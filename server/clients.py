"""Client onboarding: the clients/<slug>/ directory, its config, and its Resources.

WHAT A CLIENT IS, on disk:
  clients/<slug>/client.md           the brand brief the engine loads (readable, generated here)
  clients/<slug>/gates.json          machine config gates.py and runner.py already consume
  clients/<slug>/description.md      operator-owned brand description, editable
  clients/<slug>/never-claim.md      operator-owned do-not-claim rules, one per line
  clients/<slug>/canonical-facts.md  BINDING facts. NOT written here. See create_client.
  clients/<slug>/roadmap.csv         optional saved roadmap
  clients/<slug>/generated.csv       the append-only ledger, owned by server/ledger.py
  clients/<slug>/Resources/          the client knowledge base agents read before any search
  clients/<slug>/uploads/            archived operator CSVs

Blog OUTPUT is not here: it lives at outputs/<slug>/<topic-slug>/, and runner.py owns
that path. This module reuses runner.ensure_client_output_dir and ledger.ensure_ledger
rather than reimplementing either, so onboarding cannot drift from what the runner reads.

No concurrency primitive lives in this module. The client lock and the topic semaphore are
in runner.py and nowhere else.
"""
import json
import re
from datetime import datetime, timezone
from pathlib import Path

from . import ledger, runner

REPO_ROOT = Path(__file__).resolve().parent.parent
CLIENTS_DIR = REPO_ROOT / "clients"

# The industry reference set is the source of truth for what an industry IS. A hardcoded
# list here would rot the moment someone adds a reference file, and a client.md could then
# name an industry reference that never loads.
INDUSTRIES_DIR = (
    REPO_ROOT / ".claude" / "skills" / "geo-content-writer" / "references" / "industries"
)

# The house default word band, matching CLAUDE.md. gates.json may override it per client.
HOUSE_WORD_BAND = {"min": 1200, "soft_max": 2000, "hard_max": 2500}

# A resource is a brochure, a deck, a sheet, a PDF. 25 MB is generous for that and small
# enough that a mistaken upload fails fast instead of filling the disk.
MAX_RESOURCE_BYTES = 25 * 1024 * 1024

# Browser-supplied filenames are untrusted input. Everything outside this set becomes an
# underscore, so a name can never carry a path separator, a dot-dot, or a shell character.
_SAFE_RESOURCE_CHARS = re.compile(r"[^A-Za-z0-9._ -]")

_KINDS = {
    ".pdf": "pdf",
    ".csv": "csv",
    ".md": "markdown",
    ".txt": "text",
    ".doc": "document",
    ".docx": "document",
    ".rtf": "document",
    ".ppt": "deck",
    ".pptx": "deck",
    ".xls": "sheet",
    ".xlsx": "sheet",
    ".png": "image",
    ".jpg": "image",
    ".jpeg": "image",
    ".gif": "image",
    ".webp": "image",
    ".json": "data",
}


class ClientError(Exception):
    """Base for onboarding refusals, so app.py can map them to status codes."""


class ClientExists(ClientError):
    """The slug is taken. Never overwrite: a live client's config is not ours to replace."""


class InvalidClient(ClientError):
    """The name cannot produce a usable slug, or the slug is reserved."""


class UnknownClient(ClientError):
    """No clients/<slug>/ directory with a gates.json."""


class BadResource(ClientError):
    """An upload whose filename or size makes it unusable."""


def slugify_client(name):
    """Brand name -> directory slug: lowercase, runs of non-alphanumerics to one hyphen.

    Deliberately the same normalisation roadmap.slugify applies to topics, because a slug
    is a path segment either way and two brands that differ only in punctuation must not
    quietly become two directories.
    """
    return re.sub(r"[^a-z0-9]+", "-", str(name or "").lower()).strip("-")


def client_paths(slug):
    root = CLIENTS_DIR / slug
    return {
        "root": root,
        "client_md": root / "client.md",
        "gates": root / "gates.json",
        "description": root / "description.md",
        "never_claim": root / "never-claim.md",
        "canonical_facts": root / "canonical-facts.md",
        "roadmap": root / "roadmap.csv",
        "ledger": root / "generated.csv",
        "resources": resources_dir(slug),
        "uploads": root / "uploads",
        "output": runner.client_output_dir(slug),
    }


def resources_dir(slug):
    """clients/<slug>/Resources/, capital R.

    The path is exact on purpose: CLAUDE.md's precedence order names
    clients/<slug>/Resources/ as the client knowledge base every agent reads before any
    external search. A lowercase variant would create a folder that uploads land in and no
    agent ever opens, which looks like it works and silently is not read.
    """
    return CLIENTS_DIR / slug / "Resources"


def list_industries():
    """The exact reference filenames, without .md. Read, never hardcoded: see INDUSTRIES_DIR."""
    if not INDUSTRIES_DIR.is_dir():
        return []
    return sorted(path.stem for path in INDUSTRIES_DIR.glob("*.md"))


