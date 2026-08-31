"""Publishing one finished blog to a client's own WordPress.

TWO ACTS, AND THEY ARE DELIBERATELY SEPARATE. `connect` runs once, when an operator sets the
brand up: it proves the credential works and resolves WHICH post type the client's blog page
renders from, then pins the answer. `push` runs on every Post button press and does no discovery
at all: it reads the pinned answer and makes one HTTP call. That split is the whole performance
story here, and it is also the correctness story, because discovery at push time would let a
theme change silently redirect a blog into a section nobody displays.

WHY THE POST TYPE HAS TO BE RESOLVED AT ALL, since "just post to /wp/v2/posts" looks obvious.
Plenty of client themes register a custom post type (`insights`, `news`, `resources`) and render
the blog page from THAT. Posting to `posts` on such a site does not fail: WordPress answers 201,
we record an id, the UI says published, and the article sits in a section the theme never
renders. It is the one failure in this whole pipeline that is invisible from every surface, so
it is worth three HTTP calls at setup to make it impossible.

HOW IT IS RESOLVED, and it is read rather than guessed. Since WordPress 5.5 every singular page
emits a discovery header naming its own REST route:

    Link: <https://acme.com/wp-json/wp/v2/insights/412>; rel="alternate"; type="application/json"

That URL contains the post type. So connect fetches the blog page the operator pasted, follows
one article link on it, and reads that header off the article. No heuristics, no parsing of the
theme, and it is correct on a site using any custom post type.

WHY THE CATEGORY IS PINNED TOO, and it is the same failure one level down. On a site whose
permalinks are /%category%/%postname%/ -- a WordPress preset, not an exotic setup -- the category
IS the URL. Send no category and WordPress files the article under its default one, so an article
lands at /uncategorized/<slug> while every other article on the site sits at /blogs/<slug>. It is
published, it is reachable, and it is in a section their blog index does not list. So connect
reads the categories off the very article it resolved the post type from and pins them: whatever
section the operator pointed at is the section new articles join.

WE PUBLISH LIVE, NOT AS A DRAFT, and the reason is upstream of this file: the publish door is
open only once the CLIENT has approved the article in the portal (server/cms/gate.py). The
review a WordPress draft exists to enable has already happened, so filing a draft would ask the
same client to approve the same article twice, and it would leave the stored article URL
returning a 404 to everyone until somebody noticed.
"""
import re
from urllib.parse import urljoin, urlparse

from .http import TransportError, send

KIND = "wordpress"
LABEL = "WordPress"

# WordPress's own REST discovery relations. The api.w.org one is on EVERY front-end page and
# names the REST root, which is what makes a site with a rewritten rest prefix work without
# anyone configuring it. The alternate one is on SINGULAR pages only and names that post's own
# route, which is where the post type comes from.
_REST_ROOT_REL = "https://api.w.org/"
_LINK_HEADER = re.compile(r'<([^>]+)>\s*;\s*rel="([^"]+)"', re.I)
# The same two relations as <link> tags, for the case where a CDN or a proxy strips Link headers
# but leaves the document alone. WordPress emits both, so reading both costs nothing and buys
# the sites where only one survives.
_LINK_TAG = re.compile(
    r'<link[^>]+rel=["\']([^"\']+)["\'][^>]*href=["\']([^"\']+)["\']'
    r'|<link[^>]+href=["\']([^"\']+)["\'][^>]*rel=["\']([^"\']+)["\']', re.I)
# .../wp-json/wp/v2/<rest_base>/<id> -- the two things the alternate link is read for.
_ALTERNATE_ROUTE = re.compile(r"/wp/v2/([A-Za-z0-9_-]+)/(\d+)/?$")
_HREF = re.compile(r'href=["\']([^"\']+)["\']', re.I)

