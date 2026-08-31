"""blog.md + the ledger row -> the CMS ingest body.

PURE AND DETERMINISTIC BY CONTRACT. No network, no disk, no clock, no LLM: every
function here takes text in and returns data out, so the same draft always builds
the same payload. That is not a style preference. The blog that passed the
evaluator must be the blog that lands in the CMS, and a second model pass over a
scored artifact would mean shipping prose no evaluator ever saw.

The body is the draft byte for byte, minus its H1 (the H1 becomes `title`, and
sending it in both places renders the headline twice). No [[cite:N]] and no
[[block:...]] sentinels are woven into the prose: the CMS renders plain markdown
links, headings and tables perfectly well, and rewriting the draft to reference
arrays by index would edit the scored bytes to gain nothing an operator can see.
The `citations` array rides along beside the body as structured metadata.

The SEO fields (meta_title, meta_description), the byline, the category and the tag are all
built HERE, at push time, from the artifact. They are not written into blog.md and no agent
produces them: the draft on disk is unchanged by any of this, and re-deriving them is free.

EVERY ONE OF THEM IS DERIVED, NOT WRITTEN. That distinction is the whole design and it is
worth stating plainly, because "just have a model write the meta description" looks like an
obvious improvement:

    A meta description is published, client-facing copy. Every other client-facing word
    this engine ships has passed gates.py (no superlatives, no banned phrases) and a hostile
    evaluator against canonical-facts.md (no ROI language, no unapproved claims). Nothing
    downstream of the evaluator inspects a payload field. So a model writing this fresh at
    push time is the one path in this whole factory that puts unvetted prose in front of a
    client, and "Bangalore's best microbrewery" or a yield claim would sail into the CMS with
    no gate having ever seen it. Deriving from the H1 and the TL;DR inherits all of that
    vetting for free, because those already passed it.

The same logic kills model-written tags, for a second reason on top: tags are get-or-create
with no read endpoint, so a model emitting "Microbreweries" one run and "Microbrewery" the
next creates two permanent tags in a client's CMS that nobody chose.

Fields still OMITTED, because no honest source exists for them:

- Per-piece topic tags. The industry describes the CLIENT, not the piece; the roadmap's
  Format ("Hub listicle") is internal jargon; entity_names holds legal entities like
  "ALPL 3 LLP". None of those is a public taxonomy, and the ledger does not carry the
  roadmap's extras to push time anyway. Only the brand tag is sent (see build_payload).

And the CMS behaviours that shape all of the above, from the CMS team, since neither is in
the ingest spec:

- author_name is MATCH-ONLY against existing authors in the org, and a name that does not
  match is not an error: it SILENTLY falls back to the org's default author. A typo here
  therefore fails invisibly rather than loudly.
- category_name and tags are GET-OR-CREATE: an unrecognised value is CREATED in the client's
  CMS, and there is no endpoint to list what already exists. Both are emitted from closed
  vocabularies here for exactly that reason.
"""
import re
import uuid

# Generated once, hard-coded forever. CHANGING THIS VALUE ORPHANS EVERY DRAFT
# ALREADY IN THE CMS: every source_run_id shifts, so the next push of an existing
# blog creates a duplicate instead of updating the draft a reviewer is holding.
# It is an arbitrary constant and there is never a reason to "refresh" it.
NAMESPACE = uuid.UUID("b4b28127-f117-4129-bba6-c716e6efe5ae")

# The engine's label for itself in the CMS, so a reviewer can tell an automated
# draft from one a person typed.
SOURCE_SYSTEM = "geo-factory"

# The byline every pushed draft asks for, set by the operator.
#
# author_name is MATCH-ONLY at the CMS: a name matching no author in that org is not an
# error, it silently uses the org's default author. So this is a REQUEST, not a guarantee,
# and a typo here fails silently and invisibly. If a draft lands under the wrong byline,
# this constant and the org's author list disagree; fix it here, not by inventing a name.
AUTHOR_NAME = "Prasanna Kumar"

