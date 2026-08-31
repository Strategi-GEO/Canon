"""The five editorial CMS fields, written by a model at push time from the finished draft.

WHAT THIS IS AND WHY IT SITS APART FROM payload.py. payload.py is pure and deterministic by
contract: text in, data out, no network and no model, so the same draft always builds the same
body. That contract is load-bearing and this module does not break it. Everything here runs
BEFORE it, hands its result in as an argument, and payload.py still validates and clips what it
receives. A failure here returns None and the payload falls back to the fields it has always
derived, so a model that is slow, absent or wrong can never block a push.

THE RISK THIS CARRIES, STATED RATHER THAN HIDDEN. payload.py's docstring argues against exactly
this: a meta description is published, client-facing copy, and every other client-facing word
this engine ships has passed gates.py and a hostile evaluator, while nothing downstream of the
eval inspects a payload field. The operator chose generation anyway, for a real reason: the
derived fields could not produce a per-piece category or topic tags at all, and "Hospitality"
plus the brand name is not a taxonomy. Two guards narrow the gap rather than pretending it is
closed:

  1. THE HOUSE SCREEN. Every generated string is run through gates.py's own banned-phrase and
     superlative lists before it is accepted, so "Bangalore's best microbrewery" is rejected here
     rather than discovered in a client's CMS. It is a subset of what a draft passes, not the
     whole of gates.py, because most gate rules (word bands, paragraph shape, H2 mapping) are
     about an article and say nothing about a 148-character sentence.

  2. THE TAG VOCABULARY. category_name and tags were get-or-create at the Strategi CMS with no
     read endpoint, so a value that did not match was CREATED permanently, and a model emitting
     "Corporate Gifting" one run and "Corporate Gifts" the next left two tags nobody chose. Every
     tag a brand had been sent was stored and fed back into the prompt so the vocabulary grew
     deliberately instead of drifting.

THREE OF THE FIVE FIELDS ARE LIVE, AND TWO ARE GENERATED AND DROPPED. The one destination left is
a client's own website, which takes `excerpt`, `meta_title` and `meta_description` and does NOT
take taxonomy by name: WordPress wants term ids, and creating terms on a client's site is a write
nobody asked for (sites.article_from_payload is where they are dropped). So `category_name` and
`tags` are still asked for and still validated, and nothing sends them; `remember_tags` is
therefore never called any more and the vocabulary stays empty. It is left in place rather than
cut because the guards above are the expensive part to get right and a future destination that
takes taxonomy by name would want them back, and because the cost of asking is a few tokens in a
session that is already running.

Neither guard makes the output vetted the way a draft is vetted. A reviewer still reads the
fields in the CMS before the post goes live, and that is the actual backstop.
"""
import asyncio
import importlib.util
import json
import os
import re

from .. import runner

# One short session over text already on disk. It reads nothing and fetches nothing, so it needs
# no MCP server and no research credential: the draft is in the prompt.
MAX_TURNS = 6
TIMEOUT_SECONDS = 120

# Where a brand's accumulated tag vocabulary lives. Beside the brand's own config, because it IS
# brand config: it describes that client's CMS taxonomy and nothing else's.
TAG_VOCAB_NAME = "cms-tags.json"

# How many tags a piece may carry. The operator's reference shows five and more than that stops
# being a taxonomy and becomes a keyword dump.
MAX_TAGS = 5

_GATES_MODULE = None


