// The entry detail's retrieval fields on the wire (retrieval spec R5): `similar` and
// `possibleDuplicates` with their reasons, read from a current daemon, absent from an older one.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseKnowledgeItemResponse, parseKnowledgeRelatedReason, parseKnowledgeSimilarEntry } from "./validate.ts";

const SELF = "ke_aaaaaaaaaaaa";

const meta = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  title: `Entry ${id}`,
  kind: "post",
  author: "Hridoy",
  handle: "hridoyreh",
  url: null,
  postedAt: null,
  savedAt: "2026-10-20T10:00:00.000Z",
  updatedAt: "2026-10-20T10:00:00.000Z",
  savedFrom: { by: "agent" },
  collections: ["kc_seo"],
  contentHash: "abc",
  linkState: "linked",
  snippet: "…",
  linkCount: 1,
  ...overrides
});

const item = (entry: Record<string, unknown>) => ({
  kind: "entry",
  entry: { entry: { ...meta(SELF), body: "Full text" }, concepts: [], related: [meta("ke_rrrrrrrrrrrr")], citation: "", ...entry }
});

function readEntry(value: unknown) {
  const parsed = parseKnowledgeItemResponse(value);
  assert.equal(parsed?.kind, "entry");
  if (parsed?.kind !== "entry") throw new Error("unreachable");
  return parsed.entry;
}

describe("entry detail retrieval fields", () => {
  it("read every reason kind", () => {
    assert.deepEqual(parseKnowledgeRelatedReason({ kind: "meaning", similarity: 0.91 }), { kind: "meaning", similarity: 0.91 });
    assert.deepEqual(
      parseKnowledgeRelatedReason({ kind: "concepts", concepts: [{ id: "tactic-a", name: "A", type: "Tactic" }, { nope: 1 }], shared: 4 }),
      { kind: "concepts", concepts: [{ id: "tactic-a", name: "A", type: "Tactic" }], shared: 4 }
    );
    assert.deepEqual(
      parseKnowledgeRelatedReason({ kind: "concepts", concepts: [{ id: "tactic-a", name: "A", type: "Tactic" }] }),
      { kind: "concepts", concepts: [{ id: "tactic-a", name: "A", type: "Tactic" }], shared: 1 },
      "shared is at least the concepts named"
    );
    assert.deepEqual(parseKnowledgeRelatedReason({ kind: "author", value: "@om_patel5" }), { kind: "author", value: "@om_patel5" });
    assert.deepEqual(parseKnowledgeRelatedReason({ kind: "meaning", similarity: 7 }), { kind: "meaning", similarity: 1 }, "clamped");
  });

  it("refuse a malformed or unknown reason", () => {
    for (const bad of [
      null,
      "meaning",
      [],
      { kind: "meaning" },
      { kind: "meaning", similarity: "0.9" },
      { kind: "meaning", similarity: Number.NaN },
      { kind: "author" },
      { kind: "author", value: "  " },
      { kind: "cited-together" }
    ]) {
      assert.equal(parseKnowledgeRelatedReason(bad), null, JSON.stringify(bad));
    }
  });

  it("read a similar entry, repairing its similarity and keeping each reason kind once", () => {
    const parsed = parseKnowledgeSimilarEntry({
      entry: meta("ke_bbbbbbbbbbbb"),
      similarity: "high",
      reasons: [{ kind: "author", value: "Hridoy" }, { kind: "later" }, { kind: "author", value: "Other" }, { kind: "meaning", similarity: 0.8 }]
    });
    assert.ok(parsed);
    assert.equal(parsed.entry.id, "ke_bbbbbbbbbbbb");
    assert.equal(parsed.similarity, null);
    assert.deepEqual(parsed.reasons, [{ kind: "author", value: "Hridoy" }, { kind: "meaning", similarity: 0.8 }]);
    assert.equal(parseKnowledgeSimilarEntry({ similarity: 0.9, reasons: [] }), null, "no entry");
    assert.equal(parseKnowledgeSimilarEntry({ entry: { title: "no id" }, similarity: 0.9, reasons: [] }), null);
    assert.equal(parseKnowledgeSimilarEntry("ke_bbbbbbbbbbbb"), null);
    assert.deepEqual(parseKnowledgeSimilarEntry({ entry: meta("ke_bbbbbbbbbbbb"), similarity: 0.5 })?.reasons, [], "reasons not a list");
  });

  it("read `similar` and `possibleDuplicates` from a current daemon", () => {
    const detail = readEntry(
      item({
        similar: [
          { entry: meta("ke_bbbbbbbbbbbb"), similarity: 0.91, reasons: [{ kind: "meaning", similarity: 0.91 }] },
          { entry: meta(SELF), similarity: 1, reasons: [{ kind: "meaning", similarity: 1 }] },
          { entry: meta("ke_cccccccccccc"), similarity: null, reasons: [{ kind: "concepts", concepts: [], shared: 2 }] },
          { entry: meta("ke_bbbbbbbbbbbb"), similarity: 0.5, reasons: [] },
          { bad: true }
        ],
        possibleDuplicates: [{ entry: meta("ke_dddddddddddd"), similarity: 0.97, reasons: [{ kind: "meaning", similarity: 0.97 }] }]
      })
    );
    assert.deepEqual(
      detail.similar?.map((s) => [s.entry.id, s.similarity]),
      [
        ["ke_bbbbbbbbbbbb", 0.91],
        ["ke_cccccccccccc", null]
      ],
      "never itself, each entry once, unreadable items left out"
    );
    assert.deepEqual(detail.possibleDuplicates?.map((s) => s.entry.id), ["ke_dddddddddddd"]);
    assert.equal(detail.possibleDuplicates?.[0]?.entry.citation, "[Entry ke_dddddddddddd · @hridoyreh](orquester-knowledge:entry/ke_dddddddddddd)");
  });

  it("leave both absent from an older daemon, or when they are not lists", () => {
    const older = readEntry(item({}));
    assert.equal("similar" in older, false);
    assert.equal("possibleDuplicates" in older, false);
    assert.deepEqual(older.related.map((r) => r.id), ["ke_rrrrrrrrrrrr"]);
    const broken = readEntry(item({ similar: { entry: meta("ke_bbbbbbbbbbbb") }, possibleDuplicates: "none" }));
    assert.equal(broken.similar, undefined);
    assert.equal(broken.possibleDuplicates, undefined);
    const empty = readEntry(item({ similar: [], possibleDuplicates: [] }));
    assert.deepEqual(empty.similar, []);
    assert.deepEqual(empty.possibleDuplicates, []);
  });
});