# The category sent per client, mapped from the client's industry.
#
# An EXPLICIT map, never a humanised slug. category_name is get-or-create: an unrecognised
# value is CREATED in the client's CMS and there is no read endpoint to check first, so a
# naive .title() on the slug would permanently create "Technology Saas" and "Hr Recruitment"
# in a real client's taxonomy. A closed map means this can only ever emit values written
# here on purpose. An industry absent from this map sends NO category, which a reviewer
# fills in ten seconds, rather than inventing one nobody chose.
INDUSTRY_CATEGORIES = {
    "accounting-tax": "Accounting & Tax",
    "beauty-fashion": "Beauty & Fashion",
    "education": "Education",
    "finance": "Finance",
    "healthcare": "Healthcare",
    "hospitality": "Hospitality",
    "hr-recruitment": "HR & Recruitment",
    "legal": "Legal",
    "management-consulting": "Management Consulting",
    "media-publishing": "Media & Publishing",
    "real-estate": "Real Estate",
    "technology-saas": "Technology & SaaS",
}

# Google truncates a title near 60 characters and a description near 155. These are soft
# targets for readability, not CMS limits: nothing here is rejected for length.
META_TITLE_MAX = 60
META_DESCRIPTION_TARGET = 155

# The CMS field's OWN limit, and unlike the target above this one is HARD. The editor counts the
# field and shows "211/160" in red, so an over-length description is not a display nicety, it is
# a chore handed to a person on every single push. Live on how-leather-becomes-suede: 211 against
# 160, of which a trailing source parenthetical was 53.
META_DESCRIPTION_MAX = 160

# A trailing source parenthetical, anchored to the END and required to carry a year. The TL;DR
# cites inline because the DRAFT must; a search snippet is the one place that provenance buys
# nothing, since nobody clicks a result for its citation. Requiring the year keeps "(GST
# included)" and any mid-sentence aside, which are not citations and do belong.
_TRAILING_CITATION = re.compile(r"\s*\([^()]*\d{4}[^()]*\)\s*\.?\s*$")

# Words that GRAMMATICALLY GOVERN what follows them, so a bracket attached to one is part of the
# sentence and not an aside. "...the loan closes before retirement, per (Source, 2025)." becomes
# "...before retirement, per." the moment the bracket is lifted, which is a worse artifact than
# the length it saves. Caught by tests/cms_check.py on a real Vacation Village excerpt.
# ponytail: a stop-list, not a parser. Grows a word at a time when a real excerpt trips it.
_GOVERNS_ITS_CITATION = frozenset({
    "per", "from", "in", "at", "by", "of", "to", "via", "and", "with", "see", "source", "sources",
})

# The shortest an SEO title may get by cutting. Below this the cut has destroyed the title
# rather than shortened it: "FAQ" is not a usable SEO title for anything.
META_TITLE_MIN = 20

# The schema is strict and an unknown key is a 422, so the builder emits from an
# allowlist rather than trusting itself to remember what is forbidden. status,
# published_at, slug, body_html, body_json and org_id are the CMS's to own.
ALLOWED_KEYS = frozenset({
    "ingest_schema_version",
    # The brand slug the CMS routes this draft to. ONE shared write key posts to every org, so
    # the key no longer identifies the brand; this field does. Required, not optional.
    "client",
    "source_run_id",
    "title",
    "body_markdown",
    "source_system",
    "suggested_slug",
    "excerpt",
    "meta_title",
    "meta_description",
    "target_queries",
    "author_name",
    "category_name",
    "tags",
    "citations",
    "faq",
    "stats",
    "definitions",
    "comparisons",
})

SCHEMA_VERSION = 1

# Words an SEO title must not END on once truncation has cut it. Truncating "...Craft Beer
# Under One Roof in Bangalore" at 60 leaves "...Under One Roof in", which is true and reads
# like a sentence someone walked away from. Dropping the dangling word costs nothing and
# never changes a meaning: these carry none on their own.
_TRAILING_STOPWORDS = frozenset({
    "a", "an", "and", "as", "at", "but", "by", "for", "from", "in", "into", "of", "on",
    "or", "over", "per", "the", "to", "under", "with", "your",
})

# Tokens whose full stop is not a sentence ending. "Rs." is the one that actually bites:
# it is in every Vacation Village price, so a naive split publishes a description ending
# "...plots, from Rs." with the number stranded on the other side of the cut.
_ABBREVIATIONS = frozenset({
    "rs.", "no.", "vs.", "etc.", "approx.", "est.", "inc.", "ltd.", "co.", "pvt.",
    "mr.", "mrs.", "ms.", "dr.", "st.", "jr.", "sr.", "e.g.", "i.e.", "u.s.", "u.k.",
    "sq.", "ft.", "km.", "hrs.", "yrs.", "min.", "max.", "fig.", "vol.", "ed.", "pp.",
})

