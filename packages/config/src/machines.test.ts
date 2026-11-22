import assert from "node:assert/strict";
import test from "node:test";

import {
  agentChatThreadSshDir,
  machinesStorePath,
  managedSshConfigPath,
  managedSshKnownHostsPath,
  SSH_CONFIG_INCLUDE_LINE,
  sshProxySocketPath
} from "./index.ts";
import { parseMachinesFile, resolveMachinePolicy, serializeMachinesFile } from "./machines.ts";

test("machine and agent SSH paths sit where the spec puts them", () => {
  assert.equal(machinesStorePath("/a"), "/a/daemon/machines.json");
  assert.equal(sshProxySocketPath("/a"), "/a/daemon/ssh-proxy.sock");
  assert.equal(agentChatThreadSshDir("/a", "t1"), "/a/daemon/agent/threads/t1/ssh");
  assert.equal(managedSshConfigPath("/home/u", "jasper"), "/home/u/.ssh/orquester/jasper.conf");
  assert.equal(managedSshKnownHostsPath("/home/u"), "/home/u/.ssh/orquester/known_hosts");
  assert.equal(SSH_CONFIG_INCLUDE_LINE, "Include ~/.ssh/orquester/*.conf");
});

test("policy: new peers are hidden, unmigrated paired machines ask first with their device switch", () => {
  assert.deepEqual(resolveMachinePolicy(undefined), { visibility: "hidden", capabilities: { devices: false, commands: false, chats: false } });
  assert.deepEqual(resolveMachinePolicy(undefined, { deviceHost: true }), { visibility: "ask", capabilities: { devices: true, commands: true, chats: true } });
  assert.deepEqual(resolveMachinePolicy({ byoBoxId: "b1" }, {}), { visibility: "ask", capabilities: { devices: false, commands: true, chats: true } });
});

test("policy: a stored record wins; missing capabilities are off and an unknown visibility reads as hidden", () => {
  assert.deepEqual(resolveMachinePolicy({ visibility: "free", capabilities: { commands: true } }, { deviceHost: true }), {
    visibility: "free",
    capabilities: { devices: false, commands: true, chats: false }
  });
  assert.deepEqual(resolveMachinePolicy({ visibility: "everyone", capabilities: { devices: true, commands: true, chats: true } }, { deviceHost: true }), {
    visibility: "hidden",
    capabilities: { devices: false, commands: false, chats: false }
  });
});

test("machines.json: unreadable records and unknown keys survive a rewrite", () => {
  const raw = {
    version: 1,
    future: { keep: true },
    machines: {
      "ts:nAbc": {
        visibility: "ask",
        capabilities: { devices: true, gpu: "x" },
        ssh: { user: "jasper", port: 22 },
        wol: { nics: [{ mac: "aa:bb:cc:dd:ee:01", ipv4: "192.168.2.21", prefixLength: 24, broadcast: "192.168.2.255", wolEnabled: true }, { mac: 5 }], updatedAt: "2026-11-22T00:00:00.000Z" },
        note: "kept"
      },
      "ts:nBad": { ssh: { port: "twenty-two" } }
    }
  };
  const file = parseMachinesFile(raw);
  assert.deepEqual(Object.keys(file.machines), ["ts:nAbc"]);
  assert.equal(file.machines["ts:nAbc"]?.wol?.nics.length, 1, "an unreadable NIC is dropped, the record stays");
  const written = serializeMachinesFile(file) as { future: unknown; machines: Record<string, Record<string, unknown>> };
  assert.deepEqual(written.future, { keep: true });
  assert.deepEqual(written.machines["ts:nBad"], raw.machines["ts:nBad"]);
  assert.equal(written.machines["ts:nAbc"]?.note, "kept");
  assert.deepEqual(written.machines["ts:nAbc"]?.capabilities, { devices: true, gpu: "x" });
  assert.throws(() => parseMachinesFile({ version: 2, machines: {} }));
  assert.throws(() => parseMachinesFile({ machines: [] }));
});
