import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { SessionSummary } from "@orquester/api";

import { openChatsUsingProfile, profileDeleteChatsLine, sessionProfileIdOf } from "./chat-usage.ts";

function tab(id: string, fields: Omit<Partial<SessionSummary>, "profileId"> & { profileId?: unknown } = {}): SessionSummary {
  return {
    id,
    kind: "agent-chat",
    refId: "claude",
    title: id,
    projectPath: "/w/p",
    cwd: "/w/p",
    cols: 0,
    rows: 0,
    status: "running",
    order: 0,
    createdAt: "2026-10-18T00:00:00.000Z",
    ...fields
  } as SessionSummary;
}

describe("sessionProfileIdOf", () => {
  it("reads a chat tab's profile and treats everything else as Global", () => {
    assert.equal(sessionProfileIdOf(tab("a", { profileId: "p1" })), "p1");
    assert.equal(sessionProfileIdOf(tab("b", { profileId: null })), null);
    assert.equal(sessionProfileIdOf(tab("c")), null, "an older daemon omits it");
    assert.equal(sessionProfileIdOf(tab("d", { profileId: 7 })), null);
    assert.equal(sessionProfileIdOf(tab("e", { profileId: "" })), null);
    assert.equal(sessionProfileIdOf(tab("f", { profileId: "x".repeat(129) })), null);
    assert.equal(sessionProfileIdOf(tab("g", { kind: "terminal" as SessionSummary["kind"], profileId: "p1" })), null);
  });
});

describe("openChatsUsingProfile", () => {
  it("counts the open chats launching with the profile", () => {
    const sessions = [
      tab("a", { profileId: "p1" }),
      tab("b", { profileId: "p1" }),
      tab("c", { profileId: "p2" }),
      tab("d", { profileId: null }),
      tab("e", { profileId: "p1", status: "exited" })
    ];
    assert.equal(openChatsUsingProfile(sessions, "p1"), 2);
    assert.equal(openChatsUsingProfile(sessions, "p2"), 1);
    assert.equal(openChatsUsingProfile(sessions, "p3"), 0);
  });

  it("words the delete confirmation for none, one and many", () => {
    assert.equal(profileDeleteChatsLine(0), "No open chat uses it.");
    assert.match(profileDeleteChatsLine(1), /^1 open chat uses it/);
    assert.match(profileDeleteChatsLine(3), /^3 open chats use it/);
  });
});
