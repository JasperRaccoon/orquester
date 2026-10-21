// Informed by T3 Code (MIT): apps/web/src/components/chat/AssistantSelectionToolbar.tsx
// and packages/shared/src/assistantCitations.ts. T3 carries a citation as a link
// in the prompt and expands it into a JSON block for the provider; here a quote
// is the plain markdown a reader expects — a blockquote ahead of the message.
/**
 * Quotes in the composer: passages of the agent's replies the user selected
 * and quoted (the timeline's selection toolbar), held in the draft as their
 * own list beside the text and sent as markdown blockquotes AHEAD of it.
 *
 *  - {@link composeQuotedPrompt} — what a send puts on the wire: each quote as
 *    its own blockquote, then the user's text.
 *  - {@link splitLeadingQuotes} — the other way, for rendering: a user message
 *    that opens with blockquotes shows them as quotes above its own text.
 *  - {@link addComposerQuote} / {@link mergeQuotes} — the draft's list: the
 *    bounds a new quote meets, and a failed send's quotes put back ahead of
 *    any quoted while it was in flight.
 *
 * Pure: the composer and the rows hand these strings and render the result.
 */

import {
  MAX_COMPOSER_QUOTE_CHARS,
  MAX_COMPOSER_QUOTES,
  type ComposerQuote
} from "../../../lib/agent-chat/composer.logic";

export type { ComposerQuote } from "../../../lib/agent-chat/composer.logic";
export { MAX_COMPOSER_QUOTE_CHARS, MAX_COMPOSER_QUOTES } from "../../../lib/agent-chat/composer.logic";

// ---------------------------------------------------------------------------
// The passage itself
// ---------------------------------------------------------------------------

/** A fence opener or closer: up to three spaces, then three or more ` or ~. */
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/**
 * A passage as a quote holds it: line endings unified, blank lines at either
 * end dropped (inner ones and every line's indentation kept: code is
 * indentation), and a code fence the selection opened but never closed closed
 * — an open fence inside a blockquote would swallow everything after it, the
 * user's own text included.
 */
export function normalizeQuoteText(text: string): string {
  const lines = text
    .replace(/\r\n?/g, "\n")
    .replace(/^(?:[ \t]*\n)+/, "")
    .trimEnd()
    .split("\n");
  let open: { char: string; length: number } | null = null;
  for (const line of lines) {
    const match = FENCE.exec(line);
    if (!match) continue;
    const marker = match[1]!;
    const rest = match[2]!;
    if (open === null) {
      // A backtick fence's info string may not hold a backtick (CommonMark).
      if (marker[0] === "`" && rest.includes("`")) continue;
      open = { char: marker[0]!, length: marker.length };
    } else if (marker[0] === open.char && marker.length >= open.length && rest.trim() === "") {
      open = null;
    }
  }
  if (open !== null) lines.push(open.char.repeat(open.length));
  return lines.join("\n");
}

/** Whether a quote is one code block and nothing else: its chip reads as code. */
export function isCodeQuote(text: string): boolean {
  const lines = text.split("\n");
  if (lines.length < 2) return false;
  const first = FENCE.exec(lines[0]!);
  const last = FENCE.exec(lines[lines.length - 1]!);
  if (!first || !last || last[2]!.trim() !== "") return false;
  if (last[1]![0] !== first[1]![0] || last[1]!.length < first[1]!.length) return false;
  // No fence between them closes the first early.
  return !lines.slice(1, -1).some((line) => {
    const inner = FENCE.exec(line);
    return inner !== null && inner[1]![0] === first[1]![0] && inner[1]!.length >= first[1]!.length && inner[2]!.trim() === "";
  });
}

/**
 * A one-line preview of a quote for its chip: fence lines dropped, the leading
 * markers of headings, lists and nested quotes stripped, whitespace collapsed.
 * The chip clamps it to two lines; the cut here only bounds the DOM.
 */
