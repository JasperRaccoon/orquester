import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  NotificationRegistry,
  parseBadgeCount,
  parseNotificationRequest
} from "./native-notifications";

describe("orquester:notify payloads", () => {
  it("accepts renderer notification targets and trims the title", () => {
    assert.deepEqual(
      parseNotificationRequest({
        title: " Implement auth in api needs your input ",
        body: "",
        tag: "session-c1",
        target: { kind: "session", sessionId: "c1" }
      }),
      { title: "Implement auth in api needs your input", body: "", tag: "session-c1", target: { kind: "session", sessionId: "c1" } }
    );
    assert.deepEqual(
      parseNotificationRequest({
        title: "Workflow failed: Nightly",
        tag: "workflow-w1",
        target: { kind: "workflow", workflowId: "w1", runId: null }
      }),
      { title: "Workflow failed: Nightly", body: "", tag: "workflow-w1", target: { kind: "workflow", workflowId: "w1", runId: null } }
    );
    assert.equal(parseNotificationRequest({ title: "Agent finished", tag: "orquester-agent", target: null })?.target, null);
    // A malformed run id opens the workflow without the run.
    assert.deepEqual(
      parseNotificationRequest({ title: "x", tag: "workflow-w1", target: { kind: "workflow", workflowId: "w1", runId: "../r" } })?.target,
      { kind: "workflow", workflowId: "w1", runId: null }
    );
  });

  it("refuses anything else", () => {
    const valid = { title: "x", body: "", tag: "session-c1", target: { kind: "session", sessionId: "c1" } };
    for (const payload of [
      null,
      "x",
      [],
      { ...valid, title: " " },
      { ...valid, title: 1 },
      { ...valid, body: 2 },
      { ...valid, tag: "" },
      { ...valid, tag: "has space" },
      { ...valid, target: "c1" },
      { ...valid, target: { kind: "session", sessionId: "../c1" } },
      { ...valid, target: { kind: "url", url: "https://example.com" } },
      { ...valid, target: { kind: "workflow" } }
    ]) {
      assert.equal(parseNotificationRequest(payload), null, JSON.stringify(payload));
    }
  });
});

describe("the attention badge", () => {
  it("takes only whole, non-negative attention counts", () => {
    assert.equal(parseBadgeCount(0), 0);
    assert.equal(parseBadgeCount(3), 3);
    for (const payload of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "3", null, { count: 3 }]) {
      assert.equal(parseBadgeCount(payload), null, String(payload));
    }
  });

});

describe("held notifications", () => {
  it("replaces a notification with the same tag and hands back the old one to close", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const registry = new NotificationRegistry<string>();
    assert.equal(registry.hold("session-c1", "first"), undefined);
    assert.equal(registry.hold("session-c1", "second"), "first");
    registry.release("session-c1", "first");
    assert.equal(registry.hold("session-c1", "third"), "second", "a late close must not release its replacement");
  });

  it("lets go on click, close or failure, and on its own once the hold lapses", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const registry = new NotificationRegistry<string>();
    registry.hold("session-c1", "one");
    registry.release("session-c1", "one");
    assert.equal(registry.hold("session-c1", "two"), undefined);
    registry.hold("workflow-w1", "three");
    t.mock.timers.runAll();
    assert.equal(registry.hold("session-c1", "four"), undefined);
    assert.equal(registry.hold("workflow-w1", "five"), undefined);
  });
});
