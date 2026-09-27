import test from "node:test";
import assert from "node:assert/strict";

import { keyboardLayerOpen, openKeyboardLayer, resetKeyboardLayers } from "../../lib/keyboard-layers.ts";
import {
  createFocusTracker,
  dockKeyAction,
  focusFellOut,
  otherKeyboardLayerOpen,
  type DockKeyInput
} from "./dock-keyboard.ts";

const escape: DockKeyInput = {
  key: "Escape",
  repeat: false,
  defaultPrevented: false,
  isComposing: false,
  targetInsideDock: true,
  otherLayerOpen: () => false
};

test("an Escape nothing inside the dock handled leaves the dock", () => {
  assert.equal(dockKeyAction(escape), "leave");
});

test("an Escape the panel consumed (the search field clearing itself) stays the panel's", () => {
  assert.equal(dockKeyAction({ ...escape, defaultPrevented: true }), "ignore");
});

test("an Escape an open dropdown, menu or dialog of the panel closes is that layer's alone", () => {
  assert.equal(dockKeyAction({ ...escape, otherLayerOpen: () => true }), "ignore");
});

test("the layer question is asked only for an Escape that would otherwise leave", () => {
  // It re-registers the dock's layer to answer, so it is not asked per key.
  let asked = 0;
  const otherLayerOpen = (): boolean => {
    asked += 1;
    return false;
  };
  dockKeyAction({ ...escape, key: "a", otherLayerOpen });
  dockKeyAction({ ...escape, defaultPrevented: true, otherLayerOpen });
  dockKeyAction({ ...escape, repeat: true, otherLayerOpen });
  assert.equal(asked, 0);
  dockKeyAction({ ...escape, otherLayerOpen });
  assert.equal(asked, 1);
});

test("an IME composition's Escape cancels the composition, nothing else", () => {
  assert.equal(dockKeyAction({ ...escape, isComposing: true }), "ignore");
});

test("a held Escape leaves once: its auto-repeat is not another press", () => {
  // Otherwise the repeats land in the composer the first one focused, and a
  // repeated Escape there interrupts a running turn.
  assert.equal(dockKeyAction({ ...escape, repeat: true }), "ignore");
});

test("keys from a portaled child (a dropdown the panel opened) are never the dock's", () => {
  // React bubbles a portal's events through the dock; the DOM target is outside it.
  assert.equal(dockKeyAction({ ...escape, targetInsideDock: false }), "ignore");
  assert.equal(dockKeyAction({ ...escape, key: "1", targetInsideDock: false }), "ignore");
});

test("every other key typed in the dock is contained there", () => {
  // A question card answers on a bare digit when focus is outside an editable
  // field — a focused prompt card is exactly that, and an answer is final.
  for (const key of ["1", "9", "a", "Enter", "ArrowDown", " ", "Tab"]) {
    assert.equal(dockKeyAction({ ...escape, key }), "contain", key);
  }
  assert.equal(dockKeyAction({ ...escape, key: "1", defaultPrevented: true }), "contain");
  assert.equal(dockKeyAction({ ...escape, key: "Process", isComposing: true }), "contain");
});

test("the layer question sets the dock's own layer aside, and puts it back", () => {
  resetKeyboardLayers();
  const ours = { current: openKeyboardLayer() as (() => void) | null };
  assert.equal(otherKeyboardLayerOpen(ours), false, "ours alone is not another layer");
  assert.equal(keyboardLayerOpen(), true, "and it is held again afterwards");

  const dropdown = openKeyboardLayer();
  assert.equal(otherKeyboardLayerOpen(ours), true, "a dropdown the panel opened is");
  dropdown();
  assert.equal(otherKeyboardLayerOpen(ours), false);

  // The re-registration is the one the dock releases on close.
  ours.current?.();
  assert.equal(keyboardLayerOpen(), false, "releasing the current registration frees the gate");

  // Not holding one: the plain gate.
  const none = { current: null as (() => void) | null };
  assert.equal(otherKeyboardLayerOpen(none), false);
  const modal = openKeyboardLayer();
  assert.equal(otherKeyboardLayerOpen(none), true);
  assert.equal(none.current, null, "asking never registers a layer for a dock that holds none");
  modal();
  resetKeyboardLayers();
});

