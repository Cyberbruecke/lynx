#!/usr/bin/env node
"use strict";
// Categorize the FULL set of single-VAR templated extras (LyN-X templated URLs that did NOT match GT) by
// (a) placeholder POSITION in the URL and (b) the placeholder NAME's semantics, so we know what the
// validation harness must handle. Writes results/templated-extras-categories.json + prints a summary.
//
//   node categorize_templated.js --tool lynx [--limit DOMAINS]

const fs = require("fs");
const path = require("path");
const { resolveUrl, classify, isPurePlaceholder } = require("./lib/match");
const { loadUrlToSha, readGt, domainsFromLog } = require("./lib/corpus");

function parseArgs(argv) {
  const o = { out: path.join(__dirname, "out"), results: path.join(__dirname, "..", "results"), tool: "lynx", limit: 0, includeMulti: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") o.out = argv[++i];
    else if (a === "--results") o.results = argv[++i];
    else if (a === "--tool") o.tool = argv[++i];
    else if (a === "--limit") o.limit = +argv[++i];
    else if (a === "--include-multi") o.includeMulti = true;    // also tally multi-placeholder (position of 1st)
  }
  return o;
}

const toolCache = {};
function toolUrlsForSha(out, tool, sha) {
  const key = tool + "/" + sha;
  if (toolCache[key]) return toolCache[key];
  let urls = [];
  const f = path.join(out, "tools", tool, `${sha}.json`);
  if (fs.existsSync(f)) { try { urls = JSON.parse(fs.readFileSync(f, "utf8")).urls || []; } catch {} }
  return (toolCache[key] = urls);
}

const PH = /\{[A-Z_]+:[^}]*\}/g;
const phCount = (u) => (u.match(PH) || []).length;

