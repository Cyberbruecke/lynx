#!/usr/bin/env node
"use strict";
// Validate TEMPLATED extras (single-VAR LyN-X templated URLs that did NOT match GT) with CATEGORY-AWARE,
// GT-informed value recovery — because a naive "fill with 1" is wrong for the dominant class.
//
// Category mix (from categorize_templated.js, ~2.0M single-VAR extras): 88% are webpack publicPath chunk
// prefixes ({VAR:*.p}<chunk>), 5% whole-segment path params, 1% query values, ~1% origin/base (unguessable).
//
// Fill strategy per category:
//   publicpath   : recover the site's publicPath from GT (dirnames of GT script URLs on the SAME host),
//                  build host+prefix+chunk for the top prefixes (+ root), probe — chunk 2xx/3xx = it exists.
//   whole-segment: recover a sibling value from GT (a GT URL with the same literal shape), else fall back to
//                  "1"; probe the instantiated URL AND its parent path.
//   query        : the path before "?" is concrete — probe it directly (the query VALUE doesn't affect path
//                  existence); confirmed if the path responds real.
//   origin/base, host: SKIP (a hostname/origin can't be guessed).
//
// VALIDITY: a 404 on a value-guessed path is AMBIGUOUS (value may not exist though the template is right), so
// clean "path is real" signals are auth(401/403)/method(405)/3xx/429/2xx and a live parent. We report a LOWER
// BOUND per category. Stratified sample (--per-cat) so small categories get coverage. Resumable, polite.
//
//   node validate_templated.js --tool lynx --per-cat 2000 --concurrency 32
//   node validate_templated.js --tool lynx --dry-run           # show fills, no network

const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");
const https = require("https");
const { resolveUrl, classify, isPurePlaceholder } = require("./lib/match");
const { ensureDir, runPool } = require("./lib/util");
const { loadUrlToSha, readGt, domainsFromLog } = require("./lib/corpus");

function parseArgs(argv) {
  const o = { out: path.join(__dirname, "out"), results: path.join(__dirname, "..", "results"),
    tool: "lynx", perCat: 2000, limit: 0, dryRun: false, maxPrefix: 3, exclude: new Set(), excludeHash: false,
    concurrency: Math.max(8, os.cpus().length * 2), timeout: 10000, perHost: 4,
    ua: "Mozilla/5.0 (compatible; LyNX-endpoint-validator/1.0)" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") o.out = argv[++i];
    else if (a === "--results") o.results = argv[++i];
    else if (a === "--tool") o.tool = argv[++i];
    else if (a === "--exclude") o.exclude = new Set(argv[++i].split(","));   // categories to drop (e.g. publicpath)
    else if (a === "--exclude-hash") o.excludeHash = true;   // drop extras whose concrete filename is a content hash (churn)
    else if (a === "--per-cat") o.perCat = +argv[++i];          // cap probes PER category (stratified)
    else if (a === "--limit") o.limit = +argv[++i];
    else if (a === "--dry-run") o.dryRun = true;
    else if (a === "--max-prefix") o.maxPrefix = +argv[++i];     // publicPath candidates to try per host
    else if (a === "--concurrency") o.concurrency = +argv[++i];
    else if (a === "--timeout") o.timeout = +argv[++i];
    else if (a === "--per-host") o.perHost = +argv[++i];
    else if (a === "--help" || a === "-h") o.help = true;
  }
  return o;
}

const toolCache = {};
function toolUrlsForSha(out, tool, sha) {
  const key = tool + "/" + sha;
  if (toolCache[key]) return toolCache[key];
  let urls = [];
  const f = path.join(out, "tools", tool, `${sha}.json`);
  if (fs.existsSync(f)) { try { urls = JSON.parse(fs.readFileSync(f, "utf8")).urls || []; } catch {} }
  return (toolCache[key] = urls);
}