/**
 * Enough of an element for the focus rules: its attributes, its parent, and
 * the `matches(":disabled")` / `closest("[a],[b]")` a browser would answer.
 */
interface FakeElement {
  name: string;
  isConnected: boolean;
  /** The DOM property — a button inside a disabled `<fieldset>` still reads `false` here. */
  disabled: boolean;
  attributes: Set<string>;
  parent: FakeElement | null;
  matches(selector: string): boolean;
  closest(selector: string): FakeElement | null;
}

function el(name: string, parent: FakeElement | null = null): FakeElement {
  const self: FakeElement = {
    name,
    isConnected: true,
    disabled: false,
    attributes: new Set(),
    parent,
    matches(selector) {
      if (selector !== ":disabled") return false;
      if (self.disabled) return true;
      for (let at = self.parent; at !== null; at = at.parent) {
        if (at.name === "fieldset" && at.attributes.has("disabled")) return true;
      }
      return false;
    },
    closest(selector) {
      const names = selector.split(",").map((part) => /^\[([\w-]+)\]$/.exec(part.trim())?.[1]);
      for (let at: FakeElement | null = self; at !== null; at = at.parent) {
        if (names.some((attribute) => attribute !== undefined && at!.attributes.has(attribute))) return at;
      }
      return null;
    }
  };
  return self;
}

const asElement = (fake: FakeElement): Element => fake as unknown as Element;

test("focus the dock's element lost to a removal, a disable, hidden or inert comes back to the dock", () => {
  const body = asElement(el("body"));
  const removed = el("button");
  removed.isConnected = false;
  const disabled = el("button");
  disabled.disabled = true;
  // `:disabled`, not `.disabled`: a disabled fieldset disables the button inside it.
  const fieldset = el("fieldset");
  fieldset.attributes.add("disabled");
  const inDisabledFieldset = el("button", el("div", fieldset));
  const inert = el("button", el("div"));
  inert.parent!.attributes.add("inert");
  const hidden = el("input", el("section"));
  hidden.parent!.attributes.add("hidden");
  for (const last of [removed, disabled, inDisabledFieldset, inert, hidden]) {
    assert.equal(focusFellOut({ active: body, body, last }), true, last.name);
    assert.equal(focusFellOut({ active: null, body, last }), true, "no active element at all");
  }
  assert.equal(inDisabledFieldset.disabled, false, "the property alone would have missed it");
});

test("focus the user took away is theirs: the dock lets go", () => {
  const body = asElement(el("body"));
  const stillThere = el("button", el("div"));
  // A click on nothing focusable: the element they left is still there, still enabled.
  assert.equal(focusFellOut({ active: body, body, last: stillThere }), false);
  // Focus that moved to another element (the composer) is never pulled back.
  const composer = asElement(el("textarea"));
  const gone = el("button");
  gone.isConnected = false;
  assert.equal(focusFellOut({ active: composer, body, last: gone }), false);
  // Nothing inside ever had focus.
  assert.equal(focusFellOut({ active: body, body, last: null }), false);
});

// ---------------------------------------------------------------------------
// The tracker behind `useFocusInside`
// ---------------------------------------------------------------------------

/** A dock root, a document and the tracker over them; `deferred` holds the post-commit checks. */
function fakeDock() {
  const body = el("body");
  const doc = { activeElement: asElement(body) as Element | null, body: asElement(body) };
  const aside = el("aside");
  const state = { focusable: true };
  const node = Object.assign(aside, {
    contains(other: Element): boolean {
      for (let at: FakeElement | null = other as unknown as FakeElement; at !== null; at = at.parent) {
        if (at === aside) return true;
      }
      return false;
    },
    focus(): void {
      if (state.focusable) doc.activeElement = asElement(aside);
    }
  });
  const inside: boolean[] = [];
  const deferred: Array<() => void> = [];
  const tracker = createFocusTracker({
    node,
    doc,
    setInside: (value) => inside.push(value),
    defer: (task) => {
      deferred.push(task);
      return () => {
        const at = deferred.indexOf(task);
        if (at >= 0) deferred.splice(at, 1);
      };
    }
  });
  /** An element inside the dock, focused. */
  const focusChild = (): FakeElement => {
    const child = el("input", el("div", aside));
    doc.activeElement = asElement(child);
    return child;
  };
  /** The element is removed: detached, and focus falls to <body>. */
  const remove = (child: FakeElement): void => {
    child.isConnected = false;
    child.parent = null;
    if (doc.activeElement === asElement(child)) doc.activeElement = asElement(body);
  };
  const runDeferred = (): void => {
    for (const task of deferred.splice(0)) task();
  };
  return { aside, body, doc, state, tracker, inside, deferred, focusChild, remove, runDeferred };
}

