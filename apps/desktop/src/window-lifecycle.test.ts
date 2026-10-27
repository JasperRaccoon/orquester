import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { RendererOutbox } from "./window-lifecycle";

describe("messages for the renderer", () => {
  it("queues messages in order and drains them once", () => {
    const outbox = new RendererOutbox<string>();
    const messages = ["a", "b", "c"];
    for (const message of messages) outbox.push(message);
    assert.deepEqual(outbox.drain(), ["a", "b", "c"]);
    assert.deepEqual(outbox.drain(), []);
  });
});
