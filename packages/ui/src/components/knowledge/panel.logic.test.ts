import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { KnowledgeEntryDetail, KnowledgeSimilarEntry } from "@orquester/api";

import { entry, summary } from "../../lib/knowledge/fixtures.test-helpers.ts";
import { entryPanelIds, knowledgeMergePlan, markdownBodyPreview, mergeErrorText, similarSection } from "./panel.logic.ts";

const SELF = "ke_aaaaaaaaaaaa";

function similar(id: string, overrides: Partial<KnowledgeSimilarEntry> = {}, entryOverrides: Parameters<typeof summary>[0] = {}): KnowledgeSimilarEntry {
  return { entry: summary({ id, title: `Entry ${id.slice(-1)}`, ...entryOverrides }), similarity: null, reasons: [], ...overrides };
}

function detail(overrides: Partial<KnowledgeEntryDetail> = {}): KnowledgeEntryDetail {
  return { entry: entry(), concepts: [], related: [], citation: "", ...overrides };
}

describe("the similar section", () => {
  it("orders by similarity (none last), then shared concepts, then newest, then id; meaning first in each", () => {
    const concepts = (shared: number) => ({ kind: "concepts" as const, concepts: [], shared });
    const items = [
      similar("ke_bbbbbbbbbbb1", { similarity: null, reasons: [concepts(1)] }, { savedAt: "2026-10-01T00:00:00Z" }),
      similar("ke_bbbbbbbbbbb2", { similarity: 0.8, reasons: [{ kind: "author", value: "x" }, { kind: "meaning", similarity: 0.8 }] }),
      similar("ke_bbbbbbbbbbb3", { similarity: 0.95, reasons: [{ kind: "meaning", similarity: 0.95 }] }),
      similar("ke_bbbbbbbbbbb4", { similarity: null, reasons: [concepts(3)] }),
      similar("ke_bbbbbbbbbbb5", { similarity: null, reasons: [concepts(1)] }, { savedAt: "2026-10-05T00:00:00Z" }),
      similar("ke_bbbbbbbbbbb6", { similarity: null, reasons: [concepts(1)] }, { savedAt: "2026-10-05T00:00:00Z" })
    ];
    const { items: ordered } = similarSection(detail({ similar: items }));
    assert.deepEqual(
      ordered.map((i) => i.entry.id.slice(-1)),
      ["3", "2", "4", "5", "6", "1"]
    );
    assert.deepEqual(ordered[1]!.reasons.map((r) => r.kind), ["meaning", "author"]);
  });

  it("never lists the entry itself or one entry twice, and at most eight", () => {
    const many = Array.from({ length: 12 }, (_, i) => similar(`ke_cccccccccc${String(i).padStart(2, "0")}`, { similarity: 0.9 - i / 100 }));
    const { items } = similarSection(detail({ similar: [similar(SELF, { similarity: 1 }), ...many, many[0]!] }));
    assert.equal(items.length, 8);
    assert.ok(!items.some((i) => i.entry.id === SELF));
    assert.equal(new Set(items.map((i) => i.entry.id)).size, items.length);
    assert.equal(items[0]!.entry.id, many[0]!.entry.id);
  });

  it("falls back to the concept-related entries from a daemon without `similar`", () => {
    const related = [summary({ id: "ke_dddddddddddd" }), summary({ id: SELF }), summary({ id: "ke_eeeeeeeeeeee" })];
    const section = similarSection(detail({ related }));
    assert.deepEqual(section.items.map((i) => i.entry.id), ["ke_dddddddddddd", "ke_eeeeeeeeeeee"], "in the daemon's order");
  });

  it("keeps an empty `similar` (a current daemon found nothing) instead of falling back", () => {
    const section = similarSection(detail({ similar: [], related: [summary({ id: "ke_dddddddddddd" })] }));
    assert.deepEqual(section, { items: [] });
  });

  it("lists every entry the panel shows for staleness", () => {
    const ids = entryPanelIds(
      detail({
        related: [summary({ id: "ke_r00000000000" })],
        similar: [similar("ke_s00000000000")],
        possibleDuplicates: [similar("ke_d00000000000")]
      })
    );
    assert.deepEqual(ids, [SELF, "ke_r00000000000", "ke_s00000000000", "ke_d00000000000"]);
  });
});

describe("merging a possible duplicate", () => {
  const older = { id: "ke_old000000000", title: "Original", savedAt: "2026-10-01T10:00:00.000Z", collections: ["kc_seo"] };
  const newer = { id: "ke_new000000000", title: "Copy", savedAt: "2026-10-20T10:00:00.000Z", collections: ["kc_ads", "kc_seo", "kc_ads"] };

  it("keeps the older entry and deletes the newer, whichever is open", () => {
    const fromNewer = knowledgeMergePlan(newer, older);
    assert.equal(fromNewer.keep.id, older.id);
    assert.equal(fromNewer.remove.id, newer.id);
    assert.equal(fromNewer.removesOpen, true);
    const fromOlder = knowledgeMergePlan(older, newer);
    assert.equal(fromOlder.keep.id, older.id);
    assert.equal(fromOlder.remove.id, newer.id);
    assert.equal(fromOlder.removesOpen, false);
  });

  it("warns that a server or network failure may leave the merge unfinished", () => {
    for (const error of [
      Object.assign(new Error("The merge stopped part-way."), { status: 500, body: { code: "KNOWLEDGE_ERROR", message: "The merge stopped part-way." } }),
      new Error("Network down")
    ]) {
      const shown = mergeErrorText(error);
      assert.match(shown, /may not have finished/i);
      assert.ok(shown.includes(error.message));
    }
  });
});

describe("the body's Markdown preview", () => {
  it("never splits a surrogate pair and closes an open code fence", () => {
    const emoji = `${"a".repeat(99)}😀${"b".repeat(50)}`;
    const cut = markdownBodyPreview(emoji, 100);
    assert.equal(cut.text, "a".repeat(99));
    const fenced = `intro\n\n\`\`\`ts\n${"const x = 1;\n".repeat(20)}`;
    const preview = markdownBodyPreview(fenced, 100);
    assert.match(preview.text, /\n```$/);
    assert.ok(preview.rest > 0);
  });

  it("closes an open fence with its own character and length", () => {
    const four = `intro\n\n\`\`\`\`md\n\`\`\`\n${"inner line\n".repeat(20)}`;
    assert.match(markdownBodyPreview(four, 100).text, /\n````$/);
    const tilde = `intro\n\n~~~\n\`\`\`\n${"inner line\n".repeat(20)}`;
    assert.match(markdownBodyPreview(tilde, 100).text, /\n~~~$/);
  });
});
