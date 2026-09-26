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

resetThreadStores();
console.log("agent-chat drill-in render checks passed");
