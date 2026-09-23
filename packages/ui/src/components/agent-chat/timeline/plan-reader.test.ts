import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ensureThreadStore, resetThreadStores } from "../../../lib/agent-chat/store.ts";
import type { AgentChatTransport } from "../../../lib/agent-chat/transport.ts";
import { activity } from "../../../lib/agent-chat/test-helpers.ts";
import { threadPlanReader } from "./ChatTimeline.tsx";
import { readPlanWithoutStore, useTimelineRowContext } from "./context.ts";

// The plan card's Copy and Download read a proposal through the row context's
// `readFullPlanMarkdown`: the timeline's `threadPlanReader`, or the context's
// own fallback outside a timeline. Both keep the reader's contract: an intact
// plan is its markdown as is, and only a plan the wire cut at 16 KiB (§5.6) is
// read back, or refused.

afterEach(() => {
  resetThreadStores();
});

const INTACT = { id: "plan-intact", planMarkdown: "# Ship it\n\nevery step" };
const CUT = { id: "plan-cut", planMarkdown: "# Ship it\n\nstep 1…", truncated: true as const };
const WHOLE = "# Ship it\n\nstep 1\nstep 2";

test("with no thread store, an intact plan is still its own markdown", async () => {
  assert.equal(await threadPlanReader("thread-without-store")(INTACT), INTACT.planMarkdown);
});

test("with no thread store, only a plan the wire cut rejects: there is nothing to read it back from", async () => {
  await assert.rejects(threadPlanReader("thread-without-store")(CUT), /full plan could not be loaded/);
});

test("with a thread store, a cut plan is read back whole through it", async () => {
  const reads: string[] = [];
  const transport = {
    stream: () => ({ lastSeq: 0, hostInstanceId: null, resetCursor: () => {}, close: () => {} }),
    readItem: async (_sessionId: string, itemId: string) => {
      reads.push(itemId);
      return { item: activity("turn.proposed.completed", { planMarkdown: WHOLE }, { id: itemId }) };
    }
  } as unknown as AgentChatTransport;
  ensureThreadStore("thread-live", { transport });
  assert.equal(await threadPlanReader("thread-live")(CUT), WHOLE);
  assert.deepEqual(reads, ["plan-cut"]);
});

test("outside a timeline, the row context reads plans with the same no-store reader", () => {
  let reader: unknown;
  function Probe(): null {
    reader = useTimelineRowContext().readFullPlanMarkdown;
    return null;
  }
  renderToStaticMarkup(createElement(Probe));
  assert.equal(reader, readPlanWithoutStore);
});
