/**
 * Finding a comment's passage inside a rendered article, and marking it.
 *
 * The record stores a comment's passage as the RENDERED text somebody selected, not as a
 * source offset, because offsets rot the moment a sentence above them is edited. Re-finding
 * that text in the DOM is therefore the whole job here, and three properties of the rendered
 * article make a plain indexOf on one text node fail:
 *
 *  1. WHITESPACE. The renderer joins hard-wrapped source lines with a single space
 *     (markdown.ts, `para.join(" ")`), while a browser selection that crosses a paragraph
 *     hands back a newline, so the same passage exists in two spellings. Both sides are
 *     normalized to single spaces before they meet.
 *  2. NODE SPLITS. A passage carrying a link or a bold run is one string in the record and
 *     three text nodes in the DOM, so the search runs over a FLAT index of the container's
 *     whole text and maps positions back to (node, offset) afterwards.
 *  3. BLOCK BOUNDARIES. Concatenating text nodes alone would run "...ends here" straight
 *     into "Next heading" with no separator, so a selection spanning two blocks could never
 *     match. Entering a block element emits the same single space the selection carries.
 *
 * Nothing here reaches outside `container`, and nothing runs during SSR: the caller only has
 * an HTMLElement inside an effect anyway, and the SSR guard makes a mistaken call inert
 * rather than a crash on the server.
 *
 * ONE CONSTRAINT ON THE CALLER: the article must be content React does not update node by
 * node, which in this app means the markdown view's dangerouslySetInnerHTML. React treats
 * that subtree as opaque and only ever replaces it wholesale, so wrapping runs inside it is
 * safe. Wrapping inside React-managed elements would leave React holding stale child
 * references.
 */

/** The one attribute that matters. It survives a consumer passing its own class, so it, and
 *  never a class, is what the stylesheet paints, what unwrapping looks for, and what the
 *  rail's hover linkage reads back. renderMarkdown emits no <mark> of its own and escapes
 *  every metacharacter in the file, so every element this selector finds is one of ours. */
const MARK_SELECTOR = "mark[data-comment-id]";

/** Tags that do NOT start a new run of text. Everything else the renderer emits (p, h1 to
 *  h6, li, blockquote, pre, table cells, hr) is a block, and crossing into one reads as a
 *  space. BR is inline and still a break, so it counts as a boundary too. */
const INLINE_TAGS = new Set(["A", "EM", "STRONG", "CODE", "SPAN", "MARK", "SUP", "SUB", "B", "I", "U", "S", "SMALL"]);

export type Anchor = {
  id: string;
  /** Pixels from the container's top to the top of the comment's first mark. */
  top: number;
  /** False when the passage is no longer in the article, which happens the moment an edit
   *  rewrites it. Such a comment keeps its card and loses its highlight: dropping it would
   *  hide a request nobody has answered. */
  found: boolean;
};

/** The minimum a comment has to carry to be anchored. Both consumers hold richer rows; the
 *  field name is the record's, so neither has to rename anything on the way in. */
export type AnchorTarget = { id: string; selected_text: string };

export type HighlightOptions = {
  /** Extra classes on every mark. The paint does not depend on it (see MARK_SELECTOR). */
  markClass?: string;
  /** Marked active at wrap time, so a re-highlight does not drop the active passage for a
   *  frame. Hover changes go through setActiveMark instead: re-wrapping the whole article
   *  on every pointer move is the wrong cost for a one-attribute change. */
  activeId?: string | null;
};

type Point = { node: Text; offset: number };

/** The container's text, whitespace normalized, plus where each character came from.
 *  Positions are null for the spaces normalization invented, which is harmless: a trimmed
 *  needle starts and ends on a real character, and those are the only two positions that
 *  ever have to map back. */
type FlatIndex = { text: string; points: (Point | null)[] };

function isBoundary(element: Element): boolean {
  return element.tagName === "BR" || !INLINE_TAGS.has(element.tagName);
}

function buildIndex(container: HTMLElement): FlatIndex {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  let text = "";
  const points: (Point | null)[] = [];
  // Whitespace, or a block we just walked into, waiting to become at most one space. It
  // stays pending until a real character arrives, which is what drops the trailing run.
  let pending = false;

  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (node.nodeType === Node.ELEMENT_NODE) {
      if (isBoundary(node as Element)) {
        pending = true;
      }
      continue;
    }
    const chunk = node as Text;
    const data = chunk.data;
    for (let offset = 0; offset < data.length; offset += 1) {
      const character = data[offset];
      if (/\s/.test(character)) {
        pending = true;
        continue;
      }
      // The leading run is dropped rather than turned into a space, so an article whose
      // markup starts with a newline does not shift every position by one.
      if (pending && text.length > 0) {
        text += " ";
        points.push(null);
      }
      pending = false;
      text += character;
      points.push({ node: chunk, offset });
    }
  }

  return { text, points };
}

