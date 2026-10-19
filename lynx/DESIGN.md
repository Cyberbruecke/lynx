# LyN-X v2 — Design & Improvements

LyN-X v2 is a production-oriented wrapper around the LyN-X static URL/endpoint extractor. The core
analysis (Acorn AST + backward taint + abstract interpretation, emitting `{VAR:…}`/`{CALL:…}`
placeholders that chain-resolve to their origin) is unchanged. v2 adds robust real-world input
handling, correct multi-file attribution, relative-URL resolution, security-oriented output, and a
standalone binary.

This document records what v2 does and — more importantly — the **design choices and trade-offs**
behind it, so future changes don't silently regress them.

---

## 1. Input handling

A single positional argument is auto-detected:

- **`.js` file** — analyzed directly.
- **`.html` file** (or content that "looks like" HTML) — scripts extracted (see §3).
- **`https?://…` URL** — fetched, then treated as HTML or JS based on content.

Fetching (`src/fetch.js`) is a portable, dependency-free dual-stack GET: follows redirects, sends a
browser User-Agent, accepts `http` and `https`, decompresses gzip/deflate/br, tolerates relaxed TLS,
and retries. This is the tool's own fetch (distinct from the crawler's bulk downloader).

## 2. Scope model — the concatenation trade-off (important)

HTML pages contain many scripts. How they're combined for analysis directly determines correctness:

- **Inline classic `<script>` blocks are concatenated** (in DOM order) into one program.
  They genuinely share the page's global scope, so a variable defined in one inline block and used
  in another must be resolvable across them.
- **External `<script src>` files, recursed scripts, and ES modules are each analyzed in
  ISOLATION** — their own scope, their own line/column space — but with the page's inline **prelude**
  prepended so they can still resolve genuine page globals (see "Sound cross-script globals" below).

### Why external scripts are isolated (the bug this fixes)

Earlier, *all* classic scripts (inline **and** external) were concatenated into one shared-scope
program. On real pages (e.g. faz.de) this produced **phantom, misattributed results**:

1. **Cross-file variable aliasing.** Minified bundles all reuse short identifiers (`e`, `s`, `t`,
   `a`, `d`). Merged into one scope, a script-injection sink living in one bundle resolved its
   argument against the *union of all same-named definitions across every file*. A single sink in a
   first-party chunk emitted a mix of an unrelated vendor bundle's internal strings **and** the real
   third-party URLs — cartesian nonsense.
2. **Attribution collapse.** Each minified file is a single ~150 KB line, so a sink's line in the
   concatenated buffer landed inside a *different* file's line span and was grouped under the wrong
   file.
3. **Fragile parsing.** One chunk using `import.meta` (valid only in modules) crashed the parse of
   the entire concatenated bundle, zeroing out everything.

Isolating external/recursed/module scripts fixes all three: each is parsed and resolved on its own,
attributed to its own file with correct lines/columns, with no cross-bundle contamination, and a
parse failure is contained to that one file.

### Sound cross-script globals (the inline prelude)

Pure isolation would lose one *legitimate* pattern: a genuine global defined in an inline
`<script>` and read by an external file (e.g. relwarc's `var configUn = {...}` inline, used in
`/static/10.js`). LyN-X recovers this soundly without reintroducing the aliasing above:

