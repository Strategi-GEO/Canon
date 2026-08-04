#!/usr/bin/env python3
"""Deterministic mechanical gates for GEO blog drafts.

Usage: python3 .claude/gates.py --client <slug> <path-to-blog.md>

The engine is client-agnostic. HOUSE rules live here and apply to every client;
CLIENT rules are merged in from clients/<slug>/gates.json. Agent W runs this until it
exits 0, BEFORE the link pass and BEFORE the evaluator, because an eval pass is too
expensive to spend on something a script can catch.

Exit codes are three-valued on purpose, so the runner can tell a bad draft from a bad
setup:
  0  no FAILs (WARNs are allowed and still ship this stage)
  1  at least one gate FAILED (the draft is not clean yet)
  2  the run could not happen: missing/malformed gates.json, an uncompilable client
     regex, bad arguments, or an unreadable blog file. A broken config is not a
     failing draft, and confusing the two would strand the writer.

Quoted spans are exempt from the active-voice, entity-clarity and superlative gates,
because some clients require certain claims to be reproduced verbatim and those exact
strings can carry passive voice or a generic entity. The client quotes them for
fidelity, so the gates skip those spans. Quoted spans are NOT exempt from the client's
forbidden_claim_patterns: a forbidden claim stays forbidden even inside a quotation.
"""
import difflib
import json
import os
import pathlib
import re
import sys


# --- HOUSE rules: hardcoded, brand-free, apply to every client -----------------

# Generic AI filler. A client may extend this list in gates.json (for example a word
# that appears in that client's own site copy and must never be lifted).
HOUSE_BANNED_PHRASES = [
    "leveraging", "robust", "seamless", "transformative",
    "cutting-edge", "game-changer", "paradigm shift",
    "in today's digital landscape", "unlock potential", "synergy",
    "best-in-class", "world-class", "next-generation",
    "at the forefront of", "revolutionary",
]
HOUSE_HEDGES = ["might", "could", "possibly", "perhaps", "typically"]

# Unnamed generics. The writer must name the actual entity instead of these. Clients
# add their own via generic_entity_terms.
HOUSE_ENTITY_VIOLATIONS = ["the company", "the brand", "the developer", "the product"]

# Superlatives are a WARN, not a FAIL: a superlative can be legitimately sourced, and
# the evaluator judges whether it is substantiated. The gate only surfaces it.
HOUSE_SUPERLATIVES = [
    "best", "first", "only", "number one", "leading", "largest",
    "premier", "unrivalled", "unrivaled", "unmatched",
]

# Kept empty at the house level on purpose: any participial adjective worth exempting
# from active voice is client vocabulary, so it belongs in gates.json passive_whitelist.
HOUSE_PASSIVE_WHITELIST = []

# --- Competitor silence (OFF unless the client opts in) ------------------------
# A client sets "competitor_policy": "never_name" to turn this on, and lists the rival
# names it knows in "competitor_terms". It is off by default because the house rule
# elsewhere REQUIRES honest negatives, and for most clients conceding where a rival
# option wins is the thing that earns the citation. A client that opts in is choosing
# the opposite trade, and its honest negatives must then be made against options
# (asset type, location, price band, ownership model) instead of companies.
#
# The frames below are the unnamed forms, and they are the ones drafts actually reach
# for: a sentence about "most builders" talks about the competition without naming it,
# and a client that opted in banned talking about them, not merely naming them.
# NEITHER THE FRAMES NOR THE CLIENT LIST IS THE RULE. The rule is that no sentence may
# make a reader think of a specific competing company; the evaluator judges the rest.
HOUSE_COMPETITOR_FRAMES = [
    r"\bcompetitors?\b",
    r"\brivals?\b",
    r"\bthe competition\b",
    r"\bindustry peers\b",
    r"\b(other|most|many|some|several|rival|competing)\s+"
    r"(developers?|builders?|projects?|brands?|players?|operators?|promoters?|"
    r"companies|firms|vendors?|providers?|agencies|resorts?|platforms?|communities)\b",
    r"\bunlike\s+(other|most|many|some)\b",
    r"\bcompared\s+(?:to|with)\s+(other|most|many|rival|competing)\b",
    r"\bversus\s+other\b",
]

