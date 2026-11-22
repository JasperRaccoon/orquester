import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import { MACHINES_CHANGED_EVENT, type MachinesResponse, type MachineSummary } from "@orquester/api";

import { applyMachinesEvent, loadMachines, machinesStore, resetMachines, type MachinesApi } from "./store";

const jasper: MachineSummary = {
  id: "ts:nJASPER",
  name: "jasper",
  hostname: "jasper",
  dnsName: "jasper.tail0000.ts.net",
  os: "linux",
  tailnetIps: ["100.64.0.2"],
  online: true,
  lastSeenAt: null,
  state: "ready",
  visibility: "ask",
  capabilities: { devices: true, commands: true, chats: true },
  boxId: "byo-1",
  wake: { canWake: false },
  sudo: { passwordless: true },
  problems: [{ code: "linger-off", machineId: "ts:nJASPER", message: "jasper's user services stop at logout.", fix: "loginctl enable-linger jasper" }]
};

function api(list: () => Promise<unknown>): MachinesApi {
  return {
    connection: { id: "c1" },
    listMachines: list as () => Promise<MachinesResponse>,
    updateMachine: async () => ({ machine: jasper }),
    removeMachine: async () => ({ uninstalled: true, problems: [] }),
    pairMachineOverSsh: async () => ({ status: "pairing", machine: jasper }),
    wakeMachine: async () => ({ sent: false, via: null })
  };
}

beforeEach(() => resetMachines());

test("a machine this client cannot read is dropped, never half-applied; a payload of the wrong shape is ignored", () => {
  applyMachinesEvent({
    type: MACHINES_CHANGED_EVENT,
    payload: {
      machines: [jasper, { ...jasper, id: "ts:nNEW", visibility: "public" }, { ...jasper, id: "ts:nCAPS", capabilities: { devices: "yes" } }],
      problems: [{ code: "tailscale-unavailable", message: "Tailscale is down.", fix: "sudo tailscale up" }, { code: "made-up", message: "?" }]
    }
  });
  assert.deepEqual(machinesStore.getState().machines, [jasper]);
  assert.deepEqual(machinesStore.getState().problems.map((problem) => problem.code), ["tailscale-unavailable"]);
  applyMachinesEvent({ type: MACHINES_CHANGED_EVENT, payload: { machines: "nope" } });
  assert.deepEqual(machinesStore.getState().machines, [jasper]);
});

test("a list answer that started before a change event does not overwrite it", async () => {
  let answer: (value: unknown) => void = () => undefined;
  const loading = loadMachines(api(() => new Promise((resolve) => (answer = resolve))));
  applyMachinesEvent({ type: MACHINES_CHANGED_EVENT, payload: { machines: [{ ...jasper, visibility: "free" }], problems: [] } });
  answer({ machines: [jasper], problems: [] });
  await loading;
  assert.equal(machinesStore.getState().machines?.[0]?.visibility, "free");
});
