import { parseForgeLink, type ForgeLink } from "@orquester/api";

/**
 * Forge links inside plain text — a user message's bubble and the composer's
 * draft, neither of which is markdown — plus the one markdown question: is a
 * link's text just its own URL (an autolink), or words the author chose?
 */

/** A run of a plain-text message: text, or a forge link with the exact text it was written as. */
export interface ForgeTextRun {
  text: string;
  link?: ForgeLink;
}

/** `http(s)://` up to whitespace or a character no URL in prose ends inside. */
const URL_PATTERN = /https?:\/\/[^\s<>"'`]+/gi;
/** Sentence punctuation a URL in prose is followed by, not part of it. */
const TRAILING_PUNCTUATION = /[.,;:!?*_~]+$/;

/** Trim what prose put after a URL: punctuation, and closers it does not open. */
export function trimUrlCandidate(candidate: string): string {
  let url = candidate;
  for (;;) {
    const before = url;
    url = url.replace(TRAILING_PUNCTUATION, "");
    for (const [open, close] of [
      ["(", ")"],
      ["[", "]"],
      ["{", "}"]
    ] as const) {
      while (url.endsWith(close) && url.split(open).length < url.split(close).length) {
        url = url.slice(0, -1);
      }
    }
    if (url === before) return url;
  }
}

/** Split plain text into runs, each forge URL its own run. One run when there is none. */
export function splitForgeLinks(text: string): ForgeTextRun[] {
  if (!text.includes("://")) return [{ text }];
  const runs: ForgeTextRun[] = [];
  let cursor = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    const start = match.index ?? 0;
    const url = trimUrlCandidate(match[0]);
    const link = parseForgeLink(url);
    if (!link) continue;
    if (start > cursor) runs.push({ text: text.slice(cursor, start) });
    runs.push({ text: url, link });
    cursor = start + url.length;
  }
  if (runs.length === 0) return [{ text }];
  if (cursor < text.length) runs.push({ text: text.slice(cursor) });
  return runs;
}

/** The composer's chips: each distinct forge link in the draft, in order, at most `limit`. */
export function forgeLinksInText(text: string, limit = 8): ForgeLink[] {
  const seen = new Set<string>();
  const links: ForgeLink[] = [];
  for (const run of splitForgeLinks(text)) {
    if (!run.link || seen.has(run.link.url)) continue;
    seen.add(run.link.url);
    links.push(run.link);
    if (links.length >= limit) break;
  }
  return links;
}

function comparable(url: string): string {
  return url
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "")
    .replace(/\/+$/, "")
    .toLowerCase();
}

/**
 * The link's text is its own URL — a bare or `<…>` autolink, or `[url](url)` —
 * so the pill may replace it with the short label. Anything else is the
 * author's wording, which the pill keeps.
 */
export function isUrlText(text: string, href: string): boolean {
  if (text.trim().length === 0) return false;
  const shown = comparable(text);
  const target = comparable(href);
  if (shown === target) return true;
  try {
    // `URL` percent-encodes what the text may show decoded (spaces, unicode).
    return comparable(decodeURI(href)) === shown;
  } catch {
    return false;
  }
}
