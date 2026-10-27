import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { boxesStorePath } from "@orquester/config";

import { hashSecret } from "../hub/auth.ts";
import { byoAdapter } from "../providers/byo.ts";
import { localBoxConnection } from "../testing.ts";
import { BoxError } from "./errors.ts";
import { PAIRING_TTL_MS, PairingThrottle } from "./byo.ts";
import { testBoxService, testClock } from "./testing.ts";

async function tempDir(t: test.TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "orq-byo-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** A service with only the `byo` provider and a clock the test moves. */
async function setup(t: test.TestContext, options: { enabled?: boolean } = {}) {
  const base = await tempDir(t);
  let now = Date.parse("2026-10-27T10:00:00.000Z");
  const harness = testBoxService({
    baseDir: base,
    adapters: [byoAdapter],
    ...(options.enabled !== undefined ? { enabled: options.enabled } : {}),
    overrides: { clock: testClock(() => now) }
  });
  t.after(() => harness.service.stop());
  await harness.service.start();
  return { ...harness, base, advance: (ms: number) => void (now += ms) };
}

const codeOf = (command: string): string => /\/api\/boxes\/pair\/([A-Za-z0-9_-]+) \| sh$/.exec(command)![1]!;

/** Resolves once the record satisfies `predicate` (checked on every change). */
function until(service: Awaited<ReturnType<typeof setup>>["service"], boxId: string, predicate: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    if (predicate()) return resolve();
    const off = service.registry.onChange((id) => {
      if (id === boxId && predicate()) {
        off();
        resolve();
      }
    });
  });
}

test("Add your machine: a pairing record and a one-time command; only the code's hash is stored", async (t) => {
  const { service, base } = await setup(t);
  const pairing = await service.byo.add({ kind: "macos", name: "  Mac   mini " });
  assert.match(pairing.command, /^curl -fsSL https:\/\/orq\.example\.test\/api\/boxes\/pair\/[A-Za-z0-9_-]{24} \| sh$/);
  assert.equal(pairing.box.state, "pairing");
  assert.equal(pairing.box.purpose, "machine");
  assert.equal(pairing.box.provider, "byo");
  assert.equal(pairing.box.hourlyUsd, 0);
  assert.equal(pairing.box.deadlineAt, null);
  assert.deepEqual(pairing.box.setup, []);
  assert.equal(pairing.box.deviceHost, false);
  assert.deepEqual(pairing.box.byo, { name: "Mac mini", pairingExpiresAt: pairing.expiresAt });
  assert.equal(Date.parse(pairing.expiresAt) - Date.parse("2026-10-27T10:00:00.000Z"), PAIRING_TTL_MS);

  const code = codeOf(pairing.command);
  const onDisk = await readFile(boxesStorePath(base), "utf8");
  assert.ok(!onDisk.includes(code), "the code itself is never stored");
  assert.equal(JSON.parse(onDisk).boxes[pairing.box.id].pairingCodeHash, hashSecret(code));
  // An idle machine is not a running box.
  assert.equal(service.boxesResponse().totals.activeCount, 0);

  await assert.rejects(service.byo.add({ kind: "windows" as never, name: "x" }), (error: BoxError) => error.code === "BOX_INVALID_REQUEST");
  await assert.rejects(service.byo.add({ kind: "linux", name: " " }), (error: BoxError) => error.code === "BOX_INVALID_REQUEST");
});

test("the pairing code is spent by the first fetch and its script carries the box's bootstrap token", async (t) => {
  const { service, hub } = await setup(t);
  const pairing = await service.byo.add({ kind: "linux", name: "Build server" });
  const code = codeOf(pairing.command);

  const first = await service.byo.pairingScript(code, "203.0.113.5");
  assert.ok(first.ok);
  if (!first.ok) return;
  const token = hub.tokens.get(pairing.box.id)!;
  assert.ok(first.script.includes(`T='${token}'`), "the token is written to the 0600 token file");
  assert.ok(first.script.includes(`ORQ_BOX_ID='${pairing.box.id}'`));
  assert.ok(first.script.includes('"$T" install-service'));
  assert.ok(first.script.includes('[ "$OS" = linux ]'), "the script checks it runs on the kind it was made for");
  const record = service.registry.get(pairing.box.id)!;
  assert.equal(record.pairingCodeHash, undefined);
  assert.equal(service.registry.summary(pairing.box.id)?.byo?.pairingExpiresAt, null);

  const again = await service.byo.pairingScript(code, "203.0.113.5");
  assert.deepEqual(again.ok ? null : again.status, 404, "single use");
});