# `\Z` not `$`: Python's `$` also matches just before a trailing newline, so `$` here would
# pass "my-topic\n" as a valid slug and send it, and the CMS pattern would reject it.
SLUG_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*\Z")
_H1_RE = re.compile(r"^#\s+(.+?)\s*$")
_TLDR_RE = re.compile(r"^\s*\*\*TL;DR:?\*\*:?\s*(.+)$", re.IGNORECASE)
_SOURCES_H2_RE = re.compile(r"^##\s+sources\s+and\s+references\s*$", re.IGNORECASE)
_ANY_H2_RE = re.compile(r"^##\s+")
_URL_RE = re.compile(r"https?://\S+")
_MD_LINK_RE = re.compile(r"\[([^\]]*)\]\((?:[^)]*)\)")
# The link form, with the URL captured: used to lift a source's URL out of a markdown
# bullet before any bare-URL scan sees it. Non-greedy on the target so a trailing ')' that
# closes the link is not swallowed into the URL.
_MD_LINK_URL_RE = re.compile(r"\[([^\]]*)\]\(\s*<?(https?://[^)\s>]+)>?\s*\)")


class PayloadError(ValueError):
    """The draft is missing something the CMS requires (title or body)."""


def source_run_id(client_slug, topic_slug):
    """The idempotency key: uuid5 over "<client_slug>/<topic_slug>".

    Scoped to the BRAND, not the topic alone. One API key means one org, and an
    org can hold several brands: two of them generating "second-home-buying-guide"
    would derive the same UUID from the topic by itself, and the second push would
    silently overwrite the first brand's draft instead of creating its own. The
    brand prefix costs nothing and makes that collision impossible.

    Deterministic on purpose. A random UUID would create a fresh duplicate draft
    on every re-push, which is exactly what the idempotency key exists to stop.
    """
    client_slug = (client_slug or "").strip()
    topic_slug = (topic_slug or "").strip()
    if not client_slug or not topic_slug:
        raise PayloadError("source_run_id needs both a client slug and a topic slug")
    return str(uuid.uuid5(NAMESPACE, f"{client_slug}/{topic_slug}"))


def _plain_text(markdown):
    """Markdown inline syntax reduced to the words it wraps.

    For fields the CMS renders as a plain string (the excerpt, a citation title).
    A literal "**TL;DR:** ... [Vacation Village](https://...)" in an excerpt slot
    shows an operator the asterisks and the raw URL.
    """
    text = _MD_LINK_RE.sub(r"\1", markdown)
    text = re.sub(r"\*\*([^*]+)\*\*", r"\1", text)
    text = re.sub(r"(?<!\w)[*_]([^*_]+)[*_](?!\w)", r"\1", text)
    text = text.replace("`", "")
    return re.sub(r"\s+", " ", text).strip()


def split_title(blog_md):
    """(title, body) from a draft: the first H1, and everything after it.

    The H1 line itself is dropped from the body because `title` carries it and
    the CMS renders that heading itself. Every other byte survives untouched.
    """
    lines = blog_md.splitlines()
    for index, line in enumerate(lines):
        match = _H1_RE.match(line)
        if match:
            title = match.group(1).strip()
            body = "\n".join(lines[index + 1:]).strip("\n")
            return title, body
    raise PayloadError("draft has no H1, so there is no title to send")


def extract_excerpt(body_md):
    """The TL;DR line as plain text, or None.

    Every article this engine ships carries a TL;DR directly under the H1, which
    is already a written-to-be-lifted summary, so it is the honest excerpt. A
    draft without one sends no excerpt rather than the first paragraph: an
    answer-first opening truncated mid-sentence is not a summary.
    """
    for line in body_md.splitlines():
        match = _TLDR_RE.match(line)
        if match:
            return _plain_text(match.group(1))
    return None


