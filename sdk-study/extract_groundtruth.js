#!/usr/bin/env node
"use strict";
// P2 — spec -> ground-truth endpoint templates. For each SDK in sdks.json, load its downloaded spec
// (out/sdk/<name>/spec.{json,yaml,yml}), extract endpoint templates via lib/openapi.js, and write
// gt/<name>.jsonl (one {method,path,url} per line). Handles JSON and YAML (js-yaml from crawler/).
//
// Usage: node extract_groundtruth.js [--only name1,name2]

const fs = require("fs");
const path = require("path");
const { endpoints, endpointsMerged } = require("./lib/openapi");

let yaml = null;
try { yaml = require(path.join(__dirname, "..", "crawler", "node_modules", "js-yaml")); } catch {}

function loadSpec(file) {
  const raw = fs.readFileSync(file, "utf8");
  if (/\.ya?ml$/i.test(file)) {
    if (!yaml) throw new Error("YAML spec but js-yaml not found (npm i js-yaml in crawler/)");
    return yaml.load(raw);
  }
  return JSON.parse(raw);
}

// A single spec file, or every file under spec-parts/ (an SDK whose API is split across multiple specs).
function findSpecs(dir) {
  const single = ["spec.json", "spec.yaml", "spec.yml"].map((n) => path.join(dir, n)).find((p) => fs.existsSync(p));
  if (single) return [single];
  const partsDir = path.join(dir, "spec-parts");
  if (fs.existsSync(partsDir)) {
    return fs.readdirSync(partsDir).filter((f) => /\.(json|ya?ml)$/i.test(f)).map((f) => path.join(partsDir, f));
  }
  return [];
}

function main() {
  const argv = process.argv.slice(2);
  const onlyIdx = argv.indexOf("--only");
  const only = onlyIdx >= 0 ? new Set(argv[onlyIdx + 1].split(",")) : null;
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "sdks.json"), "utf8"));
  const gtDir = path.join(__dirname, "gt");
  fs.mkdirSync(gtDir, { recursive: true });

  let ok = 0, skipped = 0;
  for (const sdk of manifest.sdks) {
    if (only && !only.has(sdk.name)) continue;
    if (sdk.exclude) { skipped++; continue; }   // no publicly-fetchable spec (see sdks.json exclude note)
    const dir = path.join(__dirname, "out", "sdk", sdk.name);
    const specFiles = findSpecs(dir);
    if (!specFiles.length) { console.error(`[skip] ${sdk.name}: no spec in ${dir} (run fetch_sdks.js first)`); skipped++; continue; }
    let eps;
    try {
      const docs = specFiles.map(loadSpec);
      eps = endpointsMerged(docs, { format: sdk.specFormat, base: sdk.base });
    } catch (e) { console.error(`[skip] ${sdk.name}: ${e.message}`); skipped++; continue; }
    if (!eps.length) { console.error(`[warn] ${sdk.name}: 0 endpoints extracted (check specFormat/spec)`); }
    const out = path.join(gtDir, `${sdk.name}.jsonl`);
    fs.writeFileSync(out, eps.map((e) => JSON.stringify({ ...e, sdk: sdk.name, style: sdk.style })).join("\n") + (eps.length ? "\n" : ""));
    console.log(`[*] ${sdk.name.padEnd(18)} ${String(eps.length).padStart(5)} endpoints -> gt/${sdk.name}.jsonl`);
    ok++;
  }
  console.log(`\n[*] ${ok} spec(s) processed, ${skipped} skipped`);
}
main();
