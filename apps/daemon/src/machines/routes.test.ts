import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import Fastify from "fastify";
import { machineRoutes, type MachinesResponse, type PairMachineOverSshResponse, type WakeMachineResponse } from "@orquester/api";
import { PRINCIPAL_TOKEN_HEADER } from "@orquester/api/agent-chat";
import { machinesStorePath } from "@orquester/config";

import { boxRecord } from "../boxes/remote/exec/testing.ts";
import { mintPrincipalToken, registerPrincipalHook } from "../mcp/principal.ts";
import { MachineRegistry, type MachineBoxSource } from "./registry.ts";
import { registerMachineRoutes } from "./routes.ts";
import { MachinePolicyStore } from "./store.ts";
import { createTailnetReader } from "./tailscale-peers.ts";

const STATUS = readFileSync(new URL("./fixtures/localapi-status.json", import.meta.url), "utf8");
const JASPER = "ts:nJASPER000CNTRL";
const MAC = "ts:nMAC000000CNTRL";

async function harness(t: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "orq-machine-routes-"));
  const records = [boxRecord("byo-jasper", { provider: "byo", purpose: "machine", machineName: "jasper", state: "ready" })];
  const removed: string[] = [];
  const boxes: MachineBoxSource = {
    byoRecords: () => records,
    connection: (boxId) => (boxId === "byo-jasper" ? { connected: true, hostname: "jasper", os: "linux", elevated: true } : null),
    summary: () => undefined,
    onChange: () => () => undefined,
    setDeviceHost: async () => undefined,
    release: async () => undefined
  };
  const registry = new MachineRegistry({
    store: new MachinePolicyStore({ path: machinesStorePath(dir), logger: { error: () => undefined } }),
    boxes,
    readTailnet: createTailnetReader({ localApi: async () => STATUS, cli: () => Promise.reject(new Error("unused")) }),
    publish: () => undefined,
    pollMs: 3_600_000,
    logger: { warn: () => undefined }
  });
  await registry.start();
  const app = Fastify();
  registerPrincipalHook(app);
  registerMachineRoutes(app, {
    registry,
    boxes: {
      removeBox: async (boxId) => {
        removed.push(boxId);
        records.splice(records.findIndex((record) => record.id === boxId), 1);
        return { uninstalled: true };
      },
      byoBoxIds: () => records.map((record) => record.id),
      pairingEnabled: () => true
    },
    logger: { error: () => undefined }
  });
  t.after(async () => {
    await app.close();
    await registry.stop();
    await rm(dir, { recursive: true, force: true });
  });
  /** A request as an agent chat's tool makes it (a fresh single-use principal token). */
  const asAgent = (method: "GET" | "PATCH" | "POST" | "DELETE", url: string, payload?: unknown) => {
    const minted = mintPrincipalToken({ kind: "agent", threadId: "chat-1", projectPath: "" });
    return app.inject({ method, url, headers: { [PRINCIPAL_TOKEN_HEADER]: minted.token }, ...(payload !== undefined ? { payload: payload as object } : {}) }).finally(() => minted.release());
  };
  return { app, registry, removed, asAgent };
}

