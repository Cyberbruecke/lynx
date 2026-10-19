#!/usr/bin/env python3
"""Figures for the LyN-X evaluations. Usage: make_figures.py <results-dir>

Draws whatever inputs are present in <results-dir>:
  tier-counts.json        -> tier-stacked-bar.{pdf,png}   (benchmark: per-case best tier)
  compare-tiers.json      -> corpus-tiers.{pdf,png}       (crawl corpus: GT endpoints by best tier)
  coverage-*.txt          -> coherence-hist.{pdf,png}     (crawl corpus: single-string coverage of a
                                                           matched endpoint — LyN-X clusters near 1.0
                                                           (one coherent string); regex tools spread low)
  codeql-sinks-axis.json  -> codeql-coverage.{pdf,png}    (sink axis: shared / CodeQL-only / LyN-X-only)
                             codeql-resolution.{pdf,png}  (sink axis: URL resolution of shared sinks)
"""
import json
import sys
import os
import glob
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

TIER_COLOR = {"exact": "#2ca02c", "templated": "#1f77b4", "weak": "#ff7f0e", "miss": "#c7c7c7"}
TIER_LABEL = {"exact": "exact", "templated": "templated", "weak": "weak fragment", "miss": "miss"}
DISPLAY = {"grep": "grep", "linkfinder": "LinkFinder", "jsluice": "JSluice", "relwarc": "relwarc", "lynx": "LyN-X"}


def _save(fig, out_base):
    """Write a figure to <out_base>.pdf and .png, then close it."""
    for ext in ("pdf", "png"):
        out = f"{out_base}.{ext}"
        fig.savefig(out, bbox_inches="tight", dpi=150)
        print(f"[*] wrote {out}")
    plt.close(fig)


def stacked_bar(json_path, out_base, xlabel):
    with open(json_path) as f:
        d = json.load(f)
    tools, tiers, counts = d["tools"], d["tiers"], d["counts"]
    fig, ax = plt.subplots(figsize=(7, 0.7 * len(tools) + 1.2))
    left = [0] * len(tools)
    for tier in tiers:
        vals = [counts[t].get(tier, 0) for t in tools]
        ax.barh(tools, vals, left=left, color=TIER_COLOR.get(tier, "#999"),
                label=TIER_LABEL.get(tier, tier), edgecolor="white", height=0.6)
        left = [l + v for l, v in zip(left, vals)]
    ax.set_xlabel(xlabel)
    ax.set_xlim(0, max(left) if left else 1)
    ax.invert_yaxis()
    ax.legend(ncol=len(tiers), loc="lower center", bbox_to_anchor=(0.5, 1.01), frameon=False)
    ax.spines[["top", "right"]].set_visible(False)
    fig.tight_layout()
    _save(fig, out_base)


# Canonical per-tool palette — used for EVERY chart where a tool is a distinct series, so a tool keeps one
# color throughout. LyN-X = green (matches the capability matrix / SDK heatmap). Keep in sync with the copy
# in crawler/make_union_bar.py.
TOOL_COLOR = {"linkfinder": "#1E5AA8", "jsluice": "#E8A200", "relwarc": "#9467BD", "lynx": "#137333"}
TOOL_ORDER = ["linkfinder", "jsluice", "relwarc", "lynx"]


