import type { RepoIconStoredType } from "@orquester/api";

/**
 * What a repo icon's bytes really are, judged from the bytes alone — never from
 * a declared content type or a file name. Null when they are none of the
 * stored icon types ({@link RepoIconStoredType}).
 *
 * SVG is text, so it has no magic number: it counts when the document (after
 * an optional BOM, XML declaration, comments and doctype) opens with an `<svg`
 * root element and closes it. That is a shape check, not sanitizing — an SVG
 * is only ever shown through `<img>`, where its scripts do not run.
 */
export function sniffRepoIcon(bytes: Uint8Array): RepoIconStoredType | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && bytes.length >= 12 && ascii(bytes, 8, 12) === "WEBP") {
    return "image/webp";
  }
  // ICONDIR: reserved 0, type 1 (icon), then a non-zero image count.
  if (startsWith(bytes, [0x00, 0x00, 0x01, 0x00]) && bytes.length >= 6 && (bytes[4] !== 0 || bytes[5] !== 0)) {
    return "image/x-icon";
  }
  return isSvgDocument(bytes) ? "image/svg+xml" : null;
}

function startsWith(bytes: Uint8Array, magic: number[]): boolean {
  if (bytes.length < magic.length) return false;
  return magic.every((byte, i) => bytes[i] === byte);
}

function ascii(bytes: Uint8Array, from: number, to: number): string {
  return String.fromCharCode(...bytes.subarray(from, to));
}

/**
 * A hand scan rather than regexes: the bytes are untrusted (uploads, favicon responses, `data:`
 * URLs), and every step here is an `indexOf` or a single pass, so the check stays linear.
 */
function isSvgDocument(bytes: Uint8Array): boolean {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return false;
  }
  let at = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  // Prolog: XML declaration, comments, processing instructions, a doctype — any order, any count.
  for (;;) {
    at = skipSpaceForward(text, at);
    let next: number;
    if (text.startsWith("<?", at)) {
      const close = text.indexOf("?>", at + 2);
      next = close === -1 ? -1 : close + 2;
    } else if (text.startsWith("<!--", at)) {
      const close = text.indexOf("-->", at + 4);
      next = close === -1 ? -1 : close + 3;
    } else if (text.slice(at, at + 9).toUpperCase() === "<!DOCTYPE") {
      next = doctypeEnd(text, at + 9);
    } else {
      break;
    }
    if (next === -1) return false;
    at = next;
  }
  if (!/^<svg[\s>/]/i.test(text.slice(at, at + 5))) return false;
  // The document without its trailing whitespace and comments.
  const end = trailingStart(text, at);
  // A self-closing root: the root tag's own `/>` ends it.
  const rootEnd = text.indexOf(">", at);
  if (rootEnd !== -1 && rootEnd + 1 === end && text[rootEnd - 1] === "/") return true;
  // Otherwise a closing `</svg\s*>` ends it.
  if (text[end - 1] !== ">") return false;
  const close = skipSpaceBackward(text, end - 1, at);
  return close - 5 > at && text.slice(close - 5, close).toLowerCase() === "</svg";
}

/** Past `<!DOCTYPE`: the index after its `>` (an internal `[...]` subset may hold `>`), or -1. */
function doctypeEnd(text: string, from: number): number {
  for (let i = from; i < text.length; i += 1) {
    if (text[i] === ">") return i + 1;
    if (text[i] !== "[") continue;
    // The subset closes at the first `]` followed by optional whitespace and `>`.
    for (let close = text.indexOf("]", i + 1); close !== -1; close = text.indexOf("]", close + 1)) {
      const after = skipSpaceForward(text, close + 1);
      if (text[after] === ">") return after + 1;
    }
    return -1;
  }
  return -1;
}

/**
 * Where the trailing run of whitespace and `<!-- ... -->` comments starts (never before `floor`).
 * Walks back one comment at a time; a comment's body never holds `-->`.
 */
function trailingStart(text: string, floor: number): number {
  let end = skipSpaceBackward(text, text.length, floor);
  while (end - floor >= 7 && text.endsWith("-->", end)) {
    const closeAt = end - 3;
    const previousClose = text.lastIndexOf("-->", closeAt - 1);
    // The earliest `<!--` whose body does not reach back over the previous `-->`.
    const open = text.indexOf("<!--", Math.max(floor, previousClose - 3));
    if (open === -1 || open + 4 > closeAt) break;
    end = skipSpaceBackward(text, open, floor);
  }
  return end;
}

/** `\s` as a regex reads it, for one UTF-16 code unit. */
function isSpace(code: number): boolean {
  if (code === 0x20 || (code >= 0x09 && code <= 0x0d)) return true;
  return code > 0x7f && /\s/.test(String.fromCharCode(code));
}

function skipSpaceForward(text: string, from: number): number {
  let i = from;
  while (i < text.length && isSpace(text.charCodeAt(i))) i += 1;
  return i;
}

/** The index after the last non-space character before `end`, not below `floor`. */
function skipSpaceBackward(text: string, end: number, floor: number): number {
  let i = end;
  while (i > floor && isSpace(text.charCodeAt(i - 1))) i -= 1;
  return i;
}
