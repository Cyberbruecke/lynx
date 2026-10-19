#!/usr/bin/env node
"use strict";
// Query-SCHEMA recovery: for GT endpoints the crawl fired with >=1 query parameter, how many of the observed
// parameter KEYS does each tool reconstruct? (Values are volatile -> we match key names only; a key counts for
// a tool only if it appears LITERALLY, not as a placeholder.) Scored on host+path-matched endpoints (medium).
// READ-ONLY over stored tool outputs.
const fs = require("fs"), path = require("path");
const { resolveUrl, classify, isPurePlaceholder } = require("./lib/match");
const { loadUrlToSha, readGt, domainsFromLog, corpusHas } = require("./lib/corpus");
const out = path.join(__dirname, "out"), jsDir = path.join(out, "js");
const urlToSha = loadUrlToSha(path.join(out, "js-index.csv"));
let domains = domainsFromLog(path.join(out, "crawl-log.csv")).slice(0, +(process.argv[2] || 100000));
const RANK = { no_match: 0, weak: 1, templated_path: 2, exact: 3 };
const canon = (u) => u.replace(/^http:\/\//i, "https://").replace(/^(https?:\/\/)www\./i, "$1");
const onDisk = (s) => corpusHas(out, s);
const cache = {}; const U = (t, s) => { const k = t + s; if (cache[k]) return cache[k]; let u = []; const f = path.join(out, "tools", t, s + ".json"); if (fs.existsSync(f)) { try { u = JSON.parse(fs.readFileSync(f, "utf8")).urls || []; } catch {} } return (cache[k] = u); };
const TOOLS = ["linkfinder", "jsluice", "relwarc", "lynx"];
const PH = /\{[A-Z_]+:[^}]*\}/;
// literal query keys from a url's query string (skip keys that are or contain a placeholder)
function keysOf(u) {
  const qi = u.indexOf("?"); if (qi < 0) return [];
  const q = u.slice(qi + 1).split("#")[0];
  const ks = [];
  for (const pair of q.split("&")) { if (!pair) continue; const k = pair.split("=")[0]; if (k && !PH.test(k)) ks.push(k.toLowerCase()); }
  return ks;
}
const stat = Object.fromEntries(TOOLS.map((t) => [t, { rec: 0, covSum: 0, anyKey: 0, keysHit: 0, keysTot: 0 }]));
let epWithQ = 0, n = 0;
for (const domain of domains) {
  const recs = readGt(path.join(out, "ground-truth"), domain).filter((r) => r.initiatorType === "script" && r.groundTruthUrl && r.initiatorUrl);
  if (!recs.length) continue;
  const base = "https://" + domain + "/";
  const present = recs.filter((r) => { const s = urlToSha.get(r.initiatorUrl); return s && onDisk(s); });
  if (!present.length) continue;
  // GT endpoint (host+path) -> union of observed literal query keys
  const gtKeys = new Map();
  for (const r of present) { const full = r.groundTruthUrl; const ep = canon(full.split(/[?#]/)[0]); const ks = keysOf(full); if (!gtKeys.has(ep)) gtKeys.set(ep, new Set()); for (const k of ks) gtKeys.get(ep).add(k); }
  const gt = [...gtKeys.keys()];
  const withQ = gt.filter((e) => gtKeys.get(e).size > 0);
  if (!withQ.length) continue;
  epWithQ += withQ.length;
  const shas = [...new Set(present.map((r) => urlToSha.get(r.initiatorUrl)).filter(Boolean))];
  for (const t of TOOLS) {
    const toolKeys = new Map();  // ep -> Set(reconstructed literal keys), only for host+path matches
    for (const s of shas) for (const raw of U(t, s)) {
      if (!raw || isPurePlaceholder(raw)) continue;
      const e = canon(resolveUrl(raw, base));
      const { type, g } = classify(e, gt);
      if (g == null || RANK[type] < 2) continue;
      if (!gtKeys.get(g).size) continue;                       // only endpoints that HAVE observed query keys
      if (!toolKeys.has(g)) toolKeys.set(g, new Set());
      for (const k of keysOf(e)) toolKeys.get(g).add(k);
    }
    for (const ep of withQ) {
      if (!toolKeys.has(ep)) continue;                          // tool didn't recover this endpoint
      stat[t].rec++;
      const want = gtKeys.get(ep), got = toolKeys.get(ep);
      let hit = 0; for (const k of want) if (got.has(k)) hit++;
      stat[t].keysHit += hit; stat[t].keysTot += want.size;
      stat[t].covSum += hit / want.size;
      if (got.size > 0) stat[t].anyKey++;
    }
  }
  if (++n % 10000 === 0) process.stderr.write(`\r  ${n} domains, ep-with-query ${epWithQ}`);
}
process.stderr.write("\n");
console.log(`GT endpoints fired WITH >=1 query param: ${epWithQ.toLocaleString()} over ${n} domains\n`);
console.log(`${"tool".padEnd(11)} ${"recovered".padStart(9)} ${"anyKey%".padStart(8)} ${"meanKeyCov".padStart(11)} ${"keysHit/keysTot".padStart(18)}`);
for (const t of TOOLS) { const s = stat[t]; if (!s.rec) { console.log(`${t.padEnd(11)} ${String(s.rec).padStart(9)}  (recovered no query-bearing endpoints)`); continue; }
  console.log(`${t.padEnd(11)} ${String(s.rec).padStart(9)} ${(100 * s.anyKey / s.rec).toFixed(1).padStart(7)}% ${(100 * s.covSum / s.rec).toFixed(1).padStart(10)}% ${(s.keysHit + "/" + s.keysTot).padStart(18)}`); }
console.log(`\nmeanKeyCov = mean over recovered query-bearing endpoints of (observed keys reconstructed / observed keys).`);
