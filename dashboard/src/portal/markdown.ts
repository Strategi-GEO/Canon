/**
 * A small markdown renderer for artifact previews.
 *
 * SECURITY, and the reason this file exists at all: blog.md, eval.md and dossier.md are
 * file content written by an agent and editable by anyone with disk access, so they are
 * untrusted. The ONLY safe order is: escape every HTML metacharacter in the source FIRST,
 * then run markdown transforms over the already escaped text. Escaping first means a
 * payload like <img src=x onerror=alert(1)> has become inert text before any transform
 * runs, and no later step can resurrect it: the transforms only ever ADD tags of our own,
 * they never pass source text through into a tag position. Escaping afterwards would be
 * useless, because it would also escape the tags we just generated, and escaping
 * selectively is how injection bugs get written.
 *
 * The generated HTML is therefore safe to hand to dangerouslySetInnerHTML. The input never
 * is.
 */

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/**
 * Step one, always. Everything downstream assumes it has run.
 *
 * NUL is dropped here as well as escaped: `inline` parks code spans and links behind
 * NUL delimited placeholders, so a NUL arriving from the file could otherwise forge one.
 */
function escapeHtml(input: string): string {
  return input.replace(/\u0000/g, "").replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
}

/**
 * Quotes and angle brackets are already escaped by the time a URL reaches here, so an
 * attribute break is impossible. The remaining risk is the scheme: javascript: and data:
 * both execute from an href on click, so anything that is not a known safe scheme or a
 * relative path is dropped to "#".
 */
function safeUrl(raw: string): string {
  const url = raw.trim();
  if (/^(https?:|mailto:|tel:)/i.test(url)) {
    return url;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) {
    return "#";
  }
  // Relative paths, anchors and query fragments carry no scheme and cannot execute.
  return url;
}

function emphasis(text: string): string {
  return text
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_]+)__/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/(^|[^\w])_([^_\n]+)_/g, "$1<em>$2</em>");
}

const LINK_RE = /(!?)\[([^\]]*)\]\(\s*([^)\s]*)(?:\s+&quot;[^)]*&quot;)?\s*\)/g;
const CODE_RE = /`([^`\n]+)`/g;
/** Not /^\s*>/: block parsing sees escaped text, where a quote marker is already &gt;. */
const BLOCKQUOTE_RE = /^\s*&gt;/;

/**
 * Inline transforms for one already escaped line. Code spans and links are lifted out into
 * placeholders before emphasis runs, so a * inside a URL or a code span stays literal.
 * The placeholders use NUL, which cannot appear in the escaped text and is matched by none
 * of the emphasis patterns.
 */
function inline(escaped: string): string {
  const codes: string[] = [];
  let text = escaped.replace(CODE_RE, (_match, code: string) => {
    codes.push(code);
    return `\u0000C${codes.length - 1}\u0000`;
  });

  const links: string[] = [];
  text = text.replace(LINK_RE, (_match, bang: string, label: string, href: string) => {
    const url = safeUrl(href);
    // An image tag would fetch from a host the file names, and the file is untrusted, so
    // an image reference renders as an ordinary link to the same place instead.
    const shown = label.trim() === "" ? url : emphasis(label);
    const prefix = bang === "!" ? "image: " : "";
    links.push(
      `<a href="${url}" target="_blank" rel="noopener noreferrer nofollow">${prefix}${shown}</a>`,
    );
    return `\u0000L${links.length - 1}\u0000`;
  });

  text = emphasis(text);

  text = text.replace(/\u0000L(\d+)\u0000/g, (_m, i: string) => links[Number(i)]);
  text = text.replace(
    /\u0000C(\d+)\u0000/g,
    (_m, i: string) => `<code class="md-code">${codes[Number(i)]}</code>`,
  );
  return text;
}

function isTableSeparator(line: string): boolean {
  return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);
}

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

/**
 * Renders markdown to an HTML string. `source` is untrusted: it is escaped on the first
 * line of work and never reaches a tag position afterwards.
 */
export function renderMarkdown(source: string): string {
  const lines = escapeHtml(source.replace(/\r\n?/g, "\n")).split("\n");
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === "") {
      i += 1;
      continue;
    }

    // Fenced code. The body is emitted verbatim, which is safe because it is escaped.
    const fence = line.match(/^\s*(```|~~~)(.*)$/);
    if (fence) {
      const marker = fence[1];
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i].trim().startsWith(marker)) {
        body.push(lines[i]);
        i += 1;
      }
      i += 1;
      out.push(`<pre class="md-pre"><code>${body.join("\n")}</code></pre>`);
      continue;
    }

    if (/^\s*(?:[-*_]\s*){3,}$/.test(line)) {
      out.push('<hr class="md-hr" />');
      i += 1;
      continue;
    }

    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      out.push(`<h${level} class="md-h md-h${level}">${inline(heading[2].trim())}</h${level}>`);
      i += 1;
      continue;
    }

    // Escaping runs before block parsing, so a blockquote marker reaches here as &gt;
    // rather than >. Matching the raw character would silently never fire.
    if (BLOCKQUOTE_RE.test(line)) {
      const body: string[] = [];
      while (i < lines.length && BLOCKQUOTE_RE.test(lines[i])) {
        body.push(lines[i].replace(/^\s*&gt;\s?/, ""));
        i += 1;
      }
      out.push(`<blockquote class="md-quote">${inline(body.join(" "))}</blockquote>`);
      continue;
    }

    if (line.includes("|") && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const head = splitRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim() !== "") {
        rows.push(splitRow(lines[i]));
        i += 1;
      }
      const thead = head.map((cell) => `<th>${inline(cell)}</th>`).join("");
      const tbody = rows
        .map((row) => `<tr>${row.map((cell) => `<td>${inline(cell)}</td>`).join("")}</tr>`)
        .join("");
      out.push(
        `<div class="md-table-wrap"><table class="md-table"><thead><tr>${thead}</tr></thead><tbody>${tbody}</tbody></table></div>`,
      );
      continue;
    }

    const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
    const ordered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (bullet || ordered) {
      const tag = bullet ? "ul" : "ol";
      const pattern = bullet ? /^\s*[-*+]\s+(.*)$/ : /^\s*\d+[.)]\s+(.*)$/;
      const items: string[] = [];
      while (i < lines.length) {
        const match = lines[i].match(pattern);
        if (match) {
          items.push(match[1]);
          i += 1;
          continue;
        }
        // A wrapped continuation line joins the item above it rather than starting a
        // stray paragraph mid list.
        if (items.length > 0 && /^\s{2,}\S/.test(lines[i])) {
          items[items.length - 1] += ` ${lines[i].trim()}`;
          i += 1;
          continue;
        }
        break;
      }
      const body = items.map((item) => `<li>${inline(item)}</li>`).join("");
      out.push(`<${tag} class="md-list md-${tag}">${body}</${tag}>`);
      continue;
    }

    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^\s{0,3}#{1,6}\s/.test(lines[i]) &&
      !BLOCKQUOTE_RE.test(lines[i]) &&
      !/^\s*[-*+]\s+/.test(lines[i]) &&
      !/^\s*\d+[.)]\s+/.test(lines[i]) &&
      !/^\s*(```|~~~)/.test(lines[i]) &&
      !/^\s*(?:[-*_]\s*){3,}$/.test(lines[i])
    ) {
      para.push(lines[i].trim());
      i += 1;
    }
    if (para.length > 0) {
      out.push(`<p class="md-p">${inline(para.join(" "))}</p>`);
      continue;
    }
    i += 1;
  }

  return out.join("\n");
}