def _read_text(path):
    """Absent is empty, not an error: a client onboarded before these files existed, or one
    whose operator has not filled them in yet, is a normal state."""
    try:
        return path.read_text(encoding="utf-8")
    except OSError:
        return ""


def _load_gates(slug):
    path = client_paths(slug)["gates"]
    try:
        config = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {}
    return config if isinstance(config, dict) else {}


def _created(root):
    try:
        stamp = root.stat().st_ctime
    except OSError:
        return ""
    return datetime.fromtimestamp(stamp, tz=timezone.utc).isoformat()


def _blog_count(slug):
    """Blogs on disk, not ledger rows. The filesystem is the source of truth for what
    exists, exactly as _blog_history in app.py already treats it."""
    output_root = runner.client_output_dir(slug)
    if not output_root.is_dir():
        return 0
    return sum(1 for topic_dir in output_root.iterdir() if (topic_dir / "blog.md").is_file())


def exists(slug):
    paths = client_paths(slug)
    return paths["root"].is_dir() and paths["gates"].is_file()


def _organisation(slug, gates):
    """The org this brand belongs to, from gates.json's optional "organisation" key.

    An ABSENT key means the client is its own single-brand org, which is the common case
    today and the reason this synthesises rather than requiring the key: every existing
    client keeps working with zero migration, and no brand ever renders under an empty org.
    A self-referencing org is deliberately NOT written to gates.json by create_client: an
    absent key already states this fact, and storing it twice invites the two copies to
    disagree after a rename.
    """
    org = gates.get("organisation")
    if isinstance(org, dict):
        org_slug = slugify_client(org.get("slug") or org.get("name") or "")
        org_name = str(org.get("name") or "").strip()
        if org_slug and org_name:
            return {"slug": org_slug, "name": org_name}
    return {"slug": slug, "name": gates.get("name") or slug}


def list_clients():
    """Every client on disk. A client is a directory under clients/ carrying gates.json."""
    if not CLIENTS_DIR.is_dir():
        return []
    found = []
    for path in sorted(CLIENTS_DIR.iterdir()):
        if path.is_dir() and (path / "gates.json").is_file():
            found.append(read_client(path.name))
    return found


def list_orgs():
    """Orgs grouped from the clients themselves: [{"slug","name","brands":[client, ...]}].

    Derived on read, never stored. There is no orgs/ directory and no second config file,
    so an org grouping cannot drift out of sync with the brands it groups: the brands ARE
    the record. The brand stays the engine's unit of work because one brand owns exactly
    one canonical-facts.md, never-claim list, entity-name set and roadmap.
    """
    grouped = {}
    for client in list_clients():
        # clients/_fixture-unreviewed is a test fixture for the preflight refusal, not a
        # brand anyone writes for. It stays visible in GET /api/clients, which the existing
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


def read_client(slug):
    if not exists(slug):
        raise UnknownClient(f"unknown client {slug!r}")
    paths = client_paths(slug)
    gates = _load_gates(slug)
    return {
        "slug": slug,
        "name": gates.get("name") or slug,
        # The org is a grouping over brands, resolved here so every reader of a client sees
        # the same answer. See _organisation for why an absent key is not a missing value.
        "organisation": _organisation(slug, gates),
        # domain and industry live in gates.json because it is the machine-readable config
        # every other reader already parses. client.md is prose for an agent to read, so
        # scraping a field back out of it would make the brief load bearing for the API.
        # A client onboarded before this feature has neither key, so both read empty.
        "domain": gates.get("domain") or "",
        "industry": gates.get("industry") or "",
        "description": _read_text(paths["description"]),
        "never_claim": _read_text(paths["never_claim"]),
        "demo_mode": bool(gates.get("demo_mode", False)),
        "has_roadmap": paths["roadmap"].is_file(),
        "has_canonical_facts": paths["canonical_facts"].is_file(),
        "resource_count": len(list_resources(slug)),
        "blog_count": _blog_count(slug),
        "created": _created(paths["root"]),
    }


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
The binding list is `canonical-facts.md`. The operator's own rules are in
`clients/{slug}/never-claim.md`, one per line, and they seed that file at review time.