- The page's **inline classic code is a "prelude"** that is prepended when analyzing each external /
  module / recursed unit, so the unit can resolve genuine page globals. Only the unit's *own* rows
  are kept (the prelude's sinks were already reported from the inline bundle).
- **Externals are never combined with each other** — each is analyzed alone (+ prelude), so unrelated
  bundles (e.g. swiper vs a first-party chunk) still can't alias each other's variables, and per-file
  line/column attribution is preserved.
- **Scope-aware member resolution** (see below) ensures the prelude only exposes *genuine* globals: an
  inline IIFE-local (`(function(){ var secret = … })()`) does **not** leak into an external reader,
  because member-assignment resolution now respects lexical scope.

What remains unmodeled (accepted): global sharing **between two separate external files** (rare for
URL construction), and an *implicit* global assigned inside a function (`s = {}` with no `var`, read
elsewhere) — the latter stays unresolved (a sound false negative), since LyN-X binds it to the textual
scope. `var`/`let`/`const` globals — the common, hand-written case — resolve correctly.

### Scope-aware member-assignment resolution

Lexical variable scoping was already sound (an IIFE-local `var e` never escaped). The leak was in the
**member-assignment heuristic**: a global name-keyed table (`s.params.url`) plus a property-only
(`.url`) fallback, both scope-blind. Now:

- each member assignment records its lexical `scope`, `base` variable, and whether it is program-scope
  `global`;
- `resolveMemberAssignment` (in-resolution, has the read's scope) only honors an assignment whose base
  variable binds to the **same declaration** as the read's base variable (`bindingScopeId`);
- `resolveVariablePlaceholders` (the post-hoc, scope-less string pass) only draws on assignments to
  program-scope **globals** — never a function/IIFE-local object.

This removes cross-scope false positives (an IIFE-internal `config.url` can no longer resolve an
unrelated `foo.url`) while keeping same-scope and sibling-through-a-global resolution intact. See
`scoping-plan.md` for the full rationale and test matrix.

## 3. HTML script extraction

`src/html.js` splits `<script>`s (dependency-free regex) into **classic** vs **module** buckets in
DOM order, honoring `type` (skips `application/json`, templates, etc.) and `src`. Each extracted
script also carries its **HTML line** so inline results map back to the page's real line numbers.

## 4. Relative-URL resolution

Extracted URLs are often relative (`/api/x`, `foo/bar`, `../y`). They are resolved when a base is
known:

- **URL input** → resolved against the full fetched page URL (handles root-relative,
  directory-relative, and `../` dot-segments).
- **Local file** → resolved against `--origin <host|url>` if provided; otherwise left relative.

Resolution (`resolveRel` in `lyn-x.js`) is:

- **Placeholder-preserving** — `{VAR:…}` are masked with URL-safe tokens so the URL parser can't
  percent-encode the braces, then restored.
- **Conservative** — only root-relative (`/…`, `//…`) and path-structured (contains `/`) refs are
  resolved. Bare tokens (`photo`) and placeholder-anchored refs (`{VAR:base}/x`) are left untouched
  so they stay flagged as non-URL rather than being turned into plausible-looking fake URLs.

Resolution mutates the URL value (so `--raw`/`--json` also get absolutes), and the now-absolute URLs
naturally pick up host coloring. The core additionally handles webpack `varDomains` + root-relative
concat; the CLI layer runs on top and is a no-op on anything already absolute.

## 5. Recursion

`--recurse` fetches every fully-resolved script URL (`.js` / `importScripts`) and analyzes it (in
isolation, §2) to a fixpoint (`--max-depth`, default 3).

**Default is input-dependent:** ON for URL inputs (we're already fetching over the network), OFF for
local HTML/JS files. Override with `--recurse` / `--no-recurse`.

## 6. Output & attribution

Results are **grouped by originating file**. Each group leads with a repeated column header whose
trailing pseudo-column is the source file URL, then a divider, then its rows. The layout is
**terminal-width aware** (`process.stdout.columns`):

- **Known width (interactive):** the divider spans the full window width, and the file URL is
  **right-aligned to the window edge**. If the URL is too long to fit, it falls back to a fixed gap
  after the `URL` header (and wraps).
- **Unknown width (piped/redirected):** the divider uses a content-derived width and the file URL is
  left-placed after `URL` with the same fixed gap — no wasteful right-alignment into a file.

Header lines start with `LINE`, so `grep -v '^LINE'` strips them. Columns:

- **LINE** — line within *that file* (HTML line for inline scripts; file line for externals).
- **COL** — 1-based character offset of the sink within its line. Essential for minified
  single-line files, where every sink shares one line but sits at distinct columns
  (e.g. `loader.min.js` L2 at C3027 / C3458 / C8966).
- **SINK** — the sink kind (see §8).
- **URL** — the extracted URL (colored, §7).

The summary reads `N URL(s) across M files (K with sensitive sources)`.

**Default filtering:** the table and `--raw` show only **real URLs** (templated or fully-resolved) —
non-URL fragments (bare words, `{var}`-only / anchorless placeholders, `javascript:` etc., anything
that would render gray) are hidden. `--all` / `-a` keeps them. The filter is `isUrlLike(url)`.

- **`--raw`** — a flat, deduped list of just the URLs (no headers/grouping), for piping. The `TYPE:`
  prefix is stripped here too (`{VAR:document.cookie}` -> `{document.cookie}`).
- **`--json [file]`** — structured `{file, line, col, sink, url}` rows. **Always the complete export**
  — never filtered by the default/`--all` rule and keeps the full `{TYPE:...}` form, so no data is
  lost for downstream/security analysis.
- **Color is TTY-aware** — auto-disabled when piped/redirected; `--no-color` forces off.

## 7. Color scheme

| Element | Color | Notes |
|---|---|---|
| host (same-site) | green | only when a base host is known (`--origin`/URL) |
| host (external) | orange | registrable-domain heuristic; exact match for IPs/ports |
| literal (in a URL) | white | |
| literal (in a non-URL fragment) | gray | de-emphasized |
| `{var}` | light blue | VAR placeholder; `TYPE:` prefix stripped for display |
| `{call}` | dark blue | CALL / EXCLUDED_CALL / URL_CALL |
| sensitive source | red | overrides blue (see §8) |
| **bold** | — | URL is fully resolved; placeholders inside a real URL are bold too |
| non-bold | — | anchorless / non-URL fragments render non-bold so they read as lower-confidence |

"URL-like" = starts with `http(s)://`, `//`, or `/`. Everything else (bare words, bare filenames,
`javascript:`, anchorless templates like `{VAR:c}1`) is a low-confidence, non-URL extraction and is
rendered gray + non-bold.

Prefix-stripping and coloring are **display-only**; `--raw`/`--json` keep the full `{TYPE:…}` form.

## 8. Sensitive sources

`src/sensitive-sources.js` flags placeholders whose **origin** is a sensitive client-side data
source (LyN-X chain-resolves placeholders to their origin, so this is pure classification — no extra
taint pass). Drives the red highlight and is the foundation for the E9b source→off-origin-sink
detector.

### Matching philosophy (uniform, property-aware)

All sources are matched as **proper dotted segments** — never loose substrings — so
`relocation` / `fullscreen` / `mycookie` / `cookieBanner` never match. Three tiers:

- **Distinctive tokens → flagged on any (aliased) receiver:** `cookie`,
  `localStorage`/`sessionStorage`, `indexedDB`, `clipboardData`, `getSelection`. `x.cookie` is
  almost always `document.cookie` behind a minifier alias, so we flag it.
- **Ambiguous common property names → require the real global parent, anchored at the start of the
  chain:**
  - `document.URL` / `documentURI` / `referrer` / `baseURI` — because `.url` / `.referrer` are
    everyday property names. So `document.URL` and `window.document.url` match, but
    `y.document.url.0`, `config.url`, and `request.referrer` do **not**.
  - `window.name` — because bare `name` (`user.name`, `filename`) is ubiquitous.
  - Trade-off: this misses aliased globals (`w.document.url` where `w=window`); those are rare and
    low-severity (the URL is also sent in Referer anyway), so we accept a small recall loss for far
    fewer false positives.
- **`location` is property-aware:** only URL-bearing members (`location.href` / `.search` / `.hash`)
  and the *global* whole object (`window.location`, `document.location`, bare `location`) are
  flagged — these carry the URL/query/fragment where tokens and PII live. `X.location.href` is
  flagged even behind a minified alias. **NOT flagged:** `location.protocol` / `host` / `hostname` /
  `origin` / `port` (public routing info, commonly used to *build* URLs), and a bare `e.location`
  (ambiguous receiver).
- **Fingerprinting surfaces:** `navigator.*`, `screen.*` (segment-anchored).
- **crypto:** only the secret/entropy members (`getRandomValues` / `randomUUID` / `subtle`), not a
  generic `crypto` token — so `crypto.price` on a finance page doesn't match.

**Removed:** any `.value` read — it over-matched generic property chains like `u.value.id`.
Form-field `.value` exfil for the skimmer study needs a more targeted check (specific field names
like `cardnumber`/`cvv`, not any `.value`).

## 9. Robustness

- **Depth guard** — `resolveExpression` is wrapped with a recursion-depth cap (100) to prevent
  stack overflow on adversarial/obfuscated JS; it degrades to partial results rather than crashing.
  (A legitimate URL rarely needs more than ~30 resolution frames.)
- **Per-unit try/catch** — a parse/analysis failure in one script is logged and skipped, never
  aborting the whole run.

## 10. Build

`build.sh` uses `bun build --compile` to produce a standalone Linux binary (`./lynx`). Bun is
installed into the project venv, not globally. **Rebuild after any source change** — the binary does
not track source edits.

## 11. Known limitations

- Import/export resolution across ES modules is not performed (low payoff, high complexity).
- Inline-script COL is relative to the script body, not the HTML column (inline indentation is not
  added back). External/recursed files — the main use case for COL — are exact.
- Cross-file global sharing between separate files is intentionally not modeled (§2 trade-off).
