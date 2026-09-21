/**
 * Agent chat — the activity presentation resolver (spec §7.2, §7.3).
 *
 * Ported from T3 Code (MIT):
 * `packages/client-runtime/src/work-log/presentation.ts` and the label/icon
 * helpers of `apps/web/src/components/chat/MessagesTimeline.logic.ts`.
 *
 * **One normalised record, not a component taxonomy.** Icon, label and status
 * chrome are all functions of the {@link WorkLogEntry} fields §5.6's slimming
 * allow-list guarantees survive; nothing branches on the provider, and adding
 * a tool never adds a component.
 *
 * *differs from T3:* T3's `resolveT3McpToolPresentation` is a hard-coded table
 * of its own MCP tools (`link_pull_request`, `preview_click`, `device_open`…)
 * with the `pull-request` / `browser` / `device` action buckets that exist only
 * to serve them. Orquester has no such first-party MCP server, so that table
 * and those three buckets are dropped; everything derived from them degrades to
 * the generic tool path.
 *
 * No React import. Tested by `presentation.logic.test.ts`.
 */

import { isToolLifecycleItemType } from "@orquester/api/agent-chat";

import type { ToolGroupSummaryKind, WorkLogEntry } from "./contracts";

// ---------------------------------------------------------------------------
// Buckets
// ---------------------------------------------------------------------------

/**
 * The bucket a row counts under in a group summary. Wider than
 * {@link ToolGroupSummaryKind} — `code-search` and `update` are counted
 * separately but collapse into the row-level kind (see
 * {@link toolGroupSummaryKind}), because F's `AgentChatTimelineRow` fixes that
 * field to five values.
 */
export type ToolGroupAction =
  | "read"
  | "edit"
  | "command"
  | "search"
  | "code-search"
  | "other"
  | "update";

/** Every icon this resolver can ask for. Lucide names; components map them. */
export type WorkEntryIconName =
  | "eye"
  | "square-pen"
  | "terminal"
  | "globe"
  | "search"
  | "wrench"
  | "hammer"
  | "bot"
  | "brain"
  | "check"
  | "zap"
  | "circle-alert"
  | "message-circle";

/** `"Read file complete"` and `"Read file"` are the same tool. *T3: `presentation.ts:68-70`.* */
export function normalizeCompactToolLabel(value: string): string {
  return value.replace(/\s+(?:complete|completed)\s*$/i, "").trim();
}

/** *T3: `presentation.ts:363-368`.* */
export function workLogEntryIsToolLike(entry: WorkLogEntry): boolean {
  if (entry.tone === "tool" || entry.tone === "thinking" || entry.tone === "error") {
    return true;
  }
  if (entry.command !== undefined && entry.command.trim().length > 0) {
    return true;
  }
  if (entry.requestKind !== undefined) {
    return true;
  }
  return entry.itemType !== undefined && isToolLifecycleItemType(entry.itemType);
}

/**
 * Some providers report completion even when the output describes a failure.
 *
 * *T3: `presentation.ts:396-416`.*
 */
