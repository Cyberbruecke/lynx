#!/usr/bin/env node
"use strict";
// ------------------------------------------------------------------------------------------------
// evaluate.js — aggregate per-target capability attributions, split across five datasets:
//   all            every complete LyN-X output
//   recall         outputs that match a GT endpoint (exact|templated)   [= "GT"]
//   recall_unique  GT matches no regex baseline recovers                [= "GT-LyN-X-only"]
//   car            additional (no GT match), concrete
//   tar            additional (no GT match), templated
//
// For each capability C and dataset D reports how many of D's outputs REQUIRE C (present at baseline, gone
// when C alone is disabled). Also emits a cumulative-coverage CDF per dataset: capabilities ordered by
// contribution, cumulative fraction of D's outputs that would be missed without the top-k capabilities.
//
//   Output (--out): ablation-<corpus>.capabilities.csv, ablation-<corpus>.eval.json, ablation-<corpus>.summary.txt
// Usage: bun evaluate.js --corpus crawl [--out DIR]
// ------------------------------------------------------------------------------------------------

const fs = require("fs");
const path = require("path");
const { IDS } = require("./lynx-ablated/src/core/ablation");

function parseArgs(argv) {
  const o = { corpus: "crawl", out: path.join(__dirname, "data") };
  for (let i = 0; i < argv.length; i++) { const a = argv[i]; if (a === "--corpus") o.corpus = argv[++i]; else if (a === "--out") o.out = argv[++i]; }
  return o;
}
const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);
const pct = (a, b) => (b ? (100 * a / b).toFixed(1) : "0.0");

const DATASETS = {
  all:           () => true,
  recall:        (r) => r.kind === "recall",
  recall_unique: (r) => r.kind === "recall" && r.sub === "unique",
  car:           (r) => r.kind === "additional" && r.sub === "car",
  tar:           (r) => r.kind === "additional" && r.sub === "tar",
};
const DS_LABEL = { all: "all", recall: "GT (recall)", recall_unique: "GT-LyN-X-only", car: "CAR", tar: "TAR" };

const requiredOf = (rows) => { const req = Object.fromEntries(IDS.map((c) => [c, 0])); for (const r of rows) for (const c of (r.necessary || [])) req[c]++; return req; };
// cumulative-coverage CDF under a FIXED capability order: fraction of rows whose necessary[] intersects the
// top-k capabilities (union, so a row needing several caps is counted once). necessary[] is tiny (<=3) so
// .includes is cheaper than allocating a Set per row across 1M+ rows.
function cumulativeUnder(rows, order) {
  const covered = new Array(rows.length).fill(false); const cum = []; let cov = 0;
  for (const cap of order) { for (let i = 0; i < rows.length; i++) if (!covered[i] && (rows[i].necessary || []).includes(cap)) { covered[i] = true; cov++; } cum.push(+(cov / (rows.length || 1)).toFixed(4)); }
  return { cumulative: cum, ceiling: +(cov / (rows.length || 1)).toFixed(4) };
}
// SUBSET (recovery) coverage: an endpoint is recoverable under capability set S iff its ENTIRE required set
// ⊆ S. Unlike the union metric, an endpoint needing {concat,interproc} is NOT counted until BOTH are enabled
// — this is the true "capabilities we turned on -> endpoints we can actually recover" curve. Rows are
// aggregated by their distinct required-set (arity <=7, few distinct combos) so greedy selection is cheap.
function requiredSetCounts(rows) {                          // Map "a,b,c" -> {set:[...], count}
  const m = new Map();
  for (const r of rows) { const s = [...new Set(r.necessary || [])].sort(); const k = s.join(",");
    const e = m.get(k); if (e) e.count++; else m.set(k, { set: s, count: 1 }); }
  return m;
}
const totalOf = (counts) => { let n = 0; for (const e of counts.values()) n += e.count; return n; };
const subsetCoverage = (counts, S) => { let c = 0; for (const { set, count } of counts.values()) if (set.every((x) => S.has(x))) c += count; return c; };
// Greedy order (computed on the reference dataset, e.g. `all`): repeatedly add the capability that newly
// COMPLETES the most endpoints (max marginal subset-coverage). This is the order that recovers endpoints
// fastest; ties/leftover all-zero caps are appended in IDS order.
function greedyOrder(counts, ids) {
  const S = new Set(), order = [], rem = new Set(ids), n = totalOf(counts);
  while (rem.size) { let best = null, bg = -1;
    for (const c of rem) { S.add(c); const g = subsetCoverage(counts, S); S.delete(c); if (g > bg) { bg = g; best = c; } }
    S.add(best); rem.delete(best); order.push(best);
    if (subsetCoverage(counts, S) >= n) break;
  }
  for (const c of ids) if (!order.includes(c)) order.push(c);
  return order;
}
function subsetCumulativeUnder(counts, order) {            // baseline (empty-set share) + cumulative subset-coverage
  const n = totalOf(counts) || 1, S = new Set();
  const cum = []; for (const c of order) { S.add(c); cum.push(+(subsetCoverage(counts, S) / n).toFixed(4)); }
  return { baseline: +(subsetCoverage(counts, new Set()) / n).toFixed(4), cumulative: cum };
}

