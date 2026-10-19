#!/usr/bin/env node
"use strict";
// Head-to-head baseline harness: run grep / LinkFinder / jsluice / LyN-X over the same
// out/js corpus, normalize each to a URL set, and score every tool identically against
// the dynamic ground truth (thesis §4.5). CodeQL is scored separately (sink level) via
// codeql/sinks.ql — it emits sinks, not URL sets, so it isn't in this intersection.
//
//   Phase A  run each tool over out/js/*.js -> out/tools/<tool>/<sha>.json  (cached)
//   Phase B  per domain: union the tool's URLs for that domain's JS, classify vs GT
//   Output   out/compare-scores.csv + console table (per tool: strict/relaxed P/R/F1 + DG/ADG)

const fs = require("fs");
const path = require("path");
const os = require("os");
const { isPurePlaceholder, resolveUrl, scoreDomain, blankAgg, addInto, metricsRow, METRIC_COLS } = require("./lib/match");
const { ensureDir, csvAppender, runPool } = require("./lib/util");
const { loadUrlToSha, readGt, domainsFromLog } = require("./lib/corpus");
const { disp, texEsc } = require("./lib/report");

function parseArgs(argv) {
  const o = { out: path.join(__dirname, "out"), results: path.join(__dirname, "..", "results"),
    lynx: path.join(__dirname, "..", "lynx", "lyn-x.js"),
    tools: [...BASE_TOOLS], timeout: 45000,   // real minified bundles need headroom; grep dropped (LinkFinder is the regex baseline)
    concurrency: Math.max(2, os.cpus().length), limit: 0, lists: [], rerun: false, arity: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") o.out = argv[++i];                    // corpus + per-sha tool cache
    else if (a === "--results") o.results = argv[++i];       // paper deliverables (csv/tex/txt/figures)
    else if (a === "--lynx") o.lynx = argv[++i];
    else if (a === "--tools") o.tools = argv[++i].split(",");
    else if (a === "--timeout") o.timeout = +argv[++i];
    else if (a === "--concurrency") o.concurrency = +argv[++i];
    else if (a === "--limit") o.limit = +argv[++i];
    else if (a === "--rerun") o.rerun = true;
    else if (a === "--no-arity") o.arity = false;            // skip the folded-in construction-arity histogram
    else if (a === "--lists") { while (argv[i + 1] && !argv[i + 1].startsWith("--")) o.lists.push(argv[++i]); }
    else if (a === "--help" || a === "-h") o.help = true;
  }
  return o;
}

const { adapters, toolAvailable, BASE_TOOLS } = require("./lib/tools");   // shared with bench.js (+ relwarc)


async function phaseA(tool, opts, jsDir, files) {        // run tool over the given JS files, cache per sha
  const toolDir = path.join(opts.out, "tools", tool); ensureDir(toolDir);
  const todo = files.filter((f) => opts.rerun || !fs.existsSync(path.join(toolDir, f.replace(/\.js$/, ".json"))));
  process.stderr.write(`[A:${tool}] ${files.length} files | ${files.length - todo.length} cached | ${todo.length} to run\n`);
  let n = 0; const t0 = Date.now();
  await runPool(todo, async (f) => {
    let out = []; const ft0 = Date.now();
    try { out = await adapters[tool](path.join(jsDir, f), opts); } catch {}
    const ms = Date.now() - ft0;   // per-file wall-clock (only representative at low --concurrency)
    const urls = Array.isArray(out) ? out : (out.urls || []);
    const rec = { urls, ms };
    if (!Array.isArray(out) && out.arity) rec.arity = out.arity;   // lynx: per-URL construction arity (aligned to urls)
    if (!Array.isArray(out) && out.sinks) rec.sinks = out.sinks;   // lynx: per-URL sink TYPE (aligned to urls)
    fs.writeFileSync(path.join(toolDir, f.replace(/\.js$/, ".json")), JSON.stringify(rec));
    if (++n % 100 === 0 || n === todo.length) process.stderr.write(`\r    ${tool}: ${n}/${todo.length}`);
  }, { concurrency: opts.concurrency });
  if (todo.length) process.stderr.write("\n");
  // per-file scaling data: sha, file size, sink count, and per-file time (from cache, so complete even
  // when resuming). Plot ms vs bytes / sinks to show how each tool scales. Run at low --concurrency for
  // contention-free times.
  const perf = [];
  for (const f of files) {
    try {
      const c = JSON.parse(fs.readFileSync(path.join(toolDir, f.replace(/\.js$/, ".json")), "utf8"));
      const bytes = fs.statSync(path.join(jsDir, f)).size;
      perf.push(`${f.replace(/\.js$/, "")},${bytes},${(c.urls || []).length},${c.ms == null ? "" : c.ms}`);
    } catch {}
  }
  ensureDir(opts.results);
  fs.writeFileSync(path.join(opts.results, `perf-${tool}.csv`), "sha,bytes,sinks,ms\n" + perf.join("\n") + "\n");
  return { ranMs: Date.now() - t0, ran: todo.length, total: files.length };   // wall-clock over freshly-analyzed files
}