# --- Brand voice register (OFF unless the client configures it) ----------------
# "voice": {"second_person": true, "first_person_plural": true} in gates.json. The
# pronoun is only half the rule: a pronoun carries no entity, so a section written
# entirely in "we" is invisible to a knowledge graph and useless once an AI engine
# lifts it away from its surroundings. That is why the anchoring gate rides along
# with the pronoun gates and cannot be enabled separately.
HOUSE_FIRST_PERSON_PLURAL = r"\b(we|us|our|ours)\b"
HOUSE_SECOND_PERSON = r"\b(you|your|yours)\b"
# "We" means the client and nothing else. These are the readings that dissolve the
# entity by stretching "we" over the reader, the industry, or people in general.
HOUSE_GENERIC_WE = [
    r"\bwe all\b", r"\ball of us\b", r"\bmany of us\b", r"\bwe humans\b",
    r"\bwe as (?:a|an|the) \w+", r"\bwe live in\b", r"\bmost of us\b",
]

IRREGULAR_PARTICIPLES = (
    "built|sold|held|kept|set|put|made|given|taken|known|shown|drawn|grown|"
    "written|driven|seen|done|left|lost|found|told|paid|sent|meant|felt|run"
)

DEFAULT_WORD_BAND = {"min": 1200, "soft_max": 2000, "hard_max": 2500}

# The structural spec's FAQ shape: a direct opening sentence, then 75 to 300 words of
# context. The pairs gate counts questions and never reads the answers, so a six-pair
# FAQ of one-liners passed the script and lost the point at the eval instead.
FAQ_ANSWER_MIN = 75
FAQ_ANSWER_MAX = 300

# Near-duplicate prose. Threshold is 3+ occurrences, NOT 2, and the difference is the
# whole calibration: the rubric rewards self-contained sections, so a body claim
# restated once in the FAQ is the spec working rather than a defect. Three near-verbatim
# copies of one sentence is what an eval actually charged a draft for.
DUP_MIN_WORDS = 10
# 0.80, not 0.85: two copies of one claim in a live draft measured 0.837 and slipped a
# 0.85 gate. This catches lexical repetition ONLY. It cannot see semantic repetition, and
# the same draft proves the limit: a third sentence restating the identical claim in
# fresh words scored 0.648 against its twins. An evaluator charged all three as one
# defect and was right to. Treat a PASS here as "no copy-paste", never as "not repetitive".
DUP_RATIO = 0.80


# --- Text helpers (load-bearing, preserved from the single-client engine) -------

def strip_links(text: str) -> str:
    """[anchor](url) -> anchor ; ![alt](url) -> '' ; bare <url> -> ''"""
    text = re.sub(r"!\[[^\]]*\]\([^)]*\)", "", text)
    text = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", text)
    text = re.sub(r"<https?://[^>]+>", "", text)
    text = re.sub(r"https?://\S+", "", text)
    return text


def mask_quoted(text: str) -> str:
    """Blank out quoted spans and blockquotes, preserving length and newlines.

    Verbatim-permitted claims must be reproduced exactly, so they are quoted. Gates
    that would reject a client's own required wording skip these spans.
    """
    out = list(text)

    def blank(start, end):
        for i in range(start, end):
            if out[i] != "\n":
                out[i] = " "

    # Quotes wrap across line breaks in markdown prose, so newlines are allowed inside
    # a quoted span. The length cap stops an unmatched quote swallowing the document.
    for m in re.finditer(r'"[^"]{0,400}"|“[^”]{0,400}”', text):
        blank(m.start(), m.end())
    for m in re.finditer(r"^\s*>.*$", text, re.M):
        blank(m.start(), m.end())
    return "".join(out)


def split_sentences(text: str) -> list:
    text = re.sub(r"\s+", " ", text).strip()
    if not text:
        return []
    # Protect common abbreviations and decimals from the splitter.
    protected = text
    for abbr in ["sq. ft.", "Rs.", "e.g.", "i.e.", "No.", "approx.", "Ltd.", "Pvt."]:
        protected = protected.replace(abbr, abbr.replace(".", "\x00"))
    protected = re.sub(r"(\d)\.(\d)", "\\1\x00\\2", protected)
    parts = re.split(r"(?<=[.!?])\s+", protected)
    return [p.replace("\x00", ".").strip() for p in parts if p.strip()]


def sections(md: str) -> list:
    """Return (heading, body, lineno) split on H2 AND H3.

    H3 is included so each FAQ pair is its own unit: an FAQ answer is the block an AI
    engine most often extracts alone, so it has to name the entity on its own.
    """
    heads = list(re.finditer(r"^(#{2,3})\s+(.+)$", md, re.M))
    out = []
    for i, h in enumerate(heads):
        end = heads[i + 1].start() if i + 1 < len(heads) else len(md)
        out.append((h.group(2).strip(), md[h.end():end], md[:h.start()].count("\n") + 1))
    return out


