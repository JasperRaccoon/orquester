// Informed by T3 Code (MIT): apps/web/src/lib/assistantTextSelection.ts (which
// selected text counts, the triple-click boundary) and apps/web/src/lib/selectionActions.ts
// (where the action sits, which rect is still visible).
/**
 * The DOM half of "quote what the agent said" (the timeline's selection
 * toolbar): which selection may be quoted, what markdown it stands for, and
 * where the toolbar goes.
 *
 *  - {@link resolveQuoteSelection} — the selection, if it lies wholly inside
 *    ONE quotable body (an agent message, a proposed plan: the elements
 *    carrying {@link QUOTE_SOURCE_ATTR}), trimmed to the text it really
 *    selects. Anything else — a tool row, a user message, two messages — is
 *    not quotable, and the toolbar stays away.
 *  - {@link selectionMarkdown} — the selected part of the rendered message
 *    written back as markdown: paragraphs, headings, lists, quotes, tables,
 *    inline code, emphasis, links, math (as its TeX in `\(…\)` or `\[…\]`), and
 *    a code block as a fenced block in its language. Rebuilt from the DOM, not mapped to the source: the source
 *    offsets of a rendered fragment are not reliable, the structure is.
 *  - {@link quoteToolbarPosition} — pure: where the toolbar sits for a
 *    selection's rects, clear of the native touch handles.
 */

/** Marks an element whose text may be quoted; its value names the source (a message id). */
export const QUOTE_SOURCE_ATTR = "data-quote-source";

// ---------------------------------------------------------------------------
// Which selection
// ---------------------------------------------------------------------------

/**
 * An element whose text is not part of what the reader selected: chrome the
 * app marks unselectable (`select-none`, nearer than any `select-text`), what
 * assistive tech skips (KaTeX's visual half), or a computed `user-select:
 * none`.
 */
function isUnselectableElement(element: Element): boolean {
  const marked = element.closest(".select-none, .select-text");
  if (marked !== null && marked.classList.contains("select-none")) return true;
  if (element.closest("[aria-hidden='true'], [data-quote-skip]") !== null) return true;
  const view = element.ownerDocument.defaultView;
  if (!view) return false;
  const style = view.getComputedStyle(element);
  return (
    style.userSelect === "none" ||
    (style as CSSStyleDeclaration & { webkitUserSelect?: string }).webkitUserSelect === "none"
  );
}

/**
 * Whether the range selects visible text of this node: some of it, not only
 * whitespace (the layout gaps between blocks select nothing a reader sees),
 * and not unselectable chrome.
 */
function isSelectedText(range: Range, text: Text): boolean {
  const start = text === range.startContainer ? range.startOffset : 0;
  const end = text === range.endContainer ? range.endOffset : text.length;
  if (start >= end || text.data.slice(start, end).trim().length === 0) return false;
  const parent = text.parentElement;
  return parent === null || !isUnselectableElement(parent);
}

/** The first (or last) text node the range really selects under `node`. */
function selectedTextBoundary(range: Range, node: Node, last: boolean): Text | null {
  if (!range.intersectsNode(node)) return null;
  if (node.nodeType === 3) {
    return isSelectedText(range, node as Text) ? (node as Text) : null;
  }
  for (
    let child = last ? node.lastChild : node.firstChild;
    child !== null;
    child = last ? child.previousSibling : child.nextSibling
  ) {
    const boundary = selectedTextBoundary(range, child, last);
    if (boundary !== null) return boundary;
  }
  return null;
}

export interface QuoteSelection {
  /** The quotable body the whole selection lies in. */
  source: HTMLElement;
  /** The selection trimmed to the text it really selects. */
  range: Range;
}

/**
 * The selection as something quotable, or `null`.
 *
 * Trimmed first to the text it really selects: a triple click selects a
 * paragraph up to offset 0 of whatever follows — the next row, often — and a
 * drag can start in a gap between rows. Only the first and last selected
 * characters must then lie in the same quotable body, inside `viewport`.
 */
