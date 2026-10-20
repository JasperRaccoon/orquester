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

import { isToolLifecycleItemType, type ToolApprovalReference } from "@orquester/api/agent-chat";

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
  // A call still running is judged when it completes: the heuristic is for a
  // completion whose output tells another story. A running command's row
  // carries its output so far once its chunks are joined into it, and a line
  // that merely prints "No such file or directory" is not the call failing.
  if (entry.toolLifecycleStatus === "inProgress") {
    return false;
  }
  const output = includeCommand
    ? [entry.detail, entry.command].filter(Boolean).join("\n")
    : (entry.detail ?? "");
  return output.length > 0 && toolDetailTextLooksLikeFailure(output);
}

/** Includes rows that stored error output in the command field. *T3: `:437-439`.* */
function workEntryIndicatesToolFailure(entry: WorkLogEntry): boolean {
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
function workEntryIndicatesToolNeutralStatus(entry: WorkLogEntry): boolean {
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
function workEntrySignalsSevereFailure(entry: WorkLogEntry): boolean {
  return (
    entry.sourceActivityKind === "runtime.error" ||
    entry.sourceActivityKind?.endsWith(".failed") === true
  );
}

/** `runtime.warning` gets its own icon and colour, distinct from both (§7.3). */
export function workEntryIsWarning(entry: WorkLogEntry): boolean {
  return entry.sourceActivityKind === "runtime.warning";
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
    entry.sourceActivityKind === "provider.approval.respond.failed" ||
    // An answered question is not a tool call either. Absorbed from W12's
    // copy during the fix wave — the union of the two arms is what T3 has.
    entry.sourceActivityKind === "user-input.requested" ||
    entry.sourceActivityKind === "user-input.resolved"
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
 * A streamed output chunk of a tool call (`tool.output`) — the inside of its
 * call's row, not a call of its own: `joinLifecycleDetails` folds it onto the
 * row that owns the call. The one definition; `row-chrome.ts` re-exports it as
 * `isToolOutputRow`.
 */
export function isStreamedOutputEntry(entry: WorkLogEntry): boolean {
  return entry.sourceActivityKind === "tool.output";
}

/**
 * `entries` as the rows they render: without the streamed chunks
 * `joinLifecycleDetails` folds into another row — each chunk whose call
 * (`toolCallId`) has a non-chunk entry in the same list, and each orphan chunk
 * (its call has none there) after the first of its call, which carries them
 * all. What a run's live row and a group's summary read, while the rows they
 * render still carry every chunk for the join — read with them, a command's
 * output counted as a tool per flush ("Used 548 tools and ran 1 command") and
 * named the live row with its latest line.
 *
 * `entries` itself when it holds no chunk.
 */
export function withoutJoinedOutput<T>(
  entries: readonly T[],
  workEntryFor: (entry: T) => WorkLogEntry
): readonly T[] {
  const calls = new Set<string>();
  let chunks = false;
  for (const entry of entries) {
    const workEntry = workEntryFor(entry);
    if (isStreamedOutputEntry(workEntry)) {
      chunks = true;
    } else if (workEntry.toolCallId !== undefined) {
      calls.add(workEntry.toolCallId);
    }
  }
  if (!chunks) {
    return entries;
  }
  const orphanCalls = new Set<string>();
  return entries.filter((entry) => {
    const workEntry = workEntryFor(entry);
    const callId = workEntry.toolCallId;
    if (!isStreamedOutputEntry(workEntry) || callId === undefined) {
      return true;
    }
    if (calls.has(callId) || orphanCalls.has(callId)) {
      return false;
    }
    orphanCalls.add(callId);
    return true;
  });
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
function commandProgramName(command: string): string | null {
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

/**
 * Readable labels for the Orquester session tools (design 2026-10-14 §1.5;
 * unified MCP 2026-10-15 §4), by bare name — the in-chat `orquester` server's
 * tools, whatever the harness calls them. Every chat tool of the unified
 * catalogue (`TOOLSETS`) has a line (a test reads the names from there), and
 * so does every legacy name an older transcript or an older agent host may
 * still show: the old in-chat tools (`thread_*`, `task_*`, `delegate_task`,
 * `agent_catalog`) and the external names the unified tools replaced. A tool
 * with none still reads "Orquester: <its name in words>", never its raw
 * arguments.
 */
export const SESSION_TOOL_LABELS: Readonly<Record<string, string>> = {
  // --- The unified catalogue (§4, §9.1), by toolset -------------------------
  // core
  list_projects: "Listed projects",
  list_agents: "Listed agents and models",
  list_sessions: "Listed chats",
  get_session: "Checked a chat",
  read_transcript: "Read a chat",
  search_sessions: "Searched chats",
  create_session: "Opened a chat",
  send_message: "Messaged a chat",
  wait_for_session: "Waited for a chat",
  control_session: "Controlled a chat",
  fork_session: "Forked a chat",
  merge_back_session: "Merged back to the parent chat",
  get_usage: "Checked usage",
  // Visual replies (§2.1). A published page shows as its `visual` row; this
  // label is the row while it runs or when it failed.
  html_preview: "Previewed HTML",
  html_render: "Rendered HTML",
  // Secrets (design 2026-10-14 §5).
  request_secret: "Requested a secret",
  // reads
  list_workflows: "Listed workflows",
  get_workflow: "Read a workflow",
  get_workflow_runs: "Checked workflow runs",
  get_agent_profile: "Read the agent config",
  list_saved_prompts: "Listed saved prompts",
  // notes
  list_todos: "Listed to-dos",
  update_todos: "Updated to-dos",
  update_saved_prompts: "Changed saved prompts",
  // chat-extras
  update_session: "Updated a chat",
  respond_to_request: "Answered a chat's request",
  get_turn_diff: "Read a turn's changes",
  read_tool_output: "Read a tool's output",
  list_conversations: "Listed resumable conversations",
  notify_user: "Sent you a notification",
  // files-git
  read_file: "Read a file",
  get_git_state: "Checked git",
  // workflow-authoring
  list_workflow_block_types: "Listed workflow blocks",
  create_workflow: "Created a workflow",
  update_workflow: "Changed a workflow",
  delete_workflow: "Deleted a workflow",
  preview_expression: "Previewed a workflow expression",
  run_workflow: "Ran a workflow",
  cancel_workflow_run: "Cancelled a workflow run",
  list_workflow_secrets: "Listed workflow secrets",
  set_workflow_secret: "Set a workflow secret",
  // agent-profile-editing
  edit_agent_profile: "Changed the agent config",
  // desktops
  get_desktops: "Checked desktops",
  control_desktop: "Controlled a desktop",
  // secret-files
  secret_files_status: "Checked secret files",
  push_secret_files: "Pushed secret files",

  // --- Legacy in-chat names (design 2026-10-14 §5, §6) ----------------------
  // Older builds' toolset request (every chat tool is on now).
  request_toolset: "Asked for more tools",
  thread_list: "Listed this project's chats",
  thread_read: "Read a chat",
  thread_create: "Opened a chat",
  agent_catalog: "Listed agents and models",
  thread_send: "Messaged a chat",
  thread_wait: "Waited for a chat",
  thread_interrupt: "Interrupted a chat",
  thread_fork: "Forked this chat",
  thread_merge_back: "Merged back to the parent chat",
  delegate_task: "Delegated a task",
  task_status: "Checked a task",
  task_wait: "Waited for a task",
  task_cancel: "Cancelled a task",

  // --- Legacy external names the unified tools replaced (§4 "Replaces") -----
  get_session_lineage: "Checked a chat's lineage",
  interrupt_session: "Interrupted a chat",
  stop_task: "Stopped a task",
  stop_session: "Stopped a chat",
  close_session: "Closed a chat",
  revert_session: "Rewound a chat",
  compact_session: "Compacted a chat",
  implement_plan: "Implemented a plan",
  resolve_merge_back: "Resolved a merge back",
  answer_question: "Answered a question",
  dismiss_question: "Dismissed a question",
  resolve_approval: "Decided an approval",
  get_cost: "Checked costs",
  list_files: "Listed files",
  create_todo: "Created a to-do",
  update_todo: "Updated a to-do",
  delete_todo: "Deleted a to-do",
  toggle_todo_item: "Ticked a to-do item",
  validate_workflow: "Validated a workflow",
  list_workflow_runs: "Listed workflow runs",
  get_workflow_run: "Read a workflow run",
  list_agent_profiles: "Listed agent configs",
  get_agent_profile_item: "Read an agent-config item",
  get_agent_instructions: "Read an agent's instructions",
  list_marketplace_plugins: "Listed marketplace plugins",
  // The agent-profile write tools `edit_agent_profile` replaced.
  create_agent_profile_item: "Added an agent-config item",
  update_agent_profile_item: "Changed an agent-config item",
  delete_agent_profile_item: "Removed an agent-config item",
  copy_agent_profile_item: "Copied an agent-config item",
  set_agent_profile_item_enabled: "Turned an agent-config item on or off",
  trust_agent_profile_hook: "Trusted an agent-config hook",
  write_agent_instructions: "Wrote an agent's instructions",
  import_agent_profile_items: "Imported agent-config items",
  desktops_list: "Listed desktops",
  desktop_host_status: "Checked the desktop host",
  desktop_windows: "Listed desktop windows",
  desktop_app_log: "Read a desktop app's log",
  desktop_open: "Opened a desktop",
  desktop_launch_app: "Launched a desktop app",
  desktop_window_action: "Closed a desktop window",
  desktop_stop_app: "Stopped a desktop app",
  desktop_close: "Closed a desktop"
};

/**
 * How an approval-gated call ended, as its row says it (unified MCP §7.1
 * "After"): "Denied: <reason>" when the reference carries the user's words
 * (one line), else "Denied by you"; a grant names its reach when known.
 */
export function toolApprovalOutcomeText(reference: Pick<ToolApprovalReference, "kind" | "outcome" | "reason" | "grantScope">): string {
  switch (reference.outcome) {
    case "approved":
      return reference.kind === "toolset" ? "Enabled by you" : "Approved by you";
    case "granted":
      return reference.grantScope === "chat"
        ? "Allowed by a chat grant"
        : reference.grantScope === "project"
          ? "Allowed by a project grant"
          : "Allowed by a grant";
    case "denied": {
      const reason = reference.reason?.replace(/\s+/g, " ").trim();
      return reason ? `Denied: ${reason}` : "Denied by you";
    }
    case "timed_out":
      return "Expired";
    case "cancelled":
      return "Cancelled";
    case "not_delivered":
      return "Approved, but the result never reached the agent";
  }
}

const SECRET_OUTCOME_WORDS = {
  provided: "provided",
  declined: "declined",
  cancelled: "cancelled",
  timed_out: "no answer"
} as const;

/** `thread_wait` → `Thread wait`. */
function humanizeToolName(name: string): string {
  const words = name.replace(/_+/g, " ").trim();
  return words.length > 0 ? capitalize(words) : name;
}

/** The label of a session tool's row. */
export function sessionToolLabel(name: string): string {
  return SESSION_TOOL_LABELS[name] ?? `Orquester: ${humanizeToolName(name)}`;
}

/**
 * A session tool row's label: its tool's, and for `request_secret` the
 * secret's name and how the request ended (never the value, which the row
 * does not hold); for a call an approval card gated, how the card ended.
 */
export function sessionToolEntryLabel(entry: WorkLogEntry & { sessionTool: string }): string {
  const secret = entry.secretRequest;
  if (secret !== undefined) {
    return `Requested a secret: ${secret.name} · ${SECRET_OUTCOME_WORDS[secret.outcome]}`;
  }
  // A call that went through an Orquester card or a grant (unified MCP §7.1):
  // its tool's label, then how the card ended.
  const approval = entry.toolApproval;
  if (approval !== undefined) {
    return `${sessionToolLabel(entry.sessionTool)} · ${toolApprovalOutcomeText(approval)}`;
  }
  return sessionToolLabel(entry.sessionTool);
}

/** The label a settled single-tool row shows. *T3: `MessagesTimeline.logic.ts:46-53`.* */
export function singleToolCallLabel(entry: WorkLogEntry): string {
  if (entry.sessionTool !== undefined) {
    return sessionToolEntryLabel({ ...entry, sessionTool: entry.sessionTool });
  }
  const command = entry.command?.trim();
  if (command) {
    return command;
  }
  return capitalize(normalizeCompactToolLabel(entry.toolTitle || entry.label));
}

/**
 * *T3: `MessagesTimeline.logic.ts:55-70` (`workEntryDisplayLabel`); differs: a
 * streamed chunk's detail is its call's output, never its name — its row is
 * headed like its call's (its command, else its title), else by its own
 * summary, "Tool output".*
 */
export function workEntryDisplayLabel(entry: WorkLogEntry, workspaceRoot?: string): string {
  // A session tool's detail is its raw arguments (Claude's `tool: {…}`): its
  // own label reads better (design 2026-10-14 §1.5).
  if (entry.sessionTool !== undefined) {
    return sessionToolEntryLabel({ ...entry, sessionTool: entry.sessionTool });
  }
  if (entry.command) {
    return entry.command;
  }
  if (entry.detail && !isStreamedOutputEntry(entry)) {
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
function liveActivityToolStatus(
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
 * A row that reads as *still happening* in the active run — what the activity
 * group picks its live row with.
 *
 * *T3: `MessagesTimeline.logic.ts:614-621`. It lives here rather than in
 * `rows.logic.ts` so the timeline components import it from the one
 * presentation resolver (fix-wave R7-6).*
 */
export function workEntryIsActiveTurnActivity(entry: WorkLogEntry): boolean {
  return (
    entry.toolLifecycleStatus === "inProgress" ||
    (entry.toolLifecycleStatus === undefined &&
      (entry.sourceActivityKind === "task.progress" || workLogEntryIsToolLike(entry)))
  );
}

/**
 * The destructive (red) row treatment, as distinct from the muted failure
 * mark: a failure that is either **severe** or not tool-like at all. A
 * non-zero command exit is a failure but never destructive (§7.3).
 *
 * *T3: `MessagesTimeline.tsx:4837-4847`. Absorbed from W12's copy during the
 * fix wave so there is one definition (R7-6).*
 */
export function showDestructiveRowStyle(entry: WorkLogEntry): boolean {
  if (!workEntryIndicatesToolFailure(entry)) {
    return false;
  }
  return workEntrySignalsSevereFailure(entry) || !workLogEntryIsToolLike(entry);
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