def content_blocks(md: str) -> list:
    """Return (kind, text, lineno) for prose paragraphs and bullets."""
    lines = md.split("\n")
    blocks, buf, start, in_table, in_code = [], [], 0, False, False
    for i, raw in enumerate(lines, 1):
        line = raw.rstrip()
        if line.strip().startswith("```"):
            in_code = not in_code
            continue
        if in_code:
            continue
        is_table = line.lstrip().startswith("|")
        is_heading = line.lstrip().startswith("#")
        is_bullet = bool(re.match(r"^\s*([-*+]|\d+\.)\s+", line))
        if is_table:
            in_table = True
        elif not line.strip():
            in_table = False

        if not line.strip() or is_heading or is_table or is_bullet:
            if buf:
                blocks.append(("paragraph", " ".join(buf), start))
                buf = []
            if is_bullet:
                blocks.append(("bullet", re.sub(r"^\s*([-*+]|\d+\.)\s+", "", line), i))
            continue
        if not buf:
            start = i
        buf.append(line.strip())
    if buf:
        blocks.append(("paragraph", " ".join(buf), start))
    return blocks


# --- Config loading ------------------------------------------------------------

def _die(code: int, msg: str):
    sys.stderr.write("gates.py: " + msg + "\n")
    sys.exit(code)


def _repo_root() -> str:
    """The directory that contains .claude/, resolved from this file's location so the
    config path is correct no matter what the caller's cwd is."""
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _compile_patterns(items, kind, cfg_path):
    """Compile a list of {pattern, note, ...} rules. An uncompilable pattern is a
    config error, not a draft error, so it exits 2 and names the offender."""
    out = []
    if not isinstance(items, list):
        _die(2, f"'{kind}' must be a list in {cfg_path}")
    for item in items:
        if not isinstance(item, dict) or "pattern" not in item:
            _die(2, f"each '{kind}' entry needs a 'pattern' key in {cfg_path}")
        raw = item["pattern"]
        try:
            compiled = re.compile(raw, re.I)
        except re.error as e:
            _die(2, f"uncompilable regex in '{kind}' in {cfg_path}: {raw!r}: {e}")
        out.append({"re": compiled, "pattern": raw, "note": item.get("note", "")})
    return out


def load_config(client_slug: str) -> dict:
    cfg_path = os.path.join(_repo_root(), "clients", client_slug, "gates.json")
    if not os.path.exists(cfg_path):
        _die(2, f"no config for client '{client_slug}': expected {cfg_path}")
    try:
        with open(cfg_path, encoding="utf-8") as f:
            raw = json.load(f)
    except (json.JSONDecodeError, OSError) as e:
        _die(2, f"malformed gates.json at {cfg_path}: {e}")
    if not isinstance(raw, dict):
        _die(2, f"gates.json at {cfg_path} must be a JSON object")

    band = dict(DEFAULT_WORD_BAND)
    band.update(raw.get("word_band") or {})

    voice = raw.get("voice") or {}
    if not isinstance(voice, dict):
        _die(2, f"'voice' must be an object in {cfg_path}")
    policy = raw.get("competitor_policy", "") or ""
    if policy not in ("", "never_name"):
        _die(2, f"unknown competitor_policy {policy!r} in {cfg_path}: "
                f"the only value is 'never_name' (omit the key to leave it off)")

    return {
        "path": cfg_path,
        "name": raw.get("name", client_slug),
        "word_band": band,
        "voice": voice,
        "competitor_policy": policy,
        "competitor_terms": raw.get("competitor_terms", []) or [],
        "banned_phrases": raw.get("banned_phrases", []) or [],
        "entity_names": raw.get("entity_names", []) or [],
        "generic_entity_terms": raw.get("generic_entity_terms", []) or [],
        "passive_whitelist": raw.get("passive_whitelist", []) or [],
        "required_links": raw.get("required_links", []) or [],
        "forbidden_link_patterns": _compile_patterns(
            raw.get("forbidden_link_patterns", []) or [], "forbidden_link_patterns", cfg_path),
        "forbidden_claim_patterns": _compile_patterns(
            raw.get("forbidden_claim_patterns", []) or [], "forbidden_claim_patterns", cfg_path),
    }


# --- The gates -----------------------------------------------------------------