function toolDetailTextLooksLikeFailure(text: string): boolean {
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

function toolFailureFromOutput(entry: WorkLogEntry, includeCommand: boolean): boolean {
  if (
    entry.tone === "error" ||
    entry.toolLifecycleStatus === "failed" ||
    entry.toolLifecycleStatus === "declined"
  ) {
    return true;
  }
  if (!workLogEntryIsToolLike(entry)) {
    return false;
  }
  const output = includeCommand
    ? [entry.detail, entry.command].filter(Boolean).join("\n")
    : (entry.detail ?? "");
  return output.length > 0 && toolDetailTextLooksLikeFailure(output);
}

/** Includes rows that stored error output in the command field. *T3: `:437-439`.* */
export function workEntryIndicatesToolFailure(entry: WorkLogEntry): boolean {
  return toolFailureFromOutput(entry, true);
}

/** Checks rendered output without treating the user's command as an error. *T3: `:441-443`.* */
export function workEntryDisplayIndicatesToolFailure(entry: WorkLogEntry): boolean {
  return toolFailureFromOutput(entry, false);
}

/** *T3: `presentation.ts:446-453`.* */
export function workEntryIndicatesToolSuccess(entry: WorkLogEntry): boolean {
  return (
    workLogEntryIsToolLike(entry) &&
    !workEntryIndicatesToolFailure(entry) &&
    entry.tone !== "thinking" &&
    entry.toolLifecycleStatus !== "inProgress"
  );
}

/**
 * Tool-like row with neither clear success nor failure. Such rows are hidden
 * from a collapsed group; a spawn row never is, because mid-run it derives
 * from `task.progress` (tone `thinking`) and the neutral filter would swallow
 * it exactly when it matters most.
 *
 * *T3: `session-logic.ts:172-190`.*
 */
export function workEntryIndicatesToolNeutralStatus(entry: WorkLogEntry): boolean {
  if (entry.agentSpawn !== undefined) {
    return false;
  }
  if (!workLogEntryIsToolLike(entry)) {
    return false;
  }
  if (workEntryIndicatesToolFailure(entry)) {
    return false;
  }
  if (workEntryIndicatesToolSuccess(entry)) {
    return false;
  }
  return true;
}

/**
 * **Failure styling is reserved for severe failures** (§7.3). A non-zero
 * command exit gets a muted failure mark; only a `runtime.error` or a
 * `*.failed` lifecycle event — the turn or a core side effect broke — gets the
 * destructive treatment.
 *
 * *T3: `session-logic.ts:161-170`.*
 */
export function workEntrySignalsSevereFailure(entry: WorkLogEntry): boolean {
  return (
    entry.sourceActivityKind === "runtime.error" ||
    entry.sourceActivityKind?.endsWith(".failed") === true
  );
}

/** `runtime.warning` gets its own icon and colour, distinct from both (§7.3). */
export function workEntryIsWarning(entry: WorkLogEntry): boolean {
  return entry.sourceActivityKind === "runtime.warning";
}

/** The three-way severity the row chrome branches on (§7.3). */
export type WorkEntrySeverity = "none" | "warning" | "failure" | "severe";

export function workEntrySeverity(entry: WorkLogEntry): WorkEntrySeverity {
  if (workEntrySignalsSevereFailure(entry)) {
    return "severe";
  }
  if (workEntryIsWarning(entry)) {
    return "warning";
  }
  return workEntryIndicatesToolFailure(entry) ? "failure" : "none";
}

/**
 * A tool result that is a CLI-side denial reads as a denial even though no
 * `request.*` event exists for it — Claude Code gates some calls itself and
 * answers with a `<tool_use_error>` nobody authorised (SEAMS §2).
 */
export function workEntryIsProviderDenial(entry: WorkLogEntry): boolean {
  if (entry.toolLifecycleStatus === "declined") {
    return true;
  }
  const detail = entry.detail ?? "";
  return /<tool_use_error>/i.test(detail) || /\bpermission (?:denied|to use)\b/i.test(detail);
}

// ---------------------------------------------------------------------------
// Grouping buckets (§7.3 `summarizeToolGroup`)
// ---------------------------------------------------------------------------

function isLocalCodeSearch(entry: WorkLogEntry): boolean {
  return (
    entry.itemType === "web_search" &&
    /\bgrep\b/i.test(normalizeCompactToolLabel(entry.toolTitle ?? entry.label))
  );
}

/**
 * Approvals are **not** hoisted out of a group: an approval request and its
 * resolution are ordinary informational activities that fold into the
 * `"update"` summary bucket (§7.3).
 *
 * *T3: `presentation.ts:464-498`.*
 */
export function toolGroupAction(entry: WorkLogEntry): ToolGroupAction {
  if (
    entry.sourceActivityKind === "approval.requested" ||
    entry.sourceActivityKind === "approval.resolved" ||
    entry.sourceActivityKind === "provider.approval.respond.failed"
  ) {
    return "update";
  }
  if (
    entry.requestKind === "file-read" ||
    entry.itemType === "image_view" ||
    (entry.itemType === "dynamic_tool_call" && entry.toolTitle?.trim().toLowerCase() === "read file")
  ) {
    return "read";
  }
  if (
    entry.requestKind === "file-change" ||
    entry.itemType === "file_change" ||
    (entry.changedFiles?.length ?? 0) > 0
  ) {
    return "edit";
  }
  if (entry.requestKind === "command" || entry.itemType === "command_execution" || entry.command) {
    return "command";
  }
  if (isLocalCodeSearch(entry)) {
    return "code-search";
  }
  if (entry.itemType === "web_search") {
    return "search";
  }
  return workLogEntryIsToolLike(entry) ? "other" : "update";
}

/** Edits count **distinct files**, everything else counts rows. *T3: `:546-562`.* */
function toolGroupActionCount(action: ToolGroupAction, entries: readonly WorkLogEntry[]): number {
  if (action !== "edit") {
    return entries.length;
  }
  const changedFiles = new Set<string>();
  let editsWithoutFileDetails = 0;
  for (const entry of entries) {
    if (!entry.changedFiles || entry.changedFiles.length === 0) {
      editsWithoutFileDetails += 1;
      continue;
    }
    for (const file of entry.changedFiles) {
      changedFiles.add(file);
    }
  }
  return changedFiles.size + editsWithoutFileDetails;
}

/** *T3: `:564-590`.* */
function toolGroupActionLabel(action: ToolGroupAction, count: number): string {
  switch (action) {
    case "read":
      return `Read ${count} ${count === 1 ? "file" : "files"}`;
    case "edit":
      return `Changed ${count} ${count === 1 ? "file" : "files"}`;
    case "command":
      return `Ran ${count} ${count === 1 ? "command" : "commands"}`;
    case "search":
      return `Searched the web ${count} ${count === 1 ? "time" : "times"}`;
    case "code-search":
      return `Searched code ${count} ${count === 1 ? "time" : "times"}`;
    case "other":
      return `Used ${count} ${count === 1 ? "tool" : "tools"}`;
    case "update":
      return `Received ${count} ${count === 1 ? "update" : "updates"}`;
  }
}

/**
 * **Drops superseded lifecycle markers before counting** (§7.3): an
 * `item.started` row with no `toolUseId` and no status, whose
 * `{turnId, itemType, normalised label}` identity already has a later terminal
 * row, is not a second tool call. Skipping this step double-counts every tool
 * on providers that emit an unkeyed start frame.
 *
 * *T3: `presentation.ts:637-673`.*
 */
export function omitSupersededLifecycleMarkers<T>(
  entries: readonly T[],
  workEntryFor: (entry: T) => WorkLogEntry
): T[] {
  const laterTerminalIdentities = new Set<string>();
  const reversed: T[] = [];

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    const workEntry = workEntryFor(entry);
    const normalizedLabel = normalizeCompactToolLabel(workEntry.toolTitle ?? workEntry.label);
    const identity = [workEntry.turnId ?? "no-turn", workEntry.itemType ?? "", normalizedLabel].join(
      "\u001f"
    );
    const activityKind = workEntry.sourceActivityKind;
    const isStatuslessIdlessMarker =
      workEntry.toolCallId === undefined &&
      workEntry.toolLifecycleStatus === undefined &&
      (activityKind === "tool.started" || activityKind === "tool.updated");
    if (isStatuslessIdlessMarker && laterTerminalIdentities.has(identity)) {
      continue;
    }

    reversed.push(entry);
    if (
      activityKind === "tool.completed" ||
      (workEntry.toolLifecycleStatus !== undefined &&
        workEntry.toolLifecycleStatus !== "inProgress")
    ) {
      laterTerminalIdentities.add(identity);
    }
  }

  return reversed.reverse();
}

