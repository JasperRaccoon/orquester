import assert from "node:assert/strict";
import test from "node:test";
import { knowledgeConceptSummariesPath } from "./index.ts";
import { readKnowledgeConceptSummariesFile, serializeKnowledgeConceptSummariesFile } from "./knowledge-concept-summaries.ts";

test("the concept summaries file sits in the plugin dir", () => {
  assert.equal(knowledgeConceptSummariesPath("/app"), "/app/daemon/plugins/knowledge-graph/concept-summaries.json");
});

test("records read tolerantly; unreadable ones, unknown fields and keys survive a rewrite", () => {
  const record = (conceptId: string, extra: Record<string, unknown> = {}) => ({
    conceptId,
    hash: "h",
    members: [
      { id: "ke_a", contentHash: "ca", future: 1 },
      { id: "ke_b", contentHash: "cb" }
    ],
    inputs: ["ke_a", "ke_b"],
    text: "Warming up a new account before posting.",
    positions: [{ entryId: "ke_a", claim: "First video after 1–2 days." }],
    writtenAt: "t",
    ...extra
  });
  const raw = {
    version: 1,
    summaries: [
      record("tactic-warmup", { extra: true }),
      record("tactic-warmup", { text: "a second record of the same concept" }),
      record("tactic-empty", { members: [] }),
      record("tactic-old", { writtenAt: 5 }),
      { conceptId: "tactic-broken" }
    ],
    future: [1]
  };
  const file = readKnowledgeConceptSummariesFile(raw);
  assert.deepEqual(
    file.summaries.map((s) => [s.conceptId, s.writtenAt]),
    [
      ["tactic-warmup", "t"],
      ["tactic-old", ""]
    ]
  );
  assert.equal((file.summaries[0] as Record<string, unknown>).extra, true);
  assert.equal((file.summaries[0]!.members[0] as Record<string, unknown>).future, 1);
  assert.equal(file.unreadable.length, 3);
  assert.equal(file.readOnly, false);
  const written = JSON.parse(serializeKnowledgeConceptSummariesFile(file)) as Record<string, unknown>;
  assert.equal((written.summaries as unknown[]).length, 5);
  assert.deepEqual(written.future, [1]);
});

test("a newer version is read-only; anything but an object is empty", () => {
  assert.equal(readKnowledgeConceptSummariesFile({ version: 2, summaries: [] }).readOnly, true);
  assert.deepEqual(readKnowledgeConceptSummariesFile([]).summaries, []);
  assert.deepEqual(readKnowledgeConceptSummariesFile("x").summaries, []);
  assert.deepEqual(readKnowledgeConceptSummariesFile({ version: 1 }).summaries, []);
});
