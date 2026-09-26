/**
 * Render checks for the subagent drill-in over a SEEDED thread store (§7.6).
 *
 * `roster-render.check.ts` renders the drill-in over an EMPTY store and hands
 * it its rows, which is exactly the path that never met the store's own rows:
 * a second projection inside the timeline rendered ITS rows whenever it had
 * any, and threw the drill-in's away. Here the thread's items and roster come
 * through the store the way a snapshot delivers them — wire-slimmed, on the
 * parent's turn — and the drill-in renders what it projects itself.
 *
 * Static markup only — no DOM, no effects — like every other `*.check.ts`:
 * the store opens its stream on a microtask, so the fake transport hands the
 * test the frame handler and the snapshot is pushed through it before the
 * render.
 */

import assert from "node:assert/strict";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  slimActivityPayload,
  type AgentChatStreamFrame,
  type RuntimeSubagent,
  type ThreadActivityItem,
  type ThreadItem,
  type ThreadSnapshotPayload
} from "@orquester/api/agent-chat";

import { OrquesterProvider, type OrquesterProviderProps } from "../../../context/orquester-context";
import { ensureThreadStore, resetThreadStores } from "../../../lib/agent-chat/store";
import type { AgentChatTransport } from "../../../lib/agent-chat/transport";
import { head, snapshot } from "../../../lib/agent-chat/test-helpers";
import type { AgentDrillInProps } from "../contracts";
import { AgentDrillIn } from "./AgentDrillIn";

/**
 * A tool row's output pane restores its scroll offset in a layout effect,
 * which the static renderer warns about because it cannot encode it for
 * hydration. Nothing here hydrates, so that one warning is noise — filtered by
 * its exact text so every other console error still surfaces.
 */
const consoleError = console.error.bind(console);
console.error = (...args: unknown[]) => {
  if (typeof args[0] === "string" && args[0].includes("useLayoutEffect does nothing on the server")) {
    return;
  }
  consoleError(...args);
};

// ---------------------------------------------------------------------------
// A store per session, fed through a fake stream
// ---------------------------------------------------------------------------

const frameHandlers = new Map<string, (frame: AgentChatStreamFrame) => void>();
const unused = async (): Promise<never> => {
  throw new Error("unused");
};
const transport: AgentChatTransport = {
  stream(sessionId, _options, handlers) {
    frameHandlers.set(sessionId, handlers.onFrame);
    return { lastSeq: 0, hostInstanceId: null, resetCursor: () => {}, close: () => {} };
  },
  command: unused,
  switchAccount: unused,
  read: unused,
  readItem: unused,
  readHistory: unused,
  search: unused,
  turnDiff: unused,
  async providers() {
    return { providers: [], hostInstanceId: "h1" };
  },
  refreshProvider: unused,
  upload: unused,
  async fetchAttachment() {
    return new ArrayBuffer(0);
  }
};

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

let sessions = 0;

/** A fresh thread whose store holds `thread`, as a snapshot frame delivers it. */
async function seededThread(thread: Partial<ThreadSnapshotPayload>): Promise<string> {
  sessions += 1;
  const sessionId = `drill-${sessions}`;
  ensureThreadStore(sessionId, { transport });
  await flush();
  const push = frameHandlers.get(sessionId);
  assert.ok(push, "the store opened its stream");
  push({ kind: "snapshot", thread: snapshot({ head: head({ id: sessionId }), seq: 1, ...thread }) });
  return sessionId;
}

function render(props: AgentDrillInProps): string {
  const context = { useTitlebar: false, api: { agentChat: transport } } as unknown as OrquesterProviderProps;
  return renderToStaticMarkup(
    createElement(OrquesterProvider, { ...context, children: createElement(AgentDrillIn, props) as ReactElement })
  );
}

const NOOP = (): void => {};

