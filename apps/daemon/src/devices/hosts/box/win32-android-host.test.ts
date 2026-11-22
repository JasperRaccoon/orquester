import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";

import { DEFAULT_DEVICES_SETTINGS } from "@orquester/api";
import type { StoredBox } from "@orquester/config";

import type { BoxConnection, BoxExecOptions, BoxProcess } from "../../../boxes/contracts.ts";
import { isDeviceError } from "../../errors.ts";
import { BoxWindowsAndroidHost } from "./win32-android-host.ts";

const probeJson = JSON.parse(readFileSync(new URL("../../fixtures/win32/probe-minipc.txt", import.meta.url), "utf8")) as Record<string, unknown>;
const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };

function answered(stdout: string): BoxProcess {
  const emitter = new EventEmitter();
  const out = new PassThrough();
  const err = new PassThrough();
  Object.assign(emitter, { stdin: new PassThrough(), stdout: out, stderr: err, pid: 1, procId: null, exitCode: null, signalCode: null, killed: false, kill: () => false, resize: () => {} });
  setImmediate(() => {
    out.end(stdout);
    err.end("");
    emitter.emit("exit", 0, null);
  });
  return emitter as unknown as BoxProcess;
}

/** The mini PC's link: the probe answers `probe` (the fixture with overrides); the device root is empty. */
function miniPc(probe: Record<string, unknown>) {
  const scripts: string[] = [];
  const link = {
    boxId: "minipc",
    connected: true,
    capabilities: [],
    exec(options: BoxExecOptions): BoxProcess {
      const script = options.command === "powershell.exe" ? Buffer.from(options.args!.at(-1)!, "base64").toString("utf16le") : options.command;
      scripts.push(script);
      return answered(script.includes("Win32_OptionalFeature") ? JSON.stringify(probe) : "{}");
    },
    async request(method: string) {
      return method === "fs.stat" || method === "fs.readdir" ? null : undefined;
    },
    async readFile() {
      throw new Error("ENOENT");
    },
    async writeFile() {}
  } as unknown as BoxConnection;
  const record = { id: "minipc", provider: "byo", purpose: "machine", kind: "windows", os: "win32", state: "ready", machineName: "minipc", createdAt: "2026-11-22T00:00:00.000Z" } as unknown as StoredBox;
  const host = new BoxWindowsAndroidHost({
    boxId: "minipc",
    label: "minipc (your Windows machine)",
    appDir: "/nonexistent-appdir",
    record: () => record,
    connection: () => link,
    settings: () => ({ ...DEFAULT_DEVICES_SETTINGS, android: { ...DEFAULT_DEVICES_SETTINGS.android, enabled: true } }),
    activeLeases: () => [],
    logger: quiet
  });
  return { host, link, scripts };
}

describe("Windows Android host", () => {
  it("stops at WHPX turned off, names the exact fix and installs nothing", async () => {
    const { host, link, scripts } = miniPc({ ...probeJson, hypervisorPlatform: 2, hypervisorPresent: false });
    await assert.rejects(host.prepare(link, new AbortController().signal), (error) => isDeviceError(error) && /Enable-WindowsOptionalFeature -Online -FeatureName HypervisorPlatform -All, then restart minipc/.test(error.message));
    assert.equal(scripts.length, 1);
    assert.equal(host.state().status, "needs-setup");
    // No desktop-session helper on this box either: named too.
    assert.deepEqual(host.problems().map((problem) => problem.code), ["whpx-off", "no-desktop-session"]);
    assert.equal(host.capacity().total, 0);
    assert.equal(host.capacity().basis?.accel, null);
    assert.equal(host.readiness().checks.find((check) => check.id === "whpx")?.state, "error");
    await host.dispose();
  });

  it("asks for disk room before downloading the toolchain; capacity reads the probe", async () => {
    const { host, link, scripts } = miniPc({ ...probeJson, diskFreeBytes: 3 * 1024 ** 3 });
    await assert.rejects(host.prepare(link, new AbortController().signal), (error) => isDeviceError(error) && /needs about 12\.0 GB free/.test(error.message));
    assert.ok(!scripts.some((script) => script.includes("ORQ_SHA256")), "no archive was fetched");
    assert.equal(host.state().status, "needs-setup");
    const capacity = host.capacity();
    // 4.4 GB free would fit one emulator; 3 GB of disk fits none.
    assert.equal(capacity.total, 0);
    assert.deepEqual({ cpus: capacity.basis?.cpus, accel: capacity.basis?.accel, disk: capacity.basis?.freeDiskBytes }, { cpus: 16, accel: "whpx", disk: 3 * 1024 ** 3 });
    await host.dispose();
  });
});
