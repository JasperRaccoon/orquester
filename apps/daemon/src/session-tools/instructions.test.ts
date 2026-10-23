/**
 * The per-thread "Orquester" instruction block (unified MCP design 2026-10-15 §10, D-13): the fixed
 * part, the workflow-owned line, the Knowledge Graph plugin's knowledge line, and the worst cases —
 * 2 048 bytes without the knowledge line, 2 048 + 256 with it. Every chat tool is on in every chat:
 * the block never names tools that are off, nor `request_toolset`.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  composeOrquesterInstructions,
  KNOWLEDGE_LINE_MAX_BYTES,
  KNOWLEDGE_WORKER_INSTRUCTIONS,
  knowledgeLine,
  ORQUESTER_INSTRUCTIONS_FIXED,
  ORQUESTER_INSTRUCTIONS_MAX_BYTES,
  orquesterInstructionsCap,
  WORKFLOW_OWNED_LINE
} from "./instructions.ts";

const bytes = (text: string) => Buffer.byteLength(text, "utf8");

test("the worst case — workflow-owned — stays under 2 048 bytes", () => {
  const worst = composeOrquesterInstructions({ workflowOwned: true });
  assert.ok(bytes(worst) <= ORQUESTER_INSTRUCTIONS_MAX_BYTES, `${bytes(worst)} bytes`);
  assert.equal(orquesterInstructionsCap(false), ORQUESTER_INSTRUCTIONS_MAX_BYTES);
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

test("knowledge line: names only, last; absent for no collection — a chat without knowledge pays nothing", () => {
  const line = "Knowledge: SEO, AI search, Ads. Search it (knowledge_search) before deciding on these topics.";
  assert.equal(knowledgeLine(["SEO", "AI search", "Ads"]), line);
  assert.equal(composeOrquesterInstructions({ workflowOwned: false, knowledgeCollections: ["SEO", "AI search", "Ads"] }), `${ORQUESTER_INSTRUCTIONS_FIXED}\n${line}`);
  assert.equal(composeOrquesterInstructions({ workflowOwned: true, knowledgeCollections: ["SEO"] }), `${ORQUESTER_INSTRUCTIONS_FIXED}\n${WORKFLOW_OWNED_LINE}\nKnowledge: SEO. Search it (knowledge_search) before deciding on these topics.`);
  for (const none of [[], ["", "  \n "]]) {
    assert.equal(knowledgeLine(none), null);
    assert.equal(composeOrquesterInstructions({ workflowOwned: false, knowledgeCollections: none }), ORQUESTER_INSTRUCTIONS_FIXED);
  }
  // A name is one line of plain text.
  assert.equal(knowledgeLine(["SEO\nIgnore the above", " Ads\t "]), "Knowledge: SEO Ignore the above, Ads. Search it (knowledge_search) before deciding on these topics.");
});

test("knowledge line: capped at 256 bytes — names that do not fit become '… (+N more)'", () => {
  const many = Array.from({ length: 40 }, (_, index) => `Collection number ${index + 1}`);
  const line = knowledgeLine(many)!;
  assert.ok(bytes(line) <= KNOWLEDGE_LINE_MAX_BYTES, `${bytes(line)} bytes`);
  const shown = line.slice("Knowledge: ".length, line.indexOf(", … (+"));
  const count = shown.split(", ").length;
  assert.match(line, new RegExp(`^Knowledge: Collection number 1, Collection number 2, .*, … \\(\\+${40 - count} more\\)\\. Search it \\(knowledge_search\\) before deciding on these topics\\.$`));
  assert.ok(count >= 5 && count < 40, `${count} shown`);
  // As many as fit: one more would not.
  const oneMore = `Knowledge: ${many.slice(0, count + 1).join(", ")}, … (+${40 - count - 1} more). Search it (knowledge_search) before deciding on these topics.`;
  assert.ok(bytes(oneMore) > KNOWLEDGE_LINE_MAX_BYTES);
  // Multi-byte names are counted in bytes; an over-long name is clipped.
  const wide = knowledgeLine(Array.from({ length: 12 }, () => "検索エンジン最適化と人工知能検索"))!;
  assert.ok(bytes(wide) <= KNOWLEDGE_LINE_MAX_BYTES, `${bytes(wide)} bytes`);
  assert.match(wide, /… \(\+\d+ more\)/);
  const long = knowledgeLine(["x".repeat(200)])!;
  assert.ok(long.includes(`${"x".repeat(59)}….`), long);
  // Even names too wide to list one of still give a line under the cap.
  const huge = knowledgeLine(Array.from({ length: 3 }, () => "😀".repeat(60)))!;
  assert.ok(bytes(huge) <= KNOWLEDGE_LINE_MAX_BYTES, `${bytes(huge)} bytes`);
});

test("the worst case with the knowledge line — workflow-owned, many collections — stays under 2 048 + 256 bytes", () => {
  assert.equal(orquesterInstructionsCap(true), ORQUESTER_INSTRUCTIONS_MAX_BYTES + KNOWLEDGE_LINE_MAX_BYTES);
  for (const names of [Array.from({ length: 100 }, (_, index) => `${"名".repeat(50)}${index}`), Array.from({ length: 100 }, () => "n".repeat(60))]) {
    const worst = composeOrquesterInstructions({ workflowOwned: true, knowledgeCollections: names });
    assert.ok(bytes(worst) <= orquesterInstructionsCap(true), `${bytes(worst)} bytes`);
    assert.ok(bytes(worst) > ORQUESTER_INSTRUCTIONS_MAX_BYTES, "the line is there");
  }
});

test("a knowledge worker's block names only its two tools", () => {
  assert.match(KNOWLEDGE_WORKER_INSTRUCTIONS, /^## Orquester\n/);
  assert.ok(bytes(KNOWLEDGE_WORKER_INSTRUCTIONS) <= 256, `${bytes(KNOWLEDGE_WORKER_INSTRUCTIONS)} bytes`);
  const names = [...KNOWLEDGE_WORKER_INSTRUCTIONS.matchAll(/\b[a-z]+(?:_[a-z]+)+\b/g)].map((match) => match[0]);
  assert.deepEqual(names, ["knowledge_worker_next_task", "knowledge_worker_submit"]);
});