test("a field focused as the panel mounts is recorded by the first look: its removal returns focus to the dock", () => {
  const dock = fakeDock();
  const field = dock.focusChild(); // before any focusin listener exists
  dock.tracker.check();
  assert.deepEqual(dock.inside, [true]);
  dock.remove(field);
  dock.tracker.check(); // the subtree changed
  assert.equal(dock.doc.activeElement, asElement(dock.aside), "focus is back on the dock's root");
  assert.equal(dock.inside.at(-1), true, "and the layer stays");
});

test("a dock root that refuses focus lets the layer go rather than holding it for nobody", () => {
  const dock = fakeDock();
  const field = dock.focusChild();
  dock.tracker.check();
  dock.state.focusable = false;
  dock.remove(field);
  dock.tracker.check();
  assert.equal(dock.doc.activeElement, asElement(dock.body));
  assert.equal(dock.inside.at(-1), false);
  // Nothing is remembered: the next look does not try again.
  dock.state.focusable = true;
  dock.tracker.check();
  assert.equal(dock.doc.activeElement, asElement(dock.body));
  assert.equal(dock.inside.at(-1), false);
});

test("focus moving inside keeps the layer; focus taken to another element releases it", () => {
  const dock = fakeDock();
  const field = dock.focusChild();
  dock.tracker.focusIn(field);
  dock.tracker.focusOut(true);
  assert.deepEqual(dock.inside, [true], "within the dock: nothing to decide");
  dock.tracker.focusOut(false);
  assert.deepEqual(dock.inside, [true, false]);
  // Released means forgotten: that element's later removal pulls nothing back.
  dock.doc.activeElement = asElement(dock.body);
  dock.remove(field);
  dock.tracker.check();
  assert.equal(dock.doc.activeElement, asElement(dock.body));
});

test("focus that goes nowhere is decided once the commit is done", () => {
  // A click on nothing focusable: the element is still there — the user left.
  const clicked = fakeDock();
  const kept = clicked.focusChild();
  clicked.tracker.focusIn(kept);
  clicked.doc.activeElement = asElement(clicked.body);
  clicked.tracker.focusOut(null);
  assert.deepEqual(clicked.inside, [true], "not decided mid-commit");
  clicked.runDeferred();
  assert.deepEqual(clicked.inside, [true, false]);

  // The focused element went away in that commit: focus comes back.
  const removed = fakeDock();
  const gone = removed.focusChild();
  removed.tracker.focusIn(gone);
  removed.remove(gone);
  removed.tracker.focusOut(null);
  removed.tracker.focusOut(null);
  assert.equal(removed.deferred.length, 1, "one pending check, however many focusouts");
  removed.runDeferred();
  assert.equal(removed.doc.activeElement, asElement(removed.aside));
  assert.equal(removed.inside.at(-1), true);

  // The dock unmounting cancels it.
  const closing = fakeDock();
  closing.tracker.focusIn(closing.focusChild());
  closing.tracker.focusOut(null);
  closing.tracker.dispose();
  assert.equal(closing.deferred.length, 0);
});

test("focus that landed on another element outside is never pulled back, whatever became of the last one", () => {
  const dock = fakeDock();
  const field = dock.focusChild();
  dock.tracker.check();
  const composer = el("textarea");
  dock.remove(field);
  dock.doc.activeElement = asElement(composer);
  dock.tracker.check();
  assert.equal(dock.doc.activeElement, asElement(composer));
  assert.equal(dock.inside.at(-1), false);
});
