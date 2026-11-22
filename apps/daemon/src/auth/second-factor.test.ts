/**
 * The second-factor store (`auth/second-factor.ts`): enabling, codes used up exactly once (also
 * when checked concurrently and across a restart), recovery-code input forms, the tolerant file,
 * and failing closed on a file it cannot use.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { SecondFactorStore, SecondFactorUnavailableError } from "./second-factor.ts";
import { authenticatorCode } from "./testing.ts";
import { generateTotpSecret } from "./totp.ts";

const quiet = { warn: () => undefined, error: () => undefined };

async function tempFile(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "orquester-second-factor-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return join(dir, "auth-second-factor.json");
}

function clock(start = Date.parse("2026-11-22T10:00:00.000Z")): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

async function enabled(t: TestContext) {
  const file = await tempFile(t);
  const time = clock();
  const store = new SecondFactorStore({ file, now: time.now, logger: quiet });
  await store.load();
  const secret = generateTotpSecret();
  const codes = await store.enable(secret, authenticatorCode(secret, time.now()));
  assert.ok(Array.isArray(codes));
  return { file, time, store, secret, codes };
}

test("no file is off; enabling persists the secret and only digests of the recovery codes, at 0600", async (t) => {
  const { file, time, store, secret, codes } = await enabled(t);
  assert.equal(codes.length, 10);
  for (const code of codes) assert.match(code, /^[0-9a-hjkmnp-tv-z]{5}-[0-9a-hjkmnp-tv-z]{5}$/);
  assert.equal(new Set(codes).size, 10);
  assert.deepEqual(store.status(), { enabled: true, enabledAt: new Date(time.now()).toISOString(), recoveryCodesRemaining: 10, unavailable: false, lastFailedChallenge: null });
  assert.equal(await store.enable(secret, authenticatorCode(secret, time.now())), "enabled");

  const text = await readFile(file, "utf8");
  for (const code of codes) assert.ok(!text.includes(code) && !text.includes(code.replace("-", "")), "no recovery code on disk");
  assert.equal((await stat(file)).mode & 0o777, 0o600);

  const reloaded = new SecondFactorStore({ file, now: time.now, logger: quiet });
  await reloaded.load();
  assert.equal(reloaded.status().recoveryCodesRemaining, 10);
  const off = new SecondFactorStore({ file: join(file, "..", "missing.json"), logger: quiet });
  await off.load();
  assert.equal(off.isEnabled(), false);
});

test("enabling needs a current code for the pending secret", async (t) => {
  const time = clock();
  const store = new SecondFactorStore({ file: await tempFile(t), now: time.now, logger: quiet });
  await store.load();
  const secret = generateTotpSecret();
  assert.equal(await store.enable(secret, authenticatorCode(secret, time.now() - 120_000)), "invalid-code");
  assert.equal(await store.enable(secret, "not a code"), "invalid-code");
  assert.equal(store.isEnabled(), false);
});

test("an authenticator code works once, its step stays used across a restart, and the enrolling code is used", async (t) => {
  const { file, time, store, secret } = await enabled(t);
  assert.equal(await store.verify(authenticatorCode(secret, time.now())), false, "the code that enabled it");
  time.advance(30_000);
  const code = authenticatorCode(secret, time.now());
  assert.equal(await store.verify(` ${code.slice(0, 3)} ${code.slice(3)} `), true, "spaces are ignored");
  assert.equal(await store.verify(code), false, "replayed");

  const reloaded = new SecondFactorStore({ file, now: time.now, logger: quiet });
  await reloaded.load();
  assert.equal(await reloaded.verify(code), false, "replayed after a restart");
  time.advance(30_000);
  assert.equal(await reloaded.verify(authenticatorCode(secret, time.now())), true);
});

test("a recovery code works once in any typed form; regenerating replaces all of them", async (t) => {
  const { file, store, codes } = await enabled(t);
  const [first, second] = codes;
  const typed = first!.toUpperCase().replace("-", " ").replace(/0/g, "O").replace(/1/g, "l");
  assert.equal(await store.verify(typed), true);
  assert.equal(await store.verify(first!), false, "used up");
  assert.equal(store.status().recoveryCodesRemaining, 9);

  const fresh = await store.regenerateRecoveryCodes();
  assert.equal(fresh?.length, 10);
  assert.equal(await store.verify(second!), false, "the old codes stop working");
  assert.equal(await store.verify(fresh![0]!), true);
  const reloaded = new SecondFactorStore({ file, logger: quiet });
  await reloaded.load();
  assert.equal(reloaded.status().recoveryCodesRemaining, 9);
  assert.equal(await reloaded.verify(fresh![0]!), false, "used up across a restart");
});

test("the same code checked concurrently succeeds exactly once", async (t) => {
  const { time, store, secret, codes } = await enabled(t);
  time.advance(30_000);
  const code = authenticatorCode(secret, time.now());
  const totp = await Promise.all(Array.from({ length: 5 }, () => store.verify(code)));
  assert.equal(totp.filter(Boolean).length, 1);
  const recovery = await Promise.all(Array.from({ length: 5 }, () => store.verify(codes[3]!)));
  assert.equal(recovery.filter(Boolean).length, 1);
});

test("unknown fields survive changes; disabling drops the secret and codes", async (t) => {
  const { file, store } = await enabled(t);
  const onDisk = JSON.parse(await readFile(file, "utf8"));
  await writeFile(file, JSON.stringify({ ...onDisk, futureKey: [1], totp: { ...onDisk.totp, futureField: "kept" } }));
  const reloaded = new SecondFactorStore({ file, logger: quiet });
  await reloaded.load();
  await reloaded.recordFailedChallenge("203.0.113.9");
  assert.equal(reloaded.status().lastFailedChallenge?.ip, "203.0.113.9");
  let written = JSON.parse(await readFile(file, "utf8"));
  assert.deepEqual(written.futureKey, [1]);
  assert.equal(written.totp.futureField, "kept");

  await reloaded.dismissAlert();
  assert.equal(reloaded.status().lastFailedChallenge, null);
  assert.equal(await reloaded.disable(), true);
  assert.equal(await reloaded.disable(), false);
  written = JSON.parse(await readFile(file, "utf8"));
  assert.equal(written.totp, undefined);
  assert.deepEqual(written.recoveryCodes, []);
  assert.deepEqual(written.futureKey, [1]);
  assert.equal(reloaded.isEnabled(), false);
});

test("a file it cannot parse counts as on, refuses every check and change, and is never rewritten", async (t) => {
  const file = await tempFile(t);
  const garbage = '{"version":1,"totp":{"secret":"truncated';
  await writeFile(file, garbage);
  const store = new SecondFactorStore({ file, logger: quiet });
  await store.load();
  assert.equal(store.isEnabled(), true);
  assert.equal(store.status().unavailable, true);
  const secret = generateTotpSecret();
  for (const attempt of [
    () => store.verify("123456"),
    () => store.enable(secret, authenticatorCode(secret, Date.now())),
    () => store.regenerateRecoveryCodes(),
    () => store.disable(),
    () => store.recordFailedChallenge("203.0.113.1"),
    () => store.dismissAlert()
  ]) {
    await assert.rejects(attempt(), SecondFactorUnavailableError);
  }
  await store.flush();
  assert.equal(await readFile(file, "utf8"), garbage);
});
