"""Bundle a brand's blogs into ONE Word .docx, a cover page before each.

Stdlib only: a .docx is a zip of XML, so building one is writing four small XML parts into a zip
with zipfile + string templates. No python-docx, no pandoc, no build step Vercel does not have.
`build_docx` takes (title, markdown) pairs and returns the .docx bytes; the caller streams them as
an attachment.

LAYOUT the operator asked for: for blog N, a near-blank page carrying "Blog N" in large letters
(with the article's own title beneath it), then a page break, then the article on the next page,
then the next blog's cover on a fresh page. No trailing blank page: each cover after the first
starts itself with a page break rather than the previous blog ending with one.

MARKDOWN understood: ATX headings (#..######), paragraphs, **bold**, *italic*, [text](url)
hyperlinks, bullet and numbered lists, and pipe tables. That is the shape this engine's writer
emits. Formatting is DIRECT (bold + point size on the runs), not named Word styles, so there is
no styles.xml to ship and Word never has to resolve a style it was not given.

ponytail: headings are direct-formatted, so they are large and bold but do NOT populate Word's
navigation pane or a table of contents; add a styles.xml with Heading1..6 if a TOC is ever wanted.
Tables are simple (no merged cells), and a literal '|' inside a cell is not un-escaped. The whole
module is validated by _demo, which builds a document and checks its OOXML parses and is complete.
"""
from __future__ import annotations

import io
import re
import zipfile

W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"

# Point sizes are HALF-points (Word's w:sz unit): 22 = 11pt body, 96 = 48pt cover title.
_BODY_SZ = 22
_HEADING_SZ = {1: 36, 2: 30, 3: 26, 4: 24, 5: 24, 6: 24}
_COVER_SZ = 96
_COVER_SUBTITLE_SZ = 36
_LINK_COLOR = "0563C1"

_HEADING_RE = re.compile(r"^(#{1,6})\s+(.*)$")
_BULLET_RE = re.compile(r"^[-*+]\s+(.*)$")
_ORDERED_RE = re.compile(r"^(\d+)\.\s+(.*)$")
_LINK_RE = re.compile(r"\[([^\]]+)\]\(([^)\s]+)\)")
_BOLD_RE = re.compile(r"\*\*(.+?)\*\*")
_ITALIC_RE = re.compile(r"(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)")


def _esc(text: str) -> str:
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _esc_attr(text: str) -> str:
    return _esc(text).replace('"', "&quot;")


class _Doc:
    """Accumulates hyperlink relationships as blocks are built, so each link gets a stable r:id
    that document.xml.rels can resolve. Ids start at 100 to sit clear of the package rels."""

    def __init__(self) -> None:
        self.rels: list[tuple[str, str]] = []

    def hyperlink(self, url: str) -> str:
        rid = f"rId{100 + len(self.rels)}"
        self.rels.append((rid, url))
        return rid


def _run(text: str, *, bold: bool = False, italic: bool = False, sz: int = _BODY_SZ,
         underline: bool = False, color: str | None = None) -> str:
    rpr = ['<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/>']
    if bold:
        rpr.append("<w:b/>")
    if italic:
        rpr.append("<w:i/>")
    if color:
        rpr.append(f'<w:color w:val="{color}"/>')
    if underline:
        rpr.append('<w:u w:val="single"/>')
    rpr.append(f'<w:sz w:val="{sz}"/><w:szCs w:val="{sz}"/>')
    return (f'<w:r><w:rPr>{"".join(rpr)}</w:rPr>'
            f'<w:t xml:space="preserve">{_esc(text)}</w:t></w:r>')


def _para(inner: str, *, align: str | None = None, before: int | None = None,
          after: int | None = None, page_break_before: bool = False,
          indent: int | None = None) -> str:
    ppr: list[str] = []
    if page_break_before:
        ppr.append("<w:pageBreakBefore/>")
    if align:
        ppr.append(f'<w:jc w:val="{align}"/>')
    if indent:
        ppr.append(f'<w:ind w:left="{indent}"/>')
    spacing = []
    if before is not None:
        spacing.append(f'w:before="{before}"')
    if after is not None:
        spacing.append(f'w:after="{after}"')
    if spacing:
        ppr.append(f'<w:spacing {" ".join(spacing)}/>')
    ppr_xml = f"<w:pPr>{''.join(ppr)}</w:pPr>" if ppr else ""
    return f"<w:p>{ppr_xml}{inner}</w:p>"


