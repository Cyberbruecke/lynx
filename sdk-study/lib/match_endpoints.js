"use strict";
// Segment-wise path-template matcher for the SDK study. Ground truth is OpenAPI/Discovery path templates
// (e.g. /v1/customers/{customer}/subscriptions); tool output is a concrete or {VAR:}-templated URL. We
// match on the PATH template (host is a config literal, reported separately). Tiers:
//   exact     - same shape, every param position CONCRETE on the tool side, every literal correct
//   templated - same shape, literals correct, >=1 param position is a tool placeholder ({VAR:}/{CALL:})
//   fragment  - tool path is a proper prefix of the spec path (got part of it), or a placeholder sits in a
//               LITERAL position (failed to resolve a literal) - i.e. incomplete reconstruction
//   miss      - no structural correspondence
// This isolates reconstruction: regex fragments -> "fragment"; LyN-X full templates -> "exact"/"templated".

const PARAM = { param: true };

// A path segment is a param if it's an OpenAPI {name}, a :name, or a tool placeholder ({VAR:}/{CALL:}/
// {URL_CALL:}), OR any segment that consists solely of one such placeholder. Segments that merely CONTAIN
// a placeholder inside a literal (e.g. "cus_{VAR:id}") are treated as params for param positions but will
// (correctly) fail to match a spec LITERAL, since the literal wasn't recovered.
function seg(s) {
  if (s === "") return null;
  if (/^\{[^}]*\}$/.test(s) || /^:[A-Za-z_]/.test(s)) return PARAM;      // {id} / {VAR:x} / :id
  if (/\{[^}]*\}/.test(s)) return { param: true, partial: true };        // contains a placeholder
  return { lit: s };
}

