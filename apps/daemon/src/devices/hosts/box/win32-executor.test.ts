import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";

import type { BoxAgentCapability } from "@orquester/api";

import type { BoxConnection, BoxExecOptions, BoxProcess } from "../../../boxes/contracts.ts";
import { emulatorArgs } from "../../android/emulator.ts";
import { windowsBoxExecutor } from "./win32-executor.ts";
import { NoDesktopSessionError } from "./win32-remote.ts";

const fixture = (name: string) => readFileSync(new URL(`../../fixtures/win32/${name}`, import.meta.url), "utf8");
const ROOT = "C:/Users/user/.orquester/devices";

/** A box process that writes `stdout` and exits 0, or whose open fails with `errorCode`. */
function scriptedProcess(stdout: string, errorCode?: string): BoxProcess {
  const emitter = new EventEmitter();
  const out = new PassThrough();
  const err = new PassThrough();
  Object.assign(emitter, { stdin: new PassThrough(), stdout: out, stderr: err, pid: 1, procId: null, exitCode: null, signalCode: null, killed: false, kill: () => false, resize: () => {} });
  setImmediate(() => {
    if (errorCode) {
      emitter.emit("error", Object.assign(new Error(`refused: ${errorCode}`), { code: errorCode }));
      return;
    }
    out.end(stdout);
    err.end("");
    emitter.emit("exit", 0, null);
  });
  return emitter as unknown as BoxProcess;
}

/** A Windows box link answering each exec with `answer`; every exec is kept. */
function windowsLink(answer: (options: BoxExecOptions) => { stdout?: string; errorCode?: string }, capabilities: BoxAgentCapability[] = []) {
  const execs: BoxExecOptions[] = [];
  const link = {
    boxId: "minipc",
    connected: true,
    capabilities,
    exec(options: BoxExecOptions): BoxProcess {
      execs.push(options);
      const { stdout = "", errorCode } = answer(options);
      return scriptedProcess(stdout, errorCode);
    }
  } as unknown as BoxConnection;
  return { link, execs };
}

/** The PowerShell script an exec ran (`-EncodedCommand`). */
const scriptOf = (options: BoxExecOptions) => Buffer.from(options.args!.at(-1)!, "base64").toString("utf16le");

