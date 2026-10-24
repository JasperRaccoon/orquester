/** The on-demand agent rows loader (`agent-rows.logic.ts`) on its own: what it asks for, when, and how it reads answers. */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { AGENT_ROWS_MAX_AGENTS, type AgentRowsRequest } from "@orquester/api/agent-chat";

import { AgentRowsLoader, type AgentRowsView } from "./agent-rows.logic";

function harness(answer: (body: AgentRowsRequest) => Promise<unknown> = async () => ({ ok: true })) {
  const posts: AgentRowsRequest[] = [];
  const deferred: Array<() => void> = [];
  const timers: Array<{ run: () => void; delayMs: number; cancelled: boolean }> = [];
  const events = { unsupported: 0, noStream: 0 };
  const loader = new AgentRowsLoader({
    request: (body) => {
      posts.push(body);
      return answer(body);
    },
    onUnsupported: () => {
      events.unsupported += 1;
    },
    onNoStream: () => {
      events.noStream += 1;
    },
    defer: (run) => deferred.push(run),
    schedule: (run, delayMs) => {
      const timer = { run, delayMs, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    }
  });
  const flush = async (): Promise<void> => {
    for (const run of deferred.splice(0)) run();
    await new Promise((resolve) => setImmediate(resolve));
  };
  return { loader, posts, timers, events, flush };
}

const view = (overrides: Partial<AgentRowsView> = {}): AgentRowsView => ({
  omitted: ["a", "b", "c"],
  streamId: "s-1",
  live: true,
  activeAgentIds: new Set(),
  ...overrides
});

describe("on-demand agent rows — the loader", () => {
  it("asks for the wanted, the touched and the active omitted agents only, once per stream", async () => {
    const h = harness();
    h.loader.sync(view({ activeAgentIds: new Set(["c", "z"]) }));
    const release = h.loader.want("a");
    h.loader.want("q");
    h.loader.touch(["b"]);
    h.loader.sync(view({ activeAgentIds: new Set(["c", "z"]) }));
    await h.flush();
    assert.deepEqual(h.posts, [{ streamId: "s-1", agentIds: ["a", "b", "c"] }]);
    h.loader.sync(view({ activeAgentIds: new Set(["c"]) }));
    await h.flush();
    assert.equal(h.posts.length, 1, "in flight: not asked twice");
    // A new stream forgets what was asked on the old one.
    h.loader.sync(view({ streamId: "s-2", activeAgentIds: new Set(["c"]) }));
    await h.flush();
    assert.deepEqual(h.posts.at(-1), { streamId: "s-2", agentIds: ["a", "b", "c"] });
    release();
    assert.equal(h.loader.isWanted("a"), false);
  });

  it("asks nothing before the stream is live, and nothing for an agent no longer omitted", async () => {
    const h = harness();
    h.loader.want("a");
    h.loader.sync(view({ live: false }));
    await h.flush();
    assert.deepEqual(h.posts, []);
    h.loader.sync(view({ omitted: ["b"] }));
    await h.flush();
    assert.deepEqual(h.posts, []);
  });

  it("splits a request past the cap", async () => {
    const h = harness();
    const omitted = Array.from({ length: AGENT_ROWS_MAX_AGENTS + 3 }, (_, index) => `agent-${String(index).padStart(3, "0")}`);
    h.loader.sync(view({ omitted, activeAgentIds: new Set(omitted) }));
    await h.flush();
    assert.deepEqual(h.posts.map((post) => post.agentIds.length), [AGENT_ROWS_MAX_AGENTS, 3]);
  });

  it("a lost answer is asked again after a backoff; a gone stream only on the next one", async () => {
    let failWith: unknown = Object.assign(new Error("lost"), { status: 0, retryable: true });
    const h = harness(async () => {
      if (failWith !== null) throw failWith;
      return { ok: true };
    });
    h.loader.want("a");
    h.loader.sync(view());
    await h.flush();
    assert.equal(h.posts.length, 1);
    assert.equal(h.timers.length, 1, "a retry is scheduled");
    assert.ok(h.timers[0]!.delayMs <= 1_000);
    failWith = Object.assign(new Error("gone"), { status: 404, code: "STREAM_NOT_FOUND" });
    h.timers[0]!.run();
    await h.flush();
    assert.equal(h.posts.length, 2, "retried");
    h.loader.sync(view());
    await h.flush();
    assert.equal(h.posts.length, 2, "not on the stream that said it is gone");
    failWith = null;
    h.loader.sync(view({ streamId: "s-2" }));
    await h.flush();
    assert.equal(h.posts.length, 3);
    assert.equal(h.events.unsupported, 0);
  });

  it("any other refusal — a route miss above all — stops it and asks for the whole thread, once", async () => {
    const h = harness(async () => {
      throw Object.assign(new Error("No route for POST"), { status: 404, code: "THREAD_NOT_FOUND" });
    });
    h.loader.want("a");
    h.loader.sync(view());
    await h.flush();
    assert.equal(h.events.unsupported, 1);
    assert.equal(h.loader.enabled, false);
    h.loader.sync(view({ streamId: "s-2" }));
    await h.flush();
    assert.equal(h.posts.length, 1, "never asked again");
  });

  it("a live stream with omitted rows and no id to ask on reads the thread whole, once", async () => {
    const h = harness();
    h.loader.sync(view({ streamId: null }));
    h.loader.sync(view({ streamId: null }));
    await h.flush();
    assert.equal(h.events.noStream, 1);
    assert.deepEqual(h.posts, []);
    // Nothing omitted: nothing to read.
    const quiet = harness();
    quiet.loader.sync(view({ streamId: null, omitted: undefined }));
    assert.equal(quiet.events.noStream, 0);
  });

  it("a dropped frame's agents are asked for again", async () => {
    const h = harness();
    h.loader.want("a");
    h.loader.sync(view());
    await h.flush();
    h.loader.dropped(["a"]);
    h.loader.sync(view());
    await h.flush();
    assert.equal(h.posts.length, 2);
  });
});

describe("on-demand agent rows — the loader reads each refusal for what it is", () => {
  const failing = (status: number, code = "UNKNOWN") => async () => {
    throw Object.assign(new Error(`HTTP ${status}`), { status, code });
  };

  it("a proxy's 502/504, a 429 and a 500 are retried after a backoff, never taken for a missing route", async () => {
    for (const status of [502, 504, 429, 500]) {
      const h = harness(failing(status));
      h.loader.want("a");
      h.loader.sync(view());
      await h.flush();
      assert.equal(h.events.unsupported, 0, String(status));
      assert.equal(h.loader.enabled, true, String(status));
      assert.equal(h.timers.length, 1, `${status}: a retry is scheduled`);
    }
  });

  it("a 401 waits for the next stream: not retried here, not unsupported", async () => {
    const h = harness(failing(401));
    h.loader.want("a");
    h.loader.sync(view());
    await h.flush();
    h.loader.sync(view());
    await h.flush();
    assert.equal(h.posts.length, 1);
    assert.equal(h.events.unsupported, 0);
    assert.equal(h.timers.length, 0);
    h.loader.sync(view({ streamId: "s-2" }));
    await h.flush();
    assert.equal(h.posts.length, 2, "asked on the next stream");
  });

  it("a route miss reads the thread whole once, however many batches fail", async () => {
    const h = harness(failing(404, "THREAD_NOT_FOUND"));
    const omitted = Array.from({ length: 130 }, (_, index) => `agent-${String(index).padStart(3, "0")}`);
    h.loader.sync(view({ omitted, activeAgentIds: new Set(omitted) }));
    await h.flush();
    assert.equal(h.posts.length, 3, "three batches out");
    assert.equal(h.events.unsupported, 1);
    const once = harness(failing(405));
    once.loader.want("a");
    once.loader.sync(view());
    await once.flush();
    assert.equal(once.events.unsupported, 1);
  });

  it("an agent whose request is lost with its stream, stream after stream, is read whole instead — once", async () => {
    const h = harness(async () => ({ ok: true }));
    h.loader.want("a");
    for (let stream = 1; stream <= 3; stream += 1) {
      h.loader.sync(view({ streamId: `s-${stream}` }));
      await h.flush();
    }
    // Three streams went, none carried its frame.
    assert.equal(h.posts.length, 3);
    assert.equal(h.events.unsupported, 0);
    h.loader.sync(view({ streamId: "s-4" }));
    await h.flush();
    assert.equal(h.events.unsupported, 1, "not asked a fourth time: the thread is read whole");
    assert.equal(h.posts.length, 3);
    h.loader.sync(view({ streamId: "s-5" }));
    await h.flush();
    assert.equal(h.events.unsupported, 1);
  });

  it("a frame that lands clears what was lost", async () => {
    const h = harness(async () => ({ ok: true }));
    h.loader.want("a");
    for (let stream = 1; stream <= 2; stream += 1) {
      h.loader.sync(view({ streamId: `s-${stream}` }));
      await h.flush();
    }
    // Its frame landed: no longer omitted.
    h.loader.sync(view({ streamId: "s-2", omitted: ["b"] }));
    h.loader.sync(view({ streamId: "s-3", omitted: ["a"] }));
    await h.flush();
    h.loader.sync(view({ streamId: "s-4", omitted: ["a"] }));
    await h.flush();
    assert.equal(h.events.unsupported, 0, "two lost since it last landed, not three");
  });
});
