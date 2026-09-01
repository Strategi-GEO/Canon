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

# The house default market, the operator's standing decision (every brand this agency serves
# sells in India, in English). NOT a guess from the domain, which the engine contract forbids:
# it is a configured default the onboarding dialog prefills visibly, and a brand that sells
# elsewhere overrides it there or in Settings. create_client falls back to it so a brand can
# never be created marketless, which is what silently skipped DataForSEO on every early run.
HOUSE_DEFAULT_MARKET = "India, English"

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
    select c.slug, c.name, c.domain, c.industry, c.market, c.description,
           c.custom_instructions,
           -- THE KIND ONLY, EXTRACTED IN SQL, and never the blob. clients.site holds a write
           -- credential for a client's live website and this select answers to require_user,
           -- so the credential must not leave the database on this path at all. Masking it in
           -- Python after selecting it would work until someone adds a passthrough; selecting
           -- one string makes the leak unreachable. The settings page reads the rest through
           -- GET /api/clients/{slug}/site, which is admin-only and drops every secret key.
           c.site->>'kind' as site_kind,
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
    (slug, name, domain, industry, market, description, custom_instructions,
     site_kind, created_at, has_roadmap, has_facts, resource_count, blog_count,
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
        # Geography + language ("India, English"): what DataForSEO validates keywords against
        # and whose local sources Agent R prefers. Collected at onboarding, edited in Settings.
        "market": market or "",
        "description": description or "",
        # The brand's standing blog instructions, so the Settings tab can show and edit them.
        # Operator material: present on the engine's own record (owner connection), never on the
        # hosted authenticated read, which does not select this column.
        "custom_instructions": custom_instructions or "",
        # WHERE this brand's blogs publish, as a bare kind: "strategi-cms", "wordpress", or ""
        # when nothing is configured. The Post button reads exactly this: empty means no
        # destination, which the publish route refuses on with its own sentence rather than
        # falling back to anything. No part of the credential is here; see the select's note.
        "site_kind": site_kind or "",
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

    AN ORG WITH NO BRANDS IS STILL LISTED, with an empty `brands`, and that is not a
    completeness flourish. Grouping from the clients alone meant the LAST brand leaving an org
    erased the org from every surface at once: it vanished from the switcher, its own page
    answered "No such organisation", and the EmptyOrg card written for exactly this state was
    unreachable code. The orgs row survived in the table with its client-portal grant still
    live, so what the delete actually produced was an invisible tenant nobody could reach, add a
    brand to, or delete. A brandless org is only ever the seconds-to-forever after its last
    brand is dropped, so listing it is what gives that state a door.

    Non-admins never see one: _scoped_orgs in server/app.py keeps an org only when a brand of
    it survives the scope filter, and an org with no brands has none to survive.
    """
    grouped = {}
    for slug, name in db.q("select slug, name from orgs", fetch="all") or []:
        grouped[slug] = {"slug": slug, "name": name, "brands": []}
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
Not recorded yet. DataForSEO needs a location and language named here, so set the Market
field in this brand's Settings before the first real run. Do not guess a market from the
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
# The org and client slug namespaces overlap, and the guard below outlived its
# ORIGINAL reason and found a bigger one
# ---------------------------------------------------------------------------
# orgs.slug and clients.slug are each `not null unique` in SEPARATE tables
# (supabase/schema.sql), so the record happily holds an org called "acme" and an
# unrelated brand called "acme" at the same time. Nothing in the schema compares
# the two namespaces. For everything else in this module that is harmless: an org
# is a grouping, a client is a brand, and the two are joined by org_id and never
# by name.
#
# THE ORIGINAL REASON IS GONE AND A LARGER ONE WAS UNDER IT THE WHOLE TIME.
# This was written about the CMS write key: a brand with org_id null is its own
# single-brand org, synthesised on read by _client_from_row above, and
# server/cms/routes.py turned that synthesised slug into the environment variable
# STRATEGI_CMS_WRITE_KEY_<ORG>. A brand "acme" with no org of its own asked for
# exactly the variable the real org "acme" asked for and was handed that org's
# key; the Strategi CMS derived the destination tenant FROM THE KEY, so a draft
# landed in another client's CMS and neither side could notice. Migration 038
# removed that destination and server/cms/client.py with it, so that particular
# harm is unreachable.
#
# THE CLIENT PORTAL IS WHY THE INVARIANT STILL MATTERS, and it is a WORSE failure
# than the one the comment used to name. `org_membership` derives its org_slug as
# COALESCE(orgs.slug, clients.slug), which IS this synthesis, and every client
# portal RLS policy in supabase/schema.sql joins `org_members om on om.org_slug =
# m.org_slug`. So a real org and a self-org brand sharing a slug produce the SAME
# org_slug in that view, and ONE portal grant reaches both tenants: the client
# logs in and reads a stranger's brand, its blogs, its comments and its roadmap.
# Measured on the live record inside a rolled-back transaction: creating an org
# `vilvah` beside the existing self-org brand `vilvah`, with one unrelated brand
# of its own, made a single grant on `vilvah` return BOTH brands.
#
# A misrouted CMS draft was one article in the wrong tenant. This is standing
# read access to another client's whole workspace, so the guard is not merely
# kept, it is load-bearing, and the refusal messages below name the portal rather
# than a key that no longer exists.
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

    THE HARM IS A SHARED CLIENT-PORTAL LOGIN. See the section comment above: the
    `org_membership` view derives org_slug as COALESCE(orgs.slug, clients.slug),
    and every portal RLS policy joins `org_members` on that value, so a collision
    hands one grant read access to two unrelated tenants.

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
            f"{colliding[0]!r}, which has no organisation of its own. The two would share "
            f"one client-portal login, so whoever signs in would read both. Rename the "
            f"organisation, or give that brand this organisation first."
        )


def _org_row_exists(org_slug):
    return bool(db.q("select 1 from orgs where slug = %s", (org_slug,), fetch="val"))


def effective_org_slug(client_slug):
    """The org slug the PORTAL resolves this brand under, or None if it cannot see it.

    Read from `org_membership` rather than computed here, because that view is what the
    portal itself reads and its rule (COALESCE(orgs.slug, clients.slug)) must not be
    restated in a second place that can drift from it.
    """
    return db.q("select org_slug from org_membership where client_slug = %s",
                (client_slug,), fetch="val")


def self_org_slug(client_slug):
    """The org slug this brand ALONE answers to, or None when the slug is not its to give up.

    A brand with no organisation of its own IS its own org: `org_membership` derives org_slug as
    COALESCE(orgs.slug, clients.slug), so a grant on that slug reaches this brand and nothing
    else. Deleting the brand therefore has to take the grant with it, exactly as deleting an org
    does, or the slug is left holding a live client-portal login with no brand behind it. That
    leftover is not inert: a brand delete is a HARD delete, so the slug is immediately reusable,
    and `api_create_client` skips minting a login whenever `has_login` is already true. The next
    brand created with that name would silently inherit the deleted brand's login, its password
    and its `commenter` grant, which the portal admits for answer writes.

    None where an `orgs` row owns the slug, and that exclusion is the whole safety of this
    function. A brand named the same as its explicit organisation resolves to THAT org's slug,
    whose login is shared with every sibling brand, so revoking it here would lock out brands
    this delete never touched. api_delete_org owns that one, behind its own emptiness check.
    """
    org_slug = effective_org_slug(client_slug)
    if org_slug != client_slug or _org_row_exists(org_slug):
        return None
    return org_slug


def _carry_org_grants(client_slug, old_org_slug, new_org_slug):
    """Move a brand's client login with it when its org changes.

    THE LOCKOUT THIS EXISTS FOR. `org_members` grants an ORG SLUG, and `org_membership`
    derives that slug as COALESCE(orgs.slug, clients.slug), so a brand with no org of its
    own answers to its own slug. Point its org_id at a real org and the derived slug
    changes under a grant that still names the old one, orgsForUser keeps no row, and the
    client's own login lands on "No organisation is linked to this account yet" with no
    way back. That is exactly what happened to blr-brewing when it moved into
    bangalore-brewing-co: the account was live, the password was right, and the portal had
    nothing to show it. Nothing in the write path noticed, because moving a brand rewrites
    ONE column and this table is not it.

    IT CARRIES ONLY WHERE CARRYING WIDENS NOTHING, which is the whole safety argument. The
    grant is per ORG, so handing someone the destination org hands them every brand in it.
    Where the destination holds THIS BRAND ALONE, the grantee could already see everything
    that grant reaches and the carry is a no-op in access terms. That covers both lockout
    directions: a self-org brand joining an org of its own, and a brand leaving an org to
    stand on its own again, which is a one-brand destination by definition.

    WHERE THE DESTINATION ALREADY HOLDS OTHER BRANDS IT REFUSES, and the refusal is not a
    gap. An org with brands has its own login, and that login already sees the arriving
    brand through the same view, so there is nothing to repair; carrying would instead hand
    the departing org's members every OTHER brand in the destination, which is the one
    thing a grant migration must never do on its own authority.

    The old grant is deleted only once it is DEAD, meaning no brand answers to that slug
    any more. A slug the departing org still uses is a live grant for the brands that
    stayed, and dropping it would lock those out to fix this one.
    """
    if not old_org_slug or not new_org_slug or old_org_slug == new_org_slug:
        return
    if db.q("""select 1 from org_membership where org_slug = %s and client_slug <> %s limit 1""",
            (new_org_slug, client_slug), fetch="val"):
        return
    db.q("""insert into org_members (org_slug, user_id, role)
            select %s, user_id, role from org_members where org_slug = %s
            on conflict (org_slug, user_id) do nothing""",
         (new_org_slug, old_org_slug), fetch="none")
    if not db.q("select 1 from org_membership where org_slug = %s limit 1",
                (old_org_slug,), fetch="val"):
        db.q("delete from org_members where org_slug = %s", (old_org_slug,), fetch="none")


def _refuse_self_org_collision(client_slug):
    """The same invariant from the other side: a brand may not BECOME a self-org
    brand whose slug an orgs row already owns. Same harm, same view: one
    client-portal grant would reach this brand and that org's brands alike.

    This fires on the two writes that leave org_id null: onboarding a brand with
    the organisation field blank, and clearing an existing brand's organisation
    back to blank. Without it the guard above is half a guard, because a brand can
    walk into the collision just as easily as an org can walk into it.
    """
    if _org_row_exists(client_slug):
        raise InvalidClient(
            f"the brand slug {client_slug!r} is already an organisation slug, so a brand "
            f"with no organisation of its own would share that organisation's client-portal "
            f"login and each could read the other. Give this brand an explicit organisation, "
            f"or rename the organisation holding that slug."
        )


def org_slug_collides(org_slug):
    """True when this ORG SLUG denotes TWO tenants rather than one. The read-time net.

    THE PREDICATE IS BOTH SIDES PRESENT AT ONCE: an `orgs` row carrying this slug, AND a live
    brand carrying it with no org of its own. Either alone is ordinary and safe. Together they
    are the collision, because `org_membership` derives org_slug as
    COALESCE(orgs.slug, clients.slug), so both resolve to this one string and a single
    `org_members` grant on it reaches both tenants.

    WHY A READ-TIME CHECK EXISTS AT ALL, when two write guards and two database triggers already
    forbid the state. None of them can reach a collision that was already in the record: a
    constraint trigger is checked only on rows written after it exists, and a row written before
    the guards was legal when it was written. Migration 017 says exactly this and points at this
    function as the net.

    WHERE IT IS CALLED, AND WHY THAT MOVED. It used to be called by server/cms/routes.py
    immediately before a per-org CMS write key was resolved, because that was the last moment
    anything could tell the two tenants apart. Commit 5d80403 replaced those keys with one shared
    key, which removed the call and left this orphaned for months; migration 038 then removed the
    CMS entirely. The harm moved with it: a collision no longer misroutes a draft, it hands one
    client-portal login read access to another client's whole workspace. So the last moment that
    matters is now the moment a GRANT IS WRITTEN, and the two doors that write one call this:
    portal_login.provision_one and seed_org_users. Nothing calls it on a publish, because a
    publish no longer resolves anything from an org slug.

    IT TAKES AN ORG SLUG, WHERE THE OLD ONE TOOK A CLIENT SLUG. Same predicate, asked from the
    side that now needs the answer: the grant doors hold an org slug and have no brand in hand.
    """
    org_slug = str(org_slug or "").strip()
    if not org_slug:
        return False
    return bool(_org_row_exists(org_slug)) and bool(_self_org_clients(org_slug))


def refuse_grant_on_collision(org_slug):
    """Raise InvalidClient if a portal grant on this slug would reach two tenants.

    THE SENTENCE IS THE POINT, which is why this is not left to each caller. Both grant doors are
    provisioning tools an operator runs, and "refused" teaches nobody anything: the fix is to give
    the brand an explicit organisation or rename one of the two, and neither is guessable from a
    bare failure.
    """
    if not org_slug_collides(org_slug):
        return
    brand = _self_org_clients(org_slug)[0]
    raise InvalidClient(
        f"the slug {org_slug!r} is BOTH an organisation and the brand {brand!r}, which has no "
        f"organisation of its own. One client-portal login on that slug would read both, so no "
        f"login is minted for it. Give that brand an explicit organisation, or rename one of "
        f"the two, then run this again."
    )


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
                  organisation_name=None, market=""):
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
    market = str(market or "").strip() or HOUSE_DEFAULT_MARKET

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
                 (org_id, slug, name, domain, industry, market, description, client_md,
                  gates)
               values (%s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb)""",
            (org_id, slug, name, domain, industry, market,
             str(description or ""),
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
                  domain=None, industry=None, custom_instructions=None,
                  market=None):
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
    # Column only, like domain: the agents read it from client.md's Market section, which
    # sync.materialize_client below splices in from this column on every lay-down. Empty string
    # is a real value (clearing the market), so only None means "not sent".
    if market is not None:
        sets.append("market = %s")
        params.append(str(market).strip())
    # READ BEFORE THE WRITE, because the answer is derived from the column being written and
    # is unrecoverable afterwards: once org_id moves, nothing on the record still says which
    # slug the portal was resolving this brand under a moment ago.
    org_slug_before = effective_org_slug(slug) if organisation_name is not None else None
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
        # The brand's client login follows the brand. AFTER the update, so the destination
        # slug and its brand list are read from the state that now exists rather than the
        # one being replaced.
        if org_slug_before is not None:
            _carry_org_grants(slug, org_slug_before, effective_org_slug(slug))
        # Scratch tracks the record: the next agent run reads gates.json from disk, and it
        # must say what was just recorded.
        sync.materialize_client(slug)

    return read_client(slug)


# ---------------------------------------------------------------------------
# The blog destination (migration 035)
# ---------------------------------------------------------------------------
# WHY THESE TWO FUNCTIONS EXIST INSTEAD OF A FIELD ON _CLIENT_SELECT, which is where every
# other per-brand fact is read. clients.site holds a WRITE CREDENTIAL for a client's live
# website, and GET /api/clients/{slug} answers to auth.require_user, not require_admin. So
# everything _CLIENT_SELECT carries reaches any logged-in user: putting the blob there would
# hand a viewer a credential that can publish to a client's site. The client record instead
# carries the MASKED summary that site_summary builds, and the raw blob is read here, by the
# publish path, over the owner connection.

def read_site(slug):
    """This brand's blog destination, credential included, or {} when none is configured.

    THE ONLY READER OF THE RAW BLOB. Callers are the publish route and the connection test;
    nothing that answers an HTTP body may call this. An unconfigured brand answers {} rather
    than raising, because "no destination" is an ordinary state the publish gate refuses on
    with its own sentence, not an error.
    """
    row = db.q("select site from clients where slug = %s and deleted_at is null",
               (slug,), fetch="one")
    if row is None or not isinstance(row[0], dict):
        return {}
    return row[0]


def write_site(slug, site):
    """Replace this brand's destination wholesale. {} clears it.

    WHOLESALE AND NOT A MERGE, unlike update_client's field-by-field PATCH. A destination is
    one coherent object: a WordPress connection's post type belongs to its url and credential,
    and merging a Shopify blob over a WordPress one would leave a chimera carrying half of
    each that no driver can read. The caller builds the whole object or clears it.
    """
    cid = db.client_id(slug)
    if not cid:
        raise UnknownClient(f"unknown client {slug!r}")
    db.q("update clients set site = %s::jsonb where id = %s",
         (json.dumps(site or {}, ensure_ascii=False), cid), fetch="none")
    db.invalidate_client_cache()


def site_summary(slug):
    """What a SURFACE may know about the destination: everything except the secret.

    Every key a driver marks secret is dropped, so this is safe to return in an HTTP body and
    safe to log. `configured` is the one thing the publish button reads, and it is derived
    from `kind` rather than from the blob being non-empty: a half-written blob carrying a url
    and no kind is not a destination, and reporting it as one would offer a Post button that
    the route then refuses.
    """
    site = read_site(slug)
    kind = str(site.get("kind") or "").strip()
    if not kind:
        return {"configured": False, "kind": "", "label": "", "fields": {}}

    from .cms import sites as sites_mod
    secret_keys = {f["key"] for f in sites_mod.fields_for(kind) if f.get("secret")}
    return {
        "configured": True,
        "kind": kind,
        "label": sites_mod.label_for(site),
        "fields": {k: v for k, v in site.items()
                   if k != "kind" and k not in secret_keys},
    }


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


def hard_delete_org(org_slug):
    """Delete an EMPTY organisation row. Refuses while any brand still belongs to it.

    Refusing rather than cascading is deliberate. A brand is the engine's unit of work and
    hard_delete_client puts each one behind a consent checkbox and a slug retype; letting one
    org confirm stand in for all of them would drop several brands' blogs, roadmaps and
    resources on a single press. clients.org_id is ON DELETE RESTRICT, so the database refuses
    this too, but a 409 naming the brands is an answer an operator can act on where a foreign
    key violation is not.

    The org's client-portal login is NOT dropped here: that is a GoTrue write, it lives in
    server/portal_login.py with the rest of the auth admin calls, and the caller runs it. This
    function owns the record and nothing else.

    Returns the deleted org's name, or None if the slug was already absent (idempotent)."""
    name = db.q("select name from orgs where slug = %s", (org_slug,), fetch="val")
    if name is None:
        return None
    assert_org_empty(org_slug)
    db.q("delete from orgs where slug = %s", (org_slug,), fetch="none")
    return name


def assert_org_empty(org_slug):
    """Raise InvalidClient naming the brands that still belong to org_slug, if any.

    Split out of hard_delete_org so the REFUSAL can be taken before anything irreversible runs.
    Deleting an org also revokes its client-portal login, and that revoke has to happen before
    the row goes (see api_delete_org), which would otherwise put the destructive half of the
    operation in front of the check that forbids it: a refused delete would still have destroyed
    the login. hard_delete_org calls this too, so the function stays safe called alone.
    """
    brands = [row[0] for row in db.q(
        """select c.slug from clients c join orgs o on o.id = c.org_id
           where o.slug = %s and c.deleted_at is null order by c.slug""",
        (org_slug,), fetch="all") or []]
    if brands:
        raise InvalidClient(
            f"{org_slug!r} still holds {len(brands)} brand(s): {', '.join(brands)}. Delete each "
            f"brand from its own Settings first; an organisation is a grouping and deleting one "
            f"must never take its brands with it.")


def hard_delete_client(slug):
    """HARD delete a brand and everything under it. IRREVERSIBLE.

    Deleting the clients row cascades topics (and their blog_versions, blog_comments,
    review_notes, status_events), channel_posts (and channel_post_comments), roadmap_sheets,
    roadmap_rows, roadmap_uploads, client_resources, client_members and ledger_entries. EVERY
    table carrying a client_id cascades off clients: ten by a direct FK and five more through
    topics(id, client_id) and channel_posts(id, client_id). The two explicit deletes below are
    belt and braces against a database whose applied FKs have drifted from schema.sql, and they
    are NOT load-bearing. They were justified for years by the opposite claim, that these tables
    carried no cascade, and that false reading of the FK graph is what put a third delete here
    against org_membership. org_membership is a VIEW over clients left join orgs, so its row
    vanishes with the clients row and Postgres refuses the delete outright ("cannot delete from
    view"), which rolled the whole transaction back: every brand delete was a 500 and NOTHING was
    ever deleted. The scratch tree on disk (clients/<slug>/ and outputs/<slug>/) is removed
    best-effort afterwards, because it is re-derivable from the record for a live brand and inert
    for a deleted one.

    THE ONE THING THAT DOES NOT CASCADE IS NOT A TABLE WITH A client_id. `org_members` grants by
    ORG SLUG and carries no foreign key at all, so a self-org brand's client-portal grant survives
    this function. Revoking it is the CALLER's job, exactly as it is on the org path: see
    self_org_slug above and api_delete_client, which resolves the slug before this runs because
    org_membership goes blind the moment the row is gone.

    Returns the deleted brand's name, or None if the slug was already absent (idempotent)."""
    cid = db.client_id(slug)
    if cid is None:
        return None
    name = db.q("select name from clients where id = %s", (cid,), fetch="val")
    with db.tx() as cur:
        cur.execute("delete from client_reports where client_id = %s", (cid,))
        cur.execute("delete from client_analyses where client_id = %s", (cid,))
        cur.execute("delete from clients where id = %s", (cid,))
    _purge_client_scratch(slug)
    return name


def _purge_client_scratch(slug):
    """Remove the deleted brand's materialized scratch: clients/<slug>/ and outputs/<slug>/. Both
    re-derive from the record for a live brand, so removing them for a deleted one loses nothing.
    Best-effort: the record is already gone and a leftover dir is inert. slug is a validated brand
    slug (runner.slugify round-trips it), so neither join can escape its parent."""
    import shutil
    if runner.slugify(slug) != slug:
        return
    for path in (CLIENTS_DIR / slug, runner.OUTPUTS_ROOT / slug):
        shutil.rmtree(path, ignore_errors=True)