# THE SEO PLUGINS WHOSE FIELDS CAN BE WRITTEN OVER THE REST API, and the pair of post meta keys
# each one stores its title and description in. A client's site sets its own <title> and meta
# description from whichever of these it runs, so an article published without them takes the
# theme's fallback: the H1 verbatim, and usually no description at all. Filling them is the
# difference between the piece arriving with the SEO title the writer produced and arriving with
# whatever WordPress made up.
#
# WRITABILITY IS PROVEN, NEVER ASSUMED, WHICH IS WHY connect() PROBES. WordPress only accepts a
# meta key over REST when something registered it with show_in_rest, and a plugin being installed
# does not mean it did: Yoast's keys are protected (underscore prefixed) and unregistered on a
# default install, so posting them is silently dropped and the article publishes looking fine
# with no SEO title on it. So connect reads an existing article back with context=edit and takes
# the keys the site's own schema actually returns. What is not in that response cannot be written,
# and a site with no writable pair simply publishes without them, exactly as every push did before.
#
# AIOSEO IS ABSENT AND THAT IS NOT AN OVERSIGHT. It keeps its title and description in its own
# database table rather than in post meta, so there is no key here to write and its REST surface
# is the plugin's own namespace, not wp/v2. A site running it resolves no pair and is not lied to.
_SEO_PLUGINS = [
    ("Yoast SEO", "_yoast_wpseo_title", "_yoast_wpseo_metadesc"),
    ("Rank Math", "rank_math_title", "rank_math_description"),
    ("SEOPress", "_seopress_titles_title", "_seopress_titles_desc"),
    ("The SEO Framework", "_genesis_title", "_genesis_description"),
]

# How many links off the blog page to try before giving up on resolving the post type. An
# archive page carries a nav, a footer and a sidebar as well as its articles, so the first
# same-host link is usually not an article. Eight is enough to get past a nav on every real
# theme and small enough that a wrong URL costs a couple of seconds, not a minute.
_MAX_LINK_PROBES = 8


class ConnectError(Exception):
    """The site could not be connected, with a sentence an operator can act on.

    Every message here names what to DO, because the operator reading it is usually not the
    person who can fix it: they have to forward the sentence to whoever runs the site.
    """


def fields():
    """What the settings card asks for. Rendered generically; this file owns the labels.

    `secret` is load-bearing rather than cosmetic: server/clients.py site_summary drops every
    key marked here before the destination is returned in any HTTP body, so a field is safe
    from surfaces exactly when this list says it is.
    """
    return [
        {"key": "user", "label": "WordPress username", "secret": False,
         "help": "The username they sign in with, not their email address."},
        {"key": "password", "label": "Application password", "secret": True,
         "help": "In WordPress: Users → Profile → Application Passwords → "
                 "name it Canon → Add New. It is shown once."},
    ]


def label(site):
    """One line naming the destination, for a button and a settings card."""
    host = urlparse(site.get("url") or "").netloc or "WordPress"
    kind = site.get("post_type_label") or site.get("post_type") or ""
    # The section is shown beside the type because it is half of where an article actually
    # lands, and an operator could previously only find out by publishing one and looking.
    section = site.get("category_label") or ""
    # The SEO plugin for the same reason: whether a published article carries our title and
    # description is otherwise invisible until somebody views the source of a live page.
    seo = (site.get("seo") or {}).get("label") or ""
    if kind and section:
        inner = f"{kind} -> {section}"
    elif kind:
        inner = kind
    else:
        return f"{host}, SEO via {seo}" if seo else host
    return f"{host} ({inner}), SEO via {seo}" if seo else f"{host} ({inner})"


# ---------------------------------------------------------------------------
# Connect
# ---------------------------------------------------------------------------

