#!/usr/bin/env python3
"""
page_digest.py: collapse a scraped page into a compact JSON digest.

Why this exists. A client homepage is 100k to 500k tokens of raw HTML and the
report needs none of the prose. This reads the HTML off disk, answers every
structural question the report asks, and prints a few hundred tokens of JSON.
The HTML never enters the model's context.

It also settles embed attribution deterministically. Facebook and Instagram
embeds inject their own meta tags and SocialMediaPosting schema into the host
document, and scrapers flatten them into the page. Those tags are not the
client's. Every JSON-LD block and every robots-family meta tag is tagged
first_party or embed_artifact by walking its DOM ancestry, not by proximity:
proximity misfires badly on short pages, where a single window swallows the
whole document and throws away the client's real schema. The judgement is made
once, in code, and each verdict carries the reason that produced it.

Usage:
    python3 page_digest.py <path> [--url URL] [--out digest.json]

<path> accepts a raw .html file, or the tool-result JSON that Firecrawl spills
to /mnt/user-data/tool_results/ at any nesting depth. The loader hunts for the
HTML payload itself, so paste the path and move on.
"""

import argparse
import json
import re
import sys
from collections import Counter
from urllib.parse import urlparse

from bs4 import BeautifulSoup

# An embed's tags live inside the embed's own container. Ancestry decides
# ownership; nothing is judged by how close it sits in the byte stream.
EMBED_CONTAINER_CLASS_RE = re.compile(r"\bfb-[a-z_]+\b|\bfb_iframe_widget\b|\binstagram-\w+\b|\btwitter-tweet\b", re.I)
EMBED_IFRAME_SRC_RE = re.compile(
    r"facebook\.com/plugins|facebook\.com/v\d|instagram\.com/[^\"']*embed|platform\.instagram\.com", re.I
)
EMBED_REF_RE = re.compile(
    r"facebook\.com/plugins|connect\.facebook\.net|instagram\.com/[^\"']*embed|platform\.instagram\.com", re.I
)
SOCIAL_ONLY_TYPES = {"SocialMediaPosting", "DiscussionForumPosting", "Comment", "InteractionCounter"}

FINGERPRINTS = [
    ("WordPress", r"/wp-content/|/wp-includes/|wp-json"),
    ("Elementor", r"elementor"),
    ("WPBakery", r"js_composer|vc_row"),
    ("Divi", r"/themes/Divi/"),
    ("Shopify", r"cdn\.shopify\.com|shopify\.theme"),
    ("Wix", r"static\.parastorage\.com|wixstatic"),
    ("Squarespace", r"squarespace\.com|sqs-block"),
    ("Webflow", r"webflow\.com|w-webflow"),
    ("Next.js", r"/_next/static|__NEXT_DATA__"),
    ("React", r"react(-dom)?(\.production)?\.min\.js|data-reactroot"),
    ("jQuery", r"jquery[.-]"),
    ("Revolution Slider", r"rev(olution)?slider"),
    ("Slick/Swiper", r"slick\.min\.js|swiper[.-]"),
    ("Cloudflare", r"cdnjs\.cloudflare\.com|/cdn-cgi/"),
    ("Google Tag Manager", r"googletagmanager\.com/gtm\.js|GTM-[A-Z0-9]+"),
    ("Google Analytics 4", r"gtag/js\?id=G-|G-[A-Z0-9]{8,}"),
    ("Universal Analytics (dead)", r"UA-\d{4,}-\d+|analytics\.js"),
    ("Meta Pixel", r"connect\.facebook\.net/[^\"']*fbevents"),
    ("Font Awesome", r"font-?awesome"),
    ("Google Fonts", r"fonts\.googleapis\.com"),
]

ANALYTICS_ID_RE = re.compile(r"\b(GTM-[A-Z0-9]{4,}|G-[A-Z0-9]{8,}|UA-\d{4,}-\d+|AW-\d{6,})\b")