def coherence_hist(results_dir):
    # Grouped side-by-side bars: coverage bucketed into 5 ranges; one bar per tool per bucket, each tool
    # normalized to its OWN matched-string count (bars per tool sum to 1). Overlapping step outlines were
    # hard to read; grouped bars make the LyN-X-clusters-at-1.0 vs regex-spread-low contrast obvious.
    files = sorted(glob.glob(os.path.join(results_dir, "coverage-*.txt")))
    if not files:
        return
    step = 0.1
    labels = [f"{i*step:.1f}" for i in range(10)]           # simple boundary labels: 0.0, 0.1, ... 0.9
    nb = len(labels)

    def bucketize(vals):
        counts = [0] * nb
        for v in vals:
            if v <= 0:
                counts[0] += 1
                continue
            b = min(nb - 1, int(v / step - 1e-9) if v < 1.0 else nb - 1)  # 1.0 -> last bucket
            counts[b] += 1
        tot = sum(counts) or 1
        return [c / tot for c in counts]

    series = []  # (tool, fractions)
    present = {os.path.basename(f)[len("coverage-"):-len(".txt")]: f for f in files}
    for tool in TOOL_ORDER + [t for t in present if t not in TOOL_ORDER]:
        f = present.get(tool)
        if not f:
            continue
        vals = [float(x) for x in open(f).read().split() if x.strip()]
        if not vals:
            continue
        series.append((tool, bucketize(vals)))
    if not series:
        return

    n = len(series)
    w = 0.8 / n
    x = list(range(nb))
    fig, ax = plt.subplots(figsize=(11, 4.6))
    for i, (tool, fr) in enumerate(series):
        offs = [xi + (i - (n - 1) / 2) * w for xi in x]
        ax.bar(offs, [v * 100 for v in fr], width=w, color=TOOL_COLOR.get(tool, None),
               label=DISPLAY.get(tool, tool), edgecolor="white", linewidth=0.5)
    ax.set_xticks(x)
    ax.set_xticklabels(labels)
    ax.set_xlabel("coverage of matched ground-truth endpoint", fontsize=24)
    ax.set_ylabel("% matching output strings", fontsize=24)
    ax.tick_params(labelsize=21)
    ax.legend(frameon=False, fontsize=21)
    ax.grid(axis="y", linewidth=0.4, alpha=0.4)
    ax.set_axisbelow(True)
    ax.spines[["top", "right"]].set_visible(False)
    fig.tight_layout()
    _save(fig, os.path.join(results_dir, "coherence-hist"))


def sink_axis(results_dir):
    """CodeQL vs LyN-X sink-discovery axis: a coverage bar + a resolution-of-shared-sinks bar."""
    p = os.path.join(results_dir, "codeql-sinks-axis.json")
    if not os.path.exists(p):
        return
    with open(p) as f:
        d = json.load(f)
    cov = d["coverage"]

    # (1) coverage: one stacked bar — CodeQL-only | shared | LyN-X-only
    fig, ax = plt.subplots(figsize=(7, 1.8))
    segs = [("CodeQL-only", cov["codeql_only"], "#d62728"),
            ("shared", cov["shared"], "#2ca02c"),
            ("LyN-X-only", cov["lynx_only"], "#1f77b4")]
    left = 0
    for label, val, color in segs:
        ax.barh([0], [val], left=left, color=color, label=f"{label} ({val})", edgecolor="white", height=0.5)
        left += val
    ax.set_yticks([])
    ax.set_xlabel("network sinks")
    ax.set_xlim(0, max(left, 1))
    ax.legend(ncol=3, loc="lower center", bbox_to_anchor=(0.5, 1.01), frameon=False)
    ax.spines[["top", "right", "left"]].set_visible(False)
    fig.tight_layout()
    _save(fig, os.path.join(results_dir, "codeql-coverage"))

    # (2) resolution of the SHARED sinks: CodeQL (concrete|unresolved) vs LyN-X (concrete|templated|unresolved)
    res = d["resolution"]
    if cov["shared"]:
        tools = ["CodeQL", "LyN-X"]
        order = [("concrete", "#2ca02c"), ("templated", "#1f77b4"), ("unresolved", "#c7c7c7")]
        fig, ax = plt.subplots(figsize=(7, 2.2))
        left = [0, 0]
        for tier, color in order:
            vals = [res["codeql"].get(tier, 0), res["lynx"].get(tier, 0)]
            ax.barh(tools, vals, left=left, color=color, label=tier, edgecolor="white", height=0.55)
            left = [l + v for l, v in zip(left, vals)]
        ax.set_xlabel(f"URL resolution among {cov['shared']} shared sinks")
        ax.set_xlim(0, max(left) if left else 1)
        ax.invert_yaxis()
        ax.legend(ncol=3, loc="lower center", bbox_to_anchor=(0.5, 1.01), frameon=False)
        ax.spines[["top", "right"]].set_visible(False)
        fig.tight_layout()
        _save(fig, os.path.join(results_dir, "codeql-resolution"))


