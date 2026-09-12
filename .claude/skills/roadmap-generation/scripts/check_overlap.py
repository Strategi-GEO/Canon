#!/usr/bin/env python3
"""Cannibalisation gate: score proposed roadmap topics against published content.

Two checks:
  1. Proposed topic vs every published piece in the inventory.
  2. Proposed topic vs every other proposed topic (self-collision).

Scoring blends token overlap (containment-weighted Jaccard) with sequence
similarity, then adds a hard flag when two items share a primary query.

Usage:
    python3 check_overlap.py --inventory inventory.json --proposed proposed.json
    python3 check_overlap.py --inventory inventory.json --proposed proposed.json --threshold 0.45 --json report.json

inventory.json:
    {"items": [{"url": "...", "title": "...", "h1": "...", "primary_topic": "...",
                "queries_it_answers": ["..."]}, ...]}
    (a bare list is also accepted)

proposed.json:
    {"rows": [{"Content Topic": "...", "primary_query": "...",
               "Target Prompts": ["...", "...", "..."]}, ...]}
    (accepts "topic"/"title" as aliases for "Content Topic"; a bare list of
     strings also works)

Exit codes: 0 clean, 1 flags found, 2 bad input.
"""

import argparse
import json
import re
import sys
from difflib import SequenceMatcher
from itertools import combinations

STOPWORDS = {
    "a", "an", "and", "are", "as", "at", "be", "best", "but", "by", "can", "do",
    "does", "for", "from", "guide", "how", "in", "is", "it", "its", "of", "on",
    "or", "our", "that", "the", "their", "these", "this", "to", "top", "vs",
    "was", "what", "when", "where", "which", "who", "why", "will", "with",
    "you", "your", "2024", "2025", "2026",
}

WORD_RE = re.compile(r"[a-z0-9]+")


def tokens(text):
    if not text:
        return set()
    raw = WORD_RE.findall(str(text).lower())
    return {t for t in raw if t not in STOPWORDS and len(t) > 2}


def normalise(text):
    return " ".join(sorted(tokens(text)))


def overlap_score(a_text, b_text):
    """0.0 to 1.0. Blends containment-weighted Jaccard with sequence ratio."""
    a, b = tokens(a_text), tokens(b_text)
    if not a or not b:
        return 0.0
    inter = len(a & b)
    jaccard = inter / len(a | b)
    containment = inter / min(len(a), len(b))
    seq = SequenceMatcher(None, normalise(a_text), normalise(b_text)).ratio()
    return round(0.4 * jaccard + 0.35 * containment + 0.25 * seq, 3)


def band(score, threshold):
    if score >= 0.75:
        return "HIGH"
    if score >= threshold + 0.15:
        return "MEDIUM"
    return "LOW"


def load_inventory(path):
    with open(path, encoding="utf-8") as fh:
        data = json.load(fh)
    items = data.get("items", data) if isinstance(data, dict) else data
    out = []
    for i, item in enumerate(items):
        if isinstance(item, str):
            item = {"title": item}
        text = " ".join(
            str(item.get(k, ""))
            for k in ("title", "h1", "primary_topic")
        )
        queries = item.get("queries_it_answers") or []
        if isinstance(queries, str):
            queries = [queries]
        out.append({
            "url": item.get("url", f"(inventory item {i + 1})"),
            "title": item.get("title") or item.get("h1") or "(untitled)",
            "text": text.strip() or item.get("url", ""),
            "queries": [str(q).strip().lower() for q in queries if str(q).strip()],
        })
    return out


