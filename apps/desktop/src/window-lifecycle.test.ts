import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { canDeliverToRenderer, planShowWindow, RendererOutbox, replacementShows } from "./window-lifecycle";

describe("showing the window during a titlebar rebuild", () => {
  it("brings the window on screen forward, mid-rebuild too, instead of opening a third", () => {
    assert.equal(planShowWindow({ hasMain: true, rebuilding: false }), "show-main");
    assert.equal(planShowWindow({ hasMain: true, rebuilding: true }), "show-main");
  });

  it("creates a window only when there is none and none is on its way", () => {
    assert.equal(planShowWindow({ hasMain: false, rebuilding: false }), "create");
    assert.equal(planShowWindow({ hasMain: false, rebuilding: true }), "wait");
  });

  it("lets the replacement show only in place of a window that was showing", () => {
    assert.equal(replacementShows({ destroyed: false, visible: true }), true);
    assert.equal(replacementShows({ destroyed: false, visible: false }), false, "hidden to the tray stays hidden");
    assert.equal(replacementShows({ destroyed: true, visible: true }), false);
  });
});

describe("messages for the renderer", () => {
  it("go only to a loaded main page, and wait out a rebuild for the replacement", () => {
    assert.equal(canDeliverToRenderer({ mainLoaded: true, rebuilding: false }), true);
    assert.equal(canDeliverToRenderer({ mainLoaded: false, rebuilding: false }), false);
    assert.equal(canDeliverToRenderer({ mainLoaded: true, rebuilding: true }), false);
  });

  it("queues messages in order and drains them once", () => {
    const outbox = new RendererOutbox<string>();
    const messages = ["a", "b", "c"];
    for (const message of messages) outbox.push(message);
    assert.deepEqual(outbox.drain(), ["a", "b", "c"]);
    assert.deepEqual(outbox.drain(), []);
  });
});
