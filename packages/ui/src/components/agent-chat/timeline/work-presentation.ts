// Ported from T3 Code (MIT): packages/client-runtime/src/work-log/presentation.ts,
// apps/web/src/components/chat/MessagesTimeline.logic.ts, apps/web/src/session-logic.ts

/**
 * The presentation resolver for the one normalised activity record (spec §7.2).
 *
 * **Nothing here branches on the provider and nothing here is a component.**
 * Icon, label, tone and the group summary are all pure functions of the
 * allow-listed fields §5.6 guarantees survive slimming, so adding a tool never
 * adds a component and never adds a case to this file.
 *
 * Everything is exported and unit-tested: these are the rules the timeline's
 * look depends on, and a regression in `summarizeToolGroup` is invisible in a
 * screenshot but obvious in a diff.
 */

import type { ToolGroupSummaryKind, WorkLogEntry } from "../../../lib/agent-chat/contracts";

/**
 * The fields a presentation decision may read. Deliberately narrower than
 * {@link WorkLogEntry} so a helper cannot start depending on something the
 * slimmer is allowed to drop.
 */
export type WorkPresentationEntry = Pick<
  WorkLogEntry,
  | "label"
  | "detail"
  | "command"
  | "changedFiles"
  | "tone"
  | "toolTitle"
  | "itemType"
  | "requestKind"
  | "toolLifecycleStatus"
  | "sourceActivityKind"
  | "turnId"
  | "toolCallId"
  | "taskId"
  | "questionAnswer"
  | "agentSpawn"
>;

/**
 * The buckets `summarizeToolGroup` counts in. `update` is T3's bucket for
 * rows that are not a tool call at all (an approval request and its
 * resolution); it is internal here because the row contract's
 * {@link ToolGroupSummaryKind} has no such arm — {@link toolGroupSummaryKind}
 * folds it into `other` on the way out.
 */
export type ToolGroupAction = ToolGroupSummaryKind | "update";

/** The lucide glyph a row shows. Resolved by name so rows stay data-driven. */
export type WorkEntryIconName =
  | "brain"
  | "check"
  | "circle-alert"
  | "eye"
  | "square-pen"
  | "terminal"
  | "globe"
  | "search"
  | "wrench"
  | "hammer"
  | "bot"
  | "message-circle"
  | "zap"
  | "minimize-2"
  | "shuffle";

// ---------------------------------------------------------------------------
// Label normalisation
// ---------------------------------------------------------------------------

/**
 * Drops the trailing "complete"/"completed" some providers append, so the
 * in-progress and the terminal row of one call share an identity.
 * *T3: `presentation.ts:70-72`.*
 */
export function normalizeCompactToolLabel(value: string): string {
  return value.replace(/\s+(?:complete|completed)\s*$/i, "").trim();
}

