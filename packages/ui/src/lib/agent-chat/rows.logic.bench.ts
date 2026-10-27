/**
 * Retained chat timeline: 40 reasoning/tool groups separated by commentary,
 * followed by a streaming answer. Measures the actual row projection for
 * assistant and reasoning tokens, without React or layout. Run from packages/ui:
 * TSX_DISABLE_CACHE=1 node --import tsx src/lib/agent-chat/rows.logic.bench.ts [revision]
 * A revision loads its row projector through a temporary sibling module.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { unlinkSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

import { messageStreamingContext, type ThreadItem } from "@orquester/api/agent-chat";
import { deriveTimelineEntriesFromItems, type TimelineEntry } from "./entries.logic";
import {
  deriveTimelineRowsWithState as currentProject,
  type TimelineRowsInput
} from "./rows.logic";
import { activity, message, stamp } from "./test-helpers";

const revision = process.argv[2];
let project = currentProject;
if (revision !== undefined) {
  const baselineFile = new URL(`.rows-baseline-${process.pid}.ts`, import.meta.url);
  writeFileSync(baselineFile, execFileSync("git", ["show", `${revision}:packages/ui/src/lib/agent-chat/rows.logic.ts`]));
  try {
    project = (await import(baselineFile.href)).deriveTimelineRowsWithState as typeof currentProject;
  } finally {
    unlinkSync(baselineFile);
  }
}

const items: ThreadItem[] = [message("user", "Inspect the project", { createdAt: stamp(0) })];
let clock = 1;
for (let group = 0; group < 40; group += 1) {
  items.push(message("reasoning", "Inspecting", {
    id: `reasoning-${group}`, turnId: "t1", streaming: true, createdAt: stamp(clock++)
  }));
  for (let tool = 0; tool < 8; tool += 1) {
    items.push(activity("tool.completed", {
      itemType: "command_execution", toolUseId: `call-${group}-${tool}`, command: "ls", status: "completed"
    }, { turnId: "t1", createdAt: stamp(clock++) }));
  }
  items.push(message("assistant", "Continuing the inspection", {
    turnId: "t1", messageKind: "commentary", createdAt: stamp(clock++)
  }));
}
items.push(message("assistant", "The result", {
  id: "answer", turnId: "t1", streaming: true, createdAt: stamp(clock++)
}));
const entries = deriveTimelineEntriesFromItems(items).entries;
const input: TimelineRowsInput = {
  timelineEntries: entries,
  latestTurn: null,
  runningTurnId: "t1",
  isWorking: true,
  activeTurnStartedAt: stamp(0),
  supportsConversationRollback: false,
  messageStreaming: messageStreamingContext({
    head: { session: { status: "running", activeTurnId: "t1" } }, roster: []
  })
};
const groups = project(input).rows.filter((row) => row.kind === "activity-group").length;
assert.equal(groups, 40);

const updates = 5_000;
for (const kind of ["unchanged", "assistant", "reasoning"] as const) {
  const at = entries.findIndex((entry) => entry.kind === "message" && entry.id === (kind === "reasoning" ? "reasoning-39" : "answer"));
  const original = entries[at]!;
  assert.equal(original.kind, "message");
  if (original.kind !== "message") throw new Error("Missing benchmark message");
  // Prebuild each event so the measurements isolate projection work.
  const frames: TimelineEntry[][] = Array.from({ length: updates }, (_, index) => {
    if (kind === "unchanged") return entries;
    const frame = [...entries];
    frame[at] = { ...original, message: { ...original.message, text: `${original.message.text} ${index}` } };
    return frame;
  });
  const durations: number[] = [];
  for (let round = 0; round < 8; round += 1) {
    let previous = project(input);
    const started = performance.now();
    for (const timelineEntries of frames) {
      previous = project({ ...input, timelineEntries }, previous);
    }
    const elapsed = performance.now() - started;
    assert.deepEqual(previous.rows, project({ ...input, timelineEntries: frames.at(-1)! }).rows);
    if (round > 0) durations.push(elapsed);
  }
  durations.sort((left, right) => left - right);
  console.log(JSON.stringify({
    revision: revision ?? "working-tree", kind, entries: entries.length, groups, updates,
    medianMs: Number(durations[Math.floor(durations.length / 2)]!.toFixed(2)),
    samplesMs: durations.map((value) => Number(value.toFixed(2)))
  }));
}