def extract_citations(body_md):
    """The "Sources and References" bullets, as {url, title}.

    Reads ONLY that section. Inline prose links are left alone: the same source is
    linked half a dozen times across an article, and a citation list built from
    prose would be six duplicate entries of the same URL in reading order.

    Publisher and date are NOT split out. The house citation line is
    `- Publisher, "Title," date. https://url`, but that shape holds by convention
    rather than by any gate, and a comma-split guessing wrong would attribute a
    figure to the wrong publisher. The full line rides in `title`, where a human
    reads it and nothing parses it.
    """
    lines = body_md.splitlines()
    start = None
    for index, line in enumerate(lines):
        if _SOURCES_H2_RE.match(line):
            start = index + 1
            break
    if start is None:
        return []

    citations = []
    seen = set()
    for line in lines[start:]:
        # Sources is the last section by contract, so the next H2 ends it. Honour
        # that anyway rather than reading to EOF: a draft that grows a section
        # after it must not drag that prose in as citations.
        if _ANY_H2_RE.match(line):
            break
        stripped = line.strip()
        if not stripped.startswith(("-", "*")):
            continue

        urls, label = _split_urls_and_label(stripped.lstrip("-* "))
        for url in urls:
            if url in seen:
                continue
            seen.add(url)
            entry = {"url": url}
            if label:
                entry["title"] = label
            citations.append(entry)
    return citations


def _trim_url(raw):
    """A matched URL with trailing sentence punctuation removed, parens kept balanced.

    A naive rstrip(".,;)") corrupts real URLs: Wikipedia's disambiguation form
    (".../Coffee_(beverage)") and plenty of government PDFs end in a genuine ')', and
    chopping it ships a citation link that 404s. Counting decides it instead. A ')' that
    closes a '(' inside the URL stays; one with nothing to close came from the prose
    wrapping the link, as in "(see https://x.com/a)", and goes.
    """
    url = raw
    while url and url[-1] in ".,;:!?'\"":
        url = url[:-1]
    while url.endswith(")") and url.count(")") > url.count("("):
        url = url[:-1]
    return url


def _split_urls_and_label(text):
    """(every URL in a source line, the human label left over).

    ALL urls, not just the first: a house source line may cite two documents, and taking
    only `_URL_RE.search` dropped the second citation entirely AND left its raw URL sitting
    in the first one's title, because the label was built by removing just one URL.

    Markdown links are unwrapped FIRST. "[Label](https://x)" contains a URL whose regex
    match runs to the ')', so handling it as a bare URL leaves an unbalanced "[Label](" in
    the title.
    """
    urls = []

    def _take_md_link(match):
        urls.append(_trim_url(match.group(2)))
        # The link's own text survives as part of the label: it is the source's name.
        return match.group(1)

    remaining = _MD_LINK_URL_RE.sub(_take_md_link, text)

    def _take_bare(match):
        urls.append(_trim_url(match.group(0)))
        return " "

    remaining = _URL_RE.sub(_take_bare, remaining)

    label = _plain_text(remaining)
    # The colon joins the trailing set. The house line is `Publisher, "Title," date: URL`,
    # so removing the URL strips the colon's object and leaves it dangling: this was 159 of
    # 192 real citation titles ending in a bare ':'.
    label = label.strip().rstrip(".,;: ").strip()
    return [u for u in urls if u], label


def _drop_dangling_words(text):
    """Trailing connectives left behind by a cut, removed. Also trailing punctuation.

    Only ever runs on text truncation ALREADY shortened, never on a title being kept whole:
    a real title ending in a preposition is the writer's choice and is left alone.
    """
    words = text.split()
    while len(words) > 1 and words[-1].lower().strip(",;:.") in _TRAILING_STOPWORDS:
        words.pop()
    return " ".join(words).strip().rstrip(",;:")


def meta_title_from(title):
    """An SEO title, DERIVED from the H1 rather than written fresh.

    House titles are shaped "Subject: the angle", and the subject alone is both the
    keyword-bearing half and usually already inside the length Google shows. So the colon is
    a real structural seam to cut on, not a trick: "Best Microbreweries in Bangalore: How to
    Choose, and Where BLR Brewing Co. Fits by Occasion" gives "Best Microbreweries in
    Bangalore", which is the better SEO title anyway.

    Never cuts mid-word. A title already short enough is returned untouched.
    """
    title = (title or "").strip()
    if len(title) <= META_TITLE_MAX:
        return title

    head = title.split(":", 1)[0].strip()
    # The floor matters: a title like "FAQ: ..." would otherwise yield a 3-character SEO
    # title, which is worse than a truncated one.
    if META_TITLE_MIN <= len(head) <= META_TITLE_MAX:
        return head

    clipped = _drop_dangling_words(title[:META_TITLE_MAX].rsplit(" ", 1)[0])
    # The floor again, and it is NOT redundant with the one above. Word-boundary truncation
    # cuts at the LAST space inside the limit, so a title whose first space is followed by
    # one very long word has only that space to cut at: "FAQ: <70 unbroken chars>" collapses
    # straight back to "FAQ", sailing past the check above. A hard cut keeps a usable title;
    # splitting one absurd word beats emitting three characters.
    if len(clipped) < META_TITLE_MIN:
        return title[:META_TITLE_MAX].strip()
    return clipped


