import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { crc32 } from "node:zlib";

import { BOX_TOOLS_LOCK } from "../../toolchain/npm-tools.ts";
import { DEVICE_TOOL_VERSIONS } from "../../../boxes/github/device-cache.ts";
import { localBoxConnection } from "../../../boxes/testing.ts";
import {
  archiveListingProblem,
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

// ---------------------------------------------------------------------------
// Uploaded archives: crafted zips and tarballs, listed by the real bsdtar when it is installed.
// ---------------------------------------------------------------------------

interface CraftedEntry {
  name: string;
  /** `file` (default), `dir`, `symlink` (data is the target) or `hardlink` (tar only; data is the target). */
  type?: "file" | "dir" | "symlink" | "hardlink";
  data?: string;
}

/** A stored (uncompressed) zip with Unix modes, so a symlink entry is a symlink. */
function craftZip(entries: readonly CraftedEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const data = Buffer.from(entry.type === "dir" ? "" : (entry.data ?? "x"));
    const mode = entry.type === "dir" ? 0o40755 : entry.type === "symlink" ? 0o120777 : 0o100644;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((mode << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, data);
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/** A ustar tarball. */
function craftTar(entries: readonly CraftedEntry[]): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const header = Buffer.alloc(512);
    const isLink = entry.type === "symlink" || entry.type === "hardlink";
    const data = entry.type === "dir" || isLink ? Buffer.alloc(0) : Buffer.from(entry.data ?? "x");
    header.write(entry.name, 0, 100);
    header.write(entry.type === "dir" ? "0000755\0" : "0000644\0", 100);
    header.write("0000000\0", 108);
    header.write("0000000\0", 116);
    header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124);
    header.write("00000000000\0", 136);
    header.write({ file: "0", dir: "5", symlink: "2", hardlink: "1" }[entry.type ?? "file"], 156);
    if (isLink) header.write(entry.data ?? "", 157, 100);
    header.write("ustar\0", 257);
    header.write("00", 263);
    header.write("        ", 148);
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  return Buffer.concat([...blocks, Buffer.alloc(1024)]);
}

const hasBsdtar = (() => {
  try {
    execFileSync("bsdtar", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

/** What the box would answer: `bsdtar -tf` and `-tvf` of the archive. */
function listed(bytes: Buffer, file: string): { names: string; verbose: string } {
  const dir = mkdtempSync(join(tmpdir(), "orq-archive-"));
  try {
    const path = join(dir, file);
    writeFileSync(path, bytes);
    return { names: execFileSync("bsdtar", ["-tf", path], { encoding: "utf8" }), verbose: execFileSync("bsdtar", ["-tvf", path], { encoding: "utf8" }) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const APP: CraftedEntry[] = [{ name: "Payload/", type: "dir" }, { name: "Payload/Demo.app/", type: "dir" }, { name: "Payload/Demo.app/Info.plist" }];

describe("uploaded archives (bsdtar listings)", () => {
  it("a crafted zip, ipa or tarball: only entries that stay inside pass", { skip: hasBsdtar ? false : "bsdtar is not installed" }, () => {
    const cases: { entries: CraftedEntry[]; problem: RegExp | null; tarOnly?: boolean }[] = [
      { entries: APP, problem: null },
      { entries: [...APP, { name: "Payload/Demo.app/Current", type: "symlink", data: "Info.plist" }, { name: "Payload/Demo.app/up", type: "symlink", data: "../Demo.app/Info.plist" }], problem: null },
      { entries: [...APP, { name: "../escape.txt" }], problem: /points outside/ },
      { entries: [...APP, { name: "Payload/../../escape.txt" }], problem: /points outside/ },
      { entries: [...APP, { name: "/etc/evil" }], problem: /points outside/ },
      { entries: [...APP, { name: "Payload/Demo.app/ssh", type: "symlink", data: "/Users/runner/.ssh" }], problem: /link .* points outside/ },
      { entries: [...APP, { name: "Payload/Demo.app/up", type: "symlink", data: "../../../Library" }], problem: /link .* points outside/ },
      { entries: [...APP, { name: "Payload/a b -> c.txt" }], problem: null },
      { entries: [...APP, { name: "Payload/hard", type: "hardlink", data: "Payload/Demo.app/Info.plist" }], problem: null, tarOnly: true },
      { entries: [...APP, { name: "Payload/hard", type: "hardlink", data: "../outside" }], problem: /link .* points outside/, tarOnly: true }
    ];
    for (const { entries, problem, tarOnly } of cases) {
      const archives = tarOnly ? [["x.tar", craftTar(entries)] as const] : ([["x.ipa", craftZip(entries)], ["x.tar", craftTar(entries)]] as const);
      for (const [file, bytes] of archives) {
        const { names, verbose } = listed(bytes, file);
        const found = archiveListingProblem(names, verbose);
        if (problem === null) assert.equal(found, null, `${file}: ${entries.map((entry) => entry.name).join(", ")}`);
        else assert.match(found ?? "", problem, `${file}: ${entries.map((entry) => entry.name).join(", ")}`);
      }
    }
  });

  it("listings that disagree, special files, unreadable names and empty archives are refused", () => {
    assert.match(archiveListingProblem("", "") ?? "", /empty/);
    assert.match(archiveListingProblem("a\nb\n", "-rw-r--r--  0 u g 1 Oct 27 07:32 a\n") ?? "", /cannot be read/);
    assert.match(archiveListingProblem("dev\n", "crw-r--r--  0 u g 0 Oct 27 07:32 dev\n") ?? "", /not a file, directory or link/);
    assert.match(archiveListingProblem("a\tb\n", "-rw-r--r--  0 u g 1 Oct 27 07:32 a\tb\n") ?? "", /unreadable name/);
    assert.match(archiveListingProblem("l\n", "lrwxr-xr-x  0 u g 0 Oct 27 07:32 l\n") ?? "", /cannot be read/);
  });
});
