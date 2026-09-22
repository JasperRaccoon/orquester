/**
 * Render smoke checks for the composer's rewind picker (§5.5, §7.4).
 *
 * `rewind.logic.test.ts` owns the rules (which messages are targets, how many
 * turns each drops, the double-press sequence); this exists because "the
 * picker's button is absent with nothing to rewind to", "it carries the
 * `rewind` token so the double Escape can reach it", "it is disabled while
 * the agent is busy" and "the confirm says files stay as they are" are claims
 * about *markup* — and a React prop mistake typechecks perfectly while
 * rendering nothing.
 *
 * Static markup only — no DOM, no effects — like every other `*.check.ts`.
 * The popover's panel is portaled and only mounts once open, so the list and
 * the confirm are rendered as the components the panel mounts.
 */

import assert from "node:assert/strict";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { RewindTarget } from "../../../lib/agent-chat/rewind.logic";
import {
  REWIND_PICKER_LIMIT,
  RewindConfirmPanel,
  RewindControl,
  RewindPickerPanel
} from "./RewindControl";

function render(element: ReactElement): string {
  return renderToStaticMarkup(element);
}

/**
 * `ComposerPopover` uses `useLayoutEffect`, which the static renderer warns
 * about because it cannot encode the effect for hydration. This script never
 * hydrates, so that one warning is noise — filtered by its exact text so every
 * other console error still surfaces.
 */
const consoleError = console.error.bind(console);
console.error = (...args: unknown[]) => {
  if (typeof args[0] === "string" && args[0].includes("useLayoutEffect does nothing on the server")) {
    return;
  }
  consoleError(...args);
};

// Newest first, as `deriveRewindTargets` returns them.
const TARGETS: RewindTarget[] = [
  {
    messageId: "m3",
    text: "Now wire the settings page\nand add a test",
    createdAt: "2026-09-22T10:30:00.000Z",
    targetTurnCount: 2,
    droppedTurnCount: 1,
    attachmentCount: 2
  },
  {
    messageId: "m2",
    text: "Rename the helper to formatBytes",
    createdAt: "2026-09-22T10:20:00.000Z",
    targetTurnCount: 1,
    droppedTurnCount: 2,
    attachmentCount: 0
  },
  {
    messageId: "m1",
    text: "",
    createdAt: "2026-09-22T10:10:00.000Z",
    targetTurnCount: 0,
    droppedTurnCount: 3,
    attachmentCount: 1
  }
];

interface BusyFlags {
  isTurnActive: boolean;
  reverting: boolean;
  hasPendingRequest: boolean;
}

const IDLE: BusyFlags = { isTurnActive: false, reverting: false, hasPendingRequest: false };

// The HTML attribute, not the `disabled:` Tailwind variants in the class list.
const DISABLED_ATTR = /\sdisabled=""/;

// ---------------------------------------------------------------------------
// The button
// ---------------------------------------------------------------------------

const none = render(
  createElement(RewindControl, { ...IDLE, targets: [], onRewind: () => undefined })
);
assert.equal(none, "", "nothing to rewind to ⇒ no button at all, not a disabled one");

const idle = render(
  createElement(RewindControl, { ...IDLE, targets: TARGETS, onRewind: () => undefined })
);
assert.ok(idle.includes("<button"), "a thread with earlier messages gets the picker");
assert.ok(
  idle.includes('data-composer-shortcut="rewind"'),
  "the token is what lets the double Escape open it through openControl"
);
assert.ok(idle.includes('aria-label="Rewind to an earlier message"'));
assert.ok(
  idle.includes('title="Rewind to an earlier message (Esc Esc)"'),
  "the tooltip teaches the double Escape"
);
assert.ok(idle.includes('aria-haspopup="menu"'), "it opens a popover, like every other chip");
assert.ok(!DISABLED_ATTR.test(idle), "idle ⇒ the picker opens");

const busyCases: Array<[string, Partial<BusyFlags>]> = [
  ["a running turn — the host refuses a rewind mid-turn", { isTurnActive: true }],
  ["a revert already in flight", { reverting: true }],
  ["a request docked above the composer", { hasPendingRequest: true }]
];
for (const [why, flags] of busyCases) {
  const busy = render(
    createElement(RewindControl, { ...IDLE, ...flags, targets: TARGETS, onRewind: () => undefined })
  );
  assert.ok(busy.includes('data-composer-shortcut="rewind"'), `still present during ${why}`);
  assert.ok(DISABLED_ATTR.test(busy), `disabled during ${why}`);
  assert.ok(
    busy.includes("Available when the agent is idle"),
    `a disabled control must say why it is disabled (${why})`
  );
}

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

const list = render(
  createElement(RewindPickerPanel, { targets: TARGETS, onRewind: () => undefined })
);
assert.ok(list.includes("Rewind to an earlier message"), "the panel names itself");
assert.ok(
  list.includes("The chat goes back to just before the message you pick. Files are not changed."),
  "conversation only, said out loud (§5.5)"
);
assert.equal((list.match(/role="menuitem"/g) ?? []).length, 3, "one row per target");

