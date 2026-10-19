#!/usr/bin/env node
"use strict";
// Phase 2 (thesis §4.2/§4.3): retrieve the JS assets referenced in the ground truth so
// LyN-X and the baselines run on identical inputs. http+https, redirects followed,
// 200-OK-only, content-hash dedup (a script on N sites is stored once).
// Resumable/union via js-index.csv.
// (Note: thesis restricted to HTTPS; we relax to http+https for fuller coverage.)

const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const zlib = require("zlib");
const dns = require("dns");
const dnsp = dns.promises;
dns.setDefaultResultOrder("ipv4first"); // prefer IPv4 (no IPv6 route on the box)

// Rotate across public resolvers instead of hammering (and trusting) the box's default DNS.
// Also isolates "bad IPs from the local resolver" from "genuine egress filtering".
const PUBLIC_DNS = [["1.1.1.1"], ["1.0.0.1"], ["8.8.8.8"], ["8.8.4.4"],
  ["9.9.9.9"], ["149.112.112.112"], ["208.67.222.222"], ["208.67.220.220"]];
const resolvers = PUBLIC_DNS.map((s) => { const r = new dns.promises.Resolver({ timeout: 5000, tries: 2 }); r.setServers(s); return r; });
let rrIdx = 0;
const { ensureDir, sha1, csvAppender, loadDoneKeys, runPool } = require("./lib/util");

// keep one bad socket from ever taking down a multi-hour run
process.on("unhandledRejection", (e) => process.stderr.write(`\n    [unhandledRejection] ${e && e.message || e}\n`));

const MAX_BYTES = 20 * 1024 * 1024;                    // per-file cap
// Look like a browser (many CDNs/WAFs 403 non-browser clients) and accept the sloppy TLS
// that Chrome tolerated during the crawl (expired/self-signed certs) — we only read JS text.
const HEADERS = {
  "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept": "*/*",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
};

function parseArgs(argv) {
  const o = { out: path.join(__dirname, "out"), concurrency: 32, timeout: 10000, limit: 0, retries: 2 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") o.out = argv[++i];
    else if (a === "--concurrency") o.concurrency = +argv[++i];
    else if (a === "--timeout") o.timeout = +argv[++i];
    else if (a === "--limit") o.limit = +argv[++i];
    else if (a === "--retries") o.retries = +argv[++i];   // transient-failure retries per URL
    else if (a === "--help" || a === "-h") o.help = true;
  }
  return o;
}

