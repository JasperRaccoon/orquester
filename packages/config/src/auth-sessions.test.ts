/**
 * `auth-sessions.json`: tolerant read and rewrite — unknown keys and fields survive, records this
 * build cannot read are kept and never honoured, and anything that is not a version-1 file throws.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { authSessionsPath, parseAuthSessionsFile, serializeAuthSessionsFile } from "./index.ts";

const DIGEST = "a".repeat(64);
const record = (over: Record<string, unknown> = {}) => ({
  id: "s1",
  label: "Chrome on macOS",
  kind: "device",
  tokenDigest: DIGEST,
  createdAt: "2026-10-22T10:00:00.000Z",
  lastUsedAt: "2026-10-22T10:00:00.000Z",
  expiresAt: "2026-11-21T10:00:00.000Z",
  ...over
});

test("lives beside daemon.json", () => {
  assert.equal(authSessionsPath("/appdir"), "/appdir/daemon/auth-sessions.json");
});

test("unknown top-level keys and record fields survive a rewrite", () => {
  const { expiresAt: _never, ...apiRecord } = record({ id: "api1", kind: "api", tokenDigest: "b".repeat(64) });
  const raw = {
    version: 1,
    passwordFingerprint: "f".repeat(64),
    futureKey: { nested: [1, 2] },
    sessions: [record({ futureField: "kept" }), apiRecord]
  };
  const parsed = parseAuthSessionsFile(raw);
  assert.equal(parsed.sessions.length, 2);
  assert.equal(parsed.passwordFingerprint, "f".repeat(64));
  const written = JSON.parse(serializeAuthSessionsFile(parsed));
  assert.deepEqual(written.futureKey, { nested: [1, 2] });
  assert.equal(written.sessions[0].futureField, "kept");
  assert.equal(written.sessions[1].expiresAt, undefined);
  assert.deepEqual(parseAuthSessionsFile(written), parsed, "a rewrite reads back the same");
});

test("records this build cannot read are kept verbatim and never honoured", () => {
  const unknownKind = record({ id: "p1", kind: "pairing", tokenDigest: "c".repeat(64) });
  const badDigest = record({ id: "s2", tokenDigest: "not-hex" });
  const duplicateDigest = record({ id: "s3" });
  const parsed = parseAuthSessionsFile({ version: 1, sessions: [record(), unknownKind, badDigest, duplicateDigest, 7] });
  assert.deepEqual(parsed.sessions.map((s) => s.id), ["s1"]);
  assert.deepEqual(parsed.unreadableSessions, [unknownKind, badDigest, duplicateDigest, 7]);
  const written = JSON.parse(serializeAuthSessionsFile(parsed));
  assert.equal(written.sessions.length, 5);
});

test("anything but a version-1 file throws", () => {
  assert.throws(() => parseAuthSessionsFile(null));
  assert.throws(() => parseAuthSessionsFile([]));
  assert.throws(() => parseAuthSessionsFile({ version: 2, sessions: [] }));
  assert.throws(() => parseAuthSessionsFile({ version: 1, sessions: {} }));
  assert.deepEqual(parseAuthSessionsFile({}).sessions, [], "an empty object is an empty file");
});
