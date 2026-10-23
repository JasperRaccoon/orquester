import assert from "node:assert/strict";
import { test } from "node:test";

import { compactsBeforeSend, resumeCompactionOffer, resumeCompactionWakeAt, sendAfterCompaction, type ResumeCompactionInput } from "./resume-compaction.logic";

const EXPIRES = "2026-10-22T11:00:00.000Z";
const EXPIRES_MS = Date.parse(EXPIRES);

function input(over: Partial<ResumeCompactionInput> = {}): ResumeCompactionInput {
  return {
    adapter: "claude",
    mode: "onReturn",
    usedTokens: 250_000,
    promptCacheExpiresAt: EXPIRES,
    busy: false,
    nowMs: EXPIRES_MS,
    ...over
  };
}

test("a large Claude chat whose cache expired offers to compact, with its size", () => {
  assert.equal(resumeCompactionOffer(input()), 250_000);
  assert.equal(resumeCompactionOffer(input({ mode: "beforeCacheExpires", nowMs: EXPIRES_MS + 3_600_000 })), 250_000);
  assert.equal(resumeCompactionOffer(input({ usedTokens: 200_000 })), 200_000);
});

test("no offer while the cache is warm, its expiry unknown, the chat small or busy, another agent, or Never", () => {
  assert.equal(resumeCompactionOffer(input({ nowMs: EXPIRES_MS - 1 })), null);
  assert.equal(resumeCompactionOffer(input({ promptCacheExpiresAt: undefined })), null);
  assert.equal(resumeCompactionOffer(input({ promptCacheExpiresAt: "soon" })), null);
  assert.equal(resumeCompactionOffer(input({ usedTokens: 199_999 })), null);
  assert.equal(resumeCompactionOffer(input({ usedTokens: null })), null);
  assert.equal(resumeCompactionOffer(input({ busy: true })), null);
  assert.equal(resumeCompactionOffer(input({ adapter: "codex" })), null);
  assert.equal(resumeCompactionOffer(input({ mode: "off" })), null);
});

test("the offer's own wake is the expiry, only while it is ahead", () => {
  assert.equal(resumeCompactionWakeAt(EXPIRES, EXPIRES_MS - 10), EXPIRES_MS);
  assert.equal(resumeCompactionWakeAt(EXPIRES, EXPIRES_MS), null);
  assert.equal(resumeCompactionWakeAt(undefined, 0), null);
});

test("a send under the offer compacts first, and a refused compaction still sends", async () => {
  const calls: string[] = [];
  await sendAfterCompaction(true, async () => void calls.push("compact"), async () => void calls.push("send"));
  assert.deepEqual(calls, ["compact", "send"]);
  calls.length = 0;
  await sendAfterCompaction(
    true,
    async () => {
      calls.push("compact");
      throw new Error("Context compaction is unavailable while a provider turn is running.");
    },
    async () => void calls.push("send")
  );
  assert.deepEqual(calls, ["compact", "send"]);
  calls.length = 0;
  await sendAfterCompaction(false, async () => void calls.push("compact"), async () => void calls.push("send"));
  assert.deepEqual(calls, ["send"]);
  // A failed send is the caller's to handle.
  await assert.rejects(sendAfterCompaction(false, async () => undefined, async () => Promise.reject(new Error("refused"))));
});

test("a typed /compact, bare or instructed, never gets a bare compaction first", () => {
  const offered = { offered: true, keepFullHistory: false };
  for (const text of ["hello", "/compactfoo", "/review the diff"]) {
    assert.equal(compactsBeforeSend({ ...offered, text }), true, text);
  }
  for (const text of ["/compact", "/COMPACT", "  /compact keep the API notes", "/compact\n  tests"]) {
    assert.equal(compactsBeforeSend({ ...offered, text }), false, JSON.stringify(text));
  }
  assert.equal(compactsBeforeSend({ offered: true, keepFullHistory: true, text: "hello" }), false, "Full");
  assert.equal(compactsBeforeSend({ offered: false, keepFullHistory: false, text: "hello" }), false, "no offer");
});