export function resolveQuoteSelection(
  selection: Selection | null,
  viewport: HTMLElement
): QuoteSelection | null {
  if (selection === null || selection.isCollapsed || selection.rangeCount !== 1) return null;
  const range = selection.getRangeAt(0).cloneRange();
  const first = selectedTextBoundary(range, range.commonAncestorContainer, false);
  const last = selectedTextBoundary(range, range.commonAncestorContainer, true);
  if (first === null || last === null) return null;
  const source = first.parentElement?.closest<HTMLElement>(`[${QUOTE_SOURCE_ATTR}]`) ?? null;
  if (source === null || !viewport.contains(source) || !source.contains(last)) return null;
  // The innermost quotable body of each end must be the same one.
  if (last.parentElement?.closest(`[${QUOTE_SOURCE_ATTR}]`) !== source) return null;
  range.setStart(first, first === range.startContainer ? range.startOffset : 0);
  range.setEnd(last, last === range.endContainer ? range.endOffset : last.length);
  if (range.collapsed || range.toString().trim().length === 0) return null;
  return { source, range };
}

// ---------------------------------------------------------------------------
// What markdown it stands for
// ---------------------------------------------------------------------------

const BLOCK_TAGS = new Set([
  "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "DD", "DETAILS", "DIV", "DL", "DT",
  "FIGCAPTION", "FIGURE", "FOOTER", "H1", "H2", "H3", "H4", "H5", "H6", "HEADER",
  "HR", "LI", "MAIN", "NAV", "OL", "P", "PRE", "SECTION", "SUMMARY", "TABLE",
  "TBODY", "TD", "TFOOT", "TH", "THEAD", "TR", "UL"
]);

const SKIPPED_TAGS = new Set(["SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT", "SVG", "svg", "CANVAS"]);

function isElement(node: Node): node is Element {
  return node.nodeType === 1;
}

/** A rendered formula (`MarkdownMath`), and its TeX in markdown delimiters. */
function mathSourceOf(element: Element): string | null {
  if (!element.hasAttribute("data-markdown-math")) return null;
  return element.getAttribute("data-markdown-copy")?.trim() ?? "";
}

function isBlock(element: Element): boolean {
  if (element.getAttribute("data-markdown-math") === "display") return true;
  return BLOCK_TAGS.has(element.tagName);
}

/** Skipped whole: not text the reader sees as the message (or chrome around it). */
function isSkipped(element: Element): boolean {
  if (SKIPPED_TAGS.has(element.tagName)) return true;
  if (element.getAttribute("aria-hidden") === "true" || element.hasAttribute("data-quote-skip")) return true;
  return element.classList.contains("select-none");
}

/** The part of a text node inside the range. */
function clippedText(range: Range, text: Text): string {
  if (!range.intersectsNode(text)) return "";
  const start = text === range.startContainer ? range.startOffset : 0;
  const end = text === range.endContainer ? range.endOffset : text.length;
  return start < end ? text.data.slice(start, end) : "";
}

/** The longest run of `char` in `text`. */
function longestRun(text: string, char: string): number {
  let longest = 0;
  let current = 0;
  for (const c of text) {
    current = c === char ? current + 1 : 0;
    if (current > longest) longest = current;
  }
  return longest;
}

/** Inline code that survives the backticks inside it. */
function inlineCode(code: string): string {
  const fence = "`".repeat(longestRun(code, "`") + 1);
  const pad = code.startsWith("`") || code.endsWith("`") ? " " : "";
  return `${fence}${pad}${code}${pad}${fence}`;
}

/** A fenced block that survives the backtick fences inside it. */
export function fencedCode(code: string, language: string): string {
  const fence = "`".repeat(Math.max(3, longestRun(code, "`") + 1));
  return `${fence}${language}\n${code}\n${fence}`;
}

/**
 * The selected text of a code block. The chat's code block mounts one
 * `span.block` per line and no newline characters between them, so its lines
 * are read one by one; any other `<pre>` holds its newlines in its text.
 */
