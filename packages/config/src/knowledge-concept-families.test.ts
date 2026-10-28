import assert from "node:assert/strict";
import test from "node:test";
import { knowledgeConceptFamiliesPath } from "./index.ts";
import { readKnowledgeConceptFamiliesFile, serializeKnowledgeConceptFamiliesFile } from "./knowledge-concept-families.ts";

test("the concept families file sits in the plugin dir", () => {
  assert.equal(knowledgeConceptFamiliesPath("/app"), "/app/daemon/plugins/knowledge-graph/concept-families.json");
});

test("family records read tolerantly; unreadable ones, unknown fields and keys survive a rewrite", () => {
  const record = (familyId: string, extra: Record<string, unknown> = {}) => ({
    familyId,
    concepts: ["tactic-warm-48", "tactic-warm-3"],
    hash: "h",
    members: [
      { id: "ke_a", contentHash: "ca", future: 1 },
      { id: "ke_b", contentHash: "cb" }
    ],
    inputs: ["ke_a", "ke_b"],
    attributed: ["ke_b"],
    name: "Warm-up length before the first post",
    text: "How long a new account is used normally before it posts.",
    positions: [{ entryId: "ke_a", claim: "48 hours." }],
    writtenAt: "t",
    ...extra
  });
  const raw = {
    version: 1,
    families: [
      record("family-warm", { extra: true }),
      record("family-warm", { name: "a second record of the same family" }),
      record("family-one", { concepts: ["tactic-alone"] }),
      record("family-noname", { name: "" }),
      record("family-old", { writtenAt: 5, attributed: undefined }),
      { familyId: "family-broken" }
    ],
    future: [1]
  };
  const file = readKnowledgeConceptFamiliesFile(raw);
  assert.deepEqual(
    file.families.map((f) => [f.familyId, f.writtenAt, f.attributed ?? null]),
    [
      ["family-warm", "t", ["ke_b"]],
      ["family-old", "", null]
    ]
  );
  assert.equal((file.families[0] as Record<string, unknown>).extra, true);
  assert.equal((file.families[0]!.members[0] as Record<string, unknown>).future, 1);
  assert.equal(file.unreadable.length, 4);
  assert.equal(file.readOnly, false);
  const written = JSON.parse(serializeKnowledgeConceptFamiliesFile(file)) as Record<string, unknown>;
  assert.equal((written.families as unknown[]).length, 6);
  assert.deepEqual(written.future, [1]);
});

test("a newer version is read-only; anything but an object is empty", () => {
  assert.equal(readKnowledgeConceptFamiliesFile({ version: 2, families: [] }).readOnly, true);
  assert.deepEqual(readKnowledgeConceptFamiliesFile([]).families, []);
  assert.deepEqual(readKnowledgeConceptFamiliesFile("x").families, []);
  assert.deepEqual(readKnowledgeConceptFamiliesFile({ version: 1 }).families, []);
});
