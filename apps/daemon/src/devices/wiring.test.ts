import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DEVICES_CHANNEL, DEVICES_LEASE_CLOSED_EVENT, DEVICES_PLUGIN_ID, type DeviceLeaseClosedPayload, type PluginsResponse } from "@orquester/api";
import { devicesSettingsPath } from "@orquester/config";

import { FakeActionExecutor, FakeDeviceHost, FakeHostFactory } from "./testing.ts";
import { createDaemonDevices } from "./wiring.ts";

const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };

class FakePlugins {
  readonly events = new EventEmitter();
  enabled = false;
  isEnabled(): boolean {
    return this.enabled;
  }
  set(enabled: boolean): void {
    this.enabled = enabled;
    this.events.emit("changed", { plugins: [{ id: DEVICES_PLUGIN_ID, enabled }] } as unknown as PluginsResponse);
  }
}

test("the service exists only while the plugin is on; off ends every lease; chats closing end theirs", async () => {
  const baseDir = await mkdtemp(join(tmpdir(), "orq-devices-wiring-"));
  await mkdir(join(baseDir, "daemon"), { recursive: true });
  await writeFile(devicesSettingsPath(baseDir), JSON.stringify({ version: 1, settings: { android: { enabled: true } } }));
  const plugins = new FakePlugins();
  const published: { channel: string; type: string; payload: unknown }[] = [];
  const hosts: FakeDeviceHost[] = [];
  const devices = createDaemonDevices({
    baseDir,
    env: {},
    plugins,
    broadcaster: { publish: (channel, type, payload) => void published.push({ channel, type, payload }) },
    boxes: () => null,
    threadTitle: () => null,
    threadProject: () => null,
    threadExists: () => true,
    logger: quiet,
    factories: () => {
      const host = new FakeDeviceHost();
      hosts.push(host);
      return [new FakeHostFactory("local", ["android"], [host])];
    },
    actions: new FakeActionExecutor(),
    idleTimer: false
  });
  let toolChanges = 0;
  devices.onToolsChange(() => (toolChanges += 1));
  try {
    await devices.start();
    assert.equal(devices.service(), null);
    assert.equal(devices.toolsAvailable(), false);

    plugins.set(true);
    await devices.settled();
    const service = devices.service();
    assert.ok(service);
    assert.equal(devices.toolsAvailable(), true);
    assert.ok(toolChanges > 0);
    assert.ok(published.every((event) => event.channel === DEVICES_CHANNEL));

    const signal = new AbortController().signal;
    await service.toolOpen("t1", { platform: "android" }, signal);
    await service.toolOpen("t2", { platform: "android" }, signal);
    devices.chatClosed("t1");
    await service.flush();
    const closedFirst = published.filter((event) => event.type === DEVICES_LEASE_CLOSED_EVENT).map((event) => (event.payload as DeviceLeaseClosedPayload).reason);
    assert.deepEqual(closedFirst, ["chat-closed"]);

    plugins.set(false);
    await devices.settled();
    assert.equal(devices.service(), null);
    assert.equal(devices.toolsAvailable(), false);
    const reasons = published.filter((event) => event.type === DEVICES_LEASE_CLOSED_EVENT).map((event) => (event.payload as DeviceLeaseClosedPayload).reason);
    assert.deepEqual(reasons, ["chat-closed", "plugin-off"]);
    assert.equal(hosts[0]!.released.length, 2);

    // On again: a new service over the same files.
    plugins.set(true);
    await devices.settled();
    assert.notEqual(devices.service(), service);
    assert.deepEqual(devices.service()!.leaseSummaries(), []);
  } finally {
    await devices.stop();
    assert.equal(devices.service(), null);
    // After stop, the plugin switch is no longer followed.
    plugins.set(true);
    await devices.settled();
    assert.equal(devices.service(), null);
    await rm(baseDir, { recursive: true, force: true });
  }
});
