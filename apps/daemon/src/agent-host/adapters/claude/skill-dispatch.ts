/**
 * Claude adapter — `$skill` dispatch (spec §4.6.8).
 *
 * Ported from T3 Code (MIT):
 * `apps/server/src/provider/Drivers/ClaudeSkillDispatch.ts`.
 *
 * The composer inserts `$name` for every provider. Codex parses that natively;
 * Claude Code does not and treats it as prose. Claude Code's only user-side
 * invocation is a text block whose **first character** is `/`: the harness
 * expands `/name args` into the SKILL.md body and every character after the
 * name (newlines included) arrives as `ARGUMENTS`.
 *
 * - The check runs on the LAST text block of the message. Earlier text blocks
 *   are preserved verbatim, and image blocks may sit before it.
 * - Leading whitespace, or a `/name` that starts a later line of the same
 *   block, is literal text.
 * - Only one skill expands per message; a second `/x` becomes argument text
 *   (anthropics/claude-code#87113). The model still starts the rest through
 *   its Skill tool when it reads `/name` in the prompt, so earlier mentions
 *   are rewritten to `/name` inline.
 */

/**
 * The same token shape the composer and the timeline chips recognise, so a
 * rendered chip and a dispatched skill are always the same set. `\p{Sc}` is
 * the currency-symbol class: `$name`, but never `$5k` or `$1e6`.
 */
const SKILL_MENTION_PATTERN =
  /(^|\s)\p{Sc}(?![0-9][0-9_]*(?:[kKmMbBtT]|[eE][0-9]+)?(?:\s|$))(?=[a-zA-Z0-9:_-]*[a-zA-Z])([a-zA-Z0-9][a-zA-Z0-9:_-]*)(?=\s|$)/gu;

export interface ClaudeSkillDispatch {
  /** Text before the dispatched mention, or `undefined` when it opens the prompt. */
  readonly leadingText: string | undefined;
  /** `/name` plus the trailing text, ready to be the message's last text block. */
  readonly commandText: string;
  readonly skillName: string;
}

/**
 * Split `prompt` around the last `$skill` mention that names a known skill.
 * Returns `undefined` when there is nothing to dispatch, in which case the
 * prompt goes out unchanged. Mentions that do not match a discovered skill
 * stay literal: a `$HOME` in prose must not become a command.
 */
export function planClaudeSkillDispatch(
  prompt: string,
  skillNames: ReadonlySet<string>
): ClaudeSkillDispatch | undefined {
  const mentions: Array<{ name: string; start: number; end: number }> = [];
  for (const match of prompt.matchAll(SKILL_MENTION_PATTERN)) {
    const name = match[2] ?? "";
    if (!skillNames.has(name)) {
      continue;
    }
    const index = match.index ?? 0;
    mentions.push({
      name,
      start: index + (match[1]?.length ?? 0),
      end: index + match[0].length
    });
  }

  const last = mentions.at(-1);
  if (!last) {
    return undefined;
  }

  const leading = prompt.slice(0, last.start);
  const trailing = prompt.slice(last.end);
  const leadingWithInlineSlashes = mentions
    .slice(0, -1)
    .reduceRight(
      (text, mention) =>
        `${text.slice(0, mention.start)}/${mention.name}${text.slice(mention.end)}`,
      leading
    )
    .trimEnd();

  return {
    leadingText: leadingWithInlineSlashes.length > 0 ? leadingWithInlineSlashes : undefined,
    commandText: `/${last.name}${trailing}`.trimEnd(),
    skillName: last.name
  };
}

/**
 * §4.6.9: a turn whose text already opens with a slash command is never
 * prefixed, indented or wrapped — prefixing it turns the command into prose
 * and the CLI never runs it. Orquester ships no prompt-injected effort level,
 * so this is a rule the send path asserts rather than a workaround it applies.
 */
export function startsWithSlashCommand(text: string): boolean {
  return /^\/[^\s/]+(?:\s|$)/u.test(text);
}
