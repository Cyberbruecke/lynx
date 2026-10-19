#!/usr/bin/env node
"use strict";
// Dump GT endpoints LyN-X recovers at a target arity that a REGEX tool (LinkFinder/JSluice) ALSO recovers,
// showing the LyN-X (high-arity) string vs the regex tool's matching literal, to explain how a high-arity
// endpoint can be regex-recoverable (matching is host+path with query stripped). READ-ONLY.
const fs = require("fs"), path = require("path");
const { resolveUrl, classify, isPurePlaceholder } = require("./lib/match");
const { loadUrlToSha, readGt, domainsFromLog, corpusHas } = require("./lib/corpus");
const out = path.join(__dirname, "out"), jsDir = path.join(out, "js");
const TARGET = +(process.argv[2] || 10), NEED = +(process.argv[3] || 12);
const urlToSha = loadUrlToSha(path.join(out, "js-index.csv"));
let domains = domainsFromLog(path.join(out, "crawl-log.csv")).slice(0, 100000);
const RANK = { no_match: 0, weak: 1, templated_path: 2, exact: 3 };
const canon = (u) => u.replace(/^http:\/\//i, "https://").replace(/^(https?:\/\/)www\./i, "$1");
const onDisk = (s) => corpusHas(out, s);
function rec(t, s) { const f = path.join(out, "tools", t, s + ".json"); try { const c = JSON.parse(fs.readFileSync(f, "utf8")); return { urls: c.urls || [], arity: c.arity || [] }; } catch { return { urls: [], arity: [] }; } }
const out_ex = [];
for (const domain of domains) {
  if (out_ex.length >= NEED) break;
  const recs = readGt(path.join(out, "ground-truth"), domain).filter((r) => r.initiatorType === "script" && r.groundTruthUrl && r.initiatorUrl);
  if (!recs.length) continue;
  const base = "https://" + domain + "/";
  const present = recs.filter((r) => { const s = urlToSha.get(r.initiatorUrl); return s && onDisk(s); });
  const gt = [...new Set(present.map((r) => canon(r.groundTruthUrl.split(/[?#]/)[0])))]; if (!gt.length) continue;
  const shas = [...new Set(present.map((r) => urlToSha.get(r.initiatorUrl)).filter(Boolean))];
  // lynx: per-gt best (rank, arity, string)
  const lx = new Map();
  for (const s of shas) { const c = rec("lynx", s); for (let i = 0; i < c.urls.length; i++) { const raw = c.urls[i]; if (!raw || isPurePlaceholder(raw)) continue; const e = canon(resolveUrl(raw, base)); const { type, g } = classify(e, gt); if (g == null || RANK[type] < 2) continue; const a = c.arity[i] || 1; const cur = lx.get(g); if (!cur || a > cur.arity) lx.set(g, { arity: a, str: e }); } }
  // regex tools: per-gt an example matching literal string
  const regex = new Map();  // g -> {tool, str}
  for (const t of ["linkfinder", "jsluice"]) { for (const s of shas) { const c = rec(t, s); for (const raw of c.urls) { if (!raw || isPurePlaceholder(raw)) continue; const e = canon(resolveUrl(raw, base)); const { type, g } = classify(e, gt); if (g == null || RANK[type] < 2) continue; if (!regex.has(g)) regex.set(g, { tool: t, str: e }); } } }
  for (const [g, v] of lx) { if (v.arity === TARGET && regex.has(g)) { const r = regex.get(g); out_ex.push({ domain, g, lynx: v.str, arity: v.arity, rtool: r.tool, rstr: r.str }); if (out_ex.length >= NEED) break; } }
}
console.log(`\n=== arity-${TARGET} GT endpoints ALSO recovered by a regex tool (${out_ex.length}) ===\n`);
for (const e of out_ex) {
  console.log(`GT endpoint : ${e.g}`);
  console.log(`  LyN-X (arity ${e.arity}): ${e.lynx}`);
  console.log(`  ${e.rtool} literal   : ${e.rstr}\n`);
}
