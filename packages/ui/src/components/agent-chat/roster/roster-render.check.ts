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
import type {
  AgentPanelModel,
  Checkpoint,
  RuntimeSubagent,
  ThreadItem
} from "@orquester/api/agent-chat";
import {
  OrquesterProvider,
  type OrquesterProviderProps
} from "../../../context/orquester-context";
import { AgentRoster } from "./AgentRoster";
import { backgroundShellRows } from "./background-shell";
import { AgentDrillIn } from "./AgentDrillIn";
import { ChatStatusLine } from "../status/ChatStatusLine";
import { ContextMeterPanel } from "../status/ContextMeter";
import { deriveContextMeter } from "../status/context-meter";

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
// A background shell: the roster row, and the drill-in that shows its output
// ---------------------------------------------------------------------------

function shell(overrides: Partial<RuntimeSubagent> = {}): RuntimeSubagent {
  return agent("task-bg-1", {
    agentKind: "background",
    title: "run the suite",
    // The launching agent's model rides the task payload; the row must never
    // show it, because that is what made a shell read as a subagent.
    model: "fable-5-1",
    effort: "1m",
    ...overrides
  });
}

const shellRow = render(
  createElement(AgentRoster, {
    sessionId: "s1",
    agents: [shell()],
    panel: emptyPanel,
    expanded: false,
    onExpandedChange: () => {},
    onOpenAgent: () => {}
  })
);
assert.ok(shellRow.includes('data-agent-kind="background"'), "the row is stamped as a shell");
assert.ok(shellRow.includes('data-roster-shells="true"'), "shells sit in their own section");
assert.ok(shellRow.includes(">Shell<"), "whose caption names the kind");
assert.ok(shellRow.includes("1 running"), "and says how many still run");
assert.ok(!shellRow.includes("fable-5-1"), "and never the launching agent's model");
assert.ok(!shellRow.includes("— tok"), "nor a token slot a shell can never fill");
assert.ok(!shellRow.includes("data-shell-exit"), "a live shell has no exit badge yet");
assert.ok(shellRow.includes(">Running<"), "a live shell is running, not 'Working'");

// One agent and one shell: the folded label counts them apart, and the agent
// row precedes the shells' caption in the markup.
const mixedFolded = render(
  createElement(AgentRoster, {
    sessionId: "s1",
    agents: [agent("agent-x"), shell()],
    panel: emptyPanel,
    expanded: false,
    collapsed: true,
    onCollapsedChange: () => {},
    onExpandedChange: () => {},
    onOpenAgent: () => {}
  })
);
assert.match(
  mixedFolded,
  /1 agent \(<span class="text-info-300">1 working<\/span>\) · 1 shell \(<span class="text-info-300">1 running<\/span>\)/,
  "the folded roster places cyan active counts beside each kind"
);
const mixedOpen = render(
  createElement(AgentRoster, {
    sessionId: "s1",
    agents: [shell(), agent("agent-x")],
    panel: emptyPanel,
    expanded: false,
    onExpandedChange: () => {},
    onOpenAgent: () => {}
  })
);
assert.ok(
  mixedOpen.indexOf('data-agent-id="agent-x"') < mixedOpen.indexOf('data-roster-shells="true"'),
  "agents render above the shells section even when the shell spawned first"
);
assert.ok(mixedOpen.includes("● 1 working"), "working counts the agent, not the shell");

const foldedCounts = render(
  createElement(AgentRoster, {
    sessionId: "s1",
    agents: [
      ...Array.from({ length: 7 }, (_, index) =>
        agent(`agent-${index}`, { status: index < 2 ? "running" : "completed" })
      ),
      ...Array.from({ length: 6 }, (_, index) =>
        shell({ id: `shell-${index}`, status: index === 0 ? "running" : "completed" })
      )
    ],
    panel: emptyPanel,
    expanded: false,
    collapsed: true,
    onCollapsedChange: () => {},
    onExpandedChange: () => {},
    onOpenAgent: () => {}
  })
);
assert.match(
  foldedCounts,
  /7 agents \(<span class="text-info-300">2 working<\/span>\) · 6 shells \(<span class="text-info-300">1 running<\/span>\)/
);
assert.ok(!foldedCounts.includes("● 2 working"), "the working count appears only beside the agents total");

