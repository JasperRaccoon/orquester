/**
 * `auth-second-factor.json`: tolerant read and rewrite — unknown keys and fields survive, recovery
 * codes this build cannot read are kept and never accepted, and anything that is not a readable
 * version-1 file throws (the daemon then fails closed).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { authSecondFactorPath, parseAuthSecondFactorFile, serializeAuthSecondFactorFile } from "./index.ts";

const totp = { secret: "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP", enabledAt: "2026-11-22T10:00:00.000Z", lastUsedStep: 59000000 };

test("lives beside daemon.json", () => {
  assert.equal(authSecondFactorPath("/appdir"), "/appdir/daemon/auth-second-factor.json");
});

test("unknown top-level keys and record fields survive a rewrite", () => {
  const raw = {
    futureKey: { nested: [1, 2] },
    version: 1,
    totp: { ...totp, algorithm: "SHA1-future" },
    recoveryCodes: [{ digest: "a".repeat(64), label: "kept" }, { digest: "b".repeat(64) }],
    lastFailedChallenge: { at: "2026-11-22T11:00:00.000Z", ip: "203.0.113.1", country: "kept" }
  };
  const parsed = parseAuthSecondFactorFile(raw);
  assert.equal(parsed.totp?.secret, totp.secret);
  assert.equal(parsed.recoveryCodes.length, 2);
  assert.deepEqual(JSON.parse(serializeAuthSecondFactorFile(parsed)), raw);
});

test("recovery codes this build cannot read are kept verbatim and never accepted", () => {
  const parsed = parseAuthSecondFactorFile({ version: 1, totp, recoveryCodes: [{ digest: "a".repeat(64) }, { digest: "nope" }, { digest: "a".repeat(64) }, 7] });
  assert.deepEqual(parsed.recoveryCodes.map((code) => code.digest), ["a".repeat(64)]);
  assert.deepEqual(parsed.unreadableRecoveryCodes, [{ digest: "nope" }, { digest: "a".repeat(64) }, 7]);
  assert.equal(JSON.parse(serializeAuthSecondFactorFile(parsed)).recoveryCodes.length, 4);
});

test("anything but a readable version-1 file throws, so the factor never silently turns off", () => {
  assert.throws(() => parseAuthSecondFactorFile(null));
  assert.throws(() => parseAuthSecondFactorFile([]));
  assert.throws(() => parseAuthSecondFactorFile({}), "no version");
  assert.throws(() => parseAuthSecondFactorFile({ version: 2, recoveryCodes: [] }));
  assert.throws(() => parseAuthSecondFactorFile({ version: 1, totp: { secret: "not base32!" }, recoveryCodes: [] }));
  assert.throws(() => parseAuthSecondFactorFile({ version: 1, totp, recoveryCodes: {} }));
  assert.equal(parseAuthSecondFactorFile({ version: 1, recoveryCodes: [] }).totp, undefined, "a file without totp is off");
});
