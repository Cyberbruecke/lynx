#!/usr/bin/env node
"use strict";
// ------------------------------------------------------------------------------------------------
// extract_targets.js — build the ablation target set from LyN-X's FULL complete output.
//
// A target is a distinct (sha, raw) complete LyN-X output string. Each is tagged:
//   kind = "recall"      the resolved URL matches a ground-truth endpoint (exact|templated) in >=1 domain
//        = "additional"  no GT match in any domain (the CAR/TAR "extra" outputs)
//   sub  = unique|shared (recall: whether a regex baseline also recovers that GT endpoint)
//        = car|tar       (additional: concrete vs templated)
// "Complete" = absolute, concrete host, non-empty path (host-only / fragments / symbolic-host dropped),
// matching ar_table.js. Reads the cached per-sha tool outputs; no tools are re-run.
//
// This is the WIDENED extractor (was: LyN-X-only GT recoveries only) so the ablation can attribute each
// capability's contribution to BOTH recall and the additional findings.
//
//   Output (--out, default ./data):
//     targets-crawl.jsonl        {sha, raw, resolved, kind, sub, gt?, base, arity, sink}
//     targets-crawl.files.json   { sha: [target line-indices...] }
//     targets-crawl.summary.json counts by kind/sub + arity/sink mix
//
// Usage: bun extract_targets.js --corpus crawl [--limit N] [--crawler DIR] [--out DIR]
// ------------------------------------------------------------------------------------------------

const fs = require("fs");
const path = require("path");

function parseArgs(argv) {
  const o = { corpus: "crawl", crawler: path.join(__dirname, "..", "crawler"), out: path.join(__dirname, "data"), limit: 0 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--corpus") o.corpus = argv[++i];
    else if (a === "--crawler") o.crawler = argv[++i];
    else if (a === "--out") o.out = argv[++i];
    else if (a === "--limit") o.limit = +argv[++i];
    else if (a === "--help" || a === "-h") o.help = true;
  }
  return o;
}

