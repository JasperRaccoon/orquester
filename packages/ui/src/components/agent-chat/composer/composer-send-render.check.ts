/**
 * Render checks for "a send in flight outlives its composer" (§7.4).
 *
 * `composer-sends.test.ts` owns the registry; this exists because "a composer
 * mounted for a thread whose send is still in flight renders Sending, not an
 * enabled Send" is a claim about the component reading that registry — the
 * duplicate send was exactly a composer that held the flag in its own state
 * and started every new instance at `false`, so a project switch and back
 * offered an idle, empty composer while the first post was still retrying.
 * The rewind picker waits for the same send, as "Rewind to here" does.
 *
 * Static markup only — no DOM, no effects — like every other `*.check.ts`.
 */

import assert from "node:assert/strict";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { ApiClient } from "../../../lib/api-client";
import { releaseThreadStore } from "../../../lib/agent-chat/store";
import type { RewindTarget } from "../../../lib/agent-chat/rewind.logic";
import { OrquesterProvider } from "../../../context/orquester-context";
import { ChatComposer } from "./ChatComposer";
import { beginComposerSend } from "./composer-sends";

/**
 * What React's server renderer prints for every `useLayoutEffect` it cannot
 * run — the composer's draft load and the popovers' positioning. True, and
 * beside the point for a markup check.
 */
const SSR_LAYOUT_EFFECT_WARNING = "Warning: useLayoutEffect does nothing on the server";

/** The static markup, with exactly that one `console.error` dropped while it renders. */
function render(element: ReactElement): string {
  const consoleError = console.error;
  console.error = (...args: unknown[]): void => {
    if (typeof args[0] === "string" && args[0].startsWith(SSR_LAYOUT_EFFECT_WARNING)) return;
    consoleError.apply(console, args);
  };
  try {
    return renderToStaticMarkup(element);
  } finally {
    console.error = consoleError;
  }
}

/** A chat transport that never answers anything this render could ask. */
const transport = {
  stream: () => ({ lastSeq: 0, hostInstanceId: null, resetCursor: () => {}, close: () => {} }),
  command: () => new Promise<never>(() => {}),
  providers: async () => ({ providers: [], hostInstanceId: "h" })
};

const TARGET: RewindTarget = {
  messageId: "m1",
  text: "earlier",
  createdAt: "2026-09-22T10:00:00.000Z",
  targetTurnCount: 0,
  droppedTurnCount: 1,
  attachmentCount: 0
};

/** A freshly mounted composer for `sessionId` — what a project switch and back renders. */
function composer(sessionId: string): string {
  return render(
    createElement(OrquesterProvider, {
      runtime: "web",
      api: { agentChat: transport } as unknown as ApiClient,
      useTitlebar: false,
      children: createElement(ChatComposer, {
        sessionId,
        provider: null,
        modelSelection: null,
        runtimeMode: "full-access",
        interactionMode: "default",
        showPlanModeToggle: false,
        accountLabel: null,
        isTurnActive: false,
        hasPendingRequest: false,
        queue: [],
        activePlan: null,
        actionableProposedPlan: { id: "plan-1", planMarkdown: "# Implement the fix" },
        reverting: false,
        rewindTargets: [TARGET],
        onRewind: () => undefined,
        actions: {} as never,
        onHeightChange: () => undefined,
        active: true
      })
    })
  );
}

const button = (html: string, token: string): string => {
  const match = html.match(new RegExp(`<button[^>]*data-composer-shortcut="${token}"[^>]*>`));
  assert.ok(match, `missing ${token} control`);
  return match[0];
};
// The HTML attribute, not the `disabled:` Tailwind variants in the class list.
const DISABLED_ATTR = /\sdisabled=""/;

// ---------------------------------------------------------------------------
// The send button
// ---------------------------------------------------------------------------

// A send left thread A from a composer a project switch has since unmounted.
const settle = beginComposerSend("A");
try {
  const a = composer("A");
  assert.ok(DISABLED_ATTR.test(button(a, "send")), "and refuses a second click");
  assert.ok(DISABLED_ATTR.test(button(a, "rewind")), "a rewind would race the turn being sent");

  const b = composer("B");
  assert.ok(!DISABLED_ATTR.test(button(b, "send")), "B can implement its plan");
  assert.ok(!DISABLED_ATTR.test(button(b, "rewind")), "B's picker opens");
} finally {
  settle();
}
assert.ok(!DISABLED_ATTR.test(button(composer("A"), "send")), "settled: A can implement its plan");
assert.ok(!DISABLED_ATTR.test(button(composer("A"), "rewind")), "settled: A may rewind again");

releaseThreadStore("A");
releaseThreadStore("B");
console.log("composer send render checks passed");
