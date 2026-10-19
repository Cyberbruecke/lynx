#!/usr/bin/env node
"use strict";
// Construction-arity histogram (research). Runs LyN-X with LYNX_TRACK_ARITY=1 over a sample of the analyzed
// corpus and aggregates the per-URL `arity` (how many source fragments were concatenated to build the URL,
// INCLUDING pieces that resolved to literals). A URL with arity N is stitched from N fragments that a regex
// tool would surface as N disconnected strings (or miss) — the motivation for a reconstruction-capable tool.
//
//   node arity_hist.js --sample 3000 --concurrency 16
//
// Writes results/arity-hist.json (feeds make_figures.py) + a console table.

const fs = require("fs");
const path = require("path");
const { requireJsCorpus } = require("./lib/corpus");
const os = require("os");
const crypto = require("crypto");
const { execFile } = require("child_process");
const { runPool } = require("./lib/util");

function parseArgs(argv) {
  const o = { out: path.join(__dirname, "out"), results: path.join(__dirname, "..", "results"),
    lynx: path.join(__dirname, "..", "lynx", "lyn-x.js"), sample: 2000,
    concurrency: Math.max(2, os.cpus().length), timeout: 45000, urlOnly: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") o.out = argv[++i];
    else if (a === "--results") o.results = argv[++i];
    else if (a === "--lynx") o.lynx = argv[++i];
    else if (a === "--sample") o.sample = +argv[++i];         // # files to analyze (0 = all scored)
    else if (a === "--concurrency") o.concurrency = +argv[++i];
    else if (a === "--timeout") o.timeout = +argv[++i];
    else if (a === "--all-results") o.urlOnly = false;        // include non-URL fragments too
    else if (a === "--help" || a === "-h") o.help = true;
  }
  return o;
}

const runLynx = (lynxPath, file, timeout) => new Promise((res) => {
  const tmp = path.join(os.tmpdir(), "arity_" + crypto.randomUUID() + ".json");
  execFile(process.execPath, [lynxPath, file, "--json", tmp],
    { timeout, env: { ...process.env, LYNX_TRACK_ARITY: "1" }, maxBuffer: 64 * 1024 * 1024 }, () => {
      let rows = [];
      try { rows = JSON.parse(fs.readFileSync(tmp, "utf8")).results || []; } catch {}
      try { fs.unlinkSync(tmp); } catch {}
      res(rows);
    });
});

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) { console.log("Usage: node arity_hist.js [--sample N] [--concurrency N] [--timeout MS] [--all-results]"); return; }
  const jsDir = path.join(o.out, "js"), lynxDir = path.join(o.out, "tools", "lynx");
  requireJsCorpus(o.out);
  if (!fs.existsSync(lynxDir)) { console.error("no lynx tool cache — run compare.js first"); process.exit(1); }
  // sample shas LyN-X already scored (present in the tool cache) that are still on disk
  let shas = fs.readdirSync(lynxDir).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5))
    .filter((s) => fs.existsSync(path.join(jsDir, s + ".js")));
  if (o.sample && shas.length > o.sample) { const step = Math.ceil(shas.length / o.sample); shas = shas.filter((_, i) => i % step === 0).slice(0, o.sample); }
  process.stderr.write(`[arity] running LyN-X (LYNX_TRACK_ARITY) over ${shas.length} files ...\n`);

  const isUrl = (u) => /^https?:\/\//i.test(u) || /^\{[A-Z_]+:[^}]*\}\//.test(u) || u.startsWith("//");
  const hist = {}; const arities = []; let n = 0;
  await runPool(shas, async (sha) => {
    const rows = await runLynx(o.lynx, path.join(jsDir, sha + ".js"), o.timeout);
    for (const r of rows) {
      if (o.urlOnly && !isUrl(r.url || "")) continue;
      const a = r.arity || 1;
      hist[a] = (hist[a] || 0) + 1; arities.push(a);
    }
    if (++n % 200 === 0) process.stderr.write(`\r  ${n}/${shas.length}`);
  }, { concurrency: o.concurrency });
  process.stderr.write("\n");

  arities.sort((a, b) => a - b);
  const total = arities.length;
  const mean = total ? arities.reduce((x, y) => x + y, 0) / total : 0;
  const median = total ? arities[total >> 1] : 0;
  const ge = (k) => arities.filter((a) => a >= k).length;
  const out = { total, files: shas.length, mean: +mean.toFixed(3), median,
    constructed_frac: +(ge(2) / Math.max(1, total)).toFixed(4),      // >=2 pieces = genuinely assembled
    heavily_constructed_frac: +(ge(4) / Math.max(1, total)).toFixed(4),
    hist: Object.fromEntries(Object.entries(hist).sort((a, b) => (+a[0]) - (+b[0]))) };
  fs.mkdirSync(o.results, { recursive: true });
  fs.writeFileSync(path.join(o.results, "arity-hist.json"), JSON.stringify(out, null, 2));

  console.log(`\n[arity] ${total} URLs over ${shas.length} files | mean=${out.mean} median=${out.median}`);
  console.log(`  constructed (>=2 pieces): ${(100 * out.constructed_frac).toFixed(1)}%  |  heavily (>=4): ${(100 * out.heavily_constructed_frac).toFixed(1)}%`);
  console.log("  arity : count");
  for (const [a, c] of Object.entries(out.hist)) console.log(`  ${String(a).padStart(5)} : ${c}`);
  console.log(`[*] wrote ${path.join(o.results, "arity-hist.json")}  (figure: make_figures.py draws arity-hist.{png,pdf})`);
}

main().catch((e) => { console.error(e); process.exit(1); });