// Parse a URL/path/template into { host, segs }. host is null for a relative path.
function normalize(urlOrPath) {
  let s = String(urlOrPath || "").trim();
  s = s.split(/[?#]/)[0];                                                // drop query/fragment
  let host = null, pathStr = s;
  const m = s.match(/^[a-z][a-z0-9+.-]*:\/\/([^/]+)(\/.*)?$/i);
  if (m) { host = m[1].toLowerCase(); pathStr = m[2] || "/"; }
  const segs = pathStr.split("/").map(seg).filter(Boolean);
  return { host, segs };
}

// Normalize a host that may be templated (e.g. {appId}-dsn.algolia.net) to a comparable form.
function hostKey(h) { return h == null ? null : h.toLowerCase().replace(/\{[^}]*\}/g, "{}"); }

function hostMatch(toolHost, specHost) {
  if (specHost == null) return true;                                    // path-only spec
  if (toolHost == null) return null;                                    // tool gave a relative path -> host unknown
  return hostKey(toolHost) === hostKey(specHost);
}

// Path tier for tool segs vs spec segs.
function pathTier(tool, spec) {
  if (tool.length === spec.length) {
    let ok = true, toolPlaceholderInParam = false, placeholderInLiteral = false;
    for (let i = 0; i < spec.length; i++) {
      const t = tool[i], s = spec[i];
      if (s.param) { if (t.param) toolPlaceholderInParam = true; }       // param position accepts anything
      else if (t.param) { placeholderInLiteral = true; ok = false; }     // literal not recovered
      else if (t.lit !== s.lit) { ok = false; break; }                  // literal mismatch
    }
    if (ok) return toolPlaceholderInParam ? "templated" : "exact";
    if (placeholderInLiteral && !literalMismatch(tool, spec)) return "fragment";
  }
  // fragment: tool is a proper prefix of spec (structure-wise), tool shorter
  if (tool.length && tool.length < spec.length && isPrefix(tool, spec)) return "fragment";
  return "miss";
}

function literalMismatch(tool, spec) {                                   // a concrete literal that's plain wrong
  for (let i = 0; i < spec.length; i++) {
    const t = tool[i], s = spec[i];
    if (!s.param && !t.param && t.lit !== s.lit) return true;
  }
  return false;
}

function isPrefix(tool, spec) {
  for (let i = 0; i < tool.length; i++) {
    const t = tool[i], s = spec[i];
    if (s.param) continue;                                              // param accepts anything
    if (t.param) return false;                                          // unresolved literal -> not a clean prefix
    if (t.lit !== s.lit) return false;
  }
  return true;
}

const RANK = { exact: 3, templated: 2, fragment: 1, miss: 0 };

// Best tier for one tool URL against one normalized spec endpoint {host, segs, altSegs?}.
// The SDK and the spec can place the same segments differently: a tool may emit the FULL url path, the
// server-relative route (server base-path folded into baseURL, e.g. /v1/assistants → /assistants), or the
// route with the API VERSION folded into baseURL (spec /v2/account, SDK base .../v2 → /account). altSegs
// holds every such equivalent form; we score the tool against segs AND all of them and take the best tier.
function matchOne(toolUrl, specEndpoint) {
  const t = normalize(toolUrl);
  let tier = pathTier(t.segs, specEndpoint.segs);
  for (const alt of specEndpoint.altSegs || []) {
    const rt = pathTier(t.segs, alt);
    if (RANK[rt] > RANK[tier]) tier = rt;
  }
  return { tier, host: hostMatch(t.host, specEndpoint.host) };
}

// Score a tool's URL list against a spec endpoint set.
//   specEndpoints: [{ id, host, segs }]  (pre-normalized via normalizeSpec)
//   toolUrls:      [string]
// Returns per-endpoint best tier + aggregate recall/precision (recall counts templated+exact as recovered;
// fragment is "partial", not a recovery, mirroring the crawl-corpus 3-tier convention).
function scoreSet(toolUrls, specEndpoints, { requireHost = false } = {}) {
  const best = new Map(specEndpoints.map((e) => [e.id, { tier: "miss", host: false }]));
  const toolMatched = new Array(toolUrls.length).fill(false);
  toolUrls.forEach((u, i) => {
    for (const e of specEndpoints) {
      const m = matchOne(u, e);
      if (requireHost && m.host === false) continue;
      if (RANK[m.tier] > RANK[best.get(e.id).tier]) best.set(e.id, m);
      if (RANK[m.tier] >= RANK.templated) toolMatched[i] = true;        // this tool URL hit a real endpoint
    }
  });
  const recovered = [...best.values()].filter((b) => RANK[b.tier] >= RANK.templated).length;
  const partial = [...best.values()].filter((b) => b.tier === "fragment").length;
  const exact = [...best.values()].filter((b) => b.tier === "exact").length;
  const templated = [...best.values()].filter((b) => b.tier === "templated").length;
  const nTool = toolUrls.length || 0;
  const precisionHits = toolMatched.filter(Boolean).length;
  return {
    total: specEndpoints.length,
    recovered, exact, templated, partial,
    recall: specEndpoints.length ? recovered / specEndpoints.length : 0,
    precision: nTool ? precisionHits / nTool : 0,                       // fraction of tool output that hit a real endpoint
    emitted: nTool,
    best,
  };
}

// Normalize a raw spec endpoint into { id, host, segs, routeSegs? } for scoreSet. fullUrlTemplate is the
// server.url + path (segs, with any server base-path); the optional routePath is the server-relative
// OpenAPI path (routeSegs) — kept as an alternate match target when the server carries a base-path (/v1),
// so a tool emitting the bare SDK route still matches. Omitted when it adds nothing (no server base-path).
function normalizeSpec(id, fullUrlTemplate, routePath) {
  const n = normalize(fullUrlTemplate);
  const out = { id, host: n.host, segs: n.segs };
  const alts = [];
  if (routePath != null) {
    const r = normalize(routePath);
    if (r.segs.length !== n.segs.length) alts.push(r.segs);             // server base-path folded into baseURL
  }
  // API version folded into the SDK baseURL: spec path /v2/account, SDK calls .get("/account"). Offer the
  // version-stripped route as an equivalent form. A version segment = v1/v2/… (literal, not a param position).
  const isVer = (seg) => seg && seg.lit && /^v\d+$/i.test(seg.lit);
  for (const base of [n.segs, ...alts]) {
    if (base.length > 1 && isVer(base[0])) alts.push(base.slice(1));
  }
  if (alts.length) out.altSegs = alts;
  return out;
}

module.exports = { normalize, normalizeSpec, matchOne, scoreSet, pathTier, hostMatch };
