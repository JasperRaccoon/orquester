import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PUSH_CHANNEL, PUSH_NOTIFICATION_EVENT_TYPE, type PushNotificationEvent } from "@orquester/api";

import {
  desktopBadgeCount,
  desktopNotificationFor,
  observePushEvent,
  parseMenuAction,
  parseNotificationTarget,
  parsePushNotificationEvent,
  subscribePushNotifications,
  type BadgeEntry,
  type NotificationContext
} from "./desktop-host.ts";

const sessionPush: PushNotificationEvent = {
  kind: "needs-input",
  title: "Implement auth in api needs your input",
  body: "",
  tag: "session-c1",
  sessionId: "c1"
};
const workflowPush: PushNotificationEvent = {
  kind: "workflow",
  title: "Workflow failed: Nightly",
  body: "A block failed.",
  tag: "workflow-w1",
  workflowId: "w1",
  runId: "r1"
};
const scriptPush: PushNotificationEvent = { kind: "agent", title: "Backup done", body: "", tag: "orquester-agent" };

const away: NotificationContext = { enabled: true, windowFocused: false, viewingSessionId: null };
const here = (viewingSessionId: string | null): NotificationContext => ({ enabled: true, windowFocused: true, viewingSessionId });

describe("which push becomes a system notification", () => {
  it("shows every push while the window is unfocused, each with its click target", () => {
    assert.deepEqual(desktopNotificationFor(sessionPush, away), {
      title: sessionPush.title,
      body: "",
      tag: "session-c1",
      target: { kind: "session", sessionId: "c1" }
    });
    assert.deepEqual(desktopNotificationFor(workflowPush, away)?.target, { kind: "workflow", workflowId: "w1", runId: "r1" });
    assert.deepEqual(desktopNotificationFor({ ...workflowPush, runId: undefined }, away)?.target, {
      kind: "workflow",
      workflowId: "w1",
      runId: null
    });
    assert.equal(desktopNotificationFor(scriptPush, away)?.target, null);
  });

  it("stays quiet about the session the user is looking at, but not about another one", () => {
    assert.equal(desktopNotificationFor(sessionPush, here("c1")), null);
    assert.equal(desktopNotificationFor(sessionPush, here("c2"))?.tag, "session-c1");
    assert.equal(desktopNotificationFor(sessionPush, here(null))?.tag, "session-c1");
    // The tab is open but the window is not in front: the user is not looking.
    assert.equal(desktopNotificationFor(sessionPush, { ...away, viewingSessionId: "c1" })?.tag, "session-c1");
  });

  it("leaves a workflow run to the in-app toast while the window has focus", () => {
    assert.equal(desktopNotificationFor(workflowPush, here(null)), null);
  });

  it("always shows a push that names nothing, and nothing at all when turned off", () => {
    assert.equal(desktopNotificationFor(scriptPush, here("c1"))?.title, "Backup done");
    for (const push of [sessionPush, workflowPush, scriptPush]) {
      assert.equal(desktopNotificationFor(push, { ...away, enabled: false }), null);
    }
  });
});

describe("the attention badge", () => {
  const entry = (bucket: BadgeEntry["bucket"], attention: "needs-input" | "finished" | "bell" | null = null): BadgeEntry => ({
    bucket,
    activity: { attention }
  });

  it("counts sessions blocked on the user and unseen ends, not seen ends, busy or idle ones", () => {
    assert.equal(desktopBadgeCount([]), 0);
    assert.equal(
      desktopBadgeCount([
        entry("attention", "needs-input"),
        entry("attention", "finished"),
        // A question or approval the user has looked at still waits on them.
        entry("attention"),
        entry("finished", "finished"),
        entry("finished"),
        { bucket: "finished", activity: undefined },
        entry("active"),
        entry("idle")
      ]),
      4
    );
  });
});

describe("payloads off the bus and the bridge", () => {
  it("parses a push event field by field, capping its text and dropping malformed ids", () => {
    assert.deepEqual(parsePushNotificationEvent({ ...sessionPush, extra: 1 }), sessionPush);
    assert.deepEqual(parsePushNotificationEvent(workflowPush), workflowPush);
    const long = parsePushNotificationEvent({ kind: "agent", title: ` ${"t".repeat(300)} `, body: "b".repeat(900), tag: "orquester-agent" });
    assert.equal(long?.title.length, 200);
    assert.equal(long?.body.length, 500);
    assert.deepEqual(parsePushNotificationEvent({ ...sessionPush, body: 7, sessionId: "../x" }), {
      kind: "needs-input",
      title: sessionPush.title,
      body: "",
      tag: "session-c1"
    });
    // A run id without its workflow opens nothing.
    assert.deepEqual(parsePushNotificationEvent({ ...scriptPush, runId: "r1" }), scriptPush);
  });

  it("refuses a push it could not show", () => {
    for (const payload of [
      null,
      "push",
      [],
      { ...sessionPush, kind: "toast" },
      { ...sessionPush, title: "  " },
      { ...sessionPush, title: 5 },
      { ...sessionPush, tag: "" },
      { ...sessionPush, tag: "bad tag" }
    ]) {
      assert.equal(parsePushNotificationEvent(payload), null, JSON.stringify(payload));
    }
  });

  it("parses a clicked notification's target and a menu action strictly", () => {
    assert.deepEqual(parseNotificationTarget({ kind: "session", sessionId: "c1" }), { kind: "session", sessionId: "c1" });
    assert.deepEqual(parseNotificationTarget({ kind: "workflow", workflowId: "w1", runId: "r 1" }), {
      kind: "workflow",
      workflowId: "w1",
      runId: null
    });
    for (const raw of [null, {}, { kind: "session" }, { kind: "session", sessionId: "" }, { kind: "workflow", runId: "r1" }, { kind: "url", url: "x" }]) {
      assert.equal(parseNotificationTarget(raw), null);
    }
    assert.equal(parseMenuAction("open-settings"), "open-settings");
    assert.equal(parseMenuAction("quit"), null);
    assert.equal(parseMenuAction({ action: "open-settings" }), null);
  });

  it("feeds valid push events from the push channel to the listeners until they unsubscribe", () => {
    const heard: PushNotificationEvent[] = [];
    const unsubscribe = subscribePushNotifications((event) => heard.push(event));
    observePushEvent({ channel: PUSH_CHANNEL, type: PUSH_NOTIFICATION_EVENT_TYPE, payload: sessionPush });
    observePushEvent({ channel: PUSH_CHANNEL, type: PUSH_NOTIFICATION_EVENT_TYPE, payload: { kind: "nope" } });
    observePushEvent({ channel: "sessions", type: PUSH_NOTIFICATION_EVENT_TYPE, payload: sessionPush });
    observePushEvent({ channel: PUSH_CHANNEL, type: "push.other", payload: sessionPush });
    unsubscribe();
    observePushEvent({ channel: PUSH_CHANNEL, type: PUSH_NOTIFICATION_EVENT_TYPE, payload: sessionPush });
    assert.deepEqual(heard, [sessionPush]);
  });
});
