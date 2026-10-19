#!/usr/bin/env node
"use strict";
// For GT endpoints missed by ALL tools (LinkFinder, JSluice, LyN-X all < exact|templated) — the set we
// actually care about — is the full PATH literal present anywhere in the domain's analyzed initiator
// scripts? own-initiator / other-sha (cross-module) / filename-only / truly-absent. Mirrors compare.js
// scoring granularity (domain-pooled tiers) but adds per-endpoint initiator-file locality.
const fs = require("fs");
const path = require("path");
const { resolveUrl, classify, isPurePlaceholder } = require("./lib/match");
const { loadUrlToSha, readGt, domainsFromLog, requireJsCorpus } = require("./lib/corpus");

const arg = (f, d) => { const i = process.argv.indexOf(f); return i < 0 ? d : +process.argv[i + 1]; };
const o = { out: path.join(__dirname, "out"), limit: arg("--limit", 3000), cap: arg("--cap", 4000) };
const jsDir = path.join(o.out, "js");
requireJsCorpus(o.out);
const urlToSha = loadUrlToSha(path.join(o.out, "js-index.csv"));
let domains = domainsFromLog(path.join(o.out, "crawl-log.csv")).slice(0, o.limit);
const RANK = { no_match: 0, weak: 1, templated_path: 2, exact: 3 };
const cache = {};
const U = (t, s) => { const k = t + s; if (cache[k]) return cache[k]; let u = []; const f = path.join(o.out, "tools", t, s + ".json");
  if (fs.existsSync(f)) { try { u = JSON.parse(fs.readFileSync(f, "utf8")).urls || []; } catch {} } return (cache[k] = u); };
const tc = {}; const R = (s) => { if (s in tc) return tc[s]; let t = ""; try { t = fs.readFileSync(path.join(jsDir, s + ".js"), "utf8"); } catch {} return (tc[s] = t); };

const loc = { own: 0, other: 0, filename: 0, absent: 0, no_js_init: 0 };
let miss = 0, gtTot = 0, n = 0;
for (const domain of domains) {
  if (miss >= o.cap) break;
  const recs = readGt(path.join(o.out, "ground-truth"), domain).filter((r) => r.initiatorType === "script" && r.groundTruthUrl && r.initiatorUrl);
  if (!recs.length) continue;
  const base = "https://" + domain + "/";
  // compare.js scores only endpoints whose initiator maps to an on-disk sha; mirror that.
  const present = recs.filter((r) => urlToSha.get(r.initiatorUrl));
  const gt = [...new Set(present.map((r) => r.groundTruthUrl.split(/[?#]/)[0]))];
  const shas = [...new Set(present.map((r) => urlToSha.get(r.initiatorUrl)).filter(Boolean))];
  const initFor = {};
  for (const r of present) { const g = r.groundTruthUrl.split(/[?#]/)[0]; const s = urlToSha.get(r.initiatorUrl);
    (initFor[g] = initFor[g] || new Set()).add(s); }
  const best = {}; const put = (g, t) => { if ((RANK[t] || 0) > (best[g] || 0)) best[g] = RANK[t]; };
  for (const s of shas) for (const t of ["linkfinder", "jsluice", "lynx"]) for (const raw of U(t, s)) {
    if (!raw || isPurePlaceholder(raw)) continue; const { type, g } = classify(resolveUrl(raw, base), gt); if (g != null) put(g, type); }
  gtTot += gt.length;
  for (const g of gt) {
    if ((best[g] || 0) >= 2) continue;            // recovered by some tool -> not all-miss
    if (miss >= o.cap) break;
    let p = g; try { p = new URL(g).pathname; } catch {}
    if (p.length <= 3) continue;
    miss++;
    const file = p.split("/").filter(Boolean).pop() || "";
    const own = [...(initFor[g] || [])].some((s) => R(s).includes(p));
    const other = shas.some((s) => R(s).includes(p));
    if (own) loc.own++;
    else if (other) loc.other++;
    else if (shas.some((s) => file.length > 4 && R(s).includes(file))) loc.filename++;
    else loc.absent++;
  }
  if (++n % 500 === 0) process.stderr.write(`\r  ${n} domains, ${miss} all-miss checked`);
}
process.stderr.write("\n");
const tot = miss || 1; const pc = (x) => `${(100 * x / tot).toFixed(1)}%`;
console.log(`ALL-TOOLS-MISS endpoints locality-checked: ${miss} (of ${gtTot} scored GT over ${n} domains)\n`);
console.log("WHERE does the full PATH literal live (relative to the analyzed corpus):");
console.log(`  in its OWN initiator file    ${String(loc.own).padStart(6)}  ${pc(loc.own).padStart(7)}  <- present + used, but no tool resolved it`);
console.log(`  only in OTHER domain sha     ${String(loc.other).padStart(6)}  ${pc(loc.other).padStart(7)}  <- cross-module`);
console.log(`  filename-only present        ${String(loc.filename).padStart(6)}  ${pc(loc.filename).padStart(7)}  <- path prefix constructed`);
console.log(`  truly ABSENT from corpus     ${String(loc.absent).padStart(6)}  ${pc(loc.absent).padStart(7)}  <- runtime data / server-provided / not in JS at all`);
