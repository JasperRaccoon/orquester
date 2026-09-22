import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { Readable } from "node:stream";
import { Broadcaster } from "../broadcaster.ts";
import { InjectDaemonApi } from "./daemon-api.ts";

test("request runs the app's own route with the caller's bearer and parses JSON", async () => {
  const app = Fastify();
  app.get("/api/echo", async (req) => ({ auth: req.headers.authorization ?? null, q: (req.query as { a?: string }).a ?? null }));
  app.post("/api/echo", async (req, reply) => reply.code(201).send({ got: req.body }));
  const api = new InjectDaemonApi({ app, authorization: "Bearer abc", agentChat: null, broadcaster: new Broadcaster(), fsRoot: "/r", workspacesDir: "/r" });
  assert.deepEqual(await api.request("GET", "/api/echo", { query: { a: "1" } }), { status: 200, body: { auth: "Bearer abc", q: "1" } });
  assert.deepEqual(await api.request("POST", "/api/echo", { body: { x: 1 } }), { status: 201, body: { got: { x: 1 } } });
  await app.close();
});

test("request returns a non-JSON body as text and a 404 for unknown routes", async () => {
  const app = Fastify();
  app.get("/txt", async (_r, reply) => reply.type("text/plain").send("plain"));
  const api = new InjectDaemonApi({ app, authorization: undefined, agentChat: null, broadcaster: new Broadcaster(), fsRoot: "/r", workspacesDir: "/r" });
  assert.deepEqual(await api.request("GET", "/txt"), { status: 200, body: "plain" });
  assert.equal((await api.request("GET", "/nope")).status, 404);
  await app.close();
});

test("subscribe receives every published EventMessage and unsubscribes cleanly", async () => {
  const broadcaster = new Broadcaster();
  const api = new InjectDaemonApi({ app: Fastify(), authorization: undefined, agentChat: null, broadcaster, fsRoot: "/r", workspacesDir: "/r" });
  const seen: string[] = [];
  const off = api.subscribe((e) => seen.push(e.type));
  broadcaster.publish("sessions", "session.updated", { id: "s1" });
  off();
  broadcaster.publish("sessions", "session.updated", { id: "s2" });
  assert.deepEqual(seen, ["session.updated"]);
});

test("uploadAttachment and attachmentPath delegate to the agent chat service", async () => {
  const calls: unknown[] = [];
  const agentChat = {
    uploadAttachment: async (id: string, q: { name?: string; type?: string }, body: Readable) => {
      const chunks: Buffer[] = []; for await (const c of body) chunks.push(Buffer.from(c));
      calls.push([id, q, Buffer.concat(chunks).toString()]);
      return { status: 200, value: { type: "file", id: "a1", name: q.name, sizeBytes: 3 } };
    },
    attachmentPath: async (id: string, a: string) => `/threads/${id}/attachments/${a}`
  };
  const api = new InjectDaemonApi({ app: Fastify(), authorization: undefined, agentChat: agentChat as never, broadcaster: new Broadcaster(), fsRoot: "/r", workspacesDir: "/r" });
  const up = await api.uploadAttachment("s1", { name: "a.txt", type: "text/plain" }, Readable.from([Buffer.from("abc")]));
  assert.equal(up.status, 200); assert.deepEqual(calls[0], ["s1", { name: "a.txt", type: "text/plain" }, "abc"]);
  assert.equal(await api.attachmentPath("s1", "a1"), "/threads/s1/attachments/a1");
});

test("without an agent chat service uploads answer 503 HOST_UNAVAILABLE", async () => {
  const api = new InjectDaemonApi({ app: Fastify(), authorization: undefined, agentChat: null, broadcaster: new Broadcaster(), fsRoot: "/r", workspacesDir: "/r" });
  const up = await api.uploadAttachment("s1", { name: "a" }, Readable.from([]));
  assert.equal(up.status, 503);
  assert.equal(await api.attachmentPath("s1", "x"), null);
});
