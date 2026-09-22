/**
 * Render smoke checks for the compaction surfaces (§7.3).
 *
 * Not a substitute for `rows.logic.test.ts` / `row-format.test.ts` (which own
 * the rules): this exists because "the working row swaps its label in place
 * and grows an indeterminate bar", "the thinking placeholder keeps its height
 * but stops claiming the agent is thinking" and "a failed compaction reads in
 * the danger tone with its reason" are all claims about *markup*, and a React
 * prop mistake typechecks perfectly while rendering nothing.
 *
 * Static markup only — no DOM, no effects — so it stays a plain assert script
 * like every other `*.check.ts` here.
 */

import assert from "node:assert/strict";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { AgentChatTimelineRow } from "../../../lib/agent-chat/contracts";
import { IndeterminateBar } from "../primitives";
import { CompactionRow, ThinkingRow, WorkingRow } from "./rows/StructureRows";

type Row<K extends AgentChatTimelineRow["kind"]> = Extract<AgentChatTimelineRow, { kind: K }>;

function render(element: ReactElement): string {
  return renderToStaticMarkup(element);
}

// ---------------------------------------------------------------------------
// The bar itself
// ---------------------------------------------------------------------------

const bar = render(createElement(IndeterminateBar));
assert.ok(bar.includes("ac-working-bar"), "the sliding fill is the shared `ac-` motion utility");
assert.ok(
  /aria-hidden/.test(bar),
  "it is decoration beside a label that already says what is happening"
);
assert.ok(
  !/#|rgb\(|text-info|bg-info/.test(bar),
  "theme-neutral: the neutral scale only, never a literal colour"
);
assert.ok(bar.includes("neutral-"), "it paints from the neutral scale");

// ---------------------------------------------------------------------------
// The working row
// ---------------------------------------------------------------------------

const workingRow: Row<"working"> = {
  kind: "working",
  id: "working-indicator-row",
  createdAt: "2026-09-22T10:00:00.000Z"
};

const working = render(createElement(WorkingRow, { row: workingRow }));
assert.ok(working.includes("Working for"), "an ordinary turn still says how long it has run");
assert.ok(!working.includes("ac-working-bar"), "no bar outside the compaction phase");

const compactingWorking = render(
  createElement(WorkingRow, { row: { ...workingRow, compacting: true } })
);
assert.ok(
  compactingWorking.includes("Compacting context"),
  "the compaction phase names itself rather than saying `Working`"
);
assert.ok(!compactingWorking.includes("Working for"), "and drops the generic label with it");
assert.ok(compactingWorking.includes("ac-shimmer"), "the label still shimmers: it is live");
assert.ok(compactingWorking.includes("ac-working-bar"), "the indeterminate bar rides under it");

// ---------------------------------------------------------------------------
// The thinking placeholder
// ---------------------------------------------------------------------------

const thinkingRow: Row<"thinking"> = {
  kind: "thinking",
  id: "live-activity-row",
  createdAt: null
};
const thinking = render(createElement(ThinkingRow, { row: thinkingRow }));
assert.ok(thinking.includes("Thinking"), "an ordinary live turn reserves the row with `Thinking`");

const compactingThinking = render(
  createElement(ThinkingRow, { row: { ...thinkingRow, compacting: true } })
);
assert.ok(
  !compactingThinking.includes("Thinking"),
  "the working row above already says `Compacting context…`; a second live label reads as two things happening"
);
assert.ok(compactingThinking.includes("min-h-7"), "but the row keeps its height, so nothing jumps");

// ---------------------------------------------------------------------------
// The markers
// ---------------------------------------------------------------------------

const compacted = render(
  createElement(CompactionRow, {
    row: {
      kind: "context-compaction",
      id: "c1",
      createdAt: "2026-09-22T10:01:00.000Z",
      label: "Context compacted",
      beforeTokens: 800_000,
      afterTokens: 11_000
    }
  })
);
assert.ok(
  compacted.includes("Context compacted · 800k → 11k tokens"),
  "the settled divider is unchanged"
);
assert.ok(!compacted.includes("text-danger"), "a successful compaction is not an error");

const failed = render(
  createElement(CompactionRow, {
    row: {
      kind: "context-compaction",
      id: "c2",
      createdAt: "2026-09-22T10:01:00.000Z",
      label: "Context compaction failed",
      failed: true,
      detail: "the provider refused: context window exhausted"
    }
  })
);
assert.ok(failed.includes("Context compaction failed"), "the failure says so on the hairline");
assert.ok(
  failed.includes("the provider refused: context window exhausted"),
  "and the reason rides under it — the conversation is unchanged and the user must know why"
);
assert.ok(failed.includes("text-danger"), "in the danger tone, like every other failed row");

console.log("agent-chat compaction render checks passed");
