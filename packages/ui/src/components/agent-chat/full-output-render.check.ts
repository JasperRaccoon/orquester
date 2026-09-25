/**
 * Render smoke checks for "Load full output" (spec §5.6, §6.3).
 *
 * `full-output.test.ts` owns what the row asks for and what the viewer reads;
 * this exists because "the expanded row of a command whose output streamed
 * offers the button, and a plain one does not" and "the viewer says a
 * running call's output is so far, and a cut join is its head" are claims
 * about markup — and a prop mistake typechecks perfectly while rendering
 * nothing.
 *
 * Static markup only — no DOM, no effects — like every other `*.check.ts`.
 */

import assert from "node:assert/strict";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ThreadActivityItem } from "@orquester/api/agent-chat";

import type { AgentChatTimelineRow } from "../../lib/agent-chat/contracts";
import { deriveWorkLogEntries } from "../../lib/agent-chat/entries.logic";
import { fullOutputNotes } from "../../lib/agent-chat/full-output";
import { activity } from "../../lib/agent-chat/test-helpers";
import { FullOutputPane } from "./FullOutputPane";
import { TimelineRowContext, type TimelineRowContextValue } from "./timeline/context";
import { WorkRow } from "./timeline/rows/ActivityRows";

/**
 * An open tool row's output pane restores its scroll offset in a layout
 * effect, which the static renderer warns about because it cannot encode it
 * for hydration. Nothing here hydrates, so that one warning is noise —
 * filtered by its exact text so every other console error still surfaces.
 */
const consoleError = console.error.bind(console);
console.error = (...args: unknown[]) => {
  if (typeof args[0] === "string" && args[0].includes("useLayoutEffect does nothing on the server")) {
    return;
  }
  consoleError(...args);
};

const NOOP = (): void => {};

/** Every row open, so the expanded body — where the button lives — renders. */
const expanded = {
  workspaceRoot: undefined,
  readOnly: false,
  isExpanded: () => true,
  setExpanded: NOOP,
  toolOutputOffset: () => 0,
  setToolOutputOffset: NOOP,
  onOpenFile: NOOP,
  onLoadFullOutput: NOOP,
  backgroundShell: false
} as unknown as TimelineRowContextValue;

/** The rows the window holds, as the timeline renders one `work` row of them. */
function rendered(items: readonly ThreadActivityItem[]): string {
  const row: Extract<AgentChatTimelineRow, { kind: "work" }> = {
    kind: "work",
    id: "work-1",
    createdAt: items[0]!.createdAt,
    groupedEntries: deriveWorkLogEntries(items),
    isExpandedToolGroup: false
  };
  return renderToStaticMarkup(
    createElement(TimelineRowContext.Provider, { value: expanded }, createElement(WorkRow, { row })) as ReactElement
  );
}

const command = (extra: Record<string, unknown> = {}): ThreadActivityItem =>
  activity(
    "tool.completed",
    {
      itemType: "command_execution",
      toolUseId: "call-1",
      title: "npm test",
      command: "npm test",
      status: "completed",
      ...extra
    },
    { turnId: "t1" }
  );
const chunk = (delta: string, streamKind = "command_output", toolUseId = "call-1"): ThreadActivityItem =>
  activity("tool.output", { toolUseId, streamKind, delta }, { turnId: "t1", summary: "Tool output" });

// A command whose output streamed — the window holds only its latest chunk, and nothing cut its own payload.
const streamed = rendered([chunk("line 600\n"), command({ detail: "line 1" })]);
assert.ok(streamed.includes("line 600"), "the row shows what the window holds of its output");
assert.ok(streamed.includes("Load full output"), "and offers the whole of it, though nothing cut its payload");

// A running command, its start the only row of its call.
const running = rendered([
  activity(
    "tool.started",
    {
      itemType: "command_execution",
      toolUseId: "call-1",
      title: "npm test",
      command: "npm test",
      status: "inProgress"
    },
    { turnId: "t1" }
  ),
  chunk("PASS a.test.ts\n")
]);
assert.ok(running.includes("Load full output"), "a running command offers its output so far");

// A command that streamed nothing: its row is all there is.
const plain = rendered([command({ detail: "2 passed" })]);
assert.ok(plain.includes("2 passed"));
assert.ok(!plain.includes("Load full output"), "a plain command offers nothing more");

// A payload the wire cut still offers its item, as before.
const cut = rendered([command({ detail: "2 passed", truncated: true })]);
assert.ok(cut.includes("Load full output"), "a cut payload offers the full read");

// A file change streams its result text too, which is no command's output.
const edit = rendered([
  chunk("File created successfully at: /w/p/a.ts", "file_change_output", "call-e"),
  activity(
    "tool.completed",
    {
      itemType: "file_change",
      toolUseId: "call-e",
      title: "File change",
      status: "completed",
      changedFiles: ["/w/p/a.ts"]
    },
    { turnId: "t1" }
  )
]);
assert.ok(!edit.includes("Load full output"), "a file change is never offered the join");

// The viewer's pane: the text, and what the host said about it.
const pane = (props: Parameters<typeof FullOutputPane>[0]): string =>
  renderToStaticMarkup(createElement(FullOutputPane, props) as ReactElement);

const loading = pane({ loading: true, text: "", notes: [] });
assert.ok(loading.includes("Loading…"));
assert.ok(!loading.includes("data-full-output-note"), "nothing is said about an output not read yet");

const whole = pane({
  loading: false,
  text: "line 1\nline 2\n",
  notes: fullOutputNotes({ kind: "streamed", text: "line 1\nline 2\n", running: false, cut: false })
});
assert.ok(whole.includes("line 1\nline 2\n"), "the output as the command printed it");
assert.ok(!whole.includes("data-full-output-note"), "a settled, whole output needs no note");

const soFar = pane({
  loading: false,
  text: "PASS a.test.ts\n",
  notes: fullOutputNotes({ kind: "streamed", text: "PASS a.test.ts\n", running: true, cut: true })
});
assert.ok(soFar.includes("Still running — this is its output so far."), "a running call's output is so far");
assert.ok(
  soFar.includes("Only the first 8 MiB of this output can be shown here."),
  "a cut join is its head — the log keeps the rest"
);
assert.ok(
  soFar.indexOf("Still running") < soFar.indexOf("PASS a.test.ts"),
  "said before the text, where the viewer opens"
);

console.log("full-output render checks passed");
