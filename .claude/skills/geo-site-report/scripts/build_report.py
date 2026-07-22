#!/usr/bin/env python3
"""
build_report.py: render report.json into the branded PDF.

Why this exists. Hand-writing report HTML and CSS per site burns thousands of
tokens and produces a different-looking document every run, which is the exact
opposite of what a client-facing deliverable needs. Here the model produces
data only. Layout, branding, severity colours, pagination and the arithmetic
are the template's job, and they are identical on every site forever.

Anything derivable is derived here, not asked of the model: presence rate,
named and cited counts, and the traffic-light colour on every Lighthouse score.
If it can be computed it is not a field.

Usage:
    python3 build_report.py report.json --out /mnt/user-data/outputs/01-slug-audit.pdf
    python3 build_report.py report.json --out out.pdf --keep-html   # debug the layout

Schema: see references/report-schema.md. Required top-level keys are
site_name, url, audit_date, snapshot, modules, priority_fixes, deck_note.
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
REQUIRED = ["site_name", "url", "audit_date", "snapshot", "modules", "priority_fixes", "deck_note"]

FOOTER = """
<div style="width:100%;font-family:Carlito,sans-serif;font-size:7pt;color:#6B7480;
            padding:0 16mm;display:flex;justify-content:space-between;">
  <span>__ORG__ &middot; __SITE__ &middot; __DATE__</span>
  <span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>
</div>
"""


def score_cell(value):
    """Traffic-light a Lighthouse score. Google's own thresholds: 90+ green, 50-89 amber."""
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


def derive(data):
    """Compute everything computable so the model never hand-counts and never miscounts."""
    ai = data.get("ai")
    if ai and ai.get("runs"):
        runs = ai["runs"]
        ai["total_runs"] = len(runs)
        ai["named_runs"] = sum(1 for r in runs if r.get("named"))
        ai["cited_runs"] = sum(1 for r in runs if r.get("cited"))
        ai["presence_rate_pct"] = round(100.0 * ai["named_runs"] / len(runs)) if runs else 0
        ai.setdefault("limits", [])
        ai.setdefault("engines", sorted({r.get("engine", "") for r in runs if r.get("engine")}))

        # Provenance line. A visibility report is only as trustworthy as the
        # record of which model answered and whether retrieval was on, so derive
        # a one-line "engine (model)" summary from the runs when the model did
        # not supply models_line itself. Preserves engine order of appearance.
        if not ai.get("models_line"):
            seen = {}
            for r in runs:
                eng, mdl = r.get("engine"), r.get("model")
                if eng and mdl and eng not in seen:
                    seen[eng] = mdl
            if seen:
                ai["models_line"] = ", ".join("%s (%s)" % (e, m) for e, m in seen.items())

        # Note whether every run had web search on. Hard Rule 6 requires it;
        # recording it in the artifact is what lets the claim be audited.
        ws = [r.get("web_search") for r in runs if "web_search" in r]
        if ws and "web_search_note" not in ai:
            if all(ws):
                ai["web_search_note"] = "Web search (retrieval) was enabled on every run."
            else:
                ai["web_search_note"] = ("Web search was NOT enabled on every run. "
                                         "Runs without retrieval measure training memory, not live visibility.")
    # The dashboard-facing KPI block. The AI-mention total is the sum of the per-engine counts,
    # derived here so the model never hand-sums it and the PDF and the dashboard can never
    # disagree with each other about the headline number.
    metrics = data.get("metrics")
    if isinstance(metrics, dict):
        mentions = metrics.get("ai_mentions")
        if isinstance(mentions, dict):
            by_engine = mentions.get("by_engine") or []
            values = [e.get("value") for e in by_engine if isinstance(e.get("value"), (int, float))]
            mentions["total"] = int(sum(values))

    return data


def validate(data):
    missing = [k for k in REQUIRED if not data.get(k)]
    if missing:
        sys.exit("report.json is missing required keys: %s" % ", ".join(missing))

    bad = []
    for mod in data.get("modules", []):
        if mod.get("status") not in ("Strong", "Weak", "Failing", "Verify"):
            bad.append("module %r status %r" % (mod.get("name"), mod.get("status")))
        for f in mod.get("findings", []):
            if f.get("severity") not in ("High", "Medium", "Low", "Verify"):
                bad.append("finding %r severity %r" % (str(f.get("text"))[:40], f.get("severity")))
    if bad:
        sys.exit("Invalid status or severity values (allowed: Strong/Weak/Failing/Verify and "
                 "High/Medium/Low/Verify):\n  " + "\n  ".join(bad))

    # House rule, enforced rather than hoped for.
    def scan(node, path="root"):
        hits = []
        if isinstance(node, str):
            if "\u2014" in node or "\u2013" in node:
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
    tpl = env.get_template("report.html.j2")

    ctx = dict(data)
    ctx["css"] = Markup((ASSETS / "report.css").read_text())
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
        .replace("__SITE__", str(data.get("site_name", "")))
        .replace("__DATE__", str(data.get("audit_date", "")))
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


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("report", help="path to report.json")
    ap.add_argument("--out", required=True, help="output .pdf path")
    ap.add_argument("--keep-html", action="store_true", help="also write the intermediate HTML for layout debugging")
    args = ap.parse_args()

    data = json.loads(Path(args.report).read_text(encoding="utf-8"))
    validate(data)
    data = derive(data)
    html = render_html(data)
    to_pdf(html, args.out, data, args.keep_html)

    size = Path(args.out).stat().st_size
    print("Wrote %s (%.0f KB)" % (args.out, size / 1024))


if __name__ == "__main__":
    main()
