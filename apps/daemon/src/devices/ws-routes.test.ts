import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test, { type TestContext } from "node:test";

import websocketPlugin from "@fastify/websocket";
import Fastify from "fastify";
import { WebSocket } from "ws";

import { deviceRoutes } from "@orquester/api";

import type { HubProxy } from "./hub-proxy.ts";
import type { DeviceService } from "./service.ts";
import { FakeDeviceHost, FakeHostFactory, startTestDeviceService } from "./testing.ts";
import { registerDeviceWsRoutes } from "./ws-routes.ts";

const TOKEN = "good";

async function startApp(t: TestContext, service: () => DeviceService | null, proxy: HubProxy): Promise<number> {
  const app = Fastify();
  await app.register(websocketPlugin);
  await registerDeviceWsRoutes(app, { authorize: (token) => token === TOKEN, devices: service, hubProxy: () => proxy });
  await app.listen({ host: "127.0.0.1", port: 0 });
  t.after(async () => {
    for (const client of app.websocketServer.clients) client.terminate();
    await app.close();
  });
  return (app.server.address() as AddressInfo).port;
}

const url = (port: number, hostId: string, token = TOKEN) => `ws://127.0.0.1:${port}${deviceRoutes.socket(hostId, "vendor/serve-emu/ws")}?device=d1&token=${token}`;

function closeOf(client: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => client.once("close", (code, reason) => resolve({ code, reason: reason.toString() })));
}

test("the device relay checks the token, the plugin, the host and its lease before handing over", { timeout: 15_000 }, async (t) => {
  const host = new FakeDeviceHost();
  const svc = await startTestDeviceService({ factories: [new FakeHostFactory("local", ["android"], [host])], settings: { android: { enabled: true } } });
  t.after(() => svc.cleanup());
  let on = false;
  const handed: { hostId: string; hubPath: string; search: string }[] = [];
  const proxy: HubProxy = {
    async handleHttp() {},
    handleWebSocket(socket, _request, target) {
      handed.push({ hostId: target.hostId, hubPath: target.hubPath, search: target.search });
      socket.close(1000, "handed");
    }
  };
  const port = await startApp(t, () => (on ? svc.service : null), proxy);

  const expect = async (target: string, code: number, reason: string) => {
    const result = await closeOf(new WebSocket(target));
    assert.deepEqual(result, { code, reason }, target);
  };
  await expect(url(port, "local", "bad"), 1008, "unauthorized");
  await expect(url(port, "local"), 1011, "device simulators are off");
  on = true;
  await expect(url(port, "box:x"), 1011, "unknown device host");
  await expect(url(port, "local"), 1008, "no leased device on this host");
  await svc.service.toolOpen("t1", { platform: "android" }, new AbortController().signal);
  await expect(url(port, "local"), 1000, "handed");
  assert.deepEqual(handed, [{ hostId: "local", hubPath: "/vendor/serve-emu/ws", search: "?device=d1" }]);
});
