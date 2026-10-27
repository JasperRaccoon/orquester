/**
 * The session store (`auth/sessions.ts`): minting, constant-time verify, sliding expiry, throttled
 * `lastUsedAt` writes, revocation, the password binding and the tolerant file.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";

import { AuthSessionStore, AuthSessionsUnavailableError, StalePasswordError, deviceLabelFromUserAgent } from "./sessions.ts";

const quiet = { warn: () => undefined, error: () => undefined };

async function tempFile(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "orquester-auth-sessions-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return join(dir, "auth-sessions.json");
}

function clock(start = Date.parse("2026-10-22T10:00:00.000Z")): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

async function readJson(file: string): Promise<Record<string, unknown> & { sessions: Record<string, unknown>[] }> {
  return JSON.parse(await readFile(file, "utf8"));
}

test("a minted token verifies; the file holds only its digest, at 0600", async (t) => {
  const file = await tempFile(t);
  const store = new AuthSessionStore({ file, logger: quiet });
  await store.load();
  const { token, session } = await store.create("device", "Chrome on macOS");
  assert.match(token, /^orq_[A-Za-z0-9_-]{43}$/);
  assert.equal(session.kind, "device");
  assert.equal(session.current, true);
  assert.deepEqual(store.verify(token), { id: session.id, kind: "device" });

  const text = await readFile(file, "utf8");
  assert.ok(!text.includes(token), "the token never reaches the disk");
  assert.ok(!text.includes(token.slice(4)), "nor its random part");
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  const [record] = (await readJson(file)).sessions;
  assert.match(String(record?.tokenDigest), /^[0-9a-f]{64}$/);
});

test("verify refuses anything but a live token", async () => {
  const store = new AuthSessionStore();
  const { token } = await store.create("device", "x");
  assert.equal(store.verify(undefined), null);
  assert.equal(store.verify(""), null);
  assert.equal(store.verify(`${token}x`), null);
  assert.equal(store.verify(`orq_${"A".repeat(43)}`), null, "the right shape is not enough");
  // The old wire credential base64("<user>:<bcrypt hash>").
  assert.equal(store.verify(Buffer.from("admin:$2a$12$0123456789012345678901uFAKEfakeFAKEfakeFAKEfa").toString("base64")), null);
});

test("device sessions lapse after 30 idle days; each use slides the expiry; API tokens never lapse", async () => {
  const idleWindow = 30 * 24 * 60 * 60 * 1000;
  const c = clock();
  const store = new AuthSessionStore({ now: c.now });
  const device = await store.create("device", "phone");
  const api = await store.create("api", "ci");
  assert.equal(api.session.expiresAt, null);

  c.advance(idleWindow - 1000);
  assert.ok(store.verify(device.token), "still live just before the idle window ends");
  c.advance(idleWindow - 1000);
  assert.ok(store.verify(device.token), "the use above slid the expiry");
  c.advance(idleWindow + 1);
  assert.equal(store.verify(device.token), null, "lapsed after a full idle window");
  assert.ok(store.verify(api.token), "an API token lasts until revoked");
  assert.deepEqual(store.list(null).map((s) => s.kind), ["api"], "a lapsed session is no longer listed");
});

test("a peek (touch=false) neither stamps the use nor slides the expiry", async () => {
  const c = clock();
  const store = new AuthSessionStore({ now: c.now });
  const { token, session } = await store.create("device", "x");
  c.advance(60_000);
  assert.ok(store.verify(token, false));
  assert.equal(store.list(null)[0]?.lastUsedAt, session.lastUsedAt);
  c.advance(30 * 24 * 60 * 60 * 1000 - 60_000);
  assert.equal(store.verify(token, false), null, "a peek did not extend the original expiry");
});

test("lastUsedAt reaches the disk at most every few minutes per session", async (t) => {
  const c = clock();
  const file = await tempFile(t);
  const store = new AuthSessionStore({ file, now: c.now, logger: quiet });
  await store.load();
  const { token, session } = await store.create("device", "x");

  c.advance(60_000);
  store.verify(token);
  await store.flush();
  assert.equal((await readJson(file)).sessions[0]?.lastUsedAt, session.lastUsedAt, "a use a minute later stays in memory");
  assert.notEqual(store.list(null)[0]?.lastUsedAt, session.lastUsedAt);

  c.advance(10 * 60_000);
  store.verify(token);
  await store.flush();
  assert.equal((await readJson(file)).sessions[0]?.lastUsedAt, new Date(c.now()).toISOString());
});

test("revoke one, revoke all but the current, and listeners hear each revocation", async () => {
  const store = new AuthSessionStore();
  const heard: string[][] = [];
  store.onRevoked((ids) => heard.push(ids));
  const a = await store.create("device", "a");
  const b = await store.create("device", "b");
  const t = await store.create("api", "t");

  assert.equal(await store.revoke("missing"), false);
  assert.equal(await store.revoke(b.session.id), true);
  assert.equal(store.verify(b.token), null);
  assert.deepEqual(heard, [[b.session.id]]);

  const listed = store.list(a.session.id);
  assert.equal(listed[0]?.id, a.session.id, "the current session lists first");
  assert.equal(listed[0]?.current, true);
  assert.equal(listed.filter((s) => s.current).length, 1);

  assert.equal(await store.revokeAllExcept(a.session.id), 1);
  assert.equal(store.verify(t.token), null, "revoke-others includes API tokens");
  assert.ok(store.verify(a.token));
  assert.deepEqual(heard[1], [t.session.id]);
});

test("a password change revokes every device session, keeps API tokens, and is noticed across a restart", async (t) => {
  const file = await tempFile(t);
  const store = new AuthSessionStore({ file, logger: quiet });
  await store.load();
  assert.equal(await store.syncPassword("$2a$12$old"), 0, "the first hash is only recorded");
  const device = await store.create("device", "phone");
  const api = await store.create("api", "mcp");
  assert.equal(await store.syncPassword("$2a$12$old"), 0, "the same hash changes nothing");
  assert.ok(!(await readFile(file, "utf8")).includes("$2a$12$old"), "the file holds a fingerprint, not the hash");

  // The daemon restarts with a hash rotated on disk (deploy.sh rotate-password).
  const rebooted = new AuthSessionStore({ file, logger: quiet });
  await rebooted.load();
  assert.ok(rebooted.verify(device.token, false), "loaded from the file");
  assert.equal(await rebooted.syncPassword("$2a$12$new"), 1);
  assert.equal(rebooted.verify(device.token), null);
  assert.ok(rebooted.verify(api.token), "API tokens survive a password change");

  const again = new AuthSessionStore({ file, logger: quiet });
  await again.load();
  assert.equal(again.verify(device.token), null, "the revocation is durable");
  assert.equal(await again.syncPassword("$2a$12$new"), 0);
});

test("the file keeps unknown fields and records it cannot read, and never honours the latter", async (t) => {
  const file = await tempFile(t);
  const seed = new AuthSessionStore({ file, logger: quiet });
  await seed.load();
  const live = await seed.create("device", "live");
  const raw = await readJson(file);
  raw.futureTopLevel = { keep: true };
  raw.sessions[0]!.futureField = 42;
  // A newer build's kind: kept, never accepted (its digest is the live token's own).
  raw.sessions.push({ ...raw.sessions[0], id: "other", kind: "pairing" });
  (raw.sessions as unknown[]).push("not a record");
  await writeFile(file, JSON.stringify(raw));

  const store = new AuthSessionStore({ file, logger: quiet });
  await store.load();
  assert.deepEqual(store.verify(live.token, false), { id: live.session.id, kind: "device" });
  assert.deepEqual(store.list(null).map((s) => s.id), [live.session.id]);
  await store.create("api", "new");

  const written = await readJson(file);
  assert.deepEqual(written.futureTopLevel, { keep: true });
  assert.equal(written.sessions[0]?.futureField, 42);
  assert.ok(written.sessions.some((s) => typeof s === "object" && s.kind === "pairing"));
  assert.ok((written.sessions as unknown[]).includes("not a record"));
  assert.equal(written.sessions.length, 4);
});

test("a corrupt file is moved aside and nobody is signed in; an unreadable one refuses sign-in", async (t) => {
  const file = await tempFile(t);
  await writeFile(file, "{ not json");
  const store = new AuthSessionStore({ file, logger: quiet });
  await store.load();
  assert.deepEqual(store.list(null), []);
  const names = await readdir(join(file, ".."));
  assert.ok(names.some((name) => name.startsWith("auth-sessions.json.corrupt-")));

  const dir = dirname(await tempFile(t));
  // A directory where the file should be: readFile fails with EISDIR.
  const blocked = new AuthSessionStore({ file: dir, logger: quiet });
  await blocked.load();
  await assert.rejects(blocked.create("device", "x"), AuthSessionsUnavailableError);
});

test("device labels come from the user agent", () => {
  for (const [ua, parts] of [
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1", ["Safari", "iPhone"]],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) orquester/0.0.0 Chrome/138.0 Electron/37.0 Safari/537.36", ["Orquester", "macOS"]],
    ["Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0", ["Firefox", "Linux"]]
  ] as const) {
    const label = deviceLabelFromUserAgent(ua);
    for (const part of parts) assert.ok(label.includes(part), label);
  }
});

test("a login bound to a hash the sessions are no longer bound to mints nothing", async () => {
  const store = new AuthSessionStore();
  assert.ok(await store.create("device", "unbound store", "$2a$12$any"), "nothing recorded yet: nothing to compare");
  await store.syncPassword("$2a$12$old");
  assert.ok(await store.create("device", "same hash", "$2a$12$old"));
  await store.syncPassword("$2a$12$new");
  await assert.rejects(store.create("device", "checked the old hash", "$2a$12$old"), StalePasswordError);
  assert.deepEqual(store.list(null), [], "the old-hash sessions were revoked and nothing new was minted");
});
