"""Client onboarding: the clients row in Supabase, its docs, and its Resources.

WHAT A CLIENT IS, in the record (supabase/schema.sql):
  clients.slug / name / domain / industry / description   the onboarding form fields
  clients.client_md        the brand brief the engine loads (generated here at create)
  clients.canonical_facts  BINDING facts. NOT written here. See create_client.
  clients.gates            gates.json as jsonb, MINUS the "organisation" key: the org is
                           modelled as clients.org_id -> orgs, never duplicated into gates
  client_resources         the client knowledge base index; bytes live in Storage

The disk tree clients/<slug>/ is SCRATCH, laid down from the record by
sync.materialize_client because agent subprocesses read real files (gates.py,
client.md, canonical-facts.md, Resources/). This module writes the record and
re-materializes; it never treats the disk copy as the truth.

Blog OUTPUT is not here: topics and blog_versions rows are owned by the runner
and sync. blog_count below is a query over them, not a disk glob.

No concurrency primitive lives in this module. The client lock and the topic
semaphore are in runner.py and nowhere else.
"""
import json
import mimetypes
import re
from pathlib import Path

from . import db, runner, sync

REPO_ROOT = Path(__file__).resolve().parent.parent
CLIENTS_DIR = REPO_ROOT / "clients"

# The industry reference set is the source of truth for what an industry IS. A hardcoded
# list here would rot the moment someone adds a reference file, and a client.md could then
# name an industry reference that never loads. Deliberately still a glob over repo files:
# these are skill assets Agent W reads from disk every run, not client data.
INDUSTRIES_DIR = (
    REPO_ROOT / ".claude" / "skills" / "geo-content-writer" / "references" / "industries"
)

# The house default word band, matching CLAUDE.md. gates may override it per client.
HOUSE_WORD_BAND = {"min": 1200, "soft_max": 2000, "hard_max": 2500}

# A resource is a brochure, a deck, a sheet, a PDF. 25 MB is generous for that and small
# enough that a mistaken upload fails fast instead of filling Storage.
MAX_RESOURCE_BYTES = 25 * 1024 * 1024

# Browser-supplied filenames are untrusted input. Everything outside this set becomes an
# underscore, so a name can never carry a path separator, a dot-dot, or a shell character.
_SAFE_RESOURCE_CHARS = re.compile(r"[^A-Za-z0-9._ -]")


class ClientError(Exception):
    """Base for onboarding refusals, so app.py can map them to status codes."""


class ClientExists(ClientError):
    """The slug is taken. Never overwrite: a live client's config is not ours to replace."""


class InvalidClient(ClientError):
    """The name cannot produce a usable slug, or the slug is reserved."""


class UnknownClient(ClientError):
    """No clients row with this slug."""


class BadResource(ClientError):
    """An upload whose filename or size makes it unusable."""


def slugify_client(name):
    """Brand name -> slug: lowercase, runs of non-alphanumerics to one hyphen.

    Deliberately the same normalisation roadmap.slugify applies to topics, because a slug
    is a path segment either way and two brands that differ only in punctuation must not
    quietly become two records.
    """
    return re.sub(r"[^a-z0-9]+", "-", str(name or "").lower()).strip("-")


def resources_dir(slug):
    """clients/<slug>/Resources/, capital R: the SCRATCH copy of the knowledge base.

    The path is exact on purpose: the engine contract names clients/<slug>/Resources/ as
    the folder every agent reads before any external search, and sync.materialize_client
    lays it down from Storage under exactly this name. A lowercase variant would create a
    folder uploads land in and no agent ever opens.
    """
    return CLIENTS_DIR / slug / "Resources"


def list_industries():
    """The exact reference filenames, without .md. Read, never hardcoded: see INDUSTRIES_DIR."""
    if not INDUSTRIES_DIR.is_dir():
        return []
    return sorted(path.stem for path in INDUSTRIES_DIR.glob("*.md"))


def _normalize_industry(industry):
    """Map a detected industry name to a known reference name, "Others", or "".

    Onboarding detection is free text from a model, so it is pinned to the reference set here: an
    exact (case-insensitive) match becomes the canonical reference filename, a non-empty value that
    matches nothing becomes "Others", and a blank stays blank. This is the one thing that keeps
    client.md from ever naming an industry reference file that does not exist.
    """
    raw = str(industry or "").strip()
    if not raw:
        return ""
    by_lower = {name.lower(): name for name in list_industries()}
    return by_lower.get(raw.lower(), "Others")