function rosterRow(id: string, overrides: Partial<RuntimeSubagent> = {}): RuntimeSubagent {
  return {
    id,
    kind: "subagent",
    agentKind: "agent",
    title: id,
    role: null,
    model: null,
    effort: null,
    status: "running",
    activationCount: 1,
    usage: null,
    progress: null,
    lastToolName: null,
    result: null,
    error: null,
    outputFile: null,
    exitCode: null,
    isBackgrounded: null,
    parentAgentId: null,
    agentIndex: null,
    phaseIndex: null,
    phaseTitle: null,
    attempt: null,
    workflowName: null,
    phases: [],
    runHandles: null,
    recentActivity: [],
    firstSeenAt: "2026-09-21T10:00:00.000Z",
    startedAt: "2026-09-21T10:00:00.000Z",
    completedAt: null,
    updatedAt: "2026-09-21T10:00:00.000Z",
    ...overrides
  };
}

let itemSeq = 0;

/** An activity as a snapshot delivers it: its payload through the wire slimmer (§5.6). */
function wireActivity(
  activityKind: string,
  payload: Record<string, unknown>,
  overrides: Partial<ThreadActivityItem> = {}
): ThreadActivityItem {
  itemSeq += 1;
  const createdAt = new Date(Date.UTC(2026, 8, 21, 10, 0, itemSeq)).toISOString();
  return {
    kind: "activity",
    id: `w${itemSeq}`,
    tone: "tool",
    activityKind,
    summary: activityKind,
    payload: slimActivityPayload(payload),
    turnId: "turn-1",
    createdAt,
    updatedAt: createdAt,
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// A background shell: its drill-in is ONE row, the shell's own (§7.6)
// ---------------------------------------------------------------------------

const SHELL = "task-bg-1";
const SHELL_CALL = `bgshell:${SHELL}`;
const shellData = (extra: Record<string, unknown> = {}) => ({
  toolName: "Bash",
  input: { command: "pnpm test --watch", description: "run the suite" },
  background: true,
  ...extra
});
const shellStart = wireActivity(
  "tool.started",
  {
    toolUseId: SHELL_CALL,
    itemType: "command_execution",
    title: "Background shell",
    detail: "pnpm test --watch",
    status: "running",
    data: shellData()
  },
  { agentId: SHELL, id: "shell-start" }
);
const shellChunk = wireActivity(
  "tool.output",
  { toolUseId: SHELL_CALL, streamKind: "command_output", delta: "PASS src/a.test.ts\n" },
  { agentId: SHELL, id: "shell-chunk" }
);
const shellEnd = wireActivity(
  "tool.completed",
  {
    toolUseId: SHELL_CALL,
    itemType: "command_execution",
    title: "Background shell",
    detail: "pnpm test --watch",
    status: "completed",
    data: shellData({ exitCode: 0 })
  },
  { agentId: SHELL, id: "shell-end" }
);

async function shellDrillIn(items: ThreadItem[], shell: RuntimeSubagent): Promise<string> {
  const sessionId = await seededThread({ items, roster: [shell] });
  return render({ sessionId, agentId: SHELL, roster: [shell], bottomInset: 0, onBack: NOOP });
}

const liveShell = rosterRow(SHELL, { agentKind: "background", title: "run the suite" });

const printing = await shellDrillIn([shellStart, shellChunk], liveShell);
assert.ok(
  printing.includes(`data-timeline-row-id="background-shell:${SHELL}"`),
  `the drill-in renders the shell's own row, not a second projection's: ${printing}`
);
assert.ok(!printing.includes('data-timeline-row-kind="turn-fold"'), "and no turn fold: a shell is one command, not a turn");
assert.ok(printing.includes("pnpm test --watch"), "the command block names the command");
assert.ok(printing.includes('data-shell-output="true"'), "the output is the shell pane, which follows the stream");
assert.ok(printing.includes("PASS src/a.test.ts"), "and shows what it printed without a click");

const quiet = await shellDrillIn([shellStart], liveShell);
assert.ok(quiet.includes(`data-timeline-row-id="background-shell:${SHELL}"`), "a quiet running shell is its row");
assert.ok(!quiet.includes('data-timeline-row-kind="turn-fold"'), "never a lone 'Worked for' fold");
assert.ok(quiet.includes("pnpm test --watch"));

const exited = await shellDrillIn(
  [shellStart, shellChunk, shellEnd],
  rosterRow(SHELL, { agentKind: "background", title: "run the suite", status: "completed", exitCode: 0 })
);
assert.ok(exited.includes('data-shell-output="true"'), "an exited shell's output is on screen");
assert.ok(exited.includes("PASS src/a.test.ts"), "without a click: the rendered row is the one seeded open");
assert.ok(!exited.includes('data-timeline-row-kind="turn-fold"'));

// ---------------------------------------------------------------------------
// A live agent reads live: its running call, its working row
// ---------------------------------------------------------------------------

const AGENT = "agent-1";
const runningCall = wireActivity(
  "tool.started",
  { toolUseId: "call-1", itemType: "command_execution", title: "npm test", command: "npm test", status: "inProgress" },
  { agentId: AGENT, id: "agent-call" }
);

const liveAgent = rosterRow(AGENT, { title: "Run the suite", startedAt: "2026-09-21T10:00:00.000Z" });
const liveSession = await seededThread({ items: [runningCall], roster: [liveAgent] });
const live = render({ sessionId: liveSession, agentId: AGENT, roster: [liveAgent], bottomInset: 0, onBack: NOOP });
assert.ok(live.includes('data-timeline-row-kind="work-live"'), `the running call is a live row: ${live}`);
assert.ok(live.includes("Running npm"), "in the present tense, as the thread's running call reads");
assert.ok(live.includes('data-timeline-row-kind="working"'), "and the run is headed by the working row");
assert.ok(!live.includes('data-timeline-row-kind="turn-fold"'), "its run never folds while it works");

const settledAgent = rosterRow(AGENT, { title: "Run the suite", status: "completed" });
const settledSession = await seededThread({ items: [runningCall], roster: [settledAgent] });
const settled = render({ sessionId: settledSession, agentId: AGENT, roster: [settledAgent], bottomInset: 0, onBack: NOOP });
assert.ok(!settled.includes('data-timeline-row-kind="working"'), "a settled agent is not working");
assert.ok(!settled.includes('data-timeline-row-kind="work-live"'));

// ---------------------------------------------------------------------------
// A nested agent: the outer agent's drill-in lists it as a spawn row
// ---------------------------------------------------------------------------

// Claude stamps a launched task with its OWNER: the inner agent's start is the
// outer agent's row, so it is the outer drill-in's spawn row.
const innerLaunch = wireActivity(
  "task.started",
  { taskId: "agent-inner", agentKind: "agent", taskType: "subagent", toolUseId: "call-spawn", title: "Read the tests" },
  { agentId: AGENT, id: "inner-launch", tone: "info" }
);
const outer = rosterRow(AGENT, { title: "Run the suite", status: "completed" });
const inner = rosterRow("agent-inner", { title: "Read the tests", status: "completed" });
const nestedSession = await seededThread({ items: [innerLaunch], roster: [outer, inner] });
const nested = render({ sessionId: nestedSession, agentId: AGENT, roster: [outer, inner], bottomInset: 0, onBack: NOOP });
assert.ok(nested.includes("Ran 1 subagent"), `the settled batch is a spawn row: ${nested}`);
assert.ok(nested.includes("✓ completed"));

// ---------------------------------------------------------------------------
// The thread's error banner stays on screen over a child (S4)
// ---------------------------------------------------------------------------

// The overlay stays live over the drill-in, and its commands — approve,
// answer, Stop, compact — report failure only through this banner.
const failing = render({
  sessionId: liveSession,
  agentId: AGENT,
  roster: [liveAgent],
  bottomInset: 0,
  onBack: NOOP,
  errorBanner: "boom: the approval could not be sent",
  onDismissErrorBanner: NOOP
});
assert.ok(failing.includes("boom: the approval could not be sent"), `a failed command says so over a child: ${failing}`);
assert.ok(failing.includes('aria-label="Dismiss"'), "and the banner can be dismissed there");
assert.ok(!live.includes('aria-label="Dismiss"'), "no banner without an error");

// ---------------------------------------------------------------------------
// Its prompt at the top (§7.6): the launch's `payload.prompt`, the first row
// ---------------------------------------------------------------------------

const PROMPTED = "agent-prompted";
/** A Claude launch: the PARENT's row, found by its task id — before any row of the agent's. */
const LAUNCHED_AT = "2026-09-21T09:59:00.000Z";
const promptedLaunch = (extra: Record<string, unknown>, id: string) =>
  wireActivity(
    "task.started",
    { taskId: PROMPTED, agentKind: "agent", taskType: "subagent", toolUseId: `launch-${id}`, title: "Find callers", ...extra },
    { id, tone: "info", createdAt: LAUNCHED_AT, updatedAt: LAUNCHED_AT }
  );
const promptedAgent = rosterRow(PROMPTED, {
  title: "Find callers",
  status: "completed",
  result: "Found three callers of parse() in src/lib and one more in the test suite, which it mocks."
});
const answer = wireActivity(
  "tool.completed",
  { toolUseId: "grep-1", itemType: "command_execution", title: "grep", command: "grep -rn parse src", status: "completed" },
  { agentId: PROMPTED, id: "grep-1" }
);

async function promptedDrillIn(items: ThreadItem[]): Promise<string> {
  const sessionId = await seededThread({ items, roster: [promptedAgent] });
  return render({ sessionId, agentId: PROMPTED, roster: [promptedAgent], bottomInset: 0, onBack: NOOP });
}

const prompted = await promptedDrillIn([
  promptedLaunch({ prompt: "Find every caller of parse() and say which ones pass a buffer." }, "launch-a"),
  answer
]);
const firstRowId = /data-timeline-row-id="([^"]+)"/.exec(prompted)?.[1];
assert.equal(firstRowId, "agent-prompt:launch-a", `the prompt is the first row of the scroll: ${prompted}`);
assert.ok(prompted.includes('data-agent-prompt="true"'), "rendered as the agent's prompt");
assert.ok(prompted.includes("Find every caller of parse() and say which ones pass a buffer."));
assert.ok(prompted.includes("rounded-2xl bg-neutral-800"), "in the user's bubble: to the agent it is its user turn");
assert.ok(!prompted.includes("Rewind to here"), "read-only: a child rolls back nothing");

