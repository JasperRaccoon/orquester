import assert from "node:assert/strict";
import test from "node:test";

import type { BoxAgentCapability, BoxNic, MachineVisibility } from "@orquester/api";

import { localBoxConnection, type LocalBoxConnection } from "../boxes/testing.ts";
import { MachineWake, planWake, type WakeMachineView, type WakeSenderCandidate } from "./wake.ts";

const TARGET_MAC = "02:00:5e:10:00:01";
const target = (over: Partial<WakeMachineView> = {}): WakeMachineView => ({
  machineId: "ts:nTARGET",
  name: "studio",
  self: false,
  os: "linux",
  visibility: "ask",
  boxId: "byo-studio",
  wol: {
    nics: [{ name: "enp6s0", mac: TARGET_MAC, ipv4: "192.168.50.21", prefixLength: 24, broadcast: "192.168.50.255", wolEnabled: true }],
    updatedAt: "2026-11-22T08:00:00.000Z"
  },
  ...over
});

const lan = (ipv4: string, prefixLength: number, broadcast: string, wired = true) => ({ ipv4, prefixLength, broadcast, wired });
const candidate = (machineId: string, lans: WakeSenderCandidate["lans"], visibility: MachineVisibility = "free"): WakeSenderCandidate => ({ machineId, name: machineId, self: false, visibility, lans });

test("a sender is chosen only on the network that holds the target's last address, wired first, and never the target itself", () => {
  const nics = target().wol!.nics;
  const plan = planWake("ts:nTARGET", nics, [
    candidate("ts:nWIFI", [lan("192.168.50.30", 24, "192.168.50.255", false)]),
    candidate("ts:nOTHERLAN", [lan("192.168.51.4", 24, "192.168.51.255")]),
    candidate("ts:nWIDER", [lan("10.1.0.9", 8, "10.255.255.255"), lan("192.168.51.9", 23, "192.168.51.255")]),
    candidate("ts:nTARGET", [lan("192.168.50.21", 24, "192.168.50.255")])
  ]);
  assert.deepEqual(
    plan.map((attempt) => [attempt.senderId, attempt.broadcast, attempt.mac]),
    [
      // A /23 that holds 192.168.50.21 broadcasts on its own address.
      ["ts:nWIDER", "192.168.51.255", TARGET_MAC],
      ["ts:nWIFI", "192.168.50.255", TARGET_MAC]
    ]
  );
  // A NIC with wake-on known to be off is never woken.
  assert.deepEqual(planWake("ts:nTARGET", [{ ...nics[0]!, wolEnabled: false }], [candidate("ts:nWIFI", [lan("192.168.50.30", 24, "192.168.50.255")])]), []);
});

interface Sender {
  view: WakeMachineView;
  link: LocalBoxConnection;
}

function sender(id: string, options: { visibility?: MachineVisibility; capabilities?: BoxAgentCapability[]; nics?: BoxNic[] } = {}): Sender {
  const nics = options.nics ?? [{ name: "eth0", mac: "02:00:5e:10:00:99", ipv4: "192.168.50.4", prefixLength: 24, broadcast: "192.168.50.255", wired: true, wolEnabled: null }];
  return {
    view: { machineId: `ts:n${id}`, name: id, self: false, os: "windows", visibility: options.visibility ?? "free", boxId: `byo-${id}`, wol: null },
    link: localBoxConnection({ boxId: `byo-${id}`, capabilities: options.capabilities ?? ["wake-sender"], nics })
  };
}

function wakeWith(machines: WakeMachineView[], senders: Sender[]): MachineWake {
  return new MachineWake({
    machines: () => [...machines, ...senders.map((entry) => entry.view)],
    connection: (boxId) => senders.find((entry) => entry.view.boxId === boxId)?.link ?? null
  });
}

const wakeCalls = (link: LocalBoxConnection) => link.calls.filter((call) => call.method === "net.wake").map((call) => call.params);

test("a wake goes through a connected machine on the target's LAN that can send, onto that LAN's broadcast address", async () => {
  const minipc = sender("minipc");
  const wake = wakeWith([target()], [minipc]);
  assert.deepEqual(wake.canWake("ts:nTARGET"), { canWake: true, via: "ts:nminipc" });
  assert.deepEqual(await wake.wake("ts:nTARGET"), { sent: true, via: "ts:nminipc" });
  assert.deepEqual(wakeCalls(minipc.link), [{ mac: TARGET_MAC, broadcast: "192.168.50.255" }]);
});

test("with no sender on the target's subnet the wake is unavailable, says which subnet, and sends nothing", async () => {
  // Online but too old to send, offline, and on another LAN: none of them can.
  const old = sender("old", { capabilities: [] });
  const asleep = sender("asleep");
  asleep.link.setConnected(false);
  const away = sender("away", { nics: [{ name: "eth0", mac: "02:00:5e:10:00:98", ipv4: "192.168.1.4", prefixLength: 24, broadcast: "192.168.1.255", wired: true, wolEnabled: null }] });
  const wake = wakeWith([target()], [old, asleep, away]);
  assert.equal(wake.canWake("ts:nTARGET").canWake, false);
  const result = await wake.wake("ts:nTARGET");
  assert.equal(result.sent, false);
  assert.equal(result.problem?.code, "wake-unavailable");
  assert.match(result.problem!.message, /192\.168\.50\.0\/24/, "it names the subnet a sender is missing on");
  for (const entry of [old, away]) assert.deepEqual(wakeCalls(entry.link), [], entry.view.name);
});

test("the owner's wake may be sent by a Hidden machine; an agent's never is, and its answer does not name it", async () => {
  const hidden = sender("secretbox", { visibility: "hidden" });
  const wake = wakeWith([target()], [hidden]);

  assert.equal(wake.canWake("ts:nTARGET", { agent: true }).canWake, false);
  const refused = await wake.wake("ts:nTARGET", { agent: true });
  assert.equal(refused.sent, false);
  assert.doesNotMatch(`${refused.problem?.message} ${refused.problem?.fix}`, /secretbox/);
  assert.deepEqual(wakeCalls(hidden.link), []);

  assert.deepEqual(await wake.wake("ts:nTARGET"), { sent: true, via: "ts:nsecretbox" });
  assert.equal(wakeCalls(hidden.link).length, 1);
});
