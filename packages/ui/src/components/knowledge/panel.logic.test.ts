import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { knowledgeMergeKeep, type KnowledgeEntryDetail, type KnowledgeMergeRequest, type KnowledgeSimilarEntry } from "@orquester/api";

import { collections, entry, summary } from "../../lib/knowledge/fixtures.test-helpers.ts";
import { knowledgeStore, resetKnowledge, type KnowledgeApi } from "../../lib/knowledge/store.ts";
import {
  MARKDOWN_BODY_PREVIEW_CHARS,
  SIMILAR_MAX,
  entryPanelIds,
  isDuplicatePairKept,
  isPlainTextBody,
  keepDuplicatePair,
  knowledgeMergePlan,
  markdownBodyPreview,
  openCodeFence,
  mergeConfirmMessage,
  mergeErrorText,
  panelSessionVersion,
  reasonLabel,
  reasonTitle,
  resetPanelSession,
  runKnowledgeMerge,
  setPlainTextBody,
  similarSection,
  subscribePanelSession,
  visibleDuplicates
} from "./panel.logic.ts";

const SELF = "ke_aaaaaaaaaaaa";
const ref = (name: string) => ({ id: `tactic-${name.toLowerCase()}`, name, type: "Tactic" });

function similar(id: string, overrides: Partial<KnowledgeSimilarEntry> = {}, entryOverrides: Parameters<typeof summary>[0] = {}): KnowledgeSimilarEntry {
  return { entry: summary({ id, title: `Entry ${id.slice(-1)}`, ...entryOverrides }), similarity: null, reasons: [], ...overrides };
}

function detail(overrides: Partial<KnowledgeEntryDetail> = {}): KnowledgeEntryDetail {
  return { entry: entry(), concepts: [], related: [], citation: "", ...overrides };
}

