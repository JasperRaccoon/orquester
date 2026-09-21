/**
 * Render smoke checks for the roster, the drill-in and the status line.
 *
 * Not a substitute for `roster-rows.test.ts` / `status-line.test.ts` (which
 * own the rules): this exists because a fixed-height row, a "N more" toggle
 * and a degraded meter are all claims about *markup*, and a React hook-order
 * or prop mistake typechecks perfectly while rendering nothing. Static markup
 * only — no DOM, no effects — so it stays a plain assert script like every
 * other `*.check.ts` here.
 */

import assert from "node:assert/strict";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentPanelModel, Checkpoint, RuntimeSubagent } from "@orquester/api/agent-chat";
import {
  OrquesterProvider,
  type OrquesterProviderProps
} from "../../../context/orquester-context";
import { AgentRoster } from "./AgentRoster";
import { AgentDrillIn } from "./AgentDrillIn";
import { ChatStatusLine } from "../status/ChatStatusLine";

/**
 * The drill-in reads `useAgentChatDrillIn`, which resolves its thread store
 * through the app context. The store only *captures* its transport (the stream
 * opens in an effect, and effects never run under the static renderer), so a
 * bare provider is enough to render one — and rendering it under a provider is
 * the point: it proves the hook path compiles and runs, not just the props.
 */
function render(element: ReactElement): string {
  const context = {
    useTitlebar: false,
    // A store opens its stream on a microtask, so the fake transport needs a
    // `stream` that hands back a closed handle — nothing is ever delivered,
    // which is exactly the state these assertions render against.
    api: {
      agentChat: {
        stream: () => ({ close: () => {}, lastSeq: 0, hostInstanceId: null })
      }
    }
  } as unknown as OrquesterProviderProps;
  return renderToStaticMarkup(createElement(OrquesterProvider, { ...context, children: element }));
}

/**
 * The app's `Dropdown` (the meter's popover) uses `useLayoutEffect`, which the
 * static renderer warns about because it cannot encode the effect for
 * hydration. This script never hydrates, so that one warning is noise —
 * filtered by its exact text so every other console error still surfaces.
 */
const consoleError = console.error.bind(console);
console.error = (...args: unknown[]) => {
  if (typeof args[0] === "string" && args[0].includes("useLayoutEffect does nothing on the server")) {
    return;
  }
  consoleError(...args);
};

