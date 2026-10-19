# SDK-study — reconstruction & precision on API-client bundles with authoritative ground truth

**Goal.** Demonstrate LyN-X's URL-reconstruction edge and precision *cleanly*, on real-world code, with
**authoritative** ground truth. Official API-client SDKs build endpoint URLs by construction
(`baseURL + resource path + path-param interpolation`), and the API's **OpenAPI/Discovery spec is the
canonical list of endpoints**. So we know *exactly* which endpoints exist — no crawl, no host-only labels,
no guessing. This is the dataset gwillem couldn't be: endpoints are almost all **constructed** (not
literals), and the labels are **full path templates** (not just hosts).

## Why this isolates the claim
- **Reconstruction:** SDK endpoints are assembled at runtime (`` `${base}/v1/customers/${id}/subscriptions` ``,
  resource-class path builders, route-string maps). A regex tool recovers fragments (`/v1/customers/`);
  LyN-X reconstructs the full templated path. Recall against spec templates measures exactly this.
- **Precision:** the spec is the *complete* endpoint set, so every tool output that doesn't match a spec
  endpoint is a false positive. Regex's over-grab (DG) is penalized directly; LyN-X's sink-tied output isn't.
- **Coherence:** for matched endpoints, did the tool emit the *whole* path template or a fragment?

## What we measure (per tool, per SDK, and pooled)
- **Recall** = spec endpoints matched by ≥1 tool output / spec endpoints.
- **Precision** = tool outputs matching a spec endpoint / all tool outputs.
- **Coherence / reconstruction depth** = of matched endpoints, fraction where the tool produced the full
  path template vs. a proper fragment.
- Stratified by **construction style** (interpolation / route-map / base+method / generated) so we can show
  *where* reconstruction pays off.

## Ground truth
From each spec: `GT = { method, pathTemplate, fullUrlTemplate }` where `fullUrlTemplate = server.url + path`,
with all path params normalized to a single canonical placeholder `{}`. Tool output is normalized the same
way (`{VAR:…}` → `{}`; a concrete segment in a spec `{param}` position matches too — see matching).

## Matching (the crux — `lib/match_endpoints.js`)
Path-template match, segment by segment:
1. Normalize both sides: split path on `/`; map spec `{param}` and tool `{VAR:…}`/`{CALL:…}` → `{}`.
2. **Literal** segments must match exactly; a spec `{}` matches any single tool segment (concrete or `{}`)
   — a param position accepts any value.
3. Host: SDKs set the base URL from config (a literal); match on the SDK's known base(s) OR score
   **path-only** (host is not the interesting part). Report both; lead with path-template recall.
4. Query strings stripped (consistent with the crawl-corpus scorer).

Tiers, mirroring the main matcher: **exact** (all segments concrete & correct), **templated** (correct
structure with `{}` in param positions), **fragment/weak** (proper substring of a spec path but incomplete),
**miss**.

## Corpus construction — analyze the *realistic* artifact
Real tools see minified/bundled JS, not tidy src. Per SDK we produce and analyze:
- **`dist`** — the published bundle from npm (`main`/`module`/`browser`), or the CDN browser bundle if one
  exists (`stripe.js`, etc.). This is the primary, realistic target.
- **`bundle`** (optional) — for SDKs that ship only ESM/CJS module trees, esbuild/webpack them into one
  browser-like file so the tools face a single realistic artifact.
- **`src`** (secondary) — the readable source, to report a src-vs-dist delta (does minification hurt LyN-X?).

## Fairness caveats (document in the paper)
- **Spec ⊋ SDK.** A spec may list endpoints the SDK build doesn't implement (deprecated/beta). Two GT
  variants: (a) *full spec* (strict, some endpoints unreachable → caps everyone equally), (b) *reachable*
  = spec endpoints whose literal path segments appear somewhere in the SDK JS (a coverage proxy). Report (a)
  as headline, (b) as the "of endpoints actually in the code" view.
- **Irrecoverably dynamic endpoints.** Some SDKs build paths fully from runtime data (a resource name in a
  variable with no literal anchor). No static tool can get these; count them and report the ceiling.
- **Generated vs hand-written.** Generated SDKs (regular, spec-shaped) may be "easy"; hand-written ones
  (interpolation, route maps) are the interesting cases. Keep both; stratify.
- **Base URL.** Provided as a host hint per SDK (like `compare.js --domain`) OR measured path-only.

