/**
 * The per-thread "Orquester" instruction block (unified MCP design 2026-10-15 §10, D-13): the fixed
 * part, the workflow-owned line, and the 2 048-byte worst case. Every chat tool is on in every
 * chat: the block never names tools that are off, nor `request_toolset`.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  composeOrquesterInstructions,
  ORQUESTER_INSTRUCTIONS_FIXED,
  ORQUESTER_INSTRUCTIONS_MAX_BYTES,
  WORKFLOW_OWNED_LINE
} from "./instructions.ts";

const bytes = (text: string) => Buffer.byteLength(text, "utf8");

test("the worst case — workflow-owned — stays under 2 048 bytes", () => {
  const worst = composeOrquesterInstructions({ workflowOwned: true });
  assert.ok(bytes(worst) <= ORQUESTER_INSTRUCTIONS_MAX_BYTES, `${bytes(worst)} bytes`);
  // The fixed part: 1 951 bytes since the T3 Code wording (spec §10's original measured 1 445).
  assert.ok(bytes(ORQUESTER_INSTRUCTIONS_FIXED) <= 1_951, `${bytes(ORQUESTER_INSTRUCTIONS_FIXED)} bytes`);
});

test("the fixed block alone; workflow-owned adds its line; no toolset is ever named off", () => {
  assert.equal(composeOrquesterInstructions({ workflowOwned: false }), ORQUESTER_INSTRUCTIONS_FIXED);
  assert.equal(composeOrquesterInstructions({ workflowOwned: true }), `${ORQUESTER_INSTRUCTIONS_FIXED}\n${WORKFLOW_OWNED_LINE}`);
  for (const workflowOwned of [false, true]) {
    const block = composeOrquesterInstructions({ workflowOwned });
    assert.doesNotMatch(block, /request_toolset|Off at chat start|toolset/i);
  }
});
