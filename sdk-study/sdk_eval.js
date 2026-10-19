#!/usr/bin/env node
"use strict";
// P5 — run the extraction tools over each SDK's JS and score recovered endpoints against the spec-derived
// ground truth (gt/<name>.jsonl) with the path-template matcher. Reuses crawler/lib/tools (BASE_TOOLS:
// linkfinder, jsluice, relwarc, lynx obfuscated). Per SDK, the analyzed target
// is out/sdk/<name>/dist.js if present (a bundled realistic artifact), else every .js under out/sdk/<name>/pkg.
//
// Outputs (results/): sdk-recall.csv (per sdk×tool), sdk-by-style.csv (pooled per style×tool),
// sdk-detail.csv (per endpoint×tool best tier). Prints a pooled per-tool table.
//
// Usage: node sdk_eval.js [--only name1,name2] [--tools t1,t2] [--timeout MS] [--results DIR]

const fs = require("fs");
const path = require("path");
const os = require("os");
const { adapters, toolAvailable, BASE_TOOLS } = require("../crawler/lib/tools");
const { runPool } = require("../crawler/lib/util");
const M = require("./lib/match_endpoints");

function parseArgs(argv) {
  const o = { tools: [...BASE_TOOLS], lynx: path.join(__dirname, "..", "lynx", "lyn-x.js"),
    results: path.join(__dirname, "results"), timeout: 30000, concurrency: Math.max(2, os.cpus().length), only: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--only") o.only = new Set(argv[++i].split(","));
    else if (a === "--tools") o.tools = argv[++i].split(",");
    else if (a === "--lynx") o.lynx = argv[++i];
    else if (a === "--timeout") o.timeout = +argv[++i];
    else if (a === "--results") o.results = argv[++i];
    else if (a === "--concurrency") o.concurrency = +argv[++i];
  }
  return o;
}

const walkJs = (dir) => {                                   // all .js under dir (recursive)
  const out = [];
  const rec = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) rec(p); else if (e.name.endsWith(".js")) out.push(p);
  } };
  if (fs.existsSync(dir)) rec(dir);
  return out;
};

function targetFiles(sdk) {                                 // realistic bundle if present, else the SDK's own .js
  const dir = path.join(__dirname, "out", "sdk", sdk.name);
  const dist = path.join(dir, "dist.js");
  if (fs.existsSync(dist)) return [dist];
  const inst = path.join(dir, "node_modules", sdk.npm);     // npm install layout (deps present)
  if (fs.existsSync(inst)) return walkJs(inst);
  return walkJs(path.join(dir, "pkg"));                      // legacy npm-pack layout
}

function loadGt(name) {
  const f = path.join(__dirname, "gt", `${name}.jsonl`);
  if (!fs.existsSync(f)) return null;
  return fs.readFileSync(f, "utf8").trim().split(/\r?\n/).filter(Boolean).map((l) => {
    const e = JSON.parse(l); return { ...M.normalizeSpec(`${e.method} ${e.path}`, e.url, e.path), style: e.style };
  });
}

// The SDK's configured base = the spec server URL = a GT entry's full url with its route path stripped
// (e.g. https://api.openai.com/v1/assistants minus /assistants -> https://api.openai.com/v1). Passed to
// lynx as --base so it reconstructs FULL URLs (baseURL + route) exactly as the SDK does at runtime.
function loadBase(name) {
  const f = path.join(__dirname, "gt", `${name}.jsonl`);
  if (!fs.existsSync(f)) return null;
  const first = fs.readFileSync(f, "utf8").split(/\r?\n/).find(Boolean);
  if (!first) return null;
  const e = JSON.parse(first);
  if (e.url && e.path && e.url.endsWith(e.path)) return e.url.slice(0, e.url.length - e.path.length);
  try { return new URL(e.url).origin; } catch { return null; }
}

