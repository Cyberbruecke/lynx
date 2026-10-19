"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ensureDir = (d) => fs.mkdirSync(d, { recursive: true });
const sha1 = (buf) => crypto.createHash("sha1").update(buf).digest("hex");
const sanitize = (s) => s.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);

function readDomains(paths) {
  const out = [];
  for (const p of paths) {
    for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
      const d = line.trim();
      if (d && !d.startsWith("#")) out.push(d);
    }
  }
  return out;
}

function writeJsonl(file, records) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join("\n") + (records.length ? "\n" : ""));
}

const csvCell = (v) => {
  v = v == null ? "" : String(v);
  return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
};

// Shared appender. Node is single-threaded and writeSync of one full line is
// atomic w.r.t. other synchronous writes, so concurrent workers won't interleave.
// truncate=true overwrites the file (fresh header) — use it for full per-run dumps (scores tables) so
// re-runs REPLACE rather than STACK. Without it, "a" appends and successive runs pile up duplicate rows.
function csvAppender(file, header, truncate = false) {
  ensureDir(path.dirname(file));
  const fresh = truncate || !fs.existsSync(file) || fs.statSync(file).size === 0;
  const fd = fs.openSync(file, truncate ? "w" : "a");
  if (fresh) fs.writeSync(fd, header.join(",") + "\n");
  return {
    row: (vals) => fs.writeSync(fd, vals.map(csvCell).join(",") + "\n"),
    close: () => fs.closeSync(fd),
  };
}

// Parse the first CSV field, honoring RFC-4180 quoting (a quoted field may contain
// commas and "" escapes) — needed because URLs can contain commas.
function firstField(line) {
  if (line[0] !== '"') return line.split(",")[0];
  let out = "", i = 1;
  while (i < line.length) {
    const c = line[i];
    if (c === '"') {
      if (line[i + 1] === '"') { out += '"'; i += 2; } else break;
    } else { out += c; i++; }
  }
  return out;
}

// first-column set from an existing CSV (for resumability / union runs)
function loadDoneKeys(file) {
  const set = new Set();
  if (!fs.existsSync(file)) return set;
  for (const l of fs.readFileSync(file, "utf8").split(/\r?\n/).slice(1)) {
    if (!l) continue;
    const k = firstField(l);
    if (k) set.add(k);
  }
  return set;
}

// Concurrency pool. `slots` (optional) is an array of per-worker resources
// (e.g. browser handles); its length sets the worker count. Otherwise `concurrency`.
async function runPool(items, worker, { concurrency = 8, slots = null } = {}) {
  let i = 0;
  const n = slots ? slots.length : concurrency;
  const loop = async (slot) => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) break;
      await worker(items[idx], idx, slot);
    }
  };
  await Promise.all(Array.from({ length: n }, (_, k) => loop(slots ? slots[k] : null)));
}

module.exports = { ensureDir, sha1, sanitize, readDomains, writeJsonl, csvCell, csvAppender, loadDoneKeys, runPool };
