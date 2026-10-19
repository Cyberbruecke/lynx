#!/usr/bin/env node
"use strict";
// ------------------------------------------------------------------------------------------------
// extract_targets_sdk.js — LyN-X-only constructed-endpoint targets for the SDK corpus.
//
// "LyN-X-only" endpoints (recovered by LyN-X at exact|templated, by NEITHER LinkFinder nor JSluice) are
// read from the existing sdk-study/results/sdk-detail.csv (per-endpoint tier per tool, from the full SDK
// run) — so the regex tools are NOT re-run here (LinkFinder isn't even installed in every env). LyN-X is
// re-run locally (baseline of the instrumented copy == stock) over each SDK's bundle to recover the actual
// URL strings + construction arity + sink, matched to the LyN-X-only endpoint ids via the SDK matcher.
//
// Granularity differs from the crawl corpus: an SDK target is an (sdk, endpoint) pair recovered over the
// SDK's whole file set with the SDK's configured --base (matching sdk_eval.js), not a single file+string.
//
//   Output (to --out, default ./data):
//     targets-sdk.jsonl        {corpus:"sdk", sdk, endpoint, base, tier, arity, sink, raw}
//     targets-sdk.files.json   { sdk: {base, files:[...], idxs:[...]} }   (drives the harness)
//     targets-sdk.summary.json
//
// Usage: bun extract_targets_sdk.js [--only s1,s2] [--sdk DIR] [--lynx PATH] [--out DIR]
// ------------------------------------------------------------------------------------------------

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFile } = require("child_process");

function parseArgs(argv) {
  const o = { sdk: path.join(__dirname, "..", "sdk-study"), crawler: path.join(__dirname, "..", "crawler"),
    lynx: path.join(__dirname, "lynx-ablated", "lyn-x.js"),
    out: path.join(__dirname, "data"), only: null, timeout: 60000,
    concurrency: Math.max(2, (os.cpus().length || 4) - 1) };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--only") o.only = new Set(argv[++i].split(","));
    else if (a === "--sdk") o.sdk = argv[++i];
    else if (a === "--crawler") o.crawler = argv[++i];
    else if (a === "--lynx") o.lynx = argv[++i];
    else if (a === "--out") o.out = argv[++i];
    else if (a === "--timeout") o.timeout = +argv[++i];
    else if (a === "--concurrency") o.concurrency = +argv[++i];
  }
  return o;
}

const REC = { exact: 1, templated: 1 };
const RANK = { exact: 3, templated: 2, fragment: 1, miss: 0 };

// lynx-only endpoints per sdk from sdk-detail.csv (sdk,endpoint,tool,tier)
function lynxOnlyFromDetail(detailPath) {
  const rows = fs.readFileSync(detailPath, "utf8").trim().split("\n").slice(1);
  const byEp = {};
  for (const l of rows) {
    const first = l.indexOf(",");
    const sdk = l.slice(0, first);
    const rest = l.slice(first + 1);
    const lastC = rest.lastIndexOf(",");
    const tier = rest.slice(lastC + 1);
    const rest2 = rest.slice(0, lastC);
    const toolC = rest2.lastIndexOf(",");
    const tool = rest2.slice(toolC + 1);
    const endpoint = rest2.slice(0, toolC);
    ((byEp[sdk] = byEp[sdk] || {})[endpoint] = byEp[sdk][endpoint] || {})[tool] = tier;
  }
  const only = {};   // sdk -> Set(endpoint ids)
  for (const sdk in byEp) {
    for (const ep in byEp[sdk]) {
      const t = byEp[sdk][ep];
      if (REC[t.lynx] && !REC[t.linkfinder] && !REC[t.jsluice]) (only[sdk] = only[sdk] || new Set()).add(ep);
    }
  }
  return only;
}

const walkJs = (dir) => { const out = []; const rec = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
  const p = path.join(d, e.name); if (e.isDirectory()) rec(p); else if (e.name.endsWith(".js")) out.push(p); } };
  if (fs.existsSync(dir)) rec(dir); return out; };

function targetFiles(sdkDir, name, npm) {
  const dir = path.join(sdkDir, "out", "sdk", name);
  const dist = path.join(dir, "dist.js");
  if (fs.existsSync(dist)) return [dist];
  const inst = path.join(dir, "node_modules", npm || name);
  if (fs.existsSync(inst)) return walkJs(inst);
  return walkJs(path.join(dir, "pkg"));
}

function loadGtRaw(sdkDir, name) {
  const f = path.join(sdkDir, "gt", `${name}.jsonl`);
  if (!fs.existsSync(f)) return null;
  return fs.readFileSync(f, "utf8").trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
}
function loadBase(entries) {
  const e = entries && entries[0]; if (!e) return null;
  if (e.url && e.path && e.url.endsWith(e.path)) return e.url.slice(0, e.url.length - e.path.length);
  try { return new URL(e.url).origin; } catch { return null; }
}

