import assert from "node:assert/strict";
import { describe,it } from "node:test";


import {
attachmentPathOf,
parsePersistedDrafts
} from "./composer.logic";

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