async def connect(blog_url, creds, *, client=None):
    """Prove the credential and resolve where blogs go. Returns the stored destination.

    FOUR READS AND NO WRITES, so pressing Connect is safe as many times as an operator likes
    and never leaves anything behind on a client's site.
    """
    blog_url = _normalise_url(blog_url)
    user = (creds.get("user") or "").strip()
    password = (creds.get("password") or "").strip()
    if not blog_url:
        raise ConnectError("Enter the address of the client's blog page.")
    if not user or not password:
        raise ConnectError("Both the WordPress username and the application password "
                           "are needed.")
    if urlparse(blog_url).scheme != "https":
        # WordPress hides Application Passwords entirely on a non-SSL site, so this is not a
        # policy we are imposing: a credential cannot even have been created for an http site.
        raise ConnectError("The site must be on https. WordPress does not offer application "
                           "passwords on sites without SSL.")

    auth = (user, password)

    # 1. The page itself, which yields BOTH the REST root and (usually) the article links the
    #    post type is read from. One fetch doing two jobs.
    page = await _get(blog_url, client=client, label=_host(blog_url))
    if page.status_code >= 400:
        raise ConnectError(
            f"That page answered {page.status_code}. Check the blog address; it should be the "
            f"page where their articles are listed, or a link to any one article.")

    rest_root = _rest_root(page, blog_url)

    # 2. The credential, and with it the single most common real-world failure: a host running
    #    PHP as CGI/FPM strips the Authorization header before WordPress ever sees it, which is
    #    indistinguishable from a wrong password unless you say so.
    me = await _get(f"{rest_root}wp/v2/users/me?context=edit",
                    client=client, auth=auth, label=_host(blog_url))
    if me.status_code in (401, 403):
        raise ConnectError(
            "WordPress rejected the login. If the username and application password are "
            "definitely right, their server is stripping the Authorization header before "
            "WordPress sees it. Ask whoever manages the site to add this line to .htaccess:  "
            'SetEnvIf Authorization "(.*)" HTTP_AUTHORIZATION=$1')
    if me.status_code == 404:
        raise ConnectError(
            "The WordPress REST API is not reachable on that site. It is usually turned off "
            "by a security plugin such as Wordfence, or blocked by the host. Ask whoever "
            "manages the site to allow requests to /wp-json/.")
    if me.status_code >= 400:
        raise ConnectError(f"WordPress answered {me.status_code} when checking the login.")

    # 3. Where the blog actually lives, read off the article's own discovery header.
    post_type, article_url = await _resolve_post_type(page, blog_url, client=client)

    # 4. Confirm the type is one we may publish into, and get its human label.
    types = await _get(f"{rest_root}wp/v2/types?context=edit",
                       client=client, auth=auth, label=_host(blog_url))
    resolved, type_label = _validate_type(types, post_type)

    # 5. Which section of the blog the operator pointed at, so new articles join it rather
    #    than the site default. Absent on a site with nothing published yet, which is the
    #    same "unverified" case the post type already falls back on.
    categories, category_label = await _resolve_categories(
        article_url, rest_root, auth, client=client)

    # 6. Whether this site's SEO plugin will take a title and a description from us.
    seo = await _resolve_seo(rest_root, resolved, auth, client=client)

    return {
        "kind": KIND,
        "url": _origin(blog_url),
        "rest_root": rest_root,
        "blog_url": blog_url,
        "user": user,
        "password": password,
        "post_type": resolved,
        "post_type_label": type_label,
        # Term ids, exactly as wp/v2 wants them back. Empty means "say nothing about the
        # category at push time", which is the behaviour every connection had before this.
        "categories": categories,
        "category_label": category_label,
        # True only when an actual article told us the type. False means we fell back to the
        # WordPress default because the site has nothing published yet, and the settings card
        # says so rather than claiming a confidence it does not have.
        "verified": bool(post_type),
        # {"label", "title_key", "desc_key"} when this site has a writable SEO plugin, else {}.
        # Empty is ordinary and is what a site with no plugin, no published article, or a plugin
        # that keeps its fields outside post meta all resolve to.
        "seo": seo,
    }


async def _resolve_seo(rest_root, post_type, auth, *, client=None):
    """Which SEO plugin's fields this site will accept from us, or {}.

    ONE READ OF ONE EXISTING ARTICLE, and it proves the thing that matters rather than the thing
    that is easy. Detecting the plugin from the site's HTML says it is INSTALLED; what decides
    whether a push can fill its fields is whether its meta keys are registered with show_in_rest,
    and the only place that is written down is the REST response itself. So this asks the site for
    an article with context=edit and reads the meta keys it hands back.

    {} ON EVERY UNCERTAINTY, exactly as _resolve_categories degrades. A site with nothing
    published, an unreadable response, or no plugin at all all mean "publish without SEO fields",
    which is what every push did before this existed. Connect must not fail over it either: the
    post type is what it is really proving, and refusing a working destination because an SEO
    probe 500'd would trade the connection for a nicety.
    """
    try:
        listing = await _get(
            f"{rest_root}wp/v2/{post_type}?context=edit&per_page=1&_fields=meta&status=any",
            client=client, auth=auth, label=_host(rest_root))
        if listing.status_code >= 400:
            return {}
        posts = listing.json()
    except (TransportError, ValueError, TypeError):
        return {}
    if not isinstance(posts, list) or not posts:
        return {}
    meta = posts[0].get("meta") if isinstance(posts[0], dict) else None
    if not isinstance(meta, dict):
        return {}
    for label_, title_key, desc_key in _SEO_PLUGINS:
        # BOTH KEYS OR NEITHER. A plugin that exposes only its description would leave the title
        # half written, and a half-filled SEO record reads to whoever audits the site as somebody
        # having started and stopped rather than as a field this engine never fills.
        if title_key in meta and desc_key in meta:
            return {"label": label_, "title_key": title_key, "desc_key": desc_key}
    return {}