def set_onboarding_industry(slug, industry):
    """Persist an auto-detected industry and point client.md at the right reference.

    Runs from the onboarding describe job, seconds after create_client, and mirrors how the
    description is written back: the operator never picks or edits it. The industry column and the
    gates.json "industry" key are always updated. client.md is regenerated ONLY while it is still
    the unedited onboarding template create_client wrote, so an operator who later fills in the
    Market section by hand never has it wiped by a re-run of this. _client_md is deterministic, so
    that comparison is exact.
    """
    cid = db.client_id(slug)
    if not cid:
        raise UnknownClient(f"unknown client {slug!r}")
    name, domain, old_industry, client_md = db.q(
        "select name, domain, industry, client_md from clients where id = %s", (cid,), fetch="one")
    industry = _normalize_industry(industry)

    sets = ["industry = %s", "gates = jsonb_set(gates, '{industry}', %s::jsonb)"]
    params = [industry, json.dumps(industry)]
    if client_md == _client_md(name or slug, domain or "", old_industry or "", slug):
        sets.append("client_md = %s")
        params.append(_client_md(name or slug, domain or "", industry, slug))

    db.q(f"update clients set {', '.join(sets)} where id = %s", (*params, cid), fetch="none")
    db.invalidate_client_cache()
    sync.materialize_client(slug)
    return read_client(slug)


def exists(slug):
    """A client is a live clients row: deleted_at null. db.client_id is the one gate."""
    return db.client_id(slug) is not None


# Every read of a client goes through this one statement, so list and single reads cannot
# disagree on a count or a flag. blog_count counts topics that actually carry a committed
# blog version, which is the record's answer to what _blog_count used to glob off disk.
_CLIENT_SELECT = """
    select c.slug, c.name, c.domain, c.industry, c.description,
           c.custom_instructions,
           c.created_at,
           exists (select 1 from roadmap_sheets r where r.client_id = c.id)
             as has_roadmap,
           (c.canonical_facts is not null) as has_canonical_facts,
           (select count(*) from client_resources cr where cr.client_id = c.id)
             as resource_count,
           (select count(*) from topics t
             where t.client_id = c.id and t.deleted_at is null
               and exists (select 1 from blog_versions v where v.topic_id = t.id))
             as blog_count,
           o.slug as org_slug, o.name as org_name
    from clients c
    left join orgs o on o.id = c.org_id
    where c.deleted_at is null
"""


def _client_from_row(row):
    (slug, name, domain, industry, description, custom_instructions,
     created_at, has_roadmap, has_facts, resource_count, blog_count,
     org_slug, org_name) = row
    return {
        "slug": slug,
        "name": name or slug,
        # The org is a grouping over brands, resolved here so every reader of a client
        # sees the same answer. An explicit org comes from the orgs join; a client with
        # org_id null is its own single-brand org, synthesised on read and deliberately
        # never stored, exactly as the gates.json "organisation" key was never written
        # for the self case: two stored copies drift after a rename.
        "organisation": {"slug": org_slug, "name": org_name} if org_slug
                        else {"slug": slug, "name": name or slug},
        "domain": domain or "",
        "industry": industry or "",
        "description": description or "",
        # The brand's standing blog instructions, so the Settings tab can show and edit them.
        # Operator material: present on the engine's own record (owner connection), never on the
        # hosted authenticated read, which does not select this column.
        "custom_instructions": custom_instructions or "",
        "has_roadmap": bool(has_roadmap),
        "has_canonical_facts": bool(has_facts),
        "resource_count": resource_count,
        "blog_count": blog_count,
        "created": created_at.isoformat() if created_at else "",
    }


def list_clients():
    """Every live client, sorted by slug in byte order.

    collate "C" reproduces the old sorted(CLIENTS_DIR.iterdir()) exactly: the underscore
    fixture sorts before the lowercase slugs, as it did on disk.
    """
    rows = db.q(_CLIENT_SELECT + ' order by c.slug collate "C"')
    return [_client_from_row(row) for row in rows]


