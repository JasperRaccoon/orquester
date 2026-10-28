import assert from "node:assert/strict";
import { test } from "node:test";

import { Bm25Index } from "./bm25.ts";
import { claimFigure, namesPhrase, statesClaimNumber } from "./mentions.ts";
import { tokenize } from "./text.ts";

test("a phrase is named as words in order, across punctuation, never inside a longer word", () => {
  const jason = "4) turn off mobile data, then Settings → [your apple id] → Find My → Find My iPhone → off";
  assert.equal(namesPhrase(jason, "Find My iPhone"), true);
  assert.equal(namesPhrase("find-my-iphone is off", "Find My iPhone"), true);
  assert.equal(namesPhrase("Find My is off on this iPhone", "Find My iPhone"), false, "the words, not in order");
  assert.equal(namesPhrase("a proxyless setup", "Proxy"), false);
  assert.equal(namesPhrase("Use Shadowrocket (~$3).", "shadowrocket"), true);
  assert.equal(namesPhrase("an AI tool", "AI"), false, "one word under three letters names nothing");
});

test("a claim's figure is stated when one sentence holds its numbers and half its words", () => {
  assert.deepEqual(claimFigure("231 configurable settings in Candy Crush"), { numbers: ["231"], words: ["configurable", "settings", "candy", "crush"] });
  const awxkm = "Subway Surfers (112 live rule versions shipped as JSON), Candy Crush (231 configurable settings) and Block Blast all change behaviour after review.";
  assert.equal(statesClaimNumber(awxkm, "231 configurable settings in Candy Crush"), true);
  assert.equal(statesClaimNumber("https://searchengineland.com/google-num100-impact-data-462231 settings", "231 configurable settings in Candy Crush"), false, "not inside another number");
  assert.equal(statesClaimNumber("Candy Crush has 231 levels. Its settings are configurable.", "231 configurable settings in Candy Crush"), true, "half the words: candy, crush");
  assert.equal(statesClaimNumber("We saw 231 visitors.", "231 configurable settings in Candy Crush"), false, "the number alone");
  assert.equal(statesClaimNumber("Candy Crush has configurable settings.", "Configurable settings in Candy Crush"), false, "no figure to state");
  assert.equal(statesClaimNumber("Warm up for 3-5 days first.", "3-5 days of warming up"), true);
});

test("the keyword index lists the documents holding every term", () => {
  const index = new Bm25Index();
  index.add("a", [{ tokens: tokenize("Find my iPhone off"), weight: 1 }]);
  index.add("b", [{ tokens: tokenize("Find a used iPhone"), weight: 1 }]);
  index.add("c", [{ tokens: tokenize("my notes"), weight: 1 }]);
  assert.deepEqual(index.keysWithAll(["find", "iphone"]).sort(), ["a", "b"]);
  assert.deepEqual(index.keysWithAll(["find", "off"]), ["a"]);
  assert.deepEqual(index.keysWithAll(["nothing"]), []);
  assert.deepEqual(index.keysWithAll([]), []);
});
