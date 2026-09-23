/**
 * What a command row shows under its label (spec §7.2) — one rule for the
 * GUI's timeline and the MCP's `read_transcript`.
 *
 * A `command_execution` row's `detail` is the line its provider chose, and
 * for some providers that line is the command again: Grok's ACP tool call
 * repeats the command there (ingestion cuts a long one short with "...") and
 * carries what it printed in `rawOutput` or in ACP `content` blocks. Read as
 * it comes, such a row said twice what ran and never what it printed. So a
 * command row shows the output its provider data carries whenever `detail`
 * says less — it is empty, it repeats the row's title, or, on a call whose
 * data says it executes, it repeats the command — and no detail at all when
 * it only echoes the command and no output has arrived. Otherwise the
 * provider's `detail` stands (OpenCode's, for one, is already the fuller
 * output).
 *
 * The output read here is the one the wire carries: on every read path
 * `slimActivityPayload` (§5.6) has cut it to a one-line preview, and
 * `GET …/items/:itemId` holds the whole of it.
 *
 * Both readers call {@link commandDisplayDetail} — the timeline's work-log
 * rows (`packages/ui/src/lib/agent-chat/entries.logic.ts`) and the MCP's tool
 * rows (`apps/daemon/src/mcp/transcript.ts`) — so a change here changes what
 * both show.
 *
 * *T3: `packages/client-runtime/src/work-log/presentation.ts` reads the same
 * output locations (audit:
 * `docs/superpowers/research/2026-09-23-agent-timeline-rendering-audit.md`).*
 */

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const asTrimmedString = (value: unknown): string | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

/**
 * The output a command's provider data carries: the first of these that is a
 * non-blank string, trimmed — Codex's `item.aggregatedOutput`, the item's
 * `result.content`, a `rawOutput` that is the text itself, then `rawOutput`'s
 * `content` (the shape the wire's slimming leaves), its `stdout` and `stderr`
 * joined, its `output` and its `output_for_prompt` (Grok's), then the text of
 * ACP `content` blocks joined, then `result.content`, then a `result` that is
 * the text itself.
 */
function commandOutputPreview(data: Record<string, unknown> | null): string | undefined {
  const item = asRecord(data?.item);
  const raw = asRecord(data?.rawOutput);
  const outputStreams = [asTrimmedString(raw?.stdout), asTrimmedString(raw?.stderr)]
    .filter((value): value is string => value !== undefined);
  const content = Array.isArray(data?.content)
    ? data.content.flatMap((value) => {
        const block = asRecord(value);
        const text = asRecord(block?.content);
        return block?.type === "content" ? [asTrimmedString(text?.text)].filter(Boolean) : [];
      }).join("\n")
    : undefined;
  const candidates = [
    item?.aggregatedOutput,
    asRecord(item?.result)?.content,
    data?.rawOutput,
    raw?.content,
    outputStreams.length > 0 ? outputStreams.join("\n") : undefined,
    raw?.output,
    raw?.output_for_prompt,
    content,
    asRecord(data?.result)?.content,
    data?.result
  ];
  for (const candidate of candidates) {
    const text = asTrimmedString(candidate);
    if (text !== undefined) return text;
  }
  return undefined;
}

/**
 * A `detail` that only repeats the command: the command itself, or a head of
 * it cut short with "..." (ingestion's cut) or "…".
 */
function repeatsCommandPreview(detail: string | undefined, command: string | undefined): boolean {
  if (detail === undefined || command === undefined) return false;
  if (detail === command) return true;
  const prefix = detail.endsWith("...")
    ? detail.slice(0, -3)
    : detail.endsWith("…")
      ? detail.slice(0, -1)
      : undefined;
  return prefix !== undefined && prefix.length > 0 && command.startsWith(prefix);
}

/**
 * The detail a row shows for this activity payload: for a
 * `command_execution` payload the rule above, for any other the row's
 * `detail` as it is.
 *
 * The row's `detail` is the payload's own, trimmed, unless `options.detail`
 * names the one the caller kept: the GUI's task rows can promote their
 * `detail` to the row's label, and such a row passes what it has left (none),
 * which reads as an empty detail. The command is the payload's `command`,
 * else its data's; an echo counts only on a call whose data says it executes
 * (`data.kind`, ACP's `execute`).
 */
export function commandDisplayDetail(
  payload: unknown,
  options?: { readonly detail: string | undefined }
): string | undefined {
  const record = asRecord(payload);
  const data = asRecord(record?.data);
  const detail = options !== undefined ? options.detail : asTrimmedString(record?.detail);
  const command = asTrimmedString(record?.command) ?? asTrimmedString(data?.command);
  const isCommand = record?.itemType === "command_execution";
  const output = isCommand ? commandOutputPreview(data) : undefined;
  const commandEcho =
    isCommand && repeatsCommandPreview(detail, command) &&
    asTrimmedString(data?.kind)?.toLowerCase() === "execute";
  return isCommand && output !== undefined &&
    (detail === undefined || commandEcho || detail === asTrimmedString(record?.title))
    ? output
    : commandEcho
      ? undefined
      : detail;
}