test("an expired, unknown or malformed code answers the same 404; failures are throttled per client", async (t) => {
  const { service, advance } = await setup(t);
  const pairing = await service.byo.add({ kind: "linux", name: "Box" });
  advance(PAIRING_TTL_MS + 1);
  const expired = await service.byo.pairingScript(codeOf(pairing.command), "198.51.100.1");
  assert.ok(!expired.ok && expired.status === 404);
  assert.equal(service.registry.get(pairing.box.id)?.pairingCodeHash, undefined, "an expired code is dropped");

  const fresh = await service.byo.newPairing(pairing.box.id);
  for (let i = 0; i < PairingThrottle.MAX_FAILURES; i++) {
    const wrong = await service.byo.pairingScript(i % 2 === 0 ? "A".repeat(24) : "../../etc", "192.0.2.9");
    assert.ok(!wrong.ok && wrong.status === 404);
  }
  const throttled = await service.byo.pairingScript(codeOf(fresh.command), "192.0.2.9");
  assert.ok(!throttled.ok && throttled.status === 429 && (throttled.retryAfterSeconds ?? 0) > 0);
  // Another client is not affected, and the code was not spent by the refused attempt.
  const other = await service.byo.pairingScript(codeOf(fresh.command), "192.0.2.10");
  assert.ok(other.ok);
});

test("with the plugin off a valid code is refused (404) and stays unspent", async (t) => {
  const { service, setEnabled } = await setup(t);
  const pairing = await service.byo.add({ kind: "linux", name: "Box" });
  setEnabled(false);
  const refused = await service.byo.pairingScript(codeOf(pairing.command), "192.0.2.1");
  assert.ok(!refused.ok && refused.status === 404);
  assert.ok(service.registry.get(pairing.box.id)?.pairingCodeHash);
});

test("first connect pairs the machine; it is offline while away and ready when back, never destroyed", async (t) => {
  const { service, hub } = await setup(t);
  const pairing = await service.byo.add({ kind: "linux", name: "Box" });
  const id = pairing.box.id;
  hub.connect(id, localBoxConnection({ boxId: id, sys: { kvm: true } }));
  await until(service, id, () => service.registry.get(id)?.state === "ready");
  const ready = service.registry.summary(id)!;
  assert.equal(ready.purpose, "machine");
  assert.equal(ready.os, "linux");
  assert.equal(ready.kvm, true);
  assert.ok(ready.readyAt);

  hub.disconnect(id);
  await until(service, id, () => service.registry.get(id)?.state === "offline");
  await service.reconcileNow();
  assert.equal(service.registry.get(id)?.state, "offline", "the reconciler leaves an away machine alone");
  assert.deepEqual(hub.revoked, []);

  hub.connect(id, localBoxConnection({ boxId: id }));
  await until(service, id, () => service.registry.get(id)?.state === "ready");
  await assert.rejects(service.destroyBox(id, "deleted"), (error: BoxError) => error.status === 409, "an idle machine is removed, not destroyed");
});

test("a chat borrows an idle machine (provider byo) and destroying it gives it back", async (t) => {
  const { service, hub } = await setup(t);
  const pairing = await service.byo.add({ kind: "linux", name: "Box" });
  const id = pairing.box.id;
  const connection = localBoxConnection({ boxId: id });
  hub.connect(id, connection);
  await until(service, id, () => service.registry.get(id)?.state === "ready");

  const lent = await service.createTemporaryBox({ threadId: "chat-1", kind: "linux", provider: "byo", lifetimeMinutes: 30, purposeNote: "run the tests" });
  assert.equal(lent.id, id, "the machine itself, not a new box");
  assert.equal(lent.purpose, "temporary");
  assert.equal(lent.threadId, "chat-1");
  assert.ok(lent.deadlineAt);
  assert.deepEqual(lent.setup.map((step) => step.state), ["done", "done", "done"]);
  await assert.rejects(
    service.startTemporaryBox({ threadId: "chat-2", kind: "linux", provider: "byo", lifetimeMinutes: 30, purposeNote: "x" }),
    (error: BoxError) => error.code === "BOX_NOT_READY" && /None of your Linux machines is free/.test(error.message),
    "a lent machine is not free"
  );
  await assert.rejects(service.byo.remove(id), (error: BoxError) => error.code === "BOX_IN_USE");

  const back = await service.destroyBox(id, "agent");
  assert.equal(back.state, "ready");
  assert.equal(back.purpose, "machine");
  assert.equal(back.threadId, null);
  assert.equal(back.deadlineAt, null);
  assert.ok(connection.calls.some((call) => call.method === "proc.list"), "the chat's background jobs are looked for");
  assert.equal(service.registry.get(id)?.destroyedAt ?? null, null);
});

