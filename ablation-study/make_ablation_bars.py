#!/usr/bin/env python3
# Horizontal grouped bar chart of per-capability necessity across datasets.
# x = % of a dataset's outputs that REQUIRE a capability (leave-one-out); y = capability, sorted by 'all'.
# Complements the CDF (which shows cumulative UNION): this shows per-capability necessity, the CDF shows
# marginal contribution. Reads ablation-<corpus>.eval.json.
import json, os, sys
import matplotlib; matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

EVAL = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), "data", "ablation-crawl.eval.json")
OUT  = sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(__file__), "data", "ablation-bars")
d = json.load(open(EVAL))

# datasets to show (key -> (label, color)); order = bar order within each capability group.
# Labels/order/colors mirror the CDF plot so the two figures share a legend vocabulary.
SERIES = [
    ("all",           "All",           "#111111"),
    ("recall",        "GT",            "#1E5AA8"),
    ("recall_unique", "GT LyN-X only", "#137333"),
    ("car",           "CAR",           "#E8A200"),
    ("tar",           "TAR",           "#9467BD"),
]
SERIES = [s for s in SERIES if d["datasets"].get(s[0], {}).get("n")]

# pct lookup per dataset
pct = {k: {c["capability"]: c["pct"] for c in d["datasets"][k]["capabilities"]} for k, _, _ in SERIES}
# capabilities sorted by 'all' necessity desc; drop the near-zero tail (max across shown series < THRESH)
THRESH = 1.0
caps = [c["capability"] for c in sorted(d["datasets"]["all"]["capabilities"], key=lambda x: -x["pct"])]
caps = [c for c in caps if max(pct[k].get(c, 0) for k, _, _ in SERIES) >= THRESH]
dropped = [c for c in d["order"] if c not in caps]

y = np.arange(len(caps))[::-1]              # top capability at the top
h = 0.8 / len(SERIES)
fig, ax = plt.subplots(figsize=(8.64, 0.55 * len(caps) + 1.2))
for i, (k, label, color) in enumerate(SERIES):
    vals = [pct[k].get(c, 0) for c in caps]
    ax.barh(y + (i - (len(SERIES)-1)/2) * h, vals, height=h, color=color,
            label=f"{label}  (n={d['datasets'][k]['n']:,})")

ax.set_yticks(y); ax.set_yticklabels(caps, fontsize=15.4)
ax.set_xlabel("% of dataset's endpoints requiring the capability", fontsize=16.8)
ax.set_xlim(0, 100); ax.tick_params(axis="x", labelsize=14)
ax.grid(axis="x", lw=0.4, alpha=0.4); ax.set_axisbelow(True)
ax.spines[["top", "right"]].set_visible(False)
ax.legend(frameon=False, fontsize=14, loc="lower right")
fig.tight_layout()
fig.savefig(OUT + ".png", dpi=200, bbox_inches="tight")
fig.savefig(OUT + ".pdf", bbox_inches="tight")
print("wrote", OUT + ".{png,pdf}  (", len(caps), "caps shown,", len(dropped), "omitted )")
