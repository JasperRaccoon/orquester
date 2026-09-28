/**
 * Regression: a seeded thread must render the shell projection's output.
 * A second projection in ChatTimeline previously replaced it with closed turn
 * folds. Use the actual store path and assert command/output data only.
 */

import assert from "node:assert/strict";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  type AgentChatStreamFrame,
  type RuntimeSubagent,
  type ThreadActivityItem,
  type ThreadItem,
  type ThreadSnapshotPayload
} from "@orquester/api/agent-chat";

import { OrquesterProvider, type OrquesterProviderProps } from "../../../context/orquester-context";
import { ensureThreadStore, releaseThreadStore } from "../../../lib/agent-chat/store";
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

/** A fresh thread whose store holds `thread`, as a snapshot frame delivers it — on `session`, when given. */
async function seededThread(thread: Partial<ThreadSnapshotPayload>): Promise<string> {
  sessions += 1;
  const sessionId = `drill-${sessions}`;
  ensureThreadStore(sessionId, { transport });
  await flush();
  const push = frameHandlers.get(sessionId);
  assert.ok(push, "the store opened its stream");
  const threadHead = head({ id: sessionId });
  push({ kind: "snapshot", thread: snapshot({ head: threadHead, seq: 1, ...thread }) });
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

/** An activity as a snapshot delivers it. */
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
    payload,
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
const shellData = {
  toolName: "Bash",
  input: { command: "pnpm test --watch", description: "run the suite" },
  background: true
};
const shellStart = wireActivity(
  "tool.started",
  {
    toolUseId: SHELL_CALL,
    itemType: "command_execution",
    title: "Background shell",
    detail: "pnpm test --watch",
    status: "running",
    data: shellData
  },
  { agentId: SHELL, id: "shell-start" }
);
const shellChunk = wireActivity(
  "tool.output",
  { toolUseId: SHELL_CALL, streamKind: "command_output", delta: "PASS src/a.test.ts\n" },
  { agentId: SHELL, id: "shell-chunk" }
);
async function shellDrillIn(items: ThreadItem[], shell: RuntimeSubagent): Promise<string> {
  const sessionId = await seededThread({ items, roster: [shell] });
  return render({ sessionId, agentId: SHELL, roster: [shell], bottomInset: 0, onBack: NOOP });
}

const liveShell = rosterRow(SHELL, { agentKind: "background", title: "run the suite" });

const printing = await shellDrillIn([shellStart, shellChunk], liveShell);
assert.ok(printing.includes("pnpm test --watch"), "opening the shell shows its command");
assert.ok(printing.includes("PASS src/a.test.ts"), "the seeded thread renders shell output without another click");

for (const sessionId of frameHandlers.keys()) releaseThreadStore(sessionId);
console.error = consoleError;
console.log("agent-chat seeded shell output check passed");
