#!/usr/bin/env node
"use strict";
// Test content-hash-filename regexes against the templated-extra sample: how many of each category they'd
// remove, with example hits/misses, so we can pick a churn filter that catches webpack/vite chunk hashes
// (hex8 / base64url8) without nuking legit endpoints. READ-ONLY.
const path = require("path"), fs = require("fs");
const { resolveUrl, classify, isPurePlaceholder } = require("./lib/match");
const { loadUrlToSha, readGt, domainsFromLog } = require("./lib/corpus");
const out = path.join(__dirname, "out");
const LIMIT = +(process.argv[2] || 8000);
const PH = /\{[A-Z_]+:[^}]*\}/g;
const phCount = (u) => (u.match(PH) || []).length;
const hostEndOf = (u) => u.indexOf("/", u.indexOf("://") + 3);

// token-split churn filters: split the concrete path on . / _ - and test each token
function tokTest(pathStr, { minLen, needLetter }) {
  for (const t of pathStr.split(/[.\/]/)) {           // keep _ and - inside tokens (base64url hashes use them)
    if (t.length < minLen) continue;
    if (!/^[a-z0-9_\-]+$/i.test(t)) continue;
    if (!/[0-9]/.test(t)) continue;                    // a content hash always has digits
    if (needLetter && !/[a-z]/i.test(t)) continue;     // exclude pure-numeric ids/chunks
    return true;
  }
  return false;
}
const CANDS = {
  "tok8+digit":         (p) => tokTest(p, { minLen: 8, needLetter: false }),   // hex/base64url/numeric >=8 w/ a digit
  "tok8+digit+letter":  (p) => tokTest(p, { minLen: 8, needLetter: true }),    // same but must also have a letter
  "tok10+digit+letter": (p) => tokTest(p, { minLen: 10, needLetter: true }),   // stricter length
};

const urlToSha = loadUrlToSha(path.join(out, "js-index.csv"));
let domains = domainsFromLog(path.join(out, "crawl-log.csv")).slice(0, LIMIT);
const cache = {};
const urlsForSha = (s) => cache[s] || (cache[s] = (() => { const f = path.join(out, "tools", "lynx", s + ".json"); try { return JSON.parse(fs.readFileSync(f, "utf8")).urls || []; } catch { return []; } })());

// crude category (position-based, publicpath-ish = leading path segment)
function cat(u) {
  const he = hostEndOf(u), idx = u.search(PH), q = u.search(/[?#]/);
  if (he < 0 || idx < he) return "host/skip";
  if (q >= 0 && idx > q) return "query";
  const before = u.slice(he, idx);
  const segPrefix = before.slice(before.lastIndexOf("/") + 1);
  const after = u.slice(idx + u.match(PH)[0].length, q >= 0 ? q : undefined);
  const segSuffix = after.slice(0, after.indexOf("/") < 0 ? undefined : after.indexOf("/"));
  const isFirst = before.slice(1).indexOf("/") < 0;
  if (segPrefix === "" && segSuffix === "") return "whole-segment";
  if (segPrefix === "" && isFirst) return "path-prefix";
  return "other-in-seg";
}

const CATS = ["path-prefix", "whole-segment", "query", "other-in-seg"];
const stat = {}; for (const c of CATS) stat[c] = { n: 0 }, Object.keys(CANDS).forEach((k) => stat[c][k] = 0);
const hits = {}, miss = {}; Object.keys(CANDS).forEach((k) => (hits[k] = [], miss[k] = []));
const distinct = new Set();
for (const domain of domains) {
  const recs = readGt(path.join(out, "ground-truth"), domain).filter((r) => r.initiatorType === "script" && r.groundTruthUrl && r.initiatorUrl);
  if (!recs.length) continue;
  const gt = [...new Set(recs.map((r) => r.groundTruthUrl.split(/[?#]/)[0]))];
  const shas = new Set(); for (const r of recs) { const s = urlToSha.get(r.initiatorUrl); if (s) shas.add(s); }
  const base = "https://" + domain + "/";
  for (const s of shas) for (const raw of urlsForSha(s)) {
    if (!raw || isPurePlaceholder(raw)) continue;
    const u = (resolveUrl(raw, base) || "").split("#")[0];
    if (!/^https?:\/\//i.test(u) || phCount(u) !== 1) continue;
    if (classify(u, gt).type !== "no_match") continue;
    if (distinct.has(u)) continue; distinct.add(u);
    const c = cat(u); if (c === "host/skip") continue;
    if (!stat[c]) continue;
    stat[c].n++;
    const concretePath = u.replace(PH, "").split(/[?#]/)[0].slice(hostEndOf(u));   // path with placeholder removed
    for (const [k, fn] of Object.entries(CANDS)) {
      if (fn(concretePath)) { stat[c][k]++; if (hits[k].length < 6 && Math.random() < 0.2) hits[k].push(u); }
      else if (miss[k].length < 6 && c === "path-prefix" && Math.random() < 0.1) miss[k].push(u);
    }
  }
}
console.log(`\n=== churn-filter hit rates (${distinct.size} distinct templated extras, ${LIMIT} domains) ===\n`);
console.log("category".padEnd(15) + "n".padStart(7) + Object.keys(CANDS).map((k) => k.padStart(13)).join(""));
for (const c of CATS) { const s = stat[c]; console.log(c.padEnd(15) + String(s.n).padStart(7) + Object.keys(CANDS).map((k) => `${(100 * s[k] / Math.max(1, s.n)).toFixed(0)}%`.padStart(13)).join("")); }
for (const k of Object.keys(CANDS)) {
  console.log(`\n--- ${k} HITS (removed) ---`); hits[k].slice(0, 5).forEach((u) => console.log("  " + u));
  console.log(`--- ${k} path-prefix MISSES (kept) ---`); miss[k].slice(0, 5).forEach((u) => console.log("  " + u));
}