def read_client(slug):
    row = db.q(_CLIENT_SELECT + " and c.slug = %s", (slug,), fetch="one")
    if row is None:
        raise UnknownClient(f"unknown client {slug!r}")
    return _client_from_row(row)


def list_orgs():
    """Orgs grouped from the clients themselves: [{"slug","name","brands":[client, ...]}].

    Explicit orgs come from the orgs rows through the client join; every other brand is
    its own single-brand org, derived on read. The brand stays the engine's unit of work
    because one brand owns exactly one canonical_facts, entity-name set and roadmap.
    """
    grouped = {}
    for client in list_clients():
        # _fixture-unreviewed is a test fixture for the preflight refusal, not a brand
        # anyone writes for. It stays visible in GET /api/clients, which the existing
        # tests read, but it must never appear as an org an operator could create blogs in.
        if client["slug"].startswith("_"):
            continue
        org = client["organisation"]
        entry = grouped.setdefault(org["slug"], {"slug": org["slug"], "name": org["name"], "brands": []})
        entry["brands"].append(client)

    orgs = sorted(grouped.values(), key=lambda o: o["name"].lower())
    for org in orgs:
        org["brands"].sort(key=lambda brand: brand["name"].lower())
    return orgs


def read_org(org_slug):
    for org in list_orgs():
        if org["slug"] == org_slug:
            return org
    return None


def _client_md(name, domain, industry, slug):
    """The readable brief, built from the form fields only.

    It states what the operator gave us and points at the operator-owned files for the
    rest. It invents no fact about the brand: anything not on this form is not established,
    and a brief that guessed would be read by Agent W as though a human had approved it.
    """
    # A known industry has a reference file the writer must read. "Others", a vertical with no
    # reference, or a blank (not yet detected) have none, so the brief says so plainly rather than
    # pointing Agent W at a file that does not exist.
    if industry and industry in set(list_industries()):
        industry_ref = f".claude/skills/geo-content-writer/references/industries/{industry}.md"
        industry_line = (
            f"Industry: {industry}. Agent W MUST read `{industry_ref}` on every run. Skipping the "
            f"industry reference produces generic content that does not fit this client."
        )
    else:
        industry_line = (
            f"Industry: {industry or '(not yet detected)'}. No industry-specific reference applies "
            f"(general or Others), so Agent W writes to the general GEO guidance without a vertical "
            f"reference."
        )
    return f"""# client.md: {name}

The brand brief the engine loads for this client. It was generated at onboarding from the
operator's form. Every binding fact lives in `canonical-facts.md`, and where this brief and
`canonical-facts.md` disagree, `canonical-facts.md` wins.

## Identity
Brand name: {name}, and nothing else. There is no connection to any other client, past or
present. The operator-owned brand description is `clients/{slug}/description.md`. Read it as
context, never as a citable source.

## Domain
Primary domain: {domain or "(not recorded at onboarding)"} . The live site wins over internal
docs on any conflict. If a fact is not in `canonical-facts.md`, it is not established: fetch
it, do not infer it.

## Market
Not recorded at onboarding. DataForSEO needs a location and language named here, so an
operator MUST fill this section in before the first real run. Do not guess a market from the
domain suffix.

## Industry reference
{industry_line}

## Entity names (the only permitted ways to name things)
Name things only as: {name}. Never use a generic stand-in such as "the company", "the brand",
or "the product". Add every further permitted entity name to `entity_names` in
`clients/{slug}/gates.json`, which is what the gates read.

## Link architecture
Every mention of this client's primary project or entity links to the canonical URL named in
`canonical-facts.md`. Never fabricate or guess a slug. Never cite this client's own blog as
evidence for a fact: it is marketing copy.

## Do not claim
The binding list is `canonical-facts.md`. Its do-not-claim section is authoritative for this
client, and no blog may make a claim it forbids.

## Resources
`clients/{slug}/Resources/` is this client's knowledge base. Read it before any external
search. Record any per-file exclusion in `canonical-facts.md`, for example an image-only PDF
with no extractable text is not a citable source.
"""


def _org_config_value(organisation_name):
    """An organisation_name -> {"slug","name"}, or None for "no explicit org".

    Blank means the brand is its own single-brand org, which the record states with a
    null org_id and nothing else. Returning a self-referencing org here would store one
    fact in two places and let them disagree later.
    """
    org_name = str(organisation_name or "").strip()
    if not org_name:
        return None
    org_slug = slugify_client(org_name)
    if not org_slug:
        raise InvalidClient("an organisation name must contain at least one letter or digit")
    return {"slug": org_slug, "name": org_name}


