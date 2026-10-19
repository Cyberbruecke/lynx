#!/usr/bin/env node
"use strict";
// ------------------------------------------------------------------------------------------------
// run_ablation.js — capability-attribution harness (crawl + SDK corpora).
//
// For every target, run the instrumented LyN-X copy under BASELINE (no ablation) and once per capability
// with that capability disabled (LYNX_ABLATE=<cap>). A target endpoint "requires" capability C iff LyN-X
// recovers it at baseline but no longer recovers it (drops below templated tier) when C alone is off.
//
//   crawl: unit = one target file (sha); recovery = classify(resolveUrl(raw, base), [gt]) >= templated,
//          judged with crawler/lib/match. Runs LyN-X once per file per config.
//   sdk:   unit = one SDK's file set analyzed with the SDK's --base; recovery = matchOne(url, endpoint)
//          >= templated, judged with sdk-study/lib/match_endpoints. Runs LyN-X over the file set per config.
//
//   Output: ablation-<corpus>.jsonl  {sdk?/sha?, gt/endpoint, sink, arity, tier, baselineOk, necessary:[caps]}
//           ablation-<corpus>.runlog.json
//
// Usage: bun run_ablation.js --corpus crawl|sdk [--limit-files N] [--concurrency N] [--out DIR]
// ------------------------------------------------------------------------------------------------

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFile } = require("child_process");
const { IDS } = require("./lynx-ablated/src/core/ablation");

function parseArgs(argv) {
  const o = { corpus: "crawl", crawler: path.join(__dirname, "..", "crawler"), sdk: path.join(__dirname, "..", "sdk-study"),
    lynx: path.join(__dirname, "lynx-ablated", "lyn-x.js"), driver: path.join(__dirname, "ablate_one.js"),
    out: path.join(__dirname, "data"),
    limitFiles: 0, concurrency: Math.max(2, (os.cpus().length || 4) - 1), timeout: 120000, resume: false,
    slowMs: 0, sample: 1 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--corpus") o.corpus = argv[++i];
    else if (a === "--crawler") o.crawler = argv[++i];
    else if (a === "--sdk") o.sdk = argv[++i];
    else if (a === "--lynx") o.lynx = argv[++i];
    else if (a === "--driver") o.driver = argv[++i];
    else if (a === "--out") o.out = argv[++i];
    else if (a === "--limit-files") o.limitFiles = +argv[++i];
    else if (a === "--concurrency") o.concurrency = +argv[++i];
    else if (a === "--timeout") o.timeout = +argv[++i];
    else if (a === "--resume") o.resume = true;
    else if (a === "--slow-ms") o.slowMs = +argv[++i];
    else if (a === "--sample") o.sample = +argv[++i];
    else if (a === "--help" || a === "-h") o.help = true;
  }
  return o;
}

// run instrumented LyN-X on one file; resolve to [raw urls]. cap="" => baseline. base => --base <base>.
function runLynx(o, file, cap, base) {
  return new Promise((resolve) => {
    const tmp = path.join(os.tmpdir(), "abl_" + crypto.randomUUID() + ".json");
    const env = { ...process.env, LYNX_TRACK_ARITY: "1" };
    if (cap) env.LYNX_ABLATE = cap; else delete env.LYNX_ABLATE;
    const args = [o.lynx, file]; if (base) args.push("--base", base); args.push("--json", tmp);
    execFile(process.execPath, args, { env, timeout: o.timeout, maxBuffer: 1 << 28 }, (err) => {
      let urls = [];
      try { urls = (JSON.parse(fs.readFileSync(tmp, "utf8")).results || []).filter((r) => r.url).map((r) => r.url); } catch {}
      try { fs.unlinkSync(tmp); } catch {}
      resolve({ urls, err: err ? String(err.code || err.message) : null });
    });
  });
}
// Run ALL configs for one file in a SINGLE process (baseline + each triggered cap via ablate_one.js's
// in-process setDisabled loop), instead of one process per config. Returns {baseSet, capSets, err}. This
// is the crawl hot-path optimization: Node cold-start + module load is paid once per file, not ~14x.
function runDriver(o, file, caps) {
  return new Promise((resolve) => {
    const tmp = path.join(os.tmpdir(), "abl_" + crypto.randomUUID() + ".jsonl");
    const args = [o.driver, file, "--caps", caps.join(","), "--out", tmp];
    if (o.slowMs > 0) args.push("--slow-ms", String(o.slowMs));
    // One process does 1 + caps.length analyses, so the timeout budgets the WHOLE file (o.timeout per
    // config). A killed driver still leaves every config it flushed before the kill — we read those.
    const timeout = o.timeout * (1 + caps.length);
    execFile(process.execPath, args, { env: process.env, timeout, maxBuffer: 1 << 28 }, (err) => {
      const capSets = {}; let baseSet = new Set(), derr = null, sawDone = false, slow = 0;
      try {
        for (const line of fs.readFileSync(tmp, "utf8").split("\n")) {
          if (!line) continue; const r = JSON.parse(line);
          if (r.done) { sawDone = true; continue; }
          if (r.slow) { slow = r.slow; continue; }
          if (r.err && !derr) derr = r.config + ":" + r.err;
          if (r.config === "") baseSet = new Set(r.urls || []);
          else if (r.config) capSets[r.config] = new Set(r.urls || []);
        }
      } catch {}
      try { fs.unlinkSync(tmp); } catch {}
      // A cap the driver never reached (timeout/kill) simply isn't in capSets -> not tested for this file,
      // same effect as being token-filtered out. Flag incomplete files in the runlog via `err`.
      const killErr = err ? String(err.code || err.message) : null;
      const incomplete = !sawDone ? `incomplete(${Object.keys(capSets).length + 1}/${1 + caps.length})` : null;
      resolve({ baseSet, capSets, slow, err: killErr || derr || incomplete });
    });
  });
}