def _gates():
    """Load .claude/gates.py by path, the same way runner loads .claude/status.py: .claude is
    not a package, and the house banned-phrase and superlative lists live only there."""
    global _GATES_MODULE
    if _GATES_MODULE is None:
        path = runner.REPO_ROOT / ".claude" / "gates.py"
        spec = importlib.util.spec_from_file_location("geo_gates", path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        _GATES_MODULE = module
    return _GATES_MODULE


def house_violation(text):
    """The first house-rule breach in a generated string, or None.

    Banned phrases and superlatives ONLY. Those are the two gate rules that are about words
    rather than about the shape of an article, so they are the two that transfer to a field this
    short. Matched case-insensitively on word boundaries, exactly as gates.py matches them.
    """
    if not text:
        return None
    gates = _gates()
    for phrase in list(gates.HOUSE_BANNED_PHRASES) + list(gates.HOUSE_SUPERLATIVES):
        if re.search(rf"\b{re.escape(str(phrase))}\b", text, re.IGNORECASE):
            return str(phrase)
    return None


def _vocab_path(client_slug, clients_root=None):
    root = clients_root or (runner.REPO_ROOT / "clients")
    return root / client_slug / TAG_VOCAB_NAME


def known_tags(client_slug, clients_root=None):
    """Every tag this brand has already been sent, oldest first. [] when there are none.

    Never raises: an unreadable or malformed vocabulary is a reason to send the model no history,
    never a reason to fail a push.
    """
    try:
        with open(_vocab_path(client_slug, clients_root), encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError):
        return []
    tags = data.get("tags") if isinstance(data, dict) else data
    return [str(t) for t in tags if str(t).strip()] if isinstance(tags, list) else []


def remember_tags(client_slug, tags, clients_root=None):
    """Add these tags to the brand's vocabulary, preserving order and never duplicating.

    Called only AFTER the CMS accepted the push, because the vocabulary records what that CMS
    actually holds. Recording a tag from a push that 4xx'd would teach the next run to reuse a
    tag nobody ever created.
    """
    if not tags:
        return
    existing = known_tags(client_slug, clients_root)
    lowered = {t.lower() for t in existing}
    merged = existing + [t for t in tags if t.lower() not in lowered]
    if merged == existing:
        return
    path = _vocab_path(client_slug, clients_root)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "w", encoding="utf-8") as handle:
            json.dump({"tags": merged}, handle, indent=2, ensure_ascii=False)
    except OSError:
        # The vocabulary is an optimisation against drift, not a record anything depends on.
        # Losing a write costs the next run a reuse hint and nothing else.
        pass


def normalise_tags(raw, vocabulary=()):
    """Trim, dedupe, cap, and snap to the brand's existing casing.

    THE SNAP IS THE POINT. get-or-create means "Bengaluru" and "bengaluru" are two tags in the
    client's CMS forever, so a tag that matches a known one case-insensitively is rewritten to
    the casing already in use. Only genuinely new tags keep the model's own casing.
    """
    by_lower = {t.lower(): t for t in vocabulary}
    out, seen = [], set()
    for tag in raw or []:
        tag = re.sub(r"\s+", " ", str(tag)).strip().strip(",;·|")
        if not tag or len(tag) > 40:
            continue
        canonical = by_lower.get(tag.lower(), tag)
        if canonical.lower() in seen:
            continue
        if house_violation(canonical):
            continue
        seen.add(canonical.lower())
        out.append(canonical)
    return out[:MAX_TAGS]


PROMPT = """\
You are writing the CMS metadata for a blog post that is already written, already scored by a
hostile evaluator, and about to be published. You are NOT editing the article. Return JSON only.

THE ARTICLE (markdown, verbatim):
<<<
{body}
>>>

{vocab_block}
Return exactly this JSON object and nothing else, no prose, no code fence:

{{
  "excerpt": "Two sentences. What the piece is and why a reader should care. Plain text, no
              markdown, no links, no citation brackets.",
  "seo_title": "At most {title_max} characters. The article's subject in a searcher's words.",
  "seo_description": "At most {desc_max} characters. What the reader learns. Ends with a full stop.",
  "category": "ONE editorial category for this piece, Title Case, e.g. Buyer's Guides, How-To
               Guides, Comparisons, Industry Analysis, Local Guides.",
  "tags": ["3 to {max_tags} topic tags, Title Case, each 1 to 3 words"]
}}

HARD RULES, because these fields are published to a client's CMS and no further gate reads them:
- Every claim must already be in the article above. Invent no fact, no figure and no place.
- NO superlatives: no best, first, only, number one, leading, top, ultimate, premier.
- No marketing filler: no "unlock", "elevate", "game-changer", "in today's world", "dive into".
- No em dashes and no en dashes. Commas or colons.
- category and tags are GET-OR-CREATE in the client's CMS with no way to list what exists, so a
  near-duplicate of an existing tag creates a permanent second one. Reuse the vocabulary above
  verbatim wherever a tag fits, and coin a new one only when nothing there covers the subject.
"""

VOCAB_BLOCK = """\
TAGS THIS BRAND ALREADY USES, reuse these exact strings wherever one fits:
{tags}

"""


