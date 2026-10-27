import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isKnowledgeEntryId,
  knowledgeEntryFrontmatterSchema,
  parseKnowledgeCollectionsConfig,
  serializeKnowledgeCollectionsFile
} from "./index.ts";

const HASH = "ab".repeat(32);
const AT = "2026-10-23T10:00:00.000Z";

const collection = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "kc_abcdefghij",
  name: "SEO",
  description: "Search engines",
  color: "chart-2",
  createdAt: AT,
  updatedAt: AT,
  ...overrides
});

test("entry ids follow the stored file-name contract", () => {
  assert.ok(isKnowledgeEntryId("ke_abcdefgh2345"));
  assert.ok(!isKnowledgeEntryId("ke_ABCDEFGH2345"));
  assert.ok(!isKnowledgeEntryId("ke_abc"));
});

test("collections file: unknown fields, unreadable records and unknown keys survive a rewrite", () => {
  const raw = {
    version: 1,
    future: { keep: true },
    collections: [
      collection({ extraField: 7 }),
      { id: "not-an-id", name: "x" },
      collection({ id: "kc_abcdefgh234", name: "Too-long id" }),
      collection({ id: "kc_bbbbbbbbbb", name: "seo" }), // repeated name (case-insensitive)
      collection({ id: "kc_abcdefghij", name: "Other" }), // repeated id
      collection({ id: "kc_cccccccccc", name: "Ads", color: "neon" })
    ]
  };
  const file = parseKnowledgeCollectionsConfig(raw);
  assert.deepEqual(
    file.collections.map((c) => [c.id, c.name, c.color]),
    [
      ["kc_abcdefghij", "SEO", "chart-2"],
      ["kc_cccccccccc", "Ads", "neon"]
    ]
  );
  assert.equal((file.collections[0] as Record<string, unknown>).extraField, 7);
  assert.equal(file.rejected.length, 4);
  const written = serializeKnowledgeCollectionsFile(file) as { collections: unknown[]; future: unknown };
  assert.equal(written.collections.length, 6);
  assert.equal((written.collections[1] as { color: string }).color, "neon");
  assert.deepEqual(written.future, { keep: true });
  assert.deepEqual(written.collections[2], raw.collections[1]);
});

test("collections file: a bare array reads as version 1; a wrong outer shape throws", () => {
  const fromArray = parseKnowledgeCollectionsConfig([collection({ color: undefined })]);
  assert.equal(fromArray.collections.length, 1);
  assert.equal(fromArray.collections[0]?.color, "chart-1");
  assert.throws(() => parseKnowledgeCollectionsConfig({ version: 2, collections: [] }));
  assert.throws(() => parseKnowledgeCollectionsConfig("nope"));
  assert.throws(() => parseKnowledgeCollectionsConfig({ collections: {} }));
  assert.deepEqual(parseKnowledgeCollectionsConfig({}).collections, []);
});

test("entry frontmatter: defaults, tolerated variants, and unknown keys kept", () => {
  const parsed = knowledgeEntryFrontmatterSchema.parse({
    id: "ke_abcdefgh2345",
    title: "T",
    savedAt: AT,
    savedFrom: "session-1",
    contentHash: HASH,
    linkState: "something-new",
    author: "",
    future: [1, 2]
  });
  assert.equal(parsed.kind, "note");
  assert.equal(parsed.author, null);
  assert.equal(parsed.handle, null);
  assert.deepEqual(parsed.savedFrom, { by: "agent", sessionId: "session-1" });
  assert.equal(parsed.linkState, "pending");
  assert.deepEqual(parsed.collections, []);
  assert.deepEqual((parsed as Record<string, unknown>).future, [1, 2]);
  assert.equal(knowledgeEntryFrontmatterSchema.safeParse({ id: "ke_abcdefgh2345", title: "T", savedAt: AT }).success, false);
  assert.equal(
    knowledgeEntryFrontmatterSchema.safeParse({ id: "bad", title: "T", savedAt: AT, contentHash: HASH }).success,
    false
  );
});

test("entry frontmatter: savedFrom keeps unknown keys, and an unknown `by` still reads", () => {
  const base = { id: "ke_abcdefgh2345", title: "T", savedAt: AT, contentHash: HASH };
  const unknownKey = knowledgeEntryFrontmatterSchema.parse({ ...base, savedFrom: { by: "agent", sessionId: "s-1", via: "mcp" } });
  assert.deepEqual(unknownKey.savedFrom, { by: "agent", sessionId: "s-1", via: "mcp" });
  const unknownBy = knowledgeEntryFrontmatterSchema.safeParse({ ...base, savedFrom: { by: "workflow", runId: "run-1" } });
  assert.ok(unknownBy.success);
  assert.deepEqual(unknownBy.data.savedFrom, { by: "workflow", runId: "run-1" });
});
