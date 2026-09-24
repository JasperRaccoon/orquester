import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { keyboardLayerOpen, openKeyboardLayer, resetKeyboardLayers } from "./keyboard-layers";

beforeEach(() => {
  resetKeyboardLayers();
});

describe("the open keyboard layers", () => {
  it("none is open until one registers, and none after it releases", () => {
    assert.equal(keyboardLayerOpen(), false);
    const release = openKeyboardLayer();
    assert.equal(keyboardLayerOpen(), true);
    release();
    assert.equal(keyboardLayerOpen(), false);
  });

  it("counts: a layer closing under another leaves the other open", () => {
    const outer = openKeyboardLayer();
    const inner = openKeyboardLayer();
    inner();
    assert.equal(keyboardLayerOpen(), true, "a dropdown inside a modal closed; the modal is still up");
    outer();
    assert.equal(keyboardLayerOpen(), false);
  });

  it("a release is idempotent — a double cleanup never releases somebody else's layer", () => {
    const first = openKeyboardLayer();
    const second = openKeyboardLayer();
    first();
    first();
    assert.equal(keyboardLayerOpen(), true, "the second layer is still counted");
    second();
    assert.equal(keyboardLayerOpen(), false);
  });
});
