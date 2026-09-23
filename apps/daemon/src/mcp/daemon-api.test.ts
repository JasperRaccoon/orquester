import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { EventMessage } from "@orquester/api";
import { HostUnavailableError } from "../agent-chat/host-client.ts";
import { Broadcaster } from "../broadcaster.ts";
import { UploadTooLargeError } from "../upload-stream.ts";
import { uploadInlineAttachments } from "./attachments.ts";
import { InjectDaemonApi, type DaemonApi } from "./daemon-api.ts";
import { daemonError } from "./errors.ts";
import { FakeDaemonApi, busEvent } from "./testing.ts";

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

const chatApi = (agentChat: unknown) => new InjectDaemonApi({ app: Fastify(), authorization: undefined, agentChat: agentChat as never, broadcaster: new Broadcaster(), fsRoot: "/r", workspacesDir: "/r" });

test("a thrown upload is HOST_UNAVAILABLE, as a thrown daemon call is: the cause is logged, never returned, and the stream is released", async (t) => {
  const logged = t.mock.method(console, "error", () => {});
  // The host socket gone before a byte is read.
  const gone = chatApi({ uploadAttachment: async () => { throw new Error("connect ENOENT /var/lib/orquester/daemon/agent-host.sock"); }, attachmentPath: async () => null });
  const unread = Readable.from([Buffer.from("abc")]);
  const up = await gone.uploadAttachment("s1", { name: "a.txt" }, unread);
  assert.deepEqual(up, { status: 503, value: { code: "HOST_UNAVAILABLE", message: "The attachment upload failed." } });
  assert.equal(unread.destroyed, true);
  // A source stream destroyed mid-upload fails the service's read the same way.
  const drains = chatApi({ uploadAttachment: async (_id: string, _q: unknown, body: Readable) => { for await (const chunk of body) void chunk; return { status: 200, value: null }; }, attachmentPath: async () => null });
  const broken = new Readable({ read() { this.destroy(new Error("EIO: i/o error, read /home/x/secret.log")); } });
  assert.deepEqual(await drains.uploadAttachment("s1", { name: "b.log" }, broken), { status: 503, value: { code: "HOST_UNAVAILABLE", message: "The attachment upload failed." } });
  assert.equal(logged.mock.callCount(), 2);
  assert.deepEqual(logged.mock.calls.map((c) => [c.arguments[0], String(c.arguments[1])]), [["[mcp] attachment upload failed", "Error: connect ENOENT /var/lib/orquester/daemon/agent-host.sock"], ["[mcp] attachment upload failed", "Error: EIO: i/o error, read /home/x/secret.log"]]);
  // Past the daemon's cap the route answers 413 UPLOAD_TOO_LARGE, and so does the seam.
  const capped = chatApi({ uploadAttachment: async () => { throw new UploadTooLargeError(); }, attachmentPath: async () => null });
  assert.deepEqual(await capped.uploadAttachment("s1", { name: "c.bin" }, Readable.from([])), { status: 413, value: { code: "UPLOAD_TOO_LARGE", message: new UploadTooLargeError().message } });
  assert.equal(logged.mock.callCount(), 2, "a size refusal is an answer, not a failure to log");
  // At the tool level that is a HOST_UNAVAILABLE naming the file, never an INTERNAL.
  await assert.rejects(uploadInlineAttachments(gone, "s1", [{ name: "a.txt", base64: "YQ==" }]),
    (e: { code: string; message: string }) => e.code === "HOST_UNAVAILABLE" && e.message === "attachments[0]: The attachment upload failed.");
});

test("a cap refusal wrapped as another error's cause is still 413 UPLOAD_TOO_LARGE, with the refusal's own message", async (t) => {
  const logged = t.mock.method(console, "error", () => {});
  const standard = { status: 413, value: { code: "UPLOAD_TOO_LARGE", message: new UploadTooLargeError().message } };
  // How the host client reports a body that failed (host-client.ts `fail()`), and an ES2022 wrapper: the message is the wrapper's.
  for (const wrapped of [new HostUnavailableError("socket hang up", new UploadTooLargeError()), new Error("the upload stream failed", { cause: new UploadTooLargeError() })]) {
    const body = Readable.from([Buffer.from("abc")]);
    const up = await chatApi({ uploadAttachment: async () => { throw wrapped; }, attachmentPath: async () => null }).uploadAttachment("s1", { name: "big.bin" }, body);
    assert.deepEqual(up, standard, wrapped.message);
    assert.equal(body.destroyed, true, `${wrapped.message}: the stream is released`);
  }
  assert.equal(logged.mock.callCount(), 0, "a size refusal is an answer, not a failure to log");
  // Any other cause is still the host's failure.
  const eio = await chatApi({ uploadAttachment: async () => { throw new HostUnavailableError("EIO", new Error("EIO: i/o error, read")); }, attachmentPath: async () => null }).uploadAttachment("s1", { name: "b.log" }, Readable.from([]));
  assert.deepEqual(eio, { status: 503, value: { code: "HOST_UNAVAILABLE", message: "The attachment upload failed." } });
});

test("request appends opts.query to a path that already carries a query string", async () => {
  const app = Fastify();
  app.get("/api/echo", async (req) => ({ q: req.query }));
  const api = new InjectDaemonApi({ app, authorization: undefined, agentChat: null, broadcaster: new Broadcaster(), fsRoot: "/r", workspacesDir: "/r" });
  assert.deepEqual(await api.request("GET", "/api/echo?a=1", { query: { b: "2 3", c: "&" } }), { status: 200, body: { q: { a: "1", b: "2 3", c: "&" } } });
  assert.deepEqual(await api.request("GET", "/api/echo?a=1"), { status: 200, body: { q: { a: "1" } } });
  await app.close();
});