# ---------------------------------------------------------------------------
# The org and client slug namespaces overlap, and the CMS write key is the one
# place where that is dangerous
# ---------------------------------------------------------------------------
# orgs.slug and clients.slug are each `not null unique` in SEPARATE tables
# (supabase/schema.sql), so the record happily holds an org called "acme" and an
# unrelated brand called "acme" at the same time. Nothing in the schema compares
# the two namespaces. For everything else in this module that is harmless: an org
# is a grouping, a client is a brand, and the two are joined by org_id and never
# by name.
#
# The CMS write key is where it stops being harmless. A brand with org_id null is
# its own single-brand org, synthesised on read by _client_from_row above, and
# server/cms/routes.py turns that synthesised slug into the environment variable
# STRATEGI_CMS_WRITE_KEY_<ORG>. So a brand "acme" with no org of its own asks for
# exactly the variable the real org "acme" asks for, and it is handed that org's
# key. server/cms/client.py spends twelve lines on why that particular outcome is
# the worst one available: the CMS derives the destination org FROM THE KEY, the
# payload is forbidden from carrying org_id, so neither side of the request can
# notice that a draft went to the wrong tenant. One client's blog lands in
# another client's CMS and both sides report success.
#
# The invariant the guards below keep is one sentence: NO CLIENT WITH org_id NULL
# MAY SHARE ITS SLUG WITH AN orgs ROW. Note what it deliberately does NOT forbid.
# A brand that BELONGS to an org of its own name is fine and common, because an
# operator who names an org after its flagship brand has said those are the same
# tenant, and the key that resolves is that org's own key. The danger is only ever
# the SYNTHESISED org, which is a name nobody chose to point at that org.

def _self_org_clients(org_slug):
    """Brands that would answer to org_slug's CMS write key WITHOUT belonging to it.

    A client with org_id null synthesises its own slug as its org, so this is
    exactly the set of rows that would silently resolve this org's key. A client
    that HAS an org is not in this set even when the slugs match, because its key
    comes from its org_id and never from the synthesis.
    """
    rows = db.q(
        """select slug from clients
           where slug = %s and org_id is null and deleted_at is null""",
        (org_slug,))
    return [row[0] for row in rows]


def _refuse_org_slug_collision(org_slug, for_client=None):
    """Refuse an org whose slug a self-org brand already answers to.

    `for_client` is the brand being written in this same operation, and it is
    exempt for a concrete reason: it is about to STOP being a self-org brand,
    because create_client and update_client both point its org_id at this very
    row. By the time anything resolves a key the synthesis is gone and the match
    is the deliberate "org named after its flagship brand" case, which is legal.

    The refusal is InvalidClient because app.py already maps that to 422, and the
    operator has typed an org name that cannot be used, which is the same class of
    answer as an org name with no letters in it. A new exception class would be a
    new mapping in a file this fix has no business editing.
    """
    colliding = [slug for slug in _self_org_clients(org_slug) if slug != for_client]
    if colliding:
        raise InvalidClient(
            f"the organisation slug {org_slug!r} is already the slug of the brand "
            f"{colliding[0]!r}, which has no organisation of its own. The two would "
            f"resolve the same CMS write key, so one brand's blog would publish into "
            f"the other's CMS. Rename the organisation, or give that brand this "
            f"organisation first."
        )


def _org_row_exists(org_slug):
    return bool(db.q("select 1 from orgs where slug = %s", (org_slug,), fetch="val"))


def _refuse_self_org_collision(client_slug):
    """The same invariant from the other side: a brand may not BECOME a self-org
    brand whose slug an orgs row already owns.

    This fires on the two writes that leave org_id null: onboarding a brand with
    the organisation field blank, and clearing an existing brand's organisation
    back to blank. Without it the guard above is half a guard, because a brand can
    walk into the collision just as easily as an org can walk into it.
    """
    if _org_row_exists(client_slug):
        raise InvalidClient(
            f"the brand slug {client_slug!r} is already an organisation slug, so a brand "
            f"with no organisation of its own would resolve that organisation's CMS write "
            f"key and publish into its CMS. Give this brand an explicit organisation, or "
            f"rename the organisation holding that slug."
        )


