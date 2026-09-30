
import { isolatedPage } from "./testing/isolated-page";
let page: Awaited<ReturnType<typeof isolatedPage>>;
async function loadPage(): Promise<void> {
  await page?.dispose();
  page = await isolatedPage();
  ({ createThreadStore } = page.store);
  ({ AgentChatCommandError } = page.transport);
}
beforeEach(loadPage);
afterEach(async () => { await page.dispose(); });
/**
 * Fix-wave regressions for the per-thread store.
 *
 * Each block fails without the matching fix; the finding id is in the title.
 * Kept beside `store.test.ts` rather than inside it so the reviewer's
 * reproduction and the pre-existing coverage stay legible apart.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { AgentChatStreamFrame, ThreadItemResponse } from "@orquester/api/agent-chat";

import type { AgentChatThreadState } from "./store";
let createThreadStore: typeof import("./store")["createThreadStore"];
import type { AgentChatTransport } from "./transport";
let AgentChatCommandError: typeof import("./transport")["AgentChatCommandError"];
import { activity, head, resetBuilders, snapshot, stamp } from "./test-helpers";

interface Posted {
  name: string;
  body: Record<string, unknown>;
}

function fakeTransport(): {
  transport: AgentChatTransport;
  posted: Posted[];
  /** Every `GET …/items/:itemId`, by item id. */
  itemReads: string[];
  push(frame: AgentChatStreamFrame): void;
  onReadItem(answer: (itemId: string) => Promise<ThreadItemResponse>): void;
} {
  const posted: Posted[] = [];
  const itemReads: string[] = [];
  let onFrame: ((frame: AgentChatStreamFrame) => void) | null = null;
  let readItem: (itemId: string) => Promise<ThreadItemResponse> = async () => {
    throw new Error("unused");
  };

  const transport: AgentChatTransport = {
    stream(_sessionId, _options, handlers) {
      onFrame = handlers.onFrame;
      return { lastSeq: 0, hostInstanceId: null, resetCursor: () => {}, close: () => {} };
    },
    async command(_sessionId, name, body) {
      posted.push({ name, body: body as unknown as Record<string, unknown> });
      return { seq: posted.length };
    },
    // §3.4's account switch rides its own daemon-owned route.
    async switchAccount() {
      return { seq: 0 };
    },
    async read() {
      return { kind: "snapshot", thread: snapshot() };
    },
    async readItem(_sessionId, itemId) {
      itemReads.push(itemId);
      return readItem(itemId);
    },
    async readHistory() {
      throw new Error("unused");
    },
    async search() {
      throw new Error("unused");
    },
    async turnDiff() {
      throw new Error("unused");
    },
    async providers() {
      return { providers: [], hostInstanceId: "h1" };
    },
    async refreshProvider() {
      throw new Error("unused");
    },
    async upload() {
      return { type: "file", id: "/a/b", name: "b", sizeBytes: 1 };
    },
    async fetchAttachment() {
      return new ArrayBuffer(0);
    }
  };

  return {
    transport,
    posted,
    itemReads,
    push: (frame) => onFrame?.(frame),
    onReadItem: (answer) => {
      readItem = answer;
    }
  };
}

const flush = async (): Promise<void> => {
  for (let index = 0; index < 4; index += 1) {
    await new Promise((resolve) => queueMicrotask(() => resolve(null)));
  }
};

async function store(): Promise<{
  api: ReturnType<typeof createThreadStore>;
  fake: ReturnType<typeof fakeTransport>;
  state: () => AgentChatThreadState;
}> {
  const fake = fakeTransport();
  const api = createThreadStore("s1", {
    transport: fake.transport
  });
  await flush();
  return { api, fake, state: () => api.getState() };
}

const running = () => head({ session: { status: "running", activeTurnId: "t1" } });

const draft = (text: string) => ({
  text,
  attachments: [],
  context: [],
  interactionMode: "default" as const,
  queuedAfterToolActivityId: null,
  holdUntilUserAction: false
});

