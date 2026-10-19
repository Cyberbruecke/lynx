#!/usr/bin/env node
"use strict";
// Decompose LyN-X's regex-only misses into failure buckets by RE-RUNNING lynx (-a --json) on the initiating
// script and inspecting the output + partial flag. Buckets (in priority order):
//   budget          : the file hit the op-budget (partial results) -> analysis didn't finish
//   resolution/fund : lynx surfaced g's PATH but the host is an unresolvable runtime value
//                     ({VAR:...origin/href/baseURL/publicPath/currentScript/location...}) -> fundamental
//   resolution/cap  : lynx surfaced a placeholder-bearing form of g (prefix or non-origin placeholder) that
//                     scoring drops -> in principle resolvable with more capability
//   no-output       : lynx produced NOTHING corresponding to g (unmodeled sink OR fully-collapsed value;
//                     not separable from output alone)
const { spawnSync } = require("child_process");
const fs = require("fs"), path = require("path");
const { resolveUrl, classify, isPurePlaceholder } = require("./lib/match");
const { loadUrlToSha, readGt, domainsFromLog, requireJsCorpus } = require("./lib/corpus");
const LX = path.join(__dirname, "..", "lynx", "lyn-x.js");
const out = path.join(__dirname, "out"), jsDir = path.join(out, "js");
requireJsCorpus(out);
const urlToSha = loadUrlToSha(path.join(out, "js-index.csv"));
const arg = (f, d) => { const i = process.argv.indexOf(f); return i < 0 ? d : +process.argv[i + 1]; };
let domains = domainsFromLog(path.join(out, "crawl-log.csv")).slice(0, arg("--limit", 6000));
const CAP = arg("--cases", 400), TO = arg("--timeout", 60000);
const RANK = { no_match: 0, weak: 1, templated_path: 2, exact: 3 };
const cache = {}; const U = (t, s) => { const k = t + s; if (cache[k]) return cache[k]; let u = []; const f = path.join(out, "tools", t, s + ".json");
  if (fs.existsSync(f)) { try { u = JSON.parse(fs.readFileSync(f, "utf8")).urls || []; } catch {} } return (cache[k] = u); };
const ORIGINPH = /\{[A-Z_]+:[^}]*(origin|href|baseurl|publicpath|currentscript|import\.meta|location|__webpack)[^}]*\}/i;

// re-run lynx -a --json on a sha; cache {partial, urls}
const runCache = {};
function lynxRun(sha) {
  if (runCache[sha]) return runCache[sha];
  const o = path.join("/tmp", `fb_${sha}.json`);
  const r = spawnSync(process.execPath, [LX, path.join(jsDir, sha + ".js"), "-a", "--json", o], { timeout: TO, maxBuffer: 1 << 28 });
  const to = r.signal === "SIGTERM" || (r.error && r.error.code === "ETIMEDOUT");
  let partial = false, urls = [];
  if (!to) { try { const j = JSON.parse(fs.readFileSync(o, "utf8")); partial = !!j.partial; urls = (j.results || []).map((x) => x.url); } catch {} }
  try { fs.unlinkSync(o); } catch {}
  return (runCache[sha] = { partial, urls, to });
}

const b = { budget: 0, "resolution/fund": 0, "resolution/cap": 0, "no-output": 0, timeout: 0 };
let checked = 0, n = 0;
for (const domain of domains) {
  if (checked >= CAP) break;
  const recs = readGt(path.join(out, "ground-truth"), domain).filter((r) => r.initiatorType === "script" && r.groundTruthUrl && r.initiatorUrl);
  if (!recs.length) continue;
  const base = "https://" + domain + "/";
  const present = recs.filter((r) => urlToSha.get(r.initiatorUrl));
  const gt = [...new Set(present.map((r) => r.groundTruthUrl.split(/[?#]/)[0]))];
  const shas = [...new Set(present.map((r) => urlToSha.get(r.initiatorUrl)).filter(Boolean))];
  const initFor = {}; for (const r of present) { const g = r.groundTruthUrl.split(/[?#]/)[0]; (initFor[g] = initFor[g] || new Set()).add(urlToSha.get(r.initiatorUrl)); }
  const tr = {}, tl = {}; const put = (m, g, t) => { if ((RANK[t] || 0) > (m[g] || 0)) m[g] = RANK[t]; };
  for (const s of shas) { for (const t of ["linkfinder", "jsluice"]) for (const raw of U(t, s)) { if (!raw || isPurePlaceholder(raw)) continue; const { type, g } = classify(resolveUrl(raw, base), gt); if (g != null) put(tr, g, type); }
    for (const raw of U("lynx", s)) { if (!raw || isPurePlaceholder(raw)) continue; const { type, g } = classify(resolveUrl(raw, base), gt); if (g != null) put(tl, g, type); } }
  for (const g of gt) {
    if (checked >= CAP) break;
    if ((tr[g] || 0) < 2 || (tl[g] || 0) >= 2) continue;      // regex-only
    checked++;
    const gShas = [...(initFor[g] || [])];
    const runs = gShas.map(lynxRun);
    if (runs.some((r) => r.to)) { b.timeout++; continue; }
    if (runs.some((r) => r.partial)) { b.budget++; continue; }
    // did any -a output surface g's structure? classify each -a url (placeholders as wildcards) vs g
    let best = null, bestPH = "";
    for (const r of runs) for (const u of r.urls) {
      const c = classify(resolveUrl(u, base), [g]);
      if (c.type !== "no_match" && (!best || RANK[c.type] > RANK[best])) { best = c.type; bestPH = u; }
    }
    if (!best) { b["no-output"]++; continue; }                 // nothing corresponds to g
    // g's structure surfaced but scored below templated -> resolution boundary; fundamental if only the host is a runtime value
    if (ORIGINPH.test(bestPH) && /\{[A-Z_]+:[^}]*(origin|href|baseurl|publicpath|currentscript|location|__webpack)[^}]*\}[^{]*$/i.test(bestPH.replace(/^https?:\/\//, ""))) b["resolution/fund"]++;
    else if (ORIGINPH.test(bestPH)) b["resolution/fund"]++;
    else b["resolution/cap"]++;
  }
  if (++n % 200 === 0) process.stderr.write(`\r  ${n} domains, ${checked} regex-only checked`);
}
process.stderr.write("\n");
const tot = checked || 1; const pc = (x) => `${(100 * x / tot).toFixed(1)}%`;
console.log(`LyN-X regex-only MISS decomposition (N=${checked}, re-run lynx -a):\n`);
for (const k of ["budget", "resolution/fund", "resolution/cap", "no-output", "timeout"])
  console.log(`  ${k.padEnd(18)} ${String(b[k]).padStart(5)}  ${pc(b[k])}`);
console.log(`\n  budget        = file hit op-budget (partial)`);
console.log(`  resolution/fund = g's path surfaced but host is an unresolvable runtime value (fundamental)`);
console.log(`  resolution/cap  = g surfaced as a droppable placeholder/prefix form (capability-addressable)`);
console.log(`  no-output       = nothing corresponds to g (unmodeled sink OR fully-collapsed value)`);