const orderedRoster = render(
  createElement(AgentRoster, {
    sessionId: "s1",
    agents: [
      agent("agent-done", { status: "completed" }),
      shell({ id: "shell-done", status: "completed" }),
      agent("agent-live"),
      shell({ id: "shell-live" })
    ],
    panel: emptyPanel,
    expanded: true,
    onCollapsedChange: () => {},
    onExpandedChange: () => {},
    onOpenAgent: () => {}
  })
);
assert.ok(orderedRoster.indexOf('data-agent-id="agent-live"') < orderedRoster.indexOf('data-agent-id="agent-done"'));
assert.ok(orderedRoster.indexOf('data-agent-id="shell-live"') < orderedRoster.indexOf('data-agent-id="shell-done"'));
assert.match(orderedRoster, /data-agent-id="agent-done"[^>]*class="[^"]*opacity-70/);
assert.match(orderedRoster, /data-agent-id="shell-done"[^>]*class="[^"]*opacity-70/);
assert.doesNotMatch(orderedRoster, /data-agent-id="agent-live"[^>]*class="[^"]*opacity-70/);

const exitedRow = render(
  createElement(AgentRoster, {
    sessionId: "s1",
    agents: [shell({ status: "completed", exitCode: 0, completedAt: "2026-09-21T10:00:30.000Z" })],
    panel: emptyPanel,
    expanded: false,
    onExpandedChange: () => {},
    onOpenAgent: () => {}
  })
);
assert.ok(exitedRow.includes("Exited with code 0"), "a settled shell leads with its exit code");
assert.ok(exitedRow.includes('data-shell-exit="0"'), "and wears it as a badge");
assert.ok(exitedRow.includes(">exit 0<"), "in the row's own words");

const failedRow = render(
  createElement(AgentRoster, {
    sessionId: "s1",
    agents: [shell({ status: "failed", exitCode: 127 })],
    panel: emptyPanel,
    expanded: false,
    onExpandedChange: () => {},
    onOpenAgent: () => {}
  })
);
assert.ok(failedRow.includes("Failed · exit 127"));

// The drill-in: the command and its output are on screen without a click.
const TOOL_USE_ID = "bgshell:task-bg-1";
let shellItemSeq = 0;
function shellItem(activityKind: string, payload: Record<string, unknown>): ThreadItem {
  shellItemSeq += 1;
  const createdAt = new Date(Date.UTC(2026, 8, 21, 10, 0, shellItemSeq)).toISOString();
  return {
    kind: "activity",
    id: `bg${shellItemSeq}`,
    tone: "tool",
    activityKind,
    summary: "Background shell",
    payload,
    turnId: "turn-1",
    createdAt,
    updatedAt: createdAt,
    agentId: "task-bg-1"
  } as ThreadItem;
}

const shellItems: ThreadItem[] = [
  shellItem("tool.started", {
    toolUseId: TOOL_USE_ID,
    itemType: "command_execution",
    title: "Background shell",
    detail: "pnpm test --watch",
    status: "running",
    data: {
      toolName: "Bash",
      input: { command: "pnpm test --watch", description: "run the suite" },
      background: true
    }
  }),
  shellItem("tool.output", {
    toolUseId: TOOL_USE_ID,
    streamKind: "command_output",
    delta: "PASS src/a.test.ts\n"
  })
];

const shellDrillIn = render(
  createElement(AgentDrillIn, {
    sessionId: "s1",
    agentId: "task-bg-1",
    agent: shell(),
    roster: [shell()],
    rows: backgroundShellRows(shellItems, "task-bg-1"),
    onBack: () => {}
  })
);
assert.ok(shellDrillIn.includes("run the suite"), "the header names the shell's description");
assert.ok(
  shellDrillIn.includes("background shell"),
  "and its metrics line says what it is, not what model ran it"
);
assert.ok(!shellDrillIn.includes("fable-5-1"));
assert.ok(
  shellDrillIn.includes(">Running<") && !shellDrillIn.includes(">Working<"),
  "the header's state chip speaks the shell's language, exactly as its roster row does"
);
assert.ok(
  shellDrillIn.includes("lucide-terminal"),
  "and the breadcrumb keeps the terminal glyph"
);

