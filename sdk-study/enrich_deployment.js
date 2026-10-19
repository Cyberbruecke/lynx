#!/usr/bin/env node
"use strict";
// Deployment/popularity enrichment for the SDK manifest. Two signals:
//   - npm downloads (last month) — UNIVERSAL, free, no auth (api.npmjs.org). Works for server + browser SDKs.
//   - web adoption — for browser-detectable SDKs only, joined from a Wappalyzer/HTTP-Archive export by the
//     `wappalyzer` technology name in sdks.json. BuiltWith aggregate counts are behind their product; the
//     reproducible free equivalent is HTTP Archive's Technology Report (Wappalyzer-based). Pass its CSV
//     (columns incl. a technology name + an adoption/origins count) via --webcsv.
// Writes deployment.json { <sdk>: { npm, npmDownloadsMonth, wappalyzer, webAdoption } } and prints a table.
//
// Usage: node enrich_deployment.js [--webcsv httparchive_tech.csv] [--only name1,name2] [--all]
//
// By DEFAULT restricts to the 31 SDKs in the eval — the code-class SDKs (group:"code") that have ground
// truth (gt/<name>.jsonl); the 3 data-class SDKs and any code SDK without gt are excluded. Pass --all to
// enrich every SDK in the manifest instead.

const fs = require("fs");
const path = require("path");

async function npmDownloads(pkg) {
  try {
    const res = await fetch(`https://api.npmjs.org/downloads/point/last-month/${pkg}`, { headers: { "user-agent": "lynx-sdk-study" } });
    if (!res.ok) return null;
    const j = await res.json();
    return typeof j.downloads === "number" ? j.downloads : null;
  } catch { return null; }
}

// Parse a generic HTTP-Archive/Wappalyzer CSV -> Map(lowercased technology name -> adoption number). Tries
// common column names; falls back to (col0 = name, last-numeric-col = count).
function loadWebCsv(file) {
  const rows = fs.readFileSync(file, "utf8").trim().split(/\r?\n/).map((l) => l.split(","));
  const hdr = rows.shift().map((h) => h.trim().toLowerCase());
  const nameCol = hdr.findIndex((h) => /tech|app|name|client_app/.test(h));
  const numCol = hdr.findIndex((h) => /adoption|origins|sites|pages|count|urls/.test(h));
  const map = new Map();
  for (const r of rows) {
    const name = (r[nameCol >= 0 ? nameCol : 0] || "").trim().toLowerCase();
    let n = numCol >= 0 ? +String(r[numCol]).replace(/[^0-9.]/g, "") : NaN;
    if (!Number.isFinite(n)) { for (let i = r.length - 1; i >= 0; i--) { const v = +String(r[i]).replace(/[^0-9.]/g, ""); if (Number.isFinite(v)) { n = v; break; } } }
    if (name && Number.isFinite(n)) map.set(name, Math.max(n, map.get(name) || 0));
  }
  return map;
}

async function main() {
  const argv = process.argv.slice(2);
  const only = argv.includes("--only") ? new Set(argv[argv.indexOf("--only") + 1].split(",")) : null;
  const all = argv.includes("--all");
  const webcsv = argv.includes("--webcsv") ? argv[argv.indexOf("--webcsv") + 1] : null;
  const web = webcsv ? loadWebCsv(webcsv) : null;
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "sdks.json"), "utf8"));

  // The eval set (default): code-class SDKs with ground truth. --all enriches the whole manifest; --only wins.
  const gtExists = (name) => fs.existsSync(path.join(__dirname, "gt", `${name}.jsonl`));
  const inEval = (sdk) => sdk.group === "code" && gtExists(sdk.name);
  const selected = manifest.sdks.filter((sdk) => only ? only.has(sdk.name) : (all || inEval(sdk)));

  const out = {};
  for (const sdk of selected) {
    const dl = sdk.npm && sdk.npm !== "-" ? await npmDownloads(sdk.npm) : null;
    const wa = sdk.wappalyzer ? (web ? web.get(String(sdk.wappalyzer).toLowerCase()) ?? null : null) : null;
    out[sdk.name] = { npm: sdk.npm, npmDownloadsMonth: dl, wappalyzer: sdk.wappalyzer || null, webAdoption: wa };
    process.stderr.write(`  ${sdk.name.padEnd(20)} npm ${dl == null ? "n/a" : dl.toLocaleString()}\n`);
  }
  fs.writeFileSync(path.join(__dirname, "deployment.json"), JSON.stringify(out, null, 2));

  const ranked = Object.entries(out).sort((a, b) => (b[1].npmDownloadsMonth || 0) - (a[1].npmDownloadsMonth || 0));
  const scope = only ? `${ranked.length} selected` : all ? `all ${ranked.length}` : `${ranked.length} eval SDKs`;
  console.log(`\n  npm downloads/month (${scope}):`);
  for (const [name, d] of ranked)
    console.log(`    ${name.padEnd(20)} ${(d.npmDownloadsMonth == null ? "n/a" : d.npmDownloadsMonth.toLocaleString()).padStart(14)}`);

  // Summary across SDKs with a resolved npm number (n/a excluded from the stats).
  const nums = ranked.map(([, d]) => d.npmDownloadsMonth).filter((n) => typeof n === "number").sort((a, b) => a - b);
  if (nums.length) {
    const sum = nums.reduce((s, n) => s + n, 0);
    const mean = Math.round(sum / nums.length);
    const median = nums.length % 2 ? nums[(nums.length - 1) / 2] : Math.round((nums[nums.length / 2 - 1] + nums[nums.length / 2]) / 2);
    const naCount = ranked.length - nums.length;
    console.log(`    ${"".padEnd(20)} ${"".padStart(14, "-")}`);
    console.log(`    ${"AVERAGE".padEnd(20)} ${mean.toLocaleString().padStart(14)}   (n=${nums.length}${naCount ? `, ${naCount} n/a` : ""})`);
    console.log(`    ${"median".padEnd(20)} ${median.toLocaleString().padStart(14)}`);
    console.log(`    ${"total".padEnd(20)} ${sum.toLocaleString().padStart(14)}`);
  }
  console.log(`\n[*] wrote deployment.json`);
}
main().catch((e) => { console.error(e); process.exit(1); });
