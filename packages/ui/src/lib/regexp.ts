/**
 * Escape a string for literal use inside `new RegExp(...)`. One spelling for
 * the whole package: the composer's path removal, the timeline's skill-mention
 * splitter and the HTML preview's self-link rewrite each carried their own.
 *
 * The output is safe only outside a character class (`-` is deliberately not
 * escaped). The set it escapes is exactly ECMAScript's SyntaxCharacter set,
 * which is what keeps the output legal under the `u` flag (`row-chrome.ts`
 * uses `"gu"`; adding `-` would make it throw "Invalid escape" for a
 * hyphenated skill).
 */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