async function readJsonlRows(file) {                        // stream (output jsonl is ~1 GB -> readFileSync overflows)
  const rows = []; const stream = fs.createReadStream(file, { encoding: "utf8" }); let carry = "";
  const emit = (line) => { if (line) rows.push(JSON.parse(line)); };
  for await (const chunk of stream) { const s = carry + chunk; let i = 0, nl; while ((nl = s.indexOf("\n", i)) >= 0) { emit(s.slice(i, nl)); i = nl + 1; } carry = s.slice(i); }
  if (carry) emit(carry);
  return rows;
}

// Files excluded by --slow-ms (baseline analyze over budget) are logged, one per line: "sha baseMs nTargets".
// Report their count so the paper can state exact coverage instead of silently dropping them.
function readSlow(o) {
  const f = path.join(o.out, `ablation-${o.corpus}.slow`);
  if (!fs.existsSync(f)) return { files: 0, targets: 0 };
  let files = 0, targets = 0;
  for (const l of fs.readFileSync(f, "utf8").split("\n")) { if (!l) continue; files++; targets += (+l.split(" ")[2] || 0); }
  return { files, targets };
}

async function evalOne(o) {
  const rows = await readJsonlRows(path.join(o.out, `ablation-${o.corpus}.jsonl`));
  const slow = readSlow(o);
  const ok = rows.filter((r) => r.baselineOk);
  const dsRows = Object.fromEntries(Object.entries(DATASETS).map(([k, f]) => [k, ok.filter(f)]));
  const req = Object.fromEntries(Object.keys(DATASETS).map((k) => [k, requiredOf(dsRows[k])]));
  const sharedOrder = [...IDS].sort((a, b) => req.all[b] - req.all[a]);   // one x-axis, ranked by overall contribution
  const ds = {}; for (const k of Object.keys(DATASETS)) { const c = cumulativeUnder(dsRows[k], sharedOrder);
    ds[k] = { n: dsRows[k].length, required: req[k], cumulative: c.cumulative, ceiling: c.ceiling,
      zero_caps: dsRows[k].filter((r) => !(r.necessary || []).length).length }; }

  // ---- SUBSET (recovery) coverage: greedy order on `all`, then subset-CDF per dataset under that order ----
  const setCounts = Object.fromEntries(Object.keys(DATASETS).map((k) => [k, requiredSetCounts(dsRows[k])]));
  const greedy = greedyOrder(setCounts.all, IDS);                       // shared x-axis, greedy on all outputs
  const subset = Object.fromEntries(Object.keys(DATASETS).map((k) => [k, subsetCumulativeUnder(setCounts[k], greedy)]));
  const arityAll = {}; for (const { set, count } of setCounts.all.values()) arityAll[set.length] = (arityAll[set.length] || 0) + count;

  // ---- CSV: one row per capability, required count + % per dataset ----
  const hdr = ["capability", ...Object.keys(DATASETS).flatMap((k) => [`${k}_req`, `${k}_pct`])];
  const csv = [hdr.join(",")].concat(IDS.map((c) => [c, ...Object.keys(DATASETS).flatMap((k) => [ds[k].required[c], pct(ds[k].required[c], ds[k].n)])].join(","))).join("\n") + "\n";
  fs.writeFileSync(path.join(o.out, `ablation-${o.corpus}.capabilities.csv`), csv);

  // ---- JSON (drives the CDF plot); `order` is shared, `cumulative[i]` aligns to order[i] per dataset ----
  const evalJson = { corpus: o.corpus, targets_total: rows.length, targets_reproduced: ok.length,
    excluded_slow: slow, order: sharedOrder,
    greedy_order: greedy, arity_all: arityAll,   // subset-coverage: recovery order + required-set-size histogram
    datasets: Object.fromEntries(Object.keys(DATASETS).map((k) => [k, {
      label: DS_LABEL[k], n: ds[k].n, ceiling: ds[k].ceiling, zero_caps: ds[k].zero_caps, cumulative: ds[k].cumulative,
      baseline: subset[k].baseline, subset_cumulative: subset[k].cumulative,
      capabilities: IDS.map((c) => ({ capability: c, required: ds[k].required[c], pct: +pct(ds[k].required[c], ds[k].n) })).sort((a, b) => b.required - a.required),
    }])) };
  fs.writeFileSync(path.join(o.out, `ablation-${o.corpus}.eval.json`), JSON.stringify(evalJson, null, 2));

  // ---- human summary ----
  let txt = `Ablation study — capability attribution across datasets (${o.corpus})\n` + "=".repeat(64) + "\n\n";
  txt += `${ok.length} of ${rows.length} complete outputs reproduced at baseline.\n`;
  if (slow.files) { const totF = rows.length + slow.targets; txt += `${slow.files} files (${slow.targets} targets, ${pct(slow.targets, totF)}% of targets) excluded as analysis-timeouts (baseline over --slow-ms); attributed set = remaining ${pct(rows.length, totF)}%.\n`; }
  txt += "dataset         " + "n".padStart(9) + "   ceiling (share needing >=1 cap)\n";
  for (const k of Object.keys(DATASETS)) txt += "  " + pad(DS_LABEL[k], 14) + padL(ds[k].n, 9) + `   ${(100 * ds[k].ceiling).toFixed(1)}%\n`;
  txt += "\nShare of each dataset's outputs that REQUIRE each capability (%):\n\n";
  txt += "  " + pad("capability", 16) + Object.keys(DATASETS).map((k) => padL(k, 15)).join("") + "\n";
  txt += "  " + "-".repeat(16 + 15 * Object.keys(DATASETS).length) + "\n";
  const orderByAll = [...IDS].sort((a, b) => ds.all.required[b] - ds.all.required[a]);
  for (const c of orderByAll) txt += "  " + pad(c, 16) + Object.keys(DATASETS).map((k) => padL(pct(ds[k].required[c], ds[k].n) + "%", 15)).join("") + "\n";
  // required-set SIZE distribution (all): how many capabilities each endpoint needs together
  const nAll = ds.all.n || 1;
  txt += "\nRequired-set size (all outputs) — # capabilities an endpoint needs TOGETHER:\n";
  for (const s of Object.keys(arityAll).map(Number).sort((a, b) => a - b))
    txt += `  ${s} cap(s): ` + padL(arityAll[s], 9) + `  (${pct(arityAll[s], nAll)}%)\n`;

  // SUBSET (recovery) coverage under the greedy order: an endpoint counts only once ALL its caps are enabled.
  txt += "\nGreedy recovery order (max newly-completed endpoints on all), with marginal gain:\n";
  let prev = subset.all.baseline;
  for (let i = 0; i < greedy.length; i++) { const cur = subset.all.cumulative[i]; const g = cur - prev; prev = cur;
    txt += `  ${padL(i + 1, 2)}. ${pad(greedy[i], 16)} +${(100 * g).toFixed(1).padStart(5)}pp  -> ${(100 * cur).toFixed(1)}%\n`;
    if (cur > 0.999) break; }
  txt += "\nSubset-coverage CDF per dataset (baseline -> top-k recoverable) under that order:\n";
  for (const k of Object.keys(DATASETS)) {
    txt += `  ${pad(DS_LABEL[k], 14)} ${(100 * subset[k].baseline).toFixed(0)}% -> `;
    txt += subset[k].cumulative.slice(0, 6).map((v) => `${(100 * v).toFixed(0)}%`).join(" -> ") + " ... 100%\n";
  }
  txt += "\n(For reference, UNION coverage — share needing >=1 of the top-k caps, NOT actual recovery:\n";
  for (const k of Object.keys(DATASETS)) {
    txt += `  ${pad(DS_LABEL[k], 14)} `;
    txt += ds[k].cumulative.slice(0, 6).map((v) => `${(100 * v).toFixed(0)}%`).join(" -> ") + ` ... ceiling ${(100 * ds[k].ceiling).toFixed(0)}%\n`;
  }
  txt += ")\n";
  fs.writeFileSync(path.join(o.out, `ablation-${o.corpus}.summary.txt`), txt);
  console.log("\n" + txt);
  console.log(`[*] wrote ablation-${o.corpus}.{capabilities.csv, eval.json, summary.txt} -> ${o.out}`);
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const v = String(o.corpus || "crawl").toLowerCase();
  const corpora = (v === "both" || v === "all") ? ["crawl", "sdk"] : v.split(",").map((x) => x.trim()).filter(Boolean);
  for (const corpus of corpora) await evalOne({ ...o, corpus });
}
main();