test("the 503 upload answer (no agent chat service) releases the stream it will never read", async () => {
  const body = Readable.from([Buffer.from("abc")]);
  const up = await chatApi(null).uploadAttachment("s1", { name: "a.txt" }, body);
  assert.equal(up.status, 503);
  assert.equal(body.destroyed, true);
});

test("a path attachment the seam refuses, or that fails mid-read, leaves no file open", { skip: !existsSync("/proc/self/fd") && "needs /proc/self/fd" }, async (t) => {
  t.mock.method(console, "error", () => {});
  const root = await mkdtemp(join(tmpdir(), "mcp-api-")); t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "big.log"), Buffer.alloc(1024 * 1024)); await writeFile(join(root, "small.txt"), "hi");
  const openFds = async () => (await readdir("/proc/self/fd")).length;
  // Reads one chunk of a stream that has many more, then fails: the source is left mid-read.
  const hangsUp = { uploadAttachment: async (_id: string, _q: unknown, body: Readable) => { for await (const chunk of body) { void chunk; throw new Error("socket hang up"); } return { status: 200, value: null }; }, attachmentPath: async () => null };
  const baseline = await openFds();
  for (const agentChat of [null, hangsUp]) {
    const api = new InjectDaemonApi({ app: Fastify(), authorization: undefined, agentChat: agentChat as never, broadcaster: new Broadcaster(), fsRoot: root, workspacesDir: root });
    await assert.rejects(uploadInlineAttachments(api, "s1", [{ path: "big.log" }, { path: "small.txt" }]), (e: { code: string; message: string }) => e.code === "HOST_UNAVAILABLE" && /^attachments\[0\]: /.test(e.message));
    assert.equal(await openFds(), baseline, agentChat ? "after a failure mid-read" : "after the 503 answer");
  }
});

test("a Fastify-shaped 4xx without a code keeps its message: the reason, not the status text", async () => {
  const app = Fastify();
  app.get("/api/bad", async () => { throw Object.assign(new Error("workspace name is invalid"), { statusCode: 400 }); });
  const api = new InjectDaemonApi({ app, authorization: undefined, agentChat: null, broadcaster: new Broadcaster(), fsRoot: "/r", workspacesDir: "/r" });
  const bad = await api.request("GET", "/api/bad");
  assert.deepEqual(bad, { status: 400, body: { statusCode: 400, error: "Bad Request", message: "workspace name is invalid" } }, "the shape Fastify really sends");
  const invalid = daemonError(bad);
  assert.equal(invalid.code, "INVALID_ARGUMENT"); assert.equal(invalid.message, "workspace name is invalid");
  // Fastify's own 404 (a daemon without the web client's not-found handler) is the same shape.
  const missing = daemonError(await api.request("GET", "/api/nope"));
  assert.equal(missing.code, "NOT_FOUND"); assert.equal(missing.message, "Route GET:/api/nope not found");
  await app.close();
});

/** The production seam over a real Broadcaster, and the fake: one bus scenario must read the same on both. */
function seams(): [string, DaemonApi, (type: string) => void][] {
  const broadcaster = new Broadcaster();
  const fake = new FakeDaemonApi();
  return [
    ["InjectDaemonApi", new InjectDaemonApi({ app: Fastify(), authorization: undefined, agentChat: null, broadcaster, fsRoot: "/r", workspacesDir: "/r" }), (type) => broadcaster.publish("sessions", type, { id: "s1" })],
    ["FakeDaemonApi", fake, (type) => fake.emit(busEvent(type, { id: "s1" }))]
  ];
}

test("listener never throws: on the production seam and on the fake, a throwing listener is swallowed, stays subscribed and never keeps the event from the rest", () => {
  for (const [label, api, publish] of seams()) {
    const seen: string[] = [];
    api.subscribe((e) => { seen.push(`thrower:${e.type}`); throw new Error("listener bug"); });
    api.subscribe((e) => { seen.push(`next:${e.type}`); });
    assert.doesNotThrow(() => publish("session.updated"), label);
    publish("session.closed");
    assert.deepEqual(seen, ["thrower:session.updated", "next:session.updated", "thrower:session.closed", "next:session.closed"], label);
  }
});

test("the fake delivers as the Broadcaster does: over the live subscriber set, in order, once per subscribe call", () => {
  for (const [label, api, publish] of seams()) {
    const seen: string[] = [];
    const record = (name: string) => (e: EventMessage) => { seen.push(`${name}:${e.type}`); };
    let offLate = () => {};
    // Mid-delivery, the first listener drops one not yet reached and adds another: the first is skipped, the second reached.
    api.subscribe((e) => { record("first")(e); if (e.type === "session.updated") { offLate(); api.subscribe(record("joined")); } });
    offLate = api.subscribe(record("late"));
    const twice = record("twice");
    const offOne = api.subscribe(twice); api.subscribe(twice);
    publish("session.updated");
    offOne();
    publish("session.closed");
    assert.deepEqual(seen, ["first:session.updated", "twice:session.updated", "twice:session.updated", "joined:session.updated", "first:session.closed", "twice:session.closed", "joined:session.closed"], label);
  }
});
