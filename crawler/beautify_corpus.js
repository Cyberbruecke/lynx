#!/usr/bin/env node
"use strict";
// One-pass corpus normalizer. Walks the JS corpus and, for each file:
//   - parses as JS  -> BEAUTIFY it in place (overwrite the minified original)
//   - not JS        -> DELETE it  (HTML pages mislabeled as .js, truncated/binary downloads)
// Result: a single beautified, JS-only corpus — no separate minified + pretty copies. CodeQL needs
// non-minified JS; regex/AST tools are unaffected by formatting; LyN-X reports beautified line/col.
// js-index.csv is left untouched as the record of the original crawl, so the filtered fraction is
// (index rows) - (files remaining).
//
// TRULY parallel: parse+beautify are synchronous CPU work, so this uses WORKER THREADS (one per core),
// not async concurrency (which would run on a single thread). --concurrency defaults to all cores.
//
// --dry-run (default): count keep / html-dropped / unparseable-dropped; write only the report + dropped.csv.
// --apply: beautify-in-place (atomic temp+rename) + delete non-JS. Re-runnable (beautify of beautified
//   is stable; deleted files stay deleted).
//
// Usage: node beautify_corpus.js --js out/js [--apply] [--concurrency N]

const fs = require("fs");
const path = require("path");
const os = require("os");
const { Worker, isMainThread, parentPort, workerData } = require("worker_threads");

const acorn = require(path.join(__dirname, "..", "lynx", "node_modules", "acorn"));
const { looksHtml } = require(path.join(__dirname, "..", "lynx", "src", "html"));

// Same acceptance test LyN-X uses: acorn parse, script then module fallback.
const parsesAsJs = (code) => {
  for (const sourceType of ["script", "module"]) {
    try { acorn.parse(code, { ecmaVersion: "latest", sourceType }); return true; } catch {}
  }
  return false;
};

// ---------------------------------------------------------------- worker
if (!isMainThread) {
  const { files, jsDir, apply } = workerData;
  const beautify = apply ? require("js-beautify").js : null;
  const st = { kept: 0, html: 0, unparseable: 0, bytesIn: 0, bytesOut: 0, dropped: [] };
  let since = 0;
  for (const f of files) {
    const p = path.join(jsDir, f);
    let code;
    try { code = fs.readFileSync(p, "utf8"); } catch { continue; }
    if (parsesAsJs(code)) {
      st.kept++;
      if (apply) {
        let out; try { out = beautify(code, { indent_size: 2, max_preserve_newlines: 1 }); } catch { out = code; }
        try {
          const tmp = p + ".tmp";                    // atomic in-place: temp then rename over original
          fs.writeFileSync(tmp, out);
          fs.renameSync(tmp, p);
          st.bytesIn += Buffer.byteLength(code); st.bytesOut += Buffer.byteLength(out);
        } catch {}
      }
    } else {
      const reason = looksHtml(code) ? "html" : "unparseable";
      st[reason]++; st.dropped.push(`${reason},${f.replace(/\.js$/, "")}`);
      if (apply) { try { fs.unlinkSync(p); } catch {} }
    }
    if (++since >= 1000) { parentPort.postMessage({ progress: since }); since = 0; }
  }
  parentPort.postMessage({ done: st });
} else {
  // ---------------------------------------------------------------- main
  main().catch((e) => { console.error(e); process.exit(1); });
}

