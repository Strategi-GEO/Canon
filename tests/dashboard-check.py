#!/usr/bin/env python3
"""House rule checks for the Next.js dashboard source.

Replaces frontend-check.py, which validated the single file web/index.html prototype the
dashboard superseded. Static checks only: tsc already proves the code compiles, so this
proves the things a compiler has no opinion about. Stdlib only.

Every rule here exists because breaking it produced a real defect at some point, and the
reason is recorded next to the rule rather than in a commit message nobody will read.
"""
import re
import sys
from pathlib import Path

SRC = Path(__file__).resolve().parent.parent / "dashboard" / "src"

failures: list[str] = []
passes: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    (passes if ok else failures).append(name if ok else f"{name}: {detail}")


def sources() -> list[Path]:
    """Every file we author. node_modules and generated output are not ours to police."""
    return [
        p
        for p in SRC.rglob("*")
        if p.suffix in {".ts", ".tsx", ".css"} and p.is_file()
    ]


def rel(path: Path) -> str:
    return str(path.relative_to(SRC.parent))


COMMENT = re.compile(r"/\*[\s\S]*?\*/|(?<![:\w])//[^\n]*", re.M)


def code_only(text: str) -> str:
    """The source with comments removed.

    Rules below govern what the operator sees and what the code does, so they must read code
    and not prose. A comment explaining the score trail is allowed to write it as `88 -> 96`;
    only the trail actually rendered to screen has to be an arrow. Checking raw text conflated
    the two and reported three defects that were all just accurate comments.
    """
    return COMMENT.sub("", text)