def load_html(path):
    """Return the HTML string from a raw file or an arbitrarily nested tool result."""
    raw = open(path, "rb").read().decode("utf-8", "replace")
    stripped = raw.lstrip()
    if not stripped.startswith(("{", "[")):
        return raw
    try:
        data = json.loads(raw)
    except Exception:
        return raw

    found = []

    def looks_like_html(s):
        low = s[:4000].lower()
        return "<html" in low or "<head" in low or "<!doctype" in low or "<body" in low

    def walk(node, depth=0):
        if found or depth > 10:
            return
        if isinstance(node, dict):
            for key in ("rawHtml", "raw_html", "html", "content"):
                val = node.get(key)
                if isinstance(val, str) and looks_like_html(val):
                    found.append(val)
                    return
            for val in node.values():
                walk(val, depth + 1)
        elif isinstance(node, list):
            for val in node:
                walk(val, depth + 1)
        elif isinstance(node, str):
            inner = node.lstrip()
            if inner.startswith(("{", "[")):
                try:
                    walk(json.loads(node), depth + 1)
                except Exception:
                    pass
            elif looks_like_html(node):
                found.append(node)

    walk(data)
    return found[0] if found else raw


def build_embed_roots(soup):
    """Elements whose subtree belongs to a social embed rather than to the client."""
    roots = []
    for el in soup.find_all(True):
        classes = " ".join(el.get("class") or [])
        if classes and EMBED_CONTAINER_CLASS_RE.search(classes):
            roots.append(el)
            continue
        if el.name == "iframe" and EMBED_IFRAME_SRC_RE.search(el.get("src") or ""):
            parent = el.parent
            roots.append(parent if parent is not None and parent.name not in ("body", "html", "[document]") else el)
        elif el.name == "title" and (el.get_text() or "").strip().lower() in ("facebook", "instagram"):
            parent = el.parent
            if parent is not None and parent.name not in ("head", "body", "html", "[document]"):
                roots.append(parent)
    return roots


def attribution(el, roots):
    """(verdict, reason). Client CMS writes <head>; embeds inject into <body>."""
    for anc in el.parents:
        if anc.name == "head":
            return "first_party", "in <head>"
        for r in roots:
            if anc is r:
                cls = " ".join(r.get("class") or []) or r.name
                return "embed_artifact", "inside embed container <%s class=%r>" % (r.name, cls)
    return "first_party", "in <body>, no embed ancestor"


def in_embed(el, roots):
    """True when el sits inside a social-embed subtree.

    Images, headings and scripts injected by a Facebook or Instagram embed are
    not the client's. Counting them corrupts alt-text stats and heading counts
    the same way embed schema would corrupt the entity graph, so the on-page
    counters exclude them by the same DOM-ancestry test the schema path uses.
    """
    for anc in el.parents:
        for r in roots:
            if anc is r:
                return True
    return False


def top_level_types(data):
    """The primary @type(s) a JSON-LD block declares, ignoring nested utility
    types. A LocalBusiness with a nested PostalAddress and GeoCoordinates is one
    LocalBusiness, not three entities, so first_party_types should not read as
    though the site ships a rich graph it does not have."""
    nodes = []
    if isinstance(data, list):
        nodes = data
    elif isinstance(data, dict):
        if isinstance(data.get("@graph"), list):
            nodes = data["@graph"]
        else:
            nodes = [data]
    out = []
    for n in nodes:
        if isinstance(n, dict):
            t = n.get("@type")
            if isinstance(t, str):
                out.append(t)
            elif isinstance(t, list):
                out.extend(x for x in t if isinstance(x, str))
    return sorted(set(out))


def collect_types(node, out):
    if isinstance(node, dict):
        t = node.get("@type")
        if isinstance(t, str):
            out.append(t)
        elif isinstance(t, list):
            out.extend(x for x in t if isinstance(x, str))
        for v in node.values():
            collect_types(v, out)
    elif isinstance(node, list):
        for v in node:
            collect_types(v, out)


def suspicious_values(node, out, path=""):
    """Flag schema values that are obviously broken. Quote these verbatim in the report."""
    if isinstance(node, dict):
        for k, v in node.items():
            here = f"{path}.{k}" if path else k
            if isinstance(v, str):
                if k in ("addressCountry", "addressRegion") and v.isdigit():
                    out.append({"key": here, "value": v, "why": "numeric where a name or ISO code belongs"})
                elif k in ("telephone", "email", "url", "sameAs") and not v.strip():
                    out.append({"key": here, "value": v, "why": "declared but empty"})
                elif k == "priceRange" and len(v) > 40:
                    out.append({"key": here, "value": v[:60], "why": "prose in a priceRange field"})
                elif v.strip().lower() in ("n/a", "na", "tbd", "null", "undefined", "none"):
                    out.append({"key": here, "value": v, "why": "placeholder left in production"})
            else:
                suspicious_values(v, out, here)
    elif isinstance(node, list):
        for i, v in enumerate(node):
            suspicious_values(v, out, f"{path}[{i}]")


