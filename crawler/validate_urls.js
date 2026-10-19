#!/usr/bin/env node
"use strict";
// DG/ADG validation: static analysis surfaces concrete URLs the single dynamic crawl never triggered
// (conditional branches, error paths, feature-flagged endpoints). This harness fetches those concrete URLs
// and records the HTTP status, so "extra" (no-match) URLs can be characterized as REAL (200/301/401/403/405/
// 5xx = the endpoint exists) vs NOT (404/410/DNS-fail). A regex tool's extras are blind grabs; a data-flow
// tool's extras are reconstructed endpoints — the status distribution is the evidence.
//
//   node validate_urls.js --tool lynx --only-extra --sample 5000 --concurrency 32
//
// Resumable: already-checked URLs are read back from the output CSV and skipped. Polite: HEAD-first
// (GET fallback on 405/501), per-host concurrency cap, timeout, redirects NOT followed (the first status is
// what we want). http/https only.

const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");
const https = require("https");
const { resolveUrl, classify, isPurePlaceholder } = require("./lib/match");
const { ensureDir, runPool } = require("./lib/util");
const { loadUrlToSha, readGt, domainsFromLog } = require("./lib/corpus");

function parseArgs(argv) {
  const o = { out: path.join(__dirname, "out"), results: path.join(__dirname, "..", "results"),
    tool: "lynx", onlyExtra: false, sample: 0, limit: 0, concurrency: Math.max(8, os.cpus().length * 2),
    timeout: 10000, perHost: 4, ua: "Mozilla/5.0 (compatible; LyNX-endpoint-validator/1.0)" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") o.out = argv[++i];
    else if (a === "--results") o.results = argv[++i];
    else if (a === "--tool") o.tool = argv[++i];
    else if (a === "--only-extra") o.onlyExtra = true;         // only URLs that did NOT match this domain's GT (the DG set)
    else if (a === "--sample") o.sample = +argv[++i];          // cap total distinct URLs fetched (0 = all)
    else if (a === "--limit") o.limit = +argv[++i];            // cap domains scanned when collecting URLs
    else if (a === "--concurrency") o.concurrency = +argv[++i];
    else if (a === "--timeout") o.timeout = +argv[++i];
    else if (a === "--per-host") o.perHost = +argv[++i];
    else if (a === "--help" || a === "-h") o.help = true;
  }
  return o;
}

const toolCache = {};
function toolUrlsForSha(out, tool, sha) {
  const key = tool + "/" + sha;
  if (toolCache[key]) return toolCache[key];
  let urls = [];
  const f = path.join(out, "tools", tool, `${sha}.json`);
  if (fs.existsSync(f)) { try { urls = JSON.parse(fs.readFileSync(f, "utf8")).urls || []; } catch {} }
  return (toolCache[key] = urls);
}

const isConcreteAbs = (u) => /^https?:\/\//i.test(u) && !/\{[A-Z_]+:[^}]*\}/.test(u);

// classify one probe: what does an HTTP status say about the endpoint EXISTING?
function statusClass(code) {
  if (code == null) return "dead";                              // DNS/conn/timeout — no server answer
  if (code >= 200 && code < 300) return "2xx";                  // exists, served
  if (code >= 300 && code < 400) return "3xx";                  // exists, redirects
  if (code === 401 || code === 403) return "auth";              // exists, protected (still a real endpoint)
  if (code === 405 || code === 501) return "method";            // exists, method not allowed
  if (code === 404 || code === 410) return "404";               // gone / not found
  if (code === 429) return "ratelimited";
  if (code >= 500) return "5xx";                                // exists, server error
  return "other";
}
const EXISTS = new Set(["2xx", "3xx", "auth", "method", "5xx", "ratelimited"]);  // evidence the endpoint is real

function probe(url, opts, method) {
  return new Promise((resolve) => {
    let u; try { u = new URL(url); } catch { return resolve({ code: null, note: "badurl" }); }
    if (u.protocol !== "http:" && u.protocol !== "https:") return resolve({ code: null, note: "scheme" });
    const lib = u.protocol === "https:" ? https : http;
    const t0 = Date.now();
    const req = lib.request(u, { method, timeout: opts.timeout, headers: { "User-Agent": opts.ua, "Accept": "*/*" } },
      (res) => { res.destroy(); resolve({ code: res.statusCode, ms: Date.now() - t0 }); });
    req.on("timeout", () => { req.destroy(); resolve({ code: null, note: "timeout", ms: Date.now() - t0 }); });
    req.on("error", (e) => resolve({ code: null, note: (e && e.code) || "error", ms: Date.now() - t0 }));
    req.end();
  });
}

