#!/usr/bin/env node
"use strict";
// Diagnose WHY LyN-X misses regex-only GT endpoints (found by LinkFinder/JSluice at exact|templated, not by
// LyN-X). For each such endpoint, classify by what LyN-X emitted for the initiating script(s):
//   no-output          : LyN-X emitted 0 URLs for the file (zero-sink / parse-fail / budget)
//   partial-weak       : LyN-X surfaced the endpoint but only at 'weak' tier (below exact|templated)
//   placeholder-only   : LyN-X emitted a placeholder-bearing form for it that scoring drops (pure {VAR:}/symbolic host)
//   not-surfaced       : LyN-X emitted URLs for the file, but none correspond to this endpoint at all
//     -> literal-in-js    : the GT URL literal IS present in the initiator JS (regex grepped it; no sink reached it)
//     -> literal-absent   : the literal is not in the initiator JS (regex matched it via a different form/file)
//
//   node regex_only_reasons.js --limit 4000 [--grep-cap 800]

const fs = require("fs");
const path = require("path");
const { resolveUrl, classify, isPurePlaceholder } = require("./lib/match");
const { loadUrlToSha, readGt, domainsFromLog, requireJsCorpus } = require("./lib/corpus");

function parseArgs(argv) {
  const o = { out: path.join(__dirname, "out"), limit: 4000, grepCap: 800 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") o.out = argv[++i];
    else if (a === "--limit") o.limit = +argv[++i];
    else if (a === "--grep-cap") o.grepCap = +argv[++i];
  }
  return o;
}