describe("Windows box executor", () => {
  it("runs programs with Windows paths in the command, arguments, cwd and environment", async () => {
    const { link, execs } = windowsLink(() => ({ stdout: "ok" }));
    const x = windowsBoxExecutor(() => link, { root: () => ROOT });
    const result = await x.exec(`${ROOT}/android-sdk/platform-tools/adb`, ["-s", "emulator-5586", "install", `${ROOT}/uploads/a/app.apk`], { env: { ANDROID_AVD_HOME: `${ROOT}/avd`, NO_COLOR: "1" }, cwd: ROOT });
    assert.equal(result.stdout, "ok");
    assert.deepEqual(execs[0], {
      command: "C:\\Users\\user\\.orquester\\devices\\android-sdk\\platform-tools\\adb",
      args: ["-s", "emulator-5586", "install", "C:\\Users\\user\\.orquester\\devices\\uploads\\a\\app.apk"],
      env: { ANDROID_AVD_HOME: "C:\\Users\\user\\.orquester\\devices\\avd", NO_COLOR: "1" },
      cwd: "C:\\Users\\user\\.orquester\\devices"
    });
  });

  it("starts -gpu host emulators in the desktop session only while the box has the helper; the values travel in the environment", async () => {
    const args = emulatorArgs({ avd: "orq-pixel-9", consolePort: 5586, grpcPort: 8570, gpu: "host", snapshot: "orq-golden" });
    const options = { env: { ANDROID_AVD_HOME: `${ROOT}/avd` }, logPath: `${ROOT}/logs/emulator-5586.log` };

    const without = windowsLink(() => ({ stdout: '{"pid":4242}' }));
    await assert.rejects(windowsBoxExecutor(() => without.link, { root: () => ROOT }).spawnDetached(`${ROOT}/android-sdk/emulator/emulator`, args, options), NoDesktopSessionError);
    assert.equal(without.execs.length, 0);

    const desktop = windowsLink(() => ({ stdout: '#< CLIXML\r\n{"pid":4242}\r\n' }), ["desktop-session"]);
    const pid = await windowsBoxExecutor(() => desktop.link, { root: () => ROOT }).spawnDetached(`${ROOT}/android-sdk/emulator/emulator`, args, options);
    assert.equal(pid, 4242);
    const exec = desktop.execs[0]!;
    assert.equal(exec.command, "powershell.exe");
    assert.equal(exec.session, "desktop");
    assert.equal(exec.env?.ORQ_EXE, "C:\\Users\\user\\.orquester\\devices\\android-sdk\\emulator\\emulator.exe");
    assert.equal(exec.env?.ORQ_LOG, "C:\\Users\\user\\.orquester\\devices\\logs\\emulator-5586.log");
    assert.match(exec.env!.ORQ_ARGS!, /^-read-only -avd orq-pixel-9 .* -gpu host -port 5586 /);
    // The script is constant text: no value is spliced into it.
    assert.ok(!scriptOf(exec).includes("orq-pixel-9") && !scriptOf(exec).includes("emulator-5586"));

    const service = windowsLink(() => ({ stdout: '{"pid":77}' }));
    await windowsBoxExecutor(() => service.link, { root: () => ROOT }).spawnDetached(`${ROOT}/android-sdk/emulator/emulator`, emulatorArgs({ avd: "orq-pixel-9", consolePort: 5586, grpcPort: 8570, gpu: "angle_indirect" }), options);
    assert.equal(service.execs[0]!.session, undefined);
  });

  it("names the refusal when the box's helper went away between the check and the launch", async () => {
    const { link } = windowsLink(() => ({ errorCode: "NO_DESKTOP_SESSION" }), ["desktop-session"]);
    const args = emulatorArgs({ avd: "orq-pixel-9", consolePort: 5586, grpcPort: 8570, gpu: "host" });
    await assert.rejects(windowsBoxExecutor(() => link, { root: () => ROOT }).spawnDetached(`${ROOT}/android-sdk/emulator/emulator`, args, { env: {}, logPath: `${ROOT}/logs/x.log` }), NoDesktopSessionError);
  });

  it("reads processes from CIM rows: names without .exe, children by parent pid, this host's by their executable's place", async () => {
    const qemu = `[[5001,5000,"qemu-system-x86_64-headless.exe",1795329177591,123400000,"C:\\\\Users\\\\user\\\\.orquester\\\\devices\\\\android-sdk\\\\emulator\\\\qemu\\\\windows-x86_64\\\\qemu-system-x86_64-headless.exe","C:\\\\Users\\\\user\\\\.orquester\\\\devices\\\\android-sdk\\\\emulator\\\\qemu\\\\windows-x86_64\\\\qemu-system-x86_64-headless.exe -avd orq-pixel-9"]]`;
    const { link } = windowsLink((options) => {
      const pid = options.env?.ORQ_PID;
      if (pid === "3788") return { stdout: fixture("processes-one.txt") };
      if (pid === "5001") return { stdout: `{"processes":${qemu}}` };
      if (pid) return { stdout: '{"processes":[]}' };
      return { stdout: fixture("processes-all.txt") };
    });
    const x = windowsBoxExecutor(() => link, { root: () => ROOT });
    const all = await x.procStats();
    const explorer = all.find((stat) => stat.pid === 3788);
    assert.deepEqual(explorer, { pid: 3788, comm: "explorer", state: "R", ppid: 5200, pgrp: 3788, cpuTicks: 437, startTicks: 179532377422 });

    const stat = await x.procStat(5001);
    assert.equal(stat?.comm, "qemu-system-x86_64-headless");
    assert.equal(stat?.cpuTicks, 1234);
    assert.deepEqual(await x.environ(5001), new Map([["ANDROID_AVD_HOME", `${ROOT}/avd`]]));
    assert.deepEqual(await x.cmdline(5001), [`${ROOT}/android-sdk/emulator/qemu/windows-x86_64/qemu-system-x86_64-headless.exe -avd orq-pixel-9`]);
    // explorer.exe is not this host's: no marker; a gone pid reads as gone.
    assert.deepEqual(await x.environ(3788), new Map());
    assert.equal(await x.procStat(9999), null);
    assert.equal(await x.environ(9999), null);
  });

  it("reads listening sockets as /proc/net/tcp states", async () => {
    const { link } = windowsLink(() => ({ stdout: fixture("tcp.txt") }));
    const x = windowsBoxExecutor(() => link, { root: () => ROOT });
    const rows = await x.tcpRows();
    assert.deepEqual(
      rows.map((row) => `${row.localPort}:${row.state}`),
      ["49671:0A", "22:0A", "34597:0A", "49975:01"]
    );
    assert.equal(await x.isPortFree(22), false);
    assert.equal(await x.isPortFree(5586), true);
  });

  it("stops a process tree with taskkill, and refuses reads while the box is unreachable", async () => {
    const { link, execs } = windowsLink(() => ({ stdout: "" }));
    const x = windowsBoxExecutor(() => link, { root: () => ROOT });
    assert.equal(await x.signal(5000, 5001, "SIGTERM"), true);
    assert.deepEqual([execs[0]!.command, ...execs[0]!.args!], ["taskkill.exe", "/T", "/F", "/PID", "5000"]);
    (link as { connected: boolean }).connected = false;
    await assert.rejects(x.procStat(5001), /not connected/);
  });
});
