#!/usr/bin/env python3
"""Normalize all tracker/ad sources in raw/ to a common eTLD+1 schema so they can
be intersected with LyN-X's extracted endpoints.

Output (normalized/):
  <source>.csv            one row per (domain) with: etld1,domain,source,category,owner
  all_trackers.csv        union of the above (keeps source/category/owner)
  all_trackers_etld1.txt  deduped sorted eTLD+1 set (fast join key)

Matching contract: compute eTLD+1 with the Public Suffix List (via tldextract) on
BOTH sides (here and on LyN-X output) before intersecting. Never string-match hosts.

Deps: pip install tldextract
"""
import csv
import glob
import json
import os
import re
import sys

try:
    import tldextract
except ImportError:
    sys.exit("Missing dependency: pip install tldextract")

RAW = os.path.join(os.path.dirname(__file__), "raw")
OUT = os.path.join(os.path.dirname(__file__), "normalized")
os.makedirs(OUT, exist_ok=True)

# No live PSL fetch during a run (suffix_list_urls=()) and no on-disk cache
# (cache_dir=None) -> uses the snapshot bundled with tldextract, fully offline.
_extract = tldextract.TLDExtract(suffix_list_urls=(), cache_dir=None)


def etld1(host: str) -> str:
    host = (host or "").strip().lower().lstrip(".")
    if host.startswith("*."):
        host = host[2:]
    e = _extract(host)
    # version-agnostic registered domain (avoids renamed attributes across tldextract versions)
    return ".".join(p for p in (e.domain, e.suffix) if p)


# ---- source parsers: each yields (domain, category, owner) ----

def parse_ddg():
    root = os.path.join(RAW, "tracker-radar", "domains")
    seen = {}
    for path in glob.glob(os.path.join(root, "*", "*.json")):
        try:
            d = json.load(open(path, encoding="utf-8"))
        except Exception:
            continue
        dom = d.get("domain")
        if not dom:
            continue
        owner = (d.get("owner") or {}).get("displayName") or (d.get("owner") or {}).get("name") or ""
        cats = "|".join(d.get("categories") or [])
        # dedup across regions; keep the richest record
        if dom not in seen or (cats and not seen[dom][0]):
            seen[dom] = (cats, owner)
    for dom, (cats, owner) in seen.items():
        yield dom, cats, owner


def parse_ghostery():
    path = os.path.join(RAW, "ghostery-trackerdb.json")
    if not os.path.exists(path):
        return
    db = json.load(open(path, encoding="utf-8"))
    patterns = db.get("patterns", {})
    orgs = db.get("organizations", {})
    for dom, pat_key in db.get("domains", {}).items():
        pat = patterns.get(pat_key, {})
        cat = pat.get("category", "") or ""
        org_key = pat.get("organization")
        owner = (orgs.get(org_key, {}) or {}).get("name", "") if org_key else ""
        yield dom, cat, owner


_ADBLOCK = re.compile(r"^\|\|([a-z0-9.\-_]+)\^")


def parse_adblock(filename, category):
    path = os.path.join(RAW, filename)
    if not os.path.exists(path):
        return
    for line in open(path, encoding="utf-8", errors="ignore"):
        line = line.strip()
        if not line or line[0] in "!#[":
            continue
        if line.startswith("@@"):            # exception rule
            continue
        if any(c in line for c in ("##", "#@#", "#?#", "#$#")):  # cosmetic
            continue
        m = _ADBLOCK.match(line)             # only ||domain^ network-anchor rules
        if m:
            yield m.group(1).lower().rstrip("."), category, ""


def parse_hosts(filename, category):
    path = os.path.join(RAW, filename)
    if not os.path.exists(path):
        return
    for line in open(path, encoding="utf-8", errors="ignore"):
        line = line.strip()
        if not line or line[0] in "#!":
            continue
        parts = line.split()
        dom = parts[-1] if parts else ""     # "0.0.0.0 domain" or bare "domain"
        if "." in dom and " " not in dom:
            yield dom.lower(), category, ""


SOURCES = {
    "ddg-tracker-radar": parse_ddg,
    "ghostery-trackerdb": parse_ghostery,
    "easyprivacy": lambda: parse_adblock("easyprivacy.txt", "tracking"),
    "easylist": lambda: parse_adblock("easylist.txt", "advertising"),
    "adguard-tracking": lambda: parse_adblock("adguard-tracking.txt", "tracking"),
    "pgl-yoyo": lambda: parse_hosts("pgl-yoyo.txt", "advertising"),
}


def main():
    union = {}            # etld1 -> (source, category, owner) first-seen
    union_writer_rows = []
    for source, fn in SOURCES.items():
        rows, n = [], 0
        for dom, cat, owner in fn():
            e = etld1(dom)
            if not e:
                continue
            rows.append((e, dom, source, cat, owner))
            n += 1
            union.setdefault(e, (source, cat, owner))
            union_writer_rows.append((e, dom, source, cat, owner))
        with open(os.path.join(OUT, f"{source}.csv"), "w", newline="") as f:
            w = csv.writer(f)
            w.writerow(["etld1", "domain", "source", "category", "owner"])
            w.writerows(rows)
        print(f"  {source:22} {n:>7} domains -> {len({r[0] for r in rows}):>7} eTLD+1")

    with open(os.path.join(OUT, "all_trackers.csv"), "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["etld1", "domain", "source", "category", "owner"])
        w.writerows(union_writer_rows)
    with open(os.path.join(OUT, "all_trackers_etld1.txt"), "w") as f:
        f.write("\n".join(sorted(union)) + "\n")
    print(f"[*] union: {len(union)} unique eTLD+1 -> normalized/all_trackers_etld1.txt")


if __name__ == "__main__":
    main()
