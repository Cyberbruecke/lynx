#!/usr/bin/env node
"use strict";
// Dynamic ground-truth crawler for LyN-X (thesis §4.3).
// Captures CDP Network.requestWillBeSent initiator chains per domain:
//   - script-initiated (fetch/XHR/import/dynamic <script>): top callFrame {url,fn,line,col}
//   - parser/preload-initiated JS asset inclusions (resourceType Script)
// Passive observation to networkidle0, no UI interaction. Resumable + parallel.

const path = require("path");
const puppeteer = require("puppeteer");
const { ensureDir, sanitize, readDomains, writeJsonl, csvAppender, loadDoneKeys, runPool } = require("./lib/util");

const LAUNCH = {
  headless: true,
  args: [
    "--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu",
    // restore IPv4 fallback on hosts with AAAA records but no working IPv6 route
    // (harmless no-op where IPv6 works). Override via additional --chrome-arg if needed.
    "--disable-features=HappyEyeballsV3",
  ],
};

function parseArgs(argv) {
  const o = { lists: [], concurrency: 8, browsers: 1, out: path.join(__dirname, "out"), navTimeout: 10000, limit: 0,
    executable: process.env.PUPPETEER_EXECUTABLE_PATH || "", retries: 1, retryTimeout: 20000, chromeArgs: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--concurrency") o.concurrency = +argv[++i];
    else if (a === "--browsers") o.browsers = +argv[++i];
    else if (a === "--out") o.out = argv[++i];
    else if (a === "--nav-timeout") o.navTimeout = +argv[++i];
    else if (a === "--retries") o.retries = +argv[++i];        // retry attempts for failures (default 1)
    else if (a === "--retry-timeout") o.retryTimeout = +argv[++i]; // longer nav timeout on retry
    else if (a === "--limit") o.limit = +argv[++i];
    else if (a === "--executable") o.executable = argv[++i];  // path to a system Chrome/Chromium
    else if (a === "--chrome-arg") o.chromeArgs.push(argv[++i]); // extra Chrome flag (repeatable)
    else if (a.startsWith("--chrome-arg=")) o.chromeArgs.push(a.slice(13)); // also accept =form
    else if (a === "--help" || a === "-h") o.help = true;
    else o.lists.push(a);
  }
  return o;
}

