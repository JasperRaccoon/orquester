/**
 * The thread-scoped session-tool credentials (design 2026-10-14 §1.2):
 * issue, verify, revoke on end and on relaunch, hash-only storage.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { bearerToken, SessionToolCredentials, type SessionToolGrantScope } from "./credentials.ts";

test("an issued credential is ≥32 random bytes, base64url, and verifies to its own thread", () => {
  const credentials = new SessionToolCredentials();
  const a = credentials.issue("thread-a");
  const b = credentials.issue("thread-b");
  assert.match(a.token, /^[A-Za-z0-9_-]{43,}$/);
  assert.notEqual(a.token, b.token);
  assert.deepEqual(credentials.verify(a.token), { threadId: "thread-a", grantId: a.grantId });
  assert.deepEqual(credentials.verify(b.token), { threadId: "thread-b", grantId: b.grantId });
  // A's credential can never name B: the scope comes from the credential alone.
  assert.equal(credentials.verify(a.token)?.threadId, "thread-a");
});

test("unknown, empty, oversized and missing credentials do not verify", () => {
  const credentials = new SessionToolCredentials();
  credentials.issue("thread-a");
  for (const token of [undefined, "", "nope", "x".repeat(600)]) {
    assert.equal(credentials.verify(token), null);
  }
});

test("only the SHA-256 is kept: the raw value appears nowhere in the registry", () => {
  const credentials = new SessionToolCredentials();
  const { token } = credentials.issue("thread-a");
  const dump = JSON.stringify([...(credentials as unknown as { byHash: Map<string, unknown> }).byHash]);
  assert.ok(!dump.includes(token));
});

test("a relaunch revokes the thread's previous credential; other threads keep theirs", () => {
  const credentials = new SessionToolCredentials();
  const first = credentials.issue("thread-a");
  const other = credentials.issue("thread-b");
  const second = credentials.issue("thread-a");
  assert.equal(credentials.verify(first.token), null);
  assert.equal(credentials.verify(second.token)?.threadId, "thread-a");
  assert.equal(credentials.verify(other.token)?.threadId, "thread-b");
  assert.equal(credentials.size, 2);
});

test("revoking a grant (its session ended) ends it, idempotently, and tells the listeners", () => {
  const credentials = new SessionToolCredentials();
  const revoked: SessionToolGrantScope[] = [];
  credentials.onRevoke((scope) => revoked.push(scope));
  const a = credentials.issue("thread-a");
  credentials.revokeGrant(a.grantId);
  credentials.revokeGrant(a.grantId);
  assert.equal(credentials.verify(a.token), null);
  assert.deepEqual(revoked, [{ threadId: "thread-a", grantId: a.grantId }]);
  const b = credentials.issue("thread-b");
  credentials.revokeAll();
  assert.equal(credentials.verify(b.token), null);
  assert.equal(credentials.size, 0);
});

test("bearerToken reads only a well-formed Bearer header", () => {
  assert.equal(bearerToken("Bearer abc"), "abc");
  assert.equal(bearerToken("bearer abc"), "abc");
  assert.equal(bearerToken(["Bearer abc"]), "abc");
  assert.equal(bearerToken("Basic abc"), undefined);
  assert.equal(bearerToken("Bearer a b"), undefined);
  assert.equal(bearerToken(undefined), undefined);
});