def venn_diagram(results_dir):
    """3-set Venn of GT endpoints DISCOVERED (best tier exact|templated) by LinkFinder / JSluice / LyN-X.
    Reads compare-venn.json (written by compare.js). The LyN-X-only lobe = endpoints only the data-flow
    tool recovers (constructed at runtime, no literal for a regex to find); the regex-union-only region =
    what LyN-X's sink model misses (mostly third-party static beacons). Needs matplotlib-venn."""
    p = os.path.join(results_dir, "compare-venn.json")
    if not os.path.exists(p):
        return
    try:
        from matplotlib_venn import venn3, venn3_circles
    except ImportError:
        print("[!] matplotlib-venn not installed (pip install matplotlib-venn); skipping venn figure")
        return
    with open(p) as f:
        d = json.load(f)
    subs = tuple(d["venn3_pathlevel"]["subsets"])          # Abc,aBc,ABc,abC,AbC,aBC,ABC (A=LF,B=JS,C=LX)
    labels = tuple(d["sets"])
    fig, ax = plt.subplots(figsize=(7, 6))
    v = venn3(subsets=subs, set_labels=labels, ax=ax,                 # A=LinkFinder, B=JSluice, C=LyN-X
              set_colors=(TOOL_COLOR["linkfinder"], TOOL_COLOR["jsluice"], TOOL_COLOR["lynx"]), alpha=0.45)
    venn3_circles(subsets=subs, ax=ax, linewidth=0.8)
    for t in (v.set_labels or []):
        if t: t.set_fontsize(12)
    for t in (v.subset_labels or []):
        if t: t.set_fontsize(10)
    lx = d.get("lynx_only", {})
    reg = d.get("regex_only", {})
    cap = (f"Discovered = best tier exact|templated among {d['total_gt']:,} GT endpoints "
           f"({d.get('gt_third_party',0)/max(1,d['total_gt'])*100:.0f}% third-party).\n"
           f"LyN-X-only {lx.get('n',0):,} ({lx.get('templated',0)/max(1,lx.get('n',1))*100:.0f}% templated = constructed) | "
           f"regex-only {reg.get('n',0):,} ({reg.get('third_party',0)/max(1,reg.get('n',1))*100:.0f}% third-party).")
    ax.set_title("Endpoints discovered: constructed (LyN-X) vs regex-recoverable", fontsize=12)
    fig.text(0.5, 0.02, cap, ha="center", fontsize=8.5, color="#333")
    fig.subplots_adjust(bottom=0.16)
    _save(fig, os.path.join(results_dir, "compare-venn"))


def arity_hist(results_dir):
    """Construction-arity histogram: # source fragments each LyN-X URL is assembled from (arity-hist.json,
    written by arity_hist.js). Arity>=2 = URLs a regex tool would only see as disconnected fragments."""
    p = os.path.join(results_dir, "arity-hist.json")
    if not os.path.exists(p):
        return
    with open(p) as f:
        d = json.load(f)
    hist = d.get("hist", {})
    if not hist:
        return
    CAP = 10                                                   # fold the long tail into a "10+" bucket
    buckets = {}
    for k in hist:
        step = int(k) - 1                                      # arity counts fragments (leaf=1); as ASSEMBLY STEPS a
        b = min(step, CAP)                                     # literal is 0 and an N-fragment concat is N-1 steps
        buckets[b] = buckets.get(b, 0) + hist[k]
    labels = [str(b) if b < CAP else f"{CAP}+" for b in sorted(buckets)]
    counts = [buckets[b] for b in sorted(buckets)]
    tot = sum(counts) or 1
    vals = [100 * c / tot for c in counts]                     # as % of endpoints
    fig, ax = plt.subplots(figsize=(7, 4.1))
    ax.bar(labels, vals, color=TOOL_COLOR["lynx"], edgecolor="white")
    ax.set_xlabel("construction steps", fontsize=15)
    ax.set_ylabel("% of endpoints", fontsize=15)
    ax.tick_params(labelsize=13)
    ax.spines[["top", "right"]].set_visible(False)
    fig.tight_layout()
    _save(fig, os.path.join(results_dir, "arity-hist"))


