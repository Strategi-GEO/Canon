"""Turn a Word .docx (body + tracked comments) into markdown plus anchored comments.

WHY STDLIB AND NOT python-docx/mammoth/pandoc: a .docx is a zip of XML, and the two things
this app needs from it (the article as markdown, and each comment's text plus the passage it
is anchored to) are a shallow walk of two of those XML parts. A dependency would buy a fuller
converter we do not need and a build step Vercel does not have. zipfile + ElementTree are in
the stdlib on every machine that already runs this engine.

WHAT IT EXTRACTS:
- Body -> markdown: headings (Heading1-6/Title), paragraphs, bold/italic runs, hyperlinks,
  bullet/numbered list items, and simple tables. That is the shape a written article takes.
- Comments -> anchored change requests: each Word comment becomes {selected_text, instruction,
  author}. selected_text is the PLAIN text of the run range the comment brackets in the body,
  which is exactly what the dashboard's highlighter matches on (it normalizes whitespace and
  does an indexOf over the rendered article), so a comment lands back on its passage.

ponytail: simple tables only (no merged/nested cells), and list items are flattened to a single
"- " level (Word's numbering.xml level/ordered-vs-bullet is not read). Upgrade to reading
numbering.xml only if real client docs need ordered or nested lists rendered as such.
"""
from __future__ import annotations

import io
import zipfile
from xml.etree import ElementTree as ET

W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"

# Word style ids (case/space folded) that open a markdown heading, mapped to their prefix.
_HEADINGS = {
    "title": "# ", "heading1": "# ", "heading2": "## ", "heading3": "### ",
    "heading4": "#### ", "heading5": "##### ", "heading6": "###### ",
}


class DocxError(Exception):
    """The upload is not a readable .docx. Carries a message the route answers 422 with."""


def _local(tag: str) -> str:
    """The tag name without its {namespace}, so a walk can switch on 'p', 'r', 't' plainly."""
    return tag.rsplit("}", 1)[-1]


def _w(elem, name: str):
    return elem.find(f"{{{W}}}{name}")


def _text_of(elem) -> str:
    """Every w:t under elem, tabs as spaces and w:br as newlines, in document order."""
    out = []
    for node in elem.iter():
        tag = _local(node.tag)
        if tag == "t":
            out.append(node.text or "")
        elif tag == "tab":
            out.append(" ")
        elif tag == "br":
            out.append("\n")
    return "".join(out)


def parse(data: bytes) -> tuple[str, list[dict]]:
    """(markdown_body, comments). Raises DocxError when the bytes are not a usable .docx."""
    try:
        zf = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile as exc:
        raise DocxError("that file is not a valid Word .docx") from exc
    try:
        doc_xml = zf.read("word/document.xml")
    except KeyError as exc:
        raise DocxError("that .docx has no document body (word/document.xml missing)") from exc

    try:
        doc_root = ET.fromstring(doc_xml)
    except ET.ParseError as exc:
        raise DocxError("that .docx has an unreadable document body") from exc

    rels = _read_rels(zf)
    comments_map = _read_comments_xml(zf)

    body = doc_root.find(f"{{{W}}}body")
    markdown = _body_to_markdown(body, rels) if body is not None else ""
    comments = _extract_comments(doc_root, comments_map)
    return markdown, comments


def _read_rels(zf: zipfile.ZipFile) -> dict[str, str]:
    """Relationship id -> target URL, for resolving hyperlinks. Absent rels is the empty map."""
    try:
        root = ET.fromstring(zf.read("word/_rels/document.xml.rels"))
    except (KeyError, ET.ParseError):
        return {}
    rels = {}
    for rel in root:
        rid = rel.get("Id")
        target = rel.get("Target")
        if rid and target:
            rels[rid] = target
    return rels


def _read_comments_xml(zf: zipfile.ZipFile) -> dict[str, dict]:
    """Word comment id -> {author, text}. A doc with no comments has no comments.xml."""
    try:
        root = ET.fromstring(zf.read("word/comments.xml"))
    except (KeyError, ET.ParseError):
        return {}
    out = {}
    for comment in root.findall(f"{{{W}}}comment"):
        cid = comment.get(f"{{{W}}}id")
        if cid is None:
            continue
        out[cid] = {
            "author": (comment.get(f"{{{W}}}author") or "").strip(),
            "text": _text_of(comment).strip(),
        }
    return out


