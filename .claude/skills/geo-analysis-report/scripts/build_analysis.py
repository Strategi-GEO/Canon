#!/usr/bin/env python3
"""
build_analysis.py: render analysis.json into the branded monthly PDF.

Same data-in / document-out split as geo-site-report's build_report.py: the model
produces analysis.json (numbers only), and this owns every pixel of layout,
branding, colour, and pagination so every brand's report looks identical forever.
Anything derivable (prompt-matrix coverage, the Lighthouse traffic-light) is
derived here, never asked of the model.

The report DEGRADES: any section whose tool was not connected is simply absent
from the JSON, and the template's {% if %} guards drop it. A missing tool costs a
section, never the whole document.

Usage:
    python3 build_analysis.py analysis.json --out analysis.pdf
    python3 build_analysis.py analysis.json --out analysis.pdf --keep-html   # debug layout
    python3 build_analysis.py --selfcheck                                     # validate/derive checks

Schema: see references/analysis-schema.md.
"""

import argparse
import json
import os
import sys
import tempfile
from pathlib import Path

from jinja2 import Environment, FileSystemLoader, select_autoescape
from markupsafe import Markup

ASSETS = Path(__file__).resolve().parent.parent / "assets"

# The required floor: producible from DataForSEO + Firecrawl alone. Everything else is optional and
# omitted when its tool is absent (graceful degradation IS the schema).
REQUIRED = ["client", "month", "month_label", "scorecard", "ai_visibility", "tools"]

FOOTER = """
<div style="width:100%;font-family:Carlito,sans-serif;font-size:7pt;color:#6B7480;
            padding:0 16mm;display:flex;justify-content:space-between;">
  <span>__ORG__ &middot; __SITE__ &middot; __DATE__</span>
  <span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>
</div>
"""

CELL_CLASS = {"cited": "cell-good", "mentioned": "cell-mid", "absent": "cell-bad"}


def score_cell(value):
    """Traffic-light a Lighthouse score on Google's own thresholds: 90+ green, 50-89 amber."""
    if value is None or value == "":
        return Markup('<span class="score-na">n/a</span>')
    try:
        v = int(round(float(value)))
    except (TypeError, ValueError):
        return Markup('<span class="score-na">%s</span>' % value)
    if v <= 1 and isinstance(value, float):  # someone passed 0.61 instead of 61
        v = int(round(float(value) * 100))
    cls = "score-good" if v >= 90 else ("score-mid" if v >= 50 else "score-bad")
    return Markup('<span class="score %s">%d</span>' % (cls, v))


def cell_class(state):
    """The fixed matrix colour for a cell state; unknown/missing renders neutral."""
    return CELL_CLASS.get(state, "cell-none")


def _coverage_from_cells(prompts):
    """Fraction of (prompt, engine) cells that are cited or mentioned, as a 0-100 int.
    A prompt counts a cell only where the engine returned a state, so absent-by-omission does not
    silently deflate coverage."""
    seen = hit = 0
    for p in prompts:
        for c in p.get("cells", []):
            state = c.get("state")
            if state in ("cited", "mentioned", "absent"):
                seen += 1
                if state in ("cited", "mentioned"):
                    hit += 1
    return round(100.0 * hit / seen) if seen else 0


def derive(data):
    """Compute everything computable so the model never hand-counts and never miscounts."""
    av = data.get("ai_visibility")
    if isinstance(av, dict):
        pm = av.get("prompt_matrix")
        if isinstance(pm, dict) and isinstance(pm.get("prompts"), list):
            if not isinstance(pm.get("coverage_pct"), (int, float)):
                pm["coverage_pct"] = _coverage_from_cells(pm["prompts"])
            # A per-prompt cell lookup keyed by engine, so the template can render a fixed column
            # order (pm.engines) and drop a neutral cell where an engine has no result this month.
            engines = pm.get("engines") or []
            for prompt in pm["prompts"]:
                by = {c.get("engine"): c for c in prompt.get("cells", []) if isinstance(c, dict)}
                prompt["row"] = [by.get(e, {"engine": e, "state": None}) for e in engines]
    return data


def validate(data):
    missing = [k for k in REQUIRED if not data.get(k)]
    if missing:
        sys.exit("analysis.json is missing required keys: %s" % ", ".join(missing))

    av = data.get("ai_visibility") or {}
    pm = av.get("prompt_matrix") or {}
    if not (pm.get("engines") and pm.get("prompts")):
        sys.exit("analysis.json ai_visibility.prompt_matrix needs a non-empty engines array and a "
                 "non-empty prompts array (the GEO centrepiece, always producible from the floor tools)")

    bad = []
    for p in pm.get("prompts", []):
        for c in p.get("cells", []):
            if c.get("state") not in ("cited", "mentioned", "absent", None):
                bad.append("prompt %r engine %r state %r" % (
                    str(p.get("prompt"))[:40], c.get("engine"), c.get("state")))
    if bad:
        sys.exit("Invalid matrix cell state(s) (allowed: cited/mentioned/absent):\n  " + "\n  ".join(bad))

    # House rule, enforced not hoped for: no em/en dashes anywhere.
    def scan(node, path="root"):
        hits = []
        if isinstance(node, str):
            if "—" in node or "–" in node:
                hits.append((path, node[:70]))
        elif isinstance(node, dict):
            for k, v in node.items():
                hits += scan(v, path + "." + str(k))
        elif isinstance(node, list):
            for i, v in enumerate(node):
                hits += scan(v, "%s[%d]" % (path, i))
        return hits

    dashes = scan(data)
    if dashes:
        print("Em or en dashes found. House rule is commas, colons, periods, parentheses:", file=sys.stderr)
        for p, t in dashes[:12]:
            print("  %s: %s" % (p, t), file=sys.stderr)
        sys.exit(1)


