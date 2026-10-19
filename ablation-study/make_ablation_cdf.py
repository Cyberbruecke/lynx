#!/usr/bin/env python3
# Subset-coverage (RECOVERY) curve. An endpoint is recoverable only once its ENTIRE required-capability set is
# enabled (an endpoint needing {concat,interproc} is NOT counted until both are on). Each line runs from a
# dataset's baseline (endpoints needing no capability) up to 100%, enabling capabilities left-to-right in GREEDY
# recovery order (at each step, the capability that newly completes the most endpoints, computed on `all`).
# One line per dataset. Reads ablation-<corpus>.eval.json.
import json, os, sys
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

EVAL = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), "data", "ablation-crawl.eval.json")
OUT = sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(__file__), "data", "ablation-cdf")
d = json.load(open(EVAL))
order = d["greedy_order"]                 # greedy recovery order (max newly-completed endpoints on `all`)
x = list(range(0, len(order) + 1))        # x=0 = baseline (no capability); x=1..N add caps in greedy order

# dataset -> (color, style, label); drawn in this order
SERIES = [
    ("all",           "#111111", "-",  "All"),
    ("recall",        "#1E5AA8", "-",  "GT"),
    ("recall_unique", "#137333", "-",  "GT LyN-X only"),
    ("car",           "#E8A200", "--", "CAR"),
    ("tar",           "#9467BD", "--", "TAR"),
]

fig, ax = plt.subplots(figsize=(8.6, 4.8))
for key, color, ls, label in SERIES:
    ds = d["datasets"].get(key)
    if not ds or not ds["n"]:
        continue
    y = [100 * ds["baseline"]] + [100 * v for v in ds["subset_cumulative"]]   # baseline -> ... -> 100%
    ax.plot(x, y, ls, color=color, lw=2.4, marker="o", ms=4, label=f"{label}  (n={ds['n']:,})")

ax.set_xticks(x)
ax.set_xticklabels(["∅"] + order, rotation=45, ha="right", fontsize=14)
ax.set_ylabel("% of endpoints recoverable", fontsize=18.2)
ax.set_ylim(0, 101); ax.tick_params(axis="y", labelsize=14)
ax.axhline(100, color="#bbb", lw=0.8, ls=":", zorder=0)
ax.grid(axis="y", lw=0.4, alpha=0.4); ax.set_axisbelow(True)
ax.spines[["top", "right"]].set_visible(False)
ax.legend(frameon=False, fontsize=14, loc="lower right")
fig.tight_layout()
fig.savefig(OUT + ".png", dpi=200, bbox_inches="tight")
fig.savefig(OUT + ".pdf", bbox_inches="tight")
print("wrote", OUT + ".{png,pdf}")
