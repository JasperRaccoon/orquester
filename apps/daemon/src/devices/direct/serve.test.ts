import assert from "node:assert/strict";
import test from "node:test";

import { parseProxyTarget, type ProxyTarget, type ServeRoute } from "../../boxes/tailscale/local.ts";
import { decideGateServe, GATE_SERVE_PORTS, ownGateServePorts, type GateServeInput } from "./serve.ts";

const target = (port: number): ProxyTarget => parseProxyTarget(`http://127.0.0.1:${port}`)!;
const web = (port: number, to: number): ServeRoute => ({ port, kind: "web", https: true, target: target(to) });
const LIVE = target(41000);

const input = (over: Partial<GateServeInput> & { routes?: ServeRoute[] } = {}): GateServeInput => {
  const routes = over.routes ?? [];
  return {
    live: LIVE,
    record: null,
    recordTargetAlive: null,
    ...over,
    snapshot: { installed: true, running: true, dnsName: "jasper.tail.ts.net", httpsCerts: true, serveKnown: true, routes, usedPorts: routes.map((route) => route.port), ...over.snapshot }
  };
};

test("the gate's serve route: created on the first free port, kept, repointed only when it is ours", () => {
  assert.deepEqual(decideGateServe(input()), { kind: "create", port: GATE_SERVE_PORTS[0] });
  // Another app on the first candidate: it is left alone, the next one is used.
  const other = web(GATE_SERVE_PORTS[0]!, 3000);
  assert.deepEqual(decideGateServe(input({ routes: [other] })), { kind: "create", port: GATE_SERVE_PORTS[1] });
  // Already proxying to the live gate (made before a restart): kept, and recorded.
  assert.deepEqual(decideGateServe(input({ routes: [web(10044, 41000)] })), { kind: "serving", port: 10044, adopt: true });
  // Our recorded route, left on a dead port after the gate moved: repointed in place.
  const stale = { port: 10044, target: target(39000) };
  assert.deepEqual(decideGateServe(input({ routes: [web(10044, 39000)], record: stale, recordTargetAlive: false })), { kind: "create", port: 10044 });
  // The recorded port now serves something that answers (someone else took it): never clobbered.
  assert.deepEqual(decideGateServe(input({ routes: [web(10044, 39000)], record: stale, recordTargetAlive: true })), { kind: "create", port: GATE_SERVE_PORTS[0] });
  // Every candidate taken: nothing changes.
  assert.deepEqual(decideGateServe(input({ routes: GATE_SERVE_PORTS.map((port) => web(port, 3000)) })), { kind: "no-port" });
});

test("the gate's serve route needs Tailscale running with HTTPS certificates; only ours is ever removed", () => {
  assert.deepEqual(decideGateServe(input({ snapshot: { installed: false } as GateServeInput["snapshot"] })), { kind: "unavailable", problem: null });
  assert.deepEqual(decideGateServe(input({ snapshot: { running: false } as GateServeInput["snapshot"] })), { kind: "unavailable", problem: "tailscale-unavailable" });
  assert.deepEqual(decideGateServe(input({ snapshot: { httpsCerts: false } as GateServeInput["snapshot"] })), { kind: "unavailable", problem: "tailscale-https-disabled" });

  const routes = [web(10043, 3000), web(10044, 41000), web(10045, 39000)];
  assert.deepEqual(ownGateServePorts({ live: LIVE, record: { port: 10045, target: target(39000) }, routes }), [10044, 10045]);
});
