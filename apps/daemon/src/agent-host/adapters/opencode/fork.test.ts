/**
 * Thread lineage — OpenCode's native fork (spec 2026-10-14 §6): where the cut
 * lands in the message list, and the fork call against a fake client.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { forkOpenCodeSession, OPENCODE_FORK_BOUNDARY_GONE, planOpenCodeFork } from "./fork.ts";
import type { OpenCodeClient } from "./http.ts";
import type { OpenCodeMessageWithParts } from "./routes.ts";

const msg = (id: string, role: "user" | "assistant"): OpenCodeMessageWithParts =>
  ({ info: { id, role }, parts: [] }) as unknown as OpenCodeMessageWithParts;

const LIST = [msg("u1", "user"), msg("a1", "assistant"), msg("u2", "user"), msg("a2", "assistant"), msg("a2b", "assistant")];

describe("planOpenCodeFork", () => {
  it("cuts before the prompt that opens the first removed turn", () => {
    // A live turn's id is its prompt; a replayed one's its assistant message.
    assert.deepEqual(planOpenCodeFork(LIST, "u2"), { messageID: "u2", expectedCount: 2 });
    assert.deepEqual(planOpenCodeFork(LIST, "a2b"), { messageID: "u2", expectedCount: 2 });
  });

  it("keeps everything when nothing is removed", () => {
    assert.deepEqual(planOpenCodeFork(LIST, null), { expectedCount: 5 });
  });

  it("refuses an id the session does not hold", () => {
    assert.throws(() => planOpenCodeFork(LIST, "nope"), new RegExp(OPENCODE_FORK_BOUNDARY_GONE));
  });
});

function fakeClient(forkedCount: number) {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const client = {
    async get(path: string) {
      calls.push({ method: "GET", path });
      return path.includes("forked-1") ? LIST.slice(0, forkedCount) : LIST;
    },
    async post(path: string, options: { body?: unknown }) {
      calls.push({ method: "POST", path, body: options.body });
      return { id: "forked-1" };
    }
  } as unknown as OpenCodeClient;
  return { client, calls };
}

describe("forkOpenCodeSession", () => {
  it("forks with the cut's messageID and the thread's directory, then checks the count", async () => {
    const { client, calls } = fakeClient(2);
    const id = await forkOpenCodeSession({
      client,
      sourceSessionId: "ses-1",
      firstRemovedMessageId: "a2",
      directory: "/work/project"
    });
    assert.equal(id, "forked-1");
    const post = calls.find((call) => call.method === "POST");
    assert.match(post!.path, /\/session\/ses-1\/fork$/);
    assert.deepEqual(post!.body, { messageID: "u2", directory: "/work/project" });
    // Nothing re-points or writes to the source: one read, one fork, one read of the fork.
    assert.deepEqual(calls.map((call) => call.method), ["GET", "POST", "GET"]);
  });

  it("refuses a fork that did not keep exactly the cut", async () => {
    const { client } = fakeClient(3);
    await assert.rejects(
      forkOpenCodeSession({
        client,
        sourceSessionId: "ses-1",
        firstRemovedMessageId: "u2",
        directory: "/work/project"
      }),
      /did not preserve/
    );
  });

  it("forks the whole session without a messageID", async () => {
    const { client, calls } = fakeClient(5);
    await forkOpenCodeSession({
      client,
      sourceSessionId: "ses-1",
      firstRemovedMessageId: null,
      directory: "/work/project"
    });
    assert.deepEqual(calls.find((call) => call.method === "POST")!.body, { directory: "/work/project" });
  });
});