async def _resolve_post_type(page, blog_url, *, client=None):
    """(rest_base, article REST url) for the blog, or ("", "") when nothing is published yet.

    Tries the pasted page as an article first, because an operator who pastes a post URL has
    given us the exact answer and there is no reason to go looking for a different one.

    The article's own REST url comes back alongside the type because the SAME article answers
    the second question connect asks -- which section new posts belong in -- and it was already
    being thrown away here.
    """
    direct = _alternate(page)
    if direct[0]:
        return direct

    # An archive, then. Its article links are what carry the header, and they sit among a nav,
    # a footer and a sidebar, so several are tried before giving up.
    origin = _origin(blog_url)
    seen = set()
    for href in _HREF.findall(page.text or ""):
        target = urljoin(blog_url, href.strip())
        if _origin(target) != origin or target.rstrip("/") == blog_url.rstrip("/"):
            continue
        target = target.split("#")[0]
        if target in seen:
            continue
        seen.add(target)
        if len(seen) > _MAX_LINK_PROBES:
            break
        try:
            article = await _get(target, client=client, label=_host(blog_url))
        except TransportError:
            continue
        if article.status_code >= 400:
            continue
        found = _alternate(article)
        if found[0]:
            return found
    return "", ""


async def _resolve_categories(article_url, rest_root, auth, *, client=None):
    """(term ids, one-line label) for the section the exemplar article sits in.

    ([], "") ON EVERY UNCERTAINTY, and that is not laziness about errors: an empty list means
    push says nothing about the category, which is exactly what it did before this existed. So
    a site with nothing published, a custom post type carrying no categories, or an unreadable
    response all degrade to the old behaviour rather than to a wrong section. Connect must not
    fail over this either -- the post type is what it is really proving, and refusing a working
    connection because a category lookup 500'd would trade a working destination for a cosmetic.

    ONLY `categories`, deliberately. WordPress builds a URL from a term for exactly one
    taxonomy, the built-in %category% on posts; a custom post type's permalink is rewritten
    from the post type slug, not from any term. Copying an exemplar's tags across every future
    article would also be plain wrong, because tags describe an article and a section does not.
    """
    if not article_url:
        return [], ""
    try:
        article = await _get(f"{article_url}?context=edit&_fields=categories",
                             client=client, auth=auth, label=_host(article_url))
        if article.status_code >= 400:
            return [], ""
        ids = [int(t) for t in (article.json() or {}).get("categories") or []]
    except (TransportError, ValueError, TypeError, AttributeError):
        return [], ""
    if not ids:
        return [], ""

    # The names, purely so the settings card can SAY where articles will land. This whole
    # class of bug is invisible from every surface, so showing the answer is the cheap half
    # of fixing it. A failure here costs the label and never the ids.
    names = []
    try:
        listing = await _get(
            f"{rest_root}wp/v2/categories?include={','.join(str(i) for i in ids)}"
            f"&_fields=id,name&per_page=100",
            client=client, auth=auth, label=_host(rest_root))
        if listing.status_code < 400:
            names = [str(t.get("name") or "") for t in (listing.json() or [])
                     if isinstance(t, dict) and t.get("name")]
    except (TransportError, ValueError, TypeError):
        names = []
    return ids, ", ".join(n for n in names if n)


