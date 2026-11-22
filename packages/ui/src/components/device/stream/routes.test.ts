import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  INITIAL_ROUTE_STATE,
  probeRoute,
  ROUTE_REEVALUATE_MS,
  ROUTE_SWITCH_COOLDOWN_MS,
  stepRoute,
  usableRoutes,
  type DeviceStreamRoute,
  type StreamRouteEvent,
  type StreamRouteState
} from "./routes.ts";

const TAILNET: DeviceStreamRoute = { kind: "tailnet", url: "https://jasper.tail.ts.net:10043" };
const LAN: DeviceStreamRoute = { kind: "lan", url: "http://192.168.2.6:41000" };
const DAEMON: DeviceStreamRoute = { kind: "daemon", url: "/api/devices/hosts/box%3Ajasper/hub/" };
const EXPECTED = { hostId: "box:jasper", machineId: "ts:jasper-node" };

/** A fetch answering each identity URL with the given body (or failing for a missing one); records what was asked. */
function identityFetch(bodies: Record<string, unknown>) {
  const asked: string[] = [];
  const fetcher = (async (input: string | URL | Request) => {
    const url = String(input);
    asked.push(url);
    const origin = Object.keys(bodies).find((base) => url.startsWith(base));
    if (!origin) throw new TypeError("Failed to fetch");
    return new Response(JSON.stringify(bodies[origin]), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetcher, asked };
}

/** Run events through the machine, answering each probe request with `answer` (by URL). */
function run(events: StreamRouteEvent[], answer: (route: DeviceStreamRoute) => boolean, start: StreamRouteState = INITIAL_ROUTE_STATE) {
  let state = start;
  const probes: string[][] = [];
  for (const event of events) {
    let step = stepRoute(state, event);
    while (step.probe) {
      probes.push(step.probe.map((route) => route.kind));
      const results = Object.fromEntries(step.probe.map((route) => [route.url, answer(route)]));
      step = stepRoute(step.state, { type: "probed", results, now: event.now });
    }
    state = step.state;
  }
  return { state, probes };
}

describe("stream routes", () => {
  it("are what the client may load: no LAN in a browser, no plain http on an HTTPS page, the daemon last", () => {
    const offered = [TAILNET, LAN, DAEMON];
    assert.deepEqual(usableRoutes(offered, { desktop: false, secure: true }), [TAILNET, DAEMON]);
    assert.deepEqual(usableRoutes([{ kind: "tailnet", url: "http://jasper:41000" }, DAEMON], { desktop: false, secure: true }), [DAEMON]);
    assert.deepEqual(usableRoutes(offered, { desktop: true, secure: false }), [TAILNET, LAN, DAEMON]);
  });

  it("are used only after the address answers as the expected machine, and never see the ticket while probing", async () => {
    const right = identityFetch({ [TAILNET.url]: EXPECTED });
    assert.equal(await probeRoute(TAILNET, EXPECTED, { fetch: right.fetcher }), true);
    assert.deepEqual(right.asked, [`${TAILNET.url}/.well-known/orquester/device-host`]);

    // The LAN address now belongs to another device (or another Orquester host): skipped.
    const other = identityFetch({ [LAN.url]: { hostId: "box:jasper", machineId: "ts:someone-else" } });
    const ok = await probeRoute(LAN, EXPECTED, { fetch: other.fetcher });
    const { state } = run([{ type: "routes", routes: [LAN, DAEMON], now: 0 }], () => ok);
    assert.deepEqual(state.active, DAEMON);
    assert.ok(other.asked.every((url) => !url.includes("ticket")));
  });

  it("start on the best route that answers, fall back at once when it fails, and come back only after the cooldown", () => {
    let tailnetUp = true;
    const answer = (route: DeviceStreamRoute) => (route.kind === "tailnet" ? tailnetUp : true);
    let { state, probes } = run([{ type: "routes", routes: [TAILNET, LAN, DAEMON], now: 0 }], answer);
    assert.deepEqual(state.active, TAILNET);
    assert.deepEqual(probes, [["tailnet", "lan"]]);

    // The Mac leaves home: the network changes and the tailnet path stops answering for now.
    tailnetUp = false;
    ({ state } = run([{ type: "network", now: 1_000 }], answer, state));
    assert.deepEqual(state.active, LAN, "a failing route is left at once");

    // Tailscale found a path again, but the switch is recent: no flapping back yet.
    tailnetUp = true;
    ({ state } = run([{ type: "network", now: 1_000 + ROUTE_SWITCH_COOLDOWN_MS - 1 }], answer, state));
    assert.deepEqual(state.active, LAN);
    // On a slower route the clock tries again every minute, then takes the better route.
    ({ state, probes } = run([{ type: "tick", now: 1_000 + ROUTE_SWITCH_COOLDOWN_MS + 10 }], answer, state));
    assert.deepEqual(probes, [], "not before a minute since the last evaluation");
    ({ state } = run([{ type: "tick", now: 1_000 + ROUTE_SWITCH_COOLDOWN_MS - 1 + ROUTE_REEVALUATE_MS }], answer, state));
    assert.deepEqual(state.active, TAILNET);
  });

  it("leave a direct route whose stream fails even though it still answers, and never re-probe the daemon", () => {
    const answer = () => true;
    let { state } = run([{ type: "routes", routes: [TAILNET, DAEMON], now: 0 }], answer);
    assert.deepEqual(state.active, TAILNET);
    ({ state } = run([{ type: "stream-failed", now: 5_000 }], answer, state));
    assert.deepEqual(state.active, DAEMON);
    const again = run([{ type: "stream-failed", now: 6_000 }], answer, state);
    assert.deepEqual(again.probes, []);
    // A renewed ticket with the same routes changes nothing; resume tries the direct route again.
    assert.deepEqual(run([{ type: "routes", routes: [TAILNET, DAEMON], now: 7_000 }], answer, state).state.active, DAEMON);
    assert.deepEqual(run([{ type: "resume", now: 5_000 + ROUTE_SWITCH_COOLDOWN_MS }], answer, state).state.active, TAILNET);
  });
});