def arity_by_recoverability(results_dir):
    """Construction arity of LyN-X-recovered endpoints, split by whether a regex tool also found them
    (arity-by-recoverability.json). Endpoints regex can find skew arity=1 (a literal form exists); endpoints
    only LyN-X finds skew high — i.e. construction is exactly what regex can't recover."""
    p = os.path.join(results_dir, "arity-by-recoverability.json")
    if not os.path.exists(p):
        return
    with open(p) as f:
        d = json.load(f)
    CAP = 10
    def fold(h):
        b = {}
        for k, v in h.items():
            kk = min(int(k) - 1, CAP)                          # arity(fragments, leaf=1) -> assembly steps (literal=0)
            b[kk] = b.get(kk, 0) + v
        return b
    ra, lo = fold(d["regex_also"]["hist"]), fold(d["lynx_only"]["hist"])
    xs = sorted(set(ra) | set(lo))
    labels = [str(x) if x < CAP else f"{CAP}+" for x in xs]
    mR = round(d["regex_also"]["mean_arity"] - 1, 1)           # mean assembly steps = mean fragments - 1
    mL = round(d["lynx_only"]["mean_arity"] - 1, 1)
    import numpy as np
    x = np.arange(len(xs)); w = 0.4
    # normalize to fractions so the two pools (different sizes) are comparable
    nR = max(1, sum(ra.values())); nL = max(1, sum(lo.values()))
    fig, ax = plt.subplots(figsize=(7.5, 4.2))
    ax.bar(x - w/2, [100 * ra.get(k, 0)/nR for k in xs], w, label=f"regex also found (n={nR:,})", color="#9E9E9E")
    ax.bar(x + w/2, [100 * lo.get(k, 0)/nL for k in xs], w, label=f"LyN-X only (n={nL:,})", color=TOOL_COLOR["lynx"])
    ax.set_xticks(x); ax.set_xticklabels(labels)
    ax.set_xlabel("construction steps", fontsize=22)      # 50% over the 15pt base
    ax.set_ylabel("% of subset", fontsize=22)
    ax.tick_params(labelsize=20)
    ax.set_yticks(range(0, 71, 10))                        # keep the 70 tick on the y-axis
    ax.legend(frameon=False, fontsize=16)
    ax.spines[["top", "right"]].set_visible(False)
    fig.tight_layout()
    _save(fig, os.path.join(results_dir, "arity-by-recoverability"))


def sink_prevalence(results_dir):
    """Prevalence of each LyN-X sink TYPE across the corpus, stacked first- vs third-party, with the sink
    types CodeQL's ClientRequest model covers marked (sink-prevalence.json). Shows which sink types carry
    third-party resource loads — and how many fall outside CodeQL's model."""
    p = os.path.join(results_dir, "sink-prevalence.json")
    if not os.path.exists(p):
        return
    with open(p) as f:
        d = json.load(f)
    # Prefer the EMPIRICAL CodeQL-covered set (from codeql_compare's file+line join on this corpus) over the
    # hand-approximation baked into sink-prevalence.json; fall back to it if CodeQL hasn't been run.
    covered = None
    cp = os.path.join(results_dir, "codeql-covered-sinks.json")
    if os.path.exists(cp):
        with open(cp) as f:
            covered = set(json.load(f).get("covered_types", []))
    is_cq = (lambda r: r["sink"] in covered) if covered is not None else (lambda r: r["codeql"])
    rows = [r for r in d.get("sinks", []) if r["total"] > 0][:18]     # top sink types by prevalence
    if not rows:
        return
    rows = rows[::-1]                                                  # barh plots bottom-up
    labels = [f"{r['sink']}  ◆" if is_cq(r) else r["sink"] for r in rows]  # ◆ = in CodeQL's model (empirical if available)
    first = [r["first"] for r in rows]
    third = [r["third"] for r in rows]
    import numpy as np
    y = np.arange(len(rows))
    fig, ax = plt.subplots(figsize=(8, 0.42 * len(rows) + 1.4))
    ax.barh(y, first, color="#2ca02c", label="first-party (same host)")
    ax.barh(y, third, left=first, color="#d62728", label="third-party (external)")
    ax.set_yticks(y); ax.set_yticklabels(labels, fontsize=9)
    ax.set_xlabel("distinct (site, endpoint) occurrences")
    n_not = (sum(1 for r in d.get("sinks", []) if not is_cq(r)) if covered is not None
             else d.get("lynx_only_sink_types", 0))
    ax.set_title(f"LyN-X sink-type prevalence, first- vs third-party  "
                 f"(◆ = in CodeQL's model; {n_not} types are not)", fontsize=10)
    ax.legend(frameon=False, loc="lower right")
    ax.spines[["top", "right"]].set_visible(False)
    fig.tight_layout()
    _save(fig, os.path.join(results_dir, "sink-prevalence"))