async function checkUrl(url, opts) {
  let r = await probe(url, opts, "HEAD");
  if (r.code === 405 || r.code === 501 || r.note === "error") r = await probe(url, opts, "GET");  // some hosts reject HEAD
  return r;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { console.log("Usage: node validate_urls.js [--tool lynx] [--only-extra] [--sample N] [--limit DOMAINS] [--concurrency N] [--timeout MS] [--per-host N]"); return; }
  const gtDir = path.join(opts.out, "ground-truth");
  const urlToSha = loadUrlToSha(path.join(opts.out, "js-index.csv"));
  let domains = domainsFromLog(path.join(opts.out, "crawl-log.csv"));
  if (opts.limit) domains = domains.slice(0, opts.limit);

  // Collect distinct concrete absolute http(s) URLs the tool emits. With --only-extra, keep only those that
  // did NOT match this domain's GT (i.e. the extra/DG set — candidate discoveries the crawl didn't trigger).
  process.stderr.write(`[collect] tool=${opts.tool} onlyExtra=${opts.onlyExtra} over ${domains.length} domains ...\n`);
  const urls = new Set();
  let n = 0;
  for (const domain of domains) {
    const recs = readGt(gtDir, domain).filter((r) => r.initiatorType === "script" && r.groundTruthUrl && r.initiatorUrl);
    if (!recs.length) continue;
    const gtStripped = [...new Set(recs.map((r) => r.groundTruthUrl.split(/[?#]/)[0]))];
    const shas = new Set();
    for (const r of recs) { const s = urlToSha.get(r.initiatorUrl); if (s) shas.add(s); }
    const base = "https://" + domain + "/";
    for (const s of shas) for (const raw of toolUrlsForSha(opts.out, opts.tool, s)) {
      if (!raw || isPurePlaceholder(raw)) continue;
      const u = resolveUrl(raw, base);
      if (!isConcreteAbs(u)) continue;
      if (opts.onlyExtra && classify(u, gtStripped).type !== "no_match") continue;  // matched GT -> not "extra"
      urls.add(u.split("#")[0]);
    }
    if (++n % 2000 === 0) process.stderr.write(`\r  scanned ${n} domains, ${urls.size} distinct urls`);
  }
  process.stderr.write(`\n[collect] ${urls.size} distinct concrete URLs\n`);

  ensureDir(opts.results);
  const outCsv = path.join(opts.results, `url-status-${opts.tool}${opts.onlyExtra ? "-extra" : ""}.csv`);
  const done = new Map();                                       // url -> class (resume)
  if (fs.existsSync(outCsv)) {
    for (const line of fs.readFileSync(outCsv, "utf8").split(/\r?\n/).slice(1)) {
      const c = line.indexOf(","); if (c < 0) continue;
      done.set(line.slice(0, c), line.split(",")[2] || "");
    }
    process.stderr.write(`[resume] ${done.size} already checked in ${path.basename(outCsv)}\n`);
  } else fs.writeFileSync(outCsv, "url,status,class,ms,note\n");

  let todo = [...urls].filter((u) => !done.has(u));
  if (opts.sample && todo.length > opts.sample) {               // deterministic sample: evenly strided
    const step = Math.ceil(todo.length / opts.sample);
    todo = todo.filter((_, i) => i % step === 0).slice(0, opts.sample);
  }
  process.stderr.write(`[fetch] ${todo.length} to probe (concurrency ${opts.concurrency}, per-host ${opts.perHost}) ...\n`);

  const inflight = new Map();                                   // host -> count (soft per-host cap)
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const fd = fs.openSync(outCsv, "a");
  let k = 0;
  await runPool(todo, async (url) => {
    let host = ""; try { host = new URL(url).host; } catch {}
    while ((inflight.get(host) || 0) >= opts.perHost) await wait(25);   // throttle per host
    inflight.set(host, (inflight.get(host) || 0) + 1);
    let r;
    try { r = await checkUrl(url, opts); } catch { r = { code: null, note: "exc" }; }
    finally { inflight.set(host, (inflight.get(host) || 0) - 1); }
    const cls = statusClass(r.code);
    fs.writeSync(fd, `${JSON.stringify(url).slice(1, -1)},${r.code == null ? "" : r.code},${cls},${r.ms || ""},${r.note || ""}\n`);
    done.set(url, cls);
    if (++k % 200 === 0) process.stderr.write(`\r  probed ${k}/${todo.length}`);
  }, { concurrency: opts.concurrency });
  fs.closeSync(fd);
  process.stderr.write(`\n`);

  // summary over everything checked so far (resumed + new)
  const dist = {}; let total = 0, exists = 0;
  for (const cls of done.values()) { dist[cls] = (dist[cls] || 0) + 1; total++; if (EXISTS.has(cls)) exists++; }
  const pct = (x) => `${((100 * x) / Math.max(1, total)).toFixed(1)}%`;
  console.log(`\n[${opts.tool}${opts.onlyExtra ? " extra" : ""}] ${total} concrete URLs probed`);
  for (const c of ["2xx", "3xx", "auth", "method", "5xx", "ratelimited", "404", "dead", "other"])
    if (dist[c]) console.log(`  ${c.padEnd(12)} ${String(dist[c]).padStart(8)}  ${pct(dist[c])}`);
  console.log(`  ${"EXISTS".padEnd(12)} ${String(exists).padStart(8)}  ${pct(exists)}  (2xx/3xx/auth/method/5xx/429 = endpoint is real)`);
  console.log(`[*] per-URL detail: ${outCsv}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