def render_html(data):
    env = Environment(
        loader=FileSystemLoader(str(ASSETS)),
        autoescape=select_autoescape(["html", "j2"]),
    )
    env.globals["score_cell"] = score_cell
    env.globals["cell_class"] = cell_class
    tpl = env.get_template("analysis.html.j2")

    ctx = dict(data)
    ctx["css"] = Markup((ASSETS / "analysis.css").read_text())
    brand = data.get("brand") or {}
    ctx["brand_overrides"] = Markup(
        " ".join("--brand-%s: %s;" % (k, v) for k, v in brand.items() if k != "org_name")
    ) if brand else ""
    ctx["org_name"] = brand.get("org_name", "Strategi")
    return tpl.render(**ctx)


def to_pdf(html, out_path, data, keep_html=False):
    from playwright.sync_api import sync_playwright

    tmp = tempfile.NamedTemporaryFile("w", suffix=".html", delete=False, encoding="utf-8")
    tmp.write(html)
    tmp.close()

    footer = (
        FOOTER.replace("__ORG__", (data.get("brand") or {}).get("org_name", "Strategi"))
        .replace("__SITE__", str((data.get("client") or {}).get("name", "")))
        .replace("__DATE__", str(data.get("month_label", "")))
    )

    Path(out_path).parent.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page()
        page.goto("file://" + tmp.name, wait_until="networkidle")
        page.pdf(
            path=out_path,
            format="A4",
            print_background=True,
            display_header_footer=True,
            header_template="<div></div>",
            footer_template=footer,
            margin={"top": "18mm", "bottom": "20mm", "left": "16mm", "right": "16mm"},
        )
        browser.close()

    if keep_html:
        side = str(Path(out_path).with_suffix(".html"))
        Path(side).write_text(html, encoding="utf-8")
        print("HTML kept at %s" % side)
    else:
        os.unlink(tmp.name)


def _selfcheck():
    """The smallest runnable proof that validate/derive hold. No framework, no fixtures."""
    good = {
        "client": {"name": "Acme", "domain": "acme.com"},
        "month": "2026-07", "month_label": "July 2026",
        "scorecard": [{"key": "k", "label": "L", "value": "1/2", "tool": "t", "available": True}],
        "ai_visibility": {"prompt_matrix": {
            "engines": ["ChatGPT", "Claude"],
            "prompts": [{"prompt": "p", "cells": [
                {"engine": "ChatGPT", "state": "cited"},
                {"engine": "Claude", "state": "absent"},
            ]}],
        }},
        "tools": [{"name": "DataForSEO", "connected": True}],
    }
    validate(good)
    derive(good)
    pm = good["ai_visibility"]["prompt_matrix"]
    assert pm["coverage_pct"] == 50, pm["coverage_pct"]                      # 1 of 2 cells hit
    row = pm["prompts"][0]["row"]
    assert [c["engine"] for c in row] == ["ChatGPT", "Claude"], row          # fixed column order
    assert cell_class("cited") == "cell-good" and cell_class(None) == "cell-none"
    assert "score-bad" in str(score_cell(40)) and "score-good" in str(score_cell(95))
    assert "n/a" in str(score_cell(None))
    # A dash anywhere is a hard fail.
    try:
        validate({**good, "month_label": "July — 2026"})
    except SystemExit:
        pass
    else:
        raise AssertionError("em dash slipped past validate()")
    print("selfcheck ok")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("analysis", nargs="?", help="path to analysis.json")
    ap.add_argument("--out", help="output .pdf path")
    ap.add_argument("--keep-html", action="store_true", help="also write the intermediate HTML")
    ap.add_argument("--selfcheck", action="store_true", help="run validate/derive self-check and exit")
    args = ap.parse_args()

    if args.selfcheck:
        _selfcheck()
        return
    if not args.analysis or not args.out:
        ap.error("analysis.json and --out are required (or pass --selfcheck)")

    data = json.loads(Path(args.analysis).read_text(encoding="utf-8"))
    validate(data)
    data = derive(data)
    html = render_html(data)
    to_pdf(html, args.out, data, args.keep_html)

    size = Path(args.out).stat().st_size
    print("Wrote %s (%.0f KB)" % (args.out, size / 1024))


if __name__ == "__main__":
    main()
