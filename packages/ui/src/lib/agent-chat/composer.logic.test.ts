import assert from "node:assert/strict";
import { describe,it } from "node:test";


import {
attachmentPathOf,
MAX_COMPOSER_QUOTE_CHARS,
MAX_COMPOSER_QUOTES,
parsePersistedDrafts,
parsePersistedQuotes,
readPersistedDrafts,
writePersistedDrafts
} from "./composer.logic";

describe("persisted quotes", () => {
  it("keeps the well-formed quotes of a partly-malformed list, narrowed to their own fields", () => {
    assert.deepEqual(
      parsePersistedQuotes([
        { id: "a", text: "kept", extra: true },
        { id: "", text: "no id" },
        { id: "b", text: "   " },
        { id: "c", text: 7 },
        { id: "d", text: "x".repeat(MAX_COMPOSER_QUOTE_CHARS + 1) },
        null,
        "string",
        { id: "a", text: "a repeated id" },
        { id: "e", text: "also kept" }
      ]),
      [
        { id: "a", text: "kept" },
        { id: "e", text: "also kept" }
      ]
    );
  });

  it("reads anything that is not a list as no quotes, and bounds the count", () => {
    assert.deepEqual(parsePersistedQuotes(undefined), []);
    assert.deepEqual(parsePersistedQuotes({ id: "a", text: "t" }), []);
    const many = Array.from({ length: MAX_COMPOSER_QUOTES + 5 }, (_, index) => ({ id: `q${index}`, text: "t" }));
    assert.equal(parsePersistedQuotes(many).length, MAX_COMPOSER_QUOTES);
  });

  it("loads a draft's quotes, and leaves the field off a draft without any", () => {
    const drafts = parsePersistedDrafts(
      JSON.stringify({
        s1: { text: "", attachments: [], context: [], quotes: [{ id: "q", text: "> passage" }] },
        s2: { text: "plain", attachments: [], context: [], quotes: "garbage" },
        s3: { text: "older bundle", attachments: [], context: [] }
      })
    );
    assert.deepEqual(drafts.s1?.quotes, [{ id: "q", text: "> passage" }]);
    assert.equal(drafts.s1?.text, "", "a draft of quotes alone is a draft");
    assert.equal("quotes" in drafts.s2!, false);
    assert.equal("quotes" in drafts.s3!, false);
  });

  it("keeps a draft of quotes alone in storage, and reads it back", () => {
    const store = new Map<string, string>();
    const saved = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => void store.set(key, value),
        removeItem: (key: string) => void store.delete(key)
      }
    });
    try {
      writePersistedDrafts({
        quoted: { text: "", attachments: [], context: [], quotes: [{ id: "q", text: "passage" }] },
        empty: { text: "  ", attachments: [], context: [] }
      });
      assert.deepEqual(readPersistedDrafts(), {
        quoted: { text: "", attachments: [], context: [], quotes: [{ id: "q", text: "passage" }] }
      });
    } finally {
      if (saved) Object.defineProperty(globalThis, "localStorage", saved);
      else delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  });
});

describe("persisted drafts", () => {
  it("survives garbage without letting it reach typed code", () => {
    assert.deepEqual(parsePersistedDrafts(null), {});
    assert.deepEqual(parsePersistedDrafts("not json"), {});
    assert.deepEqual(parsePersistedDrafts("[1,2]"), {});
    assert.deepEqual(parsePersistedDrafts(JSON.stringify({ s1: { text: 42 } })), {});
  });

  it("keeps the valid entries of a partly-malformed blob", () => {
    const parsed = parsePersistedDrafts(
      JSON.stringify({
        s1: { text: "hi", attachments: [{ type: "file", id: "a", name: "a", sizeBytes: 1 }, 7], context: "x" },
        s2: null
      })
    );
    assert.equal(parsed.s1?.text, "hi");
    assert.equal(parsed.s1?.attachments.length, 1);
    assert.deepEqual(parsed.s1?.context, []);
    assert.equal(parsed.s2, undefined);
  });

  it("keeps a string path on a persisted ref and drops a malformed one, so an old blob still loads", () => {
    const raw = JSON.stringify({
      s1: {
        text: "see /a/x.xlsx",
        attachments: [
          { type: "file", id: "a", name: "x.xlsx", sizeBytes: 1, path: "/a/x.xlsx" },
          { type: "file", id: "b", name: "y.csv", sizeBytes: 1, path: 123 },
          { type: "file", id: "c", name: "z.txt", sizeBytes: 1 },
          { type: "file", id: "d", name: "n.csv", sizeBytes: 2, path: null },
          { type: "file", id: "e", name: "e.txt", sizeBytes: 3, mimeType: "text/plain", path: "" }
        ],
        context: []
      }
    });
    const drafts = parsePersistedDrafts(raw);
    const [a, b, c, d, e] = drafts.s1!.attachments;
    assert.equal(attachmentPathOf(a), "/a/x.xlsx");
    assert.equal("path" in b!, false);
    assert.equal(attachmentPathOf(c), undefined);
    // `null` and `""` are not paths either: the field goes, everything else stays.
    assert.equal("path" in d!, false);
    assert.deepEqual(d, { type: "file", id: "d", name: "n.csv", sizeBytes: 2 });
    assert.equal("path" in e!, false);
    assert.deepEqual(e, { type: "file", id: "e", name: "e.txt", sizeBytes: 3, mimeType: "text/plain" });
  });
});