def _validate_type(response, post_type):
    """(rest_base, label) for a type we may publish into, else ConnectError.

    THE REFUSALS ARE THE POINT, and they are here rather than in the settings dropdown because
    a dropdown is a courtesy and this is the guard. A hierarchical type is a PAGE, and this
    door has no business creating pages on a client's site. A type WordPress will not render on
    the front end is not a blog, and publishing into one is the invisible failure this whole
    resolution step exists to prevent.
    """
    try:
        types = response.json()
    except ValueError:
        types = None
    if not isinstance(types, dict):
        # Nothing to validate against. Fall through with the default rather than refusing a
        # connection over a response shape: the push itself will 404 loudly if this is wrong.
        return post_type or "posts", ""

    by_base = {}
    for entry in types.values():
        if isinstance(entry, dict) and entry.get("rest_base"):
            by_base[str(entry["rest_base"])] = entry

    if post_type:
        entry = by_base.get(post_type)
        if entry is None:
            raise ConnectError(
                f"Their blog renders from '{post_type}', but that is not something this "
                f"WordPress will accept posts into over the API.")
        if entry.get("hierarchical"):
            raise ConnectError(
                f"'{post_type}' is a page type, not a blog type. Canon does not create pages "
                f"on a client's site. Point it at the page where their articles are listed.")
        if entry.get("viewable") is False:
            raise ConnectError(
                f"'{post_type}' is not shown on the front end of their site, so an article "
                f"published there would be invisible.")
        return post_type, str(entry.get("name") or "")

    # Nothing published yet: fall back to the WordPress default, which is right on the large
    # majority of sites and is marked unverified so the card can say so.
    entry = by_base.get("posts")
    if entry is None:
        raise ConnectError(
            "This site has no blog section Canon can post into. Ask whoever manages it to "
            "enable Posts, or point Canon at a custom post type once one exists.")
    return "posts", str(entry.get("name") or "Posts")


# ---------------------------------------------------------------------------
# Push
# ---------------------------------------------------------------------------

async def push(article, site, remote, *, client=None):
    """Publish one article. Returns the receipt every destination answers with.

    `remote` is None on a first push, else {"post_id": str, "pushed_at": datetime|None}: what
    the record already knows about this article on their site.
    """
    rest_root = site.get("rest_root") or f"{site['url'].rstrip('/')}/wp-json/"
    base = site.get("post_type") or "posts"
    auth = (site.get("user") or "", site.get("password") or "")
    host = _host(site.get("url") or "")
    endpoint = f"{rest_root}wp/v2/{base}"

    post_id = (remote or {}).get("post_id")

    body = {
        "title": article["title"],
        "content": article["body_html"],
        "status": "publish",
    }
    if article.get("excerpt"):
        body["excerpt"] = article["excerpt"]
    if article.get("slug"):
        body["slug"] = article["slug"]
    if not post_id and site.get("categories"):
        # At creation the category decides the URL on a /%category%/%postname%/ site, so
        # leaving it unsaid files the article under the site default, away from every other
        # article. An UPDATE is handled below, where the post's current sections are known.
        body["categories"] = site["categories"]

    # The SEO title and description, into whichever plugin's keys connect() proved writable.
    # Empty on a site with no such plugin, which is every push before this existed.
    seo = _seo_meta(site, article)
    if seo and not post_id:
        body["meta"] = seo
    # author is deliberately absent: the article lands under the user whose application
    # password we are holding, which is the correct byline on a client's own site. The
    # Strategi CMS byline in cms/payload.py is Strategi's own and must not travel here.

    if post_id:
        existing = await _get(f"{endpoint}/{post_id}?context=edit",
                              client=client, auth=auth, label=host)
        if existing.status_code == 404:
            raise TransportError(
                f"Article {post_id} no longer exists on {host}. It was deleted there, so "
                f"there is nothing to update.", status=404)
        if existing.status_code < 400 and _edited_since(existing, (remote or {}).get("pushed_at")):
            # Somebody edited it on their site after our last push. Overwriting would destroy
            # their work silently, which is the one outcome no button press should be able to
            # produce. Reported as a success, because the article IS published: nothing is
            # broken, we simply declined to clobber a newer version.
            return _receipt(existing, created=False, updated=False, skipped="edited_on_site")
        # WE FILL AN EMPTY SEO FIELD AND NEVER OVERWRITE A WRITTEN ONE. On an update the post
        # already exists and somebody may have typed a title or a description into it on their
        # side; replacing that with ours would silently discard a person's editorial decision,
        # which is the same rule _edited_since keeps for the body. A field that is still empty is
        # nobody's decision, so filling it takes nothing from anyone. A first push has no existing
        # post and no such question, which is why that arm sends the pair unconditionally above.
        unfilled = _unfilled_seo(existing, seo)
        if unfilled:
            body["meta"] = unfilled

        drifted = _drifted_section(existing, site.get("categories"))
        if drifted:
            # THE ARTICLE IS NOT IN THE BLOG SECTION AT ALL, so put it back. Without this an
            # article that was ever created in the wrong section can never be moved out of it
            # from the app: every later press takes this branch, and a branch that says nothing
            # about the category leaves the article wherever it first landed. That is the state
            # this whole change exists to make impossible, so leaving one door to it open would
            # only move the bug.
            #
            # SHARING ANY PINNED SECTION IS LEFT ALONE, which is what keeps this from fighting
            # the client. An article in blogs, or in blogs AND their own extra category, is
            # where it belongs and its URL is not touched. Only an article filed entirely
            # outside the blog section is moved, and "entirely outside" is the site default
            # every unfiled post lands in.
            body["categories"] = drifted
        response = await _post(f"{endpoint}/{post_id}", body,
                               client=client, auth=auth, label=host)
    else:
        response = await _post(endpoint, body, client=client, auth=auth, label=host)

    if response.status_code == 404:
        raise TransportError(
            f"'{base}' no longer exists on {host}, so there is nowhere to publish. Their site "
            f"has changed since it was connected; reconnect it from Settings.", status=404)
    if response.status_code >= 400:
        raise TransportError(_error_message(response), status=response.status_code)

    return _receipt(response, created=not post_id, updated=bool(post_id), skipped=None)


