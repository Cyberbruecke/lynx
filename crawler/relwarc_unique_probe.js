#!/usr/bin/env node
"use strict";
// Find relwarc-unique crawl endpoints (recovered by relwarc, missed by LinkFinder/JSluice/LyN-X) and show
// the jQuery call site + what LyN-X emitted, to see WHY LyN-X (which models $.ajax) misses them.
const fs = require("fs"), path = require("path");
const { resolveUrl, classify, isPurePlaceholder } = require("./lib/match");
const { loadUrlToSha, readGt, domainsFromLog, requireJsCorpus } = require("./lib/corpus");
const out = path.join(__dirname, "out"), jsDir = path.join(out, "js");
requireJsCorpus(out);
const urlToSha = loadUrlToSha(path.join(out, "js-index.csv"));
const SHOW = +(process.argv[process.argv.indexOf("--show") + 1] || 10);
let domains = domainsFromLog(path.join(out, "crawl-log.csv")).slice(0, 8000);
const RANK = { no_match: 0, weak: 1, templated_path: 2, exact: 3 };
const canon = (u) => u.replace(/^(https?:\/\/)www\./i, "$1");
const cache = {}; const U = (t, s) => { const k = t + s; if (cache[k]) return cache[k]; let u = []; const f = path.join(out, "tools", t, s + ".json"); if (fs.existsSync(f)) { try { u = JSON.parse(fs.readFileSync(f, "utf8")).urls || []; } catch {} } return (cache[k] = u); };
const R = (s) => { try { return fs.readFileSync(path.join(jsDir, s + ".js"), "utf8"); } catch { return ""; } };
let shown = 0;
const reasons = { minified_alias: 0, wrapper: 0, not_ajax_form: 0, other: 0, no_ajax_kw: 0 };
let total = 0;
for (const domain of domains) {
  const recs = readGt(path.join(out, "ground-truth"), domain).filter((r) => r.initiatorType === "script" && r.groundTruthUrl && r.initiatorUrl);
  if (!recs.length) continue;
  const base = "https://" + domain + "/";
  const present = recs.filter((r) => urlToSha.get(r.initiatorUrl));
  const gt = [...new Set(present.map((r) => canon(r.groundTruthUrl.split(/[?#]/)[0])))];
  const shas = [...new Set(present.map((r) => urlToSha.get(r.initiatorUrl)).filter(Boolean))];
  const initFor = {}; for (const r of present) { const g = canon(r.groundTruthUrl.split(/[?#]/)[0]); (initFor[g] = initFor[g] || new Set()).add(urlToSha.get(r.initiatorUrl)); }
  const T = { linkfinder: {}, jsluice: {}, relwarc: {}, lynx: {} };
  const put = (m, g, t) => { if ((RANK[t] || 0) > (m[g] || 0)) m[g] = RANK[t]; };
  for (const s of shas) for (const tool of Object.keys(T)) for (const raw of U(tool, s)) { if (!raw || isPurePlaceholder(raw)) continue; const { type, g } = classify(canon(resolveUrl(raw, base)), gt); if (g != null) put(T[tool], g, type); }
  for (const g of gt) {
    if ((T.relwarc[g] || 0) < 2) continue;
    if ((T.linkfinder[g] || 0) >= 2 || (T.jsluice[g] || 0) >= 2 || (T.lynx[g] || 0) >= 2) continue;   // relwarc-unique
    total++;
    let p = g; try { p = new URL(g).pathname; } catch {}
    const seg = p.split("/").filter(Boolean).pop() || p;
    // find the call site: a sha whose text contains the path segment near an ajax-ish token
    let ctx = "", where = "";
    for (const s of (initFor[g] || [])) { const txt = R(s); const i = txt.indexOf(seg);
      if (i >= 0) { const win = txt.slice(Math.max(0, i - 120), i + 80); ctx = win; where = s.slice(0, 10);
        // crude reason classification
        if (/\.ajax\s*\(|\$\.(get|post|getJSON)\s*\(/.test(txt)) reasons.minified_alias++;   // ajax present but LyN-X missed
        else if (/\bajax\b/i.test(txt)) reasons.wrapper++;
        else reasons.no_ajax_kw++;
        break; } }
    if (!ctx) reasons.other++;
    if (shown < SHOW && ctx) {
      shown++;
      const lx = [...(initFor[g] || [])].flatMap((s) => U("lynx", s)).filter((u) => u.includes(seg.slice(0, 8)) || (() => { try { return new URL(resolveUrl(u, base)).host === new URL(g).host; } catch { return false; } })()).slice(0, 2);
      console.log(`\n[${domain}] GT ${g}`);
      console.log(`  relwarc got it; lynx-near: ${JSON.stringify(lx)}`);
      console.log(`  src(${where}): …${ctx.replace(/\n/g, "\\n")}…`);
    }
  }
}
console.log(`\n--- ${total} relwarc-unique found; call-site scan of first occurrences ---`);
console.log(`  ajax/$.get/$.post literally present in initiator file: ${reasons.minified_alias}`);
console.log(`  'ajax' token present (wrapper/other form):             ${reasons.wrapper}`);
console.log(`  no 'ajax' token in initiator file:                     ${reasons.no_ajax_kw}`);
console.log(`  path segment not found in initiator file:              ${reasons.other}`);
