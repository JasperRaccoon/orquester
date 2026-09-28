import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ResolveSavedPromptResult } from "../../../lib/saved-prompts/variables.ts";
import { type ChatDelivery } from "../chat-target.ts";
import {
  createSavedPromptDeliverer,
  type SavedPromptDelivererDeps
} from "./deliver.ts";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** A fake chat: records what reached it, and which chat is on screen. */
function fakes(overrides: Partial<SavedPromptDelivererDeps> = {}) {
  const calls = {
    resolved: [] as { body: string; target: string; signal: AbortSignal }[],
    inserted: [] as { target: string; text: string }[],
    sent: [] as { target: string; text: string }[],
    used: [] as string[]
  };
  let onScreen: string | null = "chat-1";
  const deps: SavedPromptDelivererDeps = {
    resolve: async (body, target, signal) => {
      calls.resolved.push({ body, target, signal });
      return { ok: true, text: "Review +changed line" };
    },
    activeTarget: () => onScreen,
    insert: (target, text): ChatDelivery => {
      calls.inserted.push({ target, text });
      return { ok: true, disposition: "inserted" };
    },
    send: (target, text): ChatDelivery => {
      calls.sent.push({ target, text });
      return { ok: true, disposition: "sent" };
    },
    markUsed: (id) => {
      calls.used.push(id);
    },
    ...overrides
  };
  return {
    calls,
    deps,
    setOnScreen: (id: string | null) => {
      onScreen = id;
    }
  };
}

const PROMPT = { id: "p1", body: "Review {diff}" };

describe("saved-prompt delivery", () => {
  it("renders for the chat captured at the click, delivers there, and counts the use", async () => {
    for (const action of ["insert", "send"] as const) {
      const { calls, deps } = fakes();
      const outcome = await createSavedPromptDeliverer(deps).deliver(PROMPT, action, "chat-1");
      assert.equal(outcome.status, "delivered");
      assert.equal(calls.resolved[0]?.target, "chat-1");
      assert.deepEqual(calls.inserted, action === "insert" ? [{ target: "chat-1", text: "Review +changed line" }] : []);
      assert.deepEqual(calls.sent, action === "send" ? [{ target: "chat-1", text: "Review +changed line" }] : []);
      assert.deepEqual(calls.used, ["p1"]);
    }
  });

  it("refuses when another chat is on screen once the prompt is rendered — nothing lands, nothing counted", async () => {
    for (const nextTarget of ["chat-2", null]) {
      const gate = deferred<ResolveSavedPromptResult>();
      const { calls, deps, setOnScreen } = fakes({ resolve: () => gate.promise });
      const pending = createSavedPromptDeliverer(deps).deliver(PROMPT, "insert", "chat-1");
      setOnScreen(nextTarget);
      gate.resolve({ ok: true, text: "rendered" });
      assert.equal((await pending).status, "refused");
      assert.deepEqual(calls.inserted, []);
      assert.deepEqual(calls.sent, []);
      assert.deepEqual(calls.used, []);
    }
  });

  it("with no chat at the click, refuses at once and renders nothing", async () => {
    const { calls, deps } = fakes();
    assert.equal((await createSavedPromptDeliverer(deps).deliver(PROMPT, "insert", null)).status, "refused");
    assert.deepEqual(calls.resolved, []);
  });

  it("a click supersedes the one still resolving: the first lands nowhere, its git reads stop", async () => {
    const first = deferred<ResolveSavedPromptResult>();
    const { calls, deps } = fakes({
      resolve: (body, target, signal) => {
        calls.resolved.push({ body, target, signal });
        return body === "slow" ? first.promise : Promise.resolve({ ok: true, text: body });
      }
    });
    const deliverer = createSavedPromptDeliverer(deps);
    const slow = deliverer.deliver({ id: "slow", body: "slow" }, "insert", "chat-1");
    const fast = deliverer.deliver({ id: "fast", body: "fast" }, "insert", "chat-1");
    assert.equal(calls.resolved[0]?.signal.aborted, true, "the first one's reads are stopped");
    assert.equal((await fast).status, "delivered");
    first.resolve({ ok: true, text: "slow" });
    assert.deepEqual(await slow, { status: "superseded" });
    assert.deepEqual(
      calls.inserted.map((entry) => entry.text),
      ["fast"],
      "only the later click reached the chat"
    );
    assert.deepEqual(calls.used, ["fast"]);
  });

  it("dispose (the panel going away) stops the delivery in flight", async () => {
    const gate = deferred<ResolveSavedPromptResult>();
    const { calls, deps } = fakes({ resolve: () => gate.promise });
    const deliverer = createSavedPromptDeliverer(deps);
    const pending = deliverer.deliver(PROMPT, "insert", "chat-1");
    deliverer.dispose();
    gate.resolve({ ok: true, text: "rendered" });
    assert.deepEqual(await pending, { status: "superseded" });
    assert.deepEqual(calls.inserted, []);
    assert.deepEqual(calls.used, []);
  });

  it("counts the use only when the chat took it", async () => {
    const refusedRender = fakes({ resolve: async () => ({ ok: false, reason: "Couldn't read the git diff: x" }) });
    assert.deepEqual(await createSavedPromptDeliverer(refusedRender.deps).deliver(PROMPT, "insert", "chat-1"), {
      status: "refused",
      reason: "Couldn't read the git diff: x"
    });
    assert.deepEqual(refusedRender.calls.used, []);

    const refusedByChat = fakes({ send: () => ({ ok: false, reason: "Open the chat to send to it." }) });
    assert.deepEqual(await createSavedPromptDeliverer(refusedByChat.deps).deliver(PROMPT, "send", "chat-1"), {
      status: "refused",
      reason: "Open the chat to send to it."
    });
    assert.deepEqual(refusedByChat.calls.used, []);

    const threw = fakes({
      resolve: async () => {
        throw new Error("boom");
      }
    });
    assert.deepEqual(await createSavedPromptDeliverer(threw.deps).deliver(PROMPT, "insert", "chat-1"), {
      status: "refused",
      reason: "boom"
    });
    assert.deepEqual(threw.calls.used, []);
  });
});