// Map one CDP requestWillBeSent event to a ground-truth record (or null to drop).
function buildRecord(p) {
  const it = p.initiator || {};
  const gt = p.request && p.request.url;
  const rt = p.type; // CDP resource type: Script, XHR, Fetch, Image, Document, ...
  if (!gt || !/^https?:\/\//.test(gt)) return null;

  if (it.type === "script") {
    const cf = it.stack && it.stack.callFrames && it.stack.callFrames[0];
    return {
      groundTruthUrl: gt, resourceType: rt, initiatorType: "script",
      initiatorUrl: cf ? cf.url : "", functionName: cf ? cf.functionName : "",
      line: cf ? cf.lineNumber : null, column: cf ? cf.columnNumber : null,
    };
  }
  if ((it.type === "parser" || it.type === "preload") && rt === "Script") {
    return {
      groundTruthUrl: gt, resourceType: rt, initiatorType: it.type,
      initiatorUrl: it.url || p.documentURL || "", functionName: "", line: null, column: null,
    };
  }
  return null; // 'other'/'signedExchange'/top document etc. — not attributable, per thesis' two-category model
}

async function crawlDomain(domain, browser, navTimeout, userAgent) {
  const createCtx = browser.createBrowserContext
    ? browser.createBrowserContext.bind(browser)          // puppeteer >= 22
    : browser.createIncognitoBrowserContext.bind(browser); // older
  const context = await createCtx();
  const records = [], seen = new Set();
  try {
    const page = await context.newPage();
    if (userAgent) await page.setUserAgent(userAgent);    // avoid the "HeadlessChrome" token
    await page.setViewport({ width: 1366, height: 768 });
    const cdp = await page.createCDPSession();
    await cdp.send("Network.enable");
    cdp.on("Network.requestWillBeSent", (p) => {
      const rec = buildRecord(p);
      if (!rec) return;
      const key = rec.initiatorType + "|" + rec.initiatorUrl + "|" + rec.groundTruthUrl;
      if (!seen.has(key)) { seen.add(key); records.push(rec); }
    });
    const url = /^https?:\/\//.test(domain) ? domain : "https://" + domain;
    let status = "ok", error = "";
    try {
      await page.goto(url, { waitUntil: "networkidle0", timeout: navTimeout });
    } catch (e) {
      // a nav timeout still yields the requests captured during partial load — keep them
      const msg = (e && e.message) ? e.message.split("\n")[0] : String(e);
      status = /timeout/i.test(msg) ? "timeout" : "nav-error";
      error = msg;                                          // record the reason (was dropped before)
    }
    return { status, records, error };
  } catch (e) {
    return { status: "error", records, error: ((e && e.message) || String(e)).split("\n")[0] };
  } finally {
    try { await context.close(); } catch (_) {}
  }
}

// retry hard failures and empty timeouts; a timeout that captured records is left as-is
const shouldRetry = (r) =>
  r.status === "nav-error" || r.status === "error" || (r.status === "timeout" && r.records.length === 0);

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || !opts.lists.length) {
    console.log("Usage: node crawl.js <domain-list...> [--concurrency N] [--browsers M] [--out DIR]\n" +
      "         [--nav-timeout MS] [--retries N] [--retry-timeout MS] [--executable PATH] [--limit N]");
    process.exit(opts.help ? 0 : 1);
  }
  const domains = readDomains(opts.lists);
  const gtDir = path.join(opts.out, "ground-truth");
  const logFile = path.join(opts.out, "crawl-log.csv");
  ensureDir(gtDir);
  const done = loadDoneKeys(logFile);
  let todo = domains.filter((d) => !done.has(d));
  if (opts.limit) todo = todo.slice(0, opts.limit);
  console.log(`[*] ${domains.length} domains | ${done.size} already done | ${todo.length} to crawl`);
  console.log(`[*] ${opts.browsers} browser(s) x ${opts.concurrency} pages = ${opts.browsers * opts.concurrency} workers`);
  console.log(`[*] nav-timeout ${opts.navTimeout}ms, ${opts.retries} retry(s) @ ${opts.retryTimeout}ms on failure`);
  if (!todo.length) return;

  // launch options; --executable / PUPPETEER_EXECUTABLE_PATH points at a system Chrome
  // (useful when the bundled download is blocked/quarantined by endpoint security)
  const launchOpts = {
    ...LAUNCH,
    args: [...LAUNCH.args, ...opts.chromeArgs],
    ...(opts.executable ? { executablePath: opts.executable } : {}),
  };
  if (opts.executable) console.log(`[*] using Chrome at ${opts.executable}`);
  if (opts.chromeArgs.length) console.log(`[*] extra Chrome args: ${opts.chromeArgs.join(" ")}`);

  // launch browsers; workers are bound to a browser index and relaunch it if it dies
  const browsers = [];
  for (let i = 0; i < opts.browsers; i++) browsers.push(await puppeteer.launch(launchOpts));
  // real desktop UA (strip the "Headless" token that some sites block), version-accurate
  let userAgent = "";
  try { userAgent = (await browsers[0].userAgent()).replace(/Headless/g, ""); } catch (_) {}
  if (userAgent) console.log(`[*] UA: ${userAgent}`);
  const launching = {};
  const isAlive = (b) => b && (typeof b.isConnected === "function" ? b.isConnected() : b.connected !== false);
  async function ensureBrowser(bi) {
    if (isAlive(browsers[bi])) return browsers[bi];
    if (!launching[bi]) {
      launching[bi] = puppeteer.launch(launchOpts).then((nb) => { browsers[bi] = nb; delete launching[bi]; return nb; });
    }
    return launching[bi];
  }
  const slots = Array.from({ length: opts.browsers * opts.concurrency }, (_, k) => k % opts.browsers);

  const log = csvAppender(logFile, ["domain", "status", "n_records", "n_scripts", "error"]);
  let processed = 0;
  await runPool(todo, async (domain, _idx, bi) => {
    let res = await crawlDomain(domain, await ensureBrowser(bi), opts.navTimeout, userAgent);
    // retry hard failures / empty timeouts with a longer nav timeout
    for (let r = 0; r < opts.retries && shouldRetry(res); r++) {
      const retry = await crawlDomain(domain, await ensureBrowser(bi), opts.retryTimeout, userAgent);
      if (retry.records.length || !shouldRetry(retry)) { res = retry; break; }
      res = retry; // keep the latest error even if still failing
    }
    writeJsonl(path.join(gtDir, `${sanitize(domain)}.jsonl`), res.records);
    const nScripts = new Set(res.records.filter((r) => r.resourceType === "Script").map((r) => r.groundTruthUrl)).size;
    log.row([domain, res.status, res.records.length, nScripts, res.error]);
    if (++processed % 25 === 0 || processed === todo.length) {
      process.stderr.write(`\r    crawled ${processed}/${todo.length}`);
    }
  }, { slots });
  process.stderr.write("\n");

  log.close();
  for (const b of browsers) { try { await b.close(); } catch (_) {} }
  console.log(`[*] done. ground truth -> ${gtDir}  (re-run to resume/accumulate)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