def _inline(text: str, doc: _Doc, *, sz: int = _BODY_SZ) -> str:
    """One line of markdown to runs: **bold**, *italic*, [text](url), plain, in document order.
    Earliest match of the three markers wins; a link's label is taken as plain text."""
    out: list[str] = []
    pos = 0
    while pos < len(text):
        candidates = [m for m in (_LINK_RE.search(text, pos),
                                   _BOLD_RE.search(text, pos),
                                   _ITALIC_RE.search(text, pos)) if m]
        if not candidates:
            out.append(_run(text[pos:], sz=sz))
            break
        match = min(candidates, key=lambda m: m.start())
        if match.start() > pos:
            out.append(_run(text[pos:match.start()], sz=sz))
        if match.re is _LINK_RE:
            rid = doc.hyperlink(match.group(2))
            link_run = _run(match.group(1), sz=sz, underline=True, color=_LINK_COLOR)
            out.append(f'<w:hyperlink r:id="{rid}">{link_run}</w:hyperlink>')
        elif match.re is _BOLD_RE:
            out.append(_run(match.group(1), bold=True, sz=sz))
        else:
            out.append(_run(match.group(1), italic=True, sz=sz))
        pos = match.end()
    return "".join(out)


def _is_separator_row(line: str) -> bool:
    stripped = line.strip()
    return bool(stripped) and set(stripped) <= set("-:| ") and "-" in stripped


def _cells_are_separator(cells: list[str]) -> bool:
    return all(re.fullmatch(r":?-{1,}:?", c.strip()) for c in cells if c.strip())


def _split_row(line: str) -> list[str]:
    inner = line.strip()
    if inner.startswith("|"):
        inner = inner[1:]
    if inner.endswith("|"):
        inner = inner[:-1]
    return [c.strip() for c in inner.split("|")]


_BORDER = ('<w:top w:val="single" w:sz="4" w:space="0" w:color="auto"/>'
           '<w:left w:val="single" w:sz="4" w:space="0" w:color="auto"/>'
           '<w:bottom w:val="single" w:sz="4" w:space="0" w:color="auto"/>'
           '<w:right w:val="single" w:sz="4" w:space="0" w:color="auto"/>'
           '<w:insideH w:val="single" w:sz="4" w:space="0" w:color="auto"/>'
           '<w:insideV w:val="single" w:sz="4" w:space="0" w:color="auto"/>')


def _table(lines: list[str], doc: _Doc) -> str:
    rows = [_split_row(ln) for ln in lines if ln.strip().startswith("|")]
    if not rows:
        return ""
    header = rows[0]
    body_rows = rows[2:] if len(rows) >= 2 and _cells_are_separator(rows[1]) else rows[1:]
    width = max(len(r) for r in rows)

    def cell(text: str, header_cell: bool) -> str:
        inner = _run(text, bold=True) if header_cell else _inline(text, doc)
        para = _para(inner)  # a table cell must hold at least one paragraph, empty text included
        return f'<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/></w:tcPr>{para}</w:tc>'

    def row(cells: list[str], header_row: bool) -> str:
        cells = cells + [""] * (width - len(cells))
        return "<w:tr>" + "".join(cell(c, header_row) for c in cells) + "</w:tr>"

    grid = "<w:tblGrid>" + "<w:gridCol/>" * width + "</w:tblGrid>"
    trs = row(header, True) + "".join(row(r, False) for r in body_rows)
    return (f'<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/>'
            f'<w:tblBorders>{_BORDER}</w:tblBorders></w:tblPr>{grid}{trs}</w:tbl>')


def _markdown_blocks(markdown: str, doc: _Doc) -> list[str]:
    lines = markdown.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    blocks: list[str] = []
    i, n = 0, len(lines)
    while i < n:
        stripped = lines[i].strip()
        if not stripped:
            i += 1
            continue

        heading = _HEADING_RE.match(stripped)
        if heading:
            level = len(heading.group(1))
            blocks.append(_para(
                _run(heading.group(2).strip(), bold=True, sz=_HEADING_SZ[level]),
                before=240 if level <= 2 else 160, after=80))
            i += 1
            continue

        if stripped.startswith("|") and i + 1 < n and _is_separator_row(lines[i + 1]):
            table_lines = []
            while i < n and lines[i].strip().startswith("|"):
                table_lines.append(lines[i])
                i += 1
            blocks.append(_table(table_lines, doc))
            continue

        bullet = _BULLET_RE.match(stripped)
        if bullet:
            blocks.append(_para(_run("•  ") + _inline(bullet.group(1), doc), indent=360))
            i += 1
            continue

        ordered = _ORDERED_RE.match(stripped)
        if ordered:
            blocks.append(_para(_run(f"{ordered.group(1)}.  ") + _inline(ordered.group(2), doc),
                                indent=360))
            i += 1
            continue

        blocks.append(_para(_inline(stripped, doc)))
        i += 1
    return blocks