// The JS files LyN-X analyzes = loaded script assets + the executing scripts that
// initiated requests. Both are collected from the ground-truth records.
function collectJsUrls(gtDir) {
  const urls = new Set();
  for (const f of fs.readdirSync(gtDir)) {
    if (!f.endsWith(".jsonl")) continue;
    for (const line of fs.readFileSync(path.join(gtDir, f), "utf8").split(/\r?\n/)) {
      if (!line) continue;
      let r; try { r = JSON.parse(line); } catch { continue; }
      if (r.resourceType === "Script" && /^https?:\/\//.test(r.groundTruthUrl)) urls.add(r.groundTruthUrl);
      if (r.initiatorType === "script" && /^https?:\/\//.test(r.initiatorUrl)) urls.add(r.initiatorUrl);
    }
  }
  return urls;
}

// Connection-level errors -> worth trying another IP / retrying. Everything else is permanent.
const CONN_ERRS = new Set(["ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "ETIMEDOUT", "ECONNRESET", "EPIPE", "EAI_AGAIN"]);
const RETRY_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// resolve ALL IPv4 addresses (browser-like: try each, not just the first Node would pick).
// Cached per host — ~1M URLs share far fewer hosts, so per-URL resolution would hammer the
// resolver into throttling (EAI_AGAIN) and cascade failures. Negative results cached too.
const dnsCache = new Map();
async function resolveIPv4(hostname) {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) return [hostname];
  if (dnsCache.has(hostname)) return dnsCache.get(hostname);
  let ips = [];
  for (let k = 0; k < 2 && !ips.length; k++) {            // try 2 different public resolvers
    const r = resolvers[rrIdx++ % resolvers.length];
    try { ips = await r.resolve4(hostname); } catch {}
  }
  if (!ips.length) { try { ips = (await dnsp.lookup(hostname, { all: true, family: 4 })).map((x) => x.address); } catch {} }
  dnsCache.set(hostname, ips);
  return ips;
}

// one GET to a specific IP; Host header + SNI keep vhosts/TLS working; decompress by encoding
function getFromIp(u, ip, timeout) {
  return new Promise((resolve, reject) => {
    const isHttps = u.protocol === "https:";
    const opts = {
      host: ip, port: u.port || (isHttps ? 443 : 80), path: u.pathname + u.search,
      timeout, headers: { ...HEADERS, Host: u.host },
      ...(isHttps ? { servername: u.hostname, rejectUnauthorized: false } : {}),
    };
    const req = (isHttps ? https : http).get(opts, (res) => {
      const code = res.statusCode || 0;
      if (code >= 300 && code < 400 && res.headers.location) { res.resume(); return resolve({ status: code, location: res.headers.location }); }
      if (code !== 200) { res.resume(); return resolve({ status: code, buf: null }); }
      const enc = (res.headers["content-encoding"] || "").toLowerCase();
      let stream = res;
      if (enc === "gzip") stream = res.pipe(zlib.createGunzip());
      else if (enc === "deflate") stream = res.pipe(zlib.createInflate());
      else if (enc === "br") stream = res.pipe(zlib.createBrotliDecompress());
      const chunks = []; let size = 0;
      stream.on("data", (c) => { size += c.length; if (size > MAX_BYTES) { req.destroy(); return reject(new Error("too_large")); } chunks.push(c); });
      stream.on("end", () => resolve({ status: 200, buf: Buffer.concat(chunks) }));
      stream.on("error", reject);
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
  });
}

// forced-IPv4, all-addresses, redirect-following GET
async function httpGet(rawUrl, timeout, redirectsLeft = 5) {
  const u = new URL(rawUrl);                              // throws -> caught by fetchOne
  const ips = await resolveIPv4(u.hostname);
  if (!ips.length) throw Object.assign(new Error("dns"), { code: "ENOTFOUND" });
  let lastErr;
  for (const ip of ips) {                                // browser-like: try every IPv4
    try {
      const r = await getFromIp(u, ip, timeout);
      if (r.status >= 300 && r.status < 400 && r.location) {
        if (redirectsLeft <= 0) throw new Error("too_many_redirects");
        return await httpGet(new URL(r.location, u).href, timeout, redirectsLeft - 1);
      }
      return { status: r.status, buf: r.buf };
    } catch (e) {
      lastErr = e;
      const code = (e && e.code) || (e && e.message === "timeout" ? "ETIMEDOUT" : "");
      if (!CONN_ERRS.has(code)) throw e;                 // only fall through to next IP on connection errors
    }
  }
  throw lastErr || Object.assign(new Error("unreachable"), { code: "EHOSTUNREACH" });
}

async function fetchOne(url, opts, jsDir) {
  let last = "error";
  for (let attempt = 0; attempt <= opts.retries; attempt++) {
    try {
      const { status, buf } = await httpGet(url, opts.timeout);
      if (status === 200 && buf) {
        const h = sha1(buf);
        const dst = path.join(jsDir, `${h}.js`);
        if (!fs.existsSync(dst)) fs.writeFileSync(dst, buf);
        return [url, h, buf.length, 200];
      }
      if (!RETRY_STATUS.has(status)) return [url, "", "", status || "error"];   // 404/403/… are permanent
      last = status;
    } catch (e) {
      last = (e && (e.code || e.message)) || "error";
      if (!CONN_ERRS.has(last) && last !== "timeout") return [url, "", "", last]; // non-transient -> stop
    }
    if (attempt < opts.retries) await sleep(400 * (attempt + 1));               // backoff before retry
  }
  return [url, "", "", last];
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { console.log("Usage: node download.js [--out DIR] [--concurrency N] [--timeout MS] [--limit N]"); return; }
  const gtDir = path.join(opts.out, "ground-truth");
  const jsDir = path.join(opts.out, "js");
  const idxFile = path.join(opts.out, "js-index.csv");
  if (!fs.existsSync(gtDir)) { console.error(`no ground truth at ${gtDir} — run crawl.js first`); process.exit(1); }
  ensureDir(jsDir);

  const all = collectJsUrls(gtDir);
  const done = loadDoneKeys(idxFile);
  let todo = [...all].filter((u) => !done.has(u));
  if (opts.limit) todo = todo.slice(0, opts.limit);
  console.log(`[*] ${all.size} unique JS URLs | ${done.size} already fetched | ${todo.length} to download`);
  if (!todo.length) return;

  const idx = csvAppender(idxFile, ["url", "sha1", "bytes", "status"]);
  let n = 0, ok = 0;
  await runPool(todo, async (url) => {
    const row = await fetchOne(url, opts, jsDir);
    idx.row(row);
    if (row[3] === 200) ok++;
    if (++n % 50 === 0 || n === todo.length) process.stderr.write(`\r    downloaded ${n}/${todo.length} (${ok} ok)`);
  }, { concurrency: opts.concurrency });
  process.stderr.write("\n");
  idx.close();
  const stored = fs.readdirSync(jsDir).filter((f) => f.endsWith(".js")).length;
  console.log(`[*] ${ok}/${todo.length} fetched 200 OK | ${stored} unique JS files (content-hash deduped) -> ${jsDir}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
