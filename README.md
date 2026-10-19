# LyN-X: Static Endpoint Reconstruction From JavaScript — Research Artifact

LyN-X is a purely static analyzer that reconstructs request URLs from JavaScript by anchoring to
network and resource-loading sinks and tracing data flow backward through abstract interpretation.
This artifact contains the tool, the three evaluations in the paper (synthetic capability benchmark,
JavaScript SDKs, dynamic crawl corpus), the capability ablation, and the cached intermediate data
needed to reproduce every table and figure without re-running any tool.

## Layout

```
lynx/              the analyzer (Node, single dependency: acorn)
crawler/           dynamic crawl collection + all crawl-corpus analyses
benchmark/         54 synthetic capability test cases + harness + figure scripts
sdk-study/         31 JavaScript SDKs evaluated against their OpenAPI specs
ablation-study/    leave-one-out capability ablation (instrumented LyN-X copy)
security-study/    tracker-blocklist cross-reference
relwarc/           vendored Relwarc baseline
results/           derived tables and the paper's figures
data/              compressed intermediates (see unpack.sh)
```

## Prerequisites

| | Version | Notes |
|---|---|---|
| Node.js | 22 | runs LyN-X and all analysis scripts |
| Python | 3.12 + `matplotlib`, `numpy`, `matplotlib-venn` | figure generation |
| zstd, tar | any | unpacking `data/` |
| Bun | 1.x | only for the ablation study and the standalone binary build |
| LinkFinder | `pip install linkfinder` | baseline, invoked as `python -m linkfinder` |
| JSluice | `go install github.com/BishopFox/jsluice/cmd/jsluice@latest` | baseline, must be on `PATH` |
| Relwarc | vendored in `relwarc/`, `npm install && npm run build` | baseline |

The baselines are only needed to *re-run* extraction. Every number in the paper can be reproduced
from the cached tool outputs in `data/` with Node and Python alone.

```bash
./unpack.sh                       # expand data/ into the expected layout
(cd lynx && npm install)          # acorn
(cd crawler && npm install)       # puppeteer + js-beautify (only for re-collection)
(cd relwarc && npm install && npm run build)   # baseline (only to re-run extraction)
```

---

## 1. Build and run LyN-X

```bash
cd lynx
npm install                                   # acorn, the only dependency
node lyn-x.js path/to/file.js                 # table output
node lyn-x.js path/to/file.js --raw           # one URL per line
node lyn-x.js page.html --recurse             # follow <script src> and analyze each
node lyn-x.js https://example.com/app.js      # fetch and analyze
node lyn-x.js file.js --json out.json         # machine-readable
node lyn-x.js --help                          # all options (budgets, placeholders, AST dump)
```

Unresolved runtime values are emitted as `{VAR:name}` / `{CALL:name}` placeholders, so a
reconstructed template keeps its full URL shape rather than collapsing to a fragment.

Optional standalone binary (bundles the Node runtime; needs Bun):

```bash
./build.sh            # -> ./lynx, runnable with no Node install
```

---

## 2. Reproduce the evaluations and figures

All of these read the cached tool outputs unpacked by `./unpack.sh`. None re-runs a tool.

### Capability benchmark (Table 2)

```bash
cd benchmark
node bench.js --manifest manifest.json,relwarc-manifest.json
#   -> results/benchmark-results.txt, success-table.tex, tier-counts.json, bench-*.csv
```

### JavaScript SDKs (Table 3)

```bash
cd sdk-study
node sdk_eval.js                 # -> sdk-study/results/sdk-{recall,detail,by-style,by-group}.csv
node make_sdk_table.js           # -> sdk-study/results/sdk-eval-table.tex
```

`make_sdk_table.js` runs off the shipped `sdk-study/results/sdk-recall.csv` and reproduces the table
directly. `sdk_eval.js` re-runs extraction and needs the SDK sources, which are not shipped (1.5 GB);
install them at the versions pinned in each `sdk-study/out/sdk/<name>/package.json`:

```bash
for d in sdk-study/out/sdk/*/; do (cd "$d" && npm install --silent); done
```

Without them `sdk_eval.js` refuses to run rather than overwriting the shipped CSVs with zeros.

### Dynamic crawl corpus (Table 5, Table 6, Figures 2-5)

```bash
cd crawler
node compare.js                  # per-tool P/R/F1, coherence, tier counts
#   -> results/compare-{scores.csv,scores.tex,results.txt,tiers.json}, coverage-<tool>.txt, perf-<tool>.csv

node ar_table.js --limit 100000  # per-tool recall + CAR/TAR additional recoveries
node union_tiers.js              # union recall at strict/medium/relaxed (the Union row + Figure 2)
node union_recovery.js           # per-tool unique vs shared split  -> results/union-recovery.json
node union_additional.js         # union CAR/TAR
node query_shape.js              # full-shape query recovery (Table 6)
node query_keys.js               # per-key query coverage
```

