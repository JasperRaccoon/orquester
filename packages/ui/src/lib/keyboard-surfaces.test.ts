import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  insideKeyboardOwner,
  insideKeyboardSurface,
  KEYBOARD_SURFACE_ATTRIBUTE,
  KEYBOARD_SURFACE_PROPS
} from "./keyboard-surfaces";

/** Enough of an Element for `closest`: a chain of parents, each with its attributes. */
interface FakeElement {
  attributes: Record<string, string>;
  parent: FakeElement | null;
  closest(selector: string): unknown;
}

/** Matches the selector lists the module builds: `[name]` and `[name="value"]`, comma-separated. */
function matches(node: FakeElement, selector: string): boolean {
  return selector.split(",").some((part) => {
    const match = /^\[([^=\]]+)(?:="([^"]*)")?\]$/.exec(part.trim());
    if (!match) return false;
    const [, name, value] = match;
    return name! in node.attributes && (value === undefined || node.attributes[name!] === value);
  });
}

function element(attributes: Record<string, string>, parent: FakeElement | null = null): FakeElement {
  const node: FakeElement = {
    attributes,
    parent,
    closest(selector: string): unknown {
      for (let at: FakeElement | null = node; at !== null; at = at.parent) {
        if (matches(at, selector)) return at;
      }
      return null;
    }
  };
  return node;
}

const target = (node: FakeElement) => node as unknown as EventTarget;

describe("insideKeyboardSurface", () => {
  it("owns keys typed anywhere inside a rail surface", () => {
    const surface = element({ [KEYBOARD_SURFACE_ATTRIBUTE]: "" });
    assert.equal(insideKeyboardSurface(target(element({}, element({}, surface)))), true);
    assert.equal(insideKeyboardSurface(target(surface)), true);
  });

  it("owns keys typed inside any modal dialog or sheet", () => {
    const dialog = element({ role: "dialog", "aria-modal": "true" });
    assert.equal(insideKeyboardSurface(target(element({}, dialog))), true);
  });

  it("leaves the chat's own popovers (menus, not modal) and the page to the chat", () => {
    const popover = element({ role: "menu", "data-chat-composer-floating-layer": "true" });
    assert.equal(insideKeyboardSurface(target(element({}, popover))), false);
    assert.equal(insideKeyboardSurface(target(element({}, element({ "data-other": "" })))), false);
    assert.equal(insideKeyboardSurface(null), false);
    assert.equal(insideKeyboardSurface({} as EventTarget), false, "window, document: no closest()");
  });

  it("marks a root with the attribute it looks for", () => {
    assert.deepEqual(Object.keys(KEYBOARD_SURFACE_PROPS), [KEYBOARD_SURFACE_ATTRIBUTE]);
  });
});

describe("insideKeyboardOwner", () => {
  it("adds menus and listboxes: a digit on a menu item is the menu's", () => {
    assert.equal(insideKeyboardOwner(target(element({ role: "menuitem" }, element({ role: "menu" })))), true);
    assert.equal(insideKeyboardOwner(target(element({ role: "option" }))), true);
    assert.equal(insideKeyboardOwner(target(element({}, element({ role: "listbox" })))), true);
  });

  it("still owns what a surface owns, and leaves the page to the chat", () => {
    assert.equal(insideKeyboardOwner(target(element({ "aria-modal": "true" }))), true);
    assert.equal(insideKeyboardOwner(target(element({ [KEYBOARD_SURFACE_ATTRIBUTE]: "" }))), true);
    assert.equal(insideKeyboardOwner(target(element({}))), false, "the body, the chat's own content");
  });
});
