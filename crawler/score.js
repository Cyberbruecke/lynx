#!/usr/bin/env node
"use strict";
// Scoring for LyN-X vs. the dynamic ground truth (thesis §4.3/§4.5).
//
// Pipeline:
//   Phase A  run LyN-X over out/js/*.js  -> out/lynx/<sha1>.json   (cached; 5s/file timeout)
//   Phase B  per domain: GT url set (from ground truth) vs LyN-X url set (from the domain's
//            JS files), classify each extracted URL, compute strict/relaxed P/R/F1 + DG/ADG.
//
// Matching (§4.3): placeholders {VAR:}/{CALL:}/{URL_CALL:} -> (.*?), other chars escaped;
//   query strings stripped from both sides.
//   exact   = literal-equal OR regex matches AND same host        -> TP (strict & relaxed)
//   partial = regex matches but no/different host, or substring    -> FP strict, TP relaxed
//   no_match= regex fails                                          -> FP (and counts toward DG)
//   missed  = a GT url no extracted URL matched                    -> FN
//
// Granularity is per DOMAIN: LyN-X's extracted URLs from all JS loaded on a domain vs that
// domain's observed requests ("reconstruct the dependency graph vs the initiator chain").
//
// Outputs: out/pairs.csv (GT-anchored, reproduces results/*.csv) and out/scores.csv (metrics).

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFile } = require("child_process");
const { ensureDir, sanitize, csvAppender, runPool } = require("./lib/util");

function parseArgs(argv) {
  const o = {
    out: path.join(__dirname, "out"),
    lynx: path.join(__dirname, "..", "lynx", "lyn-x.js"),
    timeout: 5000, concurrency: Math.max(2, os.cpus().length), lists: [], rerun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") o.out = argv[++i];
    else if (a === "--lynx") o.lynx = argv[++i];
    else if (a === "--timeout") o.timeout = +argv[++i];
    else if (a === "--concurrency") o.concurrency = +argv[++i];
    else if (a === "--rerun-lynx") o.rerun = true;
    else if (a === "--lists") { while (argv[i + 1] && !argv[i + 1].startsWith("--")) o.lists.push(argv[++i]); }
    else if (a === "--help" || a === "-h") o.help = true;
  }
  return o;
}

