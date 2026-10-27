import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { BOX_TOOLS_LOCK } from "../../toolchain/npm-tools.ts";
import { DEVICE_TOOL_VERSIONS } from "../../../boxes/github/device-cache.ts";
import { localBoxConnection } from "../../../boxes/testing.ts";
import {
  HUB_PROC_ID,
  INSTALL_TOOLS_SCRIPT,
  IOS_VM_STREAM_FLAGS,
  PROBE_SCRIPT,
  agentDeviceEnv,
  execRemote,
  hubCommand,
  installedToolVersion,
  outputTail,
  parseAgentDeviceStart,
  parseHubState,
  parseProbe,
  remoteEnv,
  remoteLayout
} from "./remote.ts";

describe("box device host remote commands", () => {
  it("lays out Blacksmith boxes under the cache paths and own machines under ~/.orquester", () => {
    const blacksmith = remoteLayout({ provider: "blacksmith", home: "/Users/runner" });
    assert.equal(blacksmith.tools, "/var/lib/orquester/devices/tools");
    assert.equal(blacksmith.hubEntry, "/var/lib/orquester/devices/tools/node_modules/expo-device-hub/dist/server/cli.mjs");
    assert.equal(blacksmith.agentDeviceEntry, "/var/lib/orquester/devices/tools/node_modules/agent-device/bin/agent-device.mjs");
    assert.equal(remoteLayout({ provider: "byo", home: "/Users/me" }).agentState, "/Users/me/.orquester/devices/agent-device");
  });

  it("parses the probe", () => {
    const probe = parseProbe(
      "path=/opt/homebrew/bin:/usr/bin\nos=Darwin\nnode=/usr/local/bin/node\nnode_version=v22.11.0\nnpm=/usr/local/bin/npm\nvm=1\nxcode=Xcode 26.6 Build version 17E202 \nsimctl=1\n"
    );
    assert.deepEqual(probe, {
      path: "/opt/homebrew/bin:/usr/bin",
      os: "Darwin",
      nodePath: "/usr/local/bin/node",
      nodeMajor: 22,
      nodeVersion: "v22.11.0",
      npmPath: "/usr/local/bin/npm",
      vm: true,
      xcode: "Xcode 26.6 Build version 17E202",
      simctl: true,
      kvm: null
    });
    assert.equal(parseProbe("os=Linux\nnode=\nkvm=0\n").nodeMajor, null);
    assert.deepEqual(remoteEnv(probe), { PATH: "/usr/local/bin:/opt/homebrew/bin:/usr/bin", FORCE_COLOR: "0", NO_COLOR: "1" });
  });

  it("runs the probe through a box connection", async () => {
    const result = await execRemote(localBoxConnection(), { command: "/bin/sh", args: ["-c", PROBE_SCRIPT] }, { timeoutMs: 30_000 });
    assert.equal(result.exitCode, 0);
    const probe = parseProbe(result.stdout);
    assert.equal(probe.os, "Linux");
    assert.ok(probe.nodeMajor !== null && probe.nodeMajor >= 22);
  });

  it("execRemote collects output, reports exit codes and times out", async () => {
    const connection = localBoxConnection();
    const lines: string[] = [];
    const ok = await execRemote(connection, { command: "/bin/sh", args: ["-c", 'printf "a\\nb\\n"; echo err >&2; exit 3'] }, { onLine: (line) => lines.push(line) });
    assert.deepEqual([ok.exitCode, ok.stdout, ok.stderr.trim()], [3, "a\nb\n", "err"]);
    assert.deepEqual(lines.sort(), ["a", "b", "err"]);
    await assert.rejects(execRemote(connection, { command: "sleep", args: ["5"] }, { timeoutMs: 50 }), /timed out/);
    const abort = new AbortController();
    const pending = execRemote(connection, { command: "sleep", args: ["5"] }, { signal: abort.signal });
    abort.abort();
    await assert.rejects(pending);
  });

  it("installs exactly the pinned tools", () => {
    // From the shipped lockfile only, with no lifecycle script (writeBoxToolLocks puts it there).
    assert.ok(INSTALL_TOOLS_SCRIPT.includes('cd "$TOOLS"'));
    assert.ok(INSTALL_TOOLS_SCRIPT.includes("npm ci --ignore-scripts"));
    assert.ok(!/npm install/.test(INSTALL_TOOLS_SCRIPT));
    for (const [name, version] of Object.entries(DEVICE_TOOL_VERSIONS)) assert.ok(BOX_TOOLS_LOCK!.packageLock.includes(`"node_modules/${name}": {\n      "version": "${version}"`));
    assert.equal(installedToolVersion('{"name":"agent-device","version":"0.21.31"}'), "0.21.31");
    assert.equal(installedToolVersion("nope"), null);
  });

  it("starts the hub detached, token-gated on a random loopback port, with stdout dropped", () => {
    const layout = remoteLayout({ provider: "blacksmith", home: "/Users/runner" });
    const command = hubCommand({ nodePath: "/n/node", layout, platform: "ios", streamFlags: IOS_VM_STREAM_FLAGS, env: { PATH: "/n" } });
    assert.equal(command.command, "/bin/sh");
    assert.deepEqual(command.args!.slice(0, 5), ["-c", 'exec "$@" > /dev/null', HUB_PROC_ID, "/n/node", layout.hubEntry]);
    assert.deepEqual(command.args!.slice(5, 11), ["--port", "0", "--host", "127.0.0.1", "--require-token", "--hide-sidebar"]);
    assert.ok(command.args!.join(" ").endsWith("--platform ios --transport mjpeg --max-dimension 1000 --mjpeg-quality 0.6"));
    assert.deepEqual(command.detach, { procId: HUB_PROC_ID, bufferBytes: 256 * 1024 });
    assert.equal(command.env?.EXPO_DEVICE_HUB_STATE_DIR, "/var/lib/orquester/devices/hub");
    assert.ok(command.envUnset?.includes("EXPO_DEVICE_HUB_SESSION_TOKEN"));
  });

  it("reads the hub state and the agent-device daemon's answer", () => {
    assert.deepEqual(parseHubState('{"pid":12,"port":3401,"url":"x","token":"t"}'), { pid: 12, port: 3401, token: "t" });
    assert.deepEqual(parseHubState('{"pid":12,"port":3401}'), { pid: 12, port: 3401, token: null });
    assert.equal(parseHubState("{"), null);
    assert.deepEqual(parseAgentDeviceStart('noise\n{"httpPort":4100,"token":"abc"}\n'), { httpPort: 4100, token: "abc" });
    assert.equal(parseAgentDeviceStart('{"httpPort":4100,"token":""}'), null);
    assert.deepEqual(agentDeviceEnv(remoteLayout({ provider: "blacksmith", home: "/h" }), { PATH: "/p" }), {
      PATH: "/p",
      AGENT_DEVICE_STATE_DIR: "/var/lib/orquester/devices/agent-device",
      AGENT_DEVICE_DAEMON_SERVER_MODE: "http",
      AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS: "0",
      AGENT_DEVICE_NO_UPDATE_NOTIFIER: "1"
    });
    assert.equal(outputTail("a\n\nb\nc\nd\n"), "b · c · d");
  });
});