def run_gates(md: str, cfg: dict) -> list:
    stripped = strip_links(md)
    unquoted = mask_quoted(stripped)
    results = []

    def gate(name, status, detail=""):
        results.append((name, status, detail))

    def flag(name, hits, clean_msg):
        gate(name, "FAIL" if hits else "PASS", "; ".join(hits) if hits else clean_msg)

    def lineno(text, pos):
        return text[:pos].count("\n") + 1

    # --- word count (client band; measured on link-stripped text) ---------------
    band = cfg["word_band"]
    words = len(re.findall(r"\b[\w'’₹%.,-]+\b", re.sub(r"[|#*>`]", " ", stripped)))
    if words > band["hard_max"]:
        gate("word-count", "FAIL",
             f"{words} words: EXCEEDS HARD CEILING of {band['hard_max']}, must cut")
    elif words > band["soft_max"]:
        gate("word-count", "WARN",
             f"{words} words: over the {band['soft_max']} soft cap. Condense if possible, "
             f"proceed if the content earns it. Hard fail at {band['hard_max']}.")
    elif words < band["min"]:
        gate("word-count", "FAIL", f"{words} words: under the {band['min']} minimum")
    else:
        gate("word-count", "PASS",
             f"{words} words (target {band['min']}-{band['soft_max']})")

    # --- em dashes and en dashes ------------------------------------------------
    dashes = [(m.start(), m.group()) for m in re.finditer(r"[–—]", md)]
    if dashes:
        lines = sorted({lineno(md, p) for p, _ in dashes})
        gate("no-em-en-dashes", "FAIL", f"{len(dashes)} found on lines {lines}")
    else:
        gate("no-em-en-dashes", "PASS", "zero em dashes, zero en dashes")

    # --- banned phrases (house list + client extras) ----------------------------
    banned = HOUSE_BANNED_PHRASES + cfg["banned_phrases"]
    hits = []
    for phrase in banned:
        for m in re.finditer(rf"\b{re.escape(phrase)}\b", stripped, re.I):
            hits.append(f"'{phrase}' @line {lineno(stripped, m.start())}")
    flag("no-banned-phrases", hits, "zero banned phrases")

    # --- no sentence starting with And / But ------------------------------------
    hits = []
    for kind, text, ln in content_blocks(stripped):
        for s in split_sentences(text):
            if re.match(r"^(And|But)\b", s):
                hits.append(f"line {ln}: '{s[:60]}'")
    flag("no-and-but-openers", hits, "zero And/But sentence openers")

    # --- paragraph length (max 4 sentences, incl. bullets and around tables) ----
    # The house target is 2 to 4 sentences. Only the ceiling is enforced: a floor
    # produces false positives on deliberate one-line answer statements, TL;DR lines
    # and standalone quotables, which are legitimate GEO structure.
    hits = []
    for kind, text, ln in content_blocks(stripped):
        n = len(split_sentences(text))
        if n > 4:
            hits.append(f"line {ln} ({kind}): {n} sentences")
    flag("paragraph-max-4-sentences", hits,
         "every paragraph and bullet is 4 sentences or fewer")

    # --- hedging ----------------------------------------------------------------
    hits = []
    for h in HOUSE_HEDGES:
        for m in re.finditer(rf"\b{h}\b", stripped, re.I):
            hits.append(f"'{h}' @line {lineno(stripped, m.start())}")
    flag("no-hedging", hits, "zero hedging (might/could/possibly/perhaps/typically)")

    # --- active voice (quoted verbatim claims exempt) ---------------------------
    passive_wl = [w.lower() for w in (HOUSE_PASSIVE_WHITELIST + cfg["passive_whitelist"])]
    hits = []
    pattern = re.compile(
        rf"\b(is|are|was|were|be|been|being|get|gets)\s+(\w+ed|{IRREGULAR_PARTICIPLES})\b", re.I)
    for kind, text, ln in content_blocks(unquoted):
        for m in pattern.finditer(text):
            ctx = text[max(0, m.start() - 30):m.end() + 20].lower()
            if any(w in ctx for w in passive_wl):
                continue
            hits.append(f"line {ln}: '{m.group(0)}'")
    flag("active-voice", hits, "no passive constructions outside quoted verbatim claims")

    # --- entity clarity (quoted verbatim claims exempt) -------------------------
    entity_terms = HOUSE_ENTITY_VIOLATIONS + cfg["generic_entity_terms"]
    hits = []
    for e in entity_terms:
        for m in re.finditer(rf"\b{re.escape(e)}\b", unquoted, re.I):
            hits.append(f"'{e}' @line {lineno(unquoted, m.start())}")
    detail = "no unnamed-generic entity terms in live prose"
    if hits and cfg["entity_names"]:
        detail = "; ".join(hits) + "  ->  name one of: " + ", ".join(cfg["entity_names"])
    elif hits:
        detail = "; ".join(hits)
    gate("entity-clarity", "FAIL" if hits else "PASS", detail)

    # --- a client entity is named somewhere (WARN) ------------------------------
    names = cfg["entity_names"]
    if names:
        low = md.lower()
        if any(n.lower() in low for n in names):
            gate("client-entity-named", "PASS", "a client entity is named")
        else:
            gate("client-entity-named", "WARN",
                 "no client entity named: name one of " + ", ".join(names))

    # --- competitor silence (client opt-in) -------------------------------------
    # Read on `stripped`, NOT `unquoted`: a competitor named inside a quotation is
    # still named, and no verbatim-permitted claim needs a rival's name in it, so a
    # quote exemption here would protect nothing legitimate.
    if cfg["competitor_policy"] == "never_name":
        hits = []
        for pat in HOUSE_COMPETITOR_FRAMES:
            for m in re.finditer(pat, stripped, re.I):
                hits.append(f"'{m.group(0)}' @line {lineno(stripped, m.start())}")
        for term in cfg["competitor_terms"]:
            for m in re.finditer(rf"\b{re.escape(term)}\b", stripped, re.I):
                hits.append(f"competitor '{m.group(0)}' @line {lineno(stripped, m.start())}")
        gate("no-competitors", "FAIL" if hits else "PASS",
             "; ".join(hits) + "  ->  compare OPTIONS (asset type, location, price band, "
             "ownership model), never companies" if hits
             else "no competitor named, no competitor framing")

    # --- brand voice register (client opt-in) -----------------------------------
    voice = cfg["voice"]
    if voice.get("second_person"):
        n_you = len(re.findall(HOUSE_SECOND_PERSON, unquoted, re.I))
        gate("second-person-voice", "PASS" if n_you else "FAIL",
             f"{n_you} second-person references" if n_you
             else "zero 'you' anywhere: the reader is addressed directly, not as "
                  "'buyers' or 'one'")

    if voice.get("first_person_plural"):
        n_we = len(re.findall(HOUSE_FIRST_PERSON_PLURAL, unquoted, re.I))
        generic = []
        for pat in HOUSE_GENERIC_WE:
            for m in re.finditer(pat, unquoted, re.I):
                generic.append(f"'{m.group(0)}' @line {lineno(unquoted, m.start())}")
        label = cfg["entity_names"][0] if cfg["entity_names"] else cfg["name"]
        if generic:
            gate("first-person-voice", "FAIL",
                 "; ".join(generic) + f"  ->  'we' means {label} and nothing else: use "
                 "'you' for the reader and name the group where a group is meant")
        elif not n_we:
            gate("first-person-voice", "FAIL",
                 f"zero 'we/us/our': {label} speaks in first person plural, not about "
                 "itself in the third person")
        else:
            gate("first-person-voice", "PASS",
                 f"{n_we} first-person-plural references, none generic")

        # --- entity anchoring under a pronoun voice -----------------------------
        # The cost of "we" is that a pronoun carries no entity. Every block that gets
        # extracted alone (the opening, each H2 section, each FAQ pair) must name the
        # client in full somewhere inside itself. Without this, first person plural
        # trades away the entity mentions the whole engine exists to produce.
        if cfg["entity_names"]:
            named = re.compile("|".join(re.escape(n) for n in cfg["entity_names"]), re.I)
            fp = re.compile(HOUSE_FIRST_PERSON_PLURAL, re.I)
            hits = []
            first_h2 = re.search(r"^##\s+", stripped, re.M)
            opening = stripped[:first_h2.start()] if first_h2 else stripped
            if not named.search(opening):
                hits.append("the opening and TL;DR never name the client in full")
            for head, body, ln in sections(stripped):
                if "source" in head.lower():
                    continue
                if fp.search(body) and not named.search(head + " " + body):
                    hits.append(f"line {ln}: '{head[:44]}' says 'we' without naming "
                                "the entity")
            flag("entity-anchored-sections", hits,
                 "the opening and every section using 'we' also name the entity in full")

    # --- superlatives (WARN, skip quoted spans) ---------------------------------
    hits = []
    for s in HOUSE_SUPERLATIVES:
        for m in re.finditer(rf"\b{re.escape(s)}\b", unquoted, re.I):
            hits.append(f"'{s}' @line {lineno(unquoted, m.start())}")
    if hits:
        gate("superlatives", "WARN",
             "; ".join(hits) + "  ->  the eval judges whether each is substantiated")
    else:
        gate("superlatives", "PASS", "no unsubstantiated superlatives flagged")

    # --- at least one markdown comparison table ---------------------------------
    has_table = bool(re.search(r"^\|.+\|\s*$\n^\|[\s:|-]+\|\s*$", md, re.M))
    gate("comparison-table", "PASS" if has_table else "FAIL",
         "markdown table present" if has_table else "NO markdown comparison table found")

    # --- 5 to 8 H2s (count excludes the H1) -------------------------------------
    h2s = re.findall(r"^##\s+\S.*$", md, re.M)
    n_h2 = len(h2s)
    gate("h2-count-5-8", "PASS" if 5 <= n_h2 <= 8 else "FAIL",
         f"{n_h2} H2 sections (need 5-8, excluding the H1)")

    # --- TL;DR block present under the H1 ---------------------------------------
    first_h2 = re.search(r"^##\s+", md, re.M)
    tldr = re.search(r"tl;?\s?dr", md, re.I)
    tldr_ok = bool(tldr) and (first_h2 is None or tldr.start() < first_h2.start())
    gate("tldr-present", "PASS" if tldr_ok else "FAIL",
         "TL;DR block found under the H1" if tldr_ok
         else "no TL;DR block found under the H1 (before the first H2)")

    # --- FAQ block with 6+ pairs ------------------------------------------------
    faq_idx = md.lower().find("## faq")
    if faq_idx == -1:
        gate("faq-6-pairs", "FAIL", "no '## FAQ' section found")
        gate("faq-answer-length", "FAIL", "no '## FAQ' section to measure")
    else:
        tail = md[faq_idx:]
        src = tail.lower().find("## sources")
        faq_body = tail[:src] if src != -1 else tail
        # Accept H3 headings or bold questions; both are valid FAQ formats.
        qs = re.findall(r"^###\s+.+\?\s*$", faq_body, re.M)
        qs += re.findall(r"^\*\*.+\?\*\*\s*$", faq_body, re.M)
        gate("faq-6-pairs", "PASS" if len(qs) >= 6 else "FAIL",
             f"{len(qs)} question headings (need 6+)")

        # --- FAQ answers carry their 75 to 300 words ----------------------------
        # Each answer runs from its question heading to the next one, or to the end of
        # the FAQ body for the last pair. Measured link-stripped, exactly as word-count
        # measures the document, so the two gates never disagree about what a word is.
        qpat = re.compile(r"^(?:###\s+.+\?[ \t]*|\*\*.+\?\*\*[ \t]*)$", re.M)
        marks = list(qpat.finditer(faq_body))
        short, verbose = [], []
        for i, m in enumerate(marks):
            end = marks[i + 1].start() if i + 1 < len(marks) else len(faq_body)
            answer = strip_links(faq_body[m.end():end])
            n = len(re.findall(r"\b[\w'’₹%.,-]+\b", re.sub(r"[|#*>`]", " ", answer)))
            label = m.group().strip().strip("*# ")[:40]
            if n < FAQ_ANSWER_MIN:
                short.append(f"{label!r} {n}w")
            elif n > FAQ_ANSWER_MAX:
                verbose.append(f"{label!r} {n}w")
        if not marks:
            gate("faq-answer-length", "FAIL", "no question headings to measure")
        elif short:
            gate("faq-answer-length", "FAIL",
                 f"{len(short)} of {len(marks)} answers under the {FAQ_ANSWER_MIN}-word "
                 f"floor, expand them: " + "; ".join(short))
        elif verbose:
            gate("faq-answer-length", "WARN",
                 f"{len(verbose)} of {len(marks)} answers over {FAQ_ANSWER_MAX} words: "
                 + "; ".join(verbose))
        else:
            gate("faq-answer-length", "PASS",
                 f"all {len(marks)} answers within {FAQ_ANSWER_MIN}-{FAQ_ANSWER_MAX} words")

    # --- near-duplicate sentences -----------------------------------------------
    # Concision is the one graded dimension a script can see directly. This reads
    # `stripped`, NOT `unquoted`: the other gates mask quoted spans so a client's
    # required verbatim wording is never charged as passive or generic, but repetition
    # is the opposite case. Saying the same attributed claim three times is padding no
    # matter whose words it is, and §6.2 forces those repeats to be verbatim, so masking
    # quotes here would hide the one thing this gate exists to find.
    # Prose and bullets only. content_blocks() drops headings and tables, and dropping
    # them is required, not a convenience: the spec says every target prompt must be
    # reachable from an H2 or an FAQ question phrased verbatim, so an FAQ question
    # echoing its H2 is the contract being followed. Reading raw markdown here charged
    # four drafts for exactly that.
    sents = [s
             for kind, text, _ln in content_blocks(stripped)
             for s in split_sentences(re.sub(r"[|#*>`]", " ", text))
             if len(s.split()) >= DUP_MIN_WORDS]
    norms = [re.sub(r"[^a-z0-9 ]", "", s.lower()).strip() for s in sents]
    clusters, claimed = [], set()
    for i, a in enumerate(norms):
        if i in claimed or not a:
            continue
        group = [i]
        for j in range(i + 1, len(norms)):
            if j in claimed or not norms[j]:
                continue
            if difflib.SequenceMatcher(None, a, norms[j]).ratio() >= DUP_RATIO:
                group.append(j)
                claimed.add(j)
        if len(group) > 1:
            claimed.add(i)
            clusters.append(group)
    repeats = [g for g in clusters if len(g) >= 3]
    twins = [g for g in clusters if len(g) == 2]
    if repeats:
        gate("no-duplicate-sentences", "FAIL",
             "; ".join(f"{len(g)}x near-verbatim: {sents[g[0]][:64]!r}" for g in repeats))
    elif twins:
        gate("no-duplicate-sentences", "WARN",
             "restated once, allowed if the section needs to stand alone: "
             + "; ".join(f"{sents[g[0]][:64]!r}" for g in twins))
    else:
        gate("no-duplicate-sentences", "PASS",
             f"no sentence repeated near-verbatim ({len(sents)} sentences checked)")

    # --- Sources section is last ------------------------------------------------
    heads = [(m.start(), m.group().strip()) for m in re.finditer(r"^##\s+.+$", md, re.M)]
    if not heads:
        gate("sources-last", "FAIL", "no H2 sections at all")
    else:
        last = heads[-1][1].lower()
        ok = "source" in last
        gate("sources-last", "PASS" if ok else "FAIL",
             f"final section is '{heads[-1][1]}'" if ok
             else f"final H2 is '{heads[-1][1]}', expected 'Sources and References'")

    # --- required links (client) ------------------------------------------------
    for rl in cfg["required_links"]:
        url = rl.get("url", "")
        need = int(rl.get("min", 1))
        note = rl.get("note", "")
        cnt = md.count(f"]({url})")
        if cnt >= need:
            gate("required-link", "PASS", f"{cnt} link(s) to {url} (need {need})")
        else:
            msg = f"{cnt} link(s) to {url}, need {need}"
            if note:
                msg += f": {note}"
            gate("required-link", "FAIL", msg)

    # --- every cited URL was actually fetched -----------------------------------
    #
    # THE FETCH-BEFORE-CITE RULE HAD NOTHING MECHANICAL HOLDING IT UP UNTIL THIS GATE. CLAUDE.md
    # says "fetched full text, or it is not a source", the link pass inside Agent W is instructed
    # to Firecrawl every link and append it to links-verified.txt, and that file is written,
    # stored, synced and re-laid across runs. Nothing ever read it back. The sources-last gate
    # above checks that the final H2 is TITLED "Sources and References"; it does not check that
    # the section contains a reachable URL, or any URL. So the entire rule rested on an agent
    # following an instruction, with no check that would notice if it had not.
    #
    # WHAT MADE THAT URGENT rather than theoretical: an engine with no Firecrawl credential could
    # not verify a link even in principle, and until the credential check in server/runner.py
    # landed beside this, nothing told it so. A writer whose tools all 401 still produces a
    # Sources section, and every layer downstream, gates, the evaluator, the CMS, would have
    # accepted it. Two independent holes, and either one alone is enough to publish a claim
    # nobody checked.
    #
    # SCOPED TO EXTERNAL http(s) LINKS ONLY. Relative links and anchors are internal navigation,
    # not sources, and a URL is compared bare: links-verified.txt is an append-only log the agent
    # writes, so it holds whole URLs but not necessarily the exact anchor spelling around them.
    #
    # ABSENT FILE IS A FAIL AND NOT A SKIP, which is the whole point. A missing links-verified.txt
    # is not "no links to check", it is "the link pass left no evidence it ran", and skipping
    # there would make the gate silent in exactly the case it exists to catch. A draft that cites
    # nothing external has no URLs to look up and passes without the file being consulted.
    cited = sorted({
        t.strip() for t in re.findall(r"\]\(([^)\s]+)", md)
        if t.strip().lower().startswith(("http://", "https://"))
    })
    if not cited:
        gate("links-verified", "PASS", "no external links to verify")
    else:
        verified_text = cfg.get("links_verified_text")
        if verified_text is None:
            gate("links-verified", "FAIL",
                 f"{len(cited)} external link(s) cited but no links-verified.txt beside the "
                 f"draft, so nothing recorded that the link pass fetched any of them")
        else:
            # URLS PARSED OUT OF THE LOG AND COMPARED AS A SET, never a substring search of the
            # file's text. A substring test passes whenever one cited URL is a PREFIX of another
            # verified one, which is not a corner case: a homepage is a prefix of every page on
            # its own domain, so citing https://example.com and verifying only
            # https://example.com/pricing would report the homepage as verified. That is the
            # exact false PASS this gate exists to prevent, and it is likelier than the failure
            # it was hiding, because a draft that links a brand's homepage and one inner page is
            # the ordinary shape of a Sources section.
            #
            # Trailing slashes are normalised on both sides: the log is an append-only record of
            # what the agent fetched, and http://x/page and http://x/page/ are the same fetch.
            verified = {
                u.rstrip("/") for u in re.findall(r"https?://[^\s<>\]\)\"']+", verified_text)
            }
            unverified = [u for u in cited if u.rstrip("/") not in verified]
            gate("links-verified", "PASS" if not unverified else "FAIL",
                 f"all {len(cited)} cited link(s) appear in links-verified.txt" if not unverified
                 else (f"{len(unverified)} of {len(cited)} cited link(s) are not in "
                       f"links-verified.txt, so the link pass never confirmed them: "
                       f"{unverified[:5]}"))

    # --- forbidden link targets (client) ----------------------------------------
    link_targets = re.findall(r"\]\(([^)]*)\)", md)
    for fp in cfg["forbidden_link_patterns"]:
        bad = [t for t in link_targets if fp["re"].search(t)]
        if bad:
            msg = f"forbidden link target(s): {bad}"
            if fp["note"]:
                msg += f"  ({fp['note']})"
            gate("forbidden-link", "FAIL", msg)
        else:
            gate("forbidden-link", "PASS", f"no link matches /{fp['pattern']}/")

    # --- forbidden claim language (client; NOT quote-exempt) --------------------
    # Searched on link-stripped text so URLs do not trigger it, but quoted spans are
    # deliberately retained: a forbidden claim is forbidden even inside a quotation.
    for fc in cfg["forbidden_claim_patterns"]:
        found = sorted({m.group(0) for m in fc["re"].finditer(stripped)})
        if found:
            msg = f"forbidden claim language: {found}"
            if fc["note"]:
                msg += f"  ({fc['note']})"
            gate("forbidden-claim", "FAIL", msg)
        else:
            gate("forbidden-claim", "PASS", f"no match for /{fc['pattern']}/")

    return results


