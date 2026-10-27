import assert from "node:assert/strict";
import test from "node:test";

import Fastify from "fastify";

import {
  DEFAULT_DEVICES_SETTINGS,
  deviceQueryTokenAllowed,
  DEVICE_THUMBNAIL_ROUTE_PATTERN,
  deviceRoutes,
  type DeviceHostResponse,
  type DevicePoolResponse,
  type DeviceLeaseResponse, type DevicesStateResponse, type DeviceUserActionResponse } from "@orquester/api";

import { DeviceError } from "./errors.ts";
import { hubSearch, registerDeviceHttpRoutes } from "./http-routes.ts";
import { createHubProxy } from "./hub-proxy.ts";
import type { DeviceService } from "./service.ts";
import { FakeDeviceHost, FakeHostFactory, solidPng, startTestDeviceService } from "./testing.ts";

const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };

function appWith(service: DeviceService | null, mode: "local" | "remote" = "remote", principal?: { kind: string }) {
  const app = Fastify();
  if (principal) {
    app.decorateRequest("principal", null);
    app.addHook("onRequest", async (request) => {
      (request as unknown as { principal: unknown }).principal = principal;
    });
  }
  registerDeviceHttpRoutes(app, { devices: () => service, hubProxy: () => createHubProxy({ leaseOnDevice: () => null, userInput: () => undefined, viewerActive: () => undefined, logger: quiet }), logger: quiet }, mode);
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
    // Past the route's checks the proxy answers: a fold names its device; a path off the allowlist is 404.
    const proxied = await remote.inject({ method: "POST", url: deviceRoutes.hub("local", "vendor/serve-emu/api/fold"), headers: { "content-type": "application/octet-stream" }, payload: Buffer.from([1, 2]) });
    assert.equal(proxied.statusCode, 400);
    assert.equal((await remote.inject({ method: "GET", url: deviceRoutes.hub("local", "vendor/serve-sim/exec") })).statusCode, 404);
    assert.equal(hubSearch("/x?token=secret&device=abc"), "?device=abc");
    assert.equal(hubSearch("/x?token=secret"), "");
    assert.equal(hubSearch("/x"), "");
  } finally {
    await remote.close();
    await local.close();
    await t.cleanup();
  }
});

test("user actions: the user takes control first (never refused for the agent's), each is logged as theirs, power off releases", async () => {
  const host = new FakeDeviceHost();
  const t = await startTestDeviceService({ factories: [new FakeHostFactory("local", ["android"], [host])], settings: { android: { enabled: true } } });
  const app = appWith(t.service);
  const agentApp = appWith(t.service, "remote", { kind: "agent" });
  try {
    const signal = new AbortController().signal;
    const { lease } = await t.service.toolOpen("t1", { platform: "android" }, signal);
    assert.equal(lease.controller, "agent");
    const post = (body: unknown, leaseId = lease.id, on = app) => on.inject({ method: "POST", url: deviceRoutes.userAction(leaseId), payload: body as Record<string, unknown> });

    const rotated = await post({ kind: "rotate", orientation: "landscape" });
    assert.equal(rotated.statusCode, 200, rotated.body);
    const body = rotated.json() as DeviceUserActionResponse;
    assert.equal(body.lease.controller, "user");
    assert.deepEqual([body.entry.actor, body.entry.kind, body.entry.summary, body.entry.ok], ["user", "rotate", "did rotate", true]);
    assert.deepEqual(t.actions.calls.at(-1)!.input, { action: "rotate", orientation: "landscape" });
    // The agent now waits for the user.
    await assert.rejects(t.service.toolAction("t1", undefined, { action: "tap", x: 1, y: 2 }, signal), (error: unknown) => (error as DeviceError).code === "DEVICE_CONTROLLED_BY_USER");

    const restarted = (await post({ kind: "restart_app" })).json() as DeviceUserActionResponse;
    assert.equal(restarted.entry.summary, "Restarted com.example.app");
    assert.deepEqual(t.actions.restarts, [lease.id]);
    const dark = (await post({ kind: "appearance", appearance: "dark" })).json() as DeviceUserActionResponse;
    assert.equal(dark.entry.kind, "appearance");

    // A refusal is logged as the user's failed row and answered with its code.
    t.actions.restartImpl = async () => {
      throw new DeviceError("INVALID_ARGUMENT", "No app is open: the home screen is in front.");
    };
    const refused = await post({ kind: "restart_app" });
    assert.equal(refused.statusCode, 400);
    assert.match(refused.json().message, /home screen/);
    const log = t.service.actions(lease.id);
    assert.deepEqual(log.map((entry) => [entry.actor, entry.ok]), [["user", true], ["user", true], ["user", true], ["user", false]]);
    assert.equal(log.at(-1)!.summary, "Restart app failed");

    assert.equal((await post({ kind: "rotate" })).statusCode, 400);
    assert.equal((await post({ kind: "explode" })).statusCode, 400);
    assert.equal((await post({ kind: "restart_app" }, "nope")).statusCode, 404);
    // An agent's (or external client's) principal is refused: agents use device_action.
    const byAgent = await post({ kind: "rotate", orientation: "portrait" }, lease.id, agentApp);
    assert.equal(byAgent.statusCode, 403);
    assert.equal(byAgent.json().code, "PERMISSION_DENIED");

    const closed = t.nextEvent((type) => type === "devices.lease.closed");
    const off = await post({ kind: "power_off" });
    assert.equal(off.statusCode, 200);
    assert.equal((off.json() as DeviceUserActionResponse).lease.state, "released");
    assert.deepEqual(await closed, { leaseId: lease.id, threadId: "t1", reason: "user" });
    assert.deepEqual(host.released.map((entry) => entry.shutdown), [true]);
    assert.equal((await post({ kind: "power_off" })).statusCode, 404);
  } finally {
    await app.close();
    await agentApp.close();
    await t.cleanup();
  }
});