test("a machine used for device simulators is never lent to a chat or a project", async (t) => {
  const { service, hub } = await setup(t);
  const pairing = await service.byo.add({ kind: "linux", name: "Box" });
  const id = pairing.box.id;
  hub.connect(id, localBoxConnection({ boxId: id }));
  await until(service, id, () => service.registry.get(id)?.state === "ready");
  await service.byo.update(id, { deviceHost: true });
  await assert.rejects(service.createTemporaryBox({ threadId: "chat-1", kind: "linux", provider: "byo", lifetimeMinutes: 10, purposeNote: "x" }));
  await assert.rejects(service.byo.leaseProject(id, { workspace: "w", name: "p" } as never), (error: BoxError) => error.code === "BOX_IN_USE");
  await assert.rejects(service.byo.leaseTemporary(id, { threadId: "chat-1", purposeNote: "x", lifetimeMinutes: 10 }), (error: BoxError) => error.code === "BOX_IN_USE");
  assert.equal(service.registry.get(id)?.purpose, "machine");
});

test("a chat's lease past its time limit is released by the reconciler", async (t) => {
  const { service, hub, advance } = await setup(t);
  const pairing = await service.byo.add({ kind: "linux", name: "Box" });
  const id = pairing.box.id;
  hub.connect(id, localBoxConnection({ boxId: id }));
  await until(service, id, () => service.registry.get(id)?.state === "ready");
  await service.createTemporaryBox({ threadId: "chat-1", kind: "linux", provider: "byo", lifetimeMinutes: 10, purposeNote: "x" });
  advance(11 * 60_000);
  await service.reconcileNow();
  await service.settled();
  assert.equal(service.registry.get(id)?.purpose, "machine");
  assert.equal(service.registry.get(id)?.state, "ready");
});

test("device-simulator flag and rename persist on the record and show on the summary", async (t) => {
  const { service } = await setup(t);
  const pairing = await service.byo.add({ kind: "macos", name: "Mac" });
  const updated = await service.byo.update(pairing.box.id, { deviceHost: true, name: "Studio" });
  assert.equal(updated.deviceHost, true);
  assert.equal(updated.byo?.name, "Studio");
  assert.equal(service.registry.get(pairing.box.id)?.deviceHost, true);
  await assert.rejects(service.byo.update(pairing.box.id, { deviceHost: "yes" as never }), (error: BoxError) => error.status === 400);
});

test("Remove machine: a connected one uninstalls its service first; its credential is revoked and the record deleted", async (t) => {
  const { service, hub } = await setup(t);
  const pairing = await service.byo.add({ kind: "linux", name: "Box" });
  const id = pairing.box.id;
  const connection = localBoxConnection({ boxId: id });
  hub.connect(id, connection);
  await until(service, id, () => service.registry.get(id)?.state === "ready");

  assert.deepEqual(await service.byo.remove(id), { uninstalled: true });
  assert.deepEqual(
    connection.calls.find((call) => call.method === "agent.shutdown")?.params,
    { reason: "removed", uninstall: true }
  );
  assert.deepEqual(hub.revoked, [id]);
  assert.equal(service.registry.get(id), undefined);

  // A machine still pairing is just cancelled.
  const other = await service.byo.add({ kind: "linux", name: "Other" });
  assert.deepEqual(await service.byo.remove(other.box.id), { uninstalled: false });
  assert.equal(service.registry.get(other.box.id), undefined);
});
