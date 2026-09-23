/**
 * The path line a non-native attachment rides into the prompt (§4.1, §4.5).
 *
 * T3 rewrites every attachment into an on-disk path inside the prompt text
 * before the adapter sees the turn (`t3-1-providers.md:282-292`, "a path in
 * the prompt does not grant filesystem access"). That step was never ported:
 * the Claude and Codex adapters `continue`d past every non-image ref behind a
 * comment that assumed it, and the file vanished. This is the one spelling of
 * that step, called by each adapter for exactly the refs it does not ingest
 * natively — Claude ingests images, Codex images by path, OpenCode
 * image/`text/*`/pdf as `file` parts, Grok nothing.
 *
 * Two rules, both load-bearing:
 * - **A suffix, never a prefix or a wrap** (§4.6.9): a `/command` the user typed
 *   stays first.
 * - **A path the text already names is skipped.** The composer inserts the
 *   path at the caret when the upload completes (§7.4), so the common case
 *   appends nothing; this block is the guarantee for the text the user edited
 *   it out of, an older bundle, or a ref delivered from outside the composer.
 *   `namedIn` is the text that check reads, `text` by default, because a skill
 *   dispatch splits the message into a leading block and a command block and a
 *   path typed in either counts as named.
 */

export interface AttachmentPathLine {
  /** The original file name, for the agent's benefit; the path is what it reads. */
  name: string;
  /** Absolute host path, as `AdapterContext.resolveAttachmentPath` answers it. */
  path: string;
}

export function appendAttachmentPathLines(
  text: string,
  attachments: readonly AttachmentPathLine[],
  namedIn: string = text
): string {
  const missing = attachments.filter((attachment) => !namedIn.includes(attachment.path));
  if (missing.length === 0) {
    return text;
  }
  const block = `Attached files:\n${missing
    .map((attachment) => `- ${singleLineName(attachment.name)}: ${attachment.path}`)
    .join("\n")}`;
  return text.length === 0 ? block : `${text}\n\n${block}`;
}

/**
 * Collapse every run of control characters in a name to one space: a name is
 * the uploader's text, and a newline in it would forge a line of the user's
 * turn.
 */
function singleLineName(name: string): string {
  return name.replace(/[\u0000-\u001f\u007f]+/g, " ");
}

/**
 * The inverse, for a provider's NATIVE history: the block is provider input
 * and is never persisted by the host, but the CLI's own transcript keeps the
 * text the adapter sent, so a thread resumed from it would replay the block
 * inside the user's bubble. Removes exactly one trailing block in the shape
 * `appendAttachmentPathLines` writes; anything else — including a block the
 * user typed mid-message, and a block with nothing but whitespace before it —
 * is returned by identity.
 *
 * A line is `- <name>: <path>`, checked by a lookahead and then consumed whole.
 * `- [^\n]*: [^\n]+` accepts exactly the same lines, but it can split a line
 * holding several ": " in as many ways, and a block-shaped run that fails at
 * its end then retries every combination — exponential, on the one event
 * loop every thread shares, for text a native transcript can hold.
 */
export function stripAttachmentPathLines(text: string): string {
  const match = /(?:^|\n\n)Attached files:(?:\n- (?=[^\n]*: [^\n])[^\n]*)+$/.exec(text);
  if (match === null) {
    return text;
  }
  const kept = text.slice(0, match.index);
  // A block that is the whole message is all the user sent, and a replay has
  // no attachment chips to show instead, so it stays as the turn's evidence.
  return kept.trim().length === 0 ? text : kept;
}

/**
 * Whether `text` is exactly one block and nothing else: the shape
 * `appendAttachmentPathLines` writes; the strip and Claude's replay projection
 * both key on it — change all three together. The strip's own line form, in
 * the same linear lookahead (see above), anchored to the whole text with no
 * `m` flag, so a line before or after the block is not the block.
 */
export function isAttachmentPathBlock(text: string): boolean {
  return /^Attached files:(?:\n- (?=[^\n]*: [^\n])[^\n]*)+$/.test(text);
}
