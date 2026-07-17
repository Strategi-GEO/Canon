#!/usr/bin/env python3
"""Structural checks for web/index.html.

Static checks only: the frontend is built against a frozen contract, so this
verifies the file against that contract rather than driving a live server.
Driving one is also the wrong tool here, since a real run would spend API
quota. Stdlib only, plus node --check for the script block.
"""
import re
import subprocess
import sys
import tempfile
from pathlib import Path

HTML = Path(__file__).resolve().parent.parent / "web" / "index.html"

failures = []
passes = []


def check(name, ok, detail=""):
    if ok:
        passes.append(name)
    else:
        failures.append(f"{name}: {detail}")


def main():
    text = HTML.read_text(encoding="utf-8")

    # House style: no em dashes, no en dashes, anywhere in the file. The two
    # glyphs are written as escapes so this checker itself stays compliant.
    EM, EN = "\u2014", "\u2013"
    check("no em dashes", EM not in text, f"found at index {text.find(EM)}")
    check("no en dashes", EN not in text, f"found at index {text.find(EN)}")

    # Self-contained: no external asset references. API paths are relative,
    # so any absolute http(s) URL in src/href is a violation.
    ext = re.findall(r'(?:src|href)\s*=\s*["\']https?://', text, re.I)
    check("no external src/href references", not ext, f"found {len(ext)}")

    check("EventSource usage", "new EventSource(" in text, "missing")

    # Upload: the endpoint string and a real file input must both be present.
    check("upload endpoint string",
          "/roadmap/upload" in text, "missing")
    check("file input present",
          re.search(r'<input[^>]*type=["\']file["\']', text, re.I) is not None,
          "missing")
    check("csv accept attribute", ".csv,text/csv" in text, "missing")
    check("upload_id carried into generate", "upload_id" in text, "missing")

    # The duplicate ledger path: both the pre-marked rows and the 409 body.
    check("already_generated handling", "already_generated" in text, "missing")
    check("409 duplicates handling",
          "duplicates" in text and "in_flight" in text, "missing")
    check("duplicate copy names the action",
          "Deselect them to continue." in text, "missing")

    # The demo org must be labelled, never silent.
    check("demo_mode label", "demo_mode" in text, "missing")
    check("demo badge copy",
          "Precoded blogs, no API calls." in text, "missing")

    # The positional column rule replaced detection: the rule is stated and the
    # override UI is gone for good.
    check("fixed column rule stated",
          "Columns 1, 2 and 5 used" in text, "missing")
    for gone in ("wrong? override", "override-panel", "overridePanel",
                 "mappingChips", "renderMappingChips", "state.override",
                 "Apply override"):
        check(f"override UI gone: {gone!r}", gone not in text, "still present")

    # History reads /blogs, not /ledger: the ledger records only blogs that
    # shipped, while history must show every blog on disk (needs_review included)
    # and must drop anything the operator deleted in Finder.
    check("blogs endpoint", "/blogs" in text, "missing")
    check("history table with eye preview button",
          "histtable" in text and "eyeBtn" in text, "missing")
    check("eye icon is inline svg, not an external asset",
          "EYE_SVG" in text and "<svg" in text, "missing")
    check("prefers-reduced-motion block",
          "prefers-reduced-motion" in text, "missing")
    check(":focus-visible rule", ":focus-visible" in text, "missing")
    check("accent #D45512 present", "#D45512" in text, "missing")

    # Spot check on the no-percentage rule: the word progress must never sit
    # near a literal percent sign anywhere in the file.
    near = re.search(r"progress[\s\S]{0,60}%", text, re.I)
    check("no 'progress' near '%'", near is None,
          f"match at index {near.start() if near else -1}")

    # The score trail arrow must be an arrow glyph, not any kind of dash.
    check("score trail uses the arrow glyph", "→" in text, "missing")

    # Extract the single script block and let node parse it.
    m = re.search(r"<script>([\s\S]*?)</script>", text)
    check("exactly one script block",
          m is not None and text.count("<script>") == 1,
          f"count={text.count('<script>')}")
    if m:
        with tempfile.NamedTemporaryFile(
                mode="w", suffix=".js", delete=False, encoding="utf-8") as f:
            f.write(m.group(1))
            tmp = f.name
        proc = subprocess.run(["node", "--check", tmp],
                              capture_output=True, text=True)
        check("node --check on script block", proc.returncode == 0,
              proc.stderr.strip()[:400])

    for name in passes:
        print(f"PASS  {name}")
    for msg in failures:
        print(f"FAIL  {msg}")
    print(f"{len(passes)} passed, {len(failures)} failed")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
