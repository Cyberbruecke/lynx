# Ablation study — how are constructed URLs built in the real world?

Takes the set of URLs **only LyN-X recovers** (constructed endpoints with no literal form that neither
LinkFinder nor JSluice finds), and — by selectively disabling one LyN-X capability at a time — measures
**which capability each URL actually required** to be recovered. The result is a taxonomy of real-world
URL-construction techniques, weighted by prevalence, on both the crawl corpus and the SDK corpus.

Method: **capability necessity by leave-one-out ablation.** An endpoint *requires* capability `C` iff
LyN-X recovers it at baseline but no longer recovers it (drops below the templated match tier) when `C`
alone is disabled. Recovery is judged at the same host+path tier used everywhere else, so a cosmetic
string change (e.g. a dropped query param) doesn't count as a loss.

## The 13 capability buckets

Defined once in `lynx-ablated/src/core/ablation.js` (the `IDS` list) — the harness and the gates share it.

| id | capability |
|----|------------|
| `template` | backtick `` `...${}` `` template-literal assembly |
| `concat` | string concatenation: binary `+` and `String.prototype.concat` |
| `member` | member/property resolution: object-literal deep props, computed access, config objects, member-assignment (webpack public path `l.p = "/static/"`) |
| `interproc` | interprocedural function-return tracing (a URL returned by a called function) |
| `iteration` | loop / collection reconstruction: `for`/`for-of`/counted-loop unroll, `.map`/`.filter`/`.reduce`, and `forEach`-style callback element binding |
| `array_join` | array assembly: `[..].join(sep)` and `split().reverse().join()` char-array (re)assembly |
| `atob` | base64 decoding (`atob` / `window.atob`) |
| `fromCharCode` | `String.fromCharCode` char-code decoding |
| `str_transform` | string folding: `toLowerCase`/`toUpperCase`/`trim*`/`slice`/`substring`/`substr`/`normalize` |
| `str_replace` | `String.replace` / `replaceAll` literal-pattern substitution |
| `new_url` | `new URL(relative, base)` resolution |
| `query_params` | query-string assembly: `new URLSearchParams(obj)` and `entries.toString()` |
| `promise` | Promise `.then`/`.catch`/`.finally` callback-return tracing |

Excluded by design: lexical **scope indexing** (foundational — disabling it breaks everything, not a
recovery technique) and **scope-filtering** (a soundness/precision feature that removes false positives,
it never *adds* a URL).

## How the ablation is wired

`lynx-ablated/` is an **isolated copy** of `lynx/` (never the production tree). It adds
`src/core/ablation.js`, which reads a comma-separated list of disabled ids from the `LYNX_ABLATE` env
var **once at load**. Each capability's dispatch point in `resolve.js` / `runtime.js` / `analyze.js` is
guarded by a one-line `if (ablated("<id>"))` that degrades just that capability to a placeholder or
passthrough. With `LYNX_ABLATE` unset (the default), every gate is a no-op and the copy behaves
byte-for-byte like stock LyN-X — verified by reproducing every cached baseline URL.

Several capabilities have code in **both** the static resolver and the runtime interpreter (sink emission
is static, but loop/collection-bound values come from the interpreter), so those are gated in both paths.
A few (`atob`, `fromCharCode`, `array_join`, `new_url`) are static-only.

## Pipeline

```bash
export PATH="$HOME/.bun/bin:$PATH"   # bun runtime

# 1. Extract the LyN-X-only constructed-URL targets + their source files (reads the cached tool outputs
#    in crawler/out/tools/<tool>/<sha>.json; re-runs nothing). --limit N samples the first N domains.
bun extract_targets.js --corpus crawl                 # -> data/targets-crawl.{jsonl,files.json,summary.json}

# 2. Run baseline + 13 single-capability ablations per target file; attribute necessity per endpoint.
bun run_ablation.js  --corpus crawl --concurrency 8   # -> data/ablation-crawl.{jsonl,runlog.json}
#   (--limit-files N to pilot a subset)

# 3. Aggregate into the headline tables.
bun evaluate.js      --corpus crawl                    # -> data/ablation-crawl.{capabilities.csv,eval.json,summary.txt}
```

**SDK corpus** — same three stages, `--corpus sdk`. The LyN-X-only endpoints are read from the existing
`sdk-study/results/sdk-detail.csv` (per-endpoint tier per tool, from the full SDK run), so the regex
baselines are not re-run; LyN-X is re-run over each SDK's bundle with the SDK's configured `--base`. The
unit is an `(sdk, endpoint)` pair recovered over the SDK's whole file set (matching `sdk_eval.js`), not a
single file+string.

```bash
bun extract_targets_sdk.js                             # -> data/targets-sdk.{jsonl,files.json,summary.json}
bun run_ablation.js  --corpus sdk --concurrency 8      # -> data/ablation-sdk.{jsonl,runlog.json}
bun evaluate.js      --corpus sdk                      # -> data/ablation-sdk.{capabilities.csv,eval.json,summary.txt}
```

Cost: one target file is analyzed `1 + 13` times. On the pilot slice, ~0.3 s per LyN-X run
(bun startup + analysis) at concurrency 8; the full crawl corpus is a few thousand files ⇒ a few hours.
It is fully restart-safe to re-run per stage.

## Output

- `data/targets-<corpus>.jsonl` — one target per line: `{sha, raw, resolved, gt, domain, tier, arity, sink}`.
- `data/ablation-<corpus>.jsonl` — per endpoint: `{sha, gt, domain, sink, arity, tier, baselineOk, necessary:[caps]}`.
- `data/ablation-<corpus>.capabilities.csv` — `capability, required, pct_required, sole_required, pct_sole`.
- `data/ablation-<corpus>.summary.txt` — human tables (per-capability necessity, capabilities-per-endpoint
  histogram, top co-required pairs, breakdown by sink type).

### Reading the numbers

- **required / %required** — endpoints for which the capability is necessary, *including* those that also
  need others. A loop of template-literal URLs needs **both** `iteration` and `template`, so it counts
  under each. Percentages therefore sum to more than 100%.
- **sole / %sole** — endpoints that hinge on that capability *alone* (it is the single point of failure).
- **capabilities-per-endpoint** — most constructed endpoints need ≥2 capabilities (e.g. a function returns
  a base — `interproc` — that is then concatenated with a path — `concat`).
- **0-capability endpoints** are split into single-fragment **literals** (arity 1 — LyN-X-only because of
  *sink coverage*, not construction) and multi-fragment **combination-only** cases (arity ≥ 2 — recoverable
  via a substitutable path, or lost only to a combination the leave-one-out sweep can't attribute to one).

## Layout

```
ablation-study/
  README.md
  extract_targets.js      # crawl-corpus target derivation (reads cached tool outputs)
  extract_targets_sdk.js  # SDK-corpus target derivation (reads sdk-detail.csv; re-runs LyN-X only)
  run_ablation.js         # baseline + per-capability ablation runs, necessity attribution (both corpora)
  evaluate.js             # aggregation -> CSV + summary (corpus-agnostic)
  lynx-ablated/           # isolated, instrumented copy of lynx (LYNX_ABLATE gates)
  data/                   # all generated artifacts
```