// POSITION of the (first) placeholder in an absolute URL.
function positionOf(u) {
  const m = u.match(PH); if (!m) return "none";
  const ph = m[0], idx = u.indexOf(ph);
  const hostEnd = u.indexOf("/", u.indexOf("://") + 3);
  if (hostEnd < 0 || idx < hostEnd) return "host";
  const qIdx = u.search(/[?#]/);
  if (qIdx >= 0 && idx > qIdx) return "query";
  // in path: examine the segment holding ph
  const pathPart = qIdx >= 0 ? u.slice(hostEnd, qIdx) : u.slice(hostEnd);   // starts with "/"
  const rel = idx - hostEnd;                                                 // ph index within pathPart
  const segStart = pathPart.lastIndexOf("/", rel - hostEnd + hostEnd - hostEnd) ; // fallthrough below
  // simpler: split pathPart, find segment containing ph
  const before = u.slice(hostEnd, idx);
  const after = u.slice(idx + ph.length, qIdx >= 0 ? qIdx : undefined);
  const segBeforeSlash = before.lastIndexOf("/");
  const segEndSlash = after.indexOf("/");
  const segPrefix = before.slice(segBeforeSlash + 1);                        // literal chars before ph in its segment
  const segSuffix = segEndSlash >= 0 ? after.slice(0, segEndSlash) : after;  // literal chars after ph in its segment
  const isFirstSeg = before.slice(1).indexOf("/") < 0;                       // no slash between host/ and ph (besides the leading)
  if (segPrefix === "" && segSuffix === "") return "whole-segment";          // /{VAR}/ or /{VAR}
  if (segPrefix === "" && isFirstSeg) return "path-prefix";                  // {VAR}chunk.js right after host/ (publicPath)
  if (segPrefix === "") return "segment-prefix";                             // {VAR}rest inside a deeper segment
  if (segSuffix === "") return "segment-suffix";                             // prefix{VAR}
  return "segment-embedded";                                                 // a{VAR}b
}

// NAME semantics from the placeholder's variable name.
function semanticOf(ph) {
  const name = ph.slice(ph.indexOf(":") + 1, -1);
  const last = name.toLowerCase().replace(/^.*\./, "");
  const full = name.toLowerCase();
  if (/publicpath|webpack_public|__webpack_require__\.p|assetprefix|assetspath|deploypath|cdn_?path|static_?path/.test(full) || last === "p" || /(^|\.)p$/.test(full)) return "publicpath";
  if (/origin|baseurl|base_url|basehref|location\.href|location\.origin|window\.location|document\.baseuri|\.host$|hostname|^base$|apihost|apibase|endpoint/.test(full)) return "origin-base";
  if (/(^|_|\.)id$|^id|guid|uuid|index|page|offset|limit|count|^num|version|^v\d?$/.test(last)) return "id-ish";
  if (/lang|locale|country|region/.test(last)) return "locale";
  if (/token|apikey|api_key|key$|hash|sig|secret|nonce|jwt|auth/.test(last)) return "secret";
  if (/slug|name|title|query|search|term|keyword/.test(last)) return "name-ish";
  return "other";
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  const gtDir = path.join(o.out, "ground-truth");
  const urlToSha = loadUrlToSha(path.join(o.out, "js-index.csv"));
  let domains = domainsFromLog(path.join(o.out, "crawl-log.csv"));
  if (o.limit) domains = domains.slice(0, o.limit);

  const posTally = {}, semTally = {}, kindTally = {}, cross = {}, nameTally = {}, hostTally = {};
  let multi = 0, single = 0, seen = 0;
  const bump = (o2, k) => { o2[k] = (o2[k] || 0) + 1; };
  const distinct = new Set();
  let n = 0;
  for (const domain of domains) {
    const recs = readGt(gtDir, domain).filter((r) => r.initiatorType === "script" && r.groundTruthUrl && r.initiatorUrl);
    if (!recs.length) continue;
    const gtStripped = [...new Set(recs.map((r) => r.groundTruthUrl.split(/[?#]/)[0]))];
    const shas = new Set();
    for (const r of recs) { const s = urlToSha.get(r.initiatorUrl); if (s) shas.add(s); }
    const base = "https://" + domain + "/";
    for (const s of shas) for (const raw of toolUrlsForSha(o.out, o.tool, s)) {
      if (!raw || isPurePlaceholder(raw)) continue;
      const u = (resolveUrl(raw, base) || "").split("#")[0];
      if (!/^https?:\/\//i.test(u)) continue;
      const c = phCount(u);
      if (c === 0) continue;
      if (c > 1) { multi++; if (!o.includeMulti) continue; }
      else single++;
      if (distinct.has(u)) continue; distinct.add(u); seen++;
      const m = u.match(PH);
      const pos = positionOf(u), sem = semanticOf(m[0]), kind = m[0].slice(1, m[0].indexOf(":"));
      bump(posTally, pos); bump(semTally, sem); bump(kindTally, kind);
      bump(cross, pos + " | " + sem);
      bump(nameTally, m[0].slice(m[0].indexOf(":") + 1, -1).toLowerCase());
      try { bump(hostTally, new URL(u).host.split(".").slice(-2).join(".")); } catch {}
    }
    if (++n % 5000 === 0) process.stderr.write(`\r  ${n} domains, ${seen} distinct single-VAR templated extras`);
  }
  process.stderr.write("\n");

  const topN = (obj, k) => Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, k);
  const out = {
    tool: o.tool, distinct_single_var: seen, multi_placeholder_seen: multi,
    position: posTally, semantic: semTally, kind: kindTally,
    position_x_semantic: Object.fromEntries(topN(cross, 40)),
    top_names: Object.fromEntries(topN(nameTally, 40)),
    top_host_etld1: Object.fromEntries(topN(hostTally, 30)),
  };
  fs.mkdirSync(o.results, { recursive: true });
  fs.writeFileSync(path.join(o.results, "templated-extras-categories.json"), JSON.stringify(out, null, 2));

  const pct = (x) => `${((100 * x) / Math.max(1, seen)).toFixed(1)}%`;
  console.log(`\n[categorize] ${seen} distinct single-VAR templated extras (${multi} multi-placeholder seen)\n`);
  console.log("POSITION:"); for (const [k, v] of topN(posTally, 20)) console.log(`  ${k.padEnd(16)} ${String(v).padStart(9)}  ${pct(v)}`);
  console.log("\nNAME SEMANTIC:"); for (const [k, v] of topN(semTally, 20)) console.log(`  ${k.padEnd(16)} ${String(v).padStart(9)}  ${pct(v)}`);
  console.log("\nPOSITION x SEMANTIC (top 15):"); for (const [k, v] of topN(cross, 15)) console.log(`  ${k.padEnd(30)} ${String(v).padStart(9)}  ${pct(v)}`);
  console.log("\nTOP PLACEHOLDER NAMES (top 20):"); for (const [k, v] of topN(nameTally, 20)) console.log(`  ${k.padEnd(28)} ${String(v).padStart(9)}  ${pct(v)}`);
  console.log(`\n[*] wrote ${path.join(o.results, "templated-extras-categories.json")}`);
}

main();