function codeText(range: Range, pre: Element): string {
  const code = pre.querySelector("code") ?? pre;
  const lines = Array.from(code.children).filter((child) => child.classList.contains("block"));
  if (lines.length > 0 && lines.length === code.children.length) {
    return lines
      .filter((line) => range.intersectsNode(line))
      .map((line) => textUnder(range, line))
      .join("\n");
  }
  return textUnder(range, code).replace(/\n$/, "");
}

/** The selected text under `node`, as it is: no markdown. */
function textUnder(range: Range, node: Node): string {
  if (node.nodeType === 3) return clippedText(range, node as Text);
  if (!isElement(node) || isSkipped(node) || !range.intersectsNode(node)) return "";
  let out = "";
  for (const child of Array.from(node.childNodes)) out += textUnder(range, child);
  return out;
}

/** The fence language of a code block: the chat's block names it on its wrapper. */
function codeLanguage(pre: Element): string {
  const labelled = pre.closest("[data-language]")?.getAttribute("data-language") ?? "";
  if (labelled.length > 0 && labelled !== "text") return labelled.replace(/[`\s]/g, "");
  const className = pre.querySelector("code")?.className ?? "";
  return /(?:^|\s)language-(\S+)/.exec(className)?.[1] ?? "";
}

/** Collapse an inline run's layout whitespace, as the browser renders it, keeping hard breaks. */
function tidyInline(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " "))
    .join("\n")
    .trim();
}

function wrapEmphasis(inner: string, marker: string): string {
  const trimmed = inner.trim();
  if (trimmed.length === 0) return inner;
  const lead = inner.slice(0, inner.length - inner.trimStart().length);
  const trail = inner.slice(inner.trimEnd().length);
  return `${lead}${marker}${trimmed}${marker}${trail}`;
}

function inlineMarkdown(range: Range, node: Node): string {
  if (node.nodeType === 3) {
    const parent = (node as Text).parentElement;
    if (parent !== null && isUnselectableElement(parent)) return "";
    // Layout newlines in the HTML are spaces to the reader.
    return clippedText(range, node as Text).replace(/\s*\n\s*/g, " ");
  }
  if (!isElement(node) || isSkipped(node) || !range.intersectsNode(node)) return "";
  // Any part of a formula stands for all of its TeX.
  const math = mathSourceOf(node);
  if (math !== null) return math;
  if (isBlock(node)) return blockMarkdown(range, node).join("\n");
  const inner = (): string => {
    let out = "";
    for (const child of Array.from(node.childNodes)) out += inlineMarkdown(range, child);
    return out;
  };
  switch (node.tagName) {
    case "BR":
      return "\n";
    case "CODE":
      return inlineCode(textUnder(range, node));
    case "STRONG":
    case "B":
      return wrapEmphasis(inner(), "**");
    case "EM":
    case "I":
      return wrapEmphasis(inner(), "*");
    case "DEL":
    case "S":
      return wrapEmphasis(inner(), "~~");
    case "A": {
      const text = inner();
      const href = node.getAttribute("href") ?? "";
      if (!/^(?:https?:|mailto:)/i.test(href) || text.trim().length === 0 || text.trim() === href) {
        return text;
      }
      // A paren or a space would end the destination early.
      const destination = href.replace(
        /[()\s]/g,
        (char) => `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`
      );
      return `[${text.trim()}](${destination})`;
    }
    case "IMG":
      return node.getAttribute("alt") ?? "";
    case "INPUT":
      return node.getAttribute("type") === "checkbox"
        ? (node as HTMLInputElement).checked
          ? "[x] "
          : "[ ] "
        : "";
    default:
      return inner();
  }
}

/** Prefix the first line with `marker` and indent the rest under it. */
function hang(text: string, marker: string): string {
  const indent = " ".repeat(marker.length);
  return text
    .split("\n")
    .map((line, index) => (index === 0 ? `${marker}${line}` : line.length > 0 ? `${indent}${line}` : line))
    .join("\n");
}

function listMarkdown(range: Range, list: Element): string {
  const ordered = list.tagName === "OL";
  const start = Number.parseInt(list.getAttribute("start") ?? "1", 10);
  let number = Number.isFinite(start) ? start : 1;
  const items: string[] = [];
  for (const child of Array.from(list.children)) {
    if (child.tagName !== "LI") continue;
    const marker = ordered ? `${number}. ` : "- ";
    number += 1;
    if (!range.intersectsNode(child)) continue;
    const body = blockMarkdown(range, child).join("\n");
    if (body.trim().length === 0) continue;
    items.push(hang(body, marker));
  }
  return items.join("\n");
}

function tableMarkdown(range: Range, table: Element): string {
  const rows: string[] = [];
  let headerRows = 0;
  for (const row of Array.from(table.querySelectorAll("tr"))) {
    if (!range.intersectsNode(row)) continue;
    const cells = Array.from(row.children)
      .filter((cell) => cell.tagName === "TD" || cell.tagName === "TH")
      .map((cell) => tidyInline(inlineChildren(range, cell)).replace(/\n/g, " ").replace(/\|/g, "\\|"));
    if (cells.every((cell) => cell.length === 0)) continue;
    rows.push(`| ${cells.join(" | ")} |`);
    if (row.parentElement?.tagName === "THEAD") headerRows = rows.length;
  }
  if (headerRows === 1 && rows.length > 0) {
    const columns = rows[0]!.split(" | ").length;
    rows.splice(1, 0, `| ${Array.from({ length: columns }, () => "---").join(" | ")} |`);
  }
  return rows.join("\n");
}

function inlineChildren(range: Range, element: Element): string {
  let out = "";
  for (const child of Array.from(element.childNodes)) out += inlineMarkdown(range, child);
  return out;
}

/** The markdown blocks of the selected part of `element`'s children. */
function childBlocks(range: Range, element: Element): string[] {
  const blocks: string[] = [];
  let run = "";
  const flush = (): void => {
    const text = tidyInline(run);
    if (text.length > 0) blocks.push(text);
    run = "";
  };
  for (const child of Array.from(element.childNodes)) {
    if (isElement(child) && isBlock(child) && !isSkipped(child)) {
      flush();
      if (range.intersectsNode(child)) blocks.push(...blockMarkdown(range, child));
    } else {
      run += inlineMarkdown(range, child);
    }
  }
  flush();
  return blocks;
}

/** One block element's selected part as markdown blocks (none when nothing in it is selected). */
function blockMarkdown(range: Range, element: Element): string[] {
  if (isSkipped(element) || !range.intersectsNode(element)) return [];
  const math = mathSourceOf(element);
  if (math !== null) return math.length > 0 ? [math] : [];
  const tag = element.tagName;
  if (tag === "PRE" || (element.hasAttribute("data-language") && element.querySelector("pre"))) {
    const pre = tag === "PRE" ? element : element.querySelector("pre")!;
    const code = codeText(range, pre);
    return code.trim().length > 0 ? [fencedCode(code, codeLanguage(pre))] : [];
  }
  if (/^H[1-6]$/.test(tag)) {
    const text = tidyInline(inlineChildren(range, element)).replace(/\n/g, " ");
    return text.length > 0 ? [`${"#".repeat(Number(tag[1]))} ${text}`] : [];
  }
  if (tag === "UL" || tag === "OL") {
    const list = listMarkdown(range, element);
    return list.length > 0 ? [list] : [];
  }
  if (tag === "BLOCKQUOTE") {
    const inner = childBlocks(range, element).join("\n\n");
    if (inner.trim().length === 0) return [];
    return [inner.split("\n").map((line) => (line.length > 0 ? `> ${line}` : ">")).join("\n")];
  }
  if (tag === "TABLE") {
    const table = tableMarkdown(range, element);
    return table.length > 0 ? [table] : [];
  }
  if (tag === "HR") return ["---"];
  return childBlocks(range, element);
}

/**
 * The selected part of a quotable body, as markdown.
 *
 * A selection wholly inside one code block is code: one line or a part of
 * one as inline code, more as a fenced block in the block's language — so
 * quoting code keeps it code, whichever way it was selected. Anything else is
 * written back block by block from the rendered structure, and falls back to
 * the selection's plain text should that come out empty.
 */
export function selectionMarkdown(range: Range, source: HTMLElement): string {
  const ancestor = range.commonAncestorContainer;
  const ancestorElement = isElement(ancestor) ? ancestor : ancestor.parentElement;
  const pre = ancestorElement?.closest("pre") ?? null;
  if (pre !== null && source.contains(pre)) {
    const code = codeText(range, pre);
    if (code.trim().length === 0) return "";
    return code.includes("\n") ? fencedCode(code, codeLanguage(pre)) : inlineCode(code.trim());
  }
  const blocks = childBlocks(range, source);
  const markdown = blocks.join("\n\n").trim();
  return markdown.length > 0 ? markdown : range.toString().trim();
}

// ---------------------------------------------------------------------------
// Where the toolbar goes
// ---------------------------------------------------------------------------

export interface RectLike {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Whether `rect` keeps any area inside every one of `clips`. */
export function isRectVisible(rect: RectLike, clips: readonly RectLike[]): boolean {
  let { left, top, right, bottom } = rect;
  for (const clip of clips) {
    left = Math.max(left, clip.left);
    top = Math.max(top, clip.top);
    right = Math.min(right, clip.right);
    bottom = Math.min(bottom, clip.bottom);
  }
  return right > left && bottom > top;
}

/** Between the selection and the toolbar. */
const TOOLBAR_GAP_PX = 8;
/**
 * Below a touch selection: room for the native drag handles, which hang under
 * the selection's end — the toolbar must never sit on what the finger needs.
 */
const TOUCH_HANDLE_CLEARANCE_PX = 30;
/** Kept off the window's edges. */
const EDGE_PX = 8;

/**
 * Where the toolbar's top-left corner goes, in viewport pixels.
 *
 * A mouse or a keyboard selection gets it ABOVE the selection's first line,
 * at its start — the reading position, and out of the way of the composer
 * docked at the bottom; below the last line when there is no room above.
 *
 * A touch selection gets it BELOW the last line, past the drag handles: the
 * platform's own callout (Copy, Look Up…) takes the space above the
 * selection on both iOS and Android, so the two never stack. Above the first
 * line, past its handle too, when there is no room below.
 *
 * Always clamped into `bounds` (the timeline's visible area, the composer's
 * overlay excluded) and the window.
 */
export function quoteToolbarPosition(input: {
  first: RectLike;
  last: RectLike;
  toolbar: { width: number; height: number };
  bounds: RectLike;
  window: { width: number; height: number };
  pointer: "mouse" | "touch" | "keyboard";
}): { left: number; top: number; placement: "above" | "below" } {
  const { first, last, toolbar, bounds, pointer } = input;
  const touch = pointer === "touch";
  const top = Math.max(bounds.top, EDGE_PX);
  const bottom = Math.min(bounds.bottom, input.window.height - EDGE_PX);

  const aboveTop = first.top - TOOLBAR_GAP_PX - toolbar.height - (touch ? TOUCH_HANDLE_CLEARANCE_PX : 0);
  const belowTop = last.bottom + (touch ? TOUCH_HANDLE_CLEARANCE_PX : TOOLBAR_GAP_PX);
  const fitsAbove = aboveTop >= top;
  const fitsBelow = belowTop + toolbar.height <= bottom;

  let placement: "above" | "below";
  if (touch) placement = fitsBelow || !fitsAbove ? "below" : "above";
  else placement = fitsAbove || !fitsBelow ? "above" : "below";

  const anchorX = placement === "above" ? first.left : last.right - toolbar.width;
  const minLeft = Math.max(bounds.left, EDGE_PX);
  const maxLeft = Math.min(bounds.right, input.window.width - EDGE_PX) - toolbar.width;
  const left = Math.round(Math.max(minLeft, Math.min(anchorX, maxLeft)));
  const rawTop = placement === "above" ? aboveTop : belowTop;
  const clampedTop = Math.round(Math.max(top, Math.min(rawTop, bottom - toolbar.height)));
  return { left, top: clampedTop, placement };
}