// run baseline lynx over one file; resolve to [{url, arity, sink}]
function runLynx(o, file, base) {
  return new Promise((resolve) => {
    const tmp = path.join(os.tmpdir(), "sdkabl_" + crypto.randomUUID() + ".json");
    const args = [o.lynx, file]; if (base) args.push("--base", base); args.push("--json", tmp);
    execFile(process.execPath, args, { env: { ...process.env, LYNX_TRACK_ARITY: "1" }, timeout: o.timeout, maxBuffer: 1 << 28 }, () => {
      let rows = []; try { rows = (JSON.parse(fs.readFileSync(tmp, "utf8")).results || []).filter((r) => r.url); } catch {}
      try { fs.unlinkSync(tmp); } catch {}
      resolve(rows.map((r) => ({ url: r.url, arity: r.arity || 1, sink: r.sink || "?" })));
    });
  });
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const M = require(path.join(o.sdk, "lib", "match_endpoints"));
  const { runPool } = require(path.join(o.crawler, "lib", "util"));
  const manifest = JSON.parse(fs.readFileSync(path.join(o.sdk, "sdks.json"), "utf8"));
  const only = lynxOnlyFromDetail(path.join(o.sdk, "results", "sdk-detail.csv"));

  fs.mkdirSync(o.out, { recursive: true });
  const targets = [];
  const files = {};   // sdk -> {base, files, idxs}
  const sdks = manifest.sdks.filter((s) => only[s.name] && only[s.name].size && (!o.only || o.only.has(s.name)));
  process.stderr.write(`[sdk] ${sdks.length} SDKs with LyN-X-only endpoints\n`);

  for (const sdk of sdks) {
    const raw = loadGtRaw(o.sdk, sdk.name); if (!raw) continue;
    const base = loadBase(raw);
    const gt = raw.map((e) => M.normalizeSpec(`${e.method} ${e.path}`, e.url, e.path));
    const gtById = new Map(gt.map((e) => [e.id, e]));
    const wanted = only[sdk.name];
    const fileList = targetFiles(o.sdk, sdk.name, sdk.npm);
    if (!fileList.length) { process.stderr.write(`  [skip] ${sdk.name}: no bundle\n`); continue; }

    // union LyN-X output across the SDK's files, KEEPING which file produced each url (provenance). Parallel
    // sweep so big node_modules walks (klaviyo/cloudflare/... have 1000s of .js) don't run serially.
    const seen = new Map();   // url -> {arity, sink, file}
    process.stderr.write(`  [${sdk.name}] sweeping ${fileList.length} file(s) ...\n`);
    await runPool(fileList, async (f) => {
      for (const r of await runLynx(o, f, base)) {
        const cur = seen.get(r.url);
        if (!cur || r.arity > cur.arity) seen.set(r.url, { arity: r.arity, sink: r.sink, file: f });
      }
    }, { concurrency: o.concurrency });

    // for each wanted (lynx-only) endpoint, find the best-matching lynx url
    const idxs = [], usedFiles = new Set();
    for (const epId of wanted) {
      const e = gtById.get(epId); if (!e) continue;
      let best = null;   // {url, tier, rank, arity, sink, file}
      for (const [url, meta] of seen) {
        const m = M.matchOne(url, e);
        const rank = RANK[m.tier] || 0;
        if (rank >= RANK.templated && (!best || rank > best.rank)) best = { url, tier: m.tier, rank, arity: meta.arity, sink: meta.sink, file: meta.file };
      }
      if (!best) continue;   // detail says lynx-only, but this build/base didn't reproduce it; skip
      idxs.push(targets.length);
      usedFiles.add(best.file);
      targets.push({ corpus: "sdk", sdk: sdk.name, endpoint: epId, base, tier: best.tier,
        arity: best.arity, sink: best.sink || "sdk", raw: best.url, file: best.file });
    }
    // Only the files that actually produced a target endpoint go to the harness — for a 1700-file walk SDK
    // this is typically 1-3 route-building modules, so the ablation runs 14 configs over a handful of files,
    // not 14 x 1700. (usedFiles is derived from baseline provenance; recovery under ablation is judged over
    // this same reduced set, keeping baseline/ablated symmetric.)
    if (idxs.length) files[sdk.name] = { base, files: [...usedFiles], idxs };
    process.stderr.write(`  ${sdk.name}: ${idxs.length}/${wanted.size} endpoints reproduced from ${usedFiles.size} of ${fileList.length} file(s)\n`);
  }

  fs.writeFileSync(path.join(o.out, "targets-sdk.jsonl"), targets.map((t) => JSON.stringify(t)).join("\n") + (targets.length ? "\n" : ""));
  fs.writeFileSync(path.join(o.out, "targets-sdk.files.json"), JSON.stringify(files));
  const arityHist = {}, tierHist = {};
  for (const t of targets) { const a = Math.min(t.arity || 1, 64); arityHist[a] = (arityHist[a] || 0) + 1; tierHist[t.tier] = (tierHist[t.tier] || 0) + 1; }
  fs.writeFileSync(path.join(o.out, "targets-sdk.summary.json"), JSON.stringify({ corpus: "sdk",
    targets: targets.length, sdks: Object.keys(files).length, tiers: tierHist,
    arity_hist: Object.fromEntries(Object.entries(arityHist).map(([a, k]) => [+a, k]).sort((x, y) => x[0] - y[0])) }, null, 2));
  console.log(`[*] wrote ${targets.length} SDK targets (${Object.keys(files).length} SDKs) -> ${o.out}/targets-sdk.{jsonl,files.json,summary.json}`);
  console.log(`[*] tiers: ${JSON.stringify(tierHist)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