def _build_prompt(body, vocabulary, title_max, desc_max):
    vocab_block = VOCAB_BLOCK.format(tags="\n".join(f"- {t}" for t in vocabulary)) if vocabulary else ""
    return PROMPT.format(body=body.strip(), vocab_block=vocab_block,
                         title_max=title_max, desc_max=desc_max, max_tags=MAX_TAGS)


_JSON_RE = re.compile(r"\{.*\}", re.DOTALL)


def parse_reply(text):
    """The JSON object out of a model reply, or None. Tolerates a code fence and stray prose."""
    if not text:
        return None
    match = _JSON_RE.search(text)
    if not match:
        return None
    try:
        data = json.loads(match.group(0))
    except ValueError:
        return None
    return data if isinstance(data, dict) else None


def clean(data, vocabulary=(), title_max=60, desc_max=160):
    """A parsed reply into the fields payload.py will accept, dropping anything unusable.

    FIELD BY FIELD, never all-or-nothing: a model that writes a good excerpt and a superlative
    title should cost the push its title, not its excerpt. Every dropped field falls back to the
    derived value payload.py has always produced, so the worst case is exactly today's behaviour.
    Lengths are checked but NOT cut here: payload.py owns the clipping, so there is one
    implementation of the limit rather than two that can disagree.
    """
    if not isinstance(data, dict):
        return {}
    out = {}
    for key, limit in (("excerpt", None), ("seo_title", title_max), ("seo_description", desc_max),
                       ("category", 60)):
        value = data.get(key)
        if not isinstance(value, str):
            continue
        value = re.sub(r"\s+", " ", value).strip()
        # Dashes are a house rule the draft already passed; the model is told and sometimes
        # forgets. Substituting is safe where inventing words is not.
        value = value.replace("—", ", ").replace("–", ", ")
        value = re.sub(r"\s+,", ",", value)
        if not value or house_violation(value):
            continue
        if limit and len(value) > limit * 2:
            # Wildly over, rather than a few characters over. A field this far out is a model
            # that ignored the instruction, and clipping it would ship half a paragraph.
            continue
        out[key] = value
    tags = normalise_tags(data.get("tags"), vocabulary)
    if len(tags) >= 2:
        out["tags"] = tags
    return out


async def generate(client_slug, blog_md, title_max=60, desc_max=160, clients_root=None):
    """The five fields for one finished draft, or {} when anything at all goes wrong.

    {} IS A FIRST-CLASS ANSWER AND NEVER AN ERROR. Every caller falls back to payload.py's
    derived fields, so an absent SDK, a dead account, a timeout, a refusal or unparseable JSON
    all cost the push its editorial metadata and nothing else. A CMS push must not fail because
    a nicety could not be written.
    """
    body = (blog_md or "").strip()
    if not body:
        return {}
    vocabulary = known_tags(client_slug, clients_root)

    try:
        from claude_agent_sdk import ClaudeAgentOptions, query
    except ImportError:
        return {}

    options = ClaudeAgentOptions(
        cwd=str(runner.REPO_ROOT),
        # NO MCP AND NO TOOLS. The draft is in the prompt, so this session has nothing to fetch
        # and nothing to write. It is also why this path is exempt from the research-credential
        # refusal: a machine with no Firecrawl key can still publish.
        allowed_tools=[],
        max_turns=MAX_TURNS,
        model=os.environ.get("GEO_MODEL") or None,
        env=runner.db.agent_env() if hasattr(runner, "db") else None,
    )

    prompt = _build_prompt(body, vocabulary, title_max, desc_max)
    parts = []
    try:
        async with asyncio.timeout(TIMEOUT_SECONDS):
            async for message in query(prompt=prompt, options=options):
                for block in getattr(message, "content", None) or []:
                    text = getattr(block, "text", None)
                    if isinstance(text, str) and text.strip():
                        parts.append(text.strip())
    except (asyncio.TimeoutError, Exception):
        # Broad on purpose and it swallows: the SDK raises a bare Exception for a dead CLI (see
        # runner._sdk_session), and every failure mode here has the same correct answer, which is
        # to publish with the derived fields.
        return {}

    return clean(parse_reply("\n".join(parts)), vocabulary, title_max, desc_max)
