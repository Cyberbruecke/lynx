// One-shot: inject a concise `short` label (1-2 words) into each manifest case, keyed by category.
// Idempotent — re-running just overwrites `short`. Safe to delete after use.
const fs = require("fs");
const SHORT = {
  // --- cases -> "Construction" suite ---
  "literal": "Literal",
  "compound-assignment (+=)": "Compound (+=)",
  "single-expression concat": "Concat",
  "template (runtime-unknown)": "Template",
  "object config (URL from property)": "Object config",
  "computed member sink (window[m])": "Computed member",
  "IIFE / closure variants": "IIFE / closure",
  "loop-built path + URLSearchParams": "Loop + params",
  "loop (for-of) — construct endpoint per element": "for-of loop",
  "loop (Array.forEach) — construct endpoint per element": "forEach loop",
  "loop (forEach) — script.src resource per element": "forEach (src)",
  "conditional (path-sensitive protocol)": "Conditional (proto)",
  "conditional (path-sensitive cartesian)": "Conditional (path)",
  "encodeURIComponent (query)": "encodeURIComponent",
  "collection widening (list index)": "Widen (list)",
  "collection widening (map key)": "Widen (map)",
  // --- dispatch ---
  "REST dispatch (client.post(\"/path\"))": "REST dispatch",
  "positional (method, path) builder": "Positional builder",
  "enum method + variable path (openapi-gen)": "Enum + var path",
  "request-config object ({method,url})": "Config object",
  "combined \"VERB /path\" route string": "VERB+path string",
  "tagged-template parameterized route": "Tagged template",
  // --- obfuscation ---
  "base64 (atob)": "base64 (atob)",
  "char codes (String.fromCharCode)": "fromCharCode",
  "array reassembly (.join)": "Array join",
  "reversed string (split/reverse/join)": "Reversed string",
  "custom decoder (interprocedural)": "Custom decoder",
  "case transform (toLowerCase)": "Case transform",
  "combined (atob + join + concat)": "Combined decode",
  "the URL is carved out of a padded decoy string with a numeric-argument substring() fold": "substring fold",
  "string rewrite (.replace lit,lit)": ".replace rewrite",
  "templated .replace (SDK param)": "Templated .replace",
  // --- sinks ---
  "XMLHttpRequest.open(method,url)": "XHR.open",
  "new WebSocket(url)": "WebSocket",
  "location.href navigation": "location.href",
  "navigator.sendBeacon(url)": "sendBeacon",
  "element.src resource load": "element.src",
  "import(url) dynamic module": "import()",
  "window.open(url) opens the URL in a new tab/popup (navigation sink, URL at arg 0)": "window.open",
  "location.assign(url) redirects in call form (distinct code path from the location.href assignment sink)": "location.assign",
  "history.pushState(state, title, url) navigates an SPA with the URL at the 3rd positional arg": "pushState",
  "importScripts(url) loads a script into a worker context (identifier-call sink, URL at arg 0)": "importScripts",
  // --- relwarc ---
  "$.ajax data object folded to query string": "$.ajax data fold",
  "$.post URL from base-var + literal concat": "$.post concat",
  "$.ajax URL-from-var + data-string query": "$.ajax + query",
  "deep interprocedural taint with shadowing": "Deep taint",
  "interprocedural + path-sensitive call graph": "Interproc graph",
  "$.get params object built by property assignment": "$.get params obj",
  "$.ajax POST with FormData body, literal URL": "$.ajax FormData",
};
let missing = [];
for (const f of ["manifest.json", "relwarc-manifest.json"]) {
  const arr = JSON.parse(fs.readFileSync(f, "utf8"));
  for (const c of arr) {
    if (!(c.category in SHORT)) { missing.push(c.category); continue; }
    c.short = SHORT[c.category];
  }
  fs.writeFileSync(f, JSON.stringify(arr, null, 2) + "\n");
  console.log(`patched ${f} (${arr.length} cases)`);
}
if (missing.length) { console.error("NO SHORT FOR:", missing); process.exit(1); }
console.log("all cases have a short label");