const RANK = { no_match: 0, weak: 1, templated_path: 2, exact: 3 };
const cache = {};
function urlsForSha(out, tool, sha) {
  const k = tool + "/" + sha; if (cache[k]) return cache[k];
  let u = []; const f = path.join(out, "tools", tool, `${sha}.json`);
  if (fs.existsSync(f)) { try { u = JSON.parse(fs.readFileSync(f, "utf8")).urls || []; } catch {} }
  return (cache[k] = u);
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  const gtDir = path.join(o.out, "ground-truth"), jsDir = path.join(o.out, "js");
  requireJsCorpus(o.out);
  const urlToSha = loadUrlToSha(path.join(o.out, "js-index.csv"));
  let domains = domainsFromLog(path.join(o.out, "crawl-log.csv"));
  if (o.limit) domains = domains.slice(0, o.limit);

  const cat = { "no-output": 0, "partial-weak": 0, "placeholder-only": 0, "not-surfaced": 0 };
  const catThird = { "no-output": 0, "partial-weak": 0, "placeholder-only": 0, "not-surfaced": 0 };
  const litPresent = { path: 0, file: 0, absent: 0 };
  const examples = { "no-output": [], "partial-weak": [], "placeholder-only": [], "not-surfaced": [] };
  let regexOnly = 0, grepDone = 0, n = 0;
  const hostOf = (u) => { try { return new URL(u).host.toLowerCase(); } catch { return ""; } };

  for (const domain of domains) {
    const recs = readGt(gtDir, domain).filter((r) => r.initiatorType === "script" && r.groundTruthUrl && r.initiatorUrl);
    if (!recs.length) continue;
    const gtStripped = [...new Set(recs.map((r) => r.groundTruthUrl.split(/[?#]/)[0]))];
    const shas = [...new Set(recs.map((r) => urlToSha.get(r.initiatorUrl)).filter(Boolean))];
    const base = "https://" + domain + "/";
    const dl = domain.toLowerCase(), isThird = (h) => !(h === dl || h.endsWith("." + dl));

    // per-tool best tier per GT; for lynx track scored (non-pure) and all (incl placeholders)
    const tier = { linkfinder: {}, jsluice: {}, lxScored: {}, lxAll: {} };
    const put = (m, g, t) => { if ((RANK[t] || 0) > (m[g] || 0)) m[g] = RANK[t]; };
    for (const t of ["linkfinder", "jsluice", "lynx"]) {
      for (const sha of shas) for (const raw of urlsForSha(o.out, t, sha)) {
        if (!raw) continue;
        const pure = isPurePlaceholder(raw);
        const u = resolveUrl(raw, base);
        const { type, g } = classify(u, gtStripped);
        if (g == null) continue;
        if (t === "linkfinder") { if (!pure) put(tier.linkfinder, g, type); }
        else if (t === "jsluice") { if (!pure) put(tier.jsluice, g, type); }
        else { put(tier.lxAll, g, type); if (!pure) put(tier.lxScored, g, type); }
      }
    }

    for (const g of gtStripped) {
      const rx = Math.max(tier.linkfinder[g] || 0, tier.jsluice[g] || 0);
      if (rx < 2) continue;                       // regex didn't get it either
      if ((tier.lxScored[g] || 0) >= 2) continue; // lynx got it -> not regex-only
      regexOnly++;
      const third = isThird(hostOf(g));
      let c;
      const anyLxOutput = shas.some((s) => urlsForSha(o.out, "lynx", s).length > 0);
      if (!anyLxOutput) c = "no-output";
      else if ((tier.lxScored[g] || 0) === 1) c = "partial-weak";
      else if ((tier.lxAll[g] || 0) >= 1) c = "placeholder-only";  // surfaced only via a form scoring drops
      else c = "not-surfaced";
      cat[c]++; if (third) catThird[c]++;
      if (examples[c].length < 8) {
        const lx = shas.flatMap((s) => urlsForSha(o.out, "lynx", s)).slice(0, 400);
        const near = lx.filter((u) => { try { return hostOf(resolveUrl(u, base)) === hostOf(g) || u.includes(g.split("/").slice(3).join("/").slice(0, 15)); } catch { return false; } }).slice(0, 2);
        examples[c].push({ domain, gt: g, lynxNear: near });
      }
      // for not-surfaced: is the GT literal actually in the initiator JS? Check the PATH (root-relative
      // literals like /assets/x.js are how first-party URLs usually appear) and, looser, the filename.
      if (c === "not-surfaced" && grepDone < o.grepCap) {
        grepDone++;
        let pth = g, fn = g;
        try { const uu = new URL(g); pth = uu.pathname; fn = (pth.split("/").filter(Boolean).pop() || pth); } catch {}
        let hit = "absent";
        for (const sha of shas) {
          let txt = ""; try { txt = fs.readFileSync(path.join(jsDir, sha + ".js"), "utf8"); } catch { continue; }
          if (pth.length > 3 && txt.includes(pth)) { hit = "path"; break; }
          if (fn.length > 4 && txt.includes(fn)) hit = "file";       // filename present (path may be constructed)
        }
        litPresent[hit] = (litPresent[hit] || 0) + 1;
      }
    }
    if (++n % 1000 === 0) process.stderr.write(`\r  ${n} domains, ${regexOnly} regex-only`);
  }
  process.stderr.write("\n");

  const tot = regexOnly || 1;
  const pc = (x) => `${(100 * x / tot).toFixed(1)}%`;
  console.log(`\nregex-only GT endpoints analyzed: ${regexOnly} (over ${n} domains, --limit ${o.limit})\n`);
  console.log("WHY LyN-X missed them:");
  for (const c of Object.keys(cat)) console.log(`  ${c.padEnd(18)} ${String(cat[c]).padStart(8)}  ${pc(cat[c]).padStart(7)}   (third-party ${catThird[c]})`);
  const gd = litPresent.path + litPresent.file + litPresent.absent || 1;
  console.log(`\n  of 'not-surfaced' grep-checked (${gd}): PATH literal present = ${litPresent.path} (${(100 * litPresent.path / gd).toFixed(1)}%), filename-only present = ${litPresent.file} (${(100 * litPresent.file / gd).toFixed(1)}%), fully absent = ${litPresent.absent} (${(100 * litPresent.absent / gd).toFixed(1)}%)`);
  console.log(`  (PATH present + not-surfaced = literal is in the file but reaches NO modeled sink / didn't resolve -> the core miss; absent = URL is constructed or comes from another file)\n`);
  for (const c of Object.keys(examples)) {
    console.log(`--- examples: ${c} ---`);
    for (const e of examples[c].slice(0, 4)) console.log(`  [${e.domain}] GT ${e.gt}\n     lynx-near: ${JSON.stringify(e.lynxNear)}`);
  }
}

main();
