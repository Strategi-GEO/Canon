"""Client onboarding: the clients row in Supabase, its docs, and its Resources.

WHAT A CLIENT IS, in the record (supabase/schema.sql):
  clients.slug / name / domain / industry / description   the onboarding form fields
  clients.client_md        the brand brief the engine loads (generated here at create)
  clients.canonical_facts  BINDING facts. NOT written here. See create_client.
  clients.gates            gates.json as jsonb, MINUS the "organisation" key: the org is
                           modelled as clients.org_id -> orgs, never duplicated into gates
  clients.demo_mode        the demo switch, mirrored inside gates for the disk copy
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


def exists(slug):
    """A client is a live clients row: deleted_at null. db.client_id is the one gate."""
    return db.client_id(slug) is not None


# Every read of a client goes through this one statement, so list and single reads cannot
# disagree on a count or a flag. blog_count counts topics that actually carry a committed
# blog version, which is the record's answer to what _blog_count used to glob off disk.
_CLIENT_SELECT = """
    select c.slug, c.name, c.domain, c.industry, c.description,
           c.demo_mode, c.created_at,
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
    (slug, name, domain, industry, description, demo_mode,
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
        "demo_mode": bool(demo_mode),
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
    industry_ref = (
        f".claude/skills/geo-content-writer/references/industries/{industry}.md"
        if industry
        else "(none: no industry selected at onboarding)"
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
Industry: {industry or "(not selected)"}. Agent W MUST read `{industry_ref}` on every run.
Skipping the industry reference produces generic content that does not fit this client.

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


def _upsert_org(org_config):
    """The orgs row for an explicit org, created or renamed in place. Returns its id.

    on conflict updates the name so the org rename an operator typed actually lands:
    orgs.slug is the identity, the name is display.
    """
    return db.q(
        """insert into orgs (slug, name) values (%s, %s)
           on conflict (slug) do update set name = excluded.name
           returning id""",
        (org_config["slug"], org_config["name"]), fetch="val")


def create_client(name, domain, industry, description="", demo_mode=False,
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

    industry = str(industry or "").strip()
    domain = str(domain or "").strip()

    # gates.json as it will be materialized to disk, MINUS "organisation": the org lives
    # in org_id and is never duplicated into gates. demo_mode is mirrored here because
    # runner.is_demo_client reads the disk copy of gates.json, which is built from this.
    config = {
        "client": slug,
        "name": name,
        "domain": domain,
        "industry": industry,
        "demo_mode": bool(demo_mode),
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

    org_id = _upsert_org(org_config) if org_config is not None else None

    # canonical_facts is NOT written here, and onboarding must never write it. It is
    # BINDING: every blog for this client inherits it, and the runner refuses a real run
    # when it is missing or still unreviewed. A value this module invented would either be
    # a fabrication or a placeholder that merely looks approved, and both defeat the
    # preflight. It is drafted at generate time and approved by a human before it exists.
    try:
        db.q(
            """insert into clients
                 (org_id, slug, name, domain, industry, description, client_md,
                  demo_mode, gates)
               values (%s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb)""",
            (org_id, slug, name, domain, industry, str(description or ""),
             _client_md(name, domain, industry, slug),
             bool(demo_mode), json.dumps(config, ensure_ascii=False)),
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
                  domain=None, industry=None):
    """Update only what was passed. A None field is untouched, so a PATCH carrying one key
    cannot blank the others, and gates keys this function was not given survive."""
    cid = db.client_id(slug)
    if not cid:
        raise UnknownClient(f"unknown client {slug!r}")

    sets, params = [], []
    if description is not None:
        sets.append("description = %s")
        params.append(str(description))
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
            sets.append("org_id = null")
        else:
            sets.append("org_id = %s")
            params.append(_upsert_org(org_config))

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
