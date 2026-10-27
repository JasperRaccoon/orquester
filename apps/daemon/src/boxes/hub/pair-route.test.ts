// The pair route (`boxRoutes.pair`): outside the daemon's user auth, it answers a bring-your-own
// machine's pairing script for a live one-time code and the same refusal for anything else.

import assert from "node:assert/strict";
import test from "node:test";

import websocketPlugin from "@fastify/websocket";
import { boxRoutes } from "@orquester/api";
import Fastify from "fastify";

import { redactUrlTokens } from "../../devtools.ts";
import type { PairingScriptOutcome } from "../service/byo.ts";
import type { BoxHubServer } from "./hub.ts";
import { registerBoxHubRoutes, type BoxPairingScripts } from "./routes.ts";

async function app(t: test.TestContext, pairing?: BoxPairingScripts) {
  const server = Fastify({ logger: false });
  await server.register(websocketPlugin);
  // The pair route never touches the hub.
  registerBoxHubRoutes(server, {} as BoxHubServer, pairing ? { pairing } : {});
  t.after(() => server.close());
  return server;
}

test("a live code answers the script, uncached; the code and the client reach the pairing source", async (t) => {
  const seen: [string, string][] = [];
  const server = await app(t, {
    pairingScript: async (code, client): Promise<PairingScriptOutcome> => {
      seen.push([code, client]);
      return { ok: true, script: "#!/bin/sh\necho paired\n" };
    }
  });
  const code = "abcdefghijklmnopqrstuvwx";
  const res = await server.inject({ method: "GET", url: boxRoutes.pair(code), remoteAddress: "203.0.113.7" });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["content-type"], "text/x-shellscript");
  assert.equal(res.headers["cache-control"], "no-store");
  assert.equal(res.body, "#!/bin/sh\necho paired\n");
  assert.deepEqual(seen, [[code, "203.0.113.7"]]);
});

test("refusals: 404 for any dead code, 429 with Retry-After when throttled, 404 without pairing at all", async (t) => {
  const outcomes: PairingScriptOutcome[] = [
    { ok: false, status: 404, code: "PAIRING_NOT_FOUND", message: "This pairing command is not valid any more." },
    { ok: false, status: 429, code: "PAIRING_THROTTLED", message: "Too many failed pairing attempts.", retryAfterSeconds: 120 }
  ];
  const server = await app(t, { pairingScript: async () => outcomes.shift()! });
  const missing = await server.inject({ method: "GET", url: boxRoutes.pair("nope") });
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.json().code, "PAIRING_NOT_FOUND");
  const throttled = await server.inject({ method: "GET", url: boxRoutes.pair("nope") });
  assert.equal(throttled.statusCode, 429);
  assert.equal(throttled.headers["retry-after"], "120");

  const bare = await app(t);
  assert.equal((await bare.inject({ method: "GET", url: boxRoutes.pair("x".repeat(24)) })).statusCode, 404);
});

test("pairing URLs use the public route and redact the secret code from logs", () => {
  assert.equal(boxRoutes.pair("c0de"), "/api/boxes/pair/c0de");
  assert.equal(redactUrlTokens("/api/boxes/pair/AbC_123-xyz?x=1"), "/api/boxes/pair/[redacted]?x=1");
  assert.equal(redactUrlTokens("/api/boxes/agent/linux-x64"), "/api/boxes/agent/linux-x64");
});