// ---------- URL matching helpers ----------
const PH = /\{[A-Z_]+:[^}]*\}/g;                               // {VAR:..} {CALL:..} {URL_CALL:..}
const stripQuery = (u) => u.split(/[?#]/)[0];
const hasPlaceholder = (u) => { PH.lastIndex = 0; return PH.test(u); };
const isConcrete = (u) => !hasPlaceholder(u);
const isPurePlaceholder = (u) => u.replace(PH, "").replace(/[^A-Za-z0-9]/g, "").length === 0;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const host = (u) => { try { return new URL(u).host.toLowerCase(); } catch { return ""; } };

function toRegexBody(u) {                                       // placeholders -> (.*?), rest escaped
  let body = "", last = 0, m; PH.lastIndex = 0;
  while ((m = PH.exec(u))) { body += esc(u.slice(last, m.index)) + "(.*?)"; last = m.index + m[0].length; }
  return body + esc(u.slice(last));
}

function resolveUrl(raw, base) {
  if (hasPlaceholder(raw)) return raw;                          // symbolic: leave untouched
  if (/^https?:\/\//i.test(raw)) return raw;
  if (raw.startsWith("//")) return "https:" + raw;
  try { return new URL(raw, base).href; } catch { return raw; }
}

// classify one extracted url against the domain's GT (query-stripped) urls
function classify(eRaw, gtStripped) {
  const e = stripQuery(eRaw);
  if (!e) return { type: "no_match", g: null };
  let strictRe = null, looseRe = null;
  try { const b = toRegexBody(e); strictRe = new RegExp("^" + b + "$"); looseRe = new RegExp(b); } catch {}
  const eHost = host(e);
  let best = "no_match", bestG = null;
  for (const g of gtStripped) {
    let t = "no_match";
    if (e === g) t = "exact";
    else if (strictRe && strictRe.test(g)) t = (eHost && eHost === host(g)) ? "exact" : "partial";
    else if (looseRe && looseRe.test(g)) t = "partial";
    if (t === "exact") return { type: "exact", g };
    if (t === "partial" && best === "no_match") { best = "partial"; bestG = g; }
  }
  return { type: best, g: bestG };
}

// ---------- data loading ----------
function loadUrlToSha(idxFile) {
  const map = new Map();
  if (!fs.existsSync(idxFile)) return map;
  const lines = fs.readFileSync(idxFile, "utf8").split(/\r?\n/).slice(1);
  for (const l of lines) {
    if (!l) continue;
    // url may be quoted (commas); parse first two fields robustly
    let url, rest;
    if (l[0] === '"') { const e = l.indexOf('",'); url = l.slice(1, e).replace(/""/g, '"'); rest = l.slice(e + 2); }
    else { const c = l.indexOf(","); url = l.slice(0, c); rest = l.slice(c + 1); }
    const sha = rest.split(",")[0];
    if (sha) map.set(url, sha);
  }
  return map;
}

function domainsFromLog(logFile) {                              // [{domain, status}]
  const out = [];
  if (!fs.existsSync(logFile)) return out;
  for (const l of fs.readFileSync(logFile, "utf8").split(/\r?\n/).slice(1)) {
    if (!l) continue;
    const parts = l.split(",");
    out.push({ domain: parts[0].replace(/^"|"$/g, ""), status: parts[1] });
  }
  return out;
}

function readGt(gtDir, domain) {                                // records for one domain
  const f = path.join(gtDir, `${sanitize(domain)}.jsonl`);
  if (!fs.existsSync(f)) return [];
  const recs = [];
  for (const line of fs.readFileSync(f, "utf8").split(/\r?\n/)) {
    if (!line) continue;
    try { recs.push(JSON.parse(line)); } catch {}
  }
  return recs;
}

// ---------- Phase A: run LyN-X over the corpus ----------
function runLynxFile(lynx, jsFile, outFile, timeout) {
  return new Promise((res) => {
    execFile("node", [lynx, jsFile, "--json", outFile], { timeout, killSignal: "SIGKILL" }, (err) => {
      if (err) { try { fs.writeFileSync(outFile, JSON.stringify({ results: [], error: err.killed ? "timeout" : "error" })); } catch {} }
      res();
    });
  });
}

async function phaseA(opts, jsDir, lynxDir) {
  ensureDir(lynxDir);
  const files = fs.readdirSync(jsDir).filter((f) => f.endsWith(".js"));
  const todo = files.filter((f) => opts.rerun || !fs.existsSync(path.join(lynxDir, f.replace(/\.js$/, ".json"))));
  console.log(`[A] LyN-X over ${files.length} JS files | ${files.length - todo.length} cached | ${todo.length} to run`);
  let n = 0;
  await runPool(todo, async (f) => {
    await runLynxFile(opts.lynx, path.join(jsDir, f), path.join(lynxDir, f.replace(/\.js$/, ".json")), opts.timeout);
    if (++n % 50 === 0 || n === todo.length) process.stderr.write(`\r    analyzed ${n}/${todo.length}`);
  }, { concurrency: opts.concurrency });
  if (todo.length) process.stderr.write("\n");
}

const shaCache = new Map();
function lynxUrlsForSha(lynxDir, sha) {
  if (shaCache.has(sha)) return shaCache.get(sha);
  let urls = [];
  const f = path.join(lynxDir, `${sha}.json`);
  if (fs.existsSync(f)) {
    try { urls = (JSON.parse(fs.readFileSync(f, "utf8")).results || []).map((r) => r.url).filter(Boolean); } catch {}
  }
  shaCache.set(sha, urls);
  return urls;
}

// ---------- Phase B: score ----------
function blankAgg() { return { exact: 0, partial: 0, no_match: 0, missed: 0, gt: 0, extra: 0, adg: 0 }; }
function addMetrics(name, a) {
  const sP = a.exact, sFP = a.partial + a.no_match, sFN = a.missed;
  const rTP = a.exact + a.partial, rFP = a.no_match, rFN = a.missed;
  const f = (tp, fp, fn) => {
    const p = tp + fp ? tp / (tp + fp) : 0, r = tp + fn ? tp / (tp + fn) : 0;
    return [p, r, p + r ? (2 * p * r) / (p + r) : 0];
  };
  const [ps, rs, f1s] = f(sP, sFP, sFN);
  const [pr, rr, f1r] = f(rTP, rFP, rFN);
  const dg = a.gt ? a.extra / a.gt : 0, adg = a.gt ? a.adg / a.gt : 0;
  return [name, a.gt, a.exact, a.partial, a.no_match, a.missed,
    ps.toFixed(4), rs.toFixed(4), f1s.toFixed(4), pr.toFixed(4), rr.toFixed(4), f1r.toFixed(4),
    dg.toFixed(2), adg.toFixed(2)];
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { console.log("Usage: node score.js [--out DIR] [--lynx PATH] [--timeout MS] [--concurrency N] [--lists f1 f2..] [--rerun-lynx]"); return; }
  const gtDir = path.join(opts.out, "ground-truth");
  const jsDir = path.join(opts.out, "js");
  const lynxDir = path.join(opts.out, "lynx");
  if (!fs.existsSync(gtDir) || !fs.existsSync(jsDir)) { console.error("run crawl.js and download.js first"); process.exit(1); }

  await phaseA(opts, jsDir, lynxDir);

  // domain -> group (from sample lists), for per-group breakdown
  const groupOf = new Map();
  for (const lf of opts.lists) {
    const g = path.basename(lf).replace(/\.[^.]+$/, "");
    for (const d of fs.readFileSync(lf, "utf8").split(/\r?\n/)) { const t = d.trim(); if (t) groupOf.set(t, g); }
  }

  const urlToSha = loadUrlToSha(path.join(opts.out, "js-index.csv"));
  const groups = new Map();                                    // group -> agg
  const overall = blankAgg();
  const pairs = csvAppender(path.join(opts.out, "pairs.csv"),
    ["domain", "group", "groundTruthUrl", "initiatorType", "initiatorUrl", "lynxUrl", "matchType"]);

  console.log("[B] scoring domains ...");
  let n = 0;
  const domainRows = domainsFromLog(path.join(opts.out, "crawl-log.csv"));
  for (const { domain } of domainRows) {
    const recs = readGt(gtDir, domain);
    if (!recs.length) continue;
    const base = "https://" + domain + "/";

    // ground truth: all requested URLs (query-stripped), with a representative initiator
    const gtInfo = new Map();                                  // gtStripped -> {gt, initiatorType, initiatorUrl}
    for (const r of recs) {
      const k = stripQuery(r.groundTruthUrl);
      if (!gtInfo.has(k)) gtInfo.set(k, { gt: r.groundTruthUrl, initiatorType: r.initiatorType, initiatorUrl: r.initiatorUrl });
    }
    const gtStripped = [...gtInfo.keys()];

    // LyN-X urls: from every JS file loaded on this domain
    const jsUrls = new Set();
    for (const r of recs) {
      if (r.resourceType === "Script") jsUrls.add(r.groundTruthUrl);
      if (r.initiatorType === "script" && r.initiatorUrl) jsUrls.add(r.initiatorUrl);
    }
    const extracted = new Set();
    for (const ju of jsUrls) {
      const sha = urlToSha.get(ju);
      if (!sha) continue;
      for (const raw of lynxUrlsForSha(lynxDir, sha)) {
        if (!raw || isPurePlaceholder(raw)) continue;
        extracted.add(resolveUrl(raw, base));
      }
    }

    // classify
    const gMatch = new Map();                                  // gtStripped -> {type, e}
    const agg = groups.get(groupOf.get(domain) || "ungrouped") || blankAgg();
    let dExtra = 0, dAdg = 0;
    for (const e of extracted) {
      const { type, g } = classify(e, gtStripped);
      if (type === "exact") agg.exact++;
      else if (type === "partial") agg.partial++;
      else { agg.no_match++; dExtra++; if (isConcrete(e)) dAdg++; }
      if (g) {
        const cur = gMatch.get(g);
        if (!cur || (cur.type === "partial" && type === "exact")) gMatch.set(g, { type, e });
      }
    }
    for (const k of gtStripped) if (!gMatch.has(k)) agg.missed++;
    agg.gt += gtStripped.length; agg.extra += dExtra; agg.adg += dAdg;
    groups.set(groupOf.get(domain) || "ungrouped", agg);

    // pairs.csv (GT-anchored)
    for (const [k, info] of gtInfo) {
      const m = gMatch.get(k);
      pairs.row([domain, groupOf.get(domain) || "", info.gt, info.initiatorType, info.initiatorUrl,
        m ? m.e : "", m ? m.type + "_match" : "missed_match"]);
    }
    if (++n % 200 === 0) process.stderr.write(`\r    scored ${n} domains`);
  }
  process.stderr.write("\n");
  pairs.close();

  // overall = sum of groups
  for (const a of groups.values())
    for (const k of Object.keys(overall)) overall[k] += a[k];

  const scores = csvAppender(path.join(opts.out, "scores.csv"),
    ["scope", "gt_urls", "exact", "partial", "no_match", "missed", "P_s", "R_s", "F1_s", "P_r", "R_r", "F1_r", "DG", "ADG"]);
  const printed = [];
  for (const [g, a] of [...groups.entries()].sort()) printed.push(addMetrics(g, a));
  printed.push(addMetrics("OVERALL", overall));
  for (const row of printed) scores.row(row);
  scores.close();

  console.log("\n  scope            GT   P_s    R_s    F1_s   P_r    R_r    F1_r   DG    ADG");
  for (const r of printed)
    console.log(`  ${r[0].padEnd(15)} ${String(r[1]).padStart(5)}  ${r[6]} ${r[7]} ${r[8]}  ${r[9]} ${r[10]} ${r[11]}  ${r[12]} ${r[13]}`);
  console.log(`\n[*] wrote ${path.join(opts.out, "pairs.csv")} and ${path.join(opts.out, "scores.csv")}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