def print_report(results: list, path: str, client: str) -> int:
    width = max(len(n) for n, _, _ in results)
    failed = sum(1 for _, s, _ in results if s == "FAIL")
    warned = sum(1 for _, s, _ in results if s == "WARN")
    passed = sum(1 for _, s, _ in results if s == "PASS")

    print(f"MECHANICAL GATES [client: {client}]: {path}")
    print("=" * 78)
    for name, status, detail in results:
        print(f"[{status.ljust(4)}] {name.ljust(width)}  {detail}")
    print("=" * 78)
    summary = f"{passed}/{len(results)} pass"
    if warned:
        summary += f", {warned} WARN"
    summary += f"  ::  {failed} FAILING" if failed else "  ::  ALL GATES PASS"
    print(summary)
    return failed


USAGE = "usage: python3 .claude/gates.py --client <slug> <path-to-blog.md>"


def parse_args(argv):
    client, path = None, None
    i = 0
    while i < len(argv):
        a = argv[i]
        if a in ("-h", "--help"):
            print(USAGE)
            sys.exit(0)
        if a == "--client":
            if i + 1 >= len(argv):
                _die(2, "--client needs a slug\n" + USAGE)
            client, i = argv[i + 1], i + 2
            continue
        if a.startswith("--client="):
            client, i = a.split("=", 1)[1], i + 1
            continue
        if path is None:
            path, i = a, i + 1
            continue
        _die(2, f"unexpected extra argument: {a}\n{USAGE}")
    if not client or not path:
        _die(2, "both --client <slug> and a blog path are required\n" + USAGE)
    return client, path


def main(argv) -> int:
    client, path = parse_args(argv)
    cfg = load_config(client)
    try:
        md = open(path, encoding="utf-8").read()
    except OSError as e:
        _die(2, f"cannot read blog file '{path}': {e}")
    # THE LINK PASS'S OWN LOG, read from beside the draft rather than passed in, because that is
    # where the contract puts it: outputs/<slug>/<topic>/links-verified.txt sits next to blog.md,
    # and gates.py is always pointed at the draft by path. None means the file is not there, which
    # the links-verified gate treats as a FAILURE rather than as nothing to check: an absent log
    # is the link pass leaving no evidence it ran. Read here rather than inside run_gates so that
    # function stays a pure function of (text, config) and its unit tests need no filesystem.
    try:
        cfg["links_verified_text"] = (pathlib.Path(path).parent / "links-verified.txt").read_text(
            encoding="utf-8")
    except OSError:
        cfg["links_verified_text"] = None
    results = run_gates(md, cfg)
    failed = print_report(results, path, client)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
