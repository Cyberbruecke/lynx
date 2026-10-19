#!/usr/bin/env node
"use strict";
// Refine the regex-only "path present" finding: for each regex-only endpoint whose full path literal is
// present in the corpus, is it in the SAME script that issued the fetch (its own initiator sha), or only
// in OTHER domain scripts (=> cross-module), or is the initiator not a JS sha at all (=> constructing code
// is inline HTML / out of corpus)? This separates "in-file resolution failure" from "cross-module".
const fs = require("fs");
const path = require("path");
const { resolveUrl, classify, isPurePlaceholder } = require("./lib/match");
const { loadUrlToSha, readGt, domainsFromLog, requireJsCorpus } = require("./lib/corpus");

const o = { out: path.join(__dirname, "out"), limit: +(process.argv[process.argv.indexOf("--limit") + 1] || 3000),
            cap: +(process.argv[process.argv.indexOf("--cap") + 1] || 2500) };
const gtDir = path.join(o.out, "ground-truth"), jsDir = path.join(o.out, "js");
requireJsCorpus(o.out);
const urlToSha = loadUrlToSha(path.join(o.out, "js-index.csv"));
let domains = domainsFromLog(path.join(o.out, "crawl-log.csv")).slice(0, o.limit);
const RANK = { no_match: 0, weak: 1, templated_path: 2, exact: 3 };
const cache = {};
const urlsForSha = (tool, sha) => { const k = tool + "/" + sha; if (cache[k]) return cache[k];
  let u = []; const f = path.join(o.out, "tools", tool, `${sha}.json`);
  if (fs.existsSync(f)) { try { u = JSON.parse(fs.readFileSync(f, "utf8")).urls || []; } catch {} } return (cache[k] = u); };
const txtCache = {};
const readSha = (sha) => { if (sha in txtCache) return txtCache[sha];
  let t = ""; try { t = fs.readFileSync(path.join(jsDir, sha + ".js"), "utf8"); } catch {} return (txtCache[sha] = t); };

// where does the path literal live? classify.
const loc = { own_initiator: 0, other_sha_only: 0, no_js_initiator: 0, not_in_corpus: 0 };
let checked = 0, n = 0;
for (const domain of domains) {
  if (checked >= o.cap) break;
  const recs = readGt(gtDir, domain).filter((r) => r.initiatorType === "script" && r.groundTruthUrl && r.initiatorUrl);
  if (!recs.length) continue;
  const base = "https://" + domain + "/";
  const gtStripped = [...new Set(recs.map((r) => r.groundTruthUrl.split(/[?#]/)[0]))];
  const domShas = [...new Set(recs.map((r) => urlToSha.get(r.initiatorUrl)).filter(Boolean))];
  // per-endpoint initiator shas (the file(s) that actually fired the fetch for THIS url)
  const initShasFor = {};
  for (const r of recs) { const g = r.groundTruthUrl.split(/[?#]/)[0]; const s = urlToSha.get(r.initiatorUrl);
    (initShasFor[g] = initShasFor[g] || { shas: new Set(), sawUrl: false }); if (s) initShasFor[g].shas.add(s); else initShasFor[g].sawUrl = true; }
  // regex tier + lynx tier, domain-pooled (matches compare.js scoring granularity)
  const tier = { rx: {}, lx: {} };
  const put = (m, g, t) => { if ((RANK[t] || 0) > (m[g] || 0)) m[g] = RANK[t]; };
  for (const sha of domShas) {
    for (const t of ["linkfinder", "jsluice"]) for (const raw of urlsForSha(t, sha)) { if (!raw || isPurePlaceholder(raw)) continue;
      const { type, g } = classify(resolveUrl(raw, base), gtStripped); if (g != null) put(tier.rx, g, type); }
    for (const raw of urlsForSha("lynx", sha)) { if (!raw || isPurePlaceholder(raw)) continue;
      const { type, g } = classify(resolveUrl(raw, base), gtStripped); if (g != null) put(tier.lx, g, type); }
  }
  for (const g of gtStripped) {
    if ((tier.rx[g] || 0) < 2 || (tier.lx[g] || 0) >= 2) continue;   // regex-only only
    if (checked >= o.cap) break;
    let pth = g; try { pth = new URL(g).pathname; } catch {}
    if (pth.length <= 3) continue;
    checked++;
    const info = initShasFor[g] || { shas: new Set(), sawUrl: false };
    const own = [...info.shas].some((s) => readSha(s).includes(pth));
    const other = domShas.some((s) => readSha(s).includes(pth));
    if (own) loc.own_initiator++;
    else if (other) loc.other_sha_only++;
    else if (info.sawUrl && info.shas.size === 0) loc.no_js_initiator++;  // initiator was the document / non-JS
    else loc.not_in_corpus++;                                             // path literal not found anywhere we have
  }
  if (++n % 500 === 0) process.stderr.write(`\r  ${n} domains, ${checked} regex-only checked`);
}
process.stderr.write("\n");
const tot = checked || 1; const pc = (x) => `${(100 * x / tot).toFixed(1)}%`;
console.log(`regex-only endpoints locality-checked: ${checked} (limit ${o.limit} domains)\n`);
console.log("WHERE does the full PATH literal live, relative to the file that fired the fetch:");
console.log(`  in its OWN initiator script   ${String(loc.own_initiator).padStart(6)}  ${pc(loc.own_initiator).padStart(7)}  <- true in-file resolution miss`);
console.log(`  only in OTHER domain scripts  ${String(loc.other_sha_only).padStart(6)}  ${pc(loc.other_sha_only).padStart(7)}  <- cross-module (literal in a sibling chunk)`);
console.log(`  initiator is NOT a JS sha     ${String(loc.no_js_initiator).padStart(6)}  ${pc(loc.no_js_initiator).padStart(7)}  <- fired from inline HTML / doc (constructing code out of corpus)`);
console.log(`  path literal not in any sha   ${String(loc.not_in_corpus).padStart(6)}  ${pc(loc.not_in_corpus).padStart(7)}  <- constructed / fragment-only`);