function capitalize(value: string): string {
  return value.length === 0 ? value : `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

function nonEmpty(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * The display form of a path, relative to the project when it is inside it.
 *
 * Deliberately simpler than T3's `formatWorkspaceRelativePath`: we have no
 * `path:line:col` suffix syntax and no Windows-drive normalisation to undo, so
 * this is separator normalisation plus a prefix strip that keeps the project
 * folder's own name as the first segment (`orquester/src/index.ts`), which is
 * what makes a path recognisable when several projects are open.
 */
export function formatWorkspaceRelativePath(
  path: string,
  workspaceRoot: string | undefined
): string {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\/+/, "");
  if (workspaceRoot === undefined || workspaceRoot.length === 0) return normalized;
  const root = workspaceRoot.replaceAll("\\", "/").replace(/\/+$/, "");
  if (root.length === 0) return normalized;
  if (!normalized.startsWith(`${root}/`)) return normalized;
  const label = root.slice(root.lastIndexOf("/") + 1);
  const rest = normalized.slice(root.length + 1);
  return label.length > 0 ? `${label}/${rest}` : rest;
}

const SHELL_WRAPPERS = new Set([
  "sudo",
  "doas",
  "env",
  "command",
  "nohup",
  "time",
  "xargs",
  "nice",
  "exec"
]);

/**
 * The program a command line runs, for the "Running npm" style live label.
 *
 * DELIBERATE SIMPLIFICATION: T3 spends ~1 300 lines
 * (`packages/client-runtime/src/work-log/commandLabel.ts`) resolving this
 * through PowerShell call operators, shell aliases and nested `-c` strings. We
 * take the first word that is not an environment assignment or a known
 * wrapper, unquote it and keep its basename — which is the answer for every
 * command an agent CLI actually reports — and return `null` rather than guess.
 */
export function commandProgramName(command: string): string | null {
  const first = command.trim().split(/\s+/);
  for (const raw of first) {
    if (raw.length === 0) continue;
    // FOO=bar prefixes are not the program.
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(raw)) continue;
    const unquoted = raw.replace(/^["']/, "").replace(/["']$/, "");
    if (unquoted.length === 0) continue;
    if (unquoted.startsWith("-")) continue;
    const base = unquoted.slice(unquoted.replaceAll("\\", "/").lastIndexOf("/") + 1);
    if (base.length === 0) continue;
    if (SHELL_WRAPPERS.has(base)) continue;
    return base;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Failure classification (§7.3 "failure styling is reserved")
// ---------------------------------------------------------------------------

/** *T3: `presentation.ts:363-369`.* */
export function workLogEntryIsToolLike(entry: WorkPresentationEntry): boolean {
  if (entry.tone === "tool" || entry.tone === "thinking" || entry.tone === "error") return true;
  if (nonEmpty(entry.command) !== null) return true;
  if (entry.requestKind !== undefined) return true;
  return entry.itemType !== undefined;
}

/**
 * Some providers report completion even when the output describes a failure.
 * *T3: `presentation.ts:394-416`.*
 */
export function toolDetailTextLooksLikeFailure(text: string): boolean {
  const normalized = text.toLowerCase();
  return (
    normalized.includes("file not found") ||
    normalized.includes("no files found") ||
    normalized.includes("enoent") ||
    normalized.includes("no such file or directory") ||
    normalized.includes("no such file") ||
    normalized.includes("command not found") ||
    normalized.includes("permission denied") ||
    /<exited with exit code\s+[1-9]\d*\s*>/i.test(text) ||
    /exit(?:ed)? with exit code\s+[1-9]\d*/i.test(text) ||
    /exit code\s*[:\s]\s*[1-9]\d*\b/i.test(text)
  );
}

function indicatesFailureFromOutput(
  entry: WorkPresentationEntry,
  includeCommand: boolean
): boolean {
  if (
    entry.tone === "error" ||
    entry.toolLifecycleStatus === "failed" ||
    entry.toolLifecycleStatus === "declined"
  ) {
    return true;
  }
  if (!workLogEntryIsToolLike(entry)) return false;
  const output = includeCommand
    ? [entry.detail, entry.command].filter((value) => value !== undefined).join("\n")
    : (entry.detail ?? "");
  return output.length > 0 && toolDetailTextLooksLikeFailure(output);
}

/** Includes rows whose error output was stored in the command field. */
export function workEntryIndicatesToolFailure(entry: WorkPresentationEntry): boolean {
  return indicatesFailureFromOutput(entry, true);
}

/** Checks rendered output without treating the user's own command as an error. */
export function workEntryDisplayIndicatesToolFailure(entry: WorkPresentationEntry): boolean {
  return indicatesFailureFromOutput(entry, false);
}

/** Whether the row may show a success marker. *T3: `presentation.ts:446-454`.* */
export function workEntryIndicatesToolSuccess(entry: WorkPresentationEntry): boolean {
  return (
    workLogEntryIsToolLike(entry) &&
    !workEntryIndicatesToolFailure(entry) &&
    entry.tone !== "thinking" &&
    entry.toolLifecycleStatus !== "inProgress"
  );
}

/** Tool-like row with neither clear success nor failure. *T3: `session-logic.ts:172-190`.* */
export function workEntryIndicatesToolNeutralStatus(entry: WorkPresentationEntry): boolean {
  // A spawn CTA is never neutral-hidden: mid-run it derives from task.progress
  // and the neutral filter would swallow it exactly while the fleet runs.
  if (entry.agentSpawn !== undefined) return false;
  if (!workLogEntryIsToolLike(entry)) return false;
  if (workEntryIndicatesToolFailure(entry)) return false;
  if (workEntryIndicatesToolSuccess(entry)) return false;
  return true;
}

/**
 * Only a `runtime.error` or a `*.failed` lifecycle event earns the destructive
 * treatment — the turn or a core side effect broke. A non-zero command exit
 * does not. *T3: `session-logic.ts:165-170`.*
 */
export function workEntrySignalsSevereFailure(entry: WorkPresentationEntry): boolean {
  return (
    entry.sourceActivityKind === "runtime.error" ||
    entry.sourceActivityKind?.endsWith(".failed") === true
  );
}

/** `runtime.warning` gets its own icon and colour, distinct from both (§7.3). */
export function workEntryIsWarning(entry: WorkPresentationEntry): boolean {
  return entry.sourceActivityKind === "runtime.warning";
}

/** The inline "the model you asked for was not the model that ran" notice (§7.3). */
export function workEntryIsRerouteNotice(entry: WorkPresentationEntry): boolean {
  return entry.sourceActivityKind === "model.rerouted";
}

/** The destructive row style: a severe failure, or a failure on a non-tool row. */
export function showDestructiveRowStyle(entry: WorkPresentationEntry): boolean {
  return (
    workEntryDisplayIndicatesToolFailure(entry) &&
    (workEntrySignalsSevereFailure(entry) || !workLogEntryIsToolLike(entry))
  );
}

// ---------------------------------------------------------------------------
// Grouping and summary (§7.3)
// ---------------------------------------------------------------------------

/** *T3: `presentation.ts:462-497`.* */
export function toolGroupAction(entry: WorkPresentationEntry): ToolGroupAction {
  if (
    entry.sourceActivityKind === "approval.requested" ||
    entry.sourceActivityKind === "approval.resolved" ||
    entry.sourceActivityKind === "user-input.requested" ||
    entry.sourceActivityKind === "user-input.resolved"
  ) {
    return "update";
  }
  if (entry.requestKind === "file-read" || entry.itemType === "image_view") return "read";
  if (
    entry.requestKind === "file-change" ||
    entry.itemType === "file_change" ||
    (entry.changedFiles?.length ?? 0) > 0
  ) {
    return "edit";
  }
  if (
    entry.requestKind === "command" ||
    entry.itemType === "command_execution" ||
    nonEmpty(entry.command) !== null
  ) {
    return "command";
  }
  if (entry.itemType === "web_search") return "search";
  return workLogEntryIsToolLike(entry) ? "other" : "update";
}

/** The row contract's five-arm kind; `update` folds into `other`. */
export function toolGroupSummaryKind(entry: WorkPresentationEntry): ToolGroupSummaryKind {
  const action = toolGroupAction(entry);
  return action === "update" ? "other" : action;
}

/** Edits count distinct files, so three edits to one file read as one file. */
export function toolGroupActionCount(
  action: ToolGroupAction,
  entries: readonly WorkPresentationEntry[]
): number {
  if (action !== "edit") return entries.length;
  const changedFiles = new Set<string>();
  let editsWithoutFileDetails = 0;
  for (const entry of entries) {
    if (!entry.changedFiles || entry.changedFiles.length === 0) {
      editsWithoutFileDetails += 1;
      continue;
    }
    for (const file of entry.changedFiles) changedFiles.add(file);
  }
  return changedFiles.size + editsWithoutFileDetails;
}

/** *T3: `presentation.ts:567-596`.* */
export function toolGroupActionLabel(action: ToolGroupAction, count: number): string {
  switch (action) {
    case "read":
      return `Read ${count} ${count === 1 ? "file" : "files"}`;
    case "edit":
      return `Changed ${count} ${count === 1 ? "file" : "files"}`;
    case "command":
      return `Ran ${count} ${count === 1 ? "command" : "commands"}`;
    case "search":
      return `Searched ${count} ${count === 1 ? "time" : "times"}`;
    case "other":
      return `Used ${count} ${count === 1 ? "tool" : "tools"}`;
    case "update":
      return `Received ${count} ${count === 1 ? "update" : "updates"}`;
  }
}

/**
 * Drops a superseded lifecycle marker before anything counts it: a
 * `tool.started` row with **no** `toolCallId` and **no** status, whose
 * `{turnId, itemType, normalised label}` identity already has a later terminal
 * row, is not a second tool call. Skipping this double-counts every tool on a
 * provider that emits an unkeyed start frame.
 * *T3: `presentation.ts:637-673`.*
 */
export function omitSupersededLifecycleMarkers<T>(
  entries: readonly T[],
  workEntryFor: (entry: T) => WorkPresentationEntry
): T[] {
  const laterTerminalIdentities = new Set<string>();
  const reversed: T[] = [];

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index] as T;
    const work = workEntryFor(entry);
    const normalizedLabel = normalizeCompactToolLabel(work.toolTitle ?? work.label);
    const identity = [work.turnId ?? "no-turn", work.itemType ?? "", normalizedLabel].join("\u001f");
    const activityKind = work.sourceActivityKind;
    const isStatuslessIdlessMarker =
      work.toolCallId === undefined &&
      work.toolLifecycleStatus === undefined &&
      (activityKind === "tool.started" || activityKind === "tool.updated");
    if (isStatuslessIdlessMarker && laterTerminalIdentities.has(identity)) continue;

    reversed.push(entry);
    if (
      activityKind === "tool.completed" ||
      (work.toolLifecycleStatus !== undefined && work.toolLifecycleStatus !== "inProgress")
    ) {
      laterTerminalIdentities.add(identity);
    }
  }

  reversed.reverse();
  return reversed;
}

/**
 * "Read 3 files, ran 2 commands" — the settled activity-group label.
 * Buckets by {@link toolGroupAction}, joins with an Oxford comma, and
 * lower-cases every clause after the first so the line reads as a sentence.
 * *T3: `presentation.ts:598-635`.*
 */
export function summarizeToolGroup(entries: readonly WorkPresentationEntry[]): string {
  const summaryEntries = omitSupersededLifecycleMarkers(entries, (entry) => entry);
  const grouped = new Map<ToolGroupAction, WorkPresentationEntry[]>();
  for (const entry of summaryEntries) {
    const action = toolGroupAction(entry);
    const group = grouped.get(action);
    if (group) group.push(entry);
    else grouped.set(action, [entry]);
  }
  const labels = [...grouped].map(([action, actionEntries]) =>
    toolGroupActionLabel(action, toolGroupActionCount(action, actionEntries))
  );
  const sentence = labels.map((label, index) =>
    index === 0 ? label : label.charAt(0).toLowerCase() + label.slice(1)
  );
  if (sentence.length < 2) return sentence[0] ?? "";
  if (sentence.length === 2) return sentence.join(" and ");
  return `${sentence.slice(0, -1).join(", ")}, and ${sentence.at(-1)}`;
}

/** The summary kind of a whole group, for the "+N more" row's icon. */
export function summarizeToolGroupKind(
  entries: readonly WorkPresentationEntry[]
): ToolGroupSummaryKind {
  const kinds = new Set(entries.map((entry) => toolGroupSummaryKind(entry)));
  if (kinds.size === 1) {
    const [only] = [...kinds];
    if (only !== undefined) return only;
  }
  return "other";
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

/** The latest live activity stays present-tense unless the call itself ended badly. */
export function liveActivityToolStatus(
  status: WorkPresentationEntry["toolLifecycleStatus"],
  presentTense: boolean
): WorkPresentationEntry["toolLifecycleStatus"] {
  if (status === "failed" || status === "declined") return status;
  if (presentTense || status === "inProgress") return "inProgress";
  return "completed";
}

/** *T3: `MessagesTimeline.logic.ts:57-71`.* */
export function workEntryDisplayLabel(
  entry: WorkPresentationEntry,
  workspaceRoot: string | undefined
): string {
  const command = nonEmpty(entry.command);
  if (command !== null) return command;
  const detail = nonEmpty(entry.detail);
  if (detail !== null) return detail;
  const changedFiles = entry.changedFiles ?? [];
  const [firstPath] = changedFiles;
  if (firstPath !== undefined) {
    const path = formatWorkspaceRelativePath(firstPath, workspaceRoot);
    return changedFiles.length === 1 ? path : `${path} +${changedFiles.length - 1} more`;
  }
  return capitalize(normalizeCompactToolLabel(entry.toolTitle || entry.label));
}

/** *T3: `MessagesTimeline.logic.ts:73-99`.* */
export function liveWorkEntryLabel(
  entry: WorkPresentationEntry,
  workspaceRoot: string | undefined,
  active: boolean
): string {
  const status = liveActivityToolStatus(entry.toolLifecycleStatus, active);
  const command = nonEmpty(entry.command);
  if (command !== null) {
    const verb =
      status === "inProgress"
        ? "Running"
        : status === "failed"
          ? "Failed"
          : status === "declined"
            ? "Declined"
            : "Ran";
    return `${verb} ${commandProgramName(command) ?? "command"}`;
  }
  return workEntryDisplayLabel(entry, workspaceRoot);
}

// ---------------------------------------------------------------------------
// Visibility inside a group
// ---------------------------------------------------------------------------

/** *T3: `MessagesTimeline.logic.ts:101-110`.* */
export function workEntryIsVisibleInGroup(
  entry: WorkPresentationEntry,
  expandedToolGroupEntry = false
): boolean {
  return (
    (expandedToolGroupEntry &&
      (entry.toolLifecycleStatus === "inProgress" ||
        entry.sourceActivityKind === "task.progress")) ||
    !workEntryIndicatesToolNeutralStatus(entry)
  );
}

/** *T3: `MessagesTimeline.logic.ts:614-621`.* */
export function workEntryIsActiveTurnActivity(entry: WorkPresentationEntry): boolean {
  return (
    entry.toolLifecycleStatus === "inProgress" ||
    (entry.toolLifecycleStatus === undefined &&
      (entry.sourceActivityKind === "task.progress" || workLogEntryIsToolLike(entry)))
  );
}

// ---------------------------------------------------------------------------
// Icons and tone
// ---------------------------------------------------------------------------

function toolGroupSummaryIconName(kind: ToolGroupAction): WorkEntryIconName {
  switch (kind) {
    case "read":
      return "eye";
    case "edit":
      return "square-pen";
    case "command":
      return "terminal";
    case "search":
      return "globe";
    case "other":
      return "wrench";
    case "update":
      return "hammer";
  }
}

/** Exported for the "+N more" row, which carries only a {@link ToolGroupSummaryKind}. */
export function summaryKindIconName(kind: ToolGroupSummaryKind): WorkEntryIconName {
  return toolGroupSummaryIconName(kind);
}

function workToneIconName(tone: WorkPresentationEntry["tone"]): WorkEntryIconName {
  if (tone === "error") return "circle-alert";
  if (tone === "thinking") return "brain";
  if (tone === "info") return "check";
  return "zap";
}

/**
 * The icon fallback chain. *T3: `MessagesTimeline.tsx:4549-4578`.*
 *
 * Warning and severe-failure chrome is applied by the row, not here, so the
 * same entry keeps its identity glyph in the group summary while the standalone
 * row shows `circle-alert`.
 */
export function workEntryIconName(entry: WorkPresentationEntry): WorkEntryIconName {
  if (entry.agentSpawn !== undefined) return "bot";
  if (
    entry.questionAnswer !== undefined ||
    entry.sourceActivityKind === "user-input.requested" ||
    entry.sourceActivityKind === "user-input.resolved"
  ) {
    return "message-circle";
  }
  if (workEntryIsRerouteNotice(entry)) return "shuffle";
  if (entry.sourceActivityKind === "context-compaction") return "minimize-2";
  const action = toolGroupAction(entry);
  if (action !== "other" && action !== "update") return toolGroupSummaryIconName(action);
  switch (entry.itemType) {
    case "mcp_tool_call":
      return "wrench";
    case "dynamic_tool_call":
      return "hammer";
    case "collab_agent_tool_call":
      return "bot";
    default:
      break;
  }
  // Subagent lifecycle rows (grouped by taskId) get agent identity chrome.
  if (entry.taskId !== undefined) return "bot";
  return workToneIconName(entry.tone);
}

// ---------------------------------------------------------------------------
// Joining one tool call's lifecycle rows
// ---------------------------------------------------------------------------

/** A streamed output chunk of a tool call, not a tool call of its own. */
export function isToolOutputRow(entry: WorkPresentationEntry): boolean {
  return entry.sourceActivityKind === "tool.output";
}

/**
 * Folds one tool call's lifecycle rows into the row that renders it.
 *
 * Two realities from the protocol captures make this necessary, and both are
 * keyed on `toolUseId` (`toolCallId` here), which §5.6 guarantees is stable
 * across every update of one call:
 *
 *  - **Streamed command output arrives as its own rows.** W3 turns
 *    `content.delta {command_output|file_change_output}` into chunked, batched
 *    `tool.output` activities. They are the *inside* of a tool row, not twenty
 *    sibling rows: they are concatenated in arrival order and become the owning
 *    row's expanded output, and they are removed from the group.
 *  - **A `fileChange` approval carries no diff** (Codex): only the id of the
 *    `item.started` that preceded it. A row that says "Apply patch?" and
 *    nothing else is unanswerable, so a row borrows `command`, `detail` and
 *    `changedFiles` from a sibling of the same call that has them.
 *
 * Three properties keep this from being a re-derivation of thread state:
 *
 *  - it is scoped to the rows already in one group, never to the thread;
 *  - it is keyed on the id, never on a label match;
 *  - it only ever **adds** to a row, except for the streamed output, which is
 *    the fuller truth and therefore wins over a slimmed summary. An orphan
 *    output chunk — one whose owner is not in this group — is kept as its own
 *    row rather than silently dropped. The returned entry is the same reference
 *    when nothing was filled, so a settled group's row memos are untouched.
 */
export function joinLifecycleDetails<T extends WorkPresentationEntry>(entries: readonly T[]): T[] {
  const owners = new Set<string>();
  const outputs = new Map<string, string[]>();
  const borrowed = new Map<
    string,
    { command?: string; detail?: string; changedFiles?: readonly string[] }
  >();

  for (const entry of entries) {
    const callId = entry.toolCallId;
    if (callId === undefined) continue;
    if (isToolOutputRow(entry)) {
      // NOT `nonEmpty`: trimming a streamed chunk would eat the newlines that
      // separate it from the next one, and a command's output is its whitespace.
      const chunk = entry.detail;
      if (chunk !== undefined && chunk.length > 0) {
        const chunks = outputs.get(callId);
        if (chunks) chunks.push(chunk);
        else outputs.set(callId, [chunk]);
      }
      continue;
    }
    owners.add(callId);
    const slot = borrowed.get(callId) ?? {};
    if (slot.command === undefined && nonEmpty(entry.command) !== null) slot.command = entry.command;
    if (slot.detail === undefined && nonEmpty(entry.detail) !== null) slot.detail = entry.detail;
    if (slot.changedFiles === undefined && (entry.changedFiles?.length ?? 0) > 0) {
      slot.changedFiles = entry.changedFiles;
    }
    borrowed.set(callId, slot);
  }

  if (borrowed.size === 0 && outputs.size === 0) return [...entries];

  // The streamed output lands on the LAST row that owns the call — the terminal
  // one — so it is printed once, and so it survives
  // `omitSupersededLifecycleMarkers` dropping the unkeyed start frame.
  const outputRow = new Map<string, number>();
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index] as T;
    const callId = entry.toolCallId;
    if (callId === undefined || isToolOutputRow(entry)) continue;
    if (outputs.has(callId)) outputRow.set(callId, index);
  }

  const result: T[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index] as T;
    const callId = entry.toolCallId;
    if (callId === undefined) {
      result.push(entry);
      continue;
    }
    if (isToolOutputRow(entry)) {
      // Kept only when nothing in this group owns it, so nothing is lost.
      if (!owners.has(callId)) result.push(entry);
      continue;
    }
    const slot = borrowed.get(callId);
    const patch: Partial<WorkPresentationEntry> = {};
    if (slot !== undefined) {
      if (nonEmpty(entry.command) === null && slot.command !== undefined) patch.command = slot.command;
      if (nonEmpty(entry.detail) === null && slot.detail !== undefined) patch.detail = slot.detail;
      if ((entry.changedFiles?.length ?? 0) === 0 && slot.changedFiles !== undefined) {
        patch.changedFiles = slot.changedFiles;
      }
    }
    if (outputRow.get(callId) === index) {
      patch.detail = (outputs.get(callId) ?? []).join("");
    }
    result.push(Object.keys(patch).length === 0 ? entry : { ...entry, ...patch });
  }
  return result;
}
