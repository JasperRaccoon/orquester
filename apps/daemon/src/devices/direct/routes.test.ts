import assert from "node:assert/strict";
import test from "node:test";

import { DEVICE_STREAM_TICKET_TTL_MS, type DeviceStreamTicketResponse } from "@orquester/api";

import { DeviceError } from "../errors.ts";
import type { DeviceDirectStream } from "../host.ts";
import { FakeDeviceHost, FakeHostFactory, FakeMachineAccess, startTestDeviceService } from "../testing.ts";
import { signStreamTicket, verifyStreamTicket } from "./gate.mjs";

const SECRET = Buffer.alloc(32, 3);

/** An own machine whose stream gate runs: its direct routes are whatever the test sets. */
class GateHost extends FakeDeviceHost {
  direct: Omit<DeviceDirectStream, "issueTicket"> | null = null;
  directStream(): DeviceDirectStream | null {
    const direct = this.direct;
    return direct ? { ...direct, issueTicket: ({ device, expiresAt, origin }) => signStreamTicket(SECRET, { hostId: this.id, device, expiresAt, origin }) } : null;
  }
}

async function setup() {
  const access = new FakeMachineAccess();
  access.set("jasper", { machineId: "ts:jasper-node", visibility: "free" });
  const host = new GateHost("box:jasper", "byo", ["android"], "jasper (your Linux machine)");
  host.boxInfo = { boxId: "jasper", provider: "byo", hourlyUsd: 0, startedAt: "2026-11-22T00:00:00.000Z", deadlineAt: null };
  const t = await startTestDeviceService({ factories: [new FakeHostFactory("box", ["android"], [host])], settings: { android: { enabled: true } }, deps: { machineAccess: access } });
  const opened = await t.service.toolOpen("t1", { platform: "android", hostId: host.id }, new AbortController().signal);
  const device = opened.lease.stream!.deviceParam;
  return { t, host, device };
}

const kinds = (response: DeviceStreamTicketResponse) => response.routes.map((route) => route.kind);

test("stream routes go tailnet, then LAN for the desktop app only, then the daemon, with a ticket for that device and page", async () => {
  const { t, host, device } = await setup();
  try {
    host.direct = { tailnetUrl: "https://jasper.tail.ts.net:10043", lanUrls: ["http://192.168.2.6:41000"] };
    const page = "https://orq.tail.ts.net:10000";
    const browser = t.service.streamTicket(host.id, { deviceId: device }, { client: "browser", origin: page });
    assert.deepEqual(browser.routes, [
      { kind: "tailnet", url: "https://jasper.tail.ts.net:10043" },
      { kind: "daemon", url: "/api/devices/hosts/box%3Ajasper/hub/" }
    ]);
    assert.equal(browser.machineId, "ts:jasper-node");
    const verdict = verifyStreamTicket(SECRET, browser.ticket, { hostId: host.id, device, now: browser.expiresAt - DEVICE_STREAM_TICKET_TTL_MS });
    assert.ok(verdict.ok && verdict.claims.origin === page);
    assert.equal(verifyStreamTicket(SECRET, browser.ticket, { hostId: host.id, device: "emulator-5556", now: Date.now() }).ok, false);
    assert.equal(verifyStreamTicket(SECRET, browser.ticket, { hostId: host.id, device, now: browser.expiresAt }).ok, false);

    assert.deepEqual(kinds(t.service.streamTicket(host.id, { deviceId: device }, { client: "desktop", origin: null })), ["tailnet", "lan", "daemon"]);

    // Serve down: the browser gets only the daemon (and no ticket); the desktop app still its LAN route.
    host.direct = { tailnetUrl: null, lanUrls: ["http://192.168.2.6:41000"] };
    const down = t.service.streamTicket(host.id, { deviceId: device }, { client: "browser", origin: page });
    assert.deepEqual(kinds(down), ["daemon"]);
    assert.equal(down.ticket, "");
    assert.equal(down.machineId, undefined);
    assert.deepEqual(kinds(t.service.streamTicket(host.id, { deviceId: device }, { client: "desktop", origin: null })), ["lan", "daemon"]);

    // No gate at all: the daemon's proxy.
    host.direct = null;
    assert.deepEqual(kinds(t.service.streamTicket(host.id, { deviceId: device }, { client: "desktop", origin: null })), ["daemon"]);
  } finally {
    await t.cleanup();
  }
});

test("a stream ticket is only for a device leased on a visible host", async () => {
  const { t, host } = await setup();
  try {
    host.direct = { tailnetUrl: "https://jasper.tail.ts.net:10043", lanUrls: [] };
    const refused = (hostId: string, deviceId: string) => {
      try {
        t.service.streamTicket(hostId, { deviceId }, { client: "browser", origin: null });
        return null;
      } catch (error) {
        return error instanceof DeviceError ? error.code : String(error);
      }
    };
    assert.equal(refused(host.id, "emulator-9999"), "DEVICE_NOT_LEASED");
    assert.equal(refused("box:nothing", "x"), "HOST_NOT_FOUND");
  } finally {
    await t.cleanup();
  }
});
