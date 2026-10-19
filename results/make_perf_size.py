#!/usr/bin/env python3
# Processing time vs. file size, per tool. x = file size (log), y = median processing time (log), one line per
# tool over log-spaced size bins. Reads perf-<tool>.csv (sha,bytes,sinks,ms). Canonical tool colors.
import csv, os, sys
import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

HERE = os.path.dirname(__file__)
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "perf-size")

# draw/legend order + canonical colors
SERIES = [
    ("relwarc",    "relwarc",    "#9467BD"),
    ("lynx",       "LyN-X",      "#137333"),
    ("jsluice",    "JSluice",    "#E8A200"),
    ("linkfinder", "LinkFinder", "#1E5AA8"),
]

def load(t):
    xs, ys = [], []
    with open(os.path.join(HERE, f"perf-{t}.csv")) as f:
        for r in csv.DictReader(f):
            try:
                b = int(r["bytes"]); ms = float(r["ms"])
                if b > 0 and ms > 0: xs.append(b); ys.append(ms)
            except: pass
    return np.array(xs), np.array(ys)

# shared log-spaced size bins (bytes)
bins = np.logspace(np.log10(1e3), np.log10(1e7), 22)   # 1 KB .. 10 MB
ctr = np.sqrt(bins[:-1] * bins[1:])

fig, ax = plt.subplots(figsize=(8.0, 5.0))
for t, label, color in SERIES:
    b, ms = load(t)
    idx = np.digitize(b, bins) - 1
    xc, yc = [], []
    for j in range(len(ctr)):
        sel = ms[idx == j]
        if sel.size >= 30:                       # skip sparse bins (noisy tails)
            xc.append(ctr[j] / 1e3); yc.append(np.median(sel) / 1e3)   # KB, seconds
    ax.plot(xc, yc, "-", color=color, lw=2.6, marker="o", ms=5, label=label)

ax.set_xscale("log"); ax.set_yscale("log")
ax.set_xlabel("file size (KB)", fontsize=18)
ax.set_ylabel("median processing time (s)", fontsize=18)
ax.tick_params(labelsize=14)
ax.grid(True, which="major", lw=0.4, alpha=0.4); ax.set_axisbelow(True)
ax.spines[["top", "right"]].set_visible(False)
ax.legend(frameon=False, fontsize=15, loc="upper left")
fig.tight_layout()
fig.savefig(OUT + ".png", dpi=200, bbox_inches="tight")
fig.savefig(OUT + ".pdf", bbox_inches="tight")
print("wrote", OUT + ".{png,pdf}")