export function quoteExcerpt(text: string, max = 280): string {
  const flat = text
    .split("\n")
    .filter((line) => !FENCE.test(line))
    .map((line) => line.replace(/^\s*(?:>\s?)*(?:#{1,6}\s+|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)?/, ""))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

// ---------------------------------------------------------------------------
// The wire: quotes ahead of the user's text
// ---------------------------------------------------------------------------

/**
 * One passage as a markdown blockquote, quoted line by line: every line gets
 * `> ` (a blank one a bare `>`, so the quote stays one block), which also
 * quotes a code fence and its lines — a fenced block inside a blockquote is
 * ordinary CommonMark — and nests a line that was already a quote.
 */
export function blockquote(text: string): string {
  return normalizeQuoteText(text)
    .split("\n")
    .map((line) => (line.trim().length === 0 ? ">" : `> ${line}`))
    .join("\n");
}

/**
 * The prompt a send carries: each quote as its own blockquote, a blank line
 * between them — which is what keeps two quotes two blocks — then a blank line
 * and the user's text, which is what keeps it out of the last quote (a line
 * right under a blockquote would continue it). With no text the quotes alone
 * are the message; with no quotes the text goes as it is.
 */
export function composeQuotedPrompt(quotes: readonly ComposerQuote[], text: string): string {
  const blocks = quotes
    .map((quote) => normalizeQuoteText(quote.text))
    .filter((quote) => quote.trim().length > 0)
    .map(blockquote);
  if (blocks.length === 0) return text;
  const body = text.trim();
  return body.length === 0 ? blocks.join("\n\n") : `${blocks.join("\n\n")}\n\n${body}`;
}

/** A quote line: up to three spaces of indentation, then `>`. */
const QUOTE_LINE = /^ {0,3}>/;

/**
 * A user message split into the blockquotes it opens with and the rest — how
 * the bubble shows a quoted send: the quotes as quotes, the user's own words
 * under them. Each run of `>` lines is one quote with one level of `>` taken
 * off; a run must end at a blank line or the end of the message, because a
 * line right under one continues it in markdown and is not the user's text.
 * A message that does not open that way is all body.
 */
export function splitLeadingQuotes(text: string): { quotes: string[]; body: string } {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const quotes: string[] = [];
  let index = 0;
  while (index < lines.length && lines[index]!.trim() === "") index += 1;
  let bodyStart = index;
  while (index < lines.length && QUOTE_LINE.test(lines[index]!)) {
    const block: string[] = [];
    while (index < lines.length && QUOTE_LINE.test(lines[index]!)) {
      block.push(lines[index]!.replace(/^ {0,3}> ?/, ""));
      index += 1;
    }
    // A line continues the run: not a quote this split can take apart.
    if (index < lines.length && lines[index]!.trim() !== "") return { quotes: [], body: text };
    const quote = normalizeQuoteText(block.join("\n"));
    if (quote.length > 0) quotes.push(quote);
    while (index < lines.length && lines[index]!.trim() === "") index += 1;
    bodyStart = index;
  }
  if (quotes.length === 0) return { quotes: [], body: text };
  return { quotes, body: lines.slice(bodyStart).join("\n") };
}

/**
 * A message coming back into a draft — a queued one returned, a rewound one,
 * a send a reload could not finish — with the blockquotes it opens with taken
 * back out as quotes, so it returns as it was composed: quotes above, the
 * user's words in the text. A quote too long to hold leaves the message as
 * it is, in the text, where nothing of it is lost.
 */
export function quotesFromText(text: string): { text: string; quotes: ComposerQuote[] } {
  const split = splitLeadingQuotes(text);
  if (split.quotes.length === 0 || split.quotes.some((quote) => quote.length > MAX_COMPOSER_QUOTE_CHARS)) {
    return { text, quotes: [] };
  }
  return { text: split.body, quotes: split.quotes.map((quote) => ({ id: newQuoteId(), text: quote })) };
}

// ---------------------------------------------------------------------------
// The draft's list
// ---------------------------------------------------------------------------

let quoteSequence = 0;

/** A fresh quote id; unique within the page, which is all a draft's list needs. */
export function newQuoteId(): string {
  quoteSequence += 1;
  const random = Math.random().toString(36).slice(2, 8);
  return `quote-${Date.now().toString(36)}-${quoteSequence.toString(36)}-${random}`;
}

/** Why a passage cannot be quoted, or `null` when it can. */
export function quoteRefusal(input: { text: string; existing: number }): string | null {
  if (input.text.trim().length === 0) return "Nothing to quote.";
  if (input.text.length > MAX_COMPOSER_QUOTE_CHARS) return "The selection is too long to quote.";
  if (input.existing >= MAX_COMPOSER_QUOTES) {
    return `A message holds up to ${MAX_COMPOSER_QUOTES} quotes.`;
  }
  return null;
}

export type AddQuoteResult =
  | { ok: true; quotes: ComposerQuote[]; quote: ComposerQuote }
  | { ok: false; reason: string };

/** A passage added at the end of the draft's quotes, or why it cannot be. */
export function addComposerQuote(
  quotes: readonly ComposerQuote[],
  text: string,
  id: string = newQuoteId()
): AddQuoteResult {
  const normalized = normalizeQuoteText(text);
  const reason = quoteRefusal({ text: normalized, existing: quotes.length });
  if (reason !== null) return { ok: false, reason };
  const quote = { id, text: normalized };
  return { ok: true, quotes: [...quotes, quote], quote };
}

/**
 * Two lists of quotes as one: `front`'s first — a failed send's quotes, put
 * back ahead of any quoted while it was in flight, as its text and chips are
 * (`draftAfterSend`) — then `back`'s that `front` does not already hold.
 */
export function mergeQuotes(
  front: readonly ComposerQuote[],
  back: readonly ComposerQuote[]
): ComposerQuote[] {
  const ids = new Set(front.map((quote) => quote.id));
  return [...front, ...back.filter((quote) => !ids.has(quote.id))];
}

/** Value equality for two lists of quotes, in order. */
export function quotesEqual(
  a: readonly ComposerQuote[] | undefined,
  b: readonly ComposerQuote[] | undefined
): boolean {
  const left = a ?? [];
  const right = b ?? [];
  return (
    left.length === right.length &&
    left.every((quote, index) => quote.id === right[index]!.id && quote.text === right[index]!.text)
  );
}