def _body_to_markdown(body, rels: dict[str, str]) -> str:
    """Body block children -> markdown, blocks separated by a blank line."""
    blocks = []
    for child in body:
        tag = _local(child.tag)
        if tag == "p":
            line = _paragraph_to_markdown(child, rels)
            if line.strip():
                blocks.append(line)
        elif tag == "tbl":
            table = _table_to_markdown(child, rels)
            if table:
                blocks.append(table)
    return "\n\n".join(blocks).strip() + "\n"


def _paragraph_to_markdown(p, rels: dict[str, str]) -> str:
    ppr = _w(p, "pPr")
    prefix = ""
    if ppr is not None:
        style_el = _w(ppr, "pStyle")
        style = (style_el.get(f"{{{W}}}val") if style_el is not None else "") or ""
        prefix = _HEADINGS.get(style.replace(" ", "").lower(), "")
        if not prefix and _w(ppr, "numPr") is not None:
            prefix = "- "
    return prefix + _inline_runs(p, rels)


def _inline_runs(container, rels: dict[str, str]) -> str:
    """Direct runs and hyperlinks of a paragraph as inline markdown, in order."""
    out = []
    for child in container:
        tag = _local(child.tag)
        if tag == "r":
            out.append(_run_to_markdown(child))
        elif tag == "hyperlink":
            text = "".join(_run_to_markdown(r) for r in child.findall(f"{{{W}}}r"))
            rid = child.get(f"{{{R}}}id")
            target = rels.get(rid) if rid else None
            out.append(f"[{text.strip()}]({target})" if target and text.strip() else text)
    return "".join(out)


def _run_to_markdown(r) -> str:
    """One run's text wrapped in ** / * per its rPr. Whitespace-only runs stay bare so a
    marker never wraps a lone space (**  ** renders as literal asterisks)."""
    text = _text_of(r)
    if not text.strip():
        return text
    rpr = _w(r, "rPr")
    bold = rpr is not None and _w(rpr, "b") is not None
    italic = rpr is not None and _w(rpr, "i") is not None
    lead = len(text) - len(text.lstrip())
    trail = len(text) - len(text.rstrip())
    core = text.strip()
    if bold:
        core = f"**{core}**"
    if italic:
        core = f"*{core}*"
    return text[:lead] + core + (text[len(text) - trail:] if trail else "")


def _table_to_markdown(tbl, rels: dict[str, str]) -> str:
    """A simple table as a markdown pipe table, first row treated as the header."""
    rows = []
    for tr in tbl.findall(f"{{{W}}}tr"):
        cells = []
        for tc in tr.findall(f"{{{W}}}tc"):
            cell = " ".join(
                _inline_runs(p, rels).strip() for p in tc.findall(f"{{{W}}}p")
            ).strip()
            cells.append(cell.replace("|", "\\|"))
        if cells:
            rows.append(cells)
    if not rows:
        return ""
    width = max(len(r) for r in rows)
    rows = [r + [""] * (width - len(r)) for r in rows]
    header = "| " + " | ".join(rows[0]) + " |"
    sep = "| " + " | ".join(["---"] * width) + " |"
    body = ["| " + " | ".join(r) + " |" for r in rows[1:]]
    return "\n".join([header, sep, *body])


def _extract_comments(doc_root, comments_map: dict[str, dict]) -> list[dict]:
    """Walk the body in order, accumulating each comment range's plain text, then join it to
    the comment's own text. Ranges can overlap, so text goes to EVERY currently-open id."""
    buffers: dict[str, list[str]] = {}
    active: set[str] = set()
    order: list[str] = []
    for node in doc_root.iter():
        tag = _local(node.tag)
        if tag == "commentRangeStart":
            cid = node.get(f"{{{W}}}id")
            if cid is not None:
                active.add(cid)
                buffers.setdefault(cid, [])
                if cid not in order:
                    order.append(cid)
        elif tag == "commentRangeEnd":
            active.discard(node.get(f"{{{W}}}id"))
        elif tag == "p" and active:
            # A paragraph break inside a range: separate words so a two-paragraph selection
            # does not mash its last and first word together.
            for cid in active:
                buffers[cid].append(" ")
        elif tag == "t" and active:
            for cid in active:
                buffers[cid].append(node.text or "")

    # A comment can exist in comments.xml with no range in the body (anchored to nothing);
    # keep it, unanchored, so the note is not silently dropped. Preserve comment.xml order for
    # any such, appended after the ones that did appear in the body.
    ordered_ids = order + [cid for cid in comments_map if cid not in order]
    out = []
    for cid in ordered_ids:
        meta = comments_map.get(cid)
        if not meta or not meta["text"]:
            continue
        out.append({
            "selected_text": " ".join("".join(buffers.get(cid, [])).split()),
            "instruction": meta["text"],
            "author": meta["author"],
        })
    return out


