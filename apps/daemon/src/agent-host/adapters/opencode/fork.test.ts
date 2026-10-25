/**
 * Thread lineage — OpenCode's native fork (spec 2026-10-14 §6): where the cut
 * lands in the message list, and the fork call against a fake client.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { forkOpenCodeSession } from "./fork.ts";
import type { OpenCodeClient } from "./http.ts";
import type { OpenCodeMessageWithParts } from "./routes.ts";

const msg = (id: string, role: "user" | "assistant"): OpenCodeMessageWithParts =>
  ({ info: { id, role }, parts: [] }) as unknown as OpenCodeMessageWithParts;

const LIST = [msg("u1", "user"), msg("a1", "assistant"), msg("u2", "user"), msg("a2", "assistant"), msg("a2b", "assistant")];

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
    },
    async delete(path: string) {
      calls.push({ method: "DELETE", path });
      return true;
    }
  } as unknown as OpenCodeClient;
  return { client, calls };
}

describe("forkOpenCodeSession", () => {
  it("refuses a boundary the source no longer holds before creating a fork", async () => {
    const { client, calls } = fakeClient(2);
    await assert.rejects(
      forkOpenCodeSession({ client, sourceSessionId: "ses-1", firstRemovedMessageId: "missing", directory: "/work/project" }),
      /message to fork from is no longer in this conversation/
    );
    assert.equal(calls.some((call) => call.method === "POST"), false, "an unknown cut creates no session");
  });

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
    assert.equal(calls.some((call) => call.method === "DELETE"), false, "the source survives a successful fork");
  });

  it("refuses a fork that did not keep exactly the cut, and deletes the session it made", async () => {
    const { client, calls } = fakeClient(3);
    await assert.rejects(
      forkOpenCodeSession({
        client,
        sourceSessionId: "ses-1",
        firstRemovedMessageId: "u2",
        directory: "/work/project"
      }),
      /did not preserve/
    );
    assert.deepEqual(
      calls.filter((call) => call.method === "DELETE").map((call) => call.path),
      ["/session/forked-1"],
      "no orphan session is left behind, and the source is never deleted"
    );
  });

  it("deletes the fork it cannot read back, and still refuses with the read's failure", async () => {
    const { client, calls } = fakeClient(2);
    const failing = Object.assign(Object.create(client) as OpenCodeClient, {
      async get(path: string) {
        if (path.includes("forked-1")) throw new Error("opencode GET timed out");
        return (client as unknown as { get(path: string): Promise<unknown> }).get(path);
      },
      async delete() {
        calls.push({ method: "DELETE", path: "/session/forked-1" });
        throw new Error("server gone");
      }
    });
    await assert.rejects(
      forkOpenCodeSession({ client: failing, sourceSessionId: "ses-1", firstRemovedMessageId: "u2", directory: "/w" }),
      /timed out/,
      "a delete that fails too never masks why the fork was refused"
    );
    assert.equal(calls.filter((call) => call.method === "DELETE").length, 1);
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