/** The same normalization the index applies, run over what the record stored. */
function normalize(passage: string): string {
  return passage.replace(/\s+/g, " ").trim();
}

/** Every text node from `first` to `last` inclusive, collected BEFORE any splitting: a
 *  TreeWalker being iterated while the nodes under it are split is how a highlight ends up
 *  half applied. Splitting only ever adds siblings, so the nodes in this list stay valid. */
function nodesBetween(container: HTMLElement, first: Text, last: Text): Text[] {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const out: Text[] = [];
  let inside = false;
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (node === first) {
      inside = true;
    }
    if (inside) {
      out.push(node as Text);
    }
    if (node === last) {
      break;
    }
  }
  return out;
}

/**
 * Wraps one run in marks and returns the first one, or null when nothing was wrapped.
 *
 * A run spanning several text nodes becomes one mark PER NODE rather than one mark around
 * everything: a single element cannot enclose a range that starts inside one paragraph and
 * ends inside the next without restructuring the article. Per node wrapping also gives
 * overlapping comments their nesting for free, because a node already inside another
 * comment's mark simply gains a second mark inside it.
 */
function wrapRun(
  container: HTMLElement,
  id: string,
  start: Point,
  end: Point,
  markClass: string | undefined,
  active: boolean,
): HTMLElement | null {
  let first: HTMLElement | null = null;
  for (const node of nodesBetween(container, start.node, end.node)) {
    const from = node === start.node ? start.offset : 0;
    const to = node === end.node ? end.offset : node.data.length;
    if (to <= from) {
      continue;
    }
    // The renderer joins its blocks with newlines, so the container holds whitespace-only
    // text nodes between them. Marking one paints a highlighted gap between paragraphs.
    if (node.data.slice(from, to).trim() === "") {
      continue;
    }
    // Tail first, then head: splitting the head would move the tail offset.
    let run = node;
    if (to < run.data.length) {
      run.splitText(to);
    }
    if (from > 0) {
      run = run.splitText(from);
    }
    const parent = run.parentNode;
    if (parent === null) {
      continue;
    }
    const mark = document.createElement("mark");
    mark.setAttribute("data-comment-id", id);
    if (markClass !== undefined && markClass !== "") {
      mark.className = markClass;
    }
    if (active) {
      mark.setAttribute("data-active", "");
    }
    parent.insertBefore(mark, run);
    mark.appendChild(run);
    if (first === null) {
      first = mark;
    }
  }
  return first;
}

/**
 * Removes every mark this module created and puts the text back as it was.
 *
 * Idempotent re-runs depend on this: highlightComments calls it first, so calling it twice
 * on the same article is not calling it twice on the same text. querySelectorAll returns
 * nested marks in document order, and unwrapping an outer mark leaves the inner one in the
 * tree, so the later entries are still live when their turn comes. normalize() re-merges the
 * text nodes splitting produced, which is what stops an article from fragmenting a little
 * more on every pass.
 */
export function clearHighlights(container: HTMLElement): void {
  if (typeof document === "undefined") {
    return;
  }
  const marks = Array.from(container.querySelectorAll(MARK_SELECTOR));
  for (const mark of marks) {
    const parent = mark.parentNode;
    if (parent === null) {
      continue;
    }
    while (mark.firstChild !== null) {
      parent.insertBefore(mark.firstChild, mark);
    }
    parent.removeChild(mark);
  }
  if (marks.length > 0) {
    container.normalize();
  }
}

/**
 * Where each comment's highlight sits, WITHOUT touching the DOM.
 *
 * The rail re-measures on every article resize, and a resize handler that mutated the thing
 * it is observing is a loop. This reads rects and nothing else, so it is safe to call from a
 * ResizeObserver.
 */
