import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import type { ExecFn } from "../android/exec.ts";
import { CMDLINE_TOOLS, CMDLINE_TOOLS_MAC_ARM64, installCmdlineTools, sdkmanagerPath, type SdkHostPlatform } from "./android-sdk.ts";
import type { DownloadFn, PinnedDownload } from "./download.ts";

/** Install cmdline-tools for `platform` with a fake download and unzip; resolves what was downloaded. */
async function install(root: string, platform?: SdkHostPlatform): Promise<{ fetched: PinnedDownload[]; sdk: string }> {
  const sdk = join(root, "sdk");
  const fetched: PinnedDownload[] = [];
  const download: DownloadFn = async (file, dest) => {
    fetched.push(file);
    await mkdir(join(dest, ".."), { recursive: true });
    await writeFile(dest, "zip");
  };
  // `unzip -q -o <zip> -d <staging>` lays out the archive's `cmdline-tools/bin`.
  const exec: ExecFn = async (command, args) => {
    assert.equal(command, "unzip");
    const staging = args[args.indexOf("-d") + 1]!;
    await mkdir(join(staging, "cmdline-tools", "bin"), { recursive: true });
    for (const tool of ["sdkmanager", "avdmanager"]) await writeFile(join(staging, "cmdline-tools", "bin", tool), "");
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  await installCmdlineTools({ sdk, avd: join(root, "avd") }, { exec, download, env: {}, downloads: join(root, "downloads"), ...(platform ? { platform } : {}) }, new AbortController().signal, () => undefined);
  return { fetched, sdk };
}

describe("the Android command-line tools", () => {
  it("an Apple Silicon Mac gets Google's mac_arm64 archive of the same build; Linux keeps its own", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "orq-sdk-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const mac = await install(join(root, "mac"), "darwin-arm64");
    assert.deepEqual(mac.fetched, [CMDLINE_TOOLS_MAC_ARM64]);
    assert.ok(existsSync(sdkmanagerPath(mac.sdk)));
    const linux = await install(join(root, "linux"));
    assert.deepEqual(linux.fetched, [CMDLINE_TOOLS]);
    assert.equal(CMDLINE_TOOLS_MAC_ARM64.revision, CMDLINE_TOOLS.revision);
  });
});
