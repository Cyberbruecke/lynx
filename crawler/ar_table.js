#!/usr/bin/env node
"use strict";
// Per-tool results table: GT, matched (exact|templated), R%, and Additional Recoveries (AR) split into
// CAR (concrete complete endpoints, no GT match) and TAR (templated complete endpoints, no GT match).
// "Complete" = a full endpoint form (concrete host + non-empty path); bare fragments/host-only are excluded.
// Also: relwarc-unique = GT endpoints recovered by relwarc but by none of LinkFinder/JSluice/LyN-X.
const fs = require("fs"), path = require("path");
const { resolveUrl, classify, coverage, isPurePlaceholder } = require("./lib/match");
const { loadUrlToSha, readGt, domainsFromLog, corpusHas } = require("./lib/corpus");
const out = path.join(__dirname, "out"), jsDir = path.join(out, "js");
const urlToSha = loadUrlToSha(path.join(out, "js-index.csv"));
const arg = (f, d) => { const i = process.argv.indexOf(f); return i < 0 ? d : +process.argv[i + 1]; };
// Default to the FULL crawl log. A smaller --limit scores a subset of domains and yields
// proportionally smaller CAR/TAR counts, so the limit is echoed into the output.
const LIMIT = arg("--limit", 100000);
let domains = domainsFromLog(path.join(out, "crawl-log.csv")).slice(0, LIMIT);
const RANK = { no_match: 0, weak: 1, templated_path: 2, exact: 3 };
const TOOLS = ["linkfinder", "jsluice", "relwarc", "lynx"];
const cache = {}; const U = (t, s) => { const k = t + s; if (cache[k]) return cache[k]; let u = []; const f = path.join(out, "tools", t, s + ".json");
  if (fs.existsSync(f)) { try { u = JSON.parse(fs.readFileSync(f, "utf8")).urls || []; } catch {} } return (cache[k] = u); };
const onDisk = (s) => corpusHas(out, s);
const PH = /\{[A-Z_]+:[^}]*\}/g;
const hasPH = (u) => { PH.lastIndex = 0; return PH.test(u); };
const canon = (u) => u.replace(/^http:\/\//i, "https://").replace(/^(https?:\/\/)www\./i, "$1");   // match scoreDomain's http/https + www.x canonicalization
const hostOf = (u) => { try { return new URL(u).host.toLowerCase(); } catch { return ""; } };
// complete endpoint form: absolute, concrete host, non-empty path. concrete = no placeholders anywhere;
// templated = placeholders only in the path (host still concrete/parseable).
function completeness(e) {
  if (!/^https?:\/\//i.test(e)) return null;                 // must be absolute
  const h = hostOf(e); if (!h) return null;                  // concrete, parseable host (excludes symbolic host)
  const p = e.slice(e.indexOf(h) + h.length).split(/[?#]/)[0];
  if (!p || p === "/") return null;                          // needs a real path (excludes host-only)
  return hasPH(e) ? "TAR" : "CAR";                           // placeholder in path -> templated AR; else concrete AR
}

const stat = Object.fromEntries(TOOLS.map((t) => [t, { gt: 0, strict: 0, med: 0, relax: 0, car: 0, tar: 0, covSum: 0, covN: 0 }]));
let GT = 0, relwarcUnique = 0, n = 0;
for (const domain of domains) {
  const recs = readGt(path.join(out, "ground-truth"), domain).filter((r) => r.initiatorType === "script" && r.groundTruthUrl && r.initiatorUrl);
  if (!recs.length) continue;
  const base = "https://" + domain + "/";
  const present = recs.filter((r) => { const s = urlToSha.get(r.initiatorUrl); return s && onDisk(s); });
  const gt = [...new Set(present.map((r) => canon(r.groundTruthUrl.split(/[?#]/)[0])))];
  if (!gt.length) continue;
  const shas = [...new Set(present.map((r) => urlToSha.get(r.initiatorUrl)).filter(Boolean))];
  GT += gt.length;
  const recovered = {};                                       // tool -> Map(gt id -> best RANK)
  for (const t of TOOLS) {
    recovered[t] = new Map();
    const seen = new Set();
    for (const s of shas) for (const raw of U(t, s)) {
      if (!raw || seen.has(raw)) continue; seen.add(raw);
      if (isPurePlaceholder(raw)) continue;
      const e = canon(resolveUrl(raw, base));
      const { type, g } = classify(e, gt);
      if (type === "no_match" || g == null) {                 // no GT correspondence -> candidate AR
        const c = completeness(e);
        if (c === "CAR") stat[t].car++; else if (c === "TAR") stat[t].tar++;
      } else {                                                 // matched a GT endpoint at some tier
        stat[t].covSum += coverage(e, g); stat[t].covN++;      // coherence = single-string coverage over matches
        if (RANK[type] > (recovered[t].get(g) || 0)) recovered[t].set(g, RANK[type]);
      }
    }
    stat[t].gt += gt.length;
    for (const rank of recovered[t].values()) { if (rank >= 3) stat[t].strict++; if (rank >= 2) stat[t].med++; if (rank >= 1) stat[t].relax++; }
  }
  // relwarc-unique: GT recovered (medium tier) by relwarc but by none of the other three
  const at = (t, g) => recovered[t].get(g) || 0;
  for (const [g, rank] of recovered.relwarc) {
    if (rank >= 2 && at("linkfinder", g) < 2 && at("jsluice", g) < 2 && at("lynx", g) < 2) relwarcUnique++;
  }
  if (++n % 5000 === 0) process.stderr.write(`\r  ${n} domains, GT ${GT}`);
}
process.stderr.write("\n");
const disp = { linkfinder: "LinkFinder", jsluice: "JSluice", relwarc: "relwarc", lynx: "LyN-X" };
console.log(`\nGT endpoints (scored): ${GT}   over ${n} domains   (--limit ${LIMIT} crawl-log entries)\n`);
const R = (x, s) => (100 * x / s.gt).toFixed(1).padStart(5);
console.log("tool          GT      Rstrict  Rmed  Rrelax  coher     CAR        TAR");
for (const t of TOOLS) { const s = stat[t];
  console.log(`  ${disp[t].padEnd(11)} ${String(s.gt).padStart(8)}  ${R(s.strict, s)}  ${R(s.med, s)}  ${R(s.relax, s)}  ${(s.covN ? s.covSum / s.covN : 0).toFixed(3)}  ${String(s.car).padStart(9)} ${String(s.tar).padStart(10)}`); }
console.log(`\nrelwarc-unique GT endpoints (recovered by relwarc, missed by LinkFinder+JSluice+LyN-X): ${relwarcUnique}`);