def schema_blocks(soup, roots):
    blocks = []
    for el in soup.find_all("script"):
        t = (el.get("type") or "").lower()
        if "ld+json" not in t:
            continue
        body = (el.string or el.get_text() or "").strip()
        verdict, reason = attribution(el, roots)
        rec = {
            "attribution": verdict,
            "attribution_reason": reason,
            "valid_json": True,
            "types": [],
            "top_level_keys": [],
            "bytes": len(body),
        }
        try:
            data = json.loads(body)
        except Exception as e:
            rec["valid_json"] = False
            rec["error"] = str(e)[:140]
            rec["types"] = sorted(set(re.findall(r'"@type"\s*:\s*"([^"]+)"', body)))
            blocks.append(rec)
            continue

        types = []
        collect_types(data, types)
        rec["types"] = sorted(set(types))
        rec["top_level_types"] = top_level_types(data)

        # A block that is nothing but social types is the embed's, wherever it sits.
        if rec["types"] and set(rec["types"]).issubset(SOCIAL_ONLY_TYPES) and verdict == "first_party":
            rec["attribution"] = "embed_artifact"
            rec["attribution_reason"] = "every @type in the block is a social-embed type"

        root = data
        if isinstance(root, list) and root and isinstance(root[0], dict):
            root = root[0]
        if isinstance(root, dict):
            rec["top_level_keys"] = sorted(root.keys())
            if isinstance(root.get("@graph"), list):
                rec["graph_nodes"] = len(root["@graph"])

        bad = []
        suspicious_values(data, bad)
        if bad:
            rec["suspicious_values"] = bad[:8]
        blocks.append(rec)
    return blocks


def robots_family(soup, roots):
    out = []
    for el in soup.find_all("meta"):
        name = (el.get("name") or "").lower()
        if name in ("robots", "googlebot", "bingbot", "referrer"):
            verdict, reason = attribution(el, roots)
            out.append({"name": name, "content": el.get("content"),
                        "attribution": verdict, "attribution_reason": reason})
    return out


def headings(soup, roots):
    """Client headings only. An embed's own <h2> ("See our latest post") is not
    the client's heading structure and must not be counted as one."""
    found = {1: [], 2: [], 3: []}
    for el in soup.find_all(["h1", "h2", "h3"]):
        if in_embed(el, roots):
            continue
        lvl = int(el.name[1])
        text = re.sub(r"\s+", " ", el.get_text()).strip()
        if text:
            found[lvl].append(text[:110])
    return {
        "h1_count": len(found[1]),
        "h1_text": found[1][:5],
        "h2_count": len(found[2]),
        "h2_text": found[2][:14],
        "h3_count": len(found[3]),
    }


def images(soup, roots):
    """Client images only. Facebook and Instagram embeds inject alt-less <img>
    tags with scontent CDN sources; counting them inflates the missing-alt tally
    and, worse, drops foreign CDN URLs into samples_worth_quoting, which House
    Rules would then quote verbatim into the client's report."""
    missing = 0
    empty = 0
    filename_alt = 0
    good = 0
    samples = []
    total = 0
    for el in soup.find_all("img"):
        if in_embed(el, roots):
            continue
        total += 1
        a = el.get("alt")
        src = el.get("src") or el.get("data-src") or ""
        if a is None:
            missing += 1
            if len(samples) < 5:
                samples.append({"src": src[-70:], "alt": None})
        elif not a.strip():
            empty += 1
        elif re.search(r"\.(jpe?g|png|webp|gif|svg)$", a.strip(), re.I) or re.match(r"^(IMG|DSC|PXL)[-_ ]?\d+", a.strip(), re.I):
            filename_alt += 1
            if len(samples) < 5:
                samples.append({"src": src[-70:], "alt": a[:60]})
        else:
            good += 1
    return {
        "total": total,
        "alt_missing": missing,
        "alt_empty": empty,
        "alt_is_filename": filename_alt,
        "alt_descriptive": good,
        "samples_worth_quoting": samples,
    }


