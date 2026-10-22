import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  BADGE_MAX,
  badgeDescription,
  badgeOverlayBitmap,
  parseBadgeCount,
  parseNotificationRequest
} from "./native-notifications";

describe("orquester:notify payloads", () => {
  it("accepts what the renderer sends, trimming and capping the text", () => {
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
    const long = parseNotificationRequest({ title: "t".repeat(400), body: "b".repeat(900), tag: "orquester-agent", target: null });
    assert.equal(long?.title.length, 200);
    assert.equal(long?.body.length, 500);
    assert.equal(long?.target, null);
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
  it("takes a whole, non-negative count and caps it", () => {
    assert.equal(parseBadgeCount(0), 0);
    assert.equal(parseBadgeCount(3), 3);
    assert.equal(parseBadgeCount(1_000_000), BADGE_MAX);
    for (const payload of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "3", null, { count: 3 }]) {
      assert.equal(parseBadgeCount(payload), null, String(payload));
    }
  });

  it("describes the Windows overlay for a screen reader", () => {
    assert.equal(badgeDescription(0), "");
    assert.equal(badgeDescription(1), "1 session needs your attention");
    assert.equal(badgeDescription(4), "4 sessions need your attention");
  });

  it("draws the overlay as a premultiplied BGRA red dot with transparent corners", () => {
    const size = 16;
    const pixels = badgeOverlayBitmap(size);
    assert.equal(pixels.length, size * size * 4);
    const at = (x: number, y: number) => [...pixels.subarray((y * size + x) * 4, (y * size + x) * 4 + 4)];
    assert.deepEqual(at(8, 8), [0x4d, 0x48, 0xe5, 255]);
    assert.deepEqual(at(0, 0), [0, 0, 0, 0]);
    for (let i = 0; i < pixels.length; i += 4) {
      // Premultiplied: no channel exceeds its alpha.
      assert.ok(pixels[i]! <= pixels[i + 3]! && pixels[i + 1]! <= pixels[i + 3]! && pixels[i + 2]! <= pixels[i + 3]!);
    }
  });
});