def synthesised_org_collides(client_slug):
    """True when THIS brand's SYNTHESISED org is also a real org's slug. The safety net.

    The two guards above stop the collision being written from now on. They do
    nothing about a collision already sitting in the record, and they cannot: a
    row written before they existed was legal when it was written. This is the
    read-time half of the fix, called by server/cms/routes.py immediately before a
    key is resolved, and it is the half that has to hold, because that call is the
    last moment anything in the system can still tell the two orgs apart.

    A brand with an explicit org is never a collision here, however its slug reads,
    for the same reason the write guard exempts it: the org_id is the operator's
    own statement about which tenant the brand belongs to.
    """
    row = db.q(
        """select c.org_id is null,
                  exists (select 1 from orgs o where o.slug = c.slug)
           from clients c
           where c.slug = %s and c.deleted_at is null""",
        (client_slug,), fetch="one")
    if row is None:
        return False
    synthesised, org_exists = row
    return bool(synthesised) and bool(org_exists)


def _upsert_org(org_config, for_client=None):
    """The orgs row for an explicit org, created or renamed in place. Returns its id.

    on conflict updates the name so the org rename an operator typed actually lands:
    orgs.slug is the identity, the name is display.

    The collision guard runs BEFORE the insert, so a refused org name leaves no row
    behind and the caller's client write never starts.
    """
    _refuse_org_slug_collision(org_config["slug"], for_client=for_client)
    return db.q(
        """insert into orgs (slug, name) values (%s, %s)
           on conflict (slug) do update set name = excluded.name
           returning id""",
        (org_config["slug"], org_config["name"]), fetch="val")


def create_client(name, domain, industry, description="",
                  organisation_name=None):
    name = str(name or "").strip()
    slug = slugify_client(name)
    if not slug:
        raise InvalidClient("a client name must contain at least one letter or digit")
    if slug.startswith("_"):
        # Unreachable through slugify_client, which strips leading punctuation, but the
        # guard is the contract: a leading underscore marks a test fixture such as
        # _fixture-unreviewed, and onboarding must never be able to mint or collide
        # with one.
        raise InvalidClient(f"the slug {slug!r} is reserved: names starting with _ are fixtures")
    # Soft-deleted rows still hold their slug (the unique constraint spans them), so the
    # existence check deliberately ignores deleted_at: reviving a dead slug is a decision
    # for a human with database access, not for an onboarding form.
    if db.q("select 1 from clients where slug = %s", (slug,), fetch="val"):
        raise ClientExists(f"client {slug!r} already exists")

    # Validated before any write, so a bad org name refuses cleanly instead of leaving a
    # half-built client in the record.
    org_config = _org_config_value(organisation_name)
    if org_config is None:
        # A blank organisation means this brand becomes its own single-brand org, so its
        # slug enters the org namespace by synthesis and can collide with a real org
        # there. Refused here, before any write, for the same reason the org name is
        # validated here: a refusal after the orgs upsert leaves a row nobody asked for.
        _refuse_self_org_collision(slug)

    industry = str(industry or "").strip()
    domain = str(domain or "").strip()

    # gates.json as it will be materialized to disk, MINUS "organisation": the org lives
    # in org_id and is never duplicated into gates.
    config = {
        "client": slug,
        "name": name,
        "domain": domain,
        "industry": industry,
        "word_band": dict(HOUSE_WORD_BAND),
        # Empty, not seeded with a guess: the house banned-phrase list already covers the
        # generic AI phrases, and this list is only for phrases from THIS brand's own copy,
        # which nobody has read yet.
        "banned_phrases": [],
        "entity_names": [name],
        "generic_entity_terms": [],
        "passive_whitelist": [],
        "required_links": [],
        "forbidden_link_patterns": [],
        "forbidden_claim_patterns": [],
    }

    # for_client exempts the brand being created: it is about to carry this org's id, so
    # a matching slug is the flagship-brand case and not a synthesised collision.
    org_id = _upsert_org(org_config, for_client=slug) if org_config is not None else None

    # canonical_facts is NOT written here, and onboarding must never write it. It is
    # BINDING: every blog for this client inherits it, and the runner refuses a real run
    # when it is missing or still unreviewed. A value this module invented would either be
    # a fabrication or a placeholder that merely looks approved, and both defeat the
    # preflight. It is drafted at generate time and approved by a human before it exists.
    try:
        db.q(
            """insert into clients
                 (org_id, slug, name, domain, industry, description, client_md,
                  gates)
               values (%s, %s, %s, %s, %s, %s, %s, %s::jsonb)""",
            (org_id, slug, name, domain, industry, str(description or ""),
             _client_md(name, domain, industry, slug),
             json.dumps(config, ensure_ascii=False)),
            fetch="none")
    except Exception as exc:
        # Two concurrent creates both pass the pre-check; the unique constraint catches
        # the loser, and it must surface as the same 409 the pre-check produces.
        from psycopg import errors as pg_errors
        if isinstance(exc, pg_errors.UniqueViolation):
            raise ClientExists(f"client {slug!r} already exists")
        raise
    db.invalidate_client_cache()

    # The two onboarding side effects the app still relies on. The output folder is
    # scratch an operator can find in Finder before the first blog runs. Materialization
    # lays clients/<slug>/ down from the record (gates.json, client.md, Resources/) so the
    # first run finds its files without a separate sync step. The old generated.csv create
    # is gone: the ledger is a table now.
    runner.ensure_client_output_dir(slug)
    sync.materialize_client(slug)
    return read_client(slug)


