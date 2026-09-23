/**
 * Render smoke checks for the "Load older turns" row (design 2026-09-23 §C
 * "History page", "Client").
 *
 * `history.logic.test.ts` / `store.history.test.ts` own WHEN older history
 * exists and what loading it does; this exists because "the row sits above
 * the first row", "it spins and cannot be pressed twice while its request is
 * in flight", "a failure is said inline", "an empty-looking window with
 * older history is not an empty thread" and "a read-only surface never
 * offers it" are claims about markup — and a prop mistake typechecks
 * perfectly while rendering nothing.
 *
 * Static markup only — no DOM, no effects — like every other `*.check.ts`.
 */

import assert from "node:assert/strict";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ThreadMessageItem } from "@orquester/api/agent-chat";

import type { AgentChatTimelineRow } from "../../../lib/agent-chat/contracts";
import type { ChatTimelineProps } from "../contracts";
import { ChatTimeline } from "./ChatTimeline";
import { LoadOlderRow } from "./rows/LoadOlderRow";

/** The timeline's layout effects warn under the static renderer; nothing here hydrates. */
const consoleError = console.error.bind(console);
console.error = (...args: unknown[]) => {
  if (typeof args[0] === "string" && args[0].includes("useLayoutEffect does nothing on the server")) {
    return;
  }
  consoleError(...args);
};

const NOOP = (): void => {};

function userRow(id: string, text: string): Extract<AgentChatTimelineRow, { kind: "message" }> {
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
    showAssistantMeta: false
  };
}

function timeline(overrides: Partial<ChatTimelineProps>): string {
  const props: ChatTimelineProps = {
    sessionId: "s1",
    rows: [userRow("u3", "the newest prompt")],
    follow: false,
    onFollowChange: NOOP,
    disclosures: {
      expandedTurnIds: [],
      expandedGroupIds: [],
      expandedAgentIds: [],
      expandedReasoningIds: [],
      toolOutputOffsets: {}
    },
    onDisclosureChange: NOOP,
    bottomInset: 0,
    canRevert: false,
    onRevert: NOOP,
    onOpenTurnDiff: NOOP,
    onOpenFile: NOOP,
    onLoadFullOutput: NOOP,
    onOpenAgent: NOOP,
    onSendQueuedNow: NOOP,
    onReturnQueuedToComposer: NOOP,
    errorBanner: null,
    onDismissErrorBanner: NOOP,
    ...overrides
  };
  return renderToStaticMarkup(createElement(ChatTimeline, props) as ReactElement);
}

/** The row's own button tag, so no other control can satisfy an assertion. */
function loadButton(html: string): string | null {
  return (html.match(/<button[^>]*data-timeline-load-older-button[^>]*>/) ?? [null])[0];
}

// ---------------------------------------------------------------------------
// The row on its own
// ---------------------------------------------------------------------------

const idle = renderToStaticMarkup(createElement(LoadOlderRow, { loading: false, error: null, onLoad: NOOP }));
const idleButton = loadButton(idle);
assert.ok(idleButton, "the row is a button");
assert.ok(idle.includes("Load older turns"), "it says what it does");
assert.ok(!/\sdisabled=""/.test(idleButton), "idle ⇒ it can be pressed");
assert.ok(!idle.includes("animate-spin"), "no spinner before a request is in flight");
assert.ok(!idle.includes('role="alert"'), "no error to say");
assert.ok(
  !idle.includes("data-timeline-row-id"),
  "not a row: the anchor walk and the reveal look rows up by that attribute"
);

const loading = renderToStaticMarkup(createElement(LoadOlderRow, { loading: true, error: null, onLoad: NOOP }));
const loadingButton = loadButton(loading);
assert.ok(loadingButton && /\sdisabled=""/.test(loadingButton), "one request at a time");
assert.ok(loadingButton.includes('aria-busy="true"'), "and it says it is busy");
assert.ok(loading.includes("animate-spin"), "the control's own request spins its own spinner");

const failed = renderToStaticMarkup(
  createElement(LoadOlderRow, {
    loading: false,
    error: "Older turns are unavailable on this host right now.",
    onLoad: NOOP
  })
);
assert.ok(
  /role="alert"[^>]*>Older turns are unavailable on this host right now\.</.test(failed),
  "a failure is said inline, where the user pressed"
);
assert.ok(!/\sdisabled=""/.test(loadButton(failed) ?? ""), "…and the button stays to retry");

// ---------------------------------------------------------------------------
// In the timeline
// ---------------------------------------------------------------------------

const withOlder = timeline({
  historyHasOlder: true,
  onLoadOlderHistory: NOOP,
  rows: [userRow("u2", "an older prompt"), userRow("u3", "the newest prompt")]
});
const rowAt = withOlder.indexOf("data-timeline-load-older");
const firstRowAt = withOlder.indexOf('data-timeline-row-id="u2"');
assert.ok(rowAt >= 0, "offered while older history exists");
assert.ok(firstRowAt > rowAt, "above the first row");

assert.equal(
  timeline({ historyHasOlder: false, onLoadOlderHistory: NOOP }).indexOf("data-timeline-load-older"),
  -1,
  "withheld once nothing older exists"
);
assert.equal(
  timeline({ historyHasOlder: true, onLoadOlderHistory: NOOP, readOnly: true }).indexOf(
    "data-timeline-load-older"
  ),
  -1,
  "a read-only surface pages nothing"
);
assert.ok(
  timeline({ historyHasOlder: true, onLoadOlderHistory: NOOP, historyLoading: true }).includes(
    'aria-busy="true"'
  ),
  "the timeline passes the spinner through"
);

// A window the retention emptied is not an empty thread.
const emptyWindow = timeline({
  rows: [],
  threadReady: true,
  emptyThreadPanel: createElement("div", { "data-empty-thread-panel": "" }),
  historyHasOlder: true,
  onLoadOlderHistory: NOOP
});
assert.ok(emptyWindow.includes("data-timeline-load-older"), "older history is still offered");
assert.ok(!emptyWindow.includes("data-empty-thread-panel"), "never the resumable-conversations panel");
assert.ok(!emptyWindow.includes("No messages yet."), "never the empty-thread placeholder");

console.log("history-row render checks passed");