/**
 * `"Read 3 files, ran 2 commands"` — the settled label of a collapsed activity
 * group (§7.3). Buckets by {@link toolGroupAction} and joins with an Oxford
 * comma, after dropping superseded markers.
 *
 * *T3: `presentation.ts:598-635`.*
 */
export function summarizeToolGroup(entries: readonly WorkLogEntry[]): string {
  const summaryEntries = omitSupersededLifecycleMarkers(entries, (entry) => entry);
  const grouped = new Map<ToolGroupAction, WorkLogEntry[]>();
  for (const entry of summaryEntries) {
    const action = toolGroupAction(entry);
    const group = grouped.get(action);
    if (group) {
      group.push(entry);
    } else {
      grouped.set(action, [entry]);
    }
  }
  const labels = [...grouped].map(([action, actionEntries]) =>
    toolGroupActionLabel(action, toolGroupActionCount(action, actionEntries))
  );
  const sentence = labels.map((label, index) =>
    index === 0 ? label : label.charAt(0).toLowerCase() + label.slice(1)
  );
  if (sentence.length < 2) {
    return sentence[0] ?? "";
  }
  if (sentence.length === 2) {
    return sentence.join(" and ");
  }
  return `${sentence.slice(0, -1).join(", ")}, and ${sentence.at(-1)}`;
}