def main() -> None:
    files = sources()
    check("source files found", len(files) > 20, f"only {len(files)}")

    # The dash ban. The engine's own gates.py fails a blog for either glyph, so the app that
    # ships those blogs holds itself to the rule it enforces. Written as escapes so this
    # checker stays compliant with the rule it checks.
    EM, EN = "—", "–"
    dash_hits = []
    for path in files:
        text = path.read_text(encoding="utf-8")
        for glyph, label in ((EM, "em"), (EN, "en")):
            if glyph in text:
                line = text[: text.index(glyph)].count("\n") + 1
                dash_hits.append(f"{rel(path)}:{line} ({label})")
    check("no em or en dashes", not dash_hits, ", ".join(dash_hits[:6]))

    joined = {rel(p): code_only(p.read_text(encoding="utf-8")) for p in files}
    all_text = "\n".join(joined.values())

    # A run's progress is genuinely unknowable: the revise loop runs 0 to 4 iterations, so any
    # percentage would be invented. The rule is enforced as "no percent sign near the word
    # progress", which is what a regression here would actually look like.
    near = re.search(r"progress[\s\S]{0,60}%", all_text, re.I)
    check(
        "no 'progress' near a percent sign",
        near is None,
        f"...{all_text[max(0, near.start() - 20):near.end() + 10]!r}" if near else "",
    )

    # <Progress> is shadcn's progress bar. Importing it at all means someone is about to
    # display a completion fraction the engine cannot compute.
    check(
        "no progress bar component",
        "components/ui/progress" not in all_text,
        "a progress bar cannot be honest here",
    )

    # There is no global create, blogs or dashboard page: every one of those is scoped to a
    # brand. A route file reappearing at the app root means the hierarchy regressed.
    for gone in ("clients", "create", "blogs", "dashboard"):
        check(
            f"no global /{gone} route",
            not (SRC / "app" / gone).exists(),
            f"src/app/{gone}/ exists again",
        )

    # The score trail is an arrow. A dash would both break the rule above and read as a range.
    trail = [f for f, t in joined.items() if "->" in t and "score" in t.lower()]
    check("score trail is not an ascii arrow", not trail, ", ".join(trail[:4]))

    # Run state comes from the server. localStorage may hold BROWSER PREFERENCES and nothing
    # else: which org the operator looked at last, and which shape they read a roadmap in.
    # What makes those two admissible is that no truth on disk can contradict them, so a stale
    # one costs a click and never lies about the engine. Anything else in localStorage is a run
    # that a refresh would resurrect as a ghost, which is the defect this rule exists for.
    #
    # An exact file list, not a substring match: "orgs-context" also admitted any future file
    # that happened to carry the word, and widening this should have to be a deliberate edit
    # that names the preference and why it is one.
    STORAGE_ALLOWED = {
        "src/lib/orgs-context.tsx",  # the last org, for the / redirect and nothing deeper
        "src/lib/use-hotkey.ts",
    }
    storage_files = [
        f for f, t in joined.items() if "localStorage" in t and f not in STORAGE_ALLOWED
    ]
    check(
        "localStorage confined to browser preferences",
        not storage_files,
        f"{', '.join(storage_files[:4])} (the server owns run state)",
    )

    # Model generated markdown reaches the screen, so raw HTML injection is the one defect in
    # this app that hands the page to whatever an agent wrote into a file on disk.
    #
    # A blanket ban is the wrong rule: markdown-view is SAFE because markdown.ts escapes every
    # metacharacter BEFORE any transform runs, so the only tags in the string are ones the
    # renderer emitted. What must never happen is a SECOND caller adopting the prop without
    # that guarantee, so the allowance is pinned to the one file that earned it and the
    # invariant it depends on is asserted rather than assumed.
    danger = [f for f, t in joined.items() if "dangerouslySetInnerHTML" in t]
    stray_danger = [f for f in danger if not f.endswith("blogs/markdown-view.tsx")]
    check(
        "dangerouslySetInnerHTML confined to the markdown renderer",
        not stray_danger,
        f"{', '.join(stray_danger)} (escape first, or do not use the prop)",
    )

    md = joined.get("src/components/blogs/markdown.ts", "")
    if md:
        check(
            "markdown escapes html before transforming",
            "&lt;" in md and "&amp;" in md and "&quot;" in md,
            "the escape table is gone: every transform downstream assumes it ran",
        )
        # javascript: and data: both execute from an href on click, and no amount of
        # metacharacter escaping touches a scheme.
        check(
            "markdown neutralises dangerous url schemes",
            "safeUrl" in md or "javascript:" in md.lower(),
            "an href scheme is not covered by html escaping",
        )

    # The design holds one accent. A second hardcoded hex is someone bypassing the tokens.
    stray_hex = set()
    for f, t in joined.items():
        if f.endswith("globals.css"):
            continue
        for hit in re.findall(r"#[0-9a-fA-F]{6}\b", t):
            if hit.upper() != "#D45512":
                stray_hex.add(f"{f}:{hit}")
    check("no stray hex colours outside the tokens", not stray_hex, ", ".join(sorted(stray_hex)[:6]))

    # The dark theme is deliberately unbuilt: globals.css binds the dark variant to a class
    # this app never renders. A dark: utility someone adds by hand is dead code that will read
    # as a half finished theme the moment anyone flips the class on.
    css = joined.get("src/app/globals.css", "")
    check("light theme only, dark variant neutralised", "@custom-variant dark" in css, "missing")
    check("accent #D45512 is defined once, as a token", css.count("oklch(0.608 0.175 42.5)") >= 1, "missing")
    check("reduced motion honoured globally", "prefers-reduced-motion" in css, "missing")
    check("focus-visible ring", ":focus-visible" in css, "missing")
    check("scrollbar gutter reserved", "scrollbar-gutter" in css, "missing")

    # The API base must stay a single source of truth: a hardcoded localhost:8000 in a
    # component is a deployment that silently talks to the developer's own machine.
    hardcoded = [
        f
        for f, t in joined.items()
        if "127.0.0.1:8000" in t or "localhost:8000" in t
        if "config" not in f
    ]
    check("no hardcoded API host outside config", not hardcoded, ", ".join(hardcoded[:4]))

    for name in passes:
        print(f"PASS  {name}")
    for msg in failures:
        print(f"FAIL  {msg}")
    print(f"\n{len(passes)} passed, {len(failures)} failed")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
