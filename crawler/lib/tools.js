"use strict";
// Shared tool adapters: run each extractor on a JS file -> array of raw URL strings
// (placeholders normalized to {VAR:} so lib/match treats them uniformly).
// Used by both compare.js (real corpus) and bench.js (synthetic per-category suite).

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { execFile } = require("child_process");

const run = (cmd, args, timeout, cwd, env) => new Promise((res) =>
  execFile(cmd, args, { timeout, maxBuffer: 64 * 1024 * 1024, killSignal: "SIGKILL", cwd, env: env || process.env },
    (err, stdout, stderr) => res({ err, stdout: stdout || "", stderr: stderr || "" })));

// Surface a tool that failed to RUN (bad path, missing dep, spawn error, timeout) so a broken
// adapter can't masquerade as "found nothing". Legitimate empty output (no err) is NOT warned.
function warnRun(r, tool, file) {
  if (r && r.err) {
    const why = r.err.code || (r.err.killed ? "timeout" : r.err.message.split("\n")[0]);
    process.stderr.write(`[warn] ${tool} failed to run on ${path.basename(file)}: ${why}\n`);
  }
  return r;
}

const URLRE = /https?:\/\/[^\s"'`<>()\\]+/g;

const adapters = {
  async grep(file) {                                     // naive regex floor (kept, not default)
    return [...fs.readFileSync(file, "utf8").matchAll(URLRE)].map((m) => m[0]);
  },
  async linkfinder(file, o) {                            // pure-regex endpoint extractor (venv module)
    const { stdout } = warnRun(await run("python", ["-m", "linkfinder", "-i", file, "-o", "cli"], o.timeout), "linkfinder", file);
    return stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  },
  async jsluice(file, o) {                               // AST + single-expr resolution; EXPR -> {VAR:}
    const { stdout } = warnRun(await run("jsluice", ["urls", file], o.timeout), "jsluice", file);
    const out = [];
    for (const l of stdout.split(/\r?\n/)) {
      if (!l.trim()) continue;
      try { const j = JSON.parse(l); if (j.url) out.push(String(j.url).replace(/EXPR/g, "{VAR:EXPR}")); } catch {}
    }
    return out;
  },
  async lynx(file, o) {                                  // path/context-sensitive; {VAR:}/{CALL:} kept
    const tmp = path.join(os.tmpdir(), "lynx_" + crypto.randomUUID() + ".json");
    const extra = o.lynxBase ? ["--base", o.lynxBase] : [];  // concat a known base onto root-relative routes (SDK study); distinct key from bench's o.base (post-hoc resolver)
    // o.arity (set by compare.js) folds the construction-arity study into the same run: LYNX_TRACK_ARITY
    // makes lyn-x emit a per-URL `arity` (# source fragments concatenated), which we histogram per file so
    // no second corpus pass is needed. Off (bench, default) => plain URL list, zero overhead.
    const env = o.arity ? { ...process.env, LYNX_TRACK_ARITY: "1" } : undefined;
    warnRun(await run(process.execPath, [o.lynx, file, ...extra, "--json", tmp], o.timeout, undefined, env), "lynx", file);  // execPath, not "node"
    let urls = [], arity = null, sinks = null;
    try {
      const rows = JSON.parse(fs.readFileSync(tmp, "utf8")).results || [];
      const kept = rows.filter((r) => r.url);
      urls = kept.map((r) => r.url);
      if (o.arity) { arity = kept.map((r) => r.arity || 1); sinks = kept.map((r) => r.sink || ""); }   // per-URL construction arity + sink TYPE, aligned to urls
    } catch {}
    try { fs.unlinkSync(tmp); } catch {}
    return o.arity ? { urls, arity, sinks } : urls;
  },
  async relwarc(file, o) {                               // Sigalov & Gamayunov static endpoint finder
    // Per-.js mode is relwarc's `nrun` (symlinked `relwarc-js`); the app/HTML mode is `run`
    // (symlinked `relwarc`). This adapter analyzes individual .js files, so it defaults to
    // `relwarc-js`. Logs -> stderr; DEPS -> stdout as HAR blocks:
    //   "DEPS (N):" then "<METHOD> <url> HTTP/1.1" / "Host: ..." per dependency.
    // relwarc emits CONCRETE urls (substitutes guessed values), so no placeholder normalization.
    const base = o.relwarcCmd && o.relwarcCmd.length ? o.relwarcCmd : ["relwarc-js"];
    const { stdout, stderr } = warnRun(await run(base[0], [...base.slice(1), file], o.timeout, o.relwarcCwd), "relwarc", file);
    // In per-.js mode relwarc has no host context, so it fabricates `example.com` as the host for
    // root-relative URLs. That placeholder host would spuriously mismatch a real-host ground truth,
    // so strip it back to a root-relative path -> the scorer resolves it against the real page base.
    // Genuinely-absolute URLs found in the JS keep their real host (only bare example.com is dropped).
    const deplaceholder = (u) => u.replace(/^https?:\/\/example\.com(?=[/?#]|$)/i, "");
    const out = [];
    for (const line of stdout.split(/\r?\n/)) {
      const m = line.match(/^\s*(?:GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s+(\S+)\s+HTTP\//i);
      if (m) out.push(deplaceholder(m[1]));
    }
    if (!out.length) for (const m of (stdout + "\n" + stderr).matchAll(URLRE)) out.push(deplaceholder(m[0])); // fallback
    return out;
  },
};

// preflight: is a tool actually WORKING here? Runs the adapter on a trivial top-level fetch and
// requires it to recover that URL — so a missing binary, wrong --lynx path, or crashing tool is
// SKIPPED (reported "not runnable") instead of silently scoring 0 on every case. grep is the
// dependency-free floor and is always available.
async function toolAvailable(tool, o) {
  if (tool === "grep") return true;
  const tmp = path.join(os.tmpdir(), "pf_" + crypto.randomUUID() + ".js");
  fs.writeFileSync(tmp, 'fetch("https://x.example/a")');
  try { const out = await adapters[tool](tmp, o); const urls = Array.isArray(out) ? out : (out && out.urls) || [];  // lynx may return {urls, arityHist}
    return urls.some((u) => /x\.example/.test(String(u))); }
  catch { return false; }
  finally { try { fs.unlinkSync(tmp); } catch {} }
}

// Canonical tool sets (single source of truth). grep is the dependency-free floor and is opt-in only.
// Unavailable tools are skipped with a warning by toolAvailable(), so these are safe as defaults.
//   BASE_TOOLS — the four extraction tools compared throughout the paper.
const BASE_TOOLS = ["linkfinder", "jsluice", "relwarc", "lynx"];

module.exports = { adapters, toolAvailable, BASE_TOOLS };
