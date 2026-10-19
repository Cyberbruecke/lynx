#!/usr/bin/env node
"use strict";
// Per-tool recovery of the medium-tier (exact|templated) recovered-endpoint UNION: total recovered, split
// into SHARED (also found by >=1 other tool) and UNIQUE (only this tool). Writes results/union-recovery.json
// for the stacked-bar figure. Read-only over stored tool outputs; regenerate after re-running LyN-X.
const fs = require("fs"), path = require("path");
const { resolveUrl, classify, isPurePlaceholder } = require("./lib/match");
const { loadUrlToSha, readGt, domainsFromLog, corpusHas } = require("./lib/corpus");
const out = path.join(__dirname, "out"), jsDir = path.join(out, "js");
const urlToSha = loadUrlToSha(path.join(out, "js-index.csv"));
let domains = domainsFromLog(path.join(out, "crawl-log.csv")).slice(0, +(process.argv[2] || 100000));
const RANK = { no_match: 0, weak: 1, templated_path: 2, exact: 3 };
const canon = (u) => u.replace(/^http:\/\//i, "https://").replace(/^(https?:\/\/)www\./i, "$1");
const cache = {}; const U = (t, s) => { const k = t + s; if (cache[k]) return cache[k]; let u = []; const f = path.join(out, "tools", t, s + ".json"); if (fs.existsSync(f)) { try { u = JSON.parse(fs.readFileSync(f, "utf8")).urls || []; } catch {} } return (cache[k] = u); };
const disk = (s) => corpusHas(out, s);
const TOOLS = ["linkfinder", "jsluice", "relwarc", "lynx"];
const disp = { linkfinder: "LinkFinder", jsluice: "JSluice", relwarc: "relwarc", lynx: "LyN-X" };
const stat = Object.fromEntries(TOOLS.map((t) => [t, { total: 0, unique: 0 }]));
let union = 0, n = 0;
for (const domain of domains) {
  const recs = readGt(path.join(out, "ground-truth"), domain).filter((r) => r.initiatorType === "script" && r.groundTruthUrl && r.initiatorUrl);
  if (!recs.length) continue;
  const base = "https://" + domain + "/";
  const present = recs.filter((r) => { const s = urlToSha.get(r.initiatorUrl); return s && disk(s); });
  const gt = [...new Set(present.map((r) => canon(r.groundTruthUrl.split(/[?#]/)[0])))];
  const shas = [...new Set(present.map((r) => urlToSha.get(r.initiatorUrl)).filter(Boolean))];
  const best = {};                                            // g -> bitmask of tools recovering it (medium)
  TOOLS.forEach((t, bit) => { for (const s of shas) for (const raw of U(t, s)) { if (!raw || isPurePlaceholder(raw)) continue; const { type, g } = classify(canon(resolveUrl(raw, base)), gt); if (g != null && RANK[type] >= 2) best[g] = (best[g] || 0) | (1 << bit); } });
  for (const g of gt) { const m = best[g]; if (!m) continue; union++;
    TOOLS.forEach((t, bit) => { if (m & (1 << bit)) { stat[t].total++; if (m === (1 << bit)) stat[t].unique++; } }); }
  if (++n % 5000 === 0) process.stderr.write(`\r  ${n} domains, union ${union}`);
}
process.stderr.write("\n");
const rows = TOOLS.map((t) => ({ tool: disp[t], total: stat[t].total, unique: stat[t].unique, shared: stat[t].total - stat[t].unique }))
  .sort((a, b) => b.total - a.total);
const outObj = { union, domains: n, tier: "medium (exact|templated)", rows };
fs.writeFileSync(path.join(__dirname, "..", "results", "union-recovery.json"), JSON.stringify(outObj, null, 2));
console.log(`union=${union} over ${n} domains -> results/union-recovery.json`);
for (const r of rows) console.log(`  ${r.tool.padEnd(11)} total ${String(r.total).padStart(7)}  shared ${String(r.shared).padStart(7)}  unique ${String(r.unique).padStart(6)}`);
