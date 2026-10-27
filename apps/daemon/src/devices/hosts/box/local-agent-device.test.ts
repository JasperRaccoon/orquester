import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { DEVICE_TOOL_VERSIONS } from "../../../boxes/github/device-cache.ts";
import type { DeviceToolchain } from "../../toolchain/index.ts";
import { ensureLocalAgentDevice, localAgentDeviceDir, localAgentDeviceEntry } from "./local-agent-device.ts";

describe("agent-device on this machine", () => {
  let appDir: string;

  beforeEach(async () => {
    appDir = await mkdtemp(join(tmpdir(), "orq-local-ad-"));
  });

  afterEach(async () => {
    await rm(appDir, { recursive: true, force: true });
  });

  it("uses the pinned layout under devicesToolsDir once its install completed", async () => {
    const dir = localAgentDeviceDir(appDir);
    assert.equal(dir, join(appDir, "daemon", "devices", "tools", `agent-device@${DEVICE_TOOL_VERSIONS["agent-device"]}`));
    const entry = join(dir, "node_modules", "agent-device", "bin", "agent-device.mjs");
    await mkdir(join(entry, ".."), { recursive: true });
    await writeFile(entry, "");
    assert.equal(localAgentDeviceEntry(appDir), null, "no sentinel: an interrupted install");
    await writeFile(join(dir, ".install-complete"), "0.0.1");
    assert.equal(localAgentDeviceEntry(appDir), null, "another version's sentinel");
    await writeFile(join(dir, ".install-complete"), DEVICE_TOOL_VERSIONS["agent-device"]);
    assert.equal(localAgentDeviceEntry(appDir), entry);
    assert.equal(await ensureLocalAgentDevice({ appDir, signal: new AbortController().signal }), entry);
  });

  it("prefers the toolchain's install", async () => {
    const bin = join(appDir, "agent-device.mjs");
    await writeFile(bin, "");
    const toolchain = { toolBin: () => bin } as unknown as DeviceToolchain;
    assert.equal(localAgentDeviceEntry(appDir, toolchain), bin);
    assert.equal(await ensureLocalAgentDevice({ appDir, toolchain, signal: new AbortController().signal }), bin);
  });
});