describe("reason chips", () => {
  it("label meaning as a percentage, concepts by name, and an author", () => {
    assert.equal(reasonLabel({ kind: "meaning", similarity: 0.912 }), "Meaning 91%");
    assert.equal(reasonLabel({ kind: "meaning", similarity: 1.4 }), "Meaning 100%");
    assert.equal(reasonLabel({ kind: "meaning", similarity: -0.2 }), "Meaning 0%");
    assert.equal(reasonLabel({ kind: "concepts", concepts: [ref("A"), ref("B")], shared: 2 }), "Concepts: A, B");
    assert.equal(reasonLabel({ kind: "concepts", concepts: [ref("A"), ref("B"), ref("C")], shared: 5 }), "Concepts: A, B, C +2");
    assert.equal(reasonLabel({ kind: "concepts", concepts: [], shared: 1 }), "1 shared concept");
    assert.equal(reasonLabel({ kind: "concepts", concepts: [], shared: 4 }), "4 shared concepts");
    assert.equal(reasonLabel({ kind: "concepts", concepts: [], shared: 0 }), "Shared concepts");
    assert.equal(reasonLabel({ kind: "author", value: "Om Patel" }), "Same author");
  });

  it("say who the author is and how many concepts are shared in the tooltip", () => {
    assert.equal(reasonTitle({ kind: "author", value: "@om_patel5" }), "Also by @om_patel5");
    assert.equal(reasonTitle({ kind: "concepts", concepts: [ref("A")], shared: 3 }), "3 shared concepts");
    assert.equal(reasonTitle({ kind: "concepts", concepts: [ref("A")], shared: 1 }), undefined);
    assert.equal(reasonTitle({ kind: "meaning", similarity: 0.9 }), undefined);
  });
});

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
    const { items: ordered, fallback } = similarSection(detail({ similar: items }));
    assert.equal(fallback, false);
    assert.deepEqual(
      ordered.map((i) => i.entry.id.slice(-1)),
      ["3", "2", "4", "5", "6", "1"]
    );
    assert.deepEqual(ordered[1]!.reasons.map((r) => r.kind), ["meaning", "author"]);
  });

  it("never lists the entry itself or one entry twice, and at most eight", () => {
    const many = Array.from({ length: 12 }, (_, i) => similar(`ke_cccccccccc${String(i).padStart(2, "0")}`, { similarity: 0.9 - i / 100 }));
    const { items } = similarSection(detail({ similar: [similar(SELF, { similarity: 1 }), ...many, many[0]!] }));
    assert.equal(items.length, SIMILAR_MAX);
    assert.ok(!items.some((i) => i.entry.id === SELF));
    assert.equal(new Set(items.map((i) => i.entry.id)).size, items.length);
    assert.equal(items[0]!.entry.id, many[0]!.entry.id);
  });

  it("falls back to the concept-related entries from a daemon without `similar`", () => {
    const related = [summary({ id: "ke_dddddddddddd" }), summary({ id: SELF }), summary({ id: "ke_eeeeeeeeeeee" })];
    const section = similarSection(detail({ related }));
    assert.equal(section.fallback, true);
    assert.deepEqual(section.items.map((i) => i.entry.id), ["ke_dddddddddddd", "ke_eeeeeeeeeeee"], "in the daemon's order");
    assert.deepEqual(section.items.map((i) => i.reasons.map(reasonLabel)), [["Shared concepts"], ["Shared concepts"]]);
  });

  it("keeps an empty `similar` (a current daemon found nothing) instead of falling back", () => {
    const section = similarSection(detail({ similar: [], related: [summary({ id: "ke_dddddddddddd" })] }));
    assert.deepEqual(section, { items: [], fallback: false });
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

  it("compares instants, not text, and keeps the smaller id at the same instant", () => {
    const offset = { ...older, savedAt: "2026-10-01T12:00:00+05:00" }; // 07:00Z, older than 10:00Z
    assert.equal(knowledgeMergePlan({ ...newer, savedAt: "2026-10-01T10:00:00.000Z" }, offset).keep.id, older.id);
    const same = { ...newer, savedAt: older.savedAt };
    assert.equal(knowledgeMergePlan(same, older).keep.id, newer.id < older.id ? newer.id : older.id);
    assert.equal(knowledgeMergePlan(older, same).keep.id, newer.id < older.id ? newer.id : older.id);
  });

  it("gives the kept entry the union of collections, its own first; none when it has them all", () => {
    assert.deepEqual(knowledgeMergePlan(older, newer).collections, ["kc_seo", "kc_ads"]);
    assert.equal(knowledgeMergePlan({ ...older, collections: ["kc_seo", "kc_ads"] }, newer).collections, null);
    assert.equal(knowledgeMergePlan(older, { ...newer, collections: [] }).collections, null);
  });

  it("says in the confirmation which entry stays and which is deleted", () => {
    const deletesOpen = mergeConfirmMessage(knowledgeMergePlan(newer, older));
    assert.match(deletesOpen, /Keeps the older entry, “Original” \(saved Oct 1, 2026\), and deletes this one \(saved Oct 20, 2026\)/);
    assert.match(deletesOpen, /adds its collections to the one kept\.$/);
    const deletesOther = mergeConfirmMessage(knowledgeMergePlan(older, { ...newer, collections: ["kc_seo"] }));
    assert.match(deletesOther, /Keeps this entry, the older one \(saved Oct 1, 2026\), and deletes “Copy”/);
    assert.match(deletesOther, /already has all its collections/);
  });

  it("picks the entry the daemon keeps by default (the shared rule)", () => {
    for (const [a, b] of [
      [newer, older],
      [older, newer],
      [{ ...newer, savedAt: older.savedAt }, older],
      [{ ...older, savedAt: "not a date" }, newer]
    ] as const) {
      assert.equal(knowledgeMergePlan(a, b).keep, knowledgeMergeKeep([a, b]));
    }
  });

  describe("running it", () => {
    let calls: string[];
    let fail: unknown;
    const api: KnowledgeApi = {
      connection: { id: "c1" },
      getKnowledgeStatus: async () => {
        throw new Error("unused");
      },
      listKnowledgeCollections: async () => (calls.push("collections"), collections()),
      createKnowledgeCollection: async () => ({}),
      updateKnowledgeCollection: async () => ({}),
      deleteKnowledgeCollection: async () => ({}),
      updateKnowledgeEntry: async (id: string) => (calls.push(`patch:${id}`), {}),
      deleteKnowledgeEntry: async (id: string) => (calls.push(`delete:${id}`), {}),
      mergeKnowledgeEntries: async (req: KnowledgeMergeRequest) => {
        calls.push(`merge:${JSON.stringify(req)}`);
        if (fail) throw fail;
        return {};
      }
    };
    const refusal = (status: number, code: string, message: string) => Object.assign(new Error(message), { status, body: { code, message } });

    beforeEach(() => {
      calls = [];
      fail = undefined;
      resetKnowledge();
    });

    it("is one merge call naming the entry kept, and answers the kept id", async () => {
      const kept = await runKnowledgeMerge(api, knowledgeMergePlan(newer, older));
      assert.equal(kept, older.id);
      assert.deepEqual(calls.filter((c) => c !== "collections"), [`merge:{"ids":["${older.id}","${newer.id}"],"keep":"${older.id}"}`]);
      const state = knowledgeStore.getState();
      assert.deepEqual(state.changedEntryIds, [older.id, newer.id], "both entries' panels and citations read again");
    });

    it("says nothing was merged when the daemon refuses, and that it may not have finished otherwise", async () => {
      fail = refusal(404, "KNOWLEDGE_NOT_FOUND", `No such entry: ${older.id}.`);
      const error = await runKnowledgeMerge(api, knowledgeMergePlan(newer, older)).then(
        () => assert.fail("rejects"),
        (e: unknown) => e
      );
      assert.equal(mergeErrorText(error), `Nothing was merged: No such entry: ${older.id}.`);
      assert.equal(
        mergeErrorText(refusal(500, "KNOWLEDGE_ERROR", "The merge stopped part-way.")),
        "The merge may not have finished: The merge stopped part-way."
      );
      assert.equal(mergeErrorText(new Error("Network down")), "The merge may not have finished: Network down");
    });
  });
});