// Newest first, previewed on one line: the first non-empty line, collapsed.
const newest = list.indexOf("Now wire the settings page");
const middle = list.indexOf("Rename the helper to formatBytes");
const oldest = list.indexOf("(empty message)");
assert.ok(newest !== -1 && middle !== -1 && oldest !== -1, "every target is listed");
assert.ok(newest < middle && middle < oldest, "the rows keep the targets' newest-first order");
assert.ok(!list.includes("and add a test"), "a row previews the first line only");

// The cost of each rewind, singular and plural.
assert.ok(list.includes("removes 1 turn"), "the newest message drops just its own turn");
assert.ok(list.includes("removes 2 turns"));
assert.ok(list.includes("removes 3 turns"));
assert.ok(!list.includes("removes 1 turns"), "singular is singular");
assert.ok(
  list.indexOf("removes 1 turn") < list.indexOf("removes 2 turns") &&
    list.indexOf("removes 2 turns") < list.indexOf("removes 3 turns"),
  "each hint rides its own row"
);

// Attachments are counted on the row, not previewed.
assert.ok(list.includes('title="2 attachments"'), "a message with files says how many");
assert.ok(list.includes('title="1 attachment"'), "singular here too");

// A long thread lists the newest fifty, not all of them.
const many: RewindTarget[] = Array.from({ length: REWIND_PICKER_LIMIT + 10 }, (_, index) => ({
  messageId: `many-${index}`,
  text: `message ${index}`,
  createdAt: "2026-09-22T10:00:00.000Z",
  targetTurnCount: REWIND_PICKER_LIMIT + 9 - index,
  droppedTurnCount: index + 1,
  attachmentCount: 0
}));
const capped = render(createElement(RewindPickerPanel, { targets: many, onRewind: () => undefined }));
assert.equal((capped.match(/role="menuitem"/g) ?? []).length, REWIND_PICKER_LIMIT);
assert.ok(capped.includes("message 0<"), "the newest is kept");
assert.ok(!capped.includes(`message ${REWIND_PICKER_LIMIT}<`), "the oldest past the cap is not");

// ---------------------------------------------------------------------------
// The confirm
// ---------------------------------------------------------------------------

const confirmOne = render(
  createElement(RewindConfirmPanel, {
    text: "Rename the helper to formatBytes",
    droppedTurnCount: 1,
    onConfirm: () => undefined,
    onBack: () => undefined
  })
);
assert.ok(confirmOne.includes("Rename the helper to formatBytes"), "the message is quoted");
assert.ok(confirmOne.includes("line-clamp-3"), "…clamped to three lines");
assert.ok(
  confirmOne.includes(
    "Removes 1 later turn from this chat. Files stay as they are. " +
      "The message returns to the composer so you can edit and resend it."
  ),
  "the sentence names what goes, what stays and where the message ends up"
);
assert.ok(confirmOne.includes(">Rewind</button>"), "the primary action");
assert.ok(confirmOne.includes(">Back</button>"), "and the way out");
assert.ok(
  /<button[^>]*autofocus=""[^>]*>Rewind<\/button>/.test(confirmOne),
  "Rewind is focused on mount, so Enter confirms"
);
assert.ok(!/<button[^>]*autofocus=""[^>]*>Back<\/button>/.test(confirmOne));
assert.ok(!DISABLED_ATTR.test(confirmOne), "idle ⇒ the rewind can go ahead");

const confirmMany = render(
  createElement(RewindConfirmPanel, {
    text: "",
    droppedTurnCount: 4,
    onConfirm: () => undefined,
    onBack: () => undefined
  })
);
assert.ok(confirmMany.includes("Removes 4 later turns from this chat."), "plural is plural");
assert.ok(confirmMany.includes("(empty message)"), "an empty message still quotes something");

const confirmFloor = render(
  createElement(RewindConfirmPanel, {
    text: "x",
    droppedTurnCount: 0,
    onConfirm: () => undefined,
    onBack: () => undefined
  })
);
assert.ok(
  confirmFloor.includes("Removes 1 later turn"),
  "a rewind always removes at least the message's own turn"
);

const confirmBusy = render(
  createElement(RewindConfirmPanel, {
    text: "Rename the helper",
    droppedTurnCount: 2,
    busy: true,
    onConfirm: () => undefined,
    onBack: () => undefined
  })
);
assert.ok(
  /<button[^>]*disabled=""[^>]*>Rewind<\/button>/.test(confirmBusy),
  "a turn that started while the confirm was open disables Rewind"
);
assert.ok(!/<button[^>]*disabled=""[^>]*>Back<\/button>/.test(confirmBusy), "Back always works");
assert.ok(confirmBusy.includes("Available when the agent is idle"), "and it says why");

console.log("rewind-control render checks passed");