test("pool routes: drain / undrain a host, warm caches, the pool summary (validated bodies)", async () => {
  const local = new FakeDeviceHost();
  const t = await startTestDeviceService({ factories: [new FakeHostFactory("local", ["android"], [local])], settings: { android: { enabled: true } } });
  const app = appWith(t.service, "local");
  try {
    const drained = await app.inject({ method: "PUT", url: deviceRoutes.hostDrain("local"), payload: { draining: true } });
    assert.equal(drained.statusCode, 200);
    assert.equal((drained.json() as DeviceHostResponse).host.pool?.draining, true);
    const undrained = await app.inject({ method: "PUT", url: deviceRoutes.hostDrain("local"), payload: { draining: false } });
    assert.equal((undrained.json() as DeviceHostResponse).host.pool, undefined);
    assert.equal((await app.inject({ method: "PUT", url: deviceRoutes.hostDrain("local"), payload: { draining: "yes" } })).statusCode, 400);
    assert.equal((await app.inject({ method: "PUT", url: deviceRoutes.hostDrain("box:none"), payload: { draining: true } })).json().code, "HOST_NOT_FOUND");
    assert.equal((await app.inject({ method: "POST", url: deviceRoutes.cacheWarm, payload: { platform: "windows" } })).statusCode, 400);
    // No box service here: refused for the owner to read.
    const warm = await app.inject({ method: "POST", url: deviceRoutes.cacheWarm, payload: { platform: "android" } });
    assert.equal(warm.json().code, "UNAVAILABLE");
    const pool = await app.inject({ method: "GET", url: deviceRoutes.pool });
    assert.equal(pool.statusCode, 200);
    assert.equal((pool.json() as DevicePoolResponse).pool.queue, 0);
  } finally {
    await app.close();
    await t.cleanup();
  }
});

test("thumbnail: a ready lease's screen as a no-store JPEG; width checked; unknown leases refused", async () => {
  const host = new FakeDeviceHost();
  host.hubTokenValue = "hub-token";
  const fetched: string[] = [];
  const t = await startTestDeviceService({
    factories: [new FakeHostFactory("local", ["android"], [host])],
    settings: { android: { enabled: true } },
    deps: {
      // A still clock: the 1 s cache must not expire mid-test.
      now: () => Date.parse("2026-10-27T12:00:00.000Z"),
      thumbnailFetch: (async (url: string, init: RequestInit) => {
        fetched.push(`${init.method} ${url} ${(init.headers as Record<string, string>).authorization}`);
        return new Response(new Uint8Array(solidPng(72, 128)), { status: 200 });
      }) as typeof fetch
    }
  });
  const app = appWith(t.service);
  try {
    const opened = await t.service.toolOpen("t1", { platform: "android" }, new AbortController().signal);
    const res = await app.inject({ method: "GET", url: deviceRoutes.thumbnail(opened.lease.id) });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers["content-type"], "image/jpeg");
    assert.equal(res.headers["cache-control"], "no-store");
    assert.equal(res.rawPayload[0], 0xff);
    assert.deepEqual(fetched, [`POST http://127.0.0.1:9/vendor/serve-emu/api/screenshot?device=${opened.lease.stream!.deviceParam} Bearer hub-token`]);
    // Within a second: the same frame, no second capture.
    await app.inject({ method: "GET", url: deviceRoutes.thumbnail(opened.lease.id) });
    assert.equal(fetched.length, 1);
    assert.equal((await app.inject({ method: "GET", url: `${deviceRoutes.thumbnail(opened.lease.id).split("?")[0]}?w=5000` })).statusCode, 400);
    assert.equal((await app.inject({ method: "GET", url: deviceRoutes.thumbnail("nope") })).json().code, "DEVICE_NOT_LEASED");
    assert.ok(deviceQueryTokenAllowed("GET", DEVICE_THUMBNAIL_ROUTE_PATTERN));
  } finally {
    await app.close();
    await t.cleanup();
  }
});
