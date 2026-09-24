/**
 * Render smoke checks for the account chip (§3.4's account switch, §7.4).
 *
 * `account-switch.test.ts` owns the rules (the gate, the options, the labels);
 * this exists because "the chip is a disabled button while the agent is busy",
 * "it carries the `account` token so one keybinding handler can address it"
 * and "an OpenCode thread still gets a plain label, not a control that could
 * only refuse" are claims about *markup* — and a React prop mistake typechecks
 * perfectly while rendering nothing.
 *
 * Static markup only — no DOM, no effects — like every other `*.check.ts`.
 */

import assert from "node:assert/strict";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { ChatAccountOption } from "../../../lib/agent-chat/account-switch";
import { AccountChip } from "./ComposerChips";

/**
 * What React's server renderer prints, once per render, for the picker's
 * `ComposerPopover`: its `useLayoutEffect` positions an open menu, and on the
 * server nothing runs it. True, and beside the point for a markup check.
 */
const SSR_LAYOUT_EFFECT_WARNING = "Warning: useLayoutEffect does nothing on the server";

/**
 * The static markup, with exactly that one `console.error` dropped while it
 * renders — every other call still prints, and `console.error` is itself
 * again once the render returns or throws.
 */
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

const OPTIONS: ChatAccountOption[] = [
  { id: "system", label: "System", needsReauth: false },
  { id: "acc-1", label: "one", needsReauth: false }
];

// ---------------------------------------------------------------------------
// The picker
// ---------------------------------------------------------------------------

const idle = render(
  createElement(AccountChip, {
    label: "one",
    options: OPTIONS,
    selectedId: "acc-1",
    canSwitch: true,
    onChange: () => undefined
  })
);
assert.ok(idle.includes("<button"), "an idle thread's chip is a control, not a label");
assert.ok(
  idle.includes('data-composer-shortcut="account"'),
  "the token is what makes the chip addressable by the one keybinding handler"
);
// The HTML attribute, not the `disabled:` Tailwind variants in the class list.
const DISABLED_ATTR = /\sdisabled=""/;
assert.ok(!DISABLED_ATTR.test(idle), "nothing in flight ⇒ the picker opens");
assert.ok(idle.includes("one"), "the chip shows the account it is running as");

const busy = render(
  createElement(AccountChip, {
    label: "one",
    options: OPTIONS,
    selectedId: "acc-1",
    canSwitch: false,
    onChange: () => undefined
  })
);
assert.ok(busy.includes("<button"), "still a control, so the tooltip can explain itself");
assert.ok(DISABLED_ATTR.test(busy), "a turn, a request, a queue or a revert closes the picker");
assert.ok(
  busy.includes("Available when the agent is idle"),
  "a disabled control must say why it is disabled"
);

// Goals §5.5: a continuing goal holds the chip for something the user must
// DO — pause the goal — and the chip says that instead of "wait".
const goalHeld = render(
  createElement(AccountChip, {
    label: "one",
    options: OPTIONS,
    selectedId: "acc-1",
    canSwitch: false,
    disabledReason: "Pause the goal before switching accounts.",
    onChange: () => undefined
  })
);
assert.ok(DISABLED_ATTR.test(goalHeld), "a continuing goal closes the picker");
assert.ok(
  goalHeld.includes("Pause the goal before switching accounts."),
  "and the chip says what would open it"
);
assert.ok(!goalHeld.includes("Available when the agent is idle"), "not a wait that never ends");

// ---------------------------------------------------------------------------
// The label-only fallback
// ---------------------------------------------------------------------------

// An OpenCode thread: its server owns the identity, so there is nothing to
// pick and the chip stays what it always was.
const label = render(createElement(AccountChip, { label: "System" }));
assert.ok(!label.includes("<button"), "no control where a switch is impossible");
assert.ok(!label.includes("data-composer-shortcut"), "and therefore no shortcut target");
assert.ok(label.includes("Running as System"));

// An empty option list is the same case — a menu of nothing is not a menu.
const empty = render(
  createElement(AccountChip, { label: "System", options: [], onChange: () => undefined })
);
assert.ok(!empty.includes("<button"));

console.log("account-chip render checks passed");