def update_client(slug, description=None, name=None, organisation_name=None,
                  domain=None, industry=None, custom_instructions=None):
    """Update only what was passed. A None field is untouched, so a PATCH carrying one key
    cannot blank the others, and gates keys this function was not given survive."""
    cid = db.client_id(slug)
    if not cid:
        raise UnknownClient(f"unknown client {slug!r}")

    sets, params = [], []
    if description is not None:
        sets.append("description = %s")
        params.append(str(description))
    # The brand's standing blog instructions. Column only, never the gates blob: nothing in
    # gates reads it, and the next agent run reads clients/<slug>/custom-instructions.md, which
    # sync.materialize_client lays down from this column below. Empty string is a real value
    # here (the operator clearing their instructions), so only None means "not sent".
    if custom_instructions is not None:
        sets.append("custom_instructions = %s")
        params.append(str(custom_instructions))
    if name is not None:
        new_name = str(name).strip()
        if not new_name:
            raise InvalidClient("a client name cannot be blank")
        # The slug is NOT recomputed: it keys clients/<slug>/, outputs/<slug>/, and every
        # status.jsonl an SSE stream is tailing right now, and the schema declares it
        # immutable. The gates copy of the name moves with the column so the materialized
        # gates.json keeps saying what the record says.
        sets.append("name = %s")
        params.append(new_name)
        sets.append("gates = jsonb_set(gates, '{name}', %s::jsonb)")
        params.append(json.dumps(new_name))
    # domain and industry: the two fields the settings page has always sent and this function
    # has always dropped. They are written to the column only, never into the gates blob: the
    # name is mirrored there because gates.py prints it, and nothing in gates reads either of
    # these.
    if domain is not None:
        sets.append("domain = %s")
        params.append(str(domain).strip())
    if industry is not None:
        sets.append("industry = %s")
        params.append(str(industry).strip())
    if organisation_name is not None:
        # Moving a brand between orgs rewrites ONE column and renames NO slug. Blank
        # clears back to its own single-brand org, which is what a null org_id means.
        org_config = _org_config_value(organisation_name)
        if org_config is None:
            # Clearing the org sends this brand back to its own synthesised single-brand
            # org, which is a brand walking into the slug collision rather than an org
            # walking into it. Same invariant, other direction, and it has to be checked
            # here because nothing else on this path touches the orgs table at all.
            _refuse_self_org_collision(slug)
            sets.append("org_id = null")
        else:
            sets.append("org_id = %s")
            params.append(_upsert_org(org_config, for_client=slug))

    if sets:
        db.q(f"update clients set {', '.join(sets)} where id = %s",
             (*params, cid), fetch="none")
        # Scratch tracks the record: the next agent run reads gates.json from disk, and it
        # must say what was just recorded.
        sync.materialize_client(slug)

    return read_client(slug)


# ---------------------------------------------------------------------------
# Resources
# ---------------------------------------------------------------------------