test("agents see only machines they may use: Hidden ones answer 404 like an unknown id, and only the owner changes a machine", async (t) => {
  const { app, asAgent } = await harness(t);
  // The owner: every peer, the daemon's own host and the paired machine (migrated to Ask first).
  const owner = (await app.inject({ method: "GET", url: machineRoutes.list })).json() as MachinesResponse;
  assert.ok(owner.machines.some((machine) => machine.self));
  assert.equal(owner.machines.find((machine) => machine.id === MAC)?.visibility, "hidden");
  assert.equal(owner.machines.find((machine) => machine.id === JASPER)?.visibility, "ask");
  assert.equal(owner.machines.find((machine) => machine.id === JASPER)?.sudo.passwordless, true);

  const listed = (await asAgent("GET", machineRoutes.list)).json() as MachinesResponse;
  assert.deepEqual(listed.machines.map((machine) => machine.id), [JASPER]);
  const hidden = await asAgent("GET", machineRoutes.machine(MAC));
  const unknown = await asAgent("GET", machineRoutes.machine("ts:nNOSUCH0000CNTRL"));
  assert.equal(hidden.statusCode, 404);
  assert.deepEqual(hidden.json(), unknown.json());

  const patched = await asAgent("PATCH", machineRoutes.machine(JASPER), { visibility: "free" });
  assert.equal(patched.statusCode, 403);
  assert.equal(patched.json().code, "MACHINE_OWNER_ONLY");
  assert.equal((await asAgent("POST", machineRoutes.pairSsh(MAC), {})).statusCode, 404, "a Hidden machine is not even there to pair");
  assert.equal((await asAgent("DELETE", machineRoutes.machine(JASPER))).statusCode, 403);

  const bad = await app.inject({ method: "PATCH", url: machineRoutes.machine(MAC), payload: { visibility: "public" } });
  assert.equal(bad.statusCode, 400);
  const shown = await app.inject({ method: "PATCH", url: machineRoutes.machine(MAC), payload: { visibility: "free", capabilities: { commands: true } } });
  assert.equal(shown.statusCode, 200, shown.body);
  assert.deepEqual(((await asAgent("GET", machineRoutes.list)).json() as MachinesResponse).machines.map((machine) => machine.id).sort(), [JASPER, MAC].sort());
});

test("pairing and waking without their features answer a named problem; removing a paired machine unpairs it and resets its policy", async (t) => {
  const { app, removed } = await harness(t);
  const pair = (await app.inject({ method: "POST", url: machineRoutes.pairSsh(MAC), payload: { user: "mapacho", port: 22 } })).json() as PairMachineOverSshResponse;
  assert.equal(pair.status, "failed");
  assert.equal(pair.status === "failed" && pair.problem.code, "pair-bootstrap-failed");
  assert.ok(pair.status === "failed" && pair.problem.fix);
  const again = await app.inject({ method: "POST", url: machineRoutes.pairSsh(JASPER), payload: {} });
  assert.equal(again.json().code, "MACHINE_ALREADY_PAIRED");
  const wake = (await app.inject({ method: "POST", url: machineRoutes.wake(JASPER) })).json() as WakeMachineResponse;
  assert.deepEqual([wake.sent, wake.via, wake.problem?.code], [false, null, "wake-unavailable"]);

  await app.inject({ method: "PATCH", url: machineRoutes.machine(JASPER), payload: { visibility: "free" } });
  const gone = await app.inject({ method: "DELETE", url: machineRoutes.machine(JASPER) });
  assert.deepEqual(gone.json(), { uninstalled: true, problems: [] });
  assert.deepEqual(removed, ["byo-jasper"]);
  const after = (await app.inject({ method: "GET", url: machineRoutes.machine(JASPER) })).json();
  assert.deepEqual([after.machine.state, after.machine.visibility, after.machine.boxId], ["not-paired", "hidden", null]);
});

test("an agent's wake asks the wake for an agent's senders; the owner's for any of their machines", async (t) => {
  const { app, registry, asAgent } = await harness(t);
  const asked: { machineId: string; agent: boolean }[] = [];
  registry.setWake({
    canWake: () => ({ canWake: true }),
    wake: async (machineId, options) => {
      asked.push({ machineId, agent: options?.agent === true });
      return { sent: true, via: "ts:nMINIPC0000CNTRL" };
    }
  });
  assert.equal((await asAgent("POST", machineRoutes.wake(JASPER))).statusCode, 200);
  assert.equal((await app.inject({ method: "POST", url: machineRoutes.wake(JASPER) })).statusCode, 200);
  assert.deepEqual(asked, [
    { machineId: JASPER, agent: true },
    { machineId: JASPER, agent: false }
  ]);
});