const RANK = { no_match: 0, weak: 1, templated_path: 2, exact: 3 };
const RECOVERED = 2;                                   // exact|templated
const PH = /\{[A-Z_]+:[^}]*\}/;
const hasPH = (u) => PH.test(u);
function completeness(e) {                             // -> "car" | "tar" | null (mirrors ar_table.js)
  if (!/^https?:\/\//i.test(e)) return null;
  const after = e.split("://")[1] || "";
  const slash = after.indexOf("/");
  const host = (slash < 0 ? after : after.slice(0, slash)).split(/[?#]/)[0];
  if (!host || hasPH(host)) return null;               // concrete, parseable host (no symbolic host)
  const pathPart = slash < 0 ? "" : after.slice(slash).split(/[?#]/)[0];
  if (!pathPart || pathPart === "/") return null;      // needs a real path
  return hasPH(e) ? "tar" : "car";
}

function extractCrawl(o) {
  const { isPurePlaceholder, resolveUrl, classify } = require(path.join(o.crawler, "lib", "match"));
  const { loadUrlToSha, readGt, domainsFromLog } = require(path.join(o.crawler, "lib", "corpus"));
  const outDir = o.crawler + "/out", gtDir = path.join(outDir, "ground-truth"), jsDir = path.join(outDir, "js");
  const urlToSha = loadUrlToSha(path.join(outDir, "js-index.csv"));
  let domains = domainsFromLog(path.join(outDir, "crawl-log.csv"));
  if (o.limit) domains = domains.slice(0, o.limit);
  const haveSha = new Set(fs.readdirSync(jsDir).map((f) => (f.endsWith(".js") ? f.slice(0, -3) : f)));

  const plan = [];
  for (const domain of domains) {
    const recs = readGt(gtDir, domain).filter((r) => r.initiatorType === "script" && r.groundTruthUrl && r.initiatorUrl);
    if (!recs.length) continue;
    const present = recs.filter((r) => { const s = urlToSha.get(r.initiatorUrl); return s && haveSha.has(s); });
    const gt = [...new Set(present.map((r) => r.groundTruthUrl.split(/[?#]/)[0]))];
    if (!gt.length) continue;
    const shas = [...new Set(present.map((r) => urlToSha.get(r.initiatorUrl)))];
    plan.push({ domain, base: "https://" + domain + "/", gt, shas });
  }
  process.stderr.write(`[extract] ${plan.length} scorable domains\n`);

  const cache = {};
  const toolRec = (tool, sha) => { const k = tool + "/" + sha; if (cache[k]) return cache[k];
    let rec = { urls: [] }; const f = path.join(outDir, "tools", tool, `${sha}.json`);
    if (fs.existsSync(f)) { try { const c = JSON.parse(fs.readFileSync(f, "utf8")); rec = { urls: c.urls || [], arity: c.arity, sinks: c.sinks }; } catch {} }
    return (cache[k] = rec); };

  const acc = new Map();                               // sha|raw -> target (accumulated across domains)
  let nd = 0;
  for (const { domain, base, gt, shas } of plan) {
    // regex-recovered GT set (medium) for unique/shared tagging
    const regexGt = new Set();
    for (const t of ["linkfinder", "jsluice"]) for (const sha of shas) for (const raw of toolRec(t, sha).urls) {
      if (!raw || isPurePlaceholder(raw)) continue; const { type, g } = classify(resolveUrl(raw, base), gt);
      if (g != null && RANK[type] >= RECOVERED) regexGt.add(g);
    }
    for (const sha of shas) {
      const rec = toolRec("lynx", sha);
      for (let i = 0; i < rec.urls.length; i++) {
        const raw = rec.urls[i];
        if (!raw || raw.length > 2000 || isPurePlaceholder(raw)) continue;   // drop data-blob / pathological strings
        const resolved = resolveUrl(raw, base);
        const kcls = completeness(resolved); if (!kcls) continue;   // complete endpoints only
        const key = sha + "|" + raw;
        let a = acc.get(key);
        if (!a) { a = { corpus: "crawl", sha, raw, resolved, kind: "additional", sub: kcls, base,
          arity: (rec.arity && rec.arity[i]) || 1, sink: (rec.sinks && rec.sinks[i]) || "?" }; acc.set(key, a); }
        const { type, g } = classify(resolved, gt);
        if (g != null && RANK[type] >= RECOVERED) {                 // recall in this domain -> upgrade/tag
          if (a.kind !== "recall") { a.kind = "recall"; a.resolved = resolved; a.base = base; }
          a.gt = g; a.tier = type;
          a.sub = regexGt.has(g) ? "shared" : "unique";
        }
      }
    }
    if (++nd % 2000 === 0) process.stderr.write(`\r  scored ${nd}/${plan.length} domains, ${acc.size} targets`);
  }
  const targets = [...acc.values()];
  process.stderr.write(`\n[extract] ${targets.length} targets from ${new Set(targets.map((t) => t.sha)).size} files\n`);
  return targets;
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) { console.log("Usage: bun extract_targets.js --corpus crawl [--limit N] [--crawler DIR] [--out DIR]"); return; }
  if (o.corpus !== "crawl") { console.error(`corpus '${o.corpus}' not supported here (SDK: extract_targets_sdk.js)`); process.exit(1); }
  fs.mkdirSync(o.out, { recursive: true });
  const targets = extractCrawl(o);
  // stream the jsonl (1M+ targets -> a single join() string blows past V8's max string length), building the
  // file index and counts in the same pass.
  const fd = fs.openSync(path.join(o.out, "targets-crawl.jsonl"), "w");
  const byFile = {}, kindCnt = {}, subCnt = {}; let buf = "";
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    (byFile[t.sha] = byFile[t.sha] || []).push(i);
    kindCnt[t.kind] = (kindCnt[t.kind] || 0) + 1; const sk = `${t.kind}:${t.sub}`; subCnt[sk] = (subCnt[sk] || 0) + 1;
    buf += JSON.stringify(t) + "\n";
    if (buf.length > (8 << 20)) { fs.writeSync(fd, buf); buf = ""; }   // flush every ~8 MB
  }
  if (buf) fs.writeSync(fd, buf);
  fs.closeSync(fd);
  fs.writeFileSync(path.join(o.out, "targets-crawl.files.json"), JSON.stringify(byFile));

  const summary = { corpus: "crawl", targets: targets.length, files: Object.keys(byFile).length,
    by_kind: kindCnt, by_sub: subCnt };
  fs.writeFileSync(path.join(o.out, "targets-crawl.summary.json"), JSON.stringify(summary, null, 2));
  console.log(`[*] wrote ${targets.length} targets (${summary.files} files) -> ${o.out}/targets-crawl.*`);
  console.log(`[*] by kind: ${JSON.stringify(summary.by_kind)}  by sub: ${JSON.stringify(summary.by_sub)}`);
}
main();
