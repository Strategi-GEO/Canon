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

# The shortest an SEO title may get by cutting. Below this the cut has destroyed the title
# rather than shortened it: "FAQ" is not a usable SEO title for anything.
META_TITLE_MIN = 20

# The schema is strict and an unknown key is a 422, so the builder emits from an
# allowlist rather than trusting itself to remember what is forbidden. status,
# published_at, slug, body_html, body_json and org_id are the CMS's to own.
ALLOWED_KEYS = frozenset({
    "ingest_schema_version",
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

SLUG_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
_H1_RE = re.compile(r"^#\s+(.+?)\s*$")
_TLDR_RE = re.compile(r"^\s*\*\*TL;DR:?\*\*:?\s*(.+)$", re.IGNORECASE)
_SOURCES_H2_RE = re.compile(r"^##\s+sources\s+and\s+references\s*$", re.IGNORECASE)
_ANY_H2_RE = re.compile(r"^##\s+")
_URL_RE = re.compile(r"https?://\S+")
_MD_LINK_RE = re.compile(r"\[([^\]]*)\]\((?:[^)]*)\)")


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
        found = _URL_RE.search(stripped)
        if not found:
            continue
        url = found.group(0).rstrip(".,;)")
        if url in seen:
            continue
        seen.add(url)

        label = _plain_text(stripped.lstrip("-* ").replace(found.group(0), "")).strip()
        label = label.rstrip(".,; ").strip()
        entry = {"url": url}
        if label:
            entry["title"] = label
        citations.append(entry)
    return citations


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


def meta_description_from(excerpt):
    """An SEO description, DERIVED from the TL;DR rather than written fresh.

    Takes WHOLE SENTENCES up to the target, and if even the first sentence runs long it is
    used whole rather than cut. A complete true sentence that Google truncates on display
    beats a mangled fragment stored in the client's CMS forever.

    WHY THIS IS NOT A MODEL CALL, which is the obvious "better" implementation and is wrong:
    a meta description is published, client-facing copy. Every other client-facing word this
    engine ships has been through gates.py (no superlatives, no banned phrases) and a hostile
    evaluator against canonical-facts.md (no ROI language, no unapproved claims). A model
    writing this field fresh at push time would bypass BOTH: nothing downstream of the eval
    inspects it, so "Bangalore's best microbrewery" or a yield claim would ship to a client's
    CMS with no gate having ever seen it. Deriving from the TL;DR inherits all of that
    vetting for free, because the TL;DR already passed it.
    """
    excerpt = (excerpt or "").strip()
    if not excerpt:
        return None

    sentences = [s for s in re.split(r"(?<=[.!?])\s+", excerpt) if s.strip()]
    if not sentences:
        return None

    out = ""
    for sentence in sentences:
        candidate = f"{out} {sentence}".strip()
        # `out and` is what guarantees the first sentence is always taken whole, however
        # long: the alternative is returning nothing for a piece with one long TL;DR line.
        if out and len(candidate) > META_DESCRIPTION_TARGET:
            break
        out = candidate
    return out or None


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


def build_payload(client_slug, topic_slug, blog_md, prompts=None, industry=None,
                  brand_name=None):
    """The full ingest body for one finished blog.

    Optional fields are omitted when empty rather than sent as null: the schema is
    strict, and "the pipeline produced no excerpt" is said by leaving the key out.

    `industry` and `brand_name` are PASSED IN, not read from gates.json here, so this module
    stays pure and a test can build any client's payload without a clients/ tree on disk.
    """
    title, body = split_title(blog_md)
    if not body.strip():
        raise PayloadError("draft has an H1 and nothing else, so there is no body to send")

    payload = {
        "ingest_schema_version": SCHEMA_VERSION,
        "source_run_id": source_run_id(client_slug, topic_slug),
        "title": title,
        "body_markdown": body,
        "source_system": SOURCE_SYSTEM,
        "author_name": AUTHOR_NAME,
    }

    meta_title = meta_title_from(title)
    if meta_title:
        payload["meta_title"] = meta_title

    category = category_for(industry)
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
    if brand_name and brand_name.strip():
        payload["tags"] = [brand_name.strip()]

    # The topic slug is already the engine's own lowercase-hyphen identifier, so it
    # matches the CMS pattern by construction. Send it only when it really does:
    # the CMS derives a slug from the title otherwise, which beats a 422.
    if SLUG_RE.match(topic_slug or ""):
        payload["suggested_slug"] = topic_slug

    excerpt = extract_excerpt(body)
    if excerpt:
        payload["excerpt"] = excerpt
        # Derived from the excerpt, which is itself the TL;DR: the description therefore
        # inherits every gate and the evaluator pass the TL;DR already survived.
        meta_description = meta_description_from(excerpt)
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