// The line under the breadcrumb: one line, whatever it says, so nothing below it moves.
const block = /<div class="shrink-0 border-b[^>]*><div[^>]*><p class="([^"]*)"( title="([^"]*)")?/.exec(prompted);
assert.ok(block, "the activity line renders");
assert.ok(block[1]!.split(" ").includes("truncate"), `one line, truncated: ${block[1]}`);
assert.equal(block[3], promptedAgent.result, "the whole line is its tooltip");
assert.ok(!block[1]!.includes("whitespace-pre-wrap"), "never a block that wraps and shifts the rows");

const longPrompt = `${"Trace every call site of parse(), then read each caller's tests. ".repeat(20)}`;
const long = await promptedDrillIn([promptedLaunch({ prompt: longPrompt }, "launch-long")]);
assert.ok(long.includes("Show full prompt"), "a long prompt collapses past a few lines");

const wireCut = await promptedDrillIn([
  promptedLaunch({ prompt: `${"x".repeat(20_000)}` }, "launch-wire")
]);
assert.ok(wireCut.includes("Load the full prompt"), "a prompt the wire cut reads whole with the item read");
assert.ok(!wireCut.includes("Copy prompt"), "and hands over no cut text as if it were whole");
assert.ok(prompted.includes("Copy prompt"), "a whole prompt copies");

const restCut = await promptedDrillIn([
  promptedLaunch({ prompt: "The start of a very long prompt", promptTruncated: true }, "launch-rest")
]);
assert.ok(restCut.includes("Only the start of this prompt was kept."), "a prompt cut at rest says so");

const unprompted = await promptedDrillIn([promptedLaunch({}, "launch-none"), answer]);
assert.ok(!unprompted.includes('data-agent-prompt="true"'), "no prompt on the launch, no prompt row");

// ---------------------------------------------------------------------------
// An agent whose rows left the window says so (S7)
// ---------------------------------------------------------------------------

const EVICTED = "agent-evicted";
const LEFT = "Its earlier rows have left this thread&#x27;s window.";
const NOTHING_YET = "This agent has not reported anything yet.";
const evicted = rosterRow(EVICTED, {
  title: "Survey the fleet",
  status: "completed",
  result: "Surveyed 40 packages.",
  usage: { totalTokens: 48_000 }
});
const evictedSession = await seededThread({ items: [], roster: [evicted] });
const gone = render({ sessionId: evictedSession, agentId: EVICTED, roster: [evicted], bottomInset: 0, onBack: NOOP });
assert.ok(gone.includes(LEFT), `a settled agent that did work, with no row left, says where they went: ${gone}`);
assert.ok(!gone.includes(NOTHING_YET), "never that it reported nothing");

// Its launch prompt survives retention as an anchor: the notice sits under it.
const promptOnly = await seededThread({
  items: [
    wireActivity(
      "task.started",
      { taskId: EVICTED, agentKind: "agent", taskType: "subagent", toolUseId: "launch-e", prompt: "Survey the fleet." },
      { id: "launch-e", tone: "info", createdAt: LAUNCHED_AT, updatedAt: LAUNCHED_AT }
    )
  ],
  roster: [evicted]
});
const underPrompt = render({ sessionId: promptOnly, agentId: EVICTED, roster: [evicted], bottomInset: 0, onBack: NOOP });
assert.ok(underPrompt.includes(LEFT), "a prompt alone is not the agent's work: the notice still shows");
assert.ok(underPrompt.indexOf("Survey the fleet.") < underPrompt.indexOf(LEFT), "under the prompt");

// A live agent that did work and lost its rows: the notice, then the live rows.
const liveEvicted = rosterRow(EVICTED, { title: "Survey the fleet", usage: { totalTokens: 9_000 } });
const liveEvictedSession = await seededThread({ items: [], roster: [liveEvicted] });
const stillWorking = render({ sessionId: liveEvictedSession, agentId: EVICTED, roster: [liveEvicted], bottomInset: 0, onBack: NOOP });
assert.ok(stillWorking.includes(LEFT), stillWorking);
assert.ok(stillWorking.indexOf(LEFT) < stillWorking.indexOf('data-timeline-row-kind="working"'), "above its working row");

// A live agent that has done nothing yet: the live rows say so, no copy.
const fresh = rosterRow(EVICTED, { title: "Survey the fleet" });
const freshSession = await seededThread({ items: [], roster: [fresh] });
const starting = render({ sessionId: freshSession, agentId: EVICTED, roster: [fresh], bottomInset: 0, onBack: NOOP });
assert.ok(!starting.includes(LEFT) && !starting.includes(NOTHING_YET), starting);
assert.ok(starting.includes('data-timeline-row-kind="thinking"'));

// A settled shell whose every row left: its output, not "No output yet."
const exitedShell = rosterRow(SHELL, { agentKind: "background", title: "run the suite", status: "completed", exitCode: 0 });
const exitedShellSession = await seededThread({ items: [], roster: [exitedShell] });
const shellGone = render({ sessionId: exitedShellSession, agentId: SHELL, roster: [exitedShell], bottomInset: 0, onBack: NOOP });
assert.ok(shellGone.includes("Its output has left this thread&#x27;s window."), shellGone);
assert.ok(!shellGone.includes("No output yet."));

// ---------------------------------------------------------------------------
// Re-opening an agent returns to where the reader was (S12)
// ---------------------------------------------------------------------------

const rememberedEntry = {
  disclosures: {
    expandedTurnIds: [],
    expandedGroupIds: [],
    expandedAgentIds: [],
    expandedReasoningIds: [],
    toolOutputOffsets: {}
  },
  collapsedTurnIds: ["turn-1"],
  collapsedShellRowIds: [],
  position: { rowId: "grep-1", offsetWithinRow: 0, scrollOffset: 120, atEnd: false },
  follow: false
};
const reopenedSession = await seededThread({ items: [answer], roster: [promptedAgent] });
const reopened = render({
  sessionId: reopenedSession,
  agentId: PROMPTED,
  roster: [promptedAgent],
  bottomInset: 0,
  onBack: NOOP,
  remembered: rememberedEntry
});
assert.ok(reopened.includes("Scroll to end"), "left mid-list, it reopens there — not following, the pill on offer");
assert.match(
  reopened,
  /data-timeline-row-kind="turn-fold"[^]*?aria-expanded="false"/,
  "and the fold the reader closed is closed"
);
const fresh2 = render({ sessionId: reopenedSession, agentId: PROMPTED, roster: [promptedAgent], bottomInset: 0, onBack: NOOP });
assert.ok(!fresh2.includes("Scroll to end"), "never opened before: at its end, following");

resetThreadStores();
console.log("agent-chat drill-in render checks passed");
