#!/usr/bin/env node
"use strict";
// Per-category benchmark: run each URL-reconstructing tool on small JS files that isolate one
// construction technique, score the output against KNOWN expected URL(s) with the shared 3-tier
// matcher, and stratify by suite/category. This is the "central figure" table (independent of the
// crawl corpus). CodeQL is NOT here — it anchors on the sink but does not reconstruct URL strings,
// so it is evaluated on a separate sink-detection axis (see codeql-bench.js).
//
// Inputs : one or more manifests [{file, suite, category, expected:[urls], base?}] + the case files.
// Outputs (in --out): bench-scores.csv, bench-detail.csv, bench-matrix.txt (ASCII),
//                     success-table.tex (LaTeX), benchmark-results.txt (overview), tier-counts.json
//                     (fed to make_figures.py for the stacked-bar chart).

const fs = require("fs");
const path = require("path");
const os = require("os");
const { adapters, toolAvailable, BASE_TOOLS } = require("../crawler/lib/tools");
const { isPurePlaceholder, resolveUrl, scoreDomain, blankAgg, addInto, metricsRow, METRIC_COLS } = require("../crawler/lib/match");
const { csvAppender, runPool } = require("../crawler/lib/util");
const { disp, texEsc } = require("../crawler/lib/report");

function parseArgs(argv) {
  const o = { dir: __dirname, manifest: "", tools: [...BASE_TOOLS],
    lynx: path.join(__dirname, "..", "lynx", "lyn-x.js"), timeout: 8000, base: "https://example.com/",
    out: path.join(__dirname, "..", "results"), relwarcCmd: null, relwarcCwd: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dir") o.dir = argv[++i];
    else if (a === "--manifest") o.manifest = argv[++i];               // comma-separated list
    else if (a === "--tools") o.tools = argv[++i].split(",");
    else if (a === "--lynx") o.lynx = argv[++i];
    else if (a === "--timeout") o.timeout = +argv[++i];
    else if (a === "--out") o.out = argv[++i];
    else if (a === "--relwarc-cmd") o.relwarcCmd = argv[++i].split(" ");
    else if (a === "--relwarc-cwd") o.relwarcCwd = argv[++i];
    else if (a === "--help" || a === "-h") o.help = true;
  }
  o.manifest = o.manifest || [path.join(o.dir, "manifest.json"), path.join(o.dir, "relwarc-manifest.json")].join(",");
  return o;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log("Usage: node bench.js [--manifest a.json,b.json] [--tools linkfinder,jsluice,relwarc,lynx] " +
      "[--lynx path/to/lyn-x.js] [--relwarc-cmd '...'] [--out DIR]");
    return;
  }
  const cases = opts.manifest.split(",").flatMap((m) =>
    JSON.parse(fs.readFileSync(m.trim(), "utf8")).map((c) => ({ suite: "cases", ...c })));
  fs.mkdirSync(opts.out, { recursive: true });

  const tools = [];
  for (const t of opts.tools) { if (await toolAvailable(t, opts)) tools.push(t); else console.error(`[!] skip ${t} (not runnable)`); }
  const suites = [...new Set(cases.map((c) => c.suite))];
  console.log(`[*] ${cases.length} cases (${suites.join(", ")}) | tools: ${tools.map(disp).join(", ")}`);

  // agg[tool][scope] for scope in {each category, "SUITE:<suite>", "OVERALL"} ; per-case detail rows
  const agg = {}, detail = [], timeMs = {};
  for (const t of tools) { agg[t] = {}; timeMs[t] = 0; }
  for (const t of tools) {
    await runPool(cases, async (c) => {
      const file = path.isAbsolute(c.file) ? c.file : path.join(opts.dir, c.file);
      let raw = [];
      const t0 = Date.now();
      try { raw = await adapters[t](file, opts); } catch {}
      timeMs[t] += Date.now() - t0;
      const set = new Set(raw.filter((u) => u && !isPurePlaceholder(u)).map((u) => resolveUrl(u, c.base || opts.base)));
      const gt = c.expected.map((u) => u.split(/[?#]/)[0]);
      const tally = scoreDomain([...set], gt);
      for (const scope of [c.category, `SUITE:${c.suite}`, "OVERALL"]) {
        agg[t][scope] = agg[t][scope] || blankAgg(); addInto(agg[t][scope], tally);
      }
      const best = tally.nExact ? "exact" : tally.nTempl ? "templated" : tally.nWeak ? "weak" : "miss";
      detail.push({ tool: t, suite: c.suite, category: c.category, short: c.short || c.category, file: c.file, best, extracted: [...set] });
    }, { concurrency: Math.max(2, os.cpus().length) });
  }

  // ---- CSVs (metrics per scope; per-case detail) ----
  const scores = csvAppender(path.join(opts.out, "bench-scores.csv"), ["tool", "scope", ...METRIC_COLS], true);
  const scopes = [...cases.map((c) => c.category), ...suites.map((s) => `SUITE:${s}`), "OVERALL"];
  for (const t of tools) for (const s of [...new Set(scopes)]) { const a = agg[t][s]; if (a) scores.row([disp(t), ...metricsRow(s, a)]); }
  scores.close();
  const det = csvAppender(path.join(opts.out, "bench-detail.csv"), ["tool", "suite", "category", "file", "best_tier", "extracted"], true);
  detail.forEach((d) => det.row([disp(d.tool), d.suite, d.category, d.file, d.best, d.extracted.join(" | ")])); det.close();

  // ---- success matrix (rows = cases, cols = tools; ✓ = exact|templated endpoint recovered) ----
  const ok = (tier) => tier === "exact" || tier === "templated";
  const byCase = new Map();  // file -> {suite, category, tiers{tool->tier}}
  for (const d of detail) {
    if (!byCase.has(d.file)) byCase.set(d.file, { suite: d.suite, category: d.category, short: d.short, tiers: {} });
    byCase.get(d.file).tiers[d.tool] = d.best;
  }
  // Suites ordered by difficulty (easiest first), measured by baseline coverage: fraction of
  // (LinkFinder|JSluice|relwarc) hits per suite — relwarc 81% > sinks 70% > dispatch 44% >
  // cases 38% > obfuscation 10%. Unlisted suites sort last (alphabetically).
  const SUITE_ORDER = ["relwarc", "sinks", "dispatch", "cases", "obfuscation"];
  const srank = (s) => { const i = SUITE_ORDER.indexOf(s); return i < 0 ? SUITE_ORDER.length : i; };
  const orderedCases = [...byCase.entries()].sort((a, b) =>
    (srank(a[1].suite) - srank(b[1].suite)) || a[1].suite.localeCompare(b[1].suite));
  const totals = Object.fromEntries(tools.map((t) => [t, 0]));

  // ASCII matrix
  const mrows = [["case", "suite", ...tools.map(disp)]];
  for (const [file, { suite, tiers }] of orderedCases)
    mrows.push([path.basename(file), suite, ...tools.map((t) => { const y = ok(tiers[t]); if (y) totals[t]++; return y ? "✓" : "✗"; })]);
  mrows.push(["TOTAL", "", ...tools.map((t) => `${totals[t]}/${byCase.size}`)]);
  const cw = mrows[0].map((_, i) => Math.max(...mrows.map((r) => String(r[i]).length)));
  const ascii = mrows.map((r) => "  " + r.map((c, i) => String(c).padEnd(cw[i])).join("  ")).join("\n");
  fs.writeFileSync(path.join(opts.out, "bench-matrix.txt"), ascii + "\n");

  // ---- success-table.tex (booktabs; suite = rotated multirow label column; green ✓ = usable endpoint) ----
  // Suite -> display name. "cases" is too generic: these isolate how the URL *string* is built.
  const SUITE_LABEL = { cases: "Construction", dispatch: "Dispatch", obfuscation: "Obfuscation", relwarc: "AJAX (relwarc)", sinks: "Sinks" };
  const suiteName = (s) => SUITE_LABEL[s] || s.charAt(0).toUpperCase() + s.slice(1);
  const yes = "\\ok";                                           // deep green check = recovered
  const no = "\\fail";                                          // deep red cross = missed
  // group consecutive cases by suite (orderedCases is already sorted by SUITE_ORDER, so same-suite is contiguous)
  const groups = [];
  for (const [, r] of orderedCases) {
    if (!groups.length || groups[groups.length - 1].suite !== r.suite) groups.push({ suite: r.suite, rows: [] });
    groups[groups.length - 1].rows.push(r);
  }
  const colspec = "c l " + "c".repeat(tools.length);           // rotated suite | category | one per tool
  let tex = "% Auto-generated by bench.js. Requires \\usepackage{booktabs}, \\usepackage[table]{xcolor},\n";
  tex += "% \\usepackage{multirow} and \\usepackage{graphicx} (rotated per-suite label column).\n";
  tex += "% \\ok = endpoint recovered (exact|templated tier); \\fail = missed.\n";
  tex += "\\providecommand{\\ok}{\\textcolor[HTML]{137333}{$\\checkmark$}}%  deep green\n";
  tex += "\\providecommand{\\fail}{\\textcolor[HTML]{B00020}{$\\times$}}%   deep red\n";
  tex += `\\begin{tabular}{${colspec}}\n\\toprule\n`;
  tex += ` & \\textbf{Category} & ${tools.map((t) => `\\textbf{${texEsc(disp(t))}}`).join(" & ")} \\\\\n`;
  for (const g of groups) {
    tex += "\\midrule\n";
    const label = `\\multirow{${g.rows.length}}{*}{\\rotatebox[origin=c]{90}{\\bfseries ${texEsc(suiteName(g.suite))}}}`;
    g.rows.forEach((r, i) => {
      const cells = tools.map((t) => (ok(r.tiers[t]) ? yes : no));
      tex += `${i === 0 ? label : ""} & ${texEsc(r.short || r.category)} & ${cells.join(" & ")} \\\\\n`;
    });
  }
  tex += "\\midrule\n";
  tex += ` & \\textbf{Total (${byCase.size})} & ${tools.map((t) => `\\textbf{${totals[t]}/${byCase.size}}`).join(" & ")} \\\\\n`;
  tex += "\\bottomrule\n\\end{tabular}\n";
  fs.writeFileSync(path.join(opts.out, "success-table.tex"), tex);

  // ---- tier-counts.json (per-tool per-case best-tier distribution -> stacked bar) ----
  const TIERS = ["exact", "templated", "weak", "miss"];
  const counts = {};
  for (const t of tools) counts[disp(t)] = Object.fromEntries(TIERS.map((k) => [k, 0]));
  for (const d of detail) counts[disp(d.tool)][d.best]++;
  fs.writeFileSync(path.join(opts.out, "tier-counts.json"),
    JSON.stringify({ tools: tools.map(disp), tiers: TIERS, total_cases: byCase.size, counts }, null, 2));

  // ---- benchmark-results.txt (human overview: all the numbers) ----
  const pad = (s, n) => String(s).padEnd(n);
  let txt = "LyN-X benchmark — URL-reconstruction comparison\n" + "=".repeat(52) + "\n\n";
  txt += `Cases: ${byCase.size} (` + suites.map((s) => `${s}=${cases.filter((c) => c.suite === s).length}`).join(", ") + ")\n";
  txt += `Tools: ${tools.map(disp).join(", ")}\n`;
  txt += "Substrate: one local .js file per case (tool-agnostic). Query strings are stripped before\n";
  txt += "matching (host+path scored). Tiers: exact | templated_path | weak | miss.\n";
  txt += "NOTE: CodeQL is reported separately (sink detection, not URL reconstruction) — codeql-bench.js.\n";
  txt += "NOTE: the coherence histogram is a crawl-corpus metric (compare.js), not a benchmark figure.\n\n";

  txt += "Cases solved (exact|templated endpoint recovered):\n";
  for (const t of tools) txt += `  ${pad(disp(t), 12)} ${totals[t]}/${byCase.size}\n`;
  txt += "\nPer-case best tier (exact/templated/weak/miss):\n";
  for (const t of tools) { const c = counts[disp(t)]; txt += `  ${pad(disp(t), 12)} ` + TIERS.map((k) => `${k}=${c[k]}`).join("  ") + "\n"; }

  txt += "\nRuntime (summed tool time across cases; wall-clock of each tool invocation):\n";
  for (const t of tools) txt += `  ${pad(disp(t), 12)} ${timeMs[t]} ms total  (${(timeMs[t] / cases.length).toFixed(1)} ms/case)\n`;

  txt += "\n3-tier precision/recall/F1 + DG/ADG (OVERALL and per suite):\n";
  txt += "  " + pad("tool", 12) + pad("scope", 20) + "gt   F1_strict  F1_medium  F1_relaxed  DG    ADG\n";
  for (const t of tools) for (const s of ["OVERALL", ...suites.map((x) => `SUITE:${x}`)]) {
    const a = agg[t][s]; if (!a) continue;
    const r = metricsRow(s, a); // [label, gt, P_s,R_s,F1_s, P_m,R_m,F1_m, P_r,R_r,F1_r, DG, ADG]
    txt += "  " + pad(disp(t), 12) + pad(s.replace("SUITE:", ""), 20) + pad(r[1], 5)
      + pad(r[4], 11) + pad(r[7], 11) + pad(r[10], 12) + pad(r[11], 6) + r[12] + "\n";
  }
  txt += "\nSuccess matrix (✓ = usable endpoint recovered):\n\n" + ascii + "\n";
  fs.writeFileSync(path.join(opts.out, "benchmark-results.txt"), txt);

  // console
  console.log("\n" + ascii);
  console.log("\n  runtime: " + tools.map((t) => `${disp(t)} ${timeMs[t]}ms`).join("   "));
  console.log(`\n[*] wrote ${opts.out}/{success-table.tex, benchmark-results.txt, tier-counts.json,`);
  console.log(`             bench-scores.csv, bench-detail.csv, bench-matrix.txt}`);
  console.log(`[*] figures: python3 ${path.relative(process.cwd(), path.join(__dirname, "make_figures.py"))} ${opts.out}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
