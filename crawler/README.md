# LyN-X ground-truth crawler + scorer

Reproduces the dynamic ground-truth pipeline from the thesis (§4.2–§4.3, §4.5): a Puppeteer +
CDP crawler that records **initiator chains** for every network request, downloads the referenced
JS so LyN-X and the baselines run on identical inputs, and scores LyN-X against the ground truth.

Lives at `crawler/` in the artifact; the analyzer itself is at `../lynx/`.

Three resumable phases:

1. **crawl.js** — for each domain, attach a raw CDP `Network.requestWillBeSent` listener,
   navigate, wait for `networkidle0` (no UI interaction), and record:
   - **script-initiated** requests (`fetch`/XHR/`import()`/dynamic `<script>`) with the top
     `callFrame` (`url`, `functionName`, `line`, `column`) — links each request to the JS that issued it;
   - **parser/preload-initiated JS asset inclusions** (`resourceType === Script`).
2. **download.js** — collect the JS URLs from the ground truth (loaded script assets + the
   executing initiator scripts), fetch **http+https, redirects followed, 200-OK-only**, and store
   each file once by **content hash** (a library used on 100 sites is downloaded once).
3. **score.js** — run LyN-X over the corpus, then classify each extracted URL against the
   ground truth and compute strict/relaxed P/R/F1 + Discovery Gain / ADG (thesis §4.5).

## Setup
```bash
cd crawler
npm install            # pulls puppeteer (downloads a Chromium build)
(cd ../lynx && npm install)   # LyN-X itself (acorn)
```

## Run
```bash
# Phase 1 — crawl (parallel; resumable). Point at the thesis sample lists in the tool repo:
node crawl.js ../lynx/tests/top_0_200k_sample_2000.txt --browsers 2 --concurrency 8
#   -> out/ground-truth/<domain>.jsonl   (one JSON record per request)
#   -> out/crawl-log.csv                 (domain,status,n_records,n_scripts,error)

# Phase 2 — download the referenced JS (parallel; resumable):
node download.js --concurrency 32
#   -> out/js/<sha1>.js                  (deduped JS corpus for LyN-X + baselines)
#   -> out/js-index.csv                  (url,sha1,bytes,status)

# Phase 3 — run LyN-X + score (per-group breakdown if you pass the sample lists):
node score.js --lists ../lynx/tests/top_0_200k_sample_2000.txt
#   -> out/lynx/<sha1>.json              (cached LyN-X output per JS file; 5s/file timeout)
#   -> out/pairs.csv                     (GT-anchored: domain,group,groundTruthUrl,…,lynxUrl,matchType)
#   -> out/scores.csv                    (per-group + OVERALL: P/R/F1 strict & relaxed, DG, ADG)
```

## Parallelism
`--browsers M` × `--concurrency N` = M·N concurrent page workers over a shared domain queue,
each bound to a browser that is relaunched if it crashes. Start around `2 × 8`; raise for more
cores/RAM (each page ≈ a tab). Download / LyN-X concurrency are independent (`--concurrency`).

## Resumability / accumulation
All phases skip work already recorded (`crawl-log.csv` domains, `js-index.csv` URLs,
`out/lynx/*.json` results), so runs can be interrupted, re-run, or pointed at more lists later,
unioning with prior output. `score.js --rerun-lynx` forces re-analysis.

## Scoring model (§4.3/§4.5)
- Granularity **per domain**: LyN-X's URLs from all JS loaded on a domain vs that domain's
  observed requests ("reconstruct the dependency graph vs the initiator chain").
- Placeholders `{VAR:}`/`{CALL:}`/`{URL_CALL:}` → `(.*?)`, other chars escaped; query strings
  stripped from both sides.
  - **exact** = literal-equal, or regex matches with **same host** → TP (strict & relaxed)
  - **partial** = regex matches but symbolic/different host, or substring → FP strict, TP relaxed
  - **no_match** = regex fails → FP (and counts toward Discovery Gain)
  - **missed** = a GT url no extracted URL matched → FN
- DG = extracted-not-in-GT ÷ |GT|; ADG = concrete-only extracted-not-in-GT ÷ |GT|.
- Note: parser-loaded `<script src>` inclusions are in the GT set, so they count against recall
  even though a JS-only analyzer usually can't recover them — an honest full-graph measure.

## Parameters (match the thesis)
- `--nav-timeout` 10000 ms (page.goto); a nav timeout still keeps requests seen during partial load.
- download `--timeout` 10000 ms per file; redirects followed; 200-OK-only.
  (Thesis restricted to HTTPS; we relax to **http+https** for fuller coverage.)
- LyN-X `--timeout` 5000 ms per file (thesis static-analysis bound).
- `waitUntil: networkidle0`; no clicks/keyboard/forms (reproducibility over interaction coverage).

## Notes / deliberate choices
- Uses a **raw CDP session** (not `HTTPRequest.initiator()`) for reliable access to
  `initiator.stack.callFrames` across Puppeteer versions.
- Requests whose initiator is neither `script` nor a `parser/preload` **Script** inclusion
  (e.g. the top-level document, redirects) are dropped — matching the thesis' two-category model.
- Content-hash dedup means one JS file maps to many domains; `score.js` re-associates via
  `js-index.csv` (url→sha1) joined with the per-domain ground truth, and resolves relative
  extracted URLs against each domain before matching.
- Downloaded JS is third-party/untrusted (and, for the skimmer study, may be malicious):
  static-analyze only, never execute. `out/` is git-ignored.