## Resources
`clients/{slug}/Resources/` is this client's knowledge base. Read it before any external
search. Record any per-file exclusion in `canonical-facts.md`, for example an image-only PDF
with no extractable text is not a citable source.
"""


def _write_gates(slug, config):
    client_paths(slug)["gates"].write_text(
        json.dumps(config, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )


def _org_config_value(organisation_name):
    """An organisation_name -> the gates.json value, or None to write no key at all.

    Blank means "no explicit org", which is exactly what an absent key already says, so
    nothing is written. Returning a self-referencing org here would store one fact in two
    places and let them disagree later.
    """
    org_name = str(organisation_name or "").strip()
    if not org_name:
        return None
    org_slug = slugify_client(org_name)
    if not org_slug:
        raise InvalidClient("an organisation name must contain at least one letter or digit")
    return {"slug": org_slug, "name": org_name}


def create_client(name, domain, industry, description="", never_claim="", demo_mode=False,
                  organisation_name=None):
    name = str(name or "").strip()
    slug = slugify_client(name)
    if not slug:
        raise InvalidClient("a client name must contain at least one letter or digit")
    if slug.startswith("_"):
        # Unreachable through slugify_client, which strips leading punctuation, but the
        # guard is the contract: a leading underscore marks a test fixture such as
        # clients/_fixture-unreviewed, and onboarding must never be able to mint or
        # collide with one.
        raise InvalidClient(f"the slug {slug!r} is reserved: names starting with _ are fixtures")
    if exists(slug) or (CLIENTS_DIR / slug).exists():
        raise ClientExists(f"client {slug!r} already exists")

    # Validated before the directory is made, so a bad org name refuses cleanly instead of
    # leaving a half-built client on disk.
    org_config = _org_config_value(organisation_name)

    paths = client_paths(slug)
    paths["root"].mkdir(parents=True, exist_ok=False)

    industry = str(industry or "").strip()
    domain = str(domain or "").strip()

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
    if org_config is not None:
        config["organisation"] = org_config
    _write_gates(slug, config)

    paths["client_md"].write_text(_client_md(name, domain, industry, slug), encoding="utf-8")
    paths["description"].write_text(str(description or ""), encoding="utf-8")
    paths["never_claim"].write_text(str(never_claim or ""), encoding="utf-8")
    paths["resources"].mkdir(parents=True, exist_ok=True)
    paths["uploads"].mkdir(parents=True, exist_ok=True)

    # canonical-facts.md is NOT written here, and onboarding must never write it. It is
    # BINDING: every blog for this client inherits it, and the runner refuses a real run
    # when it is missing or still unreviewed. That refusal is the only thing standing
    # between an unreviewed file and a queue of blogs citing it as fact. A file this module
    # created would either be an invention (facts nobody verified) or a placeholder that
    # merely looks approved, and both defeat the preflight. It is drafted at generate time,
    # seeded by never-claim.md, and approved by a human before it exists.

    ledger.ensure_ledger(slug)
    runner.ensure_client_output_dir(slug)
    return read_client(slug)


def update_client(slug, description=None, never_claim=None, name=None, organisation_name=None):
    """Write only what was passed. A None field is untouched, so a PATCH carrying one key
    cannot blank the others, and gates.json keys this function was not given survive."""
    if not exists(slug):
        raise UnknownClient(f"unknown client {slug!r}")
    paths = client_paths(slug)

    if description is not None:
        paths["description"].write_text(str(description), encoding="utf-8")
    if never_claim is not None:
        paths["never_claim"].write_text(str(never_claim), encoding="utf-8")
    if name is not None:
        new_name = str(name).strip()
        if not new_name:
            raise InvalidClient("a client name cannot be blank")
        # Read, mutate one key, write back. The slug is NOT recomputed: renaming the
        # directory would orphan outputs/<slug>/, the ledger, and every status.jsonl an
        # SSE stream is tailing right now.
        config = _load_gates(slug)
        config["name"] = new_name
        _write_gates(slug, config)
    if organisation_name is not None:
        # Moving a brand between orgs rewrites ONE key and renames NO directory. The brand
        # slug keys clients/<slug>/, outputs/<slug>/, the ledger and any status.jsonl an SSE
        # stream is tailing right now, so a rename that moved them would orphan a live run.
        org_config = _org_config_value(organisation_name)
        config = _load_gates(slug)
        if org_config is None:
            # Cleared back to its own single-brand org, which is what an absent key means.
            config.pop("organisation", None)
        else:
            config["organisation"] = org_config
        _write_gates(slug, config)

    return read_client(slug)


# ---------------------------------------------------------------------------
# Resources
# ---------------------------------------------------------------------------

def _kind(name):
    return _KINDS.get(Path(name).suffix.lower(), "file")


def _resource_entry(path):
    stat = path.stat()
    return {
        "name": path.name,
        "size": stat.st_size,
        "uploaded": datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat(),
        "kind": _kind(path.name),
    }


def list_resources(slug):
    root = resources_dir(slug)
    if not root.is_dir():
        return []
    return sorted(
        (_resource_entry(path) for path in root.iterdir() if path.is_file()),
        key=lambda entry: entry["name"].lower(),
    )


def safe_resource_name(filename):
    """Untrusted browser-supplied name -> a name safe to join onto a path.

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
    or dot-dots past the caller."""
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
    root = resources_dir(slug)
    root.mkdir(parents=True, exist_ok=True)
    path = _inside_resources(slug, name)
    if path is None:
        raise BadResource(f"the filename {filename!r} does not resolve inside Resources")
    path.write_bytes(raw_bytes)
    return _resource_entry(path)


def delete_resource(slug, name):
    if not exists(slug):
        raise UnknownClient(f"unknown client {slug!r}")
    path = _inside_resources(slug, Path(str(name or "")).name)
    if path is None or not path.is_file():
        return False
    path.unlink()
    return True
