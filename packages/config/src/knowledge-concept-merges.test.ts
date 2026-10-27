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

test("LLM checks and a merge's source read tolerantly and survive a rewrite", () => {
  const raw = {
    version: 1,
    merges: [{ id: "cm_a", type: "Tactic", into: "tactic-a", merged: ["tactic-b"], similarity: 0.97, createdAt: "t", source: "checked" }],
    rejected: [],
    checks: [
      { a: "tactic-a", b: "tactic-b", type: "Tactic", nameA: "A", nameB: "B", same: true, keep: "tactic-a", reason: "same", similarity: 0.97, checkedAt: "t", future: 1 },
      { a: "tactic-c", b: "tactic-d", type: "Tactic", nameA: "C", nameB: "D", same: false, keep: 7, reason: "different", similarity: 0.96, checkedAt: "t" },
      { a: "tactic-e", b: "tactic-f", same: "maybe" }
    ]
  };
  const file = parseKnowledgeConceptMergesFile(raw);
  assert.equal(file.merges[0]!.source, "checked");
  assert.deepEqual(
    file.checks.map((c) => [c.a, c.same, c.keep]),
    [
      ["tactic-a", true, "tactic-a"],
      ["tactic-c", false, null]
    ]
  );
  assert.equal((file.checks[0] as Record<string, unknown>).future, 1);
  assert.equal(file.unreadable.checks.length, 1);
  const written = JSON.parse(serializeKnowledgeConceptMergesFile(file)) as { checks: unknown[]; merges: { source?: string }[] };
  assert.equal(written.checks.length, 3);
  assert.deepEqual(written.checks[2], raw.checks[2]);
  assert.equal(written.merges[0]!.source, "checked");
  // A newer source value reads as it is; a bad one costs the field.
  assert.equal(parseKnowledgeConceptMergesFile({ version: 1, merges: [{ ...raw.merges[0], source: "future" }] }).merges[0]!.source, "future");
  assert.equal(parseKnowledgeConceptMergesFile({ version: 1, merges: [{ ...raw.merges[0], source: 5 }] }).merges[0]!.source, undefined);
});

test("a file without checks is written exactly as before; a non-list `checks` is kept as an unknown key", () => {
  const plain = parseKnowledgeConceptMergesFile({ version: 1, merges: [], rejected: [] });
  assert.equal("checks" in JSON.parse(serializeKnowledgeConceptMergesFile(plain)), false);
  const odd = parseKnowledgeConceptMergesFile({ version: 1, checks: { not: "a list" } });
  assert.deepEqual(odd.checks, []);
  assert.deepEqual(JSON.parse(serializeKnowledgeConceptMergesFile(odd)).checks, { not: "a list" });
});