beforeEach(() => {
  resetBuilders();

});

describe("R7-1 — the client queue actually flushes", () => {
  it("sends exactly one queued message per tool-call boundary", async () => {
    const { api, fake, state } = await store();
    const first = activity("tool.completed", { itemType: "command_execution", command: "a" });
    fake.push({
      kind: "snapshot",
      thread: snapshot({ items: [first], seq: 1, head: running() })
    });

    api.getState().actions.queueMessage(draft("one"));
    api.getState().actions.queueMessage(draft("two"));
    await flush();
    assert.equal(fake.posted.length, 0, "anchored on the boundary that was current when queued");
    assert.equal(state().slice.queue.length, 2);

    const second = activity("tool.completed", { itemType: "command_execution", command: "b" });
    fake.push({
      kind: "snapshot",
      thread: snapshot({ items: [first, second], seq: 2, head: running() })
    });
    await flush();

    assert.equal(fake.posted.length, 1, "exactly one leaves per boundary, not the whole queue");
    assert.equal(fake.posted[0]?.body.input, "one");
    assert.equal(state().slice.queue.length, 1);
    assert.equal(
      state().slice.queue[0]?.queuedAfterToolActivityId,
      second.id,
      "the remainder re-anchors to the new boundary"
    );
  });

});

describe("Implement never sends a plan the wire cut (§5.6, §7.3)", () => {
  // Every wire string is cut at 16 KiB and the row stamped `truncated`; the
  // whole plan is one `GET …/items/:itemId` away.
  const cutProposal = () =>
    activity(
      "turn.proposed.completed",
      { planId: "p", planMarkdown: "# Ship it\n\nstep 1…", truncated: true },
      { id: "plan-1", createdAt: stamp(1) }
    );
  const wholePlan = "# Ship it\n\nstep 1\nstep 2";

  it("marks the actionable proposal truncated and reads the whole plan back by its id", async () => {
    const { fake, api } = await store();
    fake.push({ kind: "snapshot", thread: snapshot({ seq: 1, items: [cutProposal()] }) });
    const plan = api.getState().actionableProposedPlan;
    assert.equal(plan?.truncated, true);

    fake.onReadItem(async (itemId) => ({
      item: activity("turn.proposed.completed", { planId: "p", planMarkdown: wholePlan }, { id: itemId })
    }));
    assert.equal(await api.getState().actions.readFullPlanMarkdown(plan!), wholePlan);
    assert.deepEqual(fake.itemReads, ["plan-1"]);
    assert.deepEqual(fake.posted, [], "reading the plan back sends nothing");
  });

  it("never reads an intact proposal back", async () => {
    const { fake, api } = await store();
    const intact = activity("turn.proposed.completed", { planMarkdown: "# Ship it" }, { createdAt: stamp(1) });
    fake.push({ kind: "snapshot", thread: snapshot({ seq: 1, items: [intact] }) });
    const plan = api.getState().actionableProposedPlan!;
    assert.equal(plan.truncated, undefined);
    assert.equal(await api.getState().actions.readFullPlanMarkdown(plan), "# Ship it");
    assert.deepEqual(fake.itemReads, []);
  });

  it("refuses, rather than answer the cut text, when the read-back fails or brings no plan", async () => {
    const { fake, api } = await store();
    fake.push({ kind: "snapshot", thread: snapshot({ seq: 1, items: [cutProposal()] }) });
    const plan = api.getState().actionableProposedPlan!;

    fake.onReadItem(async () => {
      throw new AgentChatCommandError(503, "HOST_UNAVAILABLE", "The agent host is restarting.");
    });
    await assert.rejects(api.getState().actions.readFullPlanMarkdown(plan));
    fake.onReadItem(async (itemId) => ({ item: activity("turn.proposed.completed", {}, { id: itemId }) }));
    await assert.rejects(api.getState().actions.readFullPlanMarkdown(plan));
    assert.deepEqual(fake.posted, []);
  });
});