async def unpublish(site, remote, *, force=False, hard=False, client=None):
    """Take one published article back off the client's site. Returns a receipt like push's.

    THE INVERSE OF push(), AND IT IS A STATUS FLIP RATHER THAN A DELETE. push sends
    {"status": "publish"} (see the module docstring); this sends {"status": "draft"}. A drafted
    post is unreachable to the public: WordPress answers its URL with the theme's 404 for anyone
    without edit rights, it leaves the blog index, the feed and the sitemap, and the article,
    its body, its slug and its whole revision history stay exactly where they were.

    WHY NOT ONE OF THE OTHER FOUR THINGS THIS COULD MEAN. Each was considered and each is worse:

      status=private   Anyone signed in to their own site still sees it, prefixed "Private:".
                       A button that says the article is off the site would be lying to the
                       operator about what a logged-in editor sees.
      status=pending   Files the article in the client's editorial review queue, asserting a
                       workflow that never happened and putting our act in their inbox.
      DELETE (trash)   WordPress renames post_name to "<slug>__trash", RELEASING THE SLUG. If
                       anyone creates a post at that slug in the interval, a later re-publish
                       lands at "<slug>-2" and the original URL 404s forever. On a product whose
                       whole business is being cited at a stable URL that is the one irreversible
                       outcome, so it is behind `hard` and never the default.
      DELETE ?force    Permanent, and it invalidates cms_post_id: every later Post press then
                       hits push()'s "no longer exists" branch and fails forever. It is exactly
                       the "destroy their work silently" outcome push() refuses to produce,
                       executed deliberately.

    `hard=True` is the operator explicitly asking for the trash can, and it is offered because
    the operator asked for delete semantics by name. It still uses the ordinary trash rather
    than ?force=true, so the client can restore it from their own Trash: an irreversible
    purge of a client's content is not something this engine should be able to do at all.

    ORDER IS LOAD-BEARING AND IS WHAT MAKES THIS RETRY-SAFE. The GET comes first and four
    branches return WITHOUT writing:

      404                     -> skipped="gone". Somebody deleted it there; nothing to do.
      status is not "publish" -> skipped="already_draft". THIS IS THE IDEMPOTENCE. If the record
                                 write failed after a successful flip, the retry finds a post we
                                 already drafted and stops. Without it the retry would fall to
                                 _edited_since, which compares against a modified stamp OUR OWN
                                 flip just bumped, and would tell the operator the client edited
                                 an article nobody touched.
      edited since our push   -> skipped="edited_on_site", unless force. push() refuses this
                                 outright because overwriting DESTROYS their work; a status flip
                                 destroys nothing, so the ban does not carry over whole. What
                                 does carry is push()'s other word, SILENTLY: the operator is
                                 told, names the date, and decides. force=True is that decision.
    """
    rest_root = site.get("rest_root") or f"{site['url'].rstrip('/')}/wp-json/"
    base = site.get("post_type") or "posts"
    auth = (site.get("user") or "", site.get("password") or "")
    host = _host(site.get("url") or "")
    endpoint = f"{rest_root}wp/v2/{base}"

    post_id = (remote or {}).get("post_id")
    if not post_id:
        raise TransportError(
            f"The record holds no post id for this article on {host}, so there is nothing to "
            f"take down.", status=409)

    existing = await _get(f"{endpoint}/{post_id}?context=edit",
                          client=client, auth=auth, label=host)
    if existing.status_code == 404:
        return _receipt(existing, created=False, updated=False, skipped="gone")
    if existing.status_code >= 400:
        raise TransportError(_error_message(existing), status=existing.status_code)

    try:
        current = (existing.json() or {}).get("status")
    except ValueError:
        current = None
    if current is not None and current != "publish" and not hard:
        return _receipt(existing, created=False, updated=False, skipped="already_draft")

    if not force and _edited_since(existing, (remote or {}).get("pushed_at")):
        return _receipt(existing, created=False, updated=False, skipped="edited_on_site")

    if hard:
        # The ordinary trash, never ?force=true: recoverable from the client's own Trash.
        response = await send("DELETE", f"{endpoint}/{post_id}",
                              client=client, auth=auth, label=host)
    else:
        response = await _post(f"{endpoint}/{post_id}", {"status": "draft"},
                               client=client, auth=auth, label=host)

    if response.status_code >= 400:
        raise TransportError(_error_message(response), status=response.status_code)
    return _receipt(response, created=False, updated=True, skipped=None)


