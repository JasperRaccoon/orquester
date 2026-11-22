import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { MachinesResponse } from "@orquester/api";
import { machinesStorePath, type StoredBox } from "@orquester/config";

import { boxRecord } from "../boxes/remote/exec/testing.ts";
import type { MachineSshAccessEntry } from "./ports.ts";
import { MachineRegistry, type MachineBoxConnection, type MachineBoxSource } from "./registry.ts";
import { MachinePolicyStore } from "./store.ts";
import { createTailnetReader } from "./tailscale-peers.ts";

const MAC = "ts:nMAC000000CNTRL";
const JASPER = "ts:nJASPER000CNTRL";

/** The box side: BYO records and their links, with the calls the registry makes. */
class Boxes implements MachineBoxSource {
  readonly records = new Map<string, StoredBox>();
  readonly links = new Map<string, MachineBoxConnection>();
  readonly deviceHostCalls: [string, boolean][] = [];
  readonly released: string[] = [];
  private readonly listeners = new Set<() => void>();

  add(id: string, overrides: Partial<StoredBox> = {}, link?: Partial<MachineBoxConnection>): void {
    this.records.set(id, boxRecord(id, { provider: "byo", purpose: "machine", region: "own", size: "machine", state: link?.connected === false ? "offline" : "ready", ...overrides }));
    if (link) this.links.set(id, { connected: true, hostname: "", os: "linux", elevated: false, ...link });
    this.emit();
  }
  emit(): void {
    for (const listener of this.listeners) listener();
  }
  byoRecords(): readonly StoredBox[] {
    return [...this.records.values()];
  }
  connection(boxId: string): MachineBoxConnection | null {
    return this.links.get(boxId) ?? null;
  }
  summary(): undefined {
    return undefined;
  }
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }
  async setDeviceHost(boxId: string, deviceHost: boolean): Promise<void> {
    this.deviceHostCalls.push([boxId, deviceHost]);
    const record = this.records.get(boxId);
    if (record) record.deviceHost = deviceHost;
  }
  async release(boxId: string): Promise<void> {
    this.released.push(boxId);
    const record = this.records.get(boxId);
    if (record) Object.assign(record, { purpose: "machine", threadId: null });
  }
}

interface Harness {
  dir: string;
  boxes: Boxes;
  status: { BackendState: string; Self: unknown; Peer: Record<string, Record<string, unknown>> };
  published: MachinesResponse[];
  open(): Promise<{ registry: MachineRegistry; store: MachinePolicyStore }>;
}

async function harness(t: test.TestContext): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "orq-machines-"));
  const status = structuredClone(JSON.parse(readFileSync(new URL("./fixtures/localapi-status.json", import.meta.url), "utf8")));
  const boxes = new Boxes();
  const published: MachinesResponse[] = [];
  const opened: MachineRegistry[] = [];
  t.after(async () => {
    for (const registry of opened) await registry.stop();
    await rm(dir, { recursive: true, force: true });
  });
  return {
    dir,
    boxes,
    status,
    published,
    async open() {
      const store = new MachinePolicyStore({ path: machinesStorePath(dir), logger: { error: () => undefined } });
      const registry = new MachineRegistry({
        store,
        boxes,
        readTailnet: createTailnetReader({ localApi: async () => JSON.stringify(status), cli: () => Promise.reject(new Error("unused")) }),
        publish: (payload) => published.push(payload),
        pollMs: 3_600_000,
        logger: { warn: () => undefined }
      });
      opened.push(registry);
      await registry.start();
      return { registry, store };
    }
  };
}

const machineNamed = (response: MachinesResponse, name: string) => response.machines.find((machine) => machine.name === name);

test("machines paired before policies migrate to Ask first with their device switch carried over; a new tailnet peer is Hidden with everything off", async (t) => {
  const h = await harness(t);
  // Paired by command, never seen by orq-agent in this process: listed under its box id.
  h.boxes.add("byo-studio", { machineName: "Studio", deviceHost: true, kind: "macos" });
  const { registry, store } = await h.open();

  const studio = registry.get("box:byo-studio");
  assert.equal(studio?.visibility, "ask");
  assert.deepEqual(studio?.capabilities, { devices: true, commands: true, chats: true });
  assert.equal(studio?.state, "offline");
  const jasper = registry.get(JASPER);
  assert.equal(jasper?.state, "not-paired");
  assert.equal(jasper?.visibility, "hidden");
  assert.deepEqual(jasper?.capabilities, { devices: false, commands: false, chats: false });
  assert.deepEqual(h.boxes.deviceHostCalls, [], "the migration changes nothing on the box");

  // The migration is written once and is what the next start reads.
  await store.flush();
  const file = JSON.parse(await readFile(machinesStorePath(h.dir), "utf8"));
  assert.deepEqual(file.machines["box:byo-studio"], { visibility: "ask", capabilities: { devices: true, commands: true, chats: true }, byoBoxId: "byo-studio" });
  await registry.stop();
  h.boxes.records.get("byo-studio")!.deviceHost = false;
  const again = await h.open();
  assert.equal(again.registry.get("box:byo-studio")?.capabilities.devices, true, "the stored policy wins over the box flag after migration");
});