def _split_sentences(text):
    """Sentences, without breaking on an abbreviation's full stop.

    A plain split on "period, then space" is wrong for this client set: "Rs." appears in
    every Vacation Village price, and "approx.", "vs." and "e.g." are ordinary in the house
    voice. Breaking there makes the FIRST sentence "...from Rs." and publishes that as the
    meta description, which reads as truncation and strands the number.

    The rule is a boundary needs a following capital or digit, and the token before it must
    not be a known abbreviation. This is not full NLP and does not need to be: it only has
    to avoid cutting a real TL;DR in the wrong place.
    """
    out = []
    for part in re.split(r"(?<=[.!?])\s+(?=[\"'(\[]?[A-Z0-9])", text):
        part = part.strip()
        if not part:
            continue
        # Glue onto the PREVIOUS piece when that piece ended on an abbreviation: the break
        # between them was the abbreviation's own full stop, not a sentence ending.
        if out and _ends_on_abbreviation(out[-1]):
            out[-1] = f"{out[-1]} {part}"
        else:
            out.append(part)
    return out


def _ends_on_abbreviation(text):
    """True when text's final token is an abbreviation rather than a sentence ending."""
    last = text.rsplit(" ", 1)[-1].strip("\"')]").lower()
    # The second test catches a single-letter initial ("J. Smith"), which no list can hold.
    return last in _ABBREVIATIONS or bool(re.fullmatch(r"[a-z]\.", last))


def _strip_trailing_citation(text):
    """Drop a trailing source parenthetical, keeping the sentence a sentence.

    The regex eats the closing full stop along with the bracket, so one is put back: the point is
    to shorten the description, never to leave it unpunctuated. Returns the input untouched when
    stripping would empty it, because no description beats an empty one.
    """
    stripped = _TRAILING_CITATION.sub("", text).strip().rstrip(",;")
    if not stripped:
        return text
    if stripped.rsplit(" ", 1)[-1].strip(",;:.").lower() in _GOVERNS_ITS_CITATION:
        return text
    return stripped if stripped[-1] in ".!?" else f"{stripped}."


def _fit_description(text):
    """Cut to META_DESCRIPTION_MAX at a WORD boundary, marking the cut with an ellipsis."""
    if len(text) <= META_DESCRIPTION_MAX:
        return text
    cut = text[:META_DESCRIPTION_MAX - 1].rsplit(" ", 1)[0].rstrip(" ,;:-")
    return f"{cut}…" if cut else f"{text[:META_DESCRIPTION_MAX - 1]}…"


def meta_description_from(excerpt):
    """An SEO description, DERIVED from the TL;DR rather than written fresh.

    Takes WHOLE SENTENCES up to the target, then GUARANTEES the CMS field's hard limit.

    THE FIRST SENTENCE IS NO LONGER EXEMPT FROM THE LIMIT, which reverses what stood here. The
    old rule let a long opening sentence through whole, arguing that "a complete true sentence
    Google truncates on display beats a mangled fragment stored in the client's CMS forever".
    The premise was wrong about where the fragment lands: the CMS field has its OWN counter, an
    over-length value shows as 211/160 in red, and the operator has to hand-edit it before the
    article can go out. So the choice was never "whole sentence versus fragment", it was "we cut
    it at a word boundary" versus "a person cuts it, on every push". Two things now keep the cut
    rare rather than routine: the trailing citation goes first, which is dead weight in a snippet
    and was 53 of the 211 characters on the live case, and only what still overflows is trimmed,
    at a word boundary with an ellipsis so the cut is visible rather than looking like the writer
    stopped mid-thought.

    WHY THIS IS NOT A MODEL CALL, which is the obvious "better" implementation and is wrong:
    a meta description is published, client-facing copy. Every other client-facing word this
    engine ships has been through gates.py (no superlatives, no banned phrases) and a hostile
    evaluator against canonical-facts.md (no ROI language, no unapproved claims). A model
    writing this field fresh at push time would bypass BOTH: nothing downstream of the eval
    inspects it, so "Bangalore's best microbrewery" or a yield claim would ship to a client's
    CMS with no gate having ever seen it. Deriving from the TL;DR inherits all of that
    vetting for free, because the TL;DR already passed it. Cutting invents no words either, which
    is what keeps that guarantee intact here.
    """
    excerpt = (excerpt or "").strip()
    if not excerpt:
        return None

    sentences = _split_sentences(excerpt)
    if not sentences:
        return None

    out = ""
    for sentence in sentences:
        candidate = f"{out} {_strip_trailing_citation(sentence)}".strip()
        # `out and` is what guarantees the first sentence is always taken whole, however
        # long: the alternative is returning nothing for a piece with one long TL;DR line.
        # _fit_description below is what then holds it to the field's hard limit.
        if out and len(candidate) > META_DESCRIPTION_TARGET:
            break
        out = candidate
    return _fit_description(out) if out else None


