/**
 * File paths in the prompt (spec §7.4 Built note, owner request 2026-09-22).
 *
 * Before agent tabs were chat tabs, a file dropped on an agent terminal was
 * uploaded and its absolute daemon-side path typed into the PTY so the agent
 * could read it (`lib/session-upload.ts`, `injectionForPaths`). The composer
 * does the same for a non-image attachment: the path the upload answers
 * (`AttachmentRef.path`) is inserted at the caret when the upload completes —
 * it is not known before — and leaves with its chip. Images keep `[Image #N]`
 * (`composer-images.ts`). The host independently guarantees delivery with an
 * `Attached files:` block for any path the text does not name.
 */

import { escapeRegExp } from "../../../lib/regexp";

/**
 * Remove ONE occurrence of `path` and the single space beside it, so
 * "see /t/a.xlsx now" reads "see now" and "/t/a.xlsx then" reads "then".
 */
export function removeFilePath(text: string, path: string): string {
  if (path.length === 0 || !text.includes(path)) return text;
  const escaped = escapeRegExp(path);
  return text.replace(
    new RegExp(`^${escaped}\\s?|\\s?${escaped}(?=\\s|$)|${escaped}`),
    ""
  );
}

/** True when the draft already names the path (a returned queued message, a reload). */
export function textNamesPath(text: string, path: string): boolean {
  return path.length > 0 && text.includes(path);
}
