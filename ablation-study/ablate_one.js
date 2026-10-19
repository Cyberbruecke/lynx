#!/usr/bin/env node
"use strict";
// ------------------------------------------------------------------------------------------------
// ablate_one.js — in-process ablation driver for ONE crawl file.
//
// The harness used to spawn lyn-x.js once per (file, config): baseline + each triggered capability, i.e.
// ~14 fresh Node processes per file, each re-paying cold-start + module load + acorn init. This driver
// loads the analyzer ONCE and runs every config in the same process via ablation.setDisabled(), so the
// per-config cost collapses to just the (unavoidable) analyze() pass. Each config still builds a fresh
// LyNX/AST, so results are byte-identical to the multi-process path (all analysis state is per-instance or
// WeakMap-keyed on fresh nodes — verified in ablation.js / shared.js).
//
// Output: writes JSONL to --out, one line per config, FLUSHED after each: {config, urls} (config="" =
// baseline), then a final {done:true}. Streaming so that if the harness kills a pathological file on
// timeout mid-run, every config that already finished is still readable — the file just loses attribution
// for the configs that didn't complete (identical to a token-filtered-out cap: it simply isn't tested).
// Usage: node ablate_one.js <file.js> --caps c1,c2,... --out <tmp.jsonl>
// ------------------------------------------------------------------------------------------------

const fs = require("fs");
const { LyNX } = require("./lynx-ablated/src");
const { setDisabled } = require("./lynx-ablated/src/core/ablation");

function parseArgs(argv) {
  const o = { file: null, caps: [], out: null, slowMs: 0 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--caps") o.caps = (argv[++i] || "").split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--out") o.out = argv[++i];
    else if (a === "--slow-ms") o.slowMs = +argv[++i];
    else if (!a.startsWith("-") && !o.file) o.file = a;
  }
  return o;
}

// Distinct extracted URL strings for the current disabled-set. Mirrors the crawl path of lyn-x.js
// (single local .js, no --base, no --origin, no recursion): analyzeSource -> distinct r.url. remap/dedupe
// in the CLI only touch file/line and drop exact dup rows, so the DISTINCT url set is identical here.
function urlsForConfig(code, domain) {
  const w = new LyNX({ code });
  w.domain = domain || null;
  const rows = w.analyze({ printTable: false });
  const set = new Set();
  for (const r of rows) if (r && r.url) set.add(r.url);
  return [...set];
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  const fd = fs.openSync(o.out, "w");
  const put = (obj) => { fs.writeSync(fd, JSON.stringify(obj) + "\n"); };   // sync write = durable if killed next tick
  let code = "";
  try { code = fs.readFileSync(o.file, "utf8"); }
  catch (e) { put({ err: "read:" + (e.code || e.message) }); put({ done: true }); fs.closeSync(fd); return; }
  // Match assemble's SEP: the CLI parses `code + "\n;\n"` (ASI-safe unit separator). Harmless empty
  // statement, but keep it identical so no parse edge case diverges.
  const bundle = code + "\n;\n";
  const run = (cap, disabled) => {
    try { setDisabled(disabled); put({ config: cap, urls: urlsForConfig(bundle, null) }); }
    catch (e) { put({ config: cap, urls: [], err: (e && e.message) || String(e) }); }
  };
  // Baseline first, timed. The analyze-time distribution is bimodal: ~90% of files finish in <200ms, a
  // small tail takes SECONDS (deep webpack bundles). Each cap-run costs about as much as baseline, so a
  // pathological file costs ~14x its (multi-second) baseline. With --slow-ms>0, if the baseline alone
  // exceeds the budget we record the file as slow and SKIP its cap-runs — the harness then excludes it
  // (rather than half-attribute it), trading a small, reported coverage loss for a bounded tail.
  const t0 = process.hrtime.bigint();
  run("", []);
  const baseMs = Number(process.hrtime.bigint() - t0) / 1e6;
  if (o.slowMs > 0 && baseMs > o.slowMs) { put({ slow: +baseMs.toFixed(0) }); put({ done: true }); fs.closeSync(fd); return; }
  for (const cap of o.caps) run(cap, [cap]);
  put({ done: true });
  fs.closeSync(fd);
}

main();