async function urlsForTool(tool, files, o) {                // union of a tool's output across the SDK's files
  const set = new Set();
  await runPool(files, async (f) => {
    let urls = []; try { urls = await adapters[tool](f, o); } catch {}
    for (const u of urls) set.add(u);
  }, { concurrency: o.concurrency });
  return [...set];
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "sdks.json"), "utf8"));
  const sdks = manifest.sdks.filter((s) => (!o.only || o.only.has(s.name)) && loadGt(s.name));
  if (!sdks.length) { console.error("[!] no SDKs with gt/<name>.jsonl — run fetch_sdks.js + extract_groundtruth.js first"); process.exit(1); }
  // The artifact ships each SDK's spec and pinned package.json but not its sources (1.5 GB). Running
  // without them scores every SDK 0 and would OVERWRITE the shipped results/ CSVs with zeros, so refuse.
  if (!sdks.some((s) => targetFiles(s).length)) {
    console.error("[!] no SDK sources under out/sdk/<name>/ — every SDK would score 0 and overwrite results/.\n" +
      "    Install them at the pinned versions:  for d in out/sdk/*/; do (cd \"$d\" && npm install --silent); done\n" +
      "    Or just read the shipped results/sdk-*.csv.");
    process.exit(1);
  }

  const tools = [];
  for (const t of o.tools) { if (await toolAvailable(t, o)) tools.push(t); else console.error(`[!] ${t} unavailable — skipping`); }
  if (!tools.length) { console.error("[!] no tools available"); process.exit(1); }

  fs.mkdirSync(o.results, { recursive: true });
  const recallRows = [["sdk", "style", "tool", "recall", "precision", "exact", "templated", "partial", "total", "emitted"]];
  const detailRows = [["sdk", "endpoint", "tool", "tier"]];
  const pooled = {}, byStyle = {}, byGroup = {};            // tool -> {recovered,total,hits,emitted}
  const bump = (acc, key, r) => {
    const a = (acc[key] = acc[key] || { recovered: 0, total: 0, hits: 0, emitted: 0 });
    a.recovered += r.recovered; a.total += r.total; a.hits += Math.round(r.precision * r.emitted); a.emitted += r.emitted;
  };

  for (const sdk of sdks) {
    const gt = loadGt(sdk.name);
    const base = loadBase(sdk.name);
    const files = targetFiles(sdk);
    if (!files.length) { console.error(`[skip] ${sdk.name}: no JS in out/sdk/${sdk.name}`); continue; }
    process.stderr.write(`[*] ${sdk.name} (${gt.length} endpoints, ${files.length} file(s)${base ? `, base ${base}` : ""})\n`);
    for (const t of tools) {
      // Only lynx consumes --base (structured extraction can legitimately inject the SDK's configured base);
      // regex tools emit bare routes and match the server-relative path via the matcher's routeSegs.
      const urls = await urlsForTool(t, files, t === "lynx" ? { ...o, lynxBase: base } : o);
      const r = M.scoreSet(urls, gt);
      recallRows.push([sdk.name, sdk.style, t, r.recall.toFixed(4), r.precision.toFixed(4), r.exact, r.templated, r.partial, r.total, r.emitted]);
      for (const [id, b] of r.best) detailRows.push([sdk.name, id, t, b.tier]);
      bump(pooled, t, r); bump(byStyle, `${sdk.style}|${t}`, r); bump(byGroup, `${sdk.group || "?"}|${t}`, r);
    }
  }

  const csv = (rows) => rows.map((r) => r.join(",")).join("\n") + "\n";
  fs.writeFileSync(path.join(o.results, "sdk-recall.csv"), csv(recallRows));
  fs.writeFileSync(path.join(o.results, "sdk-detail.csv"), csv(detailRows));
  const styleRows = [["style", "tool", "recall", "precision", "recovered", "total"]];
  for (const [k, a] of Object.entries(byStyle)) { const [style, tool] = k.split("|");
    styleRows.push([style, tool, (a.recovered / (a.total || 1)).toFixed(4), (a.hits / (a.emitted || 1)).toFixed(4), a.recovered, a.total]); }
  fs.writeFileSync(path.join(o.results, "sdk-by-style.csv"), csv(styleRows));
  // Pool by URL-production MECHANISM (sdks.json `group`): code = URLs built in code (reconstruction applies)
  // vs data = route tables / discovery docs / caller-passed (no per-endpoint code → reconstruction N/A).
  const groupRows = [["group", "tool", "recall", "precision", "recovered", "total", "emitted"]];
  for (const [k, a] of Object.entries(byGroup)) { const [group, tool] = k.split("|");
    groupRows.push([group, tool, (a.recovered / (a.total || 1)).toFixed(4), (a.hits / (a.emitted || 1)).toFixed(4), a.recovered, a.total, a.emitted]); }
  fs.writeFileSync(path.join(o.results, "sdk-by-group.csv"), csv(groupRows));

  console.log(`\n  POOLED across ${sdks.length} SDK(s):`);
  console.log(`    ${"tool".padEnd(20)} ${"recall".padStart(8)} ${"precision".padStart(10)}   (recovered/total, emitted)`);
  for (const t of tools.sort((a, b) => (pooled[b]?.recovered / (pooled[b]?.total || 1)) - (pooled[a]?.recovered / (pooled[a]?.total || 1)))) {
    const a = pooled[t] || { recovered: 0, total: 0, hits: 0, emitted: 0 };
    console.log(`    ${t.padEnd(20)} ${(100 * a.recovered / (a.total || 1)).toFixed(1).padStart(7)}% ${(100 * a.hits / (a.emitted || 1)).toFixed(1).padStart(9)}%   (${a.recovered}/${a.total}, ${a.emitted})`);
  }
  // per-mechanism breakdown: reconstruction-amenable (code) vs data-embedded (data)
  for (const g of ["code", "data"]) {
    const gsdks = sdks.filter((s) => (s.group || "?") === g);
    const lxRes = gsdks.filter((s) => { const rr = recallRows.find((row) => row[0] === s.name && row[2] === "lynx"); return rr && +rr[3] > 0; }).length;
    console.log(`\n  GROUP=${g} (${gsdks.length} SDKs${g === "code" ? `, LyN-X resolves ${lxRes}` : ""}):`);
    console.log(`    ${"tool".padEnd(20)} ${"recall".padStart(8)} ${"precision".padStart(10)}   (recovered/total, emitted)`);
    for (const t of tools) { const a = byGroup[`${g}|${t}`] || { recovered: 0, total: 0, hits: 0, emitted: 0 };
      console.log(`    ${t.padEnd(20)} ${(100 * a.recovered / (a.total || 1)).toFixed(1).padStart(7)}% ${(100 * a.hits / (a.emitted || 1)).toFixed(1).padStart(9)}%   (${a.recovered}/${a.total}, ${a.emitted})`); }
  }
  console.log(`\n[*] wrote sdk-recall.csv + sdk-by-style.csv + sdk-by-group.csv + sdk-detail.csv to ${o.results}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