def third_party(soup, roots):
    """Third-party script hosts the client loads, excluding an embed's own
    scripts (connect.facebook.net and friends), which belong to the embed, not
    to the client's stack choices."""
    hosts = Counter()
    for el in soup.find_all("script"):
        if in_embed(el, roots):
            continue
        src = el.get("src")
        if not src:
            continue
        if src.startswith("//"):
            src = "https:" + src
        if src.startswith("http"):
            host = urlparse(src).netloc.lower()
            if host:
                hosts[host] += 1
    return [{"host": h, "scripts": n} for h, n in hosts.most_common(12)]


def digest(html, url=None):
    # html.parser deliberately, not lxml: lxml "repairs" documents by relocating
    # stray <title> and <meta> into <head>, which would launder an embed's tags
    # into the client's head and invert the exact judgement this script exists to make.
    soup = BeautifulSoup(html, "html.parser")
    roots = build_embed_roots(soup)

    head = soup.head
    title_el = head.find("title") if head else soup.find("title")
    title = title_el.get_text().strip() if title_el else None

    desc = None
    og = {}
    for el in soup.find_all("meta"):
        name = (el.get("name") or "").lower()
        prop = (el.get("property") or "").lower()
        if name == "description" and desc is None:
            desc = el.get("content")
        if prop.startswith("og:") and attribution(el, roots)[0] == "first_party":
            og.setdefault(prop, el.get("content"))

    canonical = None
    for el in soup.find_all("link"):
        rel = el.get("rel") or []
        if "canonical" in [r.lower() for r in rel]:
            canonical = el.get("href")
            break

    gen = None
    for el in soup.find_all("meta"):
        if (el.get("name") or "").lower() == "generator":
            gen = el.get("content")
            break

    stack = [name for name, pat in FINGERPRINTS if re.search(pat, html, re.I)]
    ids = sorted(set(ANALYTICS_ID_RE.findall(html)))

    blocks = schema_blocks(soup, roots)
    first = [b for b in blocks if b["attribution"] == "first_party"]
    embed = [b for b in blocks if b["attribution"] == "embed_artifact"]

    return {
        "url": url,
        "bytes_html": len(html),
        "title": title,
        "title_length": len(title) if title else 0,
        "meta_description": desc,
        "meta_description_length": len(desc) if desc else 0,
        "canonical": canonical,
        "og_tags_first_party": sorted(og.keys()),
        "generator": gen,
        "stack_fingerprint": stack,
        "analytics_ids": ids,
        "robots_family_meta": robots_family(soup, roots),
        "content_scope": "client-only: social-embed subtrees are excluded from headings, images and third_party_script_hosts by DOM ancestry",
        "headings": headings(soup, roots),
        "images": images(soup, roots),
        "third_party_script_hosts": third_party(soup, roots),
        "schema": {
            "blocks_total": len(blocks),
            "first_party_blocks": len(first),
            "embed_artifact_blocks": len(embed),
            "first_party_types": sorted({t for b in first for t in b.get("top_level_types", b["types"])}),
            "first_party_nested_types": sorted({t for b in first for t in b["types"]}),
            "embed_artifact_types": sorted({t for b in embed for t in b.get("top_level_types", b["types"])}),
            "invalid_json_blocks": sum(1 for b in blocks if not b["valid_json"]),
            "detail_first_party": first[:10],
            "detail_embed_artifact": [
                {"types": b["types"], "reason": b["attribution_reason"]} for b in embed[:6]
            ],
        },
        "social_embed_containers": len(roots),
        "social_embed_references": len(EMBED_REF_RE.findall(html)),
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("path", help="raw .html file, or a Firecrawl tool-result JSON")
    ap.add_argument("--url", default=None, help="the page URL, for the record")
    ap.add_argument("--out", default=None, help="also write the digest to this path")
    args = ap.parse_args()

    html = load_html(args.path)
    if len(html) < 200:
        print(json.dumps({"error": "no HTML payload found", "path": args.path, "bytes": len(html)}))
        sys.exit(1)

    d = digest(html, args.url)
    text = json.dumps(d, indent=2, ensure_ascii=False)
    if args.out:
        open(args.out, "w").write(text)
    print(text)


if __name__ == "__main__":
    main()