function agent(id: string, overrides: Partial<RuntimeSubagent> = {}): RuntimeSubagent {
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

const emptyPanel: AgentPanelModel = {
  workflows: [],
  directAgents: [],
  runningCount: 0,
  waitingCount: 0,
  idleCount: 0,
  settledCount: 0,
  totalTokens: 0,
  hasAgents: false,
  liveCount: 0
};

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

// ---------------------------------------------------------------------------
// The roster dock
// ---------------------------------------------------------------------------

const seven = Array.from({ length: 7 }, (_, index) =>
  agent(`agent-${index}`, { firstSeenAt: `2026-09-21T10:00:0${index}.000Z` })
);

const collapsed = render(
  createElement(AgentRoster, {
    sessionId: "s1",
    agents: seven,
    panel: emptyPanel,
    expanded: false,
    onExpandedChange: () => {},
    onOpenAgent: () => {},
    main: {
      turnActive: true,
      activityLabel: "Editing src/index.ts",
      turnStartedAt: "2026-09-21T10:00:00.000Z",
      tokensUsed: 12_400,
      model: "claude-opus-4-20250514"
    }
  })
);

// Five agent rows plus the main row, all of them the same fixed height.
assert.equal(countOccurrences(collapsed, 'data-agent-id="agent-'), 5);
assert.ok(collapsed.includes('data-roster-main="true"'));
assert.equal(countOccurrences(collapsed, "h-[3.875rem]"), 6);
assert.ok(collapsed.includes("2 more"), "the rest collapse behind an N-more toggle");
assert.ok(collapsed.includes("main"), "the thread's own row is labelled");
assert.ok(collapsed.includes("opus-4"), "the main row carries the model chip");

// A live background row renders past the cap and keeps its place in the order.
const withBackground = render(
  createElement(AgentRoster, {
    sessionId: "s1",
    agents: [
      ...seven,
      agent("watcher", {
        agentKind: "background",
        status: "running",
        firstSeenAt: "2026-09-21T10:00:09.000Z"
      })
    ],
    panel: emptyPanel,
    expanded: false,
    onExpandedChange: () => {},
    onOpenAgent: () => {},
    main: { turnActive: true, activityLabel: null, turnStartedAt: null, tokensUsed: null }
  })
);
assert.ok(withBackground.includes('data-agent-id="watcher"'));
assert.ok(withBackground.includes('data-agent-kind="background"'));
assert.equal(
  countOccurrences(withBackground, 'data-agent-id="agent-'),
  5,
  "the exempt row does not consume one of the five"
);

// No main row, no agents, no workflows ⇒ nothing at all, not an empty bar.
assert.equal(
  render(
    createElement(AgentRoster, {
      sessionId: "s1",
      agents: [],
      panel: emptyPanel,
      expanded: false,
      onExpandedChange: () => {},
      onOpenAgent: () => {}
    })
  ),
  ""
);

// A settled thread (no turn running) opens with its finished rows already gone.
const reopened = render(
  createElement(AgentRoster, {
    sessionId: "s1",
    agents: [agent("old", { status: "completed", completedAt: "2026-09-21T10:01:00.000Z" })],
    panel: emptyPanel,
    expanded: false,
    onExpandedChange: () => {},
    onOpenAgent: () => {},
    main: { turnActive: false, activityLabel: null, turnStartedAt: null, tokensUsed: null }
  })
);
assert.ok(!reopened.includes('data-agent-id="old"'));
assert.ok(reopened.includes('data-roster-main="true"'));

// Without a main row there is no turn signal, so nothing is faded away on a
// guess — every row the fold produced still renders.
const noMain = render(
  createElement(AgentRoster, {
    sessionId: "s1",
    agents: [agent("old", { status: "completed", completedAt: "2026-09-21T10:01:00.000Z" })],
    panel: emptyPanel,
    expanded: false,
    onExpandedChange: () => {},
    onOpenAgent: () => {}
  })
);
assert.ok(noMain.includes('data-agent-id="old"'));

// ---------------------------------------------------------------------------
// The drill-in
// ---------------------------------------------------------------------------

const drillIn = render(
  createElement(AgentDrillIn, {
    sessionId: "s1",
    agentId: "agent-1",
    agent: agent("agent-1", {
      title: "Find the bug",
      progress: "Reading src/index.ts",
      recentActivity: [{ at: "2026-09-21T10:00:01.000Z", summary: "Reading src/index.ts" }]
    }),
    rows: [],
    onBack: () => {}
  })
);
assert.ok(drillIn.includes("Find the bug"), "the breadcrumb names the agent");
assert.ok(drillIn.includes("Agents"), "the breadcrumb has a root");
assert.ok(drillIn.includes("Back"));
assert.ok(
  drillIn.includes("Reading src/index.ts"),
  "the prompt block leads with what the provider reported the agent is doing"
);
assert.ok(
  drillIn.includes('data-agent-id="agent-1"'),
  "the child timeline renders, scoped to this agent"
);

const unknownAgent = render(
  createElement(AgentDrillIn, {
    sessionId: "s1",
    agentId: "gone",
    agent: null,
    rows: [],
    onBack: () => {}
  })
);
assert.ok(
  unknownAgent.includes("no longer in the thread"),
  "a row the roster dropped says so instead of rendering a blank header"
);

// ---------------------------------------------------------------------------
// The status line
// ---------------------------------------------------------------------------

const checkpoint: Checkpoint = {
  turnId: "t1",
  checkpointTurnCount: 3,
  checkpointRef: "refs/orquester/checkpoints/x/turn/3",
  status: "ready",
  files: [{ path: "src/index.ts", additions: 4, deletions: 1 }],
  assistantMessageId: null,
  completedAt: "2026-09-21T10:01:00.000Z"
};

const live = render(
  createElement(ChatStatusLine, {
    sessionId: "s1",
    connection: "synchronized",
    turnStartedAt: "2026-09-21T10:00:00.000Z",
    activityLabel: "Running tests",
    tokensUsed: 50_000,
    contextMaxTokens: 200_000,
    autoCompactAtTokens: 180_000,
    totalProcessedTokens: 640_000,
    reportsContextWindow: true,
    activePlan: {
      createdAt: "2026-09-21T10:00:00.000Z",
      turnId: "t1",
      steps: [
        { step: "one", status: "completed" },
        { step: "two", status: "inProgress" }
      ]
    },
    onCompact: () => {},
    latestCheckpoint: checkpoint
  })
);
assert.ok(live.includes("Running tests"));
assert.ok(live.includes("ac-shimmer"), "a live label shimmers");
assert.ok(live.includes("50k tok"));
assert.ok(live.includes("1/2"), "the plan chip counts its steps");
assert.ok(live.includes("1 file"), "the checkpoint chip counts its files");
assert.ok(live.includes("25%"), "the ring announces its percentage");

const degraded = render(
  createElement(ChatStatusLine, {
    sessionId: "s1",
    connection: "synchronized",
    turnStartedAt: null,
    activityLabel: null,
    tokensUsed: 12_400,
    contextMaxTokens: null,
    autoCompactAtTokens: null,
    totalProcessedTokens: null,
    reportsContextWindow: false,
    activePlan: null,
    onCompact: () => {},
    latestCheckpoint: null
  })
);
assert.ok(degraded.includes("12k tok"), "the bare total still shows");
assert.ok(
  degraded.includes("Context usage unavailable"),
  "the ring says it has nothing to measure rather than drawing 0%"
);
assert.ok(!degraded.includes("ac-shimmer\"") || degraded.includes("ac-shimmer-settled"));
assert.ok(degraded.includes("Ready"));

// A broken stream outranks everything else the line could say.
const broken = render(
  createElement(ChatStatusLine, {
    sessionId: "s1",
    connection: "error",
    turnStartedAt: "2026-09-21T10:00:00.000Z",
    activityLabel: "Running tests",
    tokensUsed: null,
    contextMaxTokens: null,
    autoCompactAtTokens: null,
    totalProcessedTokens: null,
    reportsContextWindow: true,
    activePlan: null,
    onCompact: () => {},
    latestCheckpoint: null
  })
);
assert.ok(broken.includes("Disconnected"));
assert.ok(!broken.includes("Running tests"));

console.error = consoleError;
console.log("agent-chat roster/status render checks passed");
