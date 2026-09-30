/**
 * The open-layer registry: what every app-level key handler reads to know that
 * a modal, a sheet, a menu or a popover is up and owns the next Escape
 * (`anotherLayerOwnsTheKeyboard`). A registry that forgets a layer hands its
 * Escape to the chat, which then interrupts a turn under an open viewer; one
 * that keeps a phantom leaves Escape dead in every chat tab for good.
 */

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { isAnyLayerOpen, openLayer, openTrackedLayer } from "./open-layers.ts";

describe("the open-layer registry", () => {
  const opened: Array<() => void> = [];
  const open = (): (() => void) => {
    const release = openLayer();
    opened.push(release);
    return release;
  };
  // Nothing a test opened may leak into the next one: the registry is module
  // state, exactly as it is in the app.
  afterEach(() => {
    for (const release of opened.splice(0)) release();
    assert.equal(isAnyLayerOpen(), false, "a test left a layer open");
  });

  it("nested layers count separately: closing the inner one leaves the outer one open", () => {
    // A dropdown inside a modal: its Escape closes the dropdown, and the modal
    // still owns the next one.
    const modal = open();
    const dropdown = open();
    dropdown();
    assert.equal(isAnyLayerOpen(), true, "the modal is still up");
    modal();
    assert.equal(isAnyLayerOpen(), false);
  });

  it("a release runs once in effect: a second call never closes another layer", () => {
    // A counter would read 0 here while the second layer is still up — and the
    // chat would take an Escape that layer is waiting for.
    const first = open();
    open();
    first();
    first();
    assert.equal(isAnyLayerOpen(), true, "the second layer is still open");
  });
});

it("a tracked layer knows when a newer one (a dropdown inside a sheet) is above it", () => {
  const sheet = openTrackedLayer();
  assert.equal(sheet.isTopmost(), true);
  const dropdown = openLayer();
  assert.equal(sheet.isTopmost(), false, "the dropdown owns Escape");
  dropdown();
  assert.equal(sheet.isTopmost(), true);
  sheet.release();
  assert.equal(isAnyLayerOpen(), false);
});
