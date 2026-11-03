/**
 * The account-lend routes enforce ownership with the request's server-stamped principal: an agent
 * reaches its chat's project box and its own temporary boxes, and ends only its own lends; a person
 * reaches every box but starts no lend; an external MCP client reaches none.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { accountLendRoutes } from "@orquester/api";
import type { CallerPrincipal } from "@orquester/api/agent-chat";
import Fastify from "fastify";

import { storedBox } from "../broker/testing.ts";
import { registerAccountLendRoutes } from "./routes.ts";
import { BOX, chat, HOUR, lendWorld, NOW, type LendWorld } from "./testing.ts";

const CLAUDE = "11111111-1111-4111-8111-111111111111";
const LEND = { accounts: [{ agent: "claude", accountId: CLAUDE }], minutes: 240, purposeNote: "paid evals" };

async function app(t: Parameters<typeof lendWorld>[0], w: LendWorld) {
  const server = Fastify();
  server.addHook("onRequest", async (request) => {
    const principal = request.headers["x-test-principal"];
    if (typeof principal === "string") (request as unknown as { principal: CallerPrincipal }).principal = JSON.parse(principal) as CallerPrincipal;
  });
  registerAccountLendRoutes(server, () => w.lends);
  await server.ready();
  t.after(() => server.close());
  return server;
}

const as = (principal: CallerPrincipal) => ({ "x-test-principal": JSON.stringify(principal) });
const OUTSIDER = chat("outsider", "/ws/other/project");
const EXTERNAL: CallerPrincipal = { kind: "external" };

test("a chat in the box's project lends, sees and returns its own; other callers reach what the rule says", async (t) => {
  const w = await lendWorld(t);
  w.addAccount("claude", CLAUDE, "ana@example.com", NOW + 8 * HOUR);
  const server = await app(t, w);
  const box = accountLendRoutes.box(BOX);

  // The card's preview, then the approved lend.
  const preview = await server.inject({ method: "POST", url: accountLendRoutes.preview(BOX), headers: as(chat("chat-1")), payload: { claude: ["ana"] } });
  assert.equal(preview.statusCode, 200);
  assert.equal(preview.json().accounts[0].accountId, CLAUDE);
  const lent = await server.inject({ method: "POST", url: box, headers: as(chat("chat-1")), payload: LEND });
  assert.equal(lent.statusCode, 200);
  const lendId: string = lent.json().lent[0].id;
  assert.ok(!lent.body.includes(`${CLAUDE}-access`), "no route returns a token");

  // A chat of another project: the box reads as not found, everywhere.
  for (const [method, url] of [["POST", accountLendRoutes.preview(BOX)], ["POST", box], ["DELETE", box], ["DELETE", accountLendRoutes.lend(BOX, lendId)]] as const) {
    const refused = await server.inject({ method, url, headers: as(OUTSIDER), ...(method === "POST" ? { payload: LEND } : {}) });
    assert.equal(refused.statusCode, 404, `${method} ${url}`);
    assert.equal(refused.json().code, "BOX_NOT_FOUND");
  }
  // An external client reaches nothing; a person starts no lend.
  assert.equal((await server.inject({ method: "GET", url: accountLendRoutes.all, headers: as(EXTERNAL) })).statusCode, 403);
  assert.equal((await server.inject({ method: "DELETE", url: box, headers: as(EXTERNAL) })).statusCode, 403);
  assert.equal((await server.inject({ method: "POST", url: box, payload: LEND })).statusCode, 403);

  // A second chat of the project shares the box, not the first one's lend.
  const other = chat("chat-2");
  assert.equal((await server.inject({ method: "DELETE", url: accountLendRoutes.lend(BOX, lendId), headers: as(other) })).statusCode, 404);
  await server.inject({ method: "DELETE", url: box, headers: as(other) });
  assert.deepEqual((await server.inject({ method: "GET", url: accountLendRoutes.all, headers: as(other) })).json().lends, []);
  const own = (await server.inject({ method: "GET", url: accountLendRoutes.all, headers: as(chat("chat-1")) })).json().lends;
  assert.deepEqual(own.map((lend: { id: string; boxId: string }) => [lend.id, lend.boxId]), [[lendId, BOX]]);
  assert.equal((await server.inject({ method: "GET", url: accountLendRoutes.all })).json().lends.length, 1, "a person sees every lend");

  // A person's `threadId` limits an end to one chat.
  const scoped = await server.inject({ method: "DELETE", url: `${box}?threadId=chat-2` });
  assert.equal(scoped.json().lends.length, 1);
  const ended = await server.inject({ method: "DELETE", url: accountLendRoutes.lend(BOX, lendId), headers: as(chat("chat-1")) });
  assert.equal(ended.statusCode, 200);
  assert.deepEqual(ended.json().lends, []);
  assert.equal(await w.readVm(w.vmPath("claude", CLAUDE)), null);
  assert.equal((await server.inject({ method: "DELETE", url: accountLendRoutes.lend(BOX, lendId) })).statusCode, 404);
});

test("a temporary box is its own chat's alone; a person ends any lend on it", async (t) => {
  const w = await lendWorld(t, { purpose: "temporary", project: null, threadId: "owner" });
  w.addAccount("claude", CLAUDE, "ana@example.com", NOW + 8 * HOUR);
  await w.store.insert(storedBox({ id: "box-2", purpose: "temporary", project: null, threadId: "someone-else" }));
  const server = await app(t, w);
  const box = accountLendRoutes.box(BOX);

  assert.equal((await server.inject({ method: "POST", url: box, headers: as(chat("not-the-owner", "")), payload: LEND })).statusCode, 404);
  const lent = await server.inject({ method: "POST", url: box, headers: as(chat("owner", "")), payload: LEND });
  assert.equal(lent.statusCode, 200);
  assert.equal((await server.inject({ method: "POST", url: accountLendRoutes.box("box-2"), headers: as(chat("owner", "")), payload: LEND })).statusCode, 404);

  const ended = await server.inject({ method: "DELETE", url: accountLendRoutes.lend(BOX, lent.json().lent[0].id) });
  assert.equal(ended.statusCode, 200);
  assert.equal(await w.readVm(w.vmPath("claude", CLAUDE)), null);
});

test("until the service exists the routes say so", async (t) => {
  const server = Fastify();
  registerAccountLendRoutes(server, () => null);
  await server.ready();
  t.after(() => server.close());
  const response = await server.inject({ method: "GET", url: accountLendRoutes.all });
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().code, "BOXES_DISABLED");
});
