import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { ANDROID_SYSTEM_IMAGE } from "@orquester/api";

import type { ExecFn, ExecOptions } from "../android/exec.ts";
import { parseIni } from "../android/avd-config.ts";
import type { DeviceHostProgress } from "../host.ts";
import type { DownloadFn } from "./download.ts";
import { createDeviceToolchain } from "./index.ts";

const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };

async function withAppDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "orq-devices-toolchain-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function touch(path: string, text = ""): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

/** A fake Android SDK: unzip, sdkmanager and avdmanager create the files the real ones would. */
function fakeSdk(sdk: string, log: { command: string; args: string[]; options?: ExecOptions }[], failInstallOnce = { value: false }): ExecFn {
  return async (command, args, options) => {
    log.push({ command, args: [...args], ...(options ? { options } : {}) });
    const name = command.split("/").at(-1)!;
    if (name === "unzip") {
      const dest = args[args.indexOf("-d") + 1]!;
      await touch(join(dest, "cmdline-tools", "bin", "sdkmanager"));
      await touch(join(dest, "cmdline-tools", "bin", "avdmanager"));
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (name === "sdkmanager" && args.includes("--licenses")) return { exitCode: 0, stdout: "All SDK package licenses accepted.", stderr: "" };
    if (name === "sdkmanager" && args.includes("--install")) {
      if (failInstallOnce.value) {
        failInstallOnce.value = false;
        return { exitCode: 1, stdout: "", stderr: "Error: Failed to download emulator: connection reset" };
      }
      for (const id of args.slice(args.indexOf("--install") + 1)) {
        options?.onLine?.(`[=====      ] 50% Downloading ${id}`);
        if (id === "platform-tools") await touch(join(sdk, "platform-tools", "adb"));
        else if (id === "emulator") {
          await touch(join(sdk, "emulator", "emulator"));
          await touch(join(sdk, "emulator", "source.properties"), "Pkg.Revision=37.2.12\n");
        } else await touch(join(sdk, ...id.split(";"), "system.img"));
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (name === "avdmanager") {
      const path = args[args.indexOf("--path") + 1]!;
      const avdName = args[args.indexOf("--name") + 1]!;
      await touch(join(path, "config.ini"), "avd.id=<build>\navd.name=<build>\ndisk.dataPartition.path=<temp>\nhw.lcd.width=1080\nhw.lcd.height=2424\nhw.gpu.mode=auto\n");
      await touch(join(dirname(path), `${avdName}.ini`), `path=${path}\n`);
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    return { exitCode: -1, stdout: "", stderr: `${name}: not found` };
  };
}

const fakeDownload =
  (count: { n: number }): DownloadFn =>
  async (_file, dest) => {
    count.n += 1;
    await touch(dest, "zip");
  };

test("android: cmdline-tools, licences, packages; a failed step resumes without redoing the done ones", async () => {
  await withAppDir(async (appDir) => {
    const log: { command: string; args: string[] }[] = [];
    const downloads = { n: 0 };
    const failOnce = { value: true };
    const probe = createDeviceToolchain({ appDir, env: { PATH: "/usr/bin" }, logger: quiet, nodePath: "/usr/bin/node", npmCli: null });
    const toolchain = createDeviceToolchain({ appDir, env: { PATH: "/usr/bin" }, logger: quiet, exec: fakeSdk(probe.layout.sdk, log, failOnce), download: fakeDownload(downloads), nodePath: "/usr/bin/node", npmCli: null });
    const progress: DeviceHostProgress[] = [];
    await assert.rejects(toolchain.ensureAndroidSdk(new AbortController().signal, (p) => progress.push(p)), (error: Error & { code?: string }) => {
      assert.equal(error.code, "UNAVAILABLE");
      assert.match(error.message, /Installing the Android SDK failed: .*connection reset/);
      return true;
    });
    assert.equal(progress.at(-1)?.state, "failed");
    assert.equal(downloads.n, 1);
    const status = await toolchain.androidStatus(["pixel-9"]);
    assert.deepEqual(
      status.packages.map((p) => [p.id, p.installed]),
      [
        ["cmdline-tools", true],
        ["platform-tools", false],
        ["emulator", false],
        [ANDROID_SYSTEM_IMAGE, false]
      ]
    );
    // Resume: the archive is not downloaded again.
    await toolchain.ensureAndroidSdk(new AbortController().signal, (p) => progress.push(p));
    assert.equal(downloads.n, 1);
    assert.equal(progress.at(-1)?.state, "done");
    assert.ok(progress.some((p) => p.logLine?.includes("50%")));
    const licences = log.find((call) => call.args.includes("--licenses"));
    assert.ok(licences && licences.args.includes(`--sdk_root=${probe.layout.sdk}`));
    // Done: nothing runs again.
    const before = log.length;
    await toolchain.ensureAndroidSdk(new AbortController().signal);
    assert.equal(log.length, before);
    await toolchain.ensureSystemImage(new AbortController().signal);
    assert.equal(await toolchain.emulatorRevision(), "37.2.12");
    assert.ok((await toolchain.androidStatus([])).packages.every((p) => p.installed));
  });
});

test("android: an AVD is created per profile, its config patched; the private env is used", async () => {
  await withAppDir(async (appDir) => {
    const log: { command: string; args: string[]; options?: ExecOptions }[] = [];
    const probe = createDeviceToolchain({ appDir, env: {}, logger: quiet, nodePath: "/usr/bin/node", npmCli: null });
    const toolchain = createDeviceToolchain({ appDir, env: { PATH: "/usr/bin", SECRET: "x" }, logger: quiet, exec: fakeSdk(probe.layout.sdk, log), download: fakeDownload({ n: 0 }), nodePath: "/usr/bin/node", npmCli: null });
    await assert.rejects(toolchain.ensureAvd("pixel-9", new AbortController().signal), /not installed yet/);
    await toolchain.ensureAndroid(["galaxy-s26"], new AbortController().signal);
    const config = parseIni(await readFile(join(toolchain.layout.avd, "orq-galaxy-s26.avd", "config.ini"), "utf8"));
    assert.equal(config.get("avd.name"), "orq-galaxy-s26");
    assert.equal(config.get("hw.lcd.height"), "1560");
    assert.equal(config.get("hw.gpu.mode"), "swangle_indirect");
    assert.deepEqual(await toolchain.avdStatus("galaxy-s26"), { created: true, snapshot: false });
    assert.deepEqual(await toolchain.avdStatus("pixel-9"), { created: false, snapshot: false });
    const create = log.find((call) => call.args[0] === "create")!;
    assert.deepEqual(create.args.slice(0, 9), ["create", "avd", "--force", "--name", "orq-galaxy-s26", "--package", ANDROID_SYSTEM_IMAGE, "--device", "pixel_9"]);
    assert.equal(create.options?.env?.ANDROID_AVD_HOME, toolchain.layout.avd);
    assert.equal(create.options?.env?.SECRET, undefined);
    // Current: not made again.
    const before = log.length;
    await toolchain.ensureAvd("galaxy-s26", new AbortController().signal);
    assert.equal(log.length, before);
    await toolchain.ensureAvd("galaxy-s26", new AbortController().signal, { force: true });
    assert.equal(log.length, before + 1);
    await assert.rejects(toolchain.ensureAvd("iphone-17-pro", new AbortController().signal), /not an Android profile/);
  });
});

test("tools: none installed in a fresh appdir; installing needs npm", async () => {
  await withAppDir(async (appDir) => {
    const toolchain = createDeviceToolchain({ appDir, env: {}, logger: quiet, nodePath: "/usr/bin/node", npmCli: null });
    assert.deepEqual(
      (await toolchain.tools()).map((tool) => [tool.name, tool.installed, tool.path]),
      [
        ["expo-device-hub", false, null],
        ["agent-device", false, null]
      ]
    );
    assert.equal(toolchain.toolBin("agent-device"), null);
    assert.equal(toolchain.toolEntry("expo-device-hub"), null);
    await assert.rejects(toolchain.ensureTool("agent-device", new AbortController().signal), /npm was not found/);
  });
});
