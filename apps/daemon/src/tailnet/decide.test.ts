import assert from "node:assert/strict";
import test from "node:test";

import { parseProxyTarget, type ServeRoute } from "../boxes/tailscale/local.ts";
import { chooseHttpsPort, decideHttps, decidePreview, ownHttpsRoutes, type HttpsCheckInput, type HttpsDecision, type HttpsRecord } from "./decide.ts";

const target = (text: string) => parseProxyTarget(text)!;
const web = (port: number, proxy: string | null): ServeRoute => ({ port, kind: "web", https: true, target: proxy ? target(proxy) : null });
const LIVE = target("http://127.0.0.1:47831");
const OLD = target("http://127.0.0.1:47000");
const record = (port: number, at: string | null = "http://127.0.0.1:47831", enabled = true): HttpsRecord => ({ enabled, port, target: at ? target(at) : null });

test("decideHttps: state in, action out", () => {
  const base: HttpsCheckInput = { serveKnown: true, live: LIVE, record: null, routes: [], recordTargetAlive: null };
  const cases: [string, Partial<HttpsCheckInput>, HttpsDecision][] = [
    ["serve status unreadable: change nothing", { serveKnown: false, record: record(10000) }, { kind: "unknown" }],
    ["never set up, nothing serving", {}, { kind: "off" }],
    ["turned off, nothing serving", { record: record(10000, null, false) }, { kind: "off" }],
    ["serving the live daemon as recorded", { record: record(10000), routes: [web(10000, "http://127.0.0.1:47831")] }, { kind: "serving", port: 10000, adopt: false }],
    ["a route to the daemon made elsewhere is adopted", { routes: [web(10000, "localhost:47831")] }, { kind: "serving", port: 10000, adopt: true }],
    ["the route was deleted: recreate it", { record: record(10000), routes: [] }, { kind: "create", port: 10000, reason: "missing" }],
    [
      "our route still points at the old port, which is dead: repoint it",
      { record: record(10000, "http://127.0.0.1:47000"), routes: [web(10000, "http://127.0.0.1:47000")], recordTargetAlive: false },
      { kind: "create", port: 10000, reason: "stale" }
    ],
    [
      "our old target answers again (another app took the port): leave it",
      { record: record(10000, "http://127.0.0.1:47000"), routes: [web(10000, "http://127.0.0.1:47000")], recordTargetAlive: true },
      { kind: "taken", port: 10000, by: "http://127.0.0.1:47000" }
    ],
    [
      "another app serves the port now: never taken over",
      { record: record(10000), routes: [web(10000, "http://127.0.0.1:3000")], recordTargetAlive: false },
      { kind: "taken", port: 10000, by: "http://127.0.0.1:3000" }
    ],
    ["a file server on the port", { record: record(10000), routes: [web(10000, null)] }, { kind: "taken", port: 10000, by: null }],
    ["wanted while the HTTP transport is off", { live: null, record: record(10000) }, { kind: "http-off" }]
  ];
  for (const [label, input, expected] of cases) assert.deepEqual(decideHttps({ ...base, ...input }), expected, label);
});

test("chooseHttpsPort: the recorded port when free or our stale route, else the first unused candidate", () => {
  const candidates = [10000, 10001, 10002];
  const pick = (input: Partial<Parameters<typeof chooseHttpsPort>[0]>) =>
    chooseHttpsPort({ record: null, routes: [], usedPorts: [], candidates, previewPorts: new Set(), recordTargetAlive: null, ...input });
  assert.equal(pick({}), 10000);
  assert.equal(pick({ usedPorts: [10000], routes: [web(10000, "http://127.0.0.1:3000")] }), 10001);
  assert.equal(pick({ previewPorts: new Set([10000]) }), 10001);
  assert.equal(pick({ record: record(10002) }), 10002);
  assert.equal(pick({ record: record(10002, "http://127.0.0.1:47000"), routes: [web(10002, "http://127.0.0.1:47000")], usedPorts: [10002], recordTargetAlive: false }), 10002);
  assert.equal(pick({ usedPorts: candidates }), null);
});

test("ownHttpsRoutes: only routes to the live daemon or our recorded one", () => {
  const routes = [web(10000, "http://127.0.0.1:47831"), web(10001, "http://127.0.0.1:3000"), web(10002, "http://127.0.0.1:47000")];
  assert.deepEqual(ownHttpsRoutes({ live: LIVE, record: null, routes }), [10000]);
  assert.deepEqual(ownHttpsRoutes({ live: LIVE, record: { enabled: true, port: 10002, target: OLD }, routes }), [10000, 10002]);
  assert.deepEqual(ownHttpsRoutes({ live: null, record: { enabled: true, port: 10001, target: OLD }, routes }), []);
});

test("decidePreview: kept while listening, removed after two silent checks, forgotten when no longer ours", () => {
  const share = { port: 5173, target: target("http://127.0.0.1:5173") };
  const routes = [web(5173, "http://127.0.0.1:5173")];
  assert.deepEqual(decidePreview({ ...share, routes, listening: true, misses: 1 }), { kind: "keep" });
  assert.deepEqual(decidePreview({ ...share, routes, listening: false, misses: 0 }), { kind: "miss", misses: 1 });
  assert.deepEqual(decidePreview({ ...share, routes, listening: false, misses: 1 }), { kind: "remove" });
  assert.deepEqual(decidePreview({ ...share, routes: [], listening: true, misses: 0 }), { kind: "forget" });
  assert.deepEqual(decidePreview({ ...share, routes: [web(5173, "http://127.0.0.1:9999")], listening: true, misses: 0 }), { kind: "forget" });
});
