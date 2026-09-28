import assert from "node:assert/strict";
import test from "node:test";

import {
  failureReasonOfActivity,
  latestFailureReason
} from "./failure-reason.ts";
import type { ThreadActivityItem, ThreadMessageItem } from "./thread.ts";

let ids = 0;
function activity(
  activityKind: string,
  payload: unknown,
  extra: Partial<ThreadActivityItem> = {}
): ThreadActivityItem {
  ids += 1;
  return {
    kind: "activity",
    id: `a${ids}`,
    tone: activityKind === "runtime.error" ? "error" : "info",
    activityKind,
    summary: activityKind === "runtime.error" ? "Runtime error" : "summary",
    payload,
    turnId: "turn-1",
    createdAt: `2026-09-28T10:00:${String(ids % 60).padStart(2, "0")}.000Z`,
    updatedAt: `2026-09-28T10:00:${String(ids % 60).padStart(2, "0")}.000Z`,
    ...extra
  };
}

test("the structured reason and reset are read off the payload", () => {
  const row = activity("runtime.error", {
    message: "Rate limit",
    class: "provider_error",
    reason: "usage_limit",
    resetsAt: "2026-09-28T22:40:00Z"
  });
  assert.deepEqual(failureReasonOfActivity(row), {
    reason: "usage_limit",
    resetsAt: "2026-09-28T22:40:00.000Z",
    message: "Rate limit",
    tone: "error",
    legacy: false
  });
  assert.deepEqual(
    failureReasonOfActivity(activity("runtime.warning", { message: "x", reason: "auth" })),
    { reason: "auth", message: "x", tone: "info", legacy: false }
  );
});

test("an unreadable reset is dropped, never guessed", () => {
  const failure = failureReasonOfActivity(
    activity("runtime.error", { message: "m", class: "provider_error", reason: "usage_limit", resetsAt: "soon" })
  );
  assert.equal(failure?.reason, "usage_limit");
  assert.equal(failure?.resetsAt, undefined);
});

test("only runtime.error and runtime.warning rows name a failure", () => {
  assert.equal(
    failureReasonOfActivity(activity("tool.completed", { message: "m", reason: "usage_limit" })),
    null
  );
  assert.equal(
    failureReasonOfActivity(activity("runtime.error", { message: "boom", class: "provider_error" })),
    null
  );
});

test("an unknown reason is no failure this reader knows — and never read by its text", () => {
  assert.equal(
    failureReasonOfActivity(
      activity("runtime.error", { message: "Claude usage limit reached. x", reason: "quota_v2" })
    ),
    null
  );
});

test("legacy: the adapters' real sentences", () => {
  for (const message of [
    "Claude usage limit reached. This turn is paused until the 5-hour limit resets in 2h 5m.",
    "Claude usage limit reached. Send the message again once the limit resets.",
    "Grok usage limit reached. Try again later."
  ]) {
    assert.equal(failureReasonOfActivity(activity("runtime.warning", { message }))?.reason, "usage_limit");
  }
  assert.equal(
    failureReasonOfActivity(
      activity("runtime.error", {
        message: "Claude is not logged in for this account. Open Settings → Accounts and sign in again.",
        class: "permission_error"
      })
    )?.reason,
    "auth"
  );
});

test("legacy: a parked-turn warning's reset comes from its rate_limit_info detail", () => {
  const failure = failureReasonOfActivity(
    activity("runtime.warning", {
      message: "Claude usage limit reached. This turn is paused until the 5-hour limit resets in 2h.",
      detail: { status: "rejected", resetsAt: 1789969200, rateLimitType: "five_hour" }
    })
  );
  assert.equal(failure?.resetsAt, new Date(1789969200 * 1000).toISOString());
  assert.equal(failure?.legacy, true);
});

test("legacy: a prefix only counts at the start, and not when a reason is present", () => {
  assert.equal(
    failureReasonOfActivity(activity("runtime.error", { message: "Note: Claude usage limit reached." })),
    null
  );
  const structured = failureReasonOfActivity(
    activity("runtime.error", { message: "Claude usage limit reached.", reason: "auth" })
  );
  assert.equal(structured?.reason, "auth");
  assert.equal(structured?.legacy, false);
});

test("the summary stands in for a payload with no message", () => {
  const failure = failureReasonOfActivity(
    activity("runtime.warning", { reason: "usage_limit" }, { summary: "Grok usage limit reached." })
  );
  assert.equal(failure?.message, "Grok usage limit reached.");
});

test("latestFailureReason: the newest failure, messages skipped", () => {
  const message: ThreadMessageItem = {
    kind: "message",
    id: "m1",
    role: "assistant",
    text: "Claude usage limit reached.",
    turnId: "turn-1",
    streaming: false,
    createdAt: "2026-09-28T11:00:00.000Z",
    updatedAt: "2026-09-28T11:00:00.000Z"
  } as ThreadMessageItem;
  const first = activity("runtime.error", { message: "a", reason: "auth" });
  const second = activity("runtime.warning", { message: "b", reason: "usage_limit" });
  const other = activity("runtime.error", { message: "boom", class: "provider_error" });
  assert.equal(latestFailureReason([first, second, other, message])?.message, "b");
  assert.equal(latestFailureReason([message, other]), null);
  assert.equal(latestFailureReason([]), null);
});

test("latestFailureReason: a baseline by time or by item id", () => {
  const before = activity(
    "runtime.error",
    { message: "old", reason: "usage_limit" },
    { createdAt: "2026-09-28T09:00:00.000Z" }
  );
  const baseline = activity("tool.completed", {}, { createdAt: "2026-09-28T09:30:00.000Z" });
  const after = activity(
    "runtime.error",
    { message: "new", reason: "auth" },
    { createdAt: "2026-09-28T10:00:00.000Z" }
  );
  assert.equal(latestFailureReason([before], { afterCreatedAt: "2026-09-28T09:30:00Z" }), null);
  assert.equal(
    latestFailureReason([before, baseline, after], { afterCreatedAt: "2026-09-28T09:30:00Z" })?.message,
    "new"
  );
  assert.equal(latestFailureReason([before, baseline], { afterItemId: baseline.id }), null);
  assert.equal(
    latestFailureReason([before, baseline, after], { afterItemId: baseline.id })?.message,
    "new"
  );
  // An id the list no longer holds cuts nothing.
  assert.equal(latestFailureReason([before], { afterItemId: "gone" })?.message, "old");
});
