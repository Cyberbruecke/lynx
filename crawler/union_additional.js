#!/usr/bin/env node
"use strict";
// Union of ADDITIONAL recoveries (no-GT-match, complete) across all 4 tools, counted the SAME way as
// ar_table.js (per-domain distinct, summed over the corpus) so it is comparable to the per-tool CAR/TAR cells.
// Per domain we union each tool's no-match complete URLs, deduped by canonical form, split CAR (concrete) vs
// TAR (templated). Also reports the naive sum-of-per-tool to expose cross-tool overlap. READ-ONLY.
const fs = require("fs"), path = require("path");
const { resolveUrl, classify, isPurePlaceholder } = require("./lib/match");
const { loadUrlToSha, readGt, domainsFromLog, corpusHas } = require("./lib/corpus");
const out = path.join(__dirname, "out"), jsDir = path.join(out, "js");
const urlToSha = loadUrlToSha(path.join(out, "js-index.csv"));
let domains = domainsFromLog(path.join(out, "crawl-log.csv")).slice(0, +(process.argv[2] || 100000));
const TOOLS = ["linkfinder", "jsluice", "relwarc", "lynx"];
const cache = {}; const U = (t, s) => { const k = t + s; if (cache[k]) return cache[k]; let u = []; const f = path.join(out, "tools", t, s + ".json"); if (fs.existsSync(f)) { try { u = JSON.parse(fs.readFileSync(f, "utf8")).urls || []; } catch {} } return (cache[k] = u); };
const onDisk = (s) => corpusHas(out, s);
const PH = /\{[A-Z_]+:[^}]*\}/g;
const hasPH = (u) => { PH.lastIndex = 0; return PH.test(u); };
const canon = (u) => u.replace(/^http:\/\//i, "https://").replace(/^(https?:\/\/)www\./i, "$1");
const hostOf = (u) => { try { return new URL(u).host.toLowerCase(); } catch { return ""; } };
function completeness(e) {
  if (!/^https?:\/\//i.test(e)) return null;
  const h = hostOf(e); if (!h) return null;
  const p = e.slice(e.indexOf(h) + h.length).split(/[?#]/)[0];
  if (!p || p === "/") return null;
  return hasPH(e) ? "TAR" : "CAR";
}
let GT = 0, n = 0, uCar = 0, uTar = 0, sumCar = 0, sumTar = 0;
for (const domain of domains) {
  const recs = readGt(path.join(out, "ground-truth"), domain).filter((r) => r.initiatorType === "script" && r.groundTruthUrl && r.initiatorUrl);
  if (!recs.length) continue;
  const base = "https://" + domain + "/";
  const present = recs.filter((r) => { const s = urlToSha.get(r.initiatorUrl); return s && onDisk(s); });
  const gt = [...new Set(present.map((r) => canon(r.groundTruthUrl.split(/[?#]/)[0])))];
  if (!gt.length) continue;
  const shas = [...new Set(present.map((r) => urlToSha.get(r.initiatorUrl)).filter(Boolean))];
  GT += gt.length;
  const unionCar = new Set(), unionTar = new Set();
  for (const t of TOOLS) {
    const seen = new Set();
    for (const s of shas) for (const raw of U(t, s)) {
      if (!raw || seen.has(raw)) continue; seen.add(raw);
      if (isPurePlaceholder(raw)) continue;
      const e = canon(resolveUrl(raw, base));
      const { type, g } = classify(e, gt);
      if (type !== "no_match" || g != null) continue;
      const c = completeness(e);
      if (c === "CAR") { sumCar++; unionCar.add(e); }
      else if (c === "TAR") { sumTar++; unionTar.add(e); }
    }
  }
  uCar += unionCar.size; uTar += unionTar.size;
  if (++n % 10000 === 0) process.stderr.write(`\r  ${n} domains, GT ${GT}`);
}
process.stderr.write("\n");
const fmt = (x) => x.toLocaleString();
console.log(`GT ${fmt(GT)} over ${n} domains\n`);
console.log(`CAR  sum-of-per-tool ${fmt(sumCar)}   UNION ${fmt(uCar)}   (overlap removed: ${fmt(sumCar - uCar)}, ${(100 * (sumCar - uCar) / sumCar).toFixed(1)}%)`);
console.log(`TAR  sum-of-per-tool ${fmt(sumTar)}   UNION ${fmt(uTar)}   (overlap removed: ${fmt(sumTar - uTar)}, ${(100 * (sumTar - uTar) / sumTar).toFixed(1)}%)`);
console.log(`\nUNION additional (CAR+TAR): ${fmt(uCar + uTar)}`);