def list_resources(slug):
    """The client's knowledge-base index, from the record.

    collate "C" on lower(name) reproduces the old Python key=name.lower() sort exactly,
    underscores before letters included.
    """
    cid = db.client_id(slug)
    if not cid:
        return []
    rows = db.q(
        """select name, size_bytes, uploaded_at, content_type from client_resources
           where client_id = %s order by lower(name) collate "C" """,
        (cid,))
    return [
        # content_type falls back to a filename guess: rows migrated before the
        # column existed hold NULL, and the UI renders a type badge off this.
        {"name": name, "size": size,
         "modified": uploaded_at.isoformat() if uploaded_at else "",
         "content_type": ctype or mimetypes.guess_type(name)[0] or ""}
        for name, size, uploaded_at, ctype in rows
    ]


def safe_resource_name(filename):
    """Untrusted browser-supplied name -> a name safe to store and to join onto a path.

    The filename arrives from a browser and is attacker controlled: "../../../etc/passwd"
    is the canonical case. Take the basename, drop separators, allow only a known-good
    character set, and cap the length so a long name cannot break the filesystem's own
    limit. An empty result is a refusal, never a generated fallback, because saving a file
    under a name the operator did not choose hides what was uploaded.
    """
    raw = str(filename or "")
    # A path separator or a dot-dot segment is REFUSED, not quietly basenamed. A browser
    # sends a bare filename, so a name carrying a path is an attack or a broken client
    # either way. Basenaming it would store "../../../etc/passwd" as "passwd" and answer
    # 201, telling the caller the upload succeeded under a name nobody chose. The
    # sanitiser below still runs as defence in depth for callers that are not HTTP.
    if "/" in raw or "\\" in raw or ".." in Path(raw).parts:
        raise BadResource(
            f"the filename {filename!r} contains a path; upload a plain filename"
        )
    name = _SAFE_RESOURCE_CHARS.sub("_", Path(raw).name).strip(" ._-")
    if not name:
        raise BadResource(f"the filename {filename!r} has no usable characters")
    return name[:120]


def _inside_resources(slug, name):
    """Resolve and confirm containment. Same guard the output endpoint uses: the resolved
    path must stay inside this client's Resources dir even if the name smuggles separators
    or dot-dots past the caller. Still needed for the SCRATCH copy this module writes."""
    root = resources_dir(slug).resolve()
    path = (root / name).resolve()
    if root not in path.parents:
        return None
    return path


def save_resource(slug, filename, raw_bytes):
    if not exists(slug):
        raise UnknownClient(f"unknown client {slug!r}")
    if len(raw_bytes) > MAX_RESOURCE_BYTES:
        raise BadResource(
            f"file is {len(raw_bytes)} bytes; the resource limit is {MAX_RESOURCE_BYTES} bytes"
        )
    if not raw_bytes:
        raise BadResource("the uploaded file is empty")

    name = safe_resource_name(filename)
    path = _inside_resources(slug, name)
    if path is None:
        raise BadResource(f"the filename {filename!r} does not resolve inside Resources")

    # The record first: Storage plus the client_resources index row.
    db.resource_add(slug, name, raw_bytes,
                    content_type=mimetypes.guess_type(name)[0])

    # Then the scratch copy, because the next run reads Resources/ from disk and
    # materializing now is cheaper than a Storage download at run start. Identical bytes
    # skip the write: re-uploading the 12 MB kit must not churn the file.
    resources_dir(slug).mkdir(parents=True, exist_ok=True)
    if not (path.is_file() and path.read_bytes() == raw_bytes):
        path.write_bytes(raw_bytes)

    row = db.q(
        """select size_bytes, uploaded_at from client_resources
           where client_id = %s and name = %s""",
        (db.client_id(slug), name), fetch="one")
    size, uploaded_at = row if row else (len(raw_bytes), None)
    return {"name": name, "size": size,
            "modified": uploaded_at.isoformat() if uploaded_at else ""}


def delete_resource(slug, name):
    if not exists(slug):
        raise UnknownClient(f"unknown client {slug!r}")
    clean = Path(str(name or "")).name
    deleted = db.resource_delete(slug, clean)
    # The scratch copy follows the record either way: a file the record no longer names
    # must not survive on disk for an agent to read.
    path = _inside_resources(slug, clean)
    if path is not None and path.is_file():
        path.unlink()
    return bool(deleted)