`ar_table.js` defaults to `--limit 100000` (the full crawl log, 54,405 scored domains). Passing a
smaller limit scores a subset and yields proportionally smaller counts.

### Validation of additional recoveries

```bash
cd crawler
node summarize_probes.js ../results/url-status-lynx-extra.csv ../results/url-status-linkfinder-extra.csv
node categorize_templated.js     # templated-extra categories -> results/templated-extras-categories.json
node hashfilter.js               # content-hash filename filter selection
```

Re-probing the live web (optional, slow, and results drift as sites change):

```bash
node validate_urls.js --tool lynx --only-extra --sample 200000 --concurrency 32
node validate_templated.js --tool lynx --per-cat 15000
```

### Blocklist cross-reference

```bash
cd security-study
node tracker_xref.js             # -> results/tracker-xref.csv, tracker-beyond-dynamic.csv
```

### Capability ablation (Figures 6, 7)

The shipped `ablation-study/data/*.eval.json` already drives both figures. To recompute from
scratch you need the JS corpus (see section 3); the three stages are:

```bash
cd ablation-study/lynx-ablated && npm install && cd ..   # acorn, for the instrumented copy
bun extract_targets.js --corpus crawl
bun run_ablation.js    --corpus crawl --concurrency 8
bun evaluate.js        --corpus crawl
```

### Figures

```bash
python3 benchmark/make_figures.py results     # coherence, arity, arity-by-recoverability, tier bars, perf
python3 crawler/make_gt_static_venn.py        # Figure 2: dynamic vs static recovery
python3 crawler/make_union_bar.py             # Figure 4: unique vs shared recovery
python3 results/make_perf_size.py             # processing time vs file size
python3 ablation-study/make_ablation_bars.py  # Figure 6
python3 ablation-study/make_ablation_cdf.py   # Figure 7
```

`make_figures.py` skips any figure whose input table is absent, so it is safe to run on a partial
unpack.

---

## 3. Re-running the data collection

The 132,646-script corpus (`crawler/out/js/`, ~9 GB) is **not** part of this artifact. Analyses that
need only to know *which* scripts were in the corpus fall back automatically to the cached per-tool
outputs and print a one-line note. Analyses that need the script bodies — `allmiss_locality.js`,
`regex_only_locality.js`, `regex_only_reasons.js`, `relwarc_unique_probe.js`,
`relwarc_unique_categorize.js`, `arity_hist.js`, `failure_buckets.js`, `compare.js` phase A,
`score.js`, and the ablation — exit with a message telling you so.

To rebuild the corpus from scratch:

```bash
cd crawler
npm install

# Phase 1 — sample Tranco and crawl. The five 20K rank strata used in the paper are shipped as
# tranco-sample_{0-200,200-400,400-600,600-800,800-1000}.lst (Tranco list 94VW2).
# ./dl_tranco.sh && ./sample_tranco.sh   regenerates them from a fresh list.
node crawl.js tranco-sample_0-200.lst --browsers 2 --concurrency 8
#   -> out/ground-truth/<domain>.jsonl, out/crawl-log.csv

# Phase 2 — download every referenced script, deduplicated by content hash
node download.js --concurrency 32
#   -> out/js/<sha1>.js, out/js-index.csv

# Phase 3 — run all four extractors over the corpus (this is what data/tools-*.tar.zst caches)
node compare.js --rerun
```

All phases are resumable and skip work already recorded.

**Reproducibility caveat.** The crawl is a single snapshot of the live Web taken for the paper.
Re-crawling now will not reproduce the same corpus: sites change, scripts are rebuilt with new
content hashes, and domains disappear. This is why the ground truth and the cached tool outputs are
shipped in `data/` — they are the reproducible substrate for every number in the paper. Treat
re-collection as a way to run the pipeline on fresh data, not as a way to regenerate these results.

The live-probe validation in section 2 carries the same caveat and drifts faster: content-hashed
build artifacts rotate within days of a deploy.

---

## Notes

- `lynx/` is the version evaluated in the paper. The browser-cookie import we experimented with for
  authenticated fetching is not part of it.
- `relwarc/` is vendored at the commit used for the paper so the baseline is reproducible.
- `data/tools-<tool>.tar.zst` holds one JSON file per analyzed script per tool. These are the
  extraction outputs the whole crawl evaluation is scored from.
