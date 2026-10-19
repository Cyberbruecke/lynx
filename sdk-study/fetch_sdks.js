#!/usr/bin/env node
"use strict";
// P1 — download each SDK's code + its spec. Per sdk in sdks.json:
//   - `npm pack` the package -> extract to out/sdk/<name>/pkg/  (the published, compiled JS the tools analyze)
//   - download the OpenAPI/Discovery spec -> out/sdk/<name>/spec.{json,yaml}
//   - (optional, --bundle) esbuild the package into out/sdk/<name>/dist.js (one realistic artifact)
// Robust + resumable: skips a step whose output already exists (unless --force). Per-sdk failures are
// non-fatal. Needs network + npm on PATH; --bundle needs esbuild (npx esbuild).
//
// Usage: node fetch_sdks.js [--only name1,name2] [--bundle] [--force]

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");

// GitHub auth: the contents API is 60 req/hr UNAUTHENTICATED (returns 403 when exhausted — your browser
// hits the same limit since it doesn't send a token). Set GITHUB_TOKEN (or GH_TOKEN, e.g. `gh auth token`)
// to get 5000/hr. Harmless on raw.githubusercontent (not rate-limited) and required for any private repo.
const GH_TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";
function ghHeaders(accept) {
  const h = { "user-agent": "lynx-sdk-study" };
  if (accept) h.accept = accept;
  if (GH_TOKEN) h.authorization = `Bearer ${GH_TOKEN}`;
  return h;
}

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });
}

async function download(url, dest) {
  const res = await fetch(url, { headers: ghHeaders() });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

const ext = (u) => (/\.ya?ml($|\?)/i.test(u) ? "yaml" : "json");

// Resolve ONE specSource token into downloadable file URLs. Returns {files:[{url}]} or {manual:reason}.
async function resolveOne(src) {
  if (!src || /^N\/A/i.test(src) || /verify\)?$/i.test(src)) return { manual: `resolve ${JSON.stringify(src)} by hand` };
  if (src.startsWith("http")) return { files: [{ url: src.split(" ")[0] }] };
  const m = src.match(/^github:([^/]+)\/([^/]+)\/(.+)$/);
  if (!m) return { manual: `unrecognized specSource ${JSON.stringify(src)}` };
  const [, owner, repo, p] = m;
  if (!p.endsWith("/")) return { files: [{ url: `https://raw.githubusercontent.com/${owner}/${repo}/HEAD/${p}` }] };
  const dirPath = p.replace(/\/+$/, "");
  // directory: list via the GitHub contents API. 60 req/hr UNAUTHENTICATED (403 when exhausted); a token
  // lifts that to 5000/hr. On any API failure, fall back to the repo tarball (codeload = NOT rate-limited).
  const api = `https://api.github.com/repos/${owner}/${repo}/contents/${dirPath}`;
  const res = await fetch(api, { headers: ghHeaders("application/vnd.github+json") });
  if (res.ok) {
    const files = (await res.json()).filter((e) => e.type === "file" && /\.(json|ya?ml)$/i.test(e.name))
      .map((e) => ({ url: e.download_url, name: e.name }));
    if (files.length) return { files };
    return { manual: `no spec files under ${api}` };
  }
  const viaTar = listDirViaTarball(owner, repo, dirPath);
  if (viaTar && viaTar.length) {
    process.stderr.write(`  (contents API ${res.status}; listed ${dirPath}/ via tarball instead)\n`);
    return { files: viaTar };
  }
  const hint = res.status === 403 ? " — rate-limited; set GITHUB_TOKEN (e.g. `export GITHUB_TOKEN=$(gh auth token)`)" : "";
  return { manual: `GitHub API ${res.status} listing ${api}${hint}` };
}

// Enumerate spec files in a repo subdir WITHOUT the rate-limited contents API: download the repo tarball
// from codeload (not rate-limited), extract, read the target dir, and return raw.githubusercontent URLs
// (raw is not rate-limited either) so fetchSpecs' normal download path handles the rest. Tries main/master.
function listDirViaTarball(owner, repo, dirPath) {
  for (const branch of ["main", "master"]) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sdkspec-"));
    try {
      const tgz = path.join(tmp, "repo.tgz");
      const r = execFileSync("curl", ["-sSL", "-o", tgz, "-w", "%{http_code}",
        ...(GH_TOKEN ? ["-H", `Authorization: Bearer ${GH_TOKEN}`] : []),
        `https://codeload.github.com/${owner}/${repo}/tar.gz/refs/heads/${branch}`], { encoding: "utf8" });
      if (r.trim() !== "200") { fs.rmSync(tmp, { recursive: true, force: true }); continue; }
      sh("tar", ["-xzf", tgz, "-C", tmp]);
      const root = fs.readdirSync(tmp).find((n) => n !== "repo.tgz" && fs.statSync(path.join(tmp, n)).isDirectory());
      const dir = root && path.join(tmp, root, dirPath);
      if (!dir || !fs.existsSync(dir)) { fs.rmSync(tmp, { recursive: true, force: true }); continue; }
      const files = fs.readdirSync(dir).filter((n) => /\.(json|ya?ml)$/i.test(n))
        .map((n) => ({ url: `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${dirPath}/${n}`, name: n }));
      fs.rmSync(tmp, { recursive: true, force: true });
      if (files.length) return files;
    } catch { fs.rmSync(tmp, { recursive: true, force: true }); }
  }
  return null;
}