test("a connected box is matched to its peer by the hostname orq-agent reports; two peers that both fit match nothing", async (t) => {
  const h = await harness(t);
  h.boxes.add("byo-mac", { machineName: "Mac", kind: "macos" });
  const { registry, store } = await h.open();
  // Chosen while the box was known only by its id: the policy travels with it to the peer's id.
  await registry.updatePolicy("box:byo-mac", { visibility: "free" });
  h.boxes.links.set("byo-mac", { connected: true, hostname: "Eduards-MacBook-Pro.local", os: "macos", elevated: false });
  h.boxes.emit();
  await Promise.resolve();

  const mac = registry.get(MAC);
  assert.equal(mac?.boxId, "byo-mac", "the box record moved to the peer's id");
  assert.equal(registry.get("box:byo-mac"), undefined);
  assert.equal(mac?.name, "Mac");
  assert.equal(mac?.hostname, "Eduard’s MacBook Pro");
  assert.equal(mac?.dnsName, "eduards-macbook-pro.tail0000.ts.net");
  assert.equal(mac?.state, "ready");
  assert.equal(mac?.visibility, "free");
  await store.flush();
  const file = JSON.parse(await readFile(machinesStorePath(h.dir), "utf8"));
  assert.equal(file.machines[MAC]?.byoBoxId, "byo-mac");
  assert.equal(file.machines["box:byo-mac"], undefined);

  // A second online Linux peer that also calls itself jasper: no link either way.
  const [key, jasperPeer] = Object.entries(h.status.Peer).find(([, peer]) => peer.HostName === "jasper")!;
  h.status.Peer[`${key}x`] = { ...jasperPeer, ID: "nJASPER2000CNTRL", DNSName: "jasper-1.tail0000.ts.net." };
  await registry.refresh();
  h.boxes.add("byo-jasper", { machineName: "jasper" }, { hostname: "jasper", os: "linux" });
  await Promise.resolve();
  assert.equal(registry.get("box:byo-jasper")?.boxId, "byo-jasper");
  assert.equal(registry.get(JASPER)?.boxId, null);
  assert.equal(registry.get("ts:nJASPER2000CNTRL")?.boxId, null);
});

test("states: ready while orq-agent is connected, offline with the peer online, asleep (naming the fix) with the peer offline, pairing", async (t) => {
  const h = await harness(t);
  h.boxes.add("byo-jasper", { machineName: "jasper" }, { hostname: "jasper", os: "linux" });
  h.boxes.add("byo-new", { machineName: "New one", state: "pairing" });
  const { registry } = await h.open();
  assert.equal(registry.get(JASPER)?.state, "ready");
  assert.equal(registry.get("box:byo-new")?.state, "pairing");
  assert.equal(registry.list().machines.find((machine) => machine.self)?.state, "ready");

  h.boxes.links.get("byo-jasper")!.connected = false;
  h.boxes.emit();
  await Promise.resolve();
  assert.equal(registry.get(JASPER)?.state, "offline");

  const jasperPeer = Object.values(h.status.Peer).find((peer) => peer.HostName === "jasper")!;
  jasperPeer.Online = false;
  await registry.refresh();
  const asleep = registry.get(JASPER);
  assert.equal(asleep?.state, "asleep");
  assert.equal(asleep?.problems[0]?.code, "machine-asleep");
  assert.match(asleep?.problems[0]?.fix ?? "", /Turn it on/);
  assert.equal(asleep?.boxId, "byo-jasper", "a machine linked once stays linked while orq-agent is away");
});

test("policy effects: the device switch reaches the box, Hidden refuses the box but never a rental and takes it back from its chat, Free use with SSH gets the machine alias", async (t) => {
  const h = await harness(t);
  h.boxes.add("byo-jasper", { machineName: "jasper", purpose: "temporary", threadId: "chat-1" }, { hostname: "jasper", os: "linux" });
  const { registry } = await h.open();
  const synced: MachineSshAccessEntry[][] = [];
  registry.setSshAccess({ sync: async (entries) => void synced.push([...entries]) });
  let notified = 0;
  registry.onChange(() => (notified += 1));

  await registry.updatePolicy(JASPER, { capabilities: { devices: true } });
  assert.deepEqual(h.boxes.deviceHostCalls, [["byo-jasper", true]]);
  assert.equal(registry.allowsBox("byo-jasper", "devices"), true);
  assert.equal(registry.allowsBox("byo-jasper", "commands"), true, "Ask first still lets a chat use it (after its card)");
  assert.deepEqual(h.boxes.released, []);
  assert.equal(registry.get(JASPER)?.sshAlias, undefined, "no machine alias while Ask first");

  await registry.updatePolicy(JASPER, { visibility: "hidden" });
  assert.equal(registry.allowsBox("byo-jasper", "commands"), false);
  assert.equal(registry.allowsBox("byo-jasper", "devices"), false);
  assert.equal(registry.allowsBox("hetzner-box", "commands"), true, "a rental is never a machine");
  assert.deepEqual(h.boxes.deviceHostCalls.at(-1), ["byo-jasper", false], "a Hidden machine hosts no device simulators");
  assert.deepEqual(h.boxes.released, ["byo-jasper"], "the chat that borrowed it gives it back");
  assert.equal(registry.list({ kind: "agent", threadId: "chat-1" }).machines.length, 0);
  assert.equal(registry.get(JASPER, { kind: "agent", threadId: "chat-1" }), undefined);
  assert.ok(notified >= 2);

  await registry.updatePolicy(JASPER, { visibility: "free", capabilities: { commands: true } });
  assert.equal(registry.get(JASPER)?.sshAlias, "orq-jasper");
  assert.deepEqual(synced.at(-1), [{ machineId: JASPER, boxId: "byo-jasper", alias: "jasper" }]);
  await registry.updatePolicy(JASPER, { capabilities: { commands: false } });
  assert.deepEqual(synced.at(-1), [], "turning SSH off revokes the alias");
  const view = registry.list({ kind: "agent", threadId: "chat-1" }).machines;
  assert.deepEqual(view.map((machine) => machine.id), [JASPER], "still visible for its other uses");
  assert.ok(!view.some((machine) => machine.self), "the daemon's own host is never listed to agents");
});