def _seo_meta(site, article):
    """{plugin key: value} for the article's SEO title and description, or {}.

    The keys come from the STORED destination, so a site whose plugin was never proved writable
    resolves nothing here and the push is byte for byte what it always was. A field the payload
    did not produce is left out rather than sent empty: writing "" would blank a value the site
    might already hold, which is the one thing an SEO write must not do.
    """
    seo = site.get("seo") or {}
    title_key = seo.get("title_key")
    desc_key = seo.get("desc_key")
    if not title_key or not desc_key:
        return {}
    out = {}
    if article.get("meta_title"):
        out[title_key] = article["meta_title"]
    if article.get("meta_description"):
        out[desc_key] = article["meta_description"]
    return out


def _unfilled_seo(existing, seo):
    """The subset of `seo` whose keys are empty on the post as it stands on their site.

    {} WHEN THE POST CANNOT BE READ, which is the safe direction: an unreadable meta object is
    one this function cannot prove is empty, and the rule is fill-if-empty rather than
    fill-unless-proven-full.
    """
    if not seo:
        return {}
    try:
        meta = (existing.json() or {}).get("meta")
    except (ValueError, AttributeError):
        return {}
    if not isinstance(meta, dict):
        return {}
    return {key: value for key, value in seo.items()
            if not str(meta.get(key) or "").strip()}


def _drifted_section(existing, pinned):
    """The sections to move an article back into, or [] to say nothing about its sections.

    Answers [] on every uncertainty for the same reason connect pins nothing on one: saying
    nothing leaves the article exactly where it is, which is always safe, while guessing moves
    a live URL on a client's site.

    NOT A UNION with what the article already has, and that is the one non-obvious part. The
    section an article lands in is the one WordPress picks for %category%, which is the lowest
    term id among its categories. Uncategorized is term 1 on every WordPress install ever made,
    so it wins that tie against any category created afterwards: adding blogs to an article
    already in Uncategorized would leave the URL under /uncategorized exactly as before, having
    changed something and fixed nothing.
    """
    pinned = [int(t) for t in (pinned or [])]
    if not pinned:
        return []
    try:
        current = (existing.json() or {}).get("categories")
    except (ValueError, AttributeError):
        return []
    if not isinstance(current, list) or not current:
        return []
    return [] if set(pinned) & {int(t) for t in current if isinstance(t, int)} else pinned


