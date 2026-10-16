/**
 * The per-thread "Orquester" instruction block (unified MCP design 2026-10-15 §10, D-13): the fixed
 * part, the off-toolsets line (with the ids `request_toolset` takes), the workflow-owned line, and
 * the 2 048-byte worst case.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { TOOLSETS } from "@orquester/api";

import {
  composeOrquesterInstructions,
  ORQUESTER_INSTRUCTIONS_FIXED,
  ORQUESTER_INSTRUCTIONS_MAX_BYTES,
  WORKFLOW_OWNED_LINE
} from "./instructions.ts";

const bytes = (text: string) => Buffer.byteLength(text, "utf8");
const everything = new Set(TOOLSETS.map((toolset) => toolset.id));

test("the worst case — every toolset off, workflow-owned — stays under 2 048 bytes", () => {
  const worst = composeOrquesterInstructions({ enabledToolsets: new Set(["core"]), workflowOwned: true, canRequestToolsets: true });
  assert.ok(bytes(worst) <= ORQUESTER_INSTRUCTIONS_MAX_BYTES, `${bytes(worst)} bytes`);
  // Every conditional line at its longest (the request hint as well as the workflow line).
  const longest = `${ORQUESTER_INSTRUCTIONS_FIXED}\n${worst.split("\n").find((line) => line.startsWith("Off at chat start"))!}\n${WORKFLOW_OWNED_LINE}`;
  assert.ok(bytes(longest) <= ORQUESTER_INSTRUCTIONS_MAX_BYTES, `${bytes(longest)} bytes`);
  // The fixed part: spec §10 measures it at 1 445 bytes.
  assert.ok(bytes(ORQUESTER_INSTRUCTIONS_FIXED) <= 1_445, `${bytes(ORQUESTER_INSTRUCTIONS_FIXED)} bytes`);
});

test("the off toolsets are named by label and id, as of the chat's start (Claude cannot refresh the block: request_toolset's result is authoritative); request_toolset is suggested only where it can be asked", () => {
  const block = composeOrquesterInstructions({ enabledToolsets: new Set(["core", "reads"]), workflowOwned: false, canRequestToolsets: true });
  assert.ok(block.startsWith(ORQUESTER_INSTRUCTIONS_FIXED));
  const off = block.split("\n").at(-1)!;
  assert.match(off, /^Off at chat start: Todos & saved-prompt editing \(`notes`\), More chat control \(`chat-extras`\), /);
  assert.match(off, /Workflow authoring \(changes need your approval\) \(`workflow-authoring`\)/);
  assert.doesNotMatch(off, /`reads`|`core`/);
  assert.match(off, /call request_toolset with its id; its result says what is on now\.$/);
  // Settings › Agent tools switched off (or a workflow-owned chat): no card can turn one on.
  const switchedOff = composeOrquesterInstructions({ enabledToolsets: new Set(["core"]), workflowOwned: false, canRequestToolsets: false });
  assert.doesNotMatch(switchedOff, /request_toolset with its id/);
  assert.match(switchedOff, /Off at chat start: .*\.$/);
});

test("nothing off, no line; workflow-owned adds its line", () => {
  assert.equal(composeOrquesterInstructions({ enabledToolsets: everything, workflowOwned: false, canRequestToolsets: true }), ORQUESTER_INSTRUCTIONS_FIXED);
  assert.equal(
    composeOrquesterInstructions({ enabledToolsets: everything, workflowOwned: true, canRequestToolsets: false }),
    `${ORQUESTER_INSTRUCTIONS_FIXED}\n${WORKFLOW_OWNED_LINE}`
  );
});