def category_for(industry):
    """The client's industry as a CMS category, or None if it is not in the closed map."""
    return INDUSTRY_CATEGORIES.get((industry or "").strip().lower())


def _clean_queries(prompts):
    """Target prompts as a flat list of non-empty strings.

    The ledger stores them newline-joined in one cell, matching the operator's own
    sheet. Splitting on " | " too mirrors roadmap.py, because generated sheets use
    pipes and an unsplit cell becomes one run-on query.
    """
    if not prompts:
        return []
    if isinstance(prompts, str):
        prompts = [prompts]
    queries = []
    for prompt in prompts:
        for part in re.split(r"\n|\s\|\s", str(prompt)):
            part = part.strip()
            if part and part not in queries:
                queries.append(part)
    return queries


def _fit_title(text):
    """Hold a written SEO title to META_TITLE_MAX, cutting at a word boundary.

    Shares _drop_dangling_words with meta_title_from so a clipped written title and a clipped
    derived one never end differently, and never leaves a title shorter than META_TITLE_MIN:
    below that the cut has destroyed it rather than shortened it.
    """
    text = (text or "").strip()
    if len(text) <= META_TITLE_MAX:
        return text
    clipped = _drop_dangling_words(text[:META_TITLE_MAX].rsplit(" ", 1)[0])
    return clipped if len(clipped) >= META_TITLE_MIN else text[:META_TITLE_MAX].strip()


