/**
 * The `$skill` mentions in a piece of text, in order, deduped.
 *
 * §4.6.7: "`$skill` mentions are re-chipped from the stored text by the same
 * tokeniser the composer uses. No `isCommand` flag is persisted." This is that
 * tokeniser — the timeline re-runs it over a sent user message against the
 * current per-cwd skill list so a mention renders as a chip rather than as raw
 * `$name`, and the round trip stays one-way-derivable from the text.
 *
 * Only *known* names match: an unknown `$foo` stays literal, exactly as the
 * send path leaves it (§4.6.8). `\p{Sc}` rather than a literal `$` for the
 * same reason the composer's trigger uses it — a keyboard laid out for € or £
 * reaches skills too.
 *
 * Restored after W11's `slash-commands.logic.ts` was deleted in the
 * fix-wave arbitration (R2-5). Pure and on its own, so the timeline's rows
 * re-chip mentions without importing the composer.
 */
export function skillMentionsInText(
  text: string,
  knownSkillNames: readonly string[]
): string[] {
  const known = new Set(knownSkillNames.map((name) => name.toLowerCase()));
  const found: string[] = [];
  // `:` too: a plugin's skill is `plugin:skill` (Claude's, dotted plugin names included), the
  // shape the daemon's dispatch accepts. A trailing `.` or `:` stays in the token, so `$review.`
  // or `$1.50` is no known name and no chip, as dispatch leaves them literal too.
  for (const match of text.matchAll(/(?:^|\s)\p{Sc}([\w.:-]+)/gu)) {
    const name = match[1];
    if (name && known.has(name.toLowerCase()) && !found.includes(name)) {
      found.push(name);
    }
  }
  return found;
}
