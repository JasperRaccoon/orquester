/**
 * Thread lineage (spec 2026-10-14 §6): a fork whose outcome is unknown — the
 * daemon answered HOST_UNAVAILABLE, or nothing came back — is retried by the
 * next "Fork from here" on the same point under the SAME `commandId`, so the
 * daemon answers the fork it may already hold instead of opening a second one
 * beside a stray tab. A fork that answered frees its point.
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import type { ForkSessionRequest, ForkSessionResponse, ProjectSummary, SessionSummary } from "@orquester/api";

import { ApiError } from "../lib/api-client.ts";
import { useAppStore } from "./app.ts";

const P = "/w/acme/app";
const store = () => useAppStore.getState();

const tab = (id: string): SessionSummary =>
  ({ id, kind: "agent-chat", refId: "claude", title: id, projectPath: P, cwd: P, cols: 0, rows: 0, status: "running", order: 0, createdAt: "t" }) as SessionSummary;

/** A daemon whose fork answers are scripted per call: an error to throw, or the fork. */
function fakeApi(answers: Array<Error | null>) {
  const sent: ForkSessionRequest[] = [];
  return {
    sent,
    api: {
      async forkSession(_id: string, req: ForkSessionRequest): Promise<ForkSessionResponse> {
        sent.push(req);
        const answer = answers.shift() ?? null;
        if (answer) throw answer;
        return {
          session: tab(`fork-of-${req.commandId}`),
          lineage: { parentThreadId: "parent", relation: "fork", createdAt: "t" },
          strategy: "native"
        };
      }
    }
  };
}

const unavailable = () =>
  new ApiError(503, "POST", "/api/sessions/parent/fork", {}, { error: { code: "HOST_UNAVAILABLE", message: "restarting" } });
const refused = () =>
  new ApiError(409, "POST", "/api/sessions/parent/fork", {}, { error: { code: "COMMAND_REJECTED", message: "still being written" } });

beforeEach(() => {
  useAppStore.setState({ currentProject: { path: P, name: "app" } as ProjectSummary, sessions: [tab("parent")], activeTabByProject: {} });
});

describe("forkChatTab's retry", () => {
  it("re-sends the same commandId after an unknown outcome, and a fresh one once it answered", async () => {
    const world = fakeApi([unavailable(), new TypeError("Failed to fetch"), null, null]);
    useAppStore.setState({ api: world.api as never });
    const point = { messageId: "m1", turnId: "t1", role: "assistant" as const };
    await assert.rejects(store().forkChatTab("parent", point));
    await assert.rejects(store().forkChatTab("parent", point), /Failed to fetch/);
    await store().forkChatTab("parent", point);
    const [first, second, third] = world.sent.map((req) => req.commandId);
    assert.ok(first);
    assert.equal(second, first, "the retry after HOST_UNAVAILABLE converges on the same fork");
    assert.equal(third, first, "…and after no answer at all");
    // It answered: the next fork from the same point is a new fork.
    await store().forkChatTab("parent", point);
    assert.notEqual(world.sent[3]!.commandId, first);
  });

  it("a refusal frees the point, and another fork point never reuses the id", async () => {
    const world = fakeApi([refused(), unavailable(), null]);
    useAppStore.setState({ api: world.api as never });
    await assert.rejects(store().forkChatTab("parent", { messageId: "m1", role: "assistant" }));
    await assert.rejects(store().forkChatTab("parent", { messageId: "m1", role: "assistant" }));
    await store().forkChatTab("parent", { messageId: "m2", role: "assistant" });
    const [a, b, c] = world.sent.map((req) => req.commandId);
    assert.notEqual(b, a, "nothing was opened by a refused fork: a new click is a new command");
    assert.notEqual(c, b, "another message is another fork");
  });
});
