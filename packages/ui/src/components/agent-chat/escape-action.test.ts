import test from "node:test";
import assert from "node:assert/strict";

import { resolveChatEscape, type ChatEscapeInput } from "./escape-action.ts";

const base: ChatEscapeInput = {
  key: "Escape",
  defaultPrevented: false,
  isActiveTab: true,
  blockingLayerOpen: false,
  insideComposer: false,
  drillInOpen: false,
  turnActive: false
};

test("Escape leaves the drill-in — the case a React root handler could not see", () => {
  // The repro: open a drill-in, click a non-focusable row, `activeElement` is
  // `<body>`, and a handler on the chat root never fires again.
  assert.equal(resolveChatEscape({ ...base, drillInOpen: true }), "close-drill-in");
});

test("the drill-in wins over the interrupt", () => {
  // "Take me back", not "stop the agent": leaving a child view is the narrower
  // and reversible action. Getting this backwards is what the two competing
  // window listeners produced.
  assert.equal(
    resolveChatEscape({ ...base, drillInOpen: true, turnActive: true }),
    "close-drill-in"
  );
});

test("Escape interrupts a running turn from anywhere in the tab", () => {
  assert.equal(resolveChatEscape({ ...base, turnActive: true }), "interrupt");
});

test("Escape does nothing with no drill-in and no turn", () => {
  assert.equal(resolveChatEscape(base), "ignore");
});

test("a hidden tab never acts, whatever it is doing", () => {
  // Every chat tab stays mounted (§7.1), so without this one Escape would stop
  // an agent in a thread the user cannot see.
  assert.equal(
    resolveChatEscape({ ...base, isActiveTab: false, turnActive: true }),
    "ignore"
  );
  assert.equal(
    resolveChatEscape({ ...base, isActiveTab: false, drillInOpen: true }),
    "ignore"
  );
});

test("a blocking layer keeps the key: Escape closes the modal, not the thread", () => {
  assert.equal(
    resolveChatEscape({ ...base, blockingLayerOpen: true, turnActive: true }),
    "ignore"
  );
});

test("focus inside the composer belongs to the composer's own arm, not this one", () => {
  assert.equal(
    resolveChatEscape({ ...base, insideComposer: true, turnActive: true }),
    "ignore"
  );
  assert.equal(
    resolveChatEscape({ ...base, insideComposer: true, drillInOpen: true }),
    "ignore"
  );
});

test("an event another listener already handled is not handled twice", () => {
  assert.equal(
    resolveChatEscape({ ...base, defaultPrevented: true, turnActive: true }),
    "ignore"
  );
});

test("only Escape", () => {
  for (const key of ["Enter", "Esc", "escape", "a", ""]) {
    assert.equal(resolveChatEscape({ ...base, key, drillInOpen: true }), "ignore", key);
  }
});
