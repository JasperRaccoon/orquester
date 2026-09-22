/**
 * Render smoke checks for "Rewind to here" on a user message (§5.5, §7.3).
 *
 * `rewind.logic.test.ts` owns which rows are rewindable; this exists because
 * "the button shows only where a rollback is possible and never in the
 * read-only drill-in", "it is disabled while the agent is busy and says why"
 * and "it opens a popover rather than rewinding on the spot" are claims about
 * *markup* — and a context or prop mistake typechecks perfectly while
 * rendering nothing.
 *
 * Static markup only — no DOM, no effects — like every other `*.check.ts`.
 * The confirm is portaled and mounts only once open, so its copy is checked
 * through the panel itself, fed the count the row computes.
 */

import assert from "node:assert/strict";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ThreadMessageItem, Turn } from "@orquester/api/agent-chat";
import { startedTurns } from "@orquester/api/agent-chat";

import type { AgentChatTimelineRow } from "../../../lib/agent-chat/contracts";
import { deriveRewindTargets } from "../../../lib/agent-chat/rewind.logic";
import { RewindConfirmPanel, rewindDroppedTurnCount } from "../composer/RewindControl";
import { TimelineRowContext, type TimelineRowContextValue } from "./context";
import { UserMessageRow } from "./rows/MessageRows";

type Row<K extends AgentChatTimelineRow["kind"]> = Extract<AgentChatTimelineRow, { kind: K }>;

/**
 * `ComposerPopover` (the confirm's anchor) uses `useLayoutEffect`, which the
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

const NOOP = (): void => {};

function context(overrides: Partial<TimelineRowContextValue>): TimelineRowContextValue {
  return {
    workspaceRoot: undefined,
    readOnly: false,
    canRevert: true,
    revertBusy: false,
    startedTurnCount: 3,
    disclosures: {
      expandedTurnIds: [],
      expandedGroupIds: [],
      expandedAgentIds: [],
      expandedReasoningIds: [],
      toolOutputOffsets: {}
    },
    roster: [],
    skills: [],
    isExpanded: () => false,
    setExpanded: NOOP,
    isReasoningExpanded: () => false,
    setReasoningExpanded: NOOP,
    isTurnExpanded: () => false,
    setTurnExpanded: NOOP,
    isAgentRowExpanded: () => false,
    setAgentRowExpanded: NOOP,
    toolOutputOffset: () => 0,
    setToolOutputOffset: NOOP,
    onRevert: NOOP,
    onOpenTurnDiff: NOOP,
    onOpenFile: NOOP,
    onLoadFullOutput: NOOP,
    onOpenAgent: NOOP,
    onSendQueuedNow: NOOP,
    onReturnQueuedToComposer: NOOP,
    canBackgroundTasks: false,
    onBackgroundTool: NOOP,
    backgroundShell: false,
    ...overrides
  };
}

function userRow(id: string, text: string, revertTurnCount?: number): Row<"message"> {
  const message: ThreadMessageItem = {
    kind: "message",
    id,
    role: "user",
    text,
    turnId: null,
    streaming: false,
    createdAt: "2026-09-22T10:00:00.000Z",
    updatedAt: "2026-09-22T10:00:00.000Z"
  };
  return {
    kind: "message",
    id,
    createdAt: message.createdAt,
    message,
    durationStart: message.createdAt,
    showAssistantMeta: false,
    ...(revertTurnCount === undefined ? {} : { revertTurnCount })
  };
}

function render(row: Row<"message">, value: TimelineRowContextValue): string {
  return renderToStaticMarkup(
    createElement(TimelineRowContext.Provider, { value }, createElement(UserMessageRow, { row })) as ReactElement
  );
}

/** The rewind button's own opening tag, so other controls cannot satisfy an assertion. */
function rewindButton(html: string): string | null {
  return (html.match(/<button[^>]*aria-label="Rewind to here"[^>]*>/) ?? [null])[0];
}