def _receipt(response, *, created, updated, skipped):
    """The uniform shape every driver answers with, from a WordPress post object."""
    try:
        post = response.json()
    except ValueError:
        post = {}
    if not isinstance(post, dict):
        post = {}
    return {
        "post_id": str(post.get("id")) if post.get("id") is not None else None,
        "url": post.get("link") or None,
        "slug": post.get("slug") or None,
        "status": post.get("status") or None,
        "created": created,
        "updated": updated,
        "skipped": skipped,
    }


def _edited_since(response, pushed_at):
    """True when their copy was modified after we last pushed it.

    Unknown answers FALSE: with no stamp on either side there is no evidence of an edit, and
    refusing every update on the absence of evidence would make the button useless on every
    article published before this column existed.
    """
    if pushed_at is None:
        return False
    try:
        post = response.json()
    except ValueError:
        return False
    raw = (post or {}).get("modified_gmt") if isinstance(post, dict) else None
    if not raw:
        return False
    from datetime import datetime, timezone
    try:
        # WordPress emits naive ISO in UTC on the _gmt fields. Stamp the zone so the compare
        # is against an aware datetime rather than raising a TypeError inside a publish.
        modified = datetime.fromisoformat(str(raw)).replace(tzinfo=timezone.utc)
    except ValueError:
        return False
    stamp = pushed_at if pushed_at.tzinfo else pushed_at.replace(tzinfo=timezone.utc)
    # A second of slack: WordPress records modified_gmt when IT wrote the row, which is a
    # moment after our request left, so an exact compare reports our own push as their edit.
    return (modified - stamp).total_seconds() > 1


def _error_message(response):
    """WordPress's own words for a refusal.

    Its errors carry {"code": ..., "message": ...} and the message names the field or the
    capability that was wrong, which is the entire value of the error to whoever fixes it.
    """
    try:
        body = response.json()
    except ValueError:
        body = None
    if isinstance(body, dict) and body.get("message"):
        return str(body["message"])
    text = (response.text or "").strip()
    return text[:300] if text else f"HTTP {response.status_code}"


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------

async def _get(url, *, client=None, auth=None, label="the site"):
    return await send("GET", url, client=client, auth=auth, label=label,
                      headers={"Accept": "application/json, text/html"})


async def _post(url, body, *, client=None, auth=None, label="the site"):
    return await send("POST", url, client=client, auth=auth, label=label, json=body)


def _normalise_url(raw):
    """Accept what an operator actually pastes: bare hosts, trailing slashes, whitespace."""
    url = (raw or "").strip()
    if not url:
        return ""
    if not re.match(r"^https?://", url, re.I):
        url = f"https://{url}"
    return url


def _origin(url):
    parts = urlparse(url)
    return f"{parts.scheme}://{parts.netloc}" if parts.netloc else ""


def _host(url):
    return urlparse(url).netloc or "the site"


def _links(response):
    """Every rel -> href this response declares, from the Link header AND the document.

    Both, because a CDN or a proxy in front of the site may strip Link headers while leaving
    the <link> tags in the body untouched. WordPress emits the same relations in both places.
    """
    found = {}
    for href, rel in _LINK_HEADER.findall(response.headers.get("Link", "") or ""):
        found.setdefault(rel.strip().lower(), href.strip())
    ctype = response.headers.get("Content-Type", "")
    if "html" in ctype.lower():
        for rel_a, href_a, href_b, rel_b in _LINK_TAG.findall(response.text or ""):
            rel, href = (rel_a or rel_b), (href_a or href_b)
            if rel and href:
                found.setdefault(rel.strip().lower(), href.strip())
    return found


def _rest_root(page, blog_url):
    """The site's REST root, as the site itself declares it.

    Read rather than assumed, because a site may serve its API from a rewritten prefix, and
    assuming /wp-json/ there produces a 404 that reads like "the REST API is disabled".
    """
    declared = _links(page).get(_REST_ROOT_REL.lower())
    root = declared or f"{_origin(blog_url)}/wp-json/"
    return root if root.endswith("/") else f"{root}/"


def _alternate(response):
    """(rest_base, REST url) named by this page's own route, or ("", "") when it names none.

    Only singular pages carry it, which is exactly the property being used: an archive
    answering "" is how the caller knows to go looking at the articles on it.
    """
    href = _links(response).get("alternate", "")
    match = _ALTERNATE_ROUTE.search(href)
    return (match.group(1), href) if match else ("", "")