/**
 * The row-level kind, narrowed to F's five values. A group whose rows do not
 * share one action is `"other"`.
 *
 * *differs from T3:* T3 has a `"mixed"` kind plus `dynamic-tool` / `agent-tool`
 * / `tone-tool` fallbacks; `AgentChatTimelineRow["summaryKind"]` fixes the set
 * at five, so those collapse into `"other"`.
 */
export function toolGroupSummaryKind(entries: readonly WorkLogEntry[]): ToolGroupSummaryKind {
  const actions = new Set(entries.map(toolGroupAction));
  if (actions.size !== 1) {
    return "other";
  }
  const action = actions.values().next().value as ToolGroupAction;
  switch (action) {
    case "read":
    case "edit":
    case "command":
    case "search":
      return action;
    case "code-search":
      return "search";
    default:
      return "other";
  }
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

/** First meaningful shell program in a command string, for a live row's label. */
export function commandProgramName(command: string): string | null {
  const trimmed = command.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const head = trimmed.split(/[\n;|&]/, 1)[0]?.trim() ?? "";
  for (const token of head.split(/\s+/)) {
    if (token.length === 0 || token.includes("=")) {
      continue;
    }
    if (token === "sudo" || token === "env" || token === "command" || token === "nice") {
      continue;
    }
    const base = token.split("/").at(-1) ?? token;
    return base.length > 0 ? base : null;
  }
  return null;
}

function capitalize(value: string): string {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

/** Shorten a path for a label: `…/dir/file.ts`. */
export function shortenPath(path: string, workspaceRoot?: string): string {
  let relative = path;
  if (workspaceRoot && path.startsWith(workspaceRoot)) {
    relative = path.slice(workspaceRoot.length).replace(/^[/\\]+/, "");
  }
  const segments = relative.split(/[/\\]/).filter((segment) => segment.length > 0);
  if (segments.length <= 2) {
    return segments.join("/") || relative;
  }
  return `…/${segments.slice(-2).join("/")}`;
}

/** The label a settled single-tool row shows. *T3: `MessagesTimeline.logic.ts:46-53`.* */
export function singleToolCallLabel(entry: WorkLogEntry): string {
  const command = entry.command?.trim();
  if (command) {
    return command;
  }
  return capitalize(normalizeCompactToolLabel(entry.toolTitle || entry.label));
}

/** *T3: `MessagesTimeline.logic.ts:55-70` (`workEntryDisplayLabel`).* */
export function workEntryDisplayLabel(entry: WorkLogEntry, workspaceRoot?: string): string {
  if (entry.command) {
    return entry.command;
  }
  if (entry.detail) {
    return entry.detail;
  }
  const changedFiles = entry.changedFiles ?? [];
  const firstPath = changedFiles[0];
  if (firstPath) {
    const path = shortenPath(firstPath, workspaceRoot);
    return changedFiles.length === 1 ? path : `${path} +${changedFiles.length - 1} more`;
  }
  return capitalize(normalizeCompactToolLabel(entry.toolTitle || entry.label));
}

/** Latest live activity stays present-tense unless the call itself failed. *T3: `:186-190`.* */
export function liveActivityToolStatus(
  status: WorkLogEntry["toolLifecycleStatus"],
  presentTense: boolean
): "inProgress" | "completed" | "failed" | "declined" {
  if (status === "failed" || status === "declined") {
    return status;
  }
  if (presentTense || status === "inProgress") {
    return "inProgress";
  }
  return "completed";
}

/** The live row's label — present tense while running. *T3: `:72-98`.* */
export function liveWorkEntryLabel(
  entry: WorkLogEntry,
  active: boolean,
  workspaceRoot?: string
): string {
  const status = liveActivityToolStatus(entry.toolLifecycleStatus, active);
  const command = entry.command?.trim();
  if (command) {
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
// Icons
// ---------------------------------------------------------------------------

/** *T3: `MessagesTimeline.tsx:3283-3315`, narrowed with the buckets.* */
export function toolGroupSummaryIconName(kind: ToolGroupAction): WorkEntryIconName {
  switch (kind) {
    case "read":
      return "eye";
    case "edit":
      return "square-pen";
    case "command":
      return "terminal";
    case "search":
      return "globe";
    case "code-search":
      return "search";
    case "other":
      return "wrench";
    case "update":
      return "check";
  }
}

function workToneIconName(tone: WorkLogEntry["tone"]): WorkEntryIconName {
  if (tone === "error") {
    return "circle-alert";
  }
  if (tone === "thinking") {
    return "brain";
  }
  if (tone === "info") {
    return "check";
  }
  return "zap";
}

/** The icon fallback chain. *T3: `MessagesTimeline.tsx:4549-4578`.* */
export function workEntryIconName(entry: WorkLogEntry): WorkEntryIconName {
  if (
    entry.questionAnswer ||
    entry.sourceActivityKind === "user-input.requested" ||
    entry.sourceActivityKind === "user-input.resolved"
  ) {
    return "message-circle";
  }
  if (workEntryIsWarning(entry)) {
    return "circle-alert";
  }
  const action = toolGroupAction(entry);
  if (action !== "other") {
    return toolGroupSummaryIconName(action);
  }
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
  if (entry.taskId) {
    return "bot";
  }
  return workToneIconName(entry.tone);
}

/**
 * Everything a row needs to paint itself, resolved from the normalised record
 * in one place. This is the whole "presentation resolver" §7.2 asks for.
 */
export interface WorkEntryPresentation {
  icon: WorkEntryIconName;
  label: string;
  severity: WorkEntrySeverity;
  action: ToolGroupAction;
  isToolLike: boolean;
  isDenial: boolean;
  /** Present tense while the row is the live one. */
  live: boolean;
}

export function resolveWorkEntryPresentation(
  entry: WorkLogEntry,
  options?: { live?: boolean; workspaceRoot?: string }
): WorkEntryPresentation {
  const live = options?.live ?? false;
  return {
    icon: workEntryIconName(entry),
    label: live
      ? liveWorkEntryLabel(entry, true, options?.workspaceRoot)
      : workEntryDisplayLabel(entry, options?.workspaceRoot),
    severity: workEntrySeverity(entry),
    action: toolGroupAction(entry),
    isToolLike: workLogEntryIsToolLike(entry),
    isDenial: workEntryIsProviderDenial(entry),
    live
  };
}

/** Rows hidden from a collapsed group. *T3: `MessagesTimeline.logic.ts:101-113`.* */
export function workEntryIsVisibleInGroup(
  entry: WorkLogEntry,
  expandedToolGroupEntry = false
): boolean {
  return (
    (expandedToolGroupEntry &&
      (entry.toolLifecycleStatus === "inProgress" ||
        entry.sourceActivityKind === "task.progress")) ||
    !workEntryIndicatesToolNeutralStatus(entry)
  );
}
