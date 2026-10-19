#!/usr/bin/env python3
# Schematic Venn: dynamic GT (one circle) vs static union = THREE right-aligned circles (strict<medium<relaxed).
# The three nested crescent INTERSECTIONS with the dynamic circle are the tiered recovery (strict/medium/relaxed),
# shaded saturated and labelled with counts; the rest of the static circles (light) is the additional (static-only)
# recovery, labelled outside with a leader. NOT area-proportional -- schematic, oversized fonts to stay legible small.
import os
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import Circle, Patch

R = os.path.join(os.path.dirname(__file__), "..", "results")
# medium-tier scoring (GT 861,385): relaxed 318,747 / medium 206,654 / strict 171,427; additional union 15.8M
DYNC, DYNE, LIGHT = "#cfe0f2", "#4C72B0", "#d8f3dc"
Dcx, Rd, Xr = -0.5, 2.5, 3.4                               # dynamic center/radius; shared right edge of static circles
# (radius, saturated recovered color, tier name, count, label-x, label-y) -- counts staggered to clear the narrow strict crescent
STATIC = [(2.0, "#74C69D", "relaxed", "319K", -0.15, 0.55), (1.45, "#40916C", "medium", "207K", 0.9, 0.0), (0.95, "#1B4332", "strict", "171K", 1.8, -0.62)]

fig, ax = plt.subplots(figsize=(9.4, 5.1))
dyn = Circle((Dcx, 0), Rd, facecolor=DYNC, edgecolor="none", zorder=1)
ax.add_patch(dyn)
for rad, *_ in STATIC:                                     # base: whole static circles light = additional look
    ax.add_patch(Circle((Xr - rad, 0), rad, facecolor=LIGHT, edgecolor="none", zorder=2))
for rad, col, *_ in STATIC:                                # recovered crescents: saturated, clipped to the dynamic circle
    c = Circle((Xr - rad, 0), rad, facecolor=col, edgecolor="white", lw=1.6, zorder=3)
    ax.add_patch(c); c.set_clip_path(dyn)
ax.add_patch(Circle((Dcx, 0), Rd, facecolor="none", edgecolor=DYNE, lw=2.6, zorder=5))   # dynamic outline on top

# tier counts over the three crescent intersections (staggered)
for rad, col, name, cnt, lx, ly in STATIC:
    ax.text(lx, ly, cnt, ha="center", va="center", fontsize=15, fontweight="bold",
            color=("#14532d" if name == "relaxed" else "white"), zorder=6)
# missed (dynamic-only)
ax.text(-1.95, 0, "543K", ha="center", va="center", fontsize=23, fontweight="bold", color="#1f3b63", zorder=6)
ax.text(-1.95, -0.58, "missed", ha="center", va="center", fontsize=14, color="#333333", zorder=6)
# additional (static-only) -- labelled OUTSIDE the circles with a leader to the light region
ax.annotate("15.8M\nadditional", xy=(3.02, 0.75), xytext=(4.35, 1.65), ha="center", va="center",
            fontsize=18, fontweight="bold", color="#137333",
            arrowprops=dict(arrowstyle="-", color="#137333", lw=1.6))

ax.text(-2.1, Rd + 0.16, "Dynamic crawl", ha="center", va="bottom", fontsize=19, color=DYNE,      fontweight="bold")
ax.text( 2.5, Rd + 0.16, "Static union",  ha="center", va="bottom", fontsize=19, color="#137333", fontweight="bold")
ax.legend(handles=[Patch(facecolor=c, label=n) for (_, c, n, _, _, _) in STATIC],
          loc="lower center", ncol=3, fontsize=13, frameon=False, bbox_to_anchor=(0.42, -0.09))
ax.set_xlim(Dcx - Rd - 0.7, 5.1)
ax.set_ylim(-Rd - 0.5, Rd + 1.05)
ax.set_aspect("equal"); ax.axis("off")
fig.savefig(os.path.join(R, "gt-static-venn.png"), dpi=200, bbox_inches="tight")
fig.savefig(os.path.join(R, "gt-static-venn.pdf"), bbox_inches="tight")
print("wrote results/gt-static-venn.{png,pdf}")