def load_proposed(path):
    with open(path, encoding="utf-8") as fh:
        data = json.load(fh)
    rows = data.get("rows", data) if isinstance(data, dict) else data
    out = []
    for i, row in enumerate(rows):
        if isinstance(row, str):
            row = {"Content Topic": row}
        topic = (
            row.get("Content Topic")
            or row.get("topic")
            or row.get("title")
            or ""
        ).strip()
        if not topic:
            sys.exit(f"error: proposed row {i + 1} has no Content Topic")
        primary = (row.get("primary_query") or row.get("Primary Query") or "").strip().lower()
        prompts = row.get("Target Prompts") or []
        if isinstance(prompts, str):
            prompts = [p.strip() for p in prompts.split("|")]
        out.append({
            "n": i + 1,
            "topic": topic,
            "primary": primary,
            "text": " ".join([topic] + [str(p) for p in prompts]),
        })
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--inventory", help="published content inventory JSON")
    ap.add_argument("--proposed", required=True, help="proposed roadmap rows JSON")
    ap.add_argument("--threshold", type=float, default=0.45,
                    help="flag at or above this score (default 0.45)")
    ap.add_argument("--json", dest="json_out", help="also write the full report here")
    args = ap.parse_args()

    try:
        proposed = load_proposed(args.proposed)
        inventory = load_inventory(args.inventory) if args.inventory else []
    except (OSError, json.JSONDecodeError) as exc:
        sys.exit(f"error: {exc}")

    vs_published, vs_proposed = [], []

    for row in proposed:
        for item in inventory:
            score = overlap_score(row["text"], item["text"])
            shared_query = bool(
                row["primary"] and row["primary"] in item["queries"]
            )
            if score >= args.threshold or shared_query:
                vs_published.append({
                    "row": row["n"],
                    "topic": row["topic"],
                    "collides_with": item["title"],
                    "url": item["url"],
                    "score": score,
                    "band": "HIGH" if shared_query else band(score, args.threshold),
                    "shared_primary_query": shared_query,
                })

    for a, b in combinations(proposed, 2):
        score = overlap_score(a["text"], b["text"])
        shared_query = bool(a["primary"] and a["primary"] == b["primary"])
        if score >= args.threshold or shared_query:
            vs_proposed.append({
                "row": a["n"],
                "topic": a["topic"],
                "collides_with_row": b["n"],
                "collides_with": b["topic"],
                "score": score,
                "band": "HIGH" if shared_query else band(score, args.threshold),
                "shared_primary_query": shared_query,
            })

    order = {"HIGH": 0, "MEDIUM": 1, "LOW": 2}
    vs_published.sort(key=lambda f: (order[f["band"]], -f["score"]))
    vs_proposed.sort(key=lambda f: (order[f["band"]], -f["score"]))

    print(f"Proposed rows: {len(proposed)}   Published pieces: {len(inventory)}   "
          f"Threshold: {args.threshold}")
    if not args.inventory:
        print("WARNING: no inventory supplied - the published-content check did not run.")
    print()

    if vs_published:
        print(f"--- Collides with published content ({len(vs_published)}) ---")
        for f in vs_published:
            tag = " [SHARED PRIMARY QUERY]" if f["shared_primary_query"] else ""
            print(f"  [{f['band']}] {f['score']:.3f}{tag}")
            print(f"    row {f['row']}: {f['topic']}")
            print(f"    existing:   {f['collides_with']}")
            print(f"    {f['url']}")
        print()

    if vs_proposed:
        print(f"--- Roadmap collides with itself ({len(vs_proposed)}) ---")
        for f in vs_proposed:
            tag = " [SHARED PRIMARY QUERY]" if f["shared_primary_query"] else ""
            print(f"  [{f['band']}] {f['score']:.3f}{tag}")
            print(f"    row {f['row']}: {f['topic']}")
            print(f"    row {f['collides_with_row']}: {f['collides_with']}")
        print()

    total = len(vs_published) + len(vs_proposed)
    if total == 0:
        print("CLEAN: no overlap at or above threshold.")
    else:
        print(f"{total} flag(s). Resolve each one: drop, differentiate, or "
              f"confirm the overlap is superficial.")

    if args.json_out:
        with open(args.json_out, "w", encoding="utf-8") as fh:
            json.dump({
                "threshold": args.threshold,
                "proposed_count": len(proposed),
                "inventory_count": len(inventory),
                "vs_published": vs_published,
                "vs_proposed": vs_proposed,
            }, fh, indent=2, ensure_ascii=False)
        print(f"Report written to {args.json_out}")

    sys.exit(1 if total else 0)


if __name__ == "__main__":
    main()