export function measureAnchors(container: HTMLElement, ids: string[]): Anchor[] {
  if (typeof document === "undefined") {
    return ids.map((id) => ({ id, top: 0, found: false }));
  }
  // Document order, so the first mark wins for a comment that wrapped several nodes: the
  // card lines up with where the passage STARTS, which is where the eye goes.
  const firstMarks = new Map<string, Element>();
  for (const mark of Array.from(container.querySelectorAll(MARK_SELECTOR))) {
    const id = mark.getAttribute("data-comment-id");
    if (id !== null && !firstMarks.has(id)) {
      firstMarks.set(id, mark);
    }
  }
  const base = container.getBoundingClientRect().top - container.scrollTop;
  return ids.map((id) => {
    const mark = firstMarks.get(id);
    if (mark === undefined) {
      return { id, top: 0, found: false };
    }
    return { id, top: mark.getBoundingClientRect().top - base, found: true };
  });
}

/**
 * Marks every comment's passage in `container` and reports where each one landed.
 *
 * Order of work, and each step is load-bearing:
 *  - unwrap first, so a re-run after a re-render measures clean text rather than text that
 *    already carries last run's marks;
 *  - rebuild the flat index BEFORE each comment, because the comment before it split the
 *    text nodes this one's positions would otherwise point into. The normalized TEXT is
 *    identical across those rebuilds (splitting changes no characters, and a mark is inline
 *    so it emits no boundary space), which is what lets the repeat handling below carry an
 *    offset from one pass into the next;
 *  - measure all the tops at the end, in one pass, so the numbers all describe the same
 *    layout instead of the layout as it was midway through being marked.
 */
export function highlightComments(
  container: HTMLElement,
  comments: AnchorTarget[],
  opts?: HighlightOptions,
): Anchor[] {
  if (typeof document === "undefined") {
    // Never during SSR. Reporting every comment unanchored keeps the shape a caller expects.
    return comments.map((comment) => ({ id: comment.id, top: 0, found: false }));
  }

  clearHighlights(container);

  const activeId = opts?.activeId ?? null;
  // Where to resume searching for a passage that has already been claimed. Two comments on
  // the same repeated sentence take the first and the second occurrence rather than stacking
  // two identical marks on one of them, which would leave their cards indistinguishable.
  const claimed = new Map<string, number>();
  const marked = new Set<string>();

  for (const comment of comments) {
    const needle = normalize(comment.selected_text);
    if (needle === "") {
      continue;
    }
    const index = buildIndex(container);
    const from = claimed.get(needle) ?? 0;
    let at = index.text.indexOf(needle, from);
    if (at < 0 && from > 0) {
      // Fewer occurrences than comments. Two cards sharing one highlight beats a comment
      // reported as lost when its passage is plainly still there.
      at = index.text.indexOf(needle, 0);
    }
    if (at < 0) {
      continue;
    }
    claimed.set(needle, at + 1);

    const start = index.points[at];
    const end = index.points[at + needle.length - 1];
    if (start === null || start === undefined || end === null || end === undefined) {
      continue;
    }
    const mark = wrapRun(
      container,
      comment.id,
      start,
      // The end position is exclusive, and the last character came out of this node, so
      // offset + 1 is always inside it.
      { node: end.node, offset: end.offset + 1 },
      opts?.markClass,
      comment.id === activeId,
    );
    if (mark !== null) {
      marked.add(comment.id);
    }
  }

  const measured = measureAnchors(
    container,
    comments.map((comment) => comment.id),
  );
  // measureAnchors reports what it can see, and a comment that never matched has no mark to
  // see, so the two agree already. The intersection is asserted anyway: a comment that was
  // marked but cannot be measured is a bug worth surfacing as unanchored rather than as a
  // card pinned to the top of the rail.
  return measured.map((anchor) => ({
    ...anchor,
    found: anchor.found && marked.has(anchor.id),
  }));
}

/**
 * Moves the active flag between marks. The rail calls this on every hover, so it stays a
 * pair of attribute writes and never a re-wrap.
 */
export function setActiveMark(container: HTMLElement, id: string | null): void {
  if (typeof document === "undefined") {
    return;
  }
  for (const mark of Array.from(container.querySelectorAll(MARK_SELECTOR))) {
    if (id !== null && mark.getAttribute("data-comment-id") === id) {
      mark.setAttribute("data-active", "");
    } else {
      mark.removeAttribute("data-active");
    }
  }
}

/**
 * The comment id under a pointer or a focus, or null. Keeps the attribute name private to
 * this module: the rail delegates one listener on the article rather than binding to marks
 * that get thrown away and rebuilt on every pass.
 */
export function commentIdAt(target: EventTarget | null): string | null {
  if (target === null || !(target instanceof Element)) {
    return null;
  }
  const mark = target.closest(MARK_SELECTOR);
  return mark === null ? null : mark.getAttribute("data-comment-id");
}
