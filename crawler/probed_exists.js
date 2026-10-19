#!/usr/bin/env node
"use strict";
// Reuse an existing url-status cache (from validate_urls.js) as a tool-agnostic STATUS ORACLE: for each
// tool's concrete "extra" (no_match) URLs, look up the HTTP status we already probed — NO new network.
// EXISTS = 2xx/3xx/401/403/405/5xx/429 (the endpoint is real); NOT = 404/410/dead.
//
//   node probed_exists.js [--cache ../results/url-status-lynx-extra.csv] [--out out]
//
// CAVEAT: the cache was built from LyN-X's extras, so a LinkFinder extra is only scored if it ALSO is a
// LyN-X extra. LinkFinder's number is therefore over the SHARED subset (its unique grep-junk wasn't probed),
// which UNDERSTATES LinkFinder's junk rate. `coverage` shows how biased each tool's number is. The unbiased
// LinkFinder number needs a `validate_urls.js --tool linkfinder --only-extra --sample N` run.

const fs = require("fs");
const path = require("path");
const { resolveUrl, classify, isPurePlaceholder } = require("./lib/match");
const { loadUrlToSha, readGt, domainsFromLog } = require("./lib/corpus");

function parseArgs(argv) {
  const o = { out: path.join(__dirname, "out"), cache: path.join(__dirname, "..", "results", "url-status-lynx-extra.csv"),
    tools: ["lynx", "linkfinder"] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out") o.out = argv[++i];
    else if (argv[i] === "--cache") o.cache = argv[++i];
    else if (argv[i] === "--tools") o.tools = argv[++i].split(",");
  }
  return o;
}

// url-status CSV row = <url>,<status>,<class>,<ms>,<note>. The url field is JSON-escaped-without-quotes and
// MAY contain commas (e.g. fonts css2?family=A,B), so peel the last 4 (comma-free) fields off the end.
function loadCache(file) {
  const cache = new Map();
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  for (const line of lines.slice(1)) {
    if (!line) continue;
    const p = line.split(",");
    if (p.length < 5) continue;
    p.pop();                                    // note (last field)
    p.pop();                                    // ms
    const cls = p.pop();                        // class  <- what we want
    p.pop();                                    // status
    let url = p.join(",");                       // everything before = url (may itself contain commas)
    try { url = JSON.parse('"' + url + '"'); } catch {}   // reverse JSON.stringify escaping
    if (url) cache.set(url, cls);
  }
  return cache;
}

const toolCache = {};
function toolUrls(out, tool, sha) {
  const k = tool + "/" + sha;
  if (k in toolCache) return toolCache[k];
  let u = [];
  const f = path.join(out, "tools", tool, sha + ".json");
  if (fs.existsSync(f)) { try { u = JSON.parse(fs.readFileSync(f, "utf8")).urls || []; } catch {} }
  return (toolCache[k] = u);
}

const isConcreteAbs = (u) => /^https?:\/\//i.test(u) && !/\{[A-Z_]+:[^}]*\}/.test(u);
const EXISTS = new Set(["2xx", "3xx", "auth", "method", "5xx", "ratelimited"]);

function main() {
  const o = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(o.cache)) { console.error(`no cache at ${o.cache} — pass --cache <url-status csv>`); process.exit(1); }
  const cache = loadCache(o.cache);
  console.error(`[cache] ${cache.size} probed URLs from ${path.basename(o.cache)}`);

  const gtDir = path.join(o.out, "ground-truth");
  const urlToSha = loadUrlToSha(path.join(o.out, "js-index.csv"));
  const domains = domainsFromLog(path.join(o.out, "crawl-log.csv"));

  // collect each tool's concrete "extra" (no_match) URLs — same rule validate_urls.js --only-extra used
  const extras = {}; for (const t of o.tools) extras[t] = new Set();
  let n = 0;
  for (const domain of domains) {
    const recs = readGt(gtDir, domain).filter((r) => r.initiatorType === "script" && r.groundTruthUrl && r.initiatorUrl);
    if (!recs.length) continue;
    const gtStripped = [...new Set(recs.map((r) => r.groundTruthUrl.split(/[?#]/)[0]))];
    const shas = new Set(); for (const r of recs) { const s = urlToSha.get(r.initiatorUrl); if (s) shas.add(s); }
    const base = "https://" + domain + "/";
    for (const t of o.tools) for (const s of shas) for (const raw of toolUrls(o.out, t, s)) {
      if (!raw || isPurePlaceholder(raw)) continue;
      const u = resolveUrl(raw, base);
      if (!isConcreteAbs(u)) continue;
      if (classify(u, gtStripped).type !== "no_match") continue;   // extras only
      extras[t].add(u.split("#")[0]);
    }
    if (++n % 5000 === 0) process.stderr.write(`\r  scanned ${n} domains`);
  }
  process.stderr.write("\n");

  const report = (label, urls) => {
    let probed = 0, exists = 0; const dist = {};
    for (const u of urls) { const c = cache.get(u); if (c === undefined) continue; probed++; dist[c] = (dist[c] || 0) + 1; if (EXISTS.has(c)) exists++; }
    const total = urls.size || (Array.isArray(urls) ? urls.length : 0);
    console.log(`\n${label}`);
    console.log(`  extras=${total.toLocaleString()}  probed=${probed.toLocaleString()} (coverage ${total ? (100 * probed / total).toFixed(1) : 0}%)  EXISTS=${probed ? (100 * exists / probed).toFixed(1) : 0}%  404=${probed ? (100 * (dist["404"] || 0) / probed).toFixed(1) : 0}%  dead=${probed ? (100 * (dist["dead"] || 0) / probed).toFixed(1) : 0}%`);
    const order = ["2xx", "3xx", "auth", "method", "5xx", "ratelimited", "404", "dead", "other"];
    console.log("    " + order.filter((c) => dist[c]).map((c) => `${c}:${(100 * dist[c] / probed).toFixed(1)}%`).join("  "));
  };

  for (const t of o.tools) report(`[${t}] extras vs probed cache`, extras[t]);

  // Cleaner, unbiased-for-lynx cut: of LyN-X's extras, split by whether LinkFinder ALSO found them.
  if (extras.lynx && extras.linkfinder) {
    const lynxOnly = new Set([...extras.lynx].filter((u) => !extras.linkfinder.has(u)));
    const shared = new Set([...extras.lynx].filter((u) => extras.linkfinder.has(u)));
    report("[LyN-X-only extras] (URLs regex did NOT find — the real question)", lynxOnly);
    report("[shared extras] (both tools found)", shared);
  }

  console.log(`\nEXISTS = 2xx/3xx/401·403/405/5xx/429 (endpoint is real). LinkFinder's number is over the`);
  console.log(`shared subset only (its unique extras weren't probed) — for the unbiased figure run:`);
  console.log(`  node validate_urls.js --tool linkfinder --only-extra --sample 20000 --timeout 5000 --concurrency 64`);
}

main();
