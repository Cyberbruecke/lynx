#!/usr/bin/env node
"use strict";
// Union recall across all 4 tools at each tier: a GT endpoint counts for the union at tier T if ANY tool
// recovers it at >= T. Matches compare/ar_table base. READ-ONLY over stored tool outputs.
const fs = require("fs"), path = require("path");
const { resolveUrl, classify, isPurePlaceholder } = require("./lib/match");
const { loadUrlToSha, readGt, domainsFromLog, corpusHas } = require("./lib/corpus");
const out = path.join(__dirname, "out"), jsDir = path.join(out, "js");
const urlToSha = loadUrlToSha(path.join(out, "js-index.csv"));
let domains = domainsFromLog(path.join(out, "crawl-log.csv")).slice(0, +(process.argv[2] || 100000));
const RANK = { no_match: 0, weak: 1, templated_path: 2, exact: 3 };
const canon = (u) => u.replace(/^http:\/\//i, "https://").replace(/^(https?:\/\/)www\./i, "$1");
const disk = (s) => corpusHas(out, s);
const cache = {}; const U = (t, s) => { const k = t + s; if (cache[k]) return cache[k]; let u = []; const f = path.join(out, "tools", t, s + ".json"); if (fs.existsSync(f)) { try { u = JSON.parse(fs.readFileSync(f, "utf8")).urls || []; } catch {} } return (cache[k] = u); };
const TOOLS = ["linkfinder", "jsluice", "relwarc", "lynx"];
let GT = 0, uStrict = 0, uMed = 0, uRelax = 0, n = 0;
for (const domain of domains) {
  const recs = readGt(path.join(out, "ground-truth"), domain).filter((r) => r.initiatorType === "script" && r.groundTruthUrl && r.initiatorUrl);
  if (!recs.length) continue;
  const base = "https://" + domain + "/";
  const present = recs.filter((r) => { const s = urlToSha.get(r.initiatorUrl); return s && disk(s); });
  const gt = [...new Set(present.map((r) => canon(r.groundTruthUrl.split(/[?#]/)[0])))]; if (!gt.length) continue;
  const shas = [...new Set(present.map((r) => urlToSha.get(r.initiatorUrl)).filter(Boolean))];
  GT += gt.length;
  const gIdx = new Map(gt.map((g, i) => [g, i]));
  const best = new Array(gt.length).fill(0);                    // best tier across ALL tools per GT
  for (const t of TOOLS) for (const s of shas) for (const raw of U(t, s)) {
    if (!raw || isPurePlaceholder(raw)) continue;
    const { type, g } = classify(canon(resolveUrl(raw, base)), gt);
    if (g == null) continue; const i = gIdx.get(g); if (i == null) continue;
    if (RANK[type] > best[i]) best[i] = RANK[type];
  }
  for (const b of best) { if (b >= 3) uStrict++; if (b >= 2) uMed++; if (b >= 1) uRelax++; }
  if (++n % 10000 === 0) process.stderr.write(`\r  ${n} domains, GT ${GT}`);
}
process.stderr.write("\n");
const p = (x) => (100 * x / GT).toFixed(1);
console.log(`GT ${GT} over ${n} domains`);
console.log(`UNION  strict ${uStrict} (${p(uStrict)}%)  medium ${uMed} (${p(uMed)}%)  relaxed ${uRelax} (${p(uRelax)}%)`);
