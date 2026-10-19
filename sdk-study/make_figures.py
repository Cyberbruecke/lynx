#!/usr/bin/env python3
"""P6 — SDK-study figures. Reads results/{sdk-recall.csv,sdk-by-style.csv} (+ optional deployment.json) and
draws paper-ready charts: per-tool pooled recall+precision, recall by construction style (the "broad middle"
figure), and a per-SDK recall-vs-precision scatter (LyN-X upper-right, regex lower-right). Saves PNGs to the
results dir. Each figure is drawn only if its inputs exist.

Usage: python3 make_figures.py [results_dir]   (default: ./results)
"""
import csv
import json
import os
import sys

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

RES = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "results")
TOOL_ORDER = ["lynx", "relwarc", "jsluice", "linkfinder"]        # LyN-X first for legend consistency
COLORS = {"lynx": "#1f77b4", "relwarc": "#2ca02c", "jsluice": "#ff7f0e", "linkfinder": "#d62728"}


def read_csv(name):
    p = os.path.join(RES, name)
    if not os.path.exists(p):
        return None
    with open(p) as f:
        return list(csv.DictReader(f))


def order_tools(tools):
    return [t for t in TOOL_ORDER if t in tools] + sorted(t for t in tools if t not in TOOL_ORDER)


def fig_pooled(rows):
    """Per-tool pooled recall + precision (micro-averaged over endpoints/output)."""
    agg = {}
    for r in rows:
        a = agg.setdefault(r["tool"], {"rec": 0, "tot": 0, "hit": 0, "emit": 0})
        a["rec"] += int(r["exact"]) + int(r["templated"])
        a["tot"] += int(r["total"])
        a["hit"] += round(float(r["precision"]) * int(r["emitted"]))
        a["emit"] += int(r["emitted"])
    tools = order_tools(list(agg))
    recall = [100 * agg[t]["rec"] / max(agg[t]["tot"], 1) for t in tools]
    prec = [100 * agg[t]["hit"] / max(agg[t]["emit"], 1) for t in tools]
    x = range(len(tools))
    w = 0.38
    fig, ax = plt.subplots(figsize=(7, 4))
    ax.bar([i - w / 2 for i in x], recall, w, label="recall", color="#1f77b4")
    ax.bar([i + w / 2 for i in x], prec, w, label="precision", color="#aec7e8")
    ax.set_xticks(list(x)); ax.set_xticklabels(tools)
    ax.set_ylabel("%"); ax.set_ylim(0, 100); ax.set_title("SDK endpoints: recall & precision (pooled)")
    for i, (rv, pv) in enumerate(zip(recall, prec)):
        ax.text(i - w / 2, rv + 1, f"{rv:.0f}", ha="center", fontsize=8)
        ax.text(i + w / 2, pv + 1, f"{pv:.0f}", ha="center", fontsize=8)
    ax.legend(); fig.tight_layout()
    out = os.path.join(RES, "sdk-recall-precision.png"); fig.savefig(out, dpi=150); plt.close(fig)
    print("[*]", out)


def fig_by_style(rows):
    """Recall per construction style x tool — the 'broad middle' figure."""
    styles = sorted({r["style"] for r in rows})
    tools = order_tools(list({r["tool"] for r in rows}))
    val = {(r["style"], r["tool"]): 100 * float(r["recall"]) for r in rows}
    n = len(tools)
    w = 0.8 / max(n, 1)
    fig, ax = plt.subplots(figsize=(max(8, 1.1 * len(styles)), 4.5))
    for j, t in enumerate(tools):
        ax.bar([i + j * w for i in range(len(styles))], [val.get((s, t), 0) for s in styles],
               w, label=t, color=COLORS.get(t))
    ax.set_xticks([i + w * (n - 1) / 2 for i in range(len(styles))])
    ax.set_xticklabels(styles, rotation=35, ha="right", fontsize=8)
    ax.set_ylabel("recall %"); ax.set_ylim(0, 100)
    ax.set_title("Endpoint recall by construction style")
    ax.legend(fontsize=8); fig.tight_layout()
    out = os.path.join(RES, "sdk-recall-by-style.png"); fig.savefig(out, dpi=150); plt.close(fig)
    print("[*]", out)


def fig_scatter(rows):
    """Per-SDK recall vs precision, colored by tool (LyN-X should cluster upper-right)."""
    fig, ax = plt.subplots(figsize=(6, 6))
    for t in order_tools(list({r["tool"] for r in rows})):
        pts = [(100 * float(r["precision"]), 100 * float(r["recall"])) for r in rows if r["tool"] == t]
        if pts:
            ax.scatter([p for p, _ in pts], [r for _, r in pts], s=28, alpha=0.7, label=t, color=COLORS.get(t))
    ax.set_xlabel("precision %"); ax.set_ylabel("recall %")
    ax.set_xlim(-2, 102); ax.set_ylim(-2, 102)
    ax.set_title("Per-SDK recall vs precision"); ax.legend(fontsize=8); ax.grid(alpha=0.3)
    fig.tight_layout()
    out = os.path.join(RES, "sdk-recall-vs-precision.png"); fig.savefig(out, dpi=150); plt.close(fig)
    print("[*]", out)


def main():
    recall_rows = read_csv("sdk-recall.csv")
    style_rows = read_csv("sdk-by-style.csv")
    if not recall_rows:
        sys.exit(f"no sdk-recall.csv in {RES} — run sdk_eval.js first")
    fig_pooled(recall_rows)
    fig_scatter(recall_rows)
    if style_rows:
        fig_by_style(style_rows)
    print(f"[*] figures written to {RES}")


if __name__ == "__main__":
    main()