def _cover(number: int, title: str, doc: _Doc, *, page_break_before: bool) -> str:
    parts = [_para(_run(f"Blog {number}", bold=True, sz=_COVER_SZ),
                   align="center", before=2400, page_break_before=page_break_before)]
    if title and title.strip():
        parts.append(_para(_inline(title.strip(), doc, sz=_COVER_SUBTITLE_SZ),
                           align="center", before=240))
    # End the cover page so the article begins on the next one.
    parts.append(_para('<w:r><w:br w:type="page"/></w:r>'))
    return "".join(parts)


_SECTPR = ('<w:sectPr><w:pgSz w:w="12240" w:h="15840"/>'
           '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" '
           'w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>')

_CONTENT_TYPES = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    '<Default Extension="xml" ContentType="application/xml"/>'
    '<Override PartName="/word/document.xml" '
    'ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    '</Types>')

_ROOT_RELS = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    '<Relationship Id="rId1" '
    'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" '
    'Target="word/document.xml"/></Relationships>')

CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"


def _document_rels(rels: list[tuple[str, str]]) -> str:
    items = "".join(
        f'<Relationship Id="{rid}" '
        f'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" '
        f'Target="{_esc_attr(url)}" TargetMode="External"/>'
        for rid, url in rels)
    return ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            f'{items}</Relationships>')


def build_docx(blogs: list[tuple[str, str]]) -> bytes:
    """(title, markdown) pairs -> one .docx: a cover page per blog, then its article."""
    doc = _Doc()
    body: list[str] = []
    for index, (title, markdown) in enumerate(blogs):
        body.append(_cover(index + 1, title or "", doc, page_break_before=index > 0))
        body.extend(_markdown_blocks(markdown or "", doc))

    document_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        f'<w:document xmlns:w="{W}" xmlns:r="{R}"><w:body>'
        f'{"".join(body)}{_SECTPR}</w:body></w:document>')

    parts = {
        "[Content_Types].xml": _CONTENT_TYPES,
        "_rels/.rels": _ROOT_RELS,
        "word/document.xml": document_xml,
        "word/_rels/document.xml.rels": _document_rels(doc.rels),
    }
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, content in parts.items():
            zf.writestr(name, content)
    return buffer.getvalue()


def _demo() -> None:
    """Build a two-blog document and validate the bytes with stdlib alone: the parts a .docx must
    carry are present, word/document.xml parses as well-formed XML, and the cover and article text
    are in it. A converter that emits a file Word cannot open is the failure mode that matters, and
    an unescaped '&' or '<' would make the XML parse below raise, so parsing IS the corruption test.
    """
    from xml.etree import ElementTree as ET

    md1 = (
        "# Where to Get Ramen\n\n"
        "The **best** bowl in town is at [Noodle Bar](https://example.com/noodle).\n\n"
        "## Top picks\n\n"
        "- Tonkotsu, rich and *slow-cooked*\n"
        "- Shoyu, clean and light\n\n"
        "| Shop | Price |\n| --- | --- |\n| Noodle Bar | 12 |\n| Broth House | 14 |\n")
    md2 = "# Second Article\n\nA short *second* body with a [link](https://example.com/two).\n"

    data = build_docx([("Where to Get Ramen", md1), ("Second Article", md2)])

    zf = zipfile.ZipFile(io.BytesIO(data))
    for required in ("[Content_Types].xml", "_rels/.rels", "word/document.xml",
                     "word/_rels/document.xml.rels"):
        assert required in zf.namelist(), f"missing part {required}"

    doc = zf.read("word/document.xml").decode("utf-8")
    ET.fromstring(doc)  # well-formed, or Word cannot open it; this is the whole "is it corrupt" test
    # The covers and both articles' own text reached the document body.
    for needle in ("Blog 1", "Blog 2", "Where to Get Ramen", "Second Article",
                   "Noodle Bar", "Tonkotsu", "Shoyu"):
        assert needle in doc, needle

    # A blog with an ampersand and angle brackets must escape cleanly: if it did not, the parse
    # below raises rather than returning, and the escaped forms are in the raw XML.
    tricky = build_docx([("Cars & <Trucks>", "Sales rose 5 % on A&B <b> tags in Q1.\n")])
    tdoc = zipfile.ZipFile(io.BytesIO(tricky)).read("word/document.xml").decode("utf-8")
    ET.fromstring(tdoc)
    assert "Cars &amp; &lt;Trucks&gt;" in tdoc, tdoc
    assert "A&amp;B &lt;b&gt; tags" in tdoc, tdoc

    print("docx_export self-check passed")


if __name__ == "__main__":
    _demo()
