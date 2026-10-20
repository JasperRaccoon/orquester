/**
 * The temporary-box routes enforce ownership with the request's server-stamped principal: an agent
 * reaches only its chat's boxes (another's is 404), creates only for itself, and a person (no
 * principal) reaches every temporary box but creates none.
 */

import assert from "node:assert/strict";
import test from "node:test";

import Fastify from "fastify";
import { temporaryBoxRoutes } from "@orquester/api";
import type { CallerPrincipal } from "@orquester/api/agent-chat";

import { registerTemporaryBoxRoutes } from "./routes.ts";
import { boxSummary, FakeTemporaryBoxes } from "./testing.ts";
import { TemporaryBoxTools } from "./tools.ts";

/** Stands in for the principal hook: the test header names an agent chat (the daemon's nonce never travels in a test). */
async function app() {
  const boxes = new FakeTemporaryBoxes().add(boxSummary({ id: "box-a", threadId: "chat-a" })).add(boxSummary({ id: "box-b", threadId: "chat-b" }));
  const tools = new TemporaryBoxTools({ isChatOpen: () => true });
  tools.connect({ boxes, hub: { get: () => undefined } });
  const server = Fastify();
  server.addHook("onRequest", async (request) => {
    const chat = request.headers["x-test-chat"];
    if (typeof chat === "string") {
      (request as unknown as { principal: CallerPrincipal }).principal = { kind: "agent", threadId: chat, projectPath: "/w/acme/game" };
    }
  });
  registerTemporaryBoxRoutes(server, tools);
  await server.ready();
  return { server, boxes };
}

const as = (chat: string) => ({ "x-test-chat": chat });

test("routes: list, get and delete reach only the calling chat's boxes; a person reaches all", async (t) => {
  const { server, boxes } = await app();
  t.after(() => server.close());
  const listed = await server.inject({ method: "GET", url: temporaryBoxRoutes.list, headers: as("chat-a") });
  assert.equal(listed.statusCode, 200);
  assert.deepEqual(listed.json().boxes.map((box: { id: string }) => box.id), ["box-a"]);
  const person = await server.inject({ method: "GET", url: `${temporaryBoxRoutes.list}?threadId=chat-b` });
  assert.deepEqual(person.json().boxes.map((box: { id: string }) => box.id), ["box-b"]);

  const foreign = await server.inject({ method: "GET", url: temporaryBoxRoutes.box("box-b"), headers: as("chat-a") });
  assert.equal(foreign.statusCode, 404);
  assert.equal(foreign.json().code, "BOX_NOT_FOUND");
  const own = await server.inject({ method: "GET", url: temporaryBoxRoutes.box("box-a"), headers: as("chat-a") });
  assert.equal(own.json().box.id, "box-a");

  const foreignDelete = await server.inject({ method: "DELETE", url: temporaryBoxRoutes.box("box-b"), headers: as("chat-a") });
  assert.equal(foreignDelete.statusCode, 404);
  assert.equal(boxes.destroyed.length, 0);
  const badReason = await server.inject({ method: "DELETE", url: `${temporaryBoxRoutes.box("box-a")}?reason=chat-closed`, headers: as("chat-a") });
  assert.equal(badReason.statusCode, 400);
  const deleted = await server.inject({ method: "DELETE", url: `${temporaryBoxRoutes.box("box-a")}?reason=provisioning-failed`, headers: as("chat-a") });
  assert.equal(deleted.statusCode, 200);
  assert.equal(deleted.json().box.state, "destroyed");
  assert.deepEqual(boxes.destroyed, [{ boxId: "box-a", reason: "provisioning-failed" }]);
  const byPerson = await server.inject({ method: "DELETE", url: temporaryBoxRoutes.box("box-b") });
  assert.equal(byPerson.statusCode, 200);
});

test("routes: create is for agent chats only, and the box belongs to the calling chat", async (t) => {
  const { server, boxes } = await app();
  t.after(() => server.close());
  const payload = { kind: "linux", provider: "hetzner", size: "cx22", region: "fsn1", lifetimeMinutes: 120, purposeNote: "build" };
  const byPerson = await server.inject({ method: "POST", url: temporaryBoxRoutes.list, payload });
  assert.equal(byPerson.statusCode, 403);
  const created = await server.inject({ method: "POST", url: temporaryBoxRoutes.list, payload: { ...payload, threadId: "chat-b" }, headers: as("chat-a") });
  assert.equal(created.statusCode, 200);
  assert.equal(created.json().box.threadId, "chat-a", "a body cannot name another chat");
  assert.equal(boxes.created[0]!.threadId, "chat-a");
  const invalid = await server.inject({ method: "POST", url: temporaryBoxRoutes.list, payload: { ...payload, kind: "beos" }, headers: as("chat-a") });
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.json().code, "BOX_INVALID_REQUEST");
});