describe("the body's Markdown preview", () => {
  it("keeps a short body whole", () => {
    assert.deepEqual(markdownBodyPreview("Hello"), { text: "Hello", rest: 0 });
    const exact = "x".repeat(MARKDOWN_BODY_PREVIEW_CHARS);
    assert.deepEqual(markdownBodyPreview(exact), { text: exact, rest: 0 });
  });

  it("cuts a long body at a paragraph break, else a line break, else the limit", () => {
    const paragraphs = `${"a".repeat(70)}\n\n${"b".repeat(20)}\n${"c".repeat(40)}`;
    assert.deepEqual(markdownBodyPreview(paragraphs, 100), { text: "a".repeat(70), rest: paragraphs.length - 70 });
    const lines = `${"a".repeat(60)}\n${"b".repeat(60)}`;
    assert.deepEqual(markdownBodyPreview(lines, 100), { text: "a".repeat(60), rest: lines.length - 60 });
    const solid = "z".repeat(150);
    assert.deepEqual(markdownBodyPreview(solid, 100), { text: "z".repeat(100), rest: 50 });
  });

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

  it("tracks code fences as CommonMark does", () => {
    assert.equal(openCodeFence("```ts\ncode"), "```");
    assert.equal(openCodeFence("```ts\ncode\n```"), null);
    // Inside a ~~~ block, ``` is text; a shorter run does not close a longer fence.
    assert.equal(openCodeFence("~~~\n```\ncode"), "~~~");
    assert.equal(openCodeFence("~~~~\n~~~\ncode"), "~~~~");
    assert.equal(openCodeFence("~~~~\ncode\n~~~~~  "), null);
    // A closing fence takes no info string; a backtick info string with a backtick opens nothing.
    assert.equal(openCodeFence("```\ncode\n``` js"), "```");
    assert.equal(openCodeFence("``` a`b\ntext"), null);
    // Four spaces of indent is an indented code block, not a fence.
    assert.equal(openCodeFence("    ```\ntext"), null);
  });
});

describe("the panel's session memory", () => {
  beforeEach(() => resetPanelSession());

  it("remembers plain text across panels and tells subscribers", () => {
    let told = 0;
    const off = subscribePanelSession(() => (told += 1));
    const before = panelSessionVersion();
    assert.equal(isPlainTextBody(), false);
    setPlainTextBody(true);
    setPlainTextBody(true);
    assert.equal(isPlainTextBody(), true);
    assert.equal(told, 1, "only a change is news");
    assert.notEqual(panelSessionVersion(), before);
    off();
  });

  it("hides a pair kept as both from either entry's banner", () => {
    const a = "ke_aaaaaaaaaaaa";
    const b = "ke_bbbbbbbbbbbb";
    const c = "ke_cccccccccccc";
    const fromA = detail({ entry: entry({ id: a }), possibleDuplicates: [similar(b, { similarity: 0.97 }), similar(c, { similarity: 0.96 })] });
    assert.deepEqual(visibleDuplicates(fromA).map((d) => d.entry.id), [b, c]);
    keepDuplicatePair(a, b);
    assert.ok(isDuplicatePairKept(b, a));
    assert.deepEqual(visibleDuplicates(fromA).map((d) => d.entry.id), [c]);
    const fromB = detail({ entry: entry({ id: b }), possibleDuplicates: [similar(a)] });
    assert.deepEqual(visibleDuplicates(fromB), []);
    assert.deepEqual(visibleDuplicates(detail()), [], "an older daemon sends none");
  });
});