const toolCache = {};
function toolRecForSha(out, tool, sha) {                  // {urls, arity?} for one file, parsed once
  const key = tool + "/" + sha;
  if (toolCache[key]) return toolCache[key];
  let rec = { urls: [] };
  const f = path.join(out, "tools", tool, `${sha}.json`);
  if (fs.existsSync(f)) { try { const c = JSON.parse(fs.readFileSync(f, "utf8")); rec = { urls: c.urls || [], arity: c.arity, sinks: c.sinks }; } catch {} }
  return (toolCache[key] = rec);
}
const toolUrlsForSha = (out, tool, sha) => toolRecForSha(out, tool, sha).urls;

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { console.log("Usage: node compare.js [--out DIR] [--tools grep,linkfinder,jsluice,lynx] [--lynx PATH] [--timeout MS] [--concurrency N] [--lists f...] [--limit N] [--rerun] [--no-arity]"); return; }
  const gtDir = path.join(opts.out, "ground-truth"), jsDir = path.join(opts.out, "js");
  if (!fs.existsSync(gtDir) || !fs.existsSync(jsDir)) { console.error("run crawl.js + download.js first"); process.exit(1); }

  // preflight tools; drop any that aren't installed
  const tools = [];
  for (const t of opts.tools) {
    if (await toolAvailable(t, opts)) tools.push(t);
    else console.error(`[!] skipping ${t} (not runnable — check install / PATH)`);
  }
  if (!tools.length) { console.error("no runnable tools"); process.exit(1); }
  console.log(`[*] tools: ${tools.join(", ")}`);

  // domain -> group
  const groupOf = new Map();
  for (const lf of opts.lists) {
    const g = path.basename(lf).replace(/\.[^.]+$/, "");
    for (const d of fs.readFileSync(lf, "utf8").split(/\r?\n/)) { const s = d.trim(); if (s) groupOf.set(s, g); }
  }

  const urlToSha = loadUrlToSha(path.join(opts.out, "js-index.csv"));
  let domains = domainsFromLog(path.join(opts.out, "crawl-log.csv"));
  if (opts.limit) domains = domains.slice(0, opts.limit);

  // One GT pass -> per-domain scoring plan + the UNION of JS files actually referenced (script
  // initiators / script resources). Phase A then analyzes ONLY those files: makes --limit a true
  // corpus sample and, even on a full run, skips downloaded JS that is never scored.
  const plan = [];                                        // {group, base, gtStripped, shas:[...]}
  const needed = new Set();
  const jsFiles = fs.readdirSync(jsDir);
  const haveSha = new Set(jsFiles.map((f) => (f.endsWith(".js") ? f.slice(0, -3) : f)));  // shas actually on disk
  let gtSeen = 0, gtDropped = 0;
  for (const domain of domains) {
    const recs = readGt(gtDir, domain);
    // Only SCRIPT-INITIATED requests are recoverable by a static JS extractor. Parser-initiated
    // resources (static <script>/<link>/<img> in the HTML) are not in any JS file, so scoring JS
    // tools against them is unfair — exclude them from both the GT and the files analyzed.
    const scriptRecs = recs.filter((r) => r.initiatorType === "script" && r.groundTruthUrl && r.initiatorUrl);
    if (!scriptRecs.length) continue;
    // A GT endpoint is only scoreable if the script that INITIATED it is actually in the corpus (downloaded
    // + indexed). If that JS was never captured, NO static tool can recover the endpoint — counting it would
    // deflate every tool's recall. Keep only records whose initiator resolves to a sha on disk.
    const present = scriptRecs.filter((r) => { const s = urlToSha.get(r.initiatorUrl); return s && haveSha.has(s); });
    const allStripped = new Set(scriptRecs.map((r) => r.groundTruthUrl.split(/[?#]/)[0]));
    const gtStripped = [...new Set(present.map((r) => r.groundTruthUrl.split(/[?#]/)[0]))];
    gtSeen += allStripped.size; gtDropped += allStripped.size - gtStripped.length;
    if (!gtStripped.length) continue;
    const shas = new Set(present.map((r) => urlToSha.get(r.initiatorUrl)));  // the INITIATING scripts (all on disk)
    for (const s of shas) needed.add(s);
    plan.push({ group: groupOf.get(domain) || "ungrouped", domain, base: "https://" + domain + "/", gtStripped, shas: [...shas] });
  }
  const neededFiles = [...needed].map((s) => `${s}.js`);
  console.log(`[*] ${plan.length} scorable domains referencing ${neededFiles.length} JS files (of ${jsFiles.length} downloaded)`);
  console.log(`[*] GT endpoints: ${gtSeen - gtDropped} scoreable (${gtDropped} dropped — initiator JS not in corpus)`);

  const timing = {};                                     // Phase A wall-clock per tool (freshly-analyzed files)
  for (const t of tools) timing[t] = await phaseA(t, opts, jsDir, neededFiles);

  // Construction-arity histogram (folded in — no second corpus pass): from the per-URL arity the lynx adapter
  // cached this run. Resume-safe (reads from cache). Writes results/arity-hist.json (make_figures).
  const arityUrlLike = (u) => /^https?:\/\//i.test(u) || /^\{[A-Z_]+:[^}]*\}\//.test(u) || u.startsWith("//");
  if (opts.arity && tools.includes("lynx")) {
    const hist = {};
    for (const f of neededFiles) {
      try {
        const c = JSON.parse(fs.readFileSync(path.join(opts.out, "tools", "lynx", f.replace(/\.js$/, ".json")), "utf8"));
        if (c.arity) { for (let i = 0; i < c.urls.length; i++) { if (arityUrlLike(c.urls[i])) { const a = c.arity[i] || 1; hist[a] = (hist[a] || 0) + 1; } } }
        else if (c.arityHist) for (const [a, k] of Object.entries(c.arityHist)) hist[a] = (hist[a] || 0) + k;  // legacy cache
      } catch {}
    }
    const ent = Object.entries(hist).map(([a, k]) => [+a, k]).sort((x, y) => x[0] - y[0]);
    let total = 0, wsum = 0; for (const [a, k] of ent) { total += k; wsum += a * k; }
    let cum = 0, med = 0; for (const [a, k] of ent) { cum += k; if (cum >= total / 2) { med = a; break; } }
    const ge = (n) => ent.reduce((s, [a, k]) => s + (a >= n ? k : 0), 0);
    ensureDir(opts.results);
    fs.writeFileSync(path.join(opts.results, "arity-hist.json"), JSON.stringify({
      total, mean: total ? +(wsum / total).toFixed(3) : 0, median: med,
      constructed_frac: total ? +(ge(2) / total).toFixed(4) : 0,
      heavily_constructed_frac: total ? +(ge(4) / total).toFixed(4) : 0,
      hist: Object.fromEntries(ent),
    }, null, 2));
    console.log(`[*] construction arity: ${total} URLs, mean ${total ? (wsum / total).toFixed(2) : 0}, ${total ? (100 * ge(2) / total).toFixed(0) : 0}% assembled from >=2 pieces -> ${opts.results}/arity-hist.json`);
  }

  const agg = {};                                        // agg[tool][scope] -> tallies
  const covByTool = {};                                   // tool -> [single-string coverage per matched GT]
  for (const t of tools) { agg[t] = {}; covByTool[t] = []; }

  // Venn of endpoints DISCOVERED (best tier exact|templated) by LinkFinder / JSluice / LyN-X: which GT
  // endpoints each approach recovers, and their overlap. The LyN-X-only region is the constructed endpoints
  // that have no literal form for a regex to find; the regex-only region is what LyN-X's sink model misses.
  const VENN = ["linkfinder", "jsluice", "lynx"];
  const vennOn = VENN.every((t) => tools.includes(t));
  const hostOf = (u) => { try { return new URL(u).host.toLowerCase(); } catch { return ""; } };
  const venn = { reg: new Array(8).fill(0), regWeak: new Array(8).fill(0), gtTotal: 0, gtFirst: 0,
    lxOnly: 0, lxOnlyTempl: 0, lxOnlyFirst: 0, rxOnly: 0, rxOnlyFirst: 0, all3: 0, all3First: 0 };
  // Cross-tool construction picture: for each GT endpoint LyN-X recovers, its construction arity, split by
  // whether a regex tool ALSO found it (literal form exists) vs LyN-X-only (no literal). arityRec[bucket][arity].
  const wantArity = opts.arity && vennOn;
  const arityRec = { regex: {}, lynxOnly: {} };
  // Sink-type prevalence (LyN-X only, no regex tools needed): for each crawled site, which sink TYPES its
  // scripts contain and whether the URL points same-host (first-party) or external (third-party). sinkPrev
  // [sink] = { first, third }, counting distinct (site, endpoint, sink). Contrasts with CodeQL, whose
  // ClientRequest model covers only fetch/xhr/known-libs (CODEQL_SINKS below).
  const wantSinks = opts.arity && tools.includes("lynx");
  const sinkPrev = {};
  console.log(`[B] scoring ${plan.length} domains ...`);

  let n = 0;
  for (const { group, domain, base, gtStripped, shas } of plan) {
    const tiersByTool = {};                              // venn tool -> gtTiers array for this domain
    let lxArity = null;                                  // lynx per-endpoint construction arity
    const dlp = domain.toLowerCase();                    // for sink-prevalence party (host vs crawled site)
    const isFirstP = (h) => !!h && (h === dlp || h.endsWith("." + dlp));
    const sinkSeen = wantSinks ? new Set() : null;       // dedup (sink|endpoint) within this site
    for (const t of tools) {
      const set = new Set();
      const arityOf = (wantArity && t === "lynx") ? new Map() : null;
      for (const s of shas) {
        const rec = toolRecForSha(opts.out, t, s);
        for (let i = 0; i < rec.urls.length; i++) {
          const raw = rec.urls[i];
          if (!raw || isPurePlaceholder(raw)) continue;
          const u = resolveUrl(raw, base); set.add(u);
          if (arityOf) { const a = (rec.arity && rec.arity[i]) || 1; if (a > (arityOf.get(u) || 0)) arityOf.set(u, a); }
          if (sinkSeen && t === "lynx" && rec.sinks) {     // sink-type prevalence, first vs third party
            const sk = rec.sinks[i] || "?"; const key = sk + "|" + u;
            if (!sinkSeen.has(key)) { sinkSeen.add(key);
              const b = sinkPrev[sk] || (sinkPrev[sk] = { first: 0, third: 0 });
              if (isFirstP(hostOf(u))) b.first++; else b.third++;
            }
          }
        }
      }
      const tally = scoreDomain(set, gtStripped, domain, arityOf);
      if (arityOf) lxArity = tally.gtArity;
      for (const scope of [group, "OVERALL"]) {
        agg[t][scope] = agg[t][scope] || blankAgg();
        addInto(agg[t][scope], tally);
      }
      if (tally.byParty) {                                // same-host (first-party) vs external (third-party)
        for (const [pk, ps] of [["first", "OVERALL·same-host"], ["third", "OVERALL·third-party"]]) {
          agg[t][ps] = agg[t][ps] || blankAgg();
          addInto(agg[t][ps], tally.byParty[pk]);
        }
      }
      for (const c of tally.coverages) covByTool[t].push(c);
      if (vennOn && VENN.includes(t)) tiersByTool[t] = tally.gtTiers;
    }
    if (vennOn) {                                        // accumulate per-endpoint recovery overlap
      const dl = domain.toLowerCase(), isFirst = (h) => h === dl || h.endsWith("." + dl);
      const lfT = tiersByTool.linkfinder, jsT = tiersByTool.jsluice, lxT = tiersByTool.lynx;
      for (let i = 0; i < gtStripped.length; i++) {
        venn.gtTotal++; const first = isFirst(hostOf(gtStripped[i])); if (first) venn.gtFirst++;
        const lf = lfT[i], js = jsT[i], lx = lxT[i];
        let bits = 0; if (lf >= 2) bits |= 1; if (js >= 2) bits |= 2; if (lx >= 2) bits |= 4;   // exact|templated
        venn.reg[bits]++;
        if (bits === 4) { venn.lxOnly++; if (lx === 2) venn.lxOnlyTempl++; if (first) venn.lxOnlyFirst++; }
        if ((bits & 3) && !(bits & 4)) { venn.rxOnly++; if (first) venn.rxOnlyFirst++; }
        if (bits === 7) { venn.all3++; if (first) venn.all3First++; }
        let bw = 0; if (lf >= 1) bw |= 1; if (js >= 1) bw |= 2; if (lx >= 1) bw |= 4; venn.regWeak[bw]++;  // weak-inclusive
        if (wantArity && lxArity && lx >= 2) {            // construction arity of a LyN-X-recovered endpoint
          const a = Math.max(1, lxArity[i]);
          const bucket = (lf >= 2 || js >= 2) ? arityRec.regex : arityRec.lynxOnly;   // regex-also vs LyN-X-only
          bucket[a] = (bucket[a] || 0) + 1;
        }
      }
    }
    if (++n % 500 === 0) process.stderr.write(`\r    scored ${n}`);
  }
  process.stderr.write("\n");

  if (vennOn) {                                          // venn3 subset order (A=LF,B=JS,C=LX): Abc,aBc,ABc,abC,AbC,aBC,ABC
    const sub = (r) => [r[1], r[2], r[3], r[4], r[5], r[6], r[7]];
    fs.writeFileSync(path.join(opts.results, "compare-venn.json"), JSON.stringify({
      sets: ["LinkFinder", "JSluice", "LyN-X"], threshold: "exact|templated (path-level structural recovery)",
      total_gt: venn.gtTotal, gt_first_party: venn.gtFirst, gt_third_party: venn.gtTotal - venn.gtFirst,
      venn3_pathlevel: { order: ["LFonly", "JSonly", "LF&JS", "LXonly", "LF&LX", "JS&LX", "all3"], subsets: sub(venn.reg) },
      venn3_weakinclusive: { order: ["LFonly", "JSonly", "LF&JS", "LXonly", "LF&LX", "JS&LX", "all3"], subsets: sub(venn.regWeak) },
      lynx_only: { n: venn.lxOnly, templated: venn.lxOnlyTempl, exact: venn.lxOnly - venn.lxOnlyTempl, first_party: venn.lxOnlyFirst, third_party: venn.lxOnly - venn.lxOnlyFirst },
      regex_only: { n: venn.rxOnly, first_party: venn.rxOnlyFirst, third_party: venn.rxOnly - venn.rxOnlyFirst },
      all3: { n: venn.all3, first_party: venn.all3First, third_party: venn.all3 - venn.all3First },
    }, null, 2));
  }

  if (wantArity) {                                        // construction arity of LyN-X recoveries, split by regex-recoverability
    const sumH = (h) => Object.values(h).reduce((a, b) => a + b, 0);
    const meanH = (h) => { let t = 0, w = 0; for (const [a, k] of Object.entries(h)) { t += k; w += (+a) * k; } return t ? +(w / t).toFixed(2) : 0; };
    const sortH = (h) => Object.fromEntries(Object.entries(h).map(([a, k]) => [+a, k]).sort((x, y) => x[0] - y[0]));
    const nR = sumH(arityRec.regex), nL = sumH(arityRec.lynxOnly);
    fs.writeFileSync(path.join(opts.results, "arity-by-recoverability.json"), JSON.stringify({
      note: "Construction arity of endpoints LyN-X recovers (exact|templated). 'regex_also' = a regex tool also found it (a literal form exists); 'lynx_only' = no literal form. Regex-recoverable endpoints should skew arity=1; LyN-X-only should skew high.",
      regex_also: { n: nR, mean_arity: meanH(arityRec.regex), literal_frac: nR ? +((arityRec.regex[1] || 0) / nR).toFixed(4) : 0, hist: sortH(arityRec.regex) },
      lynx_only: { n: nL, mean_arity: meanH(arityRec.lynxOnly), literal_frac: nL ? +((arityRec.lynxOnly[1] || 0) / nL).toFixed(4) : 0, hist: sortH(arityRec.lynxOnly) },
    }, null, 2));
    console.log(`[*] cross-tool arity: regex-recoverable endpoints mean arity ${meanH(arityRec.regex)} (${nR ? (100 * (arityRec.regex[1] || 0) / nR).toFixed(0) : 0}% literal), LyN-X-only mean arity ${meanH(arityRec.lynxOnly)} -> arity-by-recoverability.json`);
  }

  if (wantSinks && Object.keys(sinkPrev).length) {       // sink-type prevalence, first- vs third-party, + CodeQL coverage
    // CodeQL's ClientRequest model covers HTTP-request sinks (fetch / XHR / known client libs). Everything
    // else LyN-X detects — dynamic script/link/img/iframe resource loads, WebSocket/EventSource/Worker,
    // sendBeacon, import(), navigations — is OUT of that model (the "LyN-X is a complementary asset" point).
    const CODEQL_SINKS = new Set(["fetch", "$.get", "$.post", "$.ajax", "$.getJSON", "axios", "request", "got"]);
    const codeqlCovered = (s) => CODEQL_SINKS.has(s) || s.startsWith("rest.") || s.startsWith("xhr");  // fetch/XHR/known HTTP clients
    const rows = Object.entries(sinkPrev).map(([sink, b]) => ({
      sink, first: b.first, third: b.third, total: b.first + b.third,
      third_frac: +(b.third / (b.first + b.third)).toFixed(4), codeql: codeqlCovered(sink),
    })).sort((a, b) => b.total - a.total);
    const cqTot = rows.filter((r) => r.codeql).reduce((s, r) => s + r.total, 0);
    const lxTot = rows.reduce((s, r) => s + r.total, 0) - cqTot;
    fs.writeFileSync(path.join(opts.results, "sink-prevalence.json"), JSON.stringify({
      note: "Prevalence of each LyN-X sink TYPE across the crawled sites, split by whether the URL points same-host (first-party) or external (third-party). Unit = distinct (site, endpoint, sink). 'codeql' = the sink type is in CodeQL's ClientRequest model (fetch/xhr/known libs); the rest are LyN-X-only sink types.",
      codeql_covered_total: cqTot, lynx_only_total: lxTot,
      lynx_only_sink_types: rows.filter((r) => !r.codeql).length, codeql_sink_types: rows.filter((r) => r.codeql).length,
      sinks: rows,
    }, null, 2));
    console.log(`[*] sink prevalence: ${rows.length} sink types (${rows.filter((r) => !r.codeql).length} outside CodeQL's model, ${(100 * lxTot / (cqTot + lxTot)).toFixed(0)}% of sink-endpoints) -> sink-prevalence.json`);
  }

  ensureDir(opts.results);
  const R = opts.results;
  const median = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  const pad = (s, n) => String(s).padEnd(n);

  // ---- per-(tool,scope) metrics CSV ----
  const csv = csvAppender(path.join(R, "compare-scores.csv"), ["tool", "scope", ...METRIC_COLS], true);
  console.log("\n  tool        scope        GT    F1_s   F1_m   F1_r    DG    ADG   (strict/medium/relaxed F1)");
  for (const t of tools) {
    for (const [scope, a] of [...Object.entries(agg[t])].sort((x, y) => (x[0] === "OVERALL" ? 1 : y[0] === "OVERALL" ? -1 : x[0] < y[0] ? -1 : 1))) {
      const row = metricsRow(scope, a);            // [scope, gt, P_s,R_s,F1_s, P_m,R_m,F1_m, P_r,R_r,F1_r, DG, ADG]
      csv.row([disp(t), ...row]);
      console.log(`  ${pad(t, 11)} ${row[0].padEnd(12)} ${String(row[1]).padStart(5)}  ${row[4]} ${row[7]} ${row[10]}  ${String(row[11]).padStart(5)} ${String(row[12]).padStart(5)}`);
    }
  }
  csv.close();

  // ---- coherence: single-string coverage per matched endpoint (histogram-ready) ----
  const coh = {};   // tool -> {mean, median, frag}
  for (const t of tools) {
    const cov = covByTool[t];
    const o = agg[t].OVERALL || blankAgg();
    const matchedGt = Math.max(1, o.gExact + o.gTempl + o.gWeak);
    coh[t] = { mean: mean(cov), median: median(cov), frag: (o.nExact + o.nTempl + o.nWeak) / matchedGt };
    fs.writeFileSync(path.join(R, `coverage-${t}.txt`), cov.map((c) => c.toFixed(4)).join("\n") + "\n");
  }

  // ---- tier data for the stacked-bar figure: GT endpoints recovered by best tier + missed ----
  const TIERS = ["exact", "templated", "weak", "miss"];
  const counts = {}, totalGt = (agg[tools[0]] && agg[tools[0]].OVERALL ? agg[tools[0]].OVERALL.gt : 0);
  for (const t of tools) {
    const o = agg[t].OVERALL || blankAgg();
    counts[disp(t)] = { exact: o.gExact, templated: o.gTempl, weak: o.gWeak, miss: Math.max(0, o.gt - o.gExact - o.gTempl - o.gWeak) };
  }
  fs.writeFileSync(path.join(R, "compare-tiers.json"),
    JSON.stringify({ tools: tools.map(disp), tiers: TIERS, total_gt: totalGt, counts }, null, 2));

  // ---- LaTeX table (booktabs): recall F1 by tier + DG, per tool ----
  let tex = "% Auto-generated by compare.js. Requires \\usepackage{booktabs}.\n";
  tex += "\\begin{tabular}{lrrrrr}\n\\toprule\nTool & GT & F1$_\\text{strict}$ & F1$_\\text{med}$ & F1$_\\text{relax}$ & DG \\\\\n\\midrule\n";
  for (const t of tools) {
    const r = metricsRow("OVERALL", agg[t].OVERALL || blankAgg());   // [,gt,,,F1s,,,F1m,,,F1r,DG,ADG]
    tex += `${texEsc(disp(t))} & ${r[1]} & ${r[4]} & ${r[7]} & ${r[10]} & ${r[11]} \\\\\n`;
  }
  tex += "\\bottomrule\n\\end{tabular}\n";
  fs.writeFileSync(path.join(R, "compare-scores.tex"), tex);

  // ---- human overview ----
  let txt = "LyN-X crawl-corpus comparison (extraction axis)\n" + "=".repeat(48) + "\n\n";
  txt += `Corpus: ${plan.length} domains scored, ${totalGt} ground-truth endpoints.\n`;
  txt += `Tools: ${tools.map(disp).join(", ")} (relwarc = per-.js/relwarc-js static mode).\n`;
  txt += "Endpoint match: host+path (query stripped). Tiers: exact | templated | weak | miss.\n\n";
  txt += "OVERALL 3-tier precision/recall/F1 + DG/ADG:\n";
  txt += "  " + pad("tool", 12) + "GT     F1_s    F1_m    F1_r    DG     ADG\n";
  for (const t of tools) { const r = metricsRow("OVERALL", agg[t].OVERALL || blankAgg());
    txt += "  " + pad(disp(t), 12) + pad(r[1], 7) + pad(r[4], 8) + pad(r[7], 8) + pad(r[10], 8) + pad(r[11], 7) + r[12] + "\n"; }
  txt += "\nSame-host (first-party) vs external (third-party) split — recall F1 + DG (LyN-X targets external\n"
    + "dependency recovery, so the external row is where the sink-coverage work matters):\n";
  txt += "  " + pad("tool", 12) + pad("scope", 14) + "GT      F1_s    F1_m    F1_r    DG\n";
  for (const t of tools) for (const [scope, label] of [["OVERALL·same-host", "same-host"], ["OVERALL·third-party", "third-party"]]) {
    const r = metricsRow(scope, agg[t][scope] || blankAgg());
    txt += "  " + pad(disp(t), 12) + pad(label, 14) + pad(r[1], 8) + pad(r[4], 8) + pad(r[7], 8) + pad(r[10], 8) + r[11] + "\n";
  }
  txt += "\nGT endpoints recovered by best tier (feeds the stacked-bar figure):\n";
  for (const t of tools) { const c = counts[disp(t)]; txt += "  " + pad(disp(t), 12) + TIERS.map((k) => `${k}=${c[k]}`).join("  ") + "\n"; }
  txt += "\nCoherence — single-string coverage of a matched endpoint (higher = one coherent string,\nnot fragments) + fragmentation (matching strings per endpoint):\n";
  txt += "  " + pad("tool", 12) + "cov_mean  cov_median  frag_ratio\n";
  for (const t of tools) txt += "  " + pad(disp(t), 12) + pad(coh[t].mean.toFixed(3), 10) + pad(coh[t].median.toFixed(3), 12) + coh[t].frag.toFixed(2) + "\n";
  txt += "\nPhase-A runtime (wall-clock analyzing the corpus; cached files excluded):\n";
  for (const t of tools) { const tm = timing[t] || { ranMs: 0, ran: 0 };
    txt += "  " + pad(disp(t), 12) + `${(tm.ranMs / 1000).toFixed(1)} s over ${tm.ran} files` + (tm.ran ? ` (${(tm.ranMs / tm.ran).toFixed(1)} ms/file)` : " (all cached)") + "\n"; }
  fs.writeFileSync(path.join(R, "compare-results.txt"), txt);

  console.log("\n" + txt.split("Coherence")[0]);
  console.log(`[*] wrote ${R}/{compare-scores.csv, compare-scores.tex, compare-results.txt, compare-tiers.json, coverage-<tool>.txt${vennOn ? ", compare-venn.json" : ""}${opts.arity && tools.includes("lynx") ? ", arity-hist.json" : ""}}`);
  console.log(`[*] figures: python3 ${path.relative(process.cwd(), path.join(__dirname, "..", "benchmark", "make_figures.py"))} ${R}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
