/**
 * Render checks for a message's liveness (`isMessageStreaming`,
 * `@orquester/api/agent-chat`).
 *
 * `drill-in.logic.test.ts` and `rows.logic.test.ts` own WHEN a message reads
 * as streaming; this exists because "a stuck turnless agent message shows no
 * 'Thinking' shimmer" and "an answer no process can finish renders as settled
 * text" are claims about markup — a row flag the components never read
 * typechecks perfectly while the old log keeps shimmering.
 *
 * Static markup only — no DOM, no effects — like every other `*.check.ts`.
 */

import assert from "node:assert/strict";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  messageStreamingContext,
  type RuntimeSubagentStatus,
  type ThreadSessionState
} from "@orquester/api/agent-chat";

import type { AgentChatTimelineRow } from "../../../lib/agent-chat/contracts";
import { EMPTY_AGENT_DRILL_IN, projectAgentDrillIn } from "../../../lib/agent-chat/drill-in.logic";
import { head, message, stamp } from "../../../lib/agent-chat/test-helpers";
import { TimelineRowContext, type TimelineRowContextValue } from "./context";
import { TimelineRow } from "./TimelineRow";

const context = {
  workspaceRoot: undefined,
  readOnly: true,
  skills: [],
  isReasoningExpanded: () => false,
  setReasoningExpanded: () => {},
  onOpenFile: () => {}
} as unknown as TimelineRowContextValue;

function render(row: AgentChatTimelineRow): string {
  return renderToStaticMarkup(
    createElement(TimelineRowContext.Provider, { value: context }, createElement(TimelineRow, { row }) as ReactElement)
  );
}

/**
 * One subagent's drill-in over an old log: its words written after the
 * parent's turn ended (no turn carried them, nothing ever closed them) and its
 * answer inside that turn, which a killed host left open. Both still say
 * `streaming: true`.
 */
function drillInRows(session: ThreadSessionState, agentStatus: RuntimeSubagentStatus): Map<string, string> {
  const rows = projectAgentDrillIn(EMPTY_AGENT_DRILL_IN, {
    items: [
      message("assistant", "Found the **manifest**", {
        id: "answer",
        agentId: "a1",
        turnId: "t1",
        streaming: true,
        createdAt: stamp(1)
      }),
      message("reasoning", "", { id: "words", agentId: "a1", turnId: null, streaming: true, createdAt: stamp(2) })
    ],
    agentId: "a1",
    messageStreaming: messageStreamingContext({ head: head({ session }), roster: [{ id: "a1", status: agentStatus }] })
  }).stable.result;
  return new Map(rows.map((row) => [row.id, render(row)]));
}

const LIVE_SHIMMER = /class="ac-shimmer[ "]/;

// The agent completed long ago, and the parent's turn with it.
const stuck = drillInRows({ status: "ready", activeTurnId: null }, "completed");
const stuckWords = stuck.get("words") ?? "";
assert.ok(stuckWords.includes("Thought"), `the stuck words read as a finished thought: ${stuckWords}`);
assert.ok(!stuckWords.includes("Thinking"), "never 'Thinking'");
assert.ok(!LIVE_SHIMMER.test(stuckWords), "and never shimmer");
assert.ok(stuckWords.includes("ac-shimmer-settled"));
const stuckAnswer = stuck.get("answer") ?? "";
assert.ok(stuckAnswer.includes("<strong>manifest</strong>"), "the answer renders");
assert.ok(!stuckAnswer.includes("data-streaming"), "as settled text: no streaming fade replays on every open");

// The same log while the agent still runs in the background.
const live = drillInRows({ status: "ready", activeTurnId: null }, "running");
const liveWords = live.get("words") ?? "";
assert.ok(liveWords.includes("Thinking"), `a live agent's words are still being thought: ${liveWords}`);
assert.ok(LIVE_SHIMMER.test(liveWords), "and shimmer");
assert.ok((live.get("answer") ?? "").includes('data-streaming="true"'), "its answer still streams");

// No process at all: whatever the roster last said, nothing streams.
const dead = drillInRows({ status: "stopped", activeTurnId: null }, "running");
assert.ok(!LIVE_SHIMMER.test(dead.get("words") ?? ""));
assert.ok(!(dead.get("answer") ?? "").includes("data-streaming"));

console.log("message-liveness render checks passed");