// union LyN-X output over several files, running up to o.concurrency of them at once (SDK file sets can be
// hundreds of small resource modules — cloudflare's 1949 endpoints span 626 files — so per-file parallelism
// inside a config is what keeps the run tractable; SDKs themselves are then processed one at a time).
async function runLynxFiles(o, files, cap, base) {
  const set = new Set(); let err = null, i = 0;
  const worker = async () => { while (i < files.length) { const f = files[i++]; const r = await runLynx(o, f, cap, base); for (const u of r.urls) set.add(u); if (r.err) err = r.err; } };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(o.concurrency, files.length)) }, worker));
  return { urls: [...set], err };
}

const configs = ["", ...IDS];   // "" = baseline (used by the SDK path)

// Sound source-token pre-filter: a capability can only be REQUIRED by a file if the construct it resolves is
// present. `null` => always run (near-universal constructs). For the rest, the token is a NECESSARY condition:
// if it is absent the capability cannot fire, so disabling it cannot change the output and we skip its run.
// (Over-running is always safe; we only ever SKIP when the construct provably can't occur.)
const TRIGGER = {
  concat: null, member: null, interproc: null, collection_widen: null,
  iteration: /for|forEach|\.map|\.filter|\.reduce/,
  collection_build: /Object\.assign|\.\.\.|\]\s*=|\[\s*['"`]/,
  iter_forward: /forEach|\.map/,
  template: /`/,
  array_join: /\.join/,
  atob: /atob/,
  fromCharCode: /fromCharCode/,
  str_transform: /toLowerCase|toUpperCase|\.trim|\.slice|substring|substr|normalize/,
  str_replace: /\.replace/,
  new_url: /URL/,
  query_params: /URLSearchParams|searchParams/,
  promise: /\.then|\.catch|\.finally/,
};
const capsToRun = (src) => IDS.filter((cap) => { const t = TRIGGER[cap]; return t == null || t.test(src); });

// stream the targets jsonl (1M+ lines, ~1 GB) grouped by sha so we never hold a giant string or index array.
// Split on "\n" ONLY (not readline) — Node's readline also breaks on U+2028/U+2029, which JSON.stringify leaves
// literal inside URL strings, truncating lines; "\n" is JSON.stringify's only real line break so this is exact.
async function readTargetsBySha(file) {
  const bySha = new Map();
  const stream = fs.createReadStream(file, { encoding: "utf8" });
  let carry = "";
  const emit = (line) => { if (!line) return; const t = JSON.parse(line); let a = bySha.get(t.sha); if (!a) bySha.set(t.sha, a = []); a.push(t); };
  for await (const chunk of stream) { const s = carry + chunk; let i = 0, nl; while ((nl = s.indexOf("\n", i)) >= 0) { emit(s.slice(i, nl)); i = nl + 1; } carry = s.slice(i); }
  if (carry) emit(carry);
  return bySha;
}

async function runCrawl(o) {
  const { runPool } = require(path.join(o.crawler, "lib", "util"));
  const jsDir = path.join(o.crawler, "out", "js");
  // Recovery is exact raw-string presence: a target "requires" cap C iff its raw output string is in the fresh
  // BASELINE run but NOT in the (cap-off) run. Baseline is re-run per file with the SAME runtime as the ablated
  // configs (not read from cache), so the diff is runtime-agnostic. Ablated configs are token-pre-filtered.
  const bySha = await readTargetsBySha(path.join(o.out, "targets-crawl.jsonl"));
  let shas = [...bySha.keys()];
  // Deterministic subsample (stable across resume): keep a sha iff hash(sha) falls in the first `sample`
  // fraction. Cuts runtime ~proportionally and thins the heavy tail with it; the CDF percentages are
  // statistical, so a large sample barely moves them. sample=1 (default) keeps everything.
  if (o.sample < 1) { const cut = Math.floor(o.sample * 0x10000); shas = shas.filter((s) => (parseInt(s.slice(0, 4), 16) < cut)); }
  if (o.limitFiles) shas = shas.slice(0, o.limitFiles);

  // Resume: a done-log sidecar records each completed sha. On --resume we skip those and APPEND to the
  // existing jsonl, so a multi-day run survives a crash/Ctrl-C without redoing finished files.
  const outPath = path.join(o.out, "ablation-crawl.jsonl"), donePath = path.join(o.out, "ablation-crawl.done");
  const done0 = new Set();
  if (o.resume && fs.existsSync(donePath)) { for (const s of fs.readFileSync(donePath, "utf8").split("\n")) if (s) done0.add(s); }
  const skip = done0.size; if (skip) shas = shas.filter((s) => !done0.has(s));
  const mode = o.resume && skip ? "a" : "w";
  console.error(`[run:crawl] ${shas.length} files${skip ? ` (resume: ${skip} already done)` : ""}, one process per file @ conc ${o.concurrency}`);

  // stream results straight to disk (the output jsonl is ~1 GB). writeRow/markDone have no await, so under
  // Node's single-threaded event loop the concurrent workers can't interleave a partial line.
  const outFd = fs.openSync(outPath, mode), doneFd = fs.openSync(donePath, mode);
  let obuf = "", dbuf = "", written = 0, okCount = 0;
  const writeRow = (r) => { obuf += JSON.stringify(r) + "\n"; written++; if (r.baselineOk) okCount++; if (obuf.length > (8 << 20)) { fs.writeSync(outFd, obuf); obuf = ""; } };
  const markDone = (sha) => { dbuf += sha + "\n"; if (dbuf.length > (1 << 16)) { fs.writeSync(doneFd, dbuf); dbuf = ""; } };
  const runlog = []; let done = 0, runCount = 0, slowFiles = 0, slowTargets = 0;
  const slowFd = fs.openSync(path.join(o.out, "ablation-crawl.slow"), mode); let sbuf = "";
  await runPool(shas, async (sha) => {
    const file = path.join(jsDir, sha + ".js");
    if (!fs.existsSync(file)) { runlog.push({ sha, missing: true }); markDone(sha); return; }
    let src = ""; try { src = fs.readFileSync(file, "utf8"); } catch {}
    const caps = capsToRun(src);
    // one process: baseline + every triggered cap, in-process (module load paid once)
    const { baseSet, capSets, slow, err } = await runDriver(o, file, caps); runCount += 1 + caps.length;
    if (err) runlog.push({ sha, ranCaps: caps.length, baseCount: baseSet.size, err });
    // --slow-ms: baseline was too slow, cap-runs skipped. EXCLUDE the file (no partial attribution) and
    // log it so the excluded coverage is reported, not silently dropped.
    if (slow) { slowFiles++; slowTargets += (bySha.get(sha) || []).length;
      sbuf += `${sha} ${slow} ${(bySha.get(sha) || []).length}\n`; if (sbuf.length > (1 << 16)) { fs.writeSync(slowFd, sbuf); sbuf = ""; }
      markDone(sha); return; }
    for (const t of bySha.get(sha)) {
      const baselineOk = baseSet.has(t.raw);
      const necessary = [];
      if (baselineOk) for (const cap of caps) if (!capSets[cap].has(t.raw)) necessary.push(cap);
      writeRow({ sha: t.sha, raw: t.raw, kind: t.kind, sub: t.sub, gt: t.gt || null, domain: t.domain,
        sink: t.sink, arity: t.arity, tier: t.tier || null, baselineOk, necessary });
    }
    markDone(sha);
    if (++done % 25 === 0 || done === shas.length) process.stderr.write(`\r  ${done}/${shas.length} files, ${runCount} runs, ${written} targets`);
  }, { concurrency: o.concurrency });
  if (obuf) fs.writeSync(outFd, obuf);
  if (dbuf) fs.writeSync(doneFd, dbuf);
  if (sbuf) fs.writeSync(slowFd, sbuf);
  fs.closeSync(outFd); fs.closeSync(doneFd); fs.closeSync(slowFd);
  process.stderr.write("\n");
  if (slowFiles) console.error(`[run:crawl] excluded ${slowFiles} slow files (${slowTargets} targets) over --slow-ms=${o.slowMs}; logged to ablation-crawl.slow`);
  return { wrote: true, count: written, okCount, runlog };
}

async function runSdk(o) {
  const M = require(path.join(o.sdk, "lib", "match_endpoints"));
  const { runPool } = require(path.join(o.crawler, "lib", "util"));
  const RANK = { exact: 3, templated: 2, fragment: 1, miss: 0 };

  const targets = fs.readFileSync(path.join(o.out, "targets-sdk.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const bySdk = JSON.parse(fs.readFileSync(path.join(o.out, "targets-sdk.files.json"), "utf8"));
  let names = Object.keys(bySdk); if (o.limitFiles) names = names.slice(0, o.limitFiles);

  // gt endpoint objects per sdk (for matchOne)
  const gtCache = {};
  const gtFor = (sdk) => {
    if (gtCache[sdk]) return gtCache[sdk];
    const f = path.join(o.sdk, "gt", `${sdk}.jsonl`);
    const m = new Map();
    if (fs.existsSync(f)) for (const l of fs.readFileSync(f, "utf8").trim().split(/\r?\n/).filter(Boolean)) {
      const e = JSON.parse(l); const n = M.normalizeSpec(`${e.method} ${e.path}`, e.url, e.path); m.set(n.id, n);
    }
    return (gtCache[sdk] = m);
  };
  const recovers = (urls, ep) => { for (const u of urls) { const m = M.matchOne(u, ep); if ((RANK[m.tier] || 0) >= 2) return true; } return false; };

  console.error(`[run:sdk] ${names.length} SDKs x ${configs.length} configs (files parallel @ conc ${o.concurrency}, SDKs sequential)`);
  const results = [], runlog = []; let done = 0; const t0 = Date.now();
  // SDKs sequential; the file set of each config runs in parallel (runLynxFiles) so big SDKs use every core.
  for (const sdk of names) {
    const { base, files, idxs } = bySdk[sdk];
    const gt = gtFor(sdk);
    process.stderr.write(`  [${++done}/${names.length}] ${sdk} (${files.length} file(s), ${idxs.length} endpoints) ...`);
    const runs = {}; for (const cap of configs) runs[cap] = await runLynxFiles(o, files, cap, base);
    const meta = { sdk, files: files.length, counts: {}, errs: {} };
    for (const cap of configs) { const k = cap || "baseline"; meta.counts[k] = runs[cap].urls.length; if (runs[cap].err) meta.errs[k] = runs[cap].err; }
    runlog.push(meta);
    for (const ti of idxs) {
      const t = targets[ti]; const ep = gt.get(t.endpoint);
      if (!ep) { results.push({ sdk, endpoint: t.endpoint, sink: t.sink, arity: t.arity, tier: t.tier, baselineOk: false, necessary: [] }); continue; }
      const baselineOk = recovers(runs[""].urls, ep);
      const necessary = [];
      if (baselineOk) for (const cap of IDS) if (!recovers(runs[cap].urls, ep)) necessary.push(cap);
      results.push({ sdk, endpoint: t.endpoint, gt: t.endpoint, domain: sdk, sink: t.sink, arity: t.arity, tier: t.tier, baselineOk, necessary });
    }
    process.stderr.write(` done (${((Date.now() - t0) / 1000).toFixed(0)}s elapsed, ${results.length} targets)\n`);
  }
  return { results, runlog };
}

// "both"/"all"/"crawl,sdk" -> run each corpus in turn (each writes its own ablation-<corpus>.* files).
function corpusList(s) {
  const v = String(s || "crawl").toLowerCase();
  if (v === "both" || v === "all") return ["crawl", "sdk"];
  return v.split(",").map((x) => x.trim()).filter(Boolean);
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) { console.log("Usage: bun run_ablation.js --corpus crawl|sdk|both [--limit-files N] [--concurrency N] [--out DIR]"); return; }
  const corpora = corpusList(o.corpus);
  for (const corpus of corpora) {
    const co = { ...o, corpus };
    const res = corpus === "sdk" ? await runSdk(co) : await runCrawl(co);
    fs.writeFileSync(path.join(o.out, `ablation-${corpus}.runlog.json`), JSON.stringify(res.runlog, null, 1));
    if (res.wrote) {                                       // crawl: results already streamed to disk
      console.log(`[*] [${corpus}] scored ${res.count} targets (${res.okCount} reproduced at baseline, ${res.count - res.okCount} not)`);
    } else {
      fs.writeFileSync(path.join(o.out, `ablation-${corpus}.jsonl`), res.results.map((r) => JSON.stringify(r)).join("\n") + "\n");
      const okN = res.results.filter((r) => r.baselineOk).length;
      console.log(`[*] [${corpus}] scored ${res.results.length} targets (${okN} reproduced at baseline, ${res.results.length - okN} not)`);
    }
  }
  console.log(`[*] evaluate: node evaluate.js --corpus ${corpora.join(",")} --out ${o.out}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