// ---------------------------------------------------------------------------
// The button
// ---------------------------------------------------------------------------

const row = userRow("m2", "Rename the helper to formatBytes", 1);

const idle = render(row, context({}));
const idleButton = rewindButton(idle);
assert.ok(idleButton, "a rewindable message offers the button");
assert.ok(idleButton.includes('title="Rewind to here"'), "labelled like the CLI's own verb");
assert.ok(
  idleButton.includes('aria-haspopup="menu"'),
  "it opens a confirm anchored to itself — it never rewinds on the spot"
);
assert.ok(!/\sdisabled=""/.test(idleButton), "idle ⇒ the rewind can be offered");
assert.ok(idle.includes("ac-reveal"), "the meta row stays hover-revealed");
assert.ok(!idle.includes('data-visible="true"'), "…and hidden until hovered while closed");

const busy = render(row, context({ revertBusy: true }));
const busyButton = rewindButton(busy);
assert.ok(busyButton, "still shown while busy, so the tooltip can explain itself");
assert.ok(/\sdisabled=""/.test(busyButton), "a running turn or a revert in flight disables it");
assert.ok(
  busyButton.includes('title="Available when the agent is idle"'),
  "a disabled control must say why it is disabled"
);
assert.ok(
  busyButton.includes("disabled:pointer-events-auto"),
  "and it still answers the pointer, or that title could never show"
);

// Withheld — not disabled — wherever a rewind is impossible.
assert.equal(rewindButton(render(userRow("m0", "hi"), context({}))), null, "no revertTurnCount");
assert.equal(rewindButton(render(row, context({ canRevert: false }))), null, "no rollback support");
assert.equal(rewindButton(render(row, context({ readOnly: true }))), null, "the read-only drill-in");

// ---------------------------------------------------------------------------
// The confirm it opens
// ---------------------------------------------------------------------------

// The row and the picker count the dropped turns the same way: a row's
// `revertTurnCount` against the thread's started turns is exactly the
// `droppedTurnCount` the picker's target carries.
const turns: Turn[] = ["t1", "t2", "t3"].map((turnId) => ({
  turnId,
  state: "completed",
  turnCount: null,
  requestedAt: "2026-09-22T10:00:00.000Z",
  startedAt: "2026-09-22T10:00:00.000Z",
  completedAt: "2026-09-22T10:01:00.000Z",
  assistantMessageId: null
}));
const rows = [userRow("m1", "first", 0), userRow("m2", "second", 1), userRow("m3", "third", 2)];
for (const target of deriveRewindTargets(rows, turns)) {
  assert.equal(
    rewindDroppedTurnCount({
      startedTurnCount: startedTurns(turns).length,
      targetTurnCount: target.targetTurnCount
    }),
    target.droppedTurnCount,
    `the row and the picker disagree about ${target.messageId}`
  );
}

const confirm = renderToStaticMarkup(
  createElement(RewindConfirmPanel, {
    text: row.message.text,
    droppedTurnCount: rewindDroppedTurnCount({ startedTurnCount: 3, targetTurnCount: 1 }),
    onConfirm: NOOP,
    onBack: NOOP
  })
);
assert.ok(confirm.includes("Rename the helper to formatBytes"), "the confirm quotes the message");
assert.ok(
  confirm.includes("Removes 2 later turns from this chat. Files stay as they are."),
  "turn 2 of 3: its own turn and the one after it go, and the files stay"
);
assert.ok(confirm.includes(">Rewind</button>") && confirm.includes(">Back</button>"));
assert.equal(
  rewindDroppedTurnCount({ startedTurnCount: 3, targetTurnCount: 2 }),
  1,
  "the newest message drops exactly its own turn"
);
assert.equal(
  rewindDroppedTurnCount({ startedTurnCount: 0, targetTurnCount: 0 }),
  1,
  "never fewer than one — a stale turn list must not read as a free rewind"
);

console.log("rewind-row render checks passed");
