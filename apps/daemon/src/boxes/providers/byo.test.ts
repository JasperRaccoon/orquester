// The bring-your-own adapter: nothing is rented, so no call goes anywhere; its offers are the
// owner's idle, connected machines (built from the records by the box settings).

import assert from "node:assert/strict";
import { test } from "node:test";

import type { StoredBox } from "@orquester/config";

import { BYO_REGION, byoAdapter, byoMachineIdle, byoMachineLabel, byoOffers } from "./byo.ts";

const options = { signal: AbortSignal.timeout(1_000), fetch: (() => assert.fail("no network call")) as unknown as typeof fetch };

function machine(id: string, extra: Partial<StoredBox> = {}): StoredBox {
  return {
    id,
    purpose: "machine",
    kind: "linux",
    provider: "byo",
    region: "own",
    size: "machine",
    name: `orq-1a2b3c4d-${id}`,
    machineName: `Machine ${id}`,
    createdAt: `2026-10-2${id.length}T00:00:00.000Z`,
    state: "ready",
    ...extra
  };
}

test("byo: free Linux and macOS machines, no credentials, no lifetime cap, never creates or lists anything", async () => {
  assert.equal(byoAdapter.id, "byo");
  assert.deepEqual([...byoAdapter.kinds], ["linux", "macos"]);
  assert.deepEqual(byoAdapter.credentialFields, []);
  assert.equal(byoAdapter.maxLifetimeMinutes, null);
  assert.deepEqual(await byoAdapter.validate({}, options), { ok: true });
  assert.deepEqual(await byoAdapter.listManaged({}, options), []);
  await assert.rejects(
    byoAdapter.create({}, { boxId: "x", name: "orq-x", kind: "linux", size: "s", region: "own", image: null, tags: {}, bootstrap: {} as never, sshPublicKey: "", windowsPassword: null, lifetimeMinutes: null }, options),
    /paired/
  );
  await byoAdapter.destroy({}, { id: "x" }, options);
  assert.deepEqual((await byoAdapter.offers({}, "linux", options)).regions, [BYO_REGION]);
});

test("byo offers: one free size per idle, connected machine of the kind; never a device host", () => {
  const records = [
    machine("a", { deviceHost: true }),
    machine("bb"),
    machine("ccc", { state: "offline" }),
    machine("dddd", { purpose: "temporary", threadId: "chat" }),
    machine("eeeee", { kind: "macos", os: "darwin", arch: "arm64" }),
    machine("ffffff", { state: "pairing" }),
    machine("ggggggg", { provider: "hetzner", purpose: "project" })
  ];
  const connected = () => true;
  const linux = byoOffers(records, "linux", connected);
  assert.deepEqual(linux.sizes.map((size) => [size.id, size.hourlyUsd]), [["bb", 0]]);
  assert.deepEqual(linux.regions, [BYO_REGION]);
  assert.deepEqual(byoOffers(records, "macos", connected).sizes.map((size) => size.label), ["Machine eeeee (macOS, arm64)"]);
  assert.deepEqual(byoOffers(records, "linux", () => false).sizes, [], "only connected machines");
  assert.equal(byoMachineIdle(machine("x"), true), true);
  assert.equal(byoMachineIdle(machine("x"), false), false);
  assert.equal(byoMachineIdle(machine("x", { deviceHost: true }), true), false, "a device host is the device service's");
  assert.equal(byoMachineLabel(machine("x")), "Machine x");
});