function parseArgs(argv) {
  const o = { js: path.join(__dirname, "out", "js"), results: path.join(__dirname, "..", "results"),
    apply: false, concurrency: os.cpus().length };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--js") o.js = argv[++i];
    else if (a === "--results") o.results = argv[++i];
    else if (a === "--apply") o.apply = true;
    else if (a === "--dry-run") o.apply = false;
    else if (a === "--concurrency") o.concurrency = +argv[++i];
    else if (a === "--help" || a === "-h") o.help = true;
  }
  return o;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) { console.log("Usage: node beautify_corpus.js --js out/js [--apply] [--concurrency N]"); return; }
  if (!fs.existsSync(o.js)) { console.error(`no such dir: ${o.js}`); process.exit(1); }
  if (o.apply) { try { require.resolve("js-beautify"); } catch { console.error("[!] --apply needs js-beautify: npm i js-beautify"); process.exit(1); } }

  const files = fs.readdirSync(o.js).filter((f) => f.endsWith(".js"));
  const N = Math.max(1, Math.min(o.concurrency, files.length));
  const chunks = Array.from({ length: N }, () => []);
  files.forEach((f, i) => chunks[i % N].push(f));   // round-robin so big/small files spread across workers

  const agg = { total: files.length, kept: 0, html: 0, unparseable: 0, bytesIn: 0, bytesOut: 0 };
  const dropped = [];
  let done = 0, workersFailed = 0;
  console.error(`[*] ${files.length} files, ${N} worker threads ...`);
  // A worker crash (e.g. OOM on a giant file) is NON-fatal: log it and finish the others. The pass is
  // idempotent (beautifying beautified JS is stable), so a re-run mops up any chunk a dead worker skipped.
  await Promise.all(chunks.map((chunk) => new Promise((resolve) => {
    const w = new Worker(__filename, { workerData: { files: chunk, jsDir: o.js, apply: o.apply } });
    w.on("message", (m) => {
      if (m.progress) { done += m.progress; process.stderr.write(`\r    processed ${done}/${files.length}`); }
      else if (m.done) {
        const s = m.done;
        agg.kept += s.kept; agg.html += s.html; agg.unparseable += s.unparseable;
        agg.bytesIn += s.bytesIn; agg.bytesOut += s.bytesOut; dropped.push(...s.dropped);
      }
    });
    w.on("error", (e) => { workersFailed++; process.stderr.write(`\n[warn] worker crashed (chunk left unprocessed, re-run to finish): ${e.message}\n`); resolve(); });
    w.on("exit", (code) => { if (code !== 0) process.stderr.write(`\n[warn] worker exited ${code}\n`); resolve(); });
  })));
  process.stderr.write(`\r    processed ${done}/${files.length}\n`);
  if (workersFailed) console.log(`[!] ${workersFailed} worker(s) crashed — some files unprocessed; lower --concurrency and re-run to finish.`);

  const dropTotal = agg.html + agg.unparseable;
  const pct = (x) => (agg.total ? (100 * x / agg.total).toFixed(1) + "%" : "-");
  console.log(`[*] ${o.apply ? "APPLIED" : "DRY RUN"} — ${agg.total} files in ${o.js}:`);
  console.log(`      keep (beautified JS): ${agg.kept}  (${pct(agg.kept)})`);
  console.log(`      drop html           : ${agg.html}  (${pct(agg.html)})`);
  console.log(`      drop unparseable    : ${agg.unparseable}  (${pct(agg.unparseable)})`);
  console.log(`      total removed       : ${dropTotal}  (${pct(dropTotal)})`);

  ensureResultsDir(o.results);
  fs.writeFileSync(path.join(o.results, "dropped.csv"), "reason,sha\n" + dropped.join("\n") + (dropped.length ? "\n" : ""));
  console.log(`[*] wrote ${path.join(o.results, "dropped.csv")} (${o.apply ? "removed" : "would remove"} ${dropTotal})`);
  if (o.apply && agg.bytesIn) console.log(`[*] kept-file size: ${(agg.bytesIn / 1e6).toFixed(0)}MB minified -> ${(agg.bytesOut / 1e6).toFixed(0)}MB beautified (single copy, no separate js-pretty)`);
  if (!o.apply) console.log(`[*] dry run — pass --apply to beautify-in-place + delete the ${dropTotal} non-JS files`);
}

function ensureResultsDir(d) { fs.mkdirSync(d, { recursive: true }); }