// Download an SDK's spec(s). Single file -> spec.<ext>; multiple -> spec-parts/NN-<name>.
async function fetchSpecs(sdk, dir, force) {
  const sources = Array.isArray(sdk.specSource) ? sdk.specSource : [sdk.specSource];
  const resolved = [];
  for (const s of sources) { const r = await resolveOne(s); if (r.manual) return { manual: r.manual }; resolved.push(...r.files); }
  if (resolved.length === 1) {
    const dest = path.join(dir, `spec.${ext(resolved[0].url)}`);
    if (!force && fs.existsSync(dest)) return { cached: true };
    await download(resolved[0].url, dest);
    return { count: 1 };
  }
  const partsDir = path.join(dir, "spec-parts");
  if (!force && fs.existsSync(partsDir) && fs.readdirSync(partsDir).length) return { cached: true, count: fs.readdirSync(partsDir).length };
  fs.rmSync(partsDir, { recursive: true, force: true });
  fs.mkdirSync(partsDir, { recursive: true });
  let i = 0;
  for (const f of resolved) {
    const nm = (f.name || `spec.${ext(f.url)}`).replace(/[^\w.-]/g, "_");
    await download(f.url, path.join(partsDir, `${String(i++).padStart(2, "0")}-${nm}`));
  }
  return { count: resolved.length };
}

// npm INSTALL (not pack) so dependencies are present — many SDKs keep their endpoint tables in a dependency
// (e.g. @octokit/plugin-rest-endpoint-methods), and esbuild needs deps resolvable to bundle. Returns the
// installed package dir (out/sdk/<name>/node_modules/<pkg>).
function npmInstall(pkg, dir) {
  if (!fs.existsSync(path.join(dir, "package.json")))
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "sdk-study-sandbox", version: "1.0.0", private: true }) + "\n");
  sh("npm", ["install", pkg, "--no-save", "--no-audit", "--no-fund", "--omit=dev", "--silent"], { cwd: dir });
  return path.join(dir, "node_modules", pkg);
}

// Bundle the installed package into one file. --platform=node externalizes node built-ins; deps are inlined.
function esbuildBundle(pkgDir, outFile, minify) {
  const pj = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"));
  const entry = path.join(pkgDir, (typeof pj.browser === "string" && pj.browser) || pj.module || pj.main || "index.js");
  sh("npx", ["--yes", "esbuild", entry, "--bundle", "--platform=node", "--legal-comments=none",
    ...(minify ? ["--minify"] : []), `--outfile=${outFile}`, "--log-level=error"], { cwd: pkgDir });
}

async function main() {
  const argv = process.argv.slice(2);
  const only = argv.includes("--only") ? new Set(argv[argv.indexOf("--only") + 1].split(",")) : null;
  const bundle = argv.includes("--bundle"), force = argv.includes("--force"), minify = argv.includes("--minify");
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "sdks.json"), "utf8"));

  for (const sdk of manifest.sdks) {
    if (only && !only.has(sdk.name)) continue;
    if (sdk.exclude && !(only && only.has(sdk.name))) { console.log(`\n=== ${sdk.name}: skipped (excluded — ${sdk.exclude}) ===`); continue; }
    const dir = path.join(__dirname, "out", "sdk", sdk.name);
    fs.mkdirSync(dir, { recursive: true });
    console.log(`\n=== ${sdk.name} (${sdk.npm}) ===`);

    // package (npm install so deps are present)
    const instDir = path.join(dir, "node_modules", sdk.npm);
    try {
      if (sdk.npm === "-") console.log("  pkg: skipped (no npm package)");
      else if (!force && fs.existsSync(path.join(instDir, "package.json"))) console.log("  pkg: cached");
      else { npmInstall(sdk.npm, dir); console.log("  pkg: ok"); }
    } catch (e) { console.error(`  pkg: FAILED ${String(e.message).split("\n")[0]}`); }

    // spec (single file, array of files, or a github directory -> spec-parts/)
    try {
      const r = await fetchSpecs(sdk, dir, force);
      if (r.manual) console.error(`  spec: MANUAL — ${r.manual} -> drop spec.json (or spec-parts/*) into ${dir}`);
      else if (r.cached) console.log(`  spec: cached${r.count > 1 ? ` (${r.count} parts)` : ""}`);
      else console.log(`  spec: ok${r.count > 1 ? ` (${r.count} parts merged)` : ""}`);
    } catch (e) { console.error(`  spec: FAILED ${String(e.message).split("\n")[0]}`); }

    // optional bundle (one realistic artifact; falls back to node_modules/<pkg>/*.js in sdk_eval if it fails)
    if (bundle && fs.existsSync(path.join(instDir, "package.json"))) {
      try {
        const outFile = path.join(dir, "dist.js");
        if (!force && fs.existsSync(outFile)) console.log("  bundle: cached");
        else { esbuildBundle(instDir, outFile, minify); console.log(`  bundle: ok${minify ? " (minified)" : ""}`); }
      } catch (e) { console.error(`  bundle: FAILED (sdk_eval falls back to node_modules/${sdk.npm}/*.js) ${String(e.message).split("\n")[0]}`); }
    }
  }
  console.log(`\n[*] done. Next: node extract_groundtruth.js  then  node sdk_eval.js`);
}
main().catch((e) => { console.error(e); process.exit(1); });
