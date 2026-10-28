import assert from "node:assert/strict";
import { test } from "node:test";

import { Bm25Index } from "./bm25.ts";

test("a query term may be a group of alternatives: a document scores the best of them, once", () => {
  const index = new Bm25Index();
  index.add("both", [{ tokens: ["phone", "iphone", "account"], weight: 1 }]);
  index.add("one", [{ tokens: ["iphone", "account", "note"], weight: 1 }]);
  index.add("none", [{ tokens: ["account", "note", "other"], weight: 1 }]);
  const score = (terms: Parameters<Bm25Index["search"]>[0]) => new Map(index.search(terms, () => true, 10).map((hit) => [hit.key, hit.score]));
  const grouped = score([["phone", "iphone", "device"], "account"]);
  assert.deepEqual([...grouped.keys()].sort(), ["both", "none", "one"]);
  const apart = score(["phone", "iphone", "account"]);
  assert.ok(grouped.get("both")! < apart.get("both")!, "two alternatives held count once, not twice");
  assert.equal(grouped.get("one"), apart.get("one"), "one alternative held scores as that term alone");
  assert.deepEqual(score([["phone"], ["phone"]]), score(["phone"]), "a repeated group counts once");
  assert.equal(index.has("iphone"), true);
  assert.equal(index.has("device"), false);
  assert.equal(index.documentFrequency("account"), 3);
  assert.equal(index.size(), 3);
});
