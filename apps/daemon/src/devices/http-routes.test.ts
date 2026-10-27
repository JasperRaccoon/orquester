import assert from "node:assert/strict";
import test from "node:test";

import Fastify from "fastify";

import { DEFAULT_DEVICES_SETTINGS, deviceRoutes, type DeviceLeaseResponse, type DevicesStateResponse } from "@orquester/api";

import { hubSearch, registerDeviceHttpRoutes } from "./http-routes.ts";
import { createHubProxy } from "./hub-proxy.ts";
import type { DeviceService } from "./service.ts";
import { FakeDeviceHost, FakeHostFactory, startTestDeviceService } from "./testing.ts";

const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };

function appWith(service: DeviceService | null, mode: "local" | "remote" = "remote") {
  const app = Fastify();
  registerDeviceHttpRoutes(app, { devices: () => service, hubProxy: () => createHubProxy({ userInput: () => undefined, logger: quiet }), logger: quiet }, mode);
  return app;
}

test("plugin off: the state says so with the default settings; everything else is DEVICES_DISABLED", async () => {
  const app = appWith(null);
  const state = await app.inject({ method: "GET", url: deviceRoutes.state });
  assert.equal(state.statusCode, 200);
  const body = state.json() as DevicesStateResponse;
  assert.equal(body.enabled, false);
  assert.deepEqual(body.settings, DEFAULT_DEVICES_SETTINGS);
  assert.ok(body.profiles.length > 0);
  for (const [method, url] of [
    ["GET", deviceRoutes.hosts],
    ["GET", deviceRoutes.leases],
    ["PUT", deviceRoutes.settings],
    ["POST", deviceRoutes.setup("android")],
    ["GET", deviceRoutes.hub("local", "api/devices")]
  ] as const) {
    const res = await app.inject({ method, url, payload: method === "GET" ? undefined : {} });
    assert.equal(res.statusCode, 409, `${method} ${url}`);
    assert.equal(res.json().code, "DEVICES_DISABLED");
  }
  await app.close();
});

test("leases over HTTP: the panel opens (201, starting), lists, hands control over, reads the log and releases", async () => {
  const host = new FakeDeviceHost();
  const t = await startTestDeviceService({ factories: [new FakeHostFactory("local", ["android"], [host])], settings: { android: { enabled: true } } });
  const app = appWith(t.service);
  try {
    const bad = await app.inject({ method: "POST", url: deviceRoutes.leases, payload: { threadId: "t1", platform: "android", profile: "iphone-17-pro" } });
    assert.equal(bad.statusCode, 400);
    const opened = await app.inject({ method: "POST", url: deviceRoutes.leases, payload: { threadId: "t1", platform: "android" } });
    assert.equal(opened.statusCode, 201);
    const { lease } = opened.json() as DeviceLeaseResponse;
    assert.equal(lease.openedBy, "user");
    assert.equal(lease.controller, "user");
    await t.service.flush();

    const listed = await app.inject({ method: "GET", url: `${deviceRoutes.leases}?threadId=t1` });
    assert.deepEqual(listed.json().leases.map((entry: { id: string }) => entry.id), [lease.id]);
    assert.deepEqual((await app.inject({ method: "GET", url: `${deviceRoutes.leases}?threadId=t2` })).json().leases, []);

    const handed = await app.inject({ method: "PUT", url: deviceRoutes.controller(lease.id), payload: { controller: "agent" } });
    assert.equal(handed.json().lease.controller, "agent");
    assert.equal((await app.inject({ method: "PUT", url: deviceRoutes.controller(lease.id), payload: { controller: "x" } })).statusCode, 400);
    assert.deepEqual((await app.inject({ method: "GET", url: deviceRoutes.actions(lease.id) })).json(), { leaseId: lease.id, actions: [] });
    assert.equal((await app.inject({ method: "GET", url: deviceRoutes.actions("nope") })).statusCode, 404);
    assert.equal((await app.inject({ method: "GET", url: deviceRoutes.screenshot(lease.id, "nope") })).statusCode, 404);

    const released = await app.inject({ method: "DELETE", url: `${deviceRoutes.lease(lease.id)}?shutdown=1` });
    assert.equal(released.json().lease.state, "released");
    assert.equal((await app.inject({ method: "DELETE", url: deviceRoutes.lease(lease.id) })).statusCode, 404);
  } finally {
    await app.close();
    await t.cleanup();
  }
});

test("settings and setup over HTTP", async () => {
  const host = new FakeDeviceHost();
  const t = await startTestDeviceService({ factories: [new FakeHostFactory("local", ["android"], [host])], settings: { android: { enabled: true } } });
  const app = appWith(t.service);
  try {
    const put = await app.inject({ method: "PUT", url: deviceRoutes.settings, payload: { android: { maxLocalDevices: 4 } } });
    assert.equal(put.statusCode, 200);
    assert.equal(put.json().settings.android.maxLocalDevices, 4);
    const refused = await app.inject({ method: "PUT", url: deviceRoutes.settings, payload: { android: { maxLocalDevices: 0 } } });
    assert.equal(refused.statusCode, 400);
    assert.equal(refused.json().code, "INVALID_ARGUMENT");

    assert.deepEqual((await app.inject({ method: "GET", url: deviceRoutes.setup("android") })).json(), { job: null });
    const ios = await app.inject({ method: "POST", url: deviceRoutes.setup("ios"), payload: {} });
    assert.equal(ios.statusCode, 409);
    assert.equal(ios.json().code, "PLATFORM_NOT_READY");
    const started = await app.inject({ method: "POST", url: deviceRoutes.setup("android"), payload: {} });
    assert.equal(started.statusCode, 202);
    assert.equal(started.json().job.platform, "android");
    assert.equal((await app.inject({ method: "GET", url: "/api/devices/setup/windows" })).statusCode, 400);
    const state = (await app.inject({ method: "GET", url: deviceRoutes.state })).json() as DevicesStateResponse;
    assert.equal(state.enabled, true);
    assert.deepEqual(state.hosts.map((entry) => entry.id), ["local"]);
  } finally {
    await app.close();
    await t.cleanup();
  }
});

test("the hub proxy is remote-only, needs a known host with a lease, and strips the token from the query", async () => {
  const host = new FakeDeviceHost();
  const t = await startTestDeviceService({ factories: [new FakeHostFactory("local", ["android"], [host])], settings: { android: { enabled: true } } });
  const remote = appWith(t.service, "remote");
  const local = appWith(t.service, "local");
  try {
    assert.equal((await local.inject({ method: "GET", url: deviceRoutes.hub("local", "api/devices") })).statusCode, 404);
    assert.equal((await remote.inject({ method: "GET", url: deviceRoutes.hub("box:x", "api/devices") })).json().code, "HOST_NOT_FOUND");
    assert.equal((await remote.inject({ method: "GET", url: deviceRoutes.hub("local", "api/devices") })).json().code, "DEVICE_NOT_LEASED");
    await t.service.toolOpen("t1", { platform: "android" }, new AbortController().signal);
    // The stand-in proxy answers 503 until the real one lands.
    const proxied = await remote.inject({ method: "POST", url: deviceRoutes.hub("local", "vendor/serve-emu/api/fold"), headers: { "content-type": "application/octet-stream" }, payload: Buffer.from([1, 2]) });
    assert.equal(proxied.statusCode, 503);
    assert.equal(hubSearch("/x?token=secret&device=abc"), "?device=abc");
    assert.equal(hubSearch("/x?token=secret"), "");
    assert.equal(hubSearch("/x"), "");
  } finally {
    await remote.close();
    await local.close();
    await t.cleanup();
  }
});
