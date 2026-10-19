#!/usr/bin/env node
"use strict";
// Summarize a validate_urls url-status cache: EXISTS% (endpoint is real) vs 404/dead, over the tool's OWN
// probed extras. Row = url,status,class,ms,note ; url may contain commas -> class is 3rd field from the end.
const fs = require("fs");
const EXISTS = new Set(["2xx", "3xx", "auth", "method", "5xx", "ratelimited"]);
const ORDER = ["2xx", "3xx", "auth", "method", "5xx", "ratelimited", "404", "dead", "other"];
for (const file of process.argv.slice(2)) {
  const dist = {}; let total = 0, exists = 0;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/).slice(1)) {
    if (!line) continue;
    const p = line.split(","); if (p.length < 5) continue;
    const cls = p[p.length - 3];                     // note, ms, [class]
    dist[cls] = (dist[cls] || 0) + 1; total++; if (EXISTS.has(cls)) exists++;
  }
  const pct = (n) => (100 * n / (total || 1)).toFixed(1) + "%";
  console.log(`\n${file}`);
  console.log(`  probed=${total.toLocaleString()}   EXISTS=${pct(exists)}   404=${pct(dist["404"]||0)}   dead=${pct(dist["dead"]||0)}`);
  console.log("    " + ORDER.filter((c) => dist[c]).map((c) => `${c}:${pct(dist[c])}`).join("  "));
}
