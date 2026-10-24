/**
 * Copy as TeX: a selection that touches a rendered formula is copied with
 * each formula as its TeX source instead of KaTeX's glyphs (which the
 * browser would copy twice over, once from the visual half and once from the
 * MathML half). *T3: `apps/web/src/markdown-clipboard.ts`.*
 *
 *  - A selection inside one formula copies that formula's TeX, whole.
 *  - A wider selection copies as markdown (`selectionMarkdown`, the quote
 *    toolbar's writer), so the formulas keep delimiters that paste back as
 *    math. The HTML flavour is the selected markup with each formula as
 *    `<code>` (inline) or `<pre><code>` (display) and the chrome removed.
 *  - A selection with no formula in it is left to the browser.
 */

import type React from "react";

import { selectionMarkdown } from "../quote-selection";
import { MATH_ATTR, MATH_COPY_ATTR } from "./MarkdownMath";

export interface MathClipboardPayload {
  text: string;
  html: string;
}

const MATH_SELECTOR = `[${MATH_ATTR}]`;
/** What the HTML flavour leaves out: controls, icons and what readers skip. */
const CHROME_SELECTOR = 'button, svg, script, style, [aria-hidden="true"], .select-none, [data-quote-skip]';

function sourceElement(document: Document, wrapper: Element): Element {
  const code = document.createElement("code");
  code.textContent = wrapper.getAttribute(MATH_COPY_ATTR)?.trim() ?? "";
  if (wrapper.getAttribute(MATH_ATTR) !== "display") return code;
  const pre = document.createElement("pre");
  pre.append(code);
  return pre;
}

function clipboardHtml(document: Document, container: Element): string {
  for (const wrapper of Array.from(container.querySelectorAll(MATH_SELECTOR))) {
    wrapper.replaceWith(sourceElement(document, wrapper));
  }
  for (const node of Array.from(container.querySelectorAll(CHROME_SELECTOR))) node.remove();
  return `<meta charset="utf-8">${container.innerHTML}`;
}

/** What copying `selection` should put on the clipboard, or `null` to let the browser copy. */
export function mathClipboardPayload(selection: Selection | null): MathClipboardPayload | null {
  if (selection === null || selection.isCollapsed || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  const ancestor = range.commonAncestorContainer;
  const element = ancestor.nodeType === 1 ? (ancestor as HTMLElement) : ancestor.parentElement;
  if (element === null) return null;
  const document = element.ownerDocument;

  // A range inside a formula would clone only some of KaTeX's glyphs.
  const formula = element.closest(MATH_SELECTOR);
  if (formula !== null) {
    const text = formula.getAttribute(MATH_COPY_ATTR)?.trim() ?? "";
    if (text.length === 0) return null;
    return { text, html: `<meta charset="utf-8">${sourceElement(document, formula).outerHTML}` };
  }

  const touched = Array.from(element.querySelectorAll(MATH_SELECTOR)).some((wrapper) => range.intersectsNode(wrapper));
  if (!touched) return null;
  const text = selectionMarkdown(range, element);
  if (text.length === 0) return null;
  const container = document.createElement("div");
  container.append(range.cloneContents());
  return { text, html: clipboardHtml(document, container) };
}

/** The `onCopy` of a message with math: {@link mathClipboardPayload} onto the clipboard. */
export function copyMathSelection(event: React.ClipboardEvent<HTMLElement>): void {
  if (!event.clipboardData) return;
  const payload = mathClipboardPayload(event.currentTarget.ownerDocument.getSelection());
  if (payload === null) return;
  event.preventDefault();
  event.clipboardData.setData("text/plain", payload.text);
  event.clipboardData.setData("text/html", payload.html);
}