## Deployment / popularity (why these SDKs matter in the wild)
Two enrichment signals, written to `deployment.json` by `enrich_deployment.js`:
- **npm downloads/month** — universal, free, no auth (`api.npmjs.org`); ranks *all* SDKs (server + browser).
- **web adoption** — for the browser-detectable subset only (SDKs with a `wappalyzer` tag in `sdks.json`),
  joined from an **HTTP-Archive Technology-Report / Wappalyzer** CSV via `--webcsv`. BuiltWith's aggregate
  counts sit behind their product; HTTP Archive (which runs Wappalyzer over millions of sites) is the
  reproducible, citable free equivalent. Export the tech report, pass the CSV, and it joins by technology name.

Selection is motivated by: official + on npm, **public machine-readable spec**, and — preferentially —
**generated by Stainless/Speakeasy/Fern/openapi-generator** so the spec↔code correspondence is *guaranteed*
(the `spec ⊋ SDK` caveat disappears). The manifest spans 18 construction styles and payments/dev-tools/comms/
cloud/identity/AI/commerce/fintech categories; `wappalyzer`-tagged rows are the ones detectable on the web.

## Directory layout
```
sdk-study/
  README.md                 # this plan
  sdks.json                 # curated SDK manifest (~42: source + spec + base + style + wappalyzer)
  fetch_sdks.js             # download each SDK's pkg (npm pack) + spec (github file/dir/array, https) [+ --bundle]
  extract_groundtruth.js    # spec(s) -> gt/<name>.jsonl  (merges multi-file specs)
  enrich_deployment.js      # npm downloads (+ optional --webcsv web adoption) -> deployment.json
  sdk_eval.js               # run BASE_TOOLS over each SDK's JS -> match vs GT -> results/*
  lib/
    openapi.js              # OpenAPI3 + Swagger2 + Google-Discovery -> endpoint templates (servers, $ref, params)
    match_endpoints.js      # segment-wise path-template matcher + tiers
  out/sdk/<name>/           # {pkg/, dist.js?, spec.json | spec-parts/*}
  gt/<name>.jsonl           # ground-truth endpoint templates
  deployment.json           # npm + web-adoption per SDK
  results/                  # sdk-recall.csv, sdk-by-style.csv, sdk-detail.csv, figures
```
Reuses `../crawler/lib/tools` (`BASE_TOOLS`: linkfinder, jsluice, relwarc, lynx
obfuscated). Specs may be OpenAPI3, **Swagger 2.0**, or Google Discovery; an SDK's API may be split across
**multiple spec files** (`spec-parts/`, merged automatically).

## Phased plan
- **P0 — curation.** Finalize `sdks.json`: ~15–20 official SDKs with public specs, spanning construction
  styles and sizes. (Draft manifest committed; verify each spec URL + base in P1.)
- **P1 — fetch.** `fetch_sdks.js`: pull each SDK's dist bundle (npm tarball `main`/`browser`, or CDN) and
  its spec (repo raw URL). Cache under `out/sdk/<name>/`. Record resolved versions + spec commit.
- **P2 — ground truth.** `extract_groundtruth.js` + `lib/openapi.js`: specs → `gt/<name>.jsonl`. Handle
  OpenAPI3 (`servers`, `paths`, `$ref`) and Google Discovery (`baseUrl`, `resources[].methods[].path`).
- **P3 — matcher.** `lib/match_endpoints.js`: segment-wise template match + tiers. **Unit-test first** with
  a synthetic spec + crafted tool outputs (sandbox-testable, no network).
- **P4 — bundling (optional).** `build_bundles.js` for module-tree-only SDKs.
- **P5 — eval.** `sdk_eval.js`: BASE_TOOLS over each SDK's JS → match → `results/` (recall, precision,
  coherence, per-style). Same runner shape as `skimmer_eval.js`.
- **P6 — analysis.** Figures: recall/precision per tool (pooled + per style), src-vs-dist delta, and a
  reconstruction-depth stacked bar. Caveat table (dynamic-endpoint ceiling, spec⊋SDK).

## Selection criteria (for adding SDKs)
Official + widely used · public OpenAPI/Discovery spec · JS/TS client · a resolvable dist/bundle ·
construction style noted. Prefer a mix of hand-written (interpolation/route-map) and generated (spec-shaped),
and a size range (small hand-written → large generated).