const exitedDrillIn = render(
  createElement(AgentDrillIn, {
    sessionId: "s1",
    agentId: "task-bg-1",
    agent: shell({ status: "completed", exitCode: 0, completedAt: "2026-09-21T10:00:30.000Z" }),
    roster: [shell({ status: "completed", exitCode: 0 })],
    rows: backgroundShellRows(shellItems, "task-bg-1"),
    onBack: () => {}
  })
);
assert.ok(exitedDrillIn.includes("Exited with code 0"));
assert.ok(exitedDrillIn.includes("background shell · exit 0"));
assert.ok(
  exitedDrillIn.includes("run the suite"),
  "a settled shell still leads with what it was asked to do"
);
assert.ok(
  shellDrillIn.includes('data-background-shell="true"'),
  "the command row knows it is a shell's row"
);
assert.ok(
  shellDrillIn.includes("pnpm test --watch"),
  "the command is on screen, in the monospace block"
);
assert.ok(
  shellDrillIn.includes("PASS src/a.test.ts"),
  "and so is what the shell has printed — without a click"
);
assert.ok(
  shellDrillIn.includes('data-shell-output="true"') && shellDrillIn.includes("max-h-[60vh]"),
  "the output pane gets the room a drill-in's whole content deserves"
);
assert.ok(
  !shellDrillIn.includes("max-h-64"),
  "and not the short cap a tool row inside a conversation gets"
);

// Nothing printed yet: the copy is a shell's, not a subagent's.
const silentShell = render(
  createElement(AgentDrillIn, {
    sessionId: "s1",
    agentId: "task-bg-1",
    agent: shell(),
    roster: [shell()],
    rows: [],
    onBack: () => {}
  })
);
assert.ok(silentShell.includes("No output yet."));
assert.ok(!silentShell.includes("has not reported anything yet"));
assert.ok(
  drillIn.includes("This agent has not reported anything yet."),
  "an agent with no items keeps its own copy"
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

// ---------------------------------------------------------------------------
// Fix-wave regressions (R8 m3, m5, m9)
// ---------------------------------------------------------------------------

// m9 — the working hairline exists only while a turn is in flight.
assert.ok(live.includes("ac-working-bar"), "a running turn draws the indeterminate hairline");
assert.ok(!degraded.includes("ac-working-bar"), "a settled thread draws no hairline");
assert.ok(!broken.includes("ac-working-bar"), "a dead stream draws no hairline");

// m5 — the meter's popover opens on hover, not on a click alone.
assert.ok(
  live.includes('data-hover-open="true"'),
  "the meter trigger carries the hover affordance"
);

// m9 — `ping` is the act-now halo, and the thread's own row is its one home.
const awaiting = render(
  createElement(AgentRoster, {
    sessionId: "s1",
    agents: [],
    panel: emptyPanel,
    expanded: false,
    onExpandedChange: () => {},
    onOpenAgent: () => {},
    main: {
      turnActive: false,
      awaitingUser: true,
      activityLabel: "Approve the edit to src/index.ts?",
      turnStartedAt: null,
      tokensUsed: null
    }
  })
);
assert.ok(awaiting.includes("ac-dot-ping"), "a thread waiting on the user pings");
assert.ok(awaiting.includes("Waiting for you"));
assert.ok(!collapsed.includes("ac-dot-ping"), "a working thread breathes, it does not ping");

// m3 — the auto-compaction sentence names the model when no threshold is known.
const panelModel = deriveContextMeter({
  usedTokens: 50_000,
  maxTokens: 200_000,
  autoCompactAtTokens: null,
  totalProcessedTokens: null,
  reportsContextWindow: true
});
assert.ok(panelModel);
const namedPanel = render(
  createElement(ContextMeterPanel, {
    model: panelModel,
    modelLabel: "claude-opus-4",
    onCompact: () => {}
  })
);
assert.ok(
  namedPanel.includes("Context for claude-opus-4 compacts automatically when needed."),
  "the sentence names the thread's model"
);
assert.ok(namedPanel.includes("Compact context"), "the Compact button is always offered");
const anonymousPanel = render(
  createElement(ContextMeterPanel, { model: panelModel, onCompact: () => {} })
);
assert.ok(
  anonymousPanel.includes("Context compacts automatically when needed."),
  "without a label it degrades to the generic sentence rather than inventing one"
);

console.error = consoleError;
console.log("agent-chat roster/status render checks passed");