const PH = /\{[A-Z_]+:[^}]*\}/g;
const phCount = (u) => (u.match(PH) || []).length;
const hostOf = (u) => { try { return new URL(u).host; } catch { return ""; } };
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// position + semantic (same rules as categorize_templated.js, condensed)
function classifyPh(u) {
  const m = u.match(PH); const ph = m[0], idx = u.indexOf(ph);
  const hostEnd = u.indexOf("/", u.indexOf("://") + 3);
  const qIdx = u.search(/[?#]/);
  let position;
  if (hostEnd < 0 || idx < hostEnd) position = "host";
  else if (qIdx >= 0 && idx > qIdx) position = "query";
  else {
    const before = u.slice(hostEnd, idx), after = u.slice(idx + ph.length, qIdx >= 0 ? qIdx : undefined);
    const segPrefix = before.slice(before.lastIndexOf("/") + 1);
    const sl = after.indexOf("/"); const segSuffix = sl >= 0 ? after.slice(0, sl) : after;
    const isFirstSeg = before.slice(1).indexOf("/") < 0;
    if (segPrefix === "" && segSuffix === "") position = "whole-segment";
    else if (segPrefix === "" && isFirstSeg) position = "path-prefix";
    else if (segPrefix === "") position = "segment-prefix";
    else if (segSuffix === "") position = "segment-suffix";
    else position = "segment-embedded";
  }
  const name = ph.slice(ph.indexOf(":") + 1, -1), full = name.toLowerCase(), last = full.replace(/^.*\./, "");
  let semantic;
  if (/publicpath|webpack_public|__webpack_require__\.p|assetprefix|assetspath|deploypath|cdn_?path|static_?path/.test(full) || last === "p" || /(^|\.)p$/.test(full)) semantic = "publicpath";
  else if (/origin|baseurl|base_url|basehref|location\.href|location\.origin|window\.location|document\.baseuri|\.host$|hostname|^base$|apihost|apibase|endpoint/.test(full)) semantic = "origin-base";
  else if (/(^|_|\.)id$|^id|guid|uuid|index|page|offset|limit|count|^num|version|^v\d?$/.test(last)) semantic = "id-ish";
  else if (/lang|locale|country|region/.test(last)) semantic = "locale";
  else if (/token|apikey|api_key|key$|hash|sig|secret|nonce|jwt|auth/.test(last)) semantic = "secret";
  else if (/slug|name|title|query|search|term|keyword/.test(last)) semantic = "name-ish";
  else semantic = "other";
  return { ph, idx, position, semantic, name };
}

// bucket a URL into a validation category
function categoryOf(c) {
  if (c.position === "host" || c.semantic === "origin-base") return "skip";
  if (c.semantic === "publicpath" && (c.position === "path-prefix" || c.position === "segment-prefix")) return "publicpath";
  if (c.position === "whole-segment") return "whole-segment";
  if (c.position === "query") return "query";
  return "other";   // segment-prefix/suffix/embedded non-publicpath: best-effort
}

// content-hash filename detector (churn quarantine): a CONCRETE path token (split on . and /, keeping -/_ so
// base64url hashes stay intact) that is >=8 chars, alnum(+-_), with BOTH a digit and a letter is a webpack/vite
// content hash (main.a1b2c3d4.js, chunk.ByMV1C3G.bundle.min.js, off-canvas.82d118980fb5aa03c82b.bundle.min.js).
// Its value churns between deploys, so a probe 404s even when the reconstruction is correct -> exclude these
// (across ALL categories, incl. publicpath-like path-prefixes) so validation reports a stable denominator.
// Tuned on the corpus: catches 97% of the churn-prone path-prefix class, only 5%/1% of whole-segment/query.
function hasChurnHash(u) {
  const he = u.indexOf("/", u.indexOf("://") + 3); if (he < 0) return false;
  const concrete = u.replace(PH, "").split(/[?#]/)[0].slice(he);   // path with the placeholder removed
  for (const t of concrete.split(/[.\/]/)) {
    if (t.length >= 8 && /^[a-z0-9_-]+$/i.test(t) && /[0-9]/.test(t) && /[a-z]/i.test(t)) return true;
  }
  return false;
}

// recover a sibling value from GT for a single-placeholder templated url (same literal shape, different value)
function gtSegmentValue(u, gtStripped) {
  const m = u.match(PH); const ph = m[0], i = u.indexOf(ph);
  const before = u.slice(0, i), afterFull = u.slice(i + ph.length);
  const after = afterFull.split(/[?#]/)[0];
  const re = new RegExp("^" + escRe(before) + "([^/?#]+)" + escRe(after) + "(?:[/?#]|$)");
  for (const g of gtStripped) { const mm = g.match(re); if (mm && mm[1] && !/^\{/.test(mm[1])) return mm[1]; }
  return null;
}

// Positional (segment-aligned) recovery — the ONE sound value recovery for TAR. A strict prefix+suffix sibling
// (gtSegmentValue) can NEVER fire on TAR: it's exactly classify's anchored seqMatch, so such a URL would already
// be a templated_path recovery, not a no_match extra. But a SAME-HOST GT url whose placeholder segment aligns by
// path index and whose EXISTING immediate-neighbor segments match literally (host.com/{VAR}/endpoint/two vs GT
// host.com/v1/endpoint/one) is still TAR (non-adjacent tail differs) yet lifts a real in-slot value. Whole-segment
// placeholders only. Strict (all existing neighbors must match) to stay sound; measured 0.2% of whole-segment.
const WHOLE_PH = /^\{[A-Z_]+:[^}]*\}$/;
function pathSegs(u) {
  const m = u.match(/^https?:\/\/([^\/?#]+)([^?#]*)/i); if (!m) return null;
  let segs = m[2].split("/").slice(1);
  if (segs.length && segs[segs.length - 1] === "") segs = segs.slice(0, -1);
  return { host: m[1].toLowerCase(), segs };
}
function positionalRecover(u, gtByHost) {
  const p = pathSegs(u); if (!p) return null;
  const k = p.segs.findIndex((s) => WHOLE_PH.test(s));
  if (k < 0) return null;                                       // placeholder is not a whole path segment
  const preLit = k > 0 ? p.segs[k - 1] : null, folLit = k + 1 < p.segs.length ? p.segs[k + 1] : null;
  if (preLit == null && folLit == null) return null;
  const gts = gtByHost[p.host]; if (!gts) return null;
  for (const g of gts) {
    if (k >= g.length) continue;
    const preOk = preLit == null || (k - 1 < g.length && g[k - 1] === preLit);
    const folOk = folLit == null || (k + 1 < g.length && g[k + 1] === folLit);
    if (preOk && folOk) { const v = g[k]; if (v && !/\{[A-Z_]+:[^}]*\}/.test(v)) return v; }
  }
  return null;
}

function synthDefault(name) {
  const last = (name || "").toLowerCase().replace(/^.*\./, "");
  if (/^(lang|locale|language|country|region)$/.test(last)) return "en";
  if (/(uuid|guid)/.test(last)) return "00000000-0000-0000-0000-000000000000";
  return "1";
}

// Build the candidate concrete URL(s) + parent for one templated url, given its category and the host's
// learned publicPath prefixes and the domain's GT.
function buildCandidates(u, cat, cinfo, prefixesForHost, gtStripped, maxPrefix, gtByHost) {
  const ph = cinfo.ph, i = u.indexOf(ph), qIdx = u.search(/[?#]/);
  const host = hostOf(u);
  if (cat === "publicpath") {
    const afterPath = u.slice(i + ph.length).split(/[?#]/)[0];   // the chunk path webpack appends to publicPath
    const prefixes = [...(prefixesForHost || []).slice(0, maxPrefix), "/"];
    const cands = [];
    const seen = new Set();
    for (const p of prefixes) {
      const c = `https://${host}${p}${afterPath}`.replace(/([^:])\/\//g, "$1/");
      if (!seen.has(c)) { seen.add(c); cands.push(c); }
    }
    return { cands, parent: null, value: prefixes[0] };
  }
  if (cat === "query") {
    const pathOnly = u.slice(0, qIdx);                           // path is concrete; value doesn't affect path existence
    const dir = pathOnly.slice(0, pathOnly.lastIndexOf("/") + 1);
    return { cands: [pathOnly], parent: dir !== pathOnly ? dir : null, value: "(path-only)" };
  }
  // whole-segment / other: recover value from GT (strict sibling, then same-host positional), else typed default
  const posVal = gtByHost ? positionalRecover(u, gtByHost) : null;
  const gtVal = gtSegmentValue(u, gtStripped) || posVal;
  const val = gtVal || synthDefault(cinfo.name);
  const inst = u.replace(ph, encodeURIComponent(val));
  let parent = null;
  const pathPart = qIdx >= 0 ? u.slice(0, qIdx) : u;
  const schemeHostEnd = pathPart.indexOf("/", pathPart.indexOf("://") + 3);
  const cut = pathPart.lastIndexOf("/", i);
  if (cut > schemeHostEnd && schemeHostEnd > 0) parent = pathPart.slice(0, cut + 1);
  return { cands: [inst], parent, value: val, fromGt: !!gtVal };
}

function statusClass(code) {
  if (code == null) return "dead";
  if (code >= 200 && code < 300) return "2xx";
  if (code >= 300 && code < 400) return "3xx";
  if (code === 401 || code === 403) return "auth";
  if (code === 405 || code === 501) return "method";
  if (code === 404 || code === 410) return "404";
  if (code === 429) return "ratelimited";
  if (code >= 500) return "5xx";
  return "other";
}
const PATH_REAL = new Set(["2xx", "3xx", "auth", "method", "5xx", "ratelimited"]);

function probe(url, opts, method) {
  return new Promise((resolve) => {
    let u; try { u = new URL(url); } catch { return resolve({ code: null }); }
    if (u.protocol !== "http:" && u.protocol !== "https:") return resolve({ code: null });
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.request(u, { method, timeout: opts.timeout, headers: { "User-Agent": opts.ua, "Accept": "*/*" } },
      (res) => { res.destroy(); resolve({ code: res.statusCode }); });
    req.on("timeout", () => { req.destroy(); resolve({ code: null }); });
    req.on("error", (e) => resolve({ code: null, note: (e && e.code) || "error" }));
    req.end();
  });
}
async function checkUrl(url, opts) {
  let r = await probe(url, opts, "HEAD");
  if (r.code === 405 || r.code === 501 || r.note === "error") r = await probe(url, opts, "GET");
  return r;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { console.log("Usage: node validate_templated.js [--tool lynx] [--per-cat N] [--limit DOMAINS] [--dry-run] [--max-prefix K] [--concurrency N]"); return; }
  const gtDir = path.join(opts.out, "ground-truth");
  const urlToSha = loadUrlToSha(path.join(opts.out, "js-index.csv"));
  let domains = domainsFromLog(path.join(opts.out, "crawl-log.csv"));
  if (opts.limit) domains = domains.slice(0, opts.limit);

  // Stratified reservoir: keep up to perCat*strideFactor candidates per category, evenly across domains.
  const CATS = ["publicpath", "whole-segment", "query", "other"];
  const buckets = Object.fromEntries(CATS.map((c) => [c, []]));
  const catSeen = Object.fromEntries(CATS.map((c) => [c, 0]));   // total seen (for stratified stride)
  let skipped = 0, churn = 0, n = 0;
  process.stderr.write(`[collect] tool=${opts.tool} category-aware single-VAR templated extras over ${domains.length} domains ...\n`);
  const distinct = new Set();

  for (const domain of domains) {
    const recs = readGt(gtDir, domain).filter((r) => r.initiatorType === "script" && r.groundTruthUrl && r.initiatorUrl);
    if (!recs.length) continue;
    const gtFull = recs.map((r) => r.groundTruthUrl);
    const gtStripped = [...new Set(gtFull.map((g) => g.split(/[?#]/)[0]))];
    // per-host publicPath candidates = dirnames of GT script URLs on that host, by frequency
    const dirByHost = {};
    for (const g of gtStripped) { const h = hostOf(g); if (!h) continue; try { const p = new URL(g).pathname; const d = p.slice(0, p.lastIndexOf("/") + 1) || "/"; (dirByHost[h] = dirByHost[h] || {}); dirByHost[h][d] = (dirByHost[h][d] || 0) + 1; } catch {} }
    const prefixesByHost = {};
    for (const h in dirByHost) prefixesByHost[h] = Object.entries(dirByHost[h]).sort((a, b) => b[1] - a[1]).map((x) => x[0]);
    // per-host GT path-segment lists, for positional (segment-aligned) value recovery
    const gtByHost = {};
    for (const g of gtStripped) { const ps = pathSegs(g); if (ps) (gtByHost[ps.host] = gtByHost[ps.host] || []).push(ps.segs); }

    const shas = new Set();
    for (const r of recs) { const s = urlToSha.get(r.initiatorUrl); if (s) shas.add(s); }
    const base = "https://" + domain + "/";
    for (const s of shas) for (const raw of toolUrlsForSha(opts.out, opts.tool, s)) {
      if (!raw || isPurePlaceholder(raw)) continue;
      const u = (resolveUrl(raw, base) || "").split("#")[0];
      if (!/^https?:\/\//i.test(u) || phCount(u) !== 1) continue;
      if (classify(u, gtStripped).type !== "no_match") continue;   // extras only
      if (distinct.has(u)) continue; distinct.add(u);
      const cinfo = classifyPh(u);
      const cat = categoryOf(cinfo);
      if (cat === "skip" || opts.exclude.has(cat)) { skipped++; continue; }
      if (opts.excludeHash && hasChurnHash(u)) { churn++; continue; }
      catSeen[cat]++;
      // reservoir cap: keep up to perCat*4 (probe-time sampling trims to perCat)
      const cap = opts.perCat * 4;
      if (buckets[cat].length < cap) {
        const built = buildCandidates(u, cat, cinfo, prefixesByHost[hostOf(u)], gtStripped, opts.maxPrefix, gtByHost);
        if (built.cands.length && built.cands.every((c) => phCount(c) === 0)) buckets[cat].push({ u, cat, ...built });
      }
    }
    if (++n % 5000 === 0) process.stderr.write(`\r  ${n} domains; ` + CATS.map((c) => `${c}=${buckets[c].length}`).join(" "));
  }
  process.stderr.write("\n[collect] seen: " + CATS.map((c) => `${c}=${catSeen[c]}`).join("  ") + `  skip(host/origin)=${skipped}  churn(hash-filename)=${churn}\n`);

  if (opts.dryRun) {
    for (const c of CATS) {
      const rec = buckets[c].filter((e) => e.fromGt).length;   // GT/positional recoveries (value != typed default)
      console.log(`\n=== ${c} (${catSeen[c]} seen, ${rec} GT/positional recoveries, showing 6) ===`);
      const shown = (["whole-segment", "other"].includes(c) ? buckets[c].filter((e) => e.fromGt) : buckets[c]).slice(0, 6);
      for (const e of shown) console.log(`  ${e.u}\n    -> value="${e.value}"  cands=${JSON.stringify(e.cands.slice(0, 3))}${e.parent ? `  parent=${e.parent}` : ""}`);
    }
    return;
  }

  // stratified sample: evenly stride each bucket down to perCat
  const todo = [];
  for (const c of CATS) { const b = buckets[c]; const target = Math.min(b.length, opts.perCat); for (let i = 0; i < target; i++) todo.push(b[Math.floor((i * b.length) / target)]); }
  ensureDir(opts.results);
  const outCsv = path.join(opts.results, `url-status-${opts.tool}-templated-extra.csv`);
  fs.writeFileSync(outCsv, "category,templated,value,probed,inst_class,parent_class,verdict\n");
  process.stderr.write(`[fetch] ${todo.length} templated URLs (` + CATS.map((c) => `${c}=${Math.min(buckets[c].length, opts.perCat)}`).join(" ") + `) conc ${opts.concurrency}\n`);

  const inflight = new Map(); const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const throttle = async (url) => { const h = hostOf(url); while ((inflight.get(h) || 0) >= opts.perHost) await wait(25); inflight.set(h, (inflight.get(h) || 0) + 1); try { return await checkUrl(url, opts); } finally { inflight.set(h, (inflight.get(h) || 0) - 1); } };
  const fd = fs.openSync(outCsv, "a"); const esc = (s) => JSON.stringify(String(s)).slice(1, -1);
  const results = []; let k = 0;
  await runPool(todo, async (e) => {
    let best = "dead", probed = "";
    for (const cand of e.cands) {                                // first candidate that responds real wins
      const r = await throttle(cand); const cls = statusClass(r.code);
      if (probed === "") probed = cand;
      if (PATH_REAL.has(cls)) { best = cls; probed = cand; break; }
      if (cls === "404" && best === "dead") best = "404";
    }
    let parentCls = "";
    if (!PATH_REAL.has(best) && e.parent) { const rp = await throttle(e.parent); parentCls = statusClass(rp.code); }
    const verdict = PATH_REAL.has(best) ? "real" : (parentCls && PATH_REAL.has(parentCls) ? "real-parent" : (best === "404" ? "ambiguous" : "dead"));
    fs.writeSync(fd, `${e.cat},${esc(e.u)},${esc(e.value)},${esc(probed)},${best},${parentCls},${verdict}\n`);
    results.push({ cat: e.cat, verdict });
    if (++k % 200 === 0) process.stderr.write(`\r  probed ${k}/${todo.length}`);
  }, { concurrency: opts.concurrency });
  fs.closeSync(fd); process.stderr.write("\n");

  // report per category + overall
  const byCat = {};
  for (const r of results) { const b = byCat[r.cat] = byCat[r.cat] || { n: 0, real: 0, realp: 0, amb: 0, dead: 0 }; b.n++; if (r.verdict === "real") b.real++; else if (r.verdict === "real-parent") b.realp++; else if (r.verdict === "ambiguous") b.amb++; else b.dead++; }
  const pct = (x, t) => `${((100 * x) / Math.max(1, t)).toFixed(1)}%`;
  console.log(`\n[${opts.tool}] templated-extra validation (category-aware, GT-recovered fills)\n`);
  console.log(`  ${"category".padEnd(15)}${"n".padStart(7)}${"CONFIRMED".padStart(12)}${"(real".padStart(9)}${"+parent)".padStart(9)}${"ambig".padStart(9)}${"dead".padStart(8)}`);
  const tot = { n: 0, real: 0, realp: 0, amb: 0, dead: 0 };
  for (const c of CATS) { const b = byCat[c]; if (!b) continue; const conf = b.real + b.realp;
    console.log(`  ${c.padEnd(15)}${String(b.n).padStart(7)}${pct(conf, b.n).padStart(12)}${String(b.real).padStart(9)}${String(b.realp).padStart(9)}${String(b.amb).padStart(9)}${String(b.dead).padStart(8)}`);
    for (const k2 of Object.keys(tot)) tot[k2] += b[k2]; }
  const conf = tot.real + tot.realp;
  console.log(`  ${"OVERALL".padEnd(15)}${String(tot.n).padStart(7)}${pct(conf, tot.n).padStart(12)}${String(tot.real).padStart(9)}${String(tot.realp).padStart(9)}${String(tot.amb).padStart(9)}${String(tot.dead).padStart(8)}`);
  console.log(`\n  CONFIRMED = LOWER BOUND (path responds real, or parent does). 'ambiguous' = 404 (value may not exist).`);
  console.log(`[*] per-URL detail: ${outCsv}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
