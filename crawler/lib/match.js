"use strict";
// Shared URL matching + scoring, used by every tool in compare.js so the comparison is fair:
// identical oracle, identical classifier, only raw output differs.
//
// 4 match classes -> 3 TP tiers:
//   exact          concrete, host confirmed, full path         -> strict / medium / relaxed TP
//   templated_path concrete host confirmed, full structure,     -> medium / relaxed TP
//                  placeholder(s) only in the PATH
//   weak           host-anchored prefix (base fragment), OR      -> relaxed TP only
//                  symbolic-host full match
//   no_match       wrong host, or no correspondence at all       -> never TP
// (wrong host is a plain mismatch, same as any non-hit — host vs path is irrelevant.)

const PH = /\{[A-Z_]+:[^}]*\}/g;                          // {VAR:..} {CALL:..} {URL_CALL:..}
const stripQuery = (u) => u.split(/[?#]/)[0];
const hasPlaceholder = (u) => { PH.lastIndex = 0; return PH.test(u); };
const isConcrete = (u) => !hasPlaceholder(u);
const isPurePlaceholder = (u) => u.replace(PH, "").replace(/[^A-Za-z0-9]/g, "").length === 0;
const _hostCache = new Map();                            // url -> host; the same CDN/lib urls recur across domains
const host = (u) => {                                    // memoized: new URL() is the hot cost in scoreDomain
  let h = _hostCache.get(u);
  if (h !== undefined) return h;
  try { h = new URL(u).host.toLowerCase(); } catch { h = ""; }
  if (u.length < 512) { if (_hostCache.size > 500000) _hostCache.clear(); _hostCache.set(u, h); }
  return h;                                              // don't cache giant data: blobs (never a useful key)
};

// A templated string like `a/{VAR:x}/b/{CALL:f}` matches a GT url exactly like the lazy regex
// `^a/(.*?)/b/(.*?)$` (strict) or `a/(.*?)/b/(.*?)` (loose) would — but building that regex is both a ReDoS
// hazard (many adjacent/repeated `(.*?)` groups backtrack near-exponentially when a trailing literal fails,
// hanging the scorer for minutes on a single url) and a crash hazard (a huge inlined data: blob escapes into
// a pattern so large V8 throws "regular expression too large", and because compilation is LAZY that throw
// lands on the first .test(), dodging any try/catch around construction). So we match without a regex.
//
// The pattern is just literal segments separated by wildcards, so it matches iff those literals occur in g
// in order (seg[0] anchored to the start for strict, seg[last] to the end for strict). A greedy left-to-right
// scan decides this in linear time with ZERO backtracking: at each step take the earliest occurrence, which
// leaves the most room for the rest, so it finds a match whenever one exists. Empty segments (from adjacent
// placeholders) are found trivially by indexOf("", pos) === pos, so no special collapsing is needed.
const literalSegs = (u) => u.split(PH);                   // split() drops the {..} placeholders, keeps literals

function seqMatch(segs, g, anchored) {                   // does g match segs[0](.*?)segs[1]...(.*?)segs[n-1] ?
  const n = segs.length;
  let pos;
  if (anchored) { if (!g.startsWith(segs[0])) return false; pos = segs[0].length; }
  else { const i = g.indexOf(segs[0]); if (i < 0) return false; pos = i + segs[0].length; }
  for (let k = 1; k < n - 1; k++) { const i = g.indexOf(segs[k], pos); if (i < 0) return false; pos = i + segs[k].length; }
  if (n === 1) return true;
  const lastSeg = segs[n - 1];
  if (anchored) return g.endsWith(lastSeg) && g.length - lastSeg.length >= pos;  // seg[last] anchored to end
  return g.indexOf(lastSeg, pos) >= 0;
}

// A leading placeholder whose value is an origin/base (location.origin, *.href, *baseURL, publicPath,
// document.currentScript.src, or the bare Location object) denotes scheme+host, NOT a path segment. Detected
// by the placeholder's final dotted component so genuine path placeholders ({VAR:lang},
// {VAR:location.pathname}, {VAR:originalUrl}) are NOT matched.
const ORIGIN_PH = /^\{[A-Z_]+:([^}]*)\}/;                // leading placeholder (rest may be /path or glued path)
const isOriginName = (inner) => /(?:origin|href|baseurl|publicpath)$|(?:^|\.)location$|currentscript\.src$/i.test(inner);

function resolveUrl(raw, base) {                          // relative -> absolute (preserving placeholders)
  if (/^https?:\/\//i.test(raw)) return raw;             // already absolute
  if (raw.startsWith("//")) return "https:" + raw;
  // Leading origin/base placeholder -> put it in HOST position (symbolic host) instead of resolving it into
  // the path (…/{VAR:origin}/x, which can never match). `{VAR:location.origin}/x` then matches `https://<h>/x`
  // at weak tier (host unknown, full path), consistent with how `https://{VAR:h}/x` is already scored.
  const om = raw.match(ORIGIN_PH);
  if (om && isOriginName(om[1])) return "https://" + raw;
  if (!base) return raw;
  if (hasPlaceholder(raw)) {                             // mask {TYPE:..} so URL() won't choke, then unmask
    const masks = []; PH.lastIndex = 0;
    const masked = raw.replace(PH, (m) => `Zq${masks.push(m) - 1}qZ`);
    try { return new URL(masked, base).href.replace(/Zq(\d+)qZ/g, (_, i) => masks[+i]); } catch { return raw; }
  }
  try { return new URL(raw, base).href; } catch { return raw; }
}

// Canonicalize for matching: fold http:// -> https:// (scheme-insensitive; an http-literal endpoint ≡ its https
// GT form) and drop a leading "www." (www.x.com ≡ x.com) so a root-relative path resolved against the bare crawl
// domain matches a GT on the www. host; only "www." is stripped (real subdomains api./cdn. stay distinct). The
// scheme fold is a correctness fix; measured impact is tiny (+22 lynx / +16 linkfinder medium GT over 861k, since
// GT is an https crawl). NOTE: a trailing-slash normalization (host ≡ host/) was tried and measured NET-NEGATIVE — its rare
// gains were cancelled by GT-collision (a domain with both `host` and `host/` uncredits one) and, in the general
// form, by stripping placeholder tails ("{VAR:base}/" -> dropped). Removed; recall > the trailing-slash variant.
const canonUrl = (u) => (typeof u === "string" ? u.replace(/^http:\/\//i, "https://").replace(/^(https?:\/\/)www\./i, "$1") : u);

const RANK = { no_match: 0, weak: 1, templated_path: 2, exact: 3 };

// classify one extracted url against the domain's query-stripped GT urls -> best match class.
// gtHosts (host() of each gtStripped entry) is precomputed once per domain by scoreDomain so we don't
// re-parse every GT url for every extracted string; it's optional for standalone callers.
function classify(eRaw, gtStripped, gtHosts) {
  const e = stripQuery(eRaw);
  if (!e) return { type: "no_match", g: null };
  if (!gtHosts) gtHosts = gtStripped.map(host);
  const eHost = host(e);
  const symbolicHost = !eHost && /^https?:\/\//i.test(e);   // e.g. https://{VAR:h}/...
  let best = "no_match", bestG = null;

  // Concrete string (no placeholders): its regex body is just the literal, so the strict match reduces to
  // e === g and the loose match to g.includes(e). Plain string ops, no regex — also sidesteps the huge
  // lazy-compiled regex a data: blob would build. This is nearly all tool output (LinkFinder/relwarc 0%
  // placeholders, jsluice ~1%).
  if (isConcrete(e)) {
    for (let i = 0; i < gtStripped.length; i++) {
      const g = gtStripped[i];
      let t = "no_match";
      if (e === g) t = "exact";
      else if ((eHost && eHost === gtHosts[i]) || symbolicHost) { if (g.includes(e)) t = "weak"; }
      if (RANK[t] > RANK[best]) { best = t; bestG = g; if (t === "exact") break; }
    }
    return { type: best, g: bestG };
  }

  // Placeholder-bearing string: match its literal segments against each g via the backtrack-free scanner.
  const segs = literalSegs(e);
  for (let i = 0; i < gtStripped.length; i++) {
    const g = gtStripped[i];
    const hostOk = eHost && eHost === gtHosts[i];
    let t = "no_match";
    if (seqMatch(segs, g, true)) {                         // full-structure match (host known -> path-only ph)
      if (hostOk) t = "templated_path";                    // host known, placeholder only in path
      else if (symbolicHost) t = "weak";                   // host unknown
      else t = "no_match";                                 // wrong host
    } else if (seqMatch(segs, g, false) && (hostOk || symbolicHost)) {
      t = "weak";                                          // host-anchored prefix / base fragment
    }
    if (RANK[t] > RANK[best]) { best = t; bestG = g; }
  }
  return { type: best, g: bestG };
}

// structural units of a url = [host, ...non-empty path segments]; a unit may itself be/contain a placeholder.
// String-based (no URL parse) so it also works on symbolic-host strings like `{VAR:base}/collect`.
function structuralUnits(u) {
  const rest = u.replace(/^[a-z]+:\/\//i, "");           // drop scheme
  const slash = rest.indexOf("/");
  const hostPart = slash < 0 ? rest : rest.slice(0, slash);
  const pathPart = slash < 0 ? "" : rest.slice(slash);
  return [hostPart, ...pathPart.split("/").filter(Boolean)];
}

// structural coverage of a WEAK/prefix match: fraction of g's structural units (host + path segments) that e
// accounts for, unit by unit. A placeholder e-unit accounts for whatever g-unit sits at that position; a
// literal e-unit must equal it (the final e-unit may be a prefix of its g-unit). Weak matches are always
// host-aligned (hostOk or symbolic host), so alignment starts at the host.
function structuralPrefixCoverage(e, g) {
  const gU = structuralUnits(g), eU = structuralUnits(e);
  if (!gU.length) return 0;
  let covered = 0;
  for (let i = 0; i < gU.length && i < eU.length; i++) {
    const eu = eU[i], last = i === eU.length - 1;
    if (hasPlaceholder(eu)) { covered++; continue; }     // variable slot covers this unit
    if (eu === gU[i] || (last && gU[i].startsWith(eu))) covered++;
    else break;
  }
  return covered / gU.length;
}

// single-string STRUCTURAL coverage: how much of a matched GT endpoint's structure ONE extracted string
// accounts for. A full-structure (strict, ^..$) match reconstructs the whole endpoint — every position is
// either a literal or a correctly-identified variable slot — so it scores 1.0 REGARDLESS of how much of the
// value is dynamic (a template pinning `host/users/{VAR:id}` against `host/users/42` is a complete
// reconstruction, not 0.9). A weak/prefix match scores the fraction of host+path units it reaches. (This
// replaces the old literal-character coverage, which measured concreteness — it penalized templating and
// couldn't tell a full reconstruction from a bare host prefix.)
function coverage(eRaw, g) {
  const e = stripQuery(eRaw);
  if (!e || !g) return 0;
  if (e === g) return 1;
  if (isConcrete(e)) return g.includes(e) ? structuralPrefixCoverage(e, g) : 0;
  const segs = literalSegs(e);
  if (seqMatch(segs, g, true)) return 1;                 // full-structure reconstruction
  if (seqMatch(segs, g, false)) return structuralPrefixCoverage(e, g);
  return 0;
}

// score one domain: a tool's extracted URL set vs the GT set.
// gtTiers[i] = best RANK this tool reached for gtStripped[i] (0 miss .. 3 exact); returned so callers can
// build cross-tool recovery sets (e.g. the Venn overlap) without re-classifying.
// domain (optional): when given, also returns byParty = { first, third } blankAgg-shaped sub-tallies so the
// metrics can be split into same-host (first-party) vs external (third-party). Recall is bucketed by the GT
// endpoint's host party; precision by the matched endpoint's party (or, for a distractor, the extracted
// string's own host party — host-less symbolic distractors stay only in the combined totals).
// arityOf (optional): Map<extracted url, construction arity>. When given, returns gtArity[i] = max arity of
// any string that matched gtStripped[i] (0 if unrecovered) — lets callers show construction depth per endpoint.
function scoreDomain(extracted, gtStripped, domain, arityOf) {
  gtStripped = gtStripped.map(canonUrl);                 // www.x ≡ x on the GT side (order/length preserved)
  const gtHosts = gtStripped.map(host);                  // parse each GT host ONCE, not per extracted string
  const gIdx = new Map(gtStripped.map((g, i) => [g, i]));
  const gtTiers = new Array(gtStripped.length).fill(0);
  const gtArity = arityOf ? new Array(gtStripped.length).fill(0) : null;
  let nExact = 0, nTempl = 0, nWeak = 0, nNo = 0, extra = 0, adg = 0;
  const coverages = [];                                   // one value per MATCHING extracted string
  const dl = domain ? domain.toLowerCase() : null;
  const isFirst = (h) => !!h && (h === dl || h.endsWith("." + dl));
  const P1 = dl && blankAgg(), P3 = dl && blankAgg();     // first- / third-party sub-tallies
  for (const e of extracted) {
    const ce = canonUrl(e);                                // www.x ≡ x on the extracted side (arityOf still keyed by e)
    const { type, g } = classify(ce, gtStripped, gtHosts);
    const conc = isConcrete(ce);
    if (type === "exact") nExact++;
    else if (type === "templated_path") nTempl++;
    else if (type === "weak") nWeak++;
    else { nNo++; extra++; if (conc) adg++; }
    let gi = -1;
    if (g) { gi = gIdx.get(g); if (RANK[type] > gtTiers[gi]) gtTiers[gi] = RANK[type]; coverages.push(coverage(ce, g));
      if (gtArity) { const a = arityOf.get(e) || 1; if (a > gtArity[gi]) gtArity[gi] = a; } }
    if (dl) {                                              // bucket this string's precision contribution
      const b = gi >= 0 ? (isFirst(gtHosts[gi]) ? P1 : P3) : (host(ce) ? (isFirst(host(ce)) ? P1 : P3) : null);
      if (b) {
        if (type === "exact") b.nExact++;
        else if (type === "templated_path") b.nTempl++;
        else if (type === "weak") b.nWeak++;
        else { b.nNo++; b.extra++; if (conc) b.adg++; }
      }
    }
  }
  let gExact = 0, gTempl = 0, gWeak = 0;
  for (let i = 0; i < gtTiers.length; i++) {
    const r = gtTiers[i];
    if (r === 3) gExact++; else if (r === 2) gTempl++; else if (r === 1) gWeak++;
    if (dl) { const b = isFirst(gtHosts[i]) ? P1 : P3; b.gt++; if (r === 3) b.gExact++; else if (r === 2) b.gTempl++; else if (r === 1) b.gWeak++; }
  }
  const res = { nExact, nTempl, nWeak, nNo, gt: gtStripped.length, gExact, gTempl, gWeak, extra, adg, coverages, gtTiers };
  if (dl) res.byParty = { first: P1, third: P3 };
  if (gtArity) res.gtArity = gtArity;
  return res;
}

const blankAgg = () => ({ nExact: 0, nTempl: 0, nWeak: 0, nNo: 0, gt: 0, gExact: 0, gTempl: 0, gWeak: 0, extra: 0, adg: 0 });
const addInto = (a, b) => { for (const k of Object.keys(a)) a[k] += b[k]; return a; };

// 3-tier P/R/F1 (precision per extracted string, recall per GT endpoint) + DG/ADG
function metricsRow(label, a) {
  const tE = a.nExact + a.nTempl + a.nWeak + a.nNo;       // all scored extracted strings
  const P = (tp) => (tE ? tp / tE : 0);
  const R = (gm) => (a.gt ? gm / a.gt : 0);
  const F1 = (p, r) => (p + r ? (2 * p * r) / (p + r) : 0);
  const tiers = [
    [P(a.nExact), R(a.gExact)],                                         // strict
    [P(a.nExact + a.nTempl), R(a.gExact + a.gTempl)],                   // medium
    [P(a.nExact + a.nTempl + a.nWeak), R(a.gExact + a.gTempl + a.gWeak)], // relaxed
  ];
  const cells = tiers.flatMap(([p, r]) => [p.toFixed(4), r.toFixed(4), F1(p, r).toFixed(4)]);
  const dg = a.gt ? a.extra / a.gt : 0, adg = a.gt ? a.adg / a.gt : 0;
  return [label, a.gt, ...cells, dg.toFixed(2), adg.toFixed(2)];
}

const METRIC_COLS = ["gt_urls",
  "P_s", "R_s", "F1_s", "P_m", "R_m", "F1_m", "P_r", "R_r", "F1_r", "DG", "ADG"];

module.exports = { isPurePlaceholder, resolveUrl, classify, coverage, scoreDomain, blankAgg, addInto, metricsRow, METRIC_COLS };
