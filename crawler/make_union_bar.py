#!/usr/bin/env python3
# Stacked horizontal bar: per-tool recovery of the medium-tier union, split shared (>=2 tools) vs unique
# (only this tool), ordered by total. Reads results/union-recovery.json (from union_recovery.js).
import json, os
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

R = os.path.join(os.path.dirname(__file__), "..", "results")
d = json.load(open(os.path.join(R, "union-recovery.json")))
rows = list(reversed(d["rows"]))                      # rows are total-desc; reverse so largest sits on top
union = d["union"]
tools = [r["tool"] for r in rows]
shared = [r["shared"] for r in rows]
unique = [r["unique"] for r in rows]
y = range(len(tools))

# Canonical per-tool palette (keep in sync with benchmark/make_figures.py TOOL_COLOR). Each tool's bar is drawn
# in its own color; shared = the same color lightened (alpha), unique = full saturation.
from matplotlib.patches import Patch
TOOL_COLOR = {"LinkFinder": "#1E5AA8", "JSluice": "#E8A200", "relwarc": "#9467BD", "LyN-X": "#137333"}
colors = [TOOL_COLOR.get(t, "#777777") for t in tools]
fig, ax = plt.subplots(figsize=(8.6, 3.2))
ax.barh(y, shared, color=colors, alpha=0.38)                                # shared = lightened tool color
ax.barh(y, unique, left=shared, color=colors)                              # unique = full tool color
ax.set_yticks(list(y)); ax.set_yticklabels(tools, fontsize=14)
for i, r in enumerate(rows):
    ax.text(r["total"] + union * 0.008, i, f'{r["total"]:,}', va="center", fontsize=11)
    if r["unique"] > union * 0.06:                    # label the unique segment when wide enough to hold text
        ax.text(r["shared"] + r["unique"] / 2, i, f'{r["unique"]:,}', va="center", ha="center", fontsize=11, color="white", fontweight="bold")
    else:                                             # tiny unique -> label past the bar end, clear of the total
        ax.text(r["total"] + union * 0.115, i, f'unique {r["unique"]:,}', va="center", fontsize=10, color=colors[i])
ax.set_xlabel("recovered ground-truth endpoints (medium tier)", fontsize=15)
ax.tick_params(axis="x", labelsize=13)
ax.set_xlim(0, max(r["total"] for r in rows) * 1.28)
ax.legend(handles=[Patch(facecolor="#777777", alpha=0.38, label="shared"),
                   Patch(facecolor="#777777", label="unique")],
          loc="lower right", fontsize=12, frameon=False)
for sp in ("top", "right"):
    ax.spines[sp].set_visible(False)
plt.tight_layout()
plt.savefig(os.path.join(R, "union-recovery.png"), dpi=150)
plt.savefig(os.path.join(R, "union-recovery.pdf"))
print("wrote results/union-recovery.{png,pdf}")
