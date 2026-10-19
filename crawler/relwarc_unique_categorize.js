#!/usr/bin/env node
"use strict";
// Categorize relwarc-unique crawl endpoints (recovered by relwarc; missed by LinkFinder/JSluice/LyN-X) by
// WHY LyN-X missed, using stored outputs + source inspection (read-only). Buckets:
//   symbolic-host   : LyN-X emitted {VAR:host}<g-path> (path recovered, host is an unresolved config/base var)
//   prefix/partial  : LyN-X emitted a host-anchored prefix of g (weak)
//   normalization   : LyN-X emitted g's path but a trailing-slash/query diff sank the match
//   custom-sink     : nothing corresponds to g AND the call site is a custom/aliased client (not fetch/XHR/createElement)
//   modeled-unresolved : nothing corresponds AND a modeled sink token (fetch/XHR/createElement/sendBeacon) is near g
const fs = require("fs"), path = require("path");
const { resolveUrl, classify, isPurePlaceholder } = require("./lib/match");
const { loadUrlToSha, readGt, domainsFromLog, requireJsCorpus } = require("./lib/corpus");
const out = path.join(__dirname, "out"), jsDir = path.join(out, "js");
requireJsCorpus(out);
const urlToSha = loadUrlToSha(path.join(out, "js-index.csv"));
let domains = domainsFromLog(path.join(out, "crawl-log.csv")).slice(0, +(process.argv[2] || 12000));
const RANK = { no_match: 0, weak: 1, templated_path: 2, exact: 3 };
const canon = (u) => u.replace(/^(https?:\/\/)www\./i, "$1");
const hasPH = (u) => /\{[A-Z_]+:/.test(u);
const hostOf = (u) => { try { return new URL(u).host.toLowerCase(); } catch { return ""; } };
const cache = {}; const U = (t, s) => { const k = t + s; if (cache[k]) return cache[k]; let u = []; const f = path.join(out, "tools", t, s + ".json"); if (fs.existsSync(f)) { try { u = JSON.parse(fs.readFileSync(f, "utf8")).urls || []; } catch {} } return (cache[k] = u); };
const R = (s) => { try { return fs.readFileSync(path.join(jsDir, s + ".js"), "utf8"); } catch { return ""; } };
const onDisk = {}; const disk = (s) => (s in onDisk ? onDisk[s] : (onDisk[s] = fs.existsSync(path.join(jsDir, s + ".js"))));

const b = { "symbolic-host": 0, "prefix/partial": 0, "normalization": 0, "custom-sink": 0, "modeled-unresolved": 0, "no-trace": 0 };
let total = 0, n = 0;
for (const domain of domains) {
  const recs = readGt(path.join(out, "ground-truth"), domain).filter((r) => r.initiatorType === "script" && r.groundTruthUrl && r.initiatorUrl);
  if (!recs.length) continue;
  const base = "https://" + domain + "/";
  const present = recs.filter((r) => { const s = urlToSha.get(r.initiatorUrl); return s && disk(s); });
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
    const lx = [...(initFor[g] || [])].flatMap((s) => U("lynx", s));
    // best lynx emission vs g (placeholders as wildcards), and its shape
    let best = "no_match", bestU = "";
    for (const u of lx) { if (isPurePlaceholder(u)) continue; const c = classify(canon(resolveUrl(u, base)), [g]); if (RANK[c.type] > RANK[best]) { best = c.type; bestU = u; } }
    // path present in a lynx emission but sank by normalization?
    const pathInLx = lx.some((u) => u.includes(p) || u.includes(seg));
    if (best === "weak" && hasPH(bestU) && !hostOf(bestU)) b["symbolic-host"]++;
    else if (best === "weak") b["prefix/partial"]++;
    else if (pathInLx) b["normalization"]++;
    else {
      // nothing corresponds: inspect the call site for a modeled vs custom sink
      const txt = [...(initFor[g] || [])].map(R).join("\n"); const i = txt.indexOf(seg.length > 4 ? seg : p);
      const win = i >= 0 ? txt.slice(Math.max(0, i - 160), i + 40) : "";
      if (!win) b["no-trace"]++;
      else if (/\b(fetch|XMLHttpRequest|\.open|sendBeacon|createElement|\.src|import\()/.test(win)) b["modeled-unresolved"]++;
      else b["custom-sink"]++;
    }
  }
  if (++n % 2000 === 0) process.stderr.write(`\r  ${n} domains, ${total} relwarc-unique`);
}
process.stderr.write("\n");
const tot = total || 1; const pc = (x) => `${(100 * x / tot).toFixed(1)}%`;
console.log(`relwarc-unique categorized (N=${total} over ${n} domains):\n`);
for (const k of Object.keys(b)) console.log(`  ${k.padEnd(20)} ${String(b[k]).padStart(5)}  ${pc(b[k])}`);
