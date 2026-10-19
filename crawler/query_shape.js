#!/usr/bin/env node
"use strict";
// FULL-SHAPE query recovery (query analog of the path-level templated match): a tool recovers an endpoint's
// full shape iff it matches host+path (medium) AND reconstructs ALL observed query KEYS literally (values as
// wildcards). Per-key partial credit lets a regex tool score on the single key that hangs off the literal
// prefix (`cart.js?v=`); full-shape requires the WHOLE query schema. Split by #observed keys to expose where
// regex collapses (>=2 keys). READ-ONLY.
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
function keysOf(u) { const qi = u.indexOf("?"); if (qi < 0) return []; const q = u.slice(qi + 1).split("#")[0]; const ks = []; for (const pair of q.split("&")) { if (!pair) continue; const k = pair.split("=")[0]; if (k && !PH.test(k)) ks.push(k.toLowerCase()); } return ks; }
const BUCKETS = ["1", "2", "3+"];
const bk = (n) => (n === 1 ? "1" : n === 2 ? "2" : "3+");
// per tool: pathRec[b] = endpoints (with b keys) recovered at host+path; full[b] = also all keys reconstructed
const stat = Object.fromEntries(TOOLS.map((t) => [t, { pathRec: { "1": 0, "2": 0, "3+": 0 }, full: { "1": 0, "2": 0, "3+": 0 } }]));
const gtByBucket = { "1": 0, "2": 0, "3+": 0 };
let n = 0;
for (const domain of domains) {
  const recs = readGt(path.join(out, "ground-truth"), domain).filter((r) => r.initiatorType === "script" && r.groundTruthUrl && r.initiatorUrl);
  if (!recs.length) continue;
  const base = "https://" + domain + "/";
  const present = recs.filter((r) => { const s = urlToSha.get(r.initiatorUrl); return s && onDisk(s); });
  if (!present.length) continue;
  const gtKeys = new Map();
  for (const r of present) { const ep = canon(r.groundTruthUrl.split(/[?#]/)[0]); const ks = keysOf(r.groundTruthUrl); if (!gtKeys.has(ep)) gtKeys.set(ep, new Set()); for (const k of ks) gtKeys.get(ep).add(k); }
  const gt = [...gtKeys.keys()];
  const withQ = gt.filter((e) => gtKeys.get(e).size > 0);
  if (!withQ.length) continue;
  for (const e of withQ) gtByBucket[bk(gtKeys.get(e).size)]++;
  const shas = [...new Set(present.map((r) => urlToSha.get(r.initiatorUrl)).filter(Boolean))];
  for (const t of TOOLS) {
    const toolKeys = new Map();
    for (const s of shas) for (const raw of U(t, s)) {
      if (!raw || isPurePlaceholder(raw)) continue;
      const e = canon(resolveUrl(raw, base));
      const { type, g } = classify(e, gt);
      if (g == null || RANK[type] < 2 || !gtKeys.get(g).size) continue;
      if (!toolKeys.has(g)) toolKeys.set(g, new Set());
      for (const k of keysOf(e)) toolKeys.get(g).add(k);
    }
    for (const ep of withQ) {
      if (!toolKeys.has(ep)) continue;
      const b = bk(gtKeys.get(ep).size); stat[t].pathRec[b]++;
      let all = true; for (const k of gtKeys.get(ep)) if (!toolKeys.get(ep).has(k)) { all = false; break; }
      if (all) stat[t].full[b]++;
    }
  }
  if (++n % 10000 === 0) process.stderr.write(`\r  ${n} domains`);
}
process.stderr.write("\n");
const tot = gtByBucket["1"] + gtByBucket["2"] + gtByBucket["3+"];
console.log(`query-bearing GT endpoints: ${tot.toLocaleString()}  (1 key: ${gtByBucket["1"].toLocaleString()}, 2 keys: ${gtByBucket["2"].toLocaleString()}, 3+ keys: ${gtByBucket["3+"].toLocaleString()})\n`);
console.log(`FULL-SHAPE recovery = host+path match AND every observed query key reconstructed.`);
console.log(`(pathRec = recovered at host+path; full = full-shape; conditional = full/pathRec)\n`);
for (const t of TOOLS) { const s = stat[t];
  const pr = s.pathRec["1"] + s.pathRec["2"] + s.pathRec["3+"], fu = s.full["1"] + s.full["2"] + s.full["3+"];
  console.log(`${t}:`);
  for (const b of BUCKETS) { const p = s.pathRec[b], f = s.full[b]; console.log(`   ${b}-key: path-recovered ${String(p).padStart(6)}  full-shape ${String(f).padStart(6)}  (${p ? (100 * f / p).toFixed(1) : "0.0"}% of path-recovered)`); }
  console.log(`   TOTAL: path ${pr}  full-shape ${fu}  -> ${pr ? (100 * fu / pr).toFixed(1) : 0}% of path-recovered keep full shape\n`);
}