def build_payload(client_slug, topic_slug, blog_md, prompts=None, industry=None,
                  brand_name=None, meta=None):
    """The full ingest body for one finished blog.

    Optional fields are omitted when empty rather than sent as null: the schema is
    strict, and "the pipeline produced no excerpt" is said by leaving the key out.

    `industry` and `brand_name` are PASSED IN, not read from gates.json here, so this module
    stays pure and a test can build any client's payload without a clients/ tree on disk.

    `meta` IS THE SAME KIND OF ARGUMENT, and it is what keeps this module pure while the
    operator's editorial fields get written by a model. cms/meta_gen.py runs BEFORE this and
    hands the result in; nothing here calls a model, reads a file or touches the network, so the
    same draft and the same meta still build the same body. Every key in it is OPTIONAL and
    every one is validated here rather than trusted: lengths are enforced against the same
    constants the derived path uses, so there is one implementation of each limit. An absent or
    rejected key falls back to the derived value exactly as before, which is why a model that is
    slow, missing or wrong costs a push its editorial polish and never the push itself.
    """
    meta = meta or {}
    title, body = split_title(blog_md)
    # BOTH are spec-required non-empty strings, so both are checked. The body was guarded
    # and the title was not, which left one real gap: _H1_RE's `(.+?)` matches a space, so
    # an H1 of "#" plus whitespace yields a title of "" that sails into the payload and
    # earns a 422 the operator would have to decode from the CMS.
    if not title.strip():
        raise PayloadError("draft's H1 is empty, so there is no title to send")
    if not body.strip():
        raise PayloadError("draft has an H1 and nothing else, so there is no body to send")

    payload = {
        "ingest_schema_version": SCHEMA_VERSION,
        # The routing slug: one shared key posts to any org, so the CMS reads which brand this
        # draft is for from here, not from the key. It is the CMS's OWN client slug when Settings
        # recorded one (the CMS can register a brand under a slug that differs from the engine's,
        # e.g. "bangalore-brewing-co" for a brand the engine keys as "blr-brewing"), else the
        # brand slug itself, which is how every brand posted before the override existed.
        # source_run_id below stays on the engine slug on purpose: routing is WHERE the draft
        # goes, idempotency is the brand's stable internal identity, and the two are separate.
        "client": client_slug,
        "source_run_id": source_run_id(client_slug, topic_slug),
        "title": title,
        "body_markdown": body,
        "source_system": SOURCE_SYSTEM,
        "author_name": AUTHOR_NAME,
    }

    # The WRITTEN title when there is one, else the H1-derived one. Both go through a cut to
    # META_TITLE_MAX: the model is told the limit and mostly obeys it, and "mostly" is not a
    # guarantee anyone should publish against.
    meta_title = _fit_title(meta.get("seo_title")) or meta_title_from(title)
    if meta_title:
        payload["meta_title"] = meta_title

    # A PER-PIECE category when one was written, else the client's industry.
    #
    # The industry fallback is not a lesser version of the same thing, it is a different claim:
    # it says what the CLIENT is, where a written category says what the PIECE is. Both are
    # get-or-create at the CMS, which is why the written one is screened for house violations and
    # capped in length upstream rather than sent through raw.
    category = (meta.get("category") or "").strip() or category_for(industry)
    if category:
        payload["category_name"] = category

    # ONE tag, the brand's own name, and deliberately not a per-piece keyword set.
    #
    # It earns its place in a multi-brand org: Acme Group is one org holding acme-north and
    # acme-south, so one CMS receives both brands' drafts and the brand tag is the only thing
    # separating them. It is also true by construction and its whole vocabulary is one value
    # per brand, so get-or-create cannot pollute anything.
    #
    # Per-piece topic tags are NOT sent, because no honest source for them exists. See the
    # module docstring: the industry is the client's, the roadmap's Format is internal
    # jargon, entity_names holds legal entities like "ALPL 3 LLP", and a model would emit
    # "Microbreweries" one run and "Microbrewery" the next, which get-or-create turns into
    # two permanent tags nobody chose.
    # THE BRAND TAG IS KEPT AND THE TOPIC TAGS JOIN IT, rather than replacing it. It is the only
    # thing separating two brands' drafts inside one multi-brand org's CMS, and that job does not
    # go away because the piece now carries its own subjects. Brand first, so the shared tag reads
    # as the constant it is; the written ones are already normalised and deduped by meta_gen.
    tags = []
    if brand_name and brand_name.strip():
        tags.append(brand_name.strip())
    for tag in meta.get("tags") or []:
        tag = str(tag).strip()
        if tag and tag.lower() not in {t.lower() for t in tags}:
            tags.append(tag)
    if tags:
        payload["tags"] = tags

    # The topic slug is already the engine's own lowercase-hyphen identifier, so it
    # matches the CMS pattern by construction. Send it only when it really does:
    # the CMS derives a slug from the title otherwise, which beats a 422.
    if SLUG_RE.match(topic_slug or ""):
        payload["suggested_slug"] = topic_slug

    # The WRITTEN excerpt when there is one, else the TL;DR. The TL;DR is a fine excerpt and is
    # already vetted, but it is written to open an ARTICLE, so it can run long and can carry an
    # inline citation a card has no use for.
    excerpt = (meta.get("excerpt") or "").strip() or extract_excerpt(body)
    if excerpt:
        payload["excerpt"] = excerpt

    # The description is NOT derived from whichever excerpt won, and the order matters: a written
    # description is its own field with its own job, so it is preferred outright and only falls
    # back to summarising the excerpt. Either way it goes through _fit_description, so the CMS's
    # hard 160 holds whoever wrote it.
    written_description = (meta.get("seo_description") or "").strip()
    meta_description = (
        _fit_description(_strip_trailing_citation(written_description))
        if written_description else (meta_description_from(excerpt) if excerpt else None)
    )
    if meta_description:
        payload["meta_description"] = meta_description

    citations = extract_citations(body)
    if citations:
        payload["citations"] = citations

    queries = _clean_queries(prompts)
    if queries:
        payload["target_queries"] = queries

    unknown = set(payload) - ALLOWED_KEYS
    if unknown:
        # Unreachable unless this module grows a key the CMS never agreed to. It
        # fails here, in a test, rather than as a 422 an operator has to decode.
        raise PayloadError(f"payload carries keys the CMS forbids: {sorted(unknown)}")
    return payload
