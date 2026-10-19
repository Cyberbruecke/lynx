"use strict";
// Loaders for the crawl-corpus artifacts under out/: js-index.csv, ground-truth/*.jsonl, crawl-log.csv.
// Shared by compare.js (extraction axis) and codeql_run.js (sink axis) so both sample identically.
const fs = require("fs");
const path = require("path");
const { sanitize } = require("./util");

// js-index.csv (url,sha1,bytes,status) -> Map<url, sha1>. URL may be RFC-4180 quoted (can hold commas).
function loadUrlToSha(idxFile) {
  const map = new Map();
  if (!fs.existsSync(idxFile)) return map;
  for (const l of fs.readFileSync(idxFile, "utf8").split(/\r?\n/).slice(1)) {
    if (!l) continue;
    let url, rest;
    if (l[0] === '"') { const e = l.indexOf('",'); url = l.slice(1, e).replace(/""/g, '"'); rest = l.slice(e + 2); }
    else { const c = l.indexOf(","); url = l.slice(0, c); rest = l.slice(c + 1); }
    const sha = rest.split(",")[0];
    if (sha) map.set(url, sha);
  }
  return map;
}

// ground-truth/<domain>.jsonl -> parsed records
function readGt(gtDir, domain) {
  const f = path.join(gtDir, `${sanitize(domain)}.jsonl`);
  if (!fs.existsSync(f)) return [];
  const recs = [];
  for (const line of fs.readFileSync(f, "utf8").split(/\r?\n/)) { if (line) try { recs.push(JSON.parse(line)); } catch {} }
  return recs;
}

// crawl-log.csv first column -> [domain, ...]
function domainsFromLog(logFile) {
  const out = [];
  if (!fs.existsSync(logFile)) return out;
  for (const l of fs.readFileSync(logFile, "utf8").split(/\r?\n/).slice(1))
    if (l) out.push(l.split(",")[0].replace(/^"|"$/g, ""));
  return out;
}

// --- corpus presence -----------------------------------------------------------------------------
// Analysis scripts gate on "was this script part of the analyzed corpus?", which natively means
// out/js/<sha>.js exists. Artifact releases ship the per-tool outputs but not the multi-GB script
// corpus, so when out/js/ is absent we fall back to an equivalent presence test: out/tools/lynx/
// <sha>.json, which holds exactly one entry per analyzed script. Results are identical when out/js/
// is present; without the fallback every gated script silently scores zero.
let _corpusMode = null;
const _corpusCache = new Map();
function corpusHas(outDir, sha) {
  if (_corpusMode === null) {
    _corpusMode = fs.existsSync(path.join(outDir, "js")) ? "js" : "tools";
    if (_corpusMode === "tools")
      process.stderr.write("[corpus] out/js/ absent -> using out/tools/lynx/<sha>.json as the corpus-presence test\n");
  }
  if (_corpusCache.has(sha)) return _corpusCache.get(sha);
  const f = _corpusMode === "js"
    ? path.join(outDir, "js", sha + ".js")
    : path.join(outDir, "tools", "lynx", sha + ".json");
  const v = fs.existsSync(f);
  _corpusCache.set(sha, v);
  return v;
}

// For scripts that need the SCRIPT BODIES, not just presence (they re-run a tool on each file or grep
// it for literals). Fail loudly and early rather than producing empty results.
function requireJsCorpus(outDir) {
  if (fs.existsSync(path.join(outDir, "js"))) return;
  console.error(
    "This analysis needs the JS corpus itself (out/js/<sha>.js), not just the cached tool outputs.\n" +
    "Unpack it first:  zstd -d js.tar.zst -c | tar -x -C out/\n" +
    "(see README, 'Re-running the data collection' — the corpus is not part of the artifact archive)");
  process.exit(1);
}

module.exports = { loadUrlToSha, readGt, domainsFromLog, corpusHas, requireJsCorpus };
