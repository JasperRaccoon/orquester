/**
 * The history page cursor (design 2026-09-23 "thread index and lazy boot").
 */

import assert from "node:assert/strict";
import test from "node:test";

import { decodeHistoryCursor, encodeHistoryCursor } from "./history-cursor.ts";
import type { HistoryCursor } from "./history-cursor.ts";

const THREAD = "5f3c9a2e-1b7d-4c1e-9f00-6a2b3c4d5e6f";

const cursor: HistoryCursor = {
  threadId: THREAD,
  beforeAnchorAt: "2026-09-23T10:11:12.345Z",
  beforeTurnId: "turn_01J8Z3"
};

/** base64url of raw bytes, the test's own spelling (Node's), never the module's. */
function base64Url(bytes: Buffer | string): string {
  return Buffer.from(bytes).toString("base64url");
}

test("a cursor round-trips through its encoding", () => {
  assert.deepEqual(decodeHistoryCursor(encodeHistoryCursor(cursor), THREAD), cursor);
});

test("the encoding is base64url of JSON {t, a, i}, unpadded", () => {
  const encoded = encodeHistoryCursor(cursor);
  assert.match(encoded, /^[A-Za-z0-9_-]+$/, "safe in a query string as-is");
  assert.deepEqual(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")), {
    t: THREAD,
    a: "2026-09-23T10:11:12.345Z",
    i: "turn_01J8Z3"
  });
});

test("non-ASCII ids survive the round trip (UTF-8, not Latin-1)", () => {
  const unicode: HistoryCursor = {
    threadId: "thread-ñ-🙂",
    beforeAnchorAt: "2026-09-23T00:00:00.000Z",
    beforeTurnId: "turn/ü?&=+"
  };
  const encoded = encodeHistoryCursor(unicode);
  assert.match(encoded, /^[A-Za-z0-9_-]+$/);
  assert.deepEqual(decodeHistoryCursor(encoded, "thread-ñ-🙂"), unicode);
});

test("a cursor minted for another thread decodes to null", () => {
  assert.equal(decodeHistoryCursor(encodeHistoryCursor(cursor), "another-thread"), null);
});

test("anything malformed decodes to null and never throws", () => {
  const malformed: unknown[] = [
    "",
    "!!!",
    "a",
    "abcde",
    "%7B%7D",
    "e30=",
    base64Url("not json"),
    base64Url("[]"),
    base64Url("null"),
    base64Url("42"),
    base64Url('"text"'),
    base64Url(JSON.stringify({ t: THREAD, a: "2026-09-23T00:00:00.000Z" })),
    base64Url(JSON.stringify({ t: THREAD, i: "turn" })),
    base64Url(JSON.stringify({ a: "2026-09-23T00:00:00.000Z", i: "turn" })),
    base64Url(JSON.stringify({ t: THREAD, a: 42, i: "turn" })),
    base64Url(JSON.stringify({ t: THREAD, a: "2026-09-23T00:00:00.000Z", i: null })),
    base64Url(JSON.stringify({ t: THREAD, a: "", i: "turn" })),
    base64Url(JSON.stringify({ t: THREAD, a: "2026-09-23T00:00:00.000Z", i: "" })),
    // Invalid UTF-8 inside otherwise valid base64url.
    base64Url(Buffer.from([0x7b, 0xff, 0xfe, 0x7d])),
    // Not a string at all (a repeated query parameter arrives as an array).
    ["a", "b"],
    null,
    undefined,
    42
  ];
  for (const value of malformed) {
    assert.equal(
      decodeHistoryCursor(value as string, THREAD),
      null,
      `expected null for ${JSON.stringify(value)}`
    );
  }
});

test("standard base64 (with + / and padding) is not base64url", () => {
  // `?` and `>` encode to `/` and `+` in standard base64.
  const standard = Buffer.from(
    JSON.stringify({ t: THREAD, a: "2026-09-23T00:00:00.000Z", i: "??>>" })
  ).toString("base64");
  assert.match(standard, /[+/=]/, "the fixture really uses the standard alphabet");
  assert.equal(decodeHistoryCursor(standard, THREAD), null);
});

test("fields beyond {t, a, i} are ignored, so a later field cannot break an old host", () => {
  const extended = base64Url(
    JSON.stringify({ t: THREAD, a: cursor.beforeAnchorAt, i: cursor.beforeTurnId, v: 2 })
  );
  assert.deepEqual(decodeHistoryCursor(extended, THREAD), cursor);
});

test("a cursor may carry a sequence bound inside its turn, and a bad one is rejected", () => {
  const cursor = { threadId: "t1", beforeAnchorAt: "2026-09-23T00:00:00.000Z", beforeTurnId: "turn-9", beforeSeq: 4210 };
  const decoded = decodeHistoryCursor(encodeHistoryCursor(cursor), "t1");
  assert.deepEqual(decoded, cursor);
  const plain = { threadId: "t1", beforeAnchorAt: "2026-09-23T00:00:00.000Z", beforeTurnId: "turn-9" };
  assert.deepEqual(decodeHistoryCursor(encodeHistoryCursor(plain), "t1"), plain, "no bound → no key");
  const bad = Buffer.from(JSON.stringify({ t: "t1", a: "x", i: "y", s: -1 })).toString("base64url");
  assert.equal(decodeHistoryCursor(bad, "t1"), null);
  const frac = Buffer.from(JSON.stringify({ t: "t1", a: "x", i: "y", s: 1.5 })).toString("base64url");
  assert.equal(decodeHistoryCursor(frac, "t1"), null);
});
