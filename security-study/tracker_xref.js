#!/usr/bin/env node
"use strict";
// E9a — tracker/blocklist cross-reference. Runs all tools over the crawl JS sample, collects the crawl's
// dynamic ground-truth URLs, then invokes security_match.py (trackers mode): per tool, how many tracker
// eTLD+1s it surfaces, and — the headline — how many the DYNAMIC crawl never fired (static-discovery
// payoff). Attributed by owner/category from all_trackers.csv.
//
// Usage: node tracker_xref.js [--out ../crawler/out] [--limit N] [--tools t1,t2] [--lynx PATH] [--results DIR]

const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawnSync } = require("child_process");
const { adapters, toolAvailable, BASE_TOOLS } = require("../crawler/lib/tools");
const { runPool } = require("../crawler/lib/util");
const { loadUrlToSha, readGt, domainsFromLog } = require("../crawler/lib/corpus");

function parseArgs(argv) {
  const base = __dirname;
  const o = {
    out: path.join(base, "..", "crawler", "out"),
    trackers: path.join(base, "tracker-lists", "normalized", "all_trackers_etld1.txt"),
    attrib: path.join(base, "tracker-lists", "normalized", "all_trackers.csv"),
    tools: [...BASE_TOOLS],
    lynx: path.join(base, "..", "lynx", "lyn-x.js"),
    results: path.join(base, "..", "results"),
    limit: 0, timeout: 45000, concurrency: Math.max(2, os.cpus().length), match: true, cache: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") o.out = argv[++i];
    else if (a === "--trackers") o.trackers = argv[++i];
    else if (a === "--attrib") o.attrib = argv[++i];
    else if (a === "--tools") o.tools = argv[++i].split(",");
    else if (a === "--lynx") o.lynx = argv[++i];
    else if (a === "--results") o.results = argv[++i];
    else if (a === "--limit") o.limit = +argv[++i];
    else if (a === "--timeout") o.timeout = +argv[++i];
    else if (a === "--concurrency") o.concurrency = +argv[++i];
    else if (a === "--no-match") o.match = false;
    else if (a === "--no-cache") o.cache = false;   // ignore compare.js's out/tools/<tool>/<sha>.json cache, re-run adapters
    else if (a === "--help" || a === "-h") o.help = true;
  }
  return o;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) { console.log("Usage: node tracker_xref.js [--out DIR] [--limit N] [--tools t1,t2] [--lynx PATH]"); return; }
  const gtDir = path.join(o.out, "ground-truth"), jsDir = path.join(o.out, "js");
  if (!fs.existsSync(gtDir) || !fs.existsSync(jsDir)) { console.error("run crawl.js + download.js first"); process.exit(1); }

  // same script-initiator sample as compare.js; dynamic = EVERY request the crawl fired (parser + script)
  const urlToSha = loadUrlToSha(path.join(o.out, "js-index.csv"));
  let domains = domainsFromLog(path.join(o.out, "crawl-log.csv"));
  if (o.limit) domains = domains.slice(0, o.limit);
  const shas = new Set(), dynamic = new Set();
  for (const d of domains) for (const r of readGt(gtDir, d)) {
    if (r.groundTruthUrl) dynamic.add(r.groundTruthUrl);
    if (r.initiatorType === "script" && r.initiatorUrl) { const s = urlToSha.get(r.initiatorUrl); if (s) shas.add(s); }
  }
  const files = [...shas].map((s) => `${s}.js`).filter((f) => fs.existsSync(path.join(jsDir, f)));
  console.log(`[*] ${files.length} JS files, ${dynamic.size} dynamic ground-truth URLs`);
  if (!files.length) { console.error("[!] no files — populate out/js (beautify_corpus.js) first"); process.exit(1); }

  // Reuse compare.js's per-sha URL cache (out/tools/<tool>/<sha>.json = {urls,...}) so we don't re-run
  // every tool over the whole corpus. A tool is usable if its cache is populated OR its binary is present.
  const cacheDir = (t) => path.join(o.out, "tools", t);
  const hasCache = (t) => { try { return fs.readdirSync(cacheDir(t)).some((f) => f.endsWith(".json")); } catch { return false; } };
  const tools = [];
  for (const t of o.tools) {
    if (o.cache && hasCache(t)) tools.push(t);
    else if (await toolAvailable(t, o)) tools.push(t);
    else console.error(`[!] ${t} unavailable (no cache, no binary) — skipping`);
  }
  if (!tools.length) { console.error("[!] no tools available"); process.exit(1); }

  const out = { tools: {}, dynamic: [...dynamic] };
  for (const t of tools) {
    const set = new Set(); let n = 0, hits = 0;
    await runPool(files, async (f) => {
      let urls = null;
      if (o.cache) {   // cache hit -> skip the adapter entirely
        try { urls = JSON.parse(fs.readFileSync(path.join(cacheDir(t), f.replace(/\.js$/, ".json")), "utf8")).urls || []; hits++; }
        catch { urls = null; }
      }
      if (urls === null) { try { urls = await adapters[t](path.join(jsDir, f), o); } catch { urls = []; } }
      for (const u of urls) set.add(u);
      if (++n % 100 === 0 || n === files.length) process.stderr.write(`\r    ${t}: ${n}/${files.length} (${hits} cached)`);
    }, { concurrency: o.concurrency });
    process.stderr.write("\n");
    out.tools[t] = [...set];
  }

  fs.mkdirSync(o.results, { recursive: true });
  const urlsJson = path.join(o.results, "tracker-urls.json");
  fs.writeFileSync(urlsJson, JSON.stringify(out));
  console.log(`[*] wrote ${urlsJson}`);
  if (o.match) {
    const py = spawnSync(process.env.PYTHON || "python3", [path.join(__dirname, "security_match.py"), "--mode", "trackers", "--urls", urlsJson,
      "--trackers", o.trackers, "--attrib", o.attrib, "--results", o.results], { stdio: "inherit" });
    process.exit(py.status == null ? 1 : py.status);
  }
  console.log(`[*] next: python3 security_match.py --mode trackers --urls ${urlsJson} --trackers ${o.trackers} --attrib ${o.attrib} --results ${o.results}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