def perf_scaling(results_dir):
    """Per-file timing scatter (log-log) — how each tool's time scales with file size and sink count.
    Reads perf-<tool>.csv (sha,bytes,sinks,ms) written by compare.js. Run compare.js at LOW
    concurrency for contention-free per-file times."""
    files = sorted(glob.glob(os.path.join(results_dir, "perf-*.csv")))
    if not files:
        return
    for xkey, xlabel, fname in [(1, "file size (bytes)", "perf-vs-size"), (2, "URLs extracted", "perf-vs-sinks")]:
        fig, ax = plt.subplots(figsize=(7, 5))
        drew = False
        byfile = {os.path.basename(fp)[len("perf-"):-len(".csv")]: fp for fp in files}
        for tool in ["relwarc", "lynx", "jsluice", "linkfinder"]:   # draw order (slowest behind); canonical colors
            fp = byfile.get(tool)
            if not fp:
                continue
            xs, ys = [], []
            for line in open(fp).read().splitlines()[1:]:
                parts = line.split(",")
                if len(parts) < 4 or not parts[3]:
                    continue
                try:
                    x, y = float(parts[xkey]), float(parts[3])
                except ValueError:
                    continue
                if x <= 0 or y <= 0:      # log axes
                    continue
                xs.append(x); ys.append(y)
            if xs:
                ax.scatter(xs, ys, s=8, alpha=0.35, color=TOOL_COLOR.get(tool),
                           label=f"{DISPLAY.get(tool, tool)} (n={len(xs)})")
                drew = True
        if not drew:
            plt.close(fig)
            continue
        ax.set_xscale("log"); ax.set_yscale("log")
        ax.set_xlabel(xlabel, fontsize=18); ax.set_ylabel("time (ms)", fontsize=18)
        ax.tick_params(labelsize=14)
        ax.legend(frameon=False, markerscale=2, fontsize=15, loc="upper left")
        ax.spines[["top", "right"]].set_visible(False)
        fig.tight_layout()
        _save(fig, os.path.join(results_dir, fname))


if __name__ == "__main__":
    d = sys.argv[1] if len(sys.argv) > 1 else "results"
    if os.path.exists(os.path.join(d, "tier-counts.json")):        # benchmark
        stacked_bar(os.path.join(d, "tier-counts.json"), os.path.join(d, "tier-stacked-bar"), "cases")
    if os.path.exists(os.path.join(d, "compare-tiers.json")):      # crawl corpus
        stacked_bar(os.path.join(d, "compare-tiers.json"), os.path.join(d, "corpus-tiers"), "ground-truth endpoints")
    coherence_hist(d)                                              # crawl corpus
    venn_diagram(d)                                                # crawl corpus: LF/JS/LyN-X discovery overlap
    arity_hist(d)                                                  # crawl corpus: LyN-X URL construction arity
    arity_by_recoverability(d)                                    # crawl corpus: arity split by regex-recoverability
    sink_prevalence(d)                                            # crawl corpus: sink-type prevalence, party-split, vs CodeQL
    sink_axis(d)                                                   # sink axis (CodeQL vs LyN-X)
    perf_scaling(d)                                                # per-file timing vs size / sinks
