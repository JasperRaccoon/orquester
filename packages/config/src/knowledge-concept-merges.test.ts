import assert from "node:assert/strict";
import test from "node:test";
import { knowledgeConceptMergesPath } from "./index.ts";
import { parseKnowledgeConceptMergesFile, serializeKnowledgeConceptMergesFile } from "./knowledge-concept-merges.ts";

test("the concept merges file sits in the plugin dir", () => {
  assert.equal(knowledgeConceptMergesPath("/app"), "/app/daemon/plugins/knowledge-graph/concept-merges.json");
});

test("a record this build cannot read is kept verbatim; unknown fields and keys survive a rewrite", () => {
  const raw = {
    version: 1,
    merges: [
      { id: "cm_a", type: "Tactic", into: "tactic-a", merged: ["tactic-b"], similarity: 0.95, createdAt: "t", note: "newer" },
      { id: "cm_b", type: "Tactic", into: "tactic-c", merged: [] },
      { id: "cm_a", type: "Tactic", into: "tactic-x", merged: ["tactic-y"], similarity: 0.9, createdAt: "t" },
      { id: "cm_c", type: "Tool", into: "tool-a", merged: ["tool-b"], similarity: "high" }
    ],
    rejected: [{ id: "cm_z", type: "Tactic", concepts: ["tactic-p", "tactic-q"], rejectedAt: "t" }, { id: "cm_y", concepts: ["one"] }],
    future: { kept: true }
  };
  const file = parseKnowledgeConceptMergesFile(raw);
  assert.deepEqual(
    file.merges.map((m) => m.id),
    ["cm_a", "cm_c"]
  );
  assert.equal(file.merges[1]!.similarity, 0, "a bad value costs that field");
  assert.equal((file.merges[0] as Record<string, unknown>).note, "newer");
  assert.equal(file.unreadable.merges.length, 2);
  assert.deepEqual(
    file.rejected.map((r) => r.id),
    ["cm_z"]
  );
  const written = JSON.parse(serializeKnowledgeConceptMergesFile(file)) as Record<string, unknown>;
  assert.deepEqual(written.future, { kept: true });
  assert.equal((written.merges as unknown[]).length, 4);
  assert.equal((written.rejected as unknown[]).length, 2);
  assert.deepEqual((written.merges as unknown[])[2], raw.merges[1]);
});

test("not a version-1 object throws (the daemon leaves the file alone)", () => {
  assert.throws(() => parseKnowledgeConceptMergesFile({ version: 2, merges: [] }));
  assert.throws(() => parseKnowledgeConceptMergesFile([]));
  assert.throws(() => parseKnowledgeConceptMergesFile("x"));
  assert.deepEqual(parseKnowledgeConceptMergesFile({ version: 1 }).merges, []);
});