def _demo() -> None:
    """Build a tiny .docx in memory with a heading, a bold run, and one comment bracketing a
    passage, then assert the parse recovers all three. Runs with no Word install and no deps."""
    body = (
        f'<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr>'
        f'<w:r><w:t>My Title</w:t></w:r></w:p>'
        f'<w:p>'
        f'<w:r><w:t xml:space="preserve">The </w:t></w:r>'
        f'<w:commentRangeStart w:id="0"/>'
        f'<w:r><w:rPr><w:b/></w:rPr><w:t>quick brown fox</w:t></w:r>'
        f'<w:commentRangeEnd w:id="0"/>'
        f'<w:r><w:commentReference w:id="0"/></w:r>'
        f'<w:r><w:t xml:space="preserve"> jumps.</w:t></w:r>'
        f'</w:p>'
    )
    doc = f'<w:document xmlns:w="{W}" xmlns:r="{R}"><w:body>{body}</w:body></w:document>'
    comments = (
        f'<w:comments xmlns:w="{W}">'
        f'<w:comment w:id="0" w:author="Reviewer"><w:p><w:r><w:t>Reword this bit.</w:t>'
        f'</w:r></w:p></w:comment></w:comments>'
    )
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("word/document.xml", doc)
        zf.writestr("word/comments.xml", comments)
    md, cs = parse(buf.getvalue())

    assert md.startswith("# My Title"), md
    assert "**quick brown fox**" in md, md
    assert len(cs) == 1, cs
    assert cs[0]["selected_text"] == "quick brown fox", cs[0]
    assert cs[0]["instruction"] == "Reword this bit.", cs[0]
    assert cs[0]["author"] == "Reviewer", cs[0]

    # A garbage upload is a clean DocxError, not a raw zip/XML traceback.
    try:
        parse(b"not a docx")
    except DocxError:
        pass
    else:
        raise AssertionError("expected DocxError on non-docx bytes")

    _demo_tables_lists_overlap()
    print("docx_import self-check passed")


def _demo_tables_lists_overlap() -> None:
    """The trickier branches: a bullet list, a two-row table, and two OVERLAPPING comment
    ranges (text between the inner start and outer end belongs to both)."""
    body = (
        f'<w:p><w:pPr><w:numPr/></w:pPr><w:r><w:t>First point</w:t></w:r></w:p>'
        f'<w:tbl>'
        f'<w:tr><w:tc><w:p><w:r><w:t>Plan</w:t></w:r></w:p></w:tc>'
        f'<w:tc><w:p><w:r><w:t>Price</w:t></w:r></w:p></w:tc></w:tr>'
        f'<w:tr><w:tc><w:p><w:r><w:t>Basic</w:t></w:r></w:p></w:tc>'
        f'<w:tc><w:p><w:r><w:t>Free</w:t></w:r></w:p></w:tc></w:tr>'
        f'</w:tbl>'
        f'<w:p>'
        f'<w:commentRangeStart w:id="1"/><w:r><w:t xml:space="preserve">alpha </w:t></w:r>'
        f'<w:commentRangeStart w:id="2"/><w:r><w:t>beta</w:t></w:r>'
        f'<w:commentRangeEnd w:id="1"/><w:r><w:t xml:space="preserve"> gamma</w:t></w:r>'
        f'<w:commentRangeEnd w:id="2"/></w:p>'
    )
    doc = f'<w:document xmlns:w="{W}" xmlns:r="{R}"><w:body>{body}</w:body></w:document>'
    comments = (
        f'<w:comments xmlns:w="{W}">'
        f'<w:comment w:id="1" w:author="A"><w:p><w:r><w:t>note one</w:t></w:r></w:p></w:comment>'
        f'<w:comment w:id="2" w:author="B"><w:p><w:r><w:t>note two</w:t></w:r></w:p></w:comment>'
        f'</w:comments>'
    )
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("word/document.xml", doc)
        zf.writestr("word/comments.xml", comments)
    md, cs = parse(buf.getvalue())

    assert "- First point" in md, md
    assert "| Plan | Price |" in md and "| --- | --- |" in md and "| Basic | Free |" in md, md
    by_author = {c["author"]: c for c in cs}
    # id 1 closes before " gamma": alpha..beta only. id 2 spans beta..gamma.
    assert by_author["A"]["selected_text"] == "alpha beta", by_author["A"]
    assert by_author["B"]["selected_text"] == "beta gamma", by_author["B"]


if __name__ == "__main__":
    _demo()
