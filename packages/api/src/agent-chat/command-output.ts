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
 * both show. {@link commandOutputText} reads the WHOLE output out of the
 * unslimmed item (the MCP's `read_tool_output`, `apps/daemon/src/mcp/tools/
 * output.ts`), from the one list of places the preview reads, in its order.
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
 * The places a command's provider data carries its output, in the order they
 * are read, each as the pieces it holds: Codex's `item.aggregatedOutput`, the
 * item's `result.content`, a `rawOutput` that is the text itself, then
 * `rawOutput`'s `content` (the shape the wire's slimming leaves), its `stdout`
 * and `stderr` (two pieces), its `output` and its `output_for_prompt` (Grok's),
 * then the texts of ACP `content` blocks (a piece each), then `result.content`,
 * then a `result` that is the text itself.
 *
 * The ONE list: the row's preview and the whole output both read the first
 * place that holds a non-blank piece ({@link outputPieces}), in this order. The
 * whole output is that first place in the UNSLIMMED item; the preview reads the
 * slimmed payload, whose allow-list rebuild may leave a different place first
 * (Grok's: the unslimmed item's `rawOutput.output_for_prompt`, where the wire
 * keeps only the ACP blocks' summary, as `rawOutput.content`) — so the whole
 * output is usually, not always, the text the preview was cut from.
 */
function outputPlaces(data: Record<string, unknown> | null): readonly (readonly unknown[])[] {
  const item = asRecord(data?.item);
  const raw = asRecord(data?.rawOutput);
  const blocks = Array.isArray(data?.content)
    ? data.content.flatMap((value) => {
        const block = asRecord(value);
        return block?.type === "content" ? [asRecord(block.content)?.text] : [];
      })
    : [];
  return [
    [item?.aggregatedOutput],
    [asRecord(item?.result)?.content],
    [data?.rawOutput],
    [raw?.content],
    [raw?.stdout, raw?.stderr],
    [raw?.output],
    [raw?.output_for_prompt],
    blocks,
    [asRecord(data?.result)?.content],
    [data?.result]
  ];
}

/**
 * The output's pieces, as the provider wrote them: the non-blank strings of the
 * first place that has one. A blank piece — a stream that printed only
 * whitespace — is no output, and a value that is not a string is never text.
 */
function outputPieces(data: unknown): string[] | undefined {
  for (const place of outputPlaces(asRecord(data))) {
    const pieces = place.filter((piece): piece is string => asTrimmedString(piece) !== undefined);
    if (pieces.length > 0) return pieces;
  }
  return undefined;
}

/**
 * What the row shows of the output: each piece trimmed, one piece per line.
 * On the wire each piece is already the slimmer's one-line summary.
 */
function commandOutputPreview(data: Record<string, unknown> | null): string | undefined {
  return outputPieces(data)?.map((piece) => piece.trim()).join("\n");
}

/**
 * The WHOLE output a command's provider data carries — the first place, in the
 * preview's reading order, that holds output ({@link outputPlaces}), as the
 * provider wrote it: nothing trimmed, inside or at the ends. A place of several
 * pieces (`stdout` then `stderr`; ACP content blocks) starts each piece on a
 * line of its own: a newline goes between two pieces only where the first does
 * not already end with one. `undefined` when the data carries no output.
 *
 * Read it from the UNSLIMMED item (`GET …/items/:itemId`, §5.6): on the wire
 * the output is already cut to its preview. Output the provider only streamed
 * is in no item's data at all (a Claude background shell's; a running
 * command's so far): `GET …/items/:itemId/output` joins its chunks instead.
 */
export function commandOutputText(data: unknown): string | undefined {
  return outputPieces(data)?.reduce((text, piece) => `${text}${text.endsWith("\n") ? "" : "\n"}${piece}`);
}

/**
 * A command's output as its ITEM stores it (`GET …/items/:itemId`, the
 * unslimmed read), and whether that is all of it — the one rule both readers
 * of a row's whole output follow: the GUI's "Load full output"
 * (`readFullOutput`, `packages/ui/src/lib/agent-chat/full-output.ts`) and the
 * MCP's `read_tool_output` (`apps/daemon/src/mcp/tools/output.ts`).
 *
 * - An item stored whole holds its output whole ({@link commandOutputText} of
 *   its data): `whole: true`, answered first.
 * - A COMPLETION stored cut (`payload.truncated`) holds only part of its
 *   output, and its adapter said so: Codex keeps the start of a long
 *   `aggregatedOutput`, its first 64 KiB (`COMMAND_OUTPUT_MAX_BYTES`,
 *   `apps/daemon/src/agent-host/adapters/codex/items.ts`); OpenCode's `bash`
 *   tool keeps the END of one past its limits, behind a note naming the file
 *   that holds all of it (`isCutFinalOutput`,
 *   `apps/daemon/src/agent-host/adapters/opencode/state.ts`). `whole: false`: a
 *   reader asks the call's streamed output first, which the host joins whole,
 *   and answers the kept part only when that comes back empty, saying it is
 *   only part of the output — never as JSON, and never as the whole output.
 *   (A host's first load closes a call a dead process left open with a
 *   completion that may carry an update's cut copy, marked the same way: its
 *   preview reads the same way, a part of the output.)
 * - An UPDATE stored cut holds no part of it: ingestion persists every
 *   `tool.updated` already slimmed (§5.6), its data a one-line preview that is
 *   never labelled as the output — `undefined`, as for an item that is no
 *   command's, or whose data carries no output.
 */
export function storedCommandOutput(
  activityKind: string,
  payload: unknown
): { text: string; whole: boolean } | undefined {
  const record = asRecord(payload);
  if (record?.itemType !== "command_execution") {
    return undefined;
  }
  const text = commandOutputText(record.data);
  if (text === undefined) {
    return undefined;
  }
  if (record.truncated !== true) {
    return { text, whole: true };
  }
  return activityKind === "tool.completed" ? { text, whole: false } : undefined;
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
