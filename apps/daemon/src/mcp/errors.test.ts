import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { Broadcaster } from "../broadcaster.ts";
import { InjectDaemonApi } from "./daemon-api.ts";
import { ToolError, daemonError, expectOk } from "./errors.ts";

test("daemonError reads the chat envelope, the flat shape and a bare string", () => {
  const a = daemonError({ status: 409, body: { error: { code: "COMMAND_REJECTED", message: "busy", detail: { x: 1 } } } });
  assert.equal(a.code, "COMMAND_REJECTED"); assert.equal(a.message, "busy"); assert.deepEqual(a.detail, { x: 1 });
  const b = daemonError({ status: 400, body: { code: "RESUME_UNAVAILABLE", message: "bad id" } });
  assert.equal(b.code, "RESUME_UNAVAILABLE"); assert.equal(b.message, "bad id");
  const c = daemonError({ status: 400, body: { error: "model is only valid for claudex/claudemix", entryId: "codex" } });
  assert.equal(c.code, "INVALID_ARGUMENT"); assert.equal(c.message, "model is only valid for claudex/claudemix");
  const d = daemonError({ status: 404, body: "not json" });
  assert.equal(d.code, "NOT_FOUND"); assert.match(d.message, /404/);
  const e = daemonError({ status: 503, body: null });
  assert.equal(e.code, "HOST_UNAVAILABLE");
});

test("a 5xx without a deliberate code never echoes the body (spec §4.5)", () => {
  const crash = daemonError({ status: 500, body: { statusCode: 500, error: "Internal Server Error", message: "ENOENT: /home/x/secret" } });
  assert.equal(crash.code, "INTERNAL"); assert.ok(!crash.message.includes("/home"));
  // Fastify also serialises an errno's own `code` — that is not a daemon code.
  const errno = daemonError({ status: 500, body: { statusCode: 500, code: "ENOENT", error: "Internal Server Error", message: "ENOENT: no such file or directory, open '/home/x/secret'" } });
  assert.equal(errno.code, "INTERNAL"); assert.ok(!errno.message.includes("/home"));
  const gateway = daemonError({ status: 502, body: { error: "upstream said /home/x/secret" } });
  assert.equal(gateway.code, "HOST_UNAVAILABLE"); assert.ok(!gateway.message.includes("/home"));
  assert.equal(daemonError({ status: 503, body: "Service Unavailable" }).code, "HOST_UNAVAILABLE");
  // A caller's fallback still replaces the status-derived error, and still never echoes the body.
  const upload = daemonError({ status: 500, body: { message: "EACCES /home/x/secret" } }, { code: "HOST_UNAVAILABLE", message: "Attachment upload failed." });
  assert.equal(upload.code, "HOST_UNAVAILABLE"); assert.equal(upload.message, "Attachment upload failed.");
  // A route's own 5xx code is deliberate and passes through.
  const own = daemonError({ status: 500, body: { code: "CONFIG_UNREADABLE", message: "daemon.json is unreadable; refusing to overwrite it." } });
  assert.equal(own.code, "CONFIG_UNREADABLE"); assert.match(own.message, /daemon\.json/);
});

test("a real Fastify crash, errno code and all, maps to INTERNAL without its path", async () => {
  const app = Fastify();
  app.get("/crash", async () => { throw Object.assign(new Error("ENOENT: no such file or directory, open '/home/x/secret'"), { code: "ENOENT" }); });
  const api = new InjectDaemonApi({ app, authorization: undefined, agentChat: null, broadcaster: new Broadcaster(), fsRoot: "/r", workspacesDir: "/r" });
  const err = daemonError(await api.request("GET", "/crash"));
  assert.equal(err.code, "INTERNAL"); assert.ok(!err.message.includes("/home"));
  await app.close();
});

test("a 4xx whose body names nothing falls back to the status table and never echoes the body", () => {
  const unknown = daemonError({ status: 405, body: "<html>/home/x/secret</html>" });
  assert.equal(unknown.code, "INVALID_ARGUMENT"); assert.ok(!unknown.message.includes("/home"));
  assert.equal(daemonError({ status: 429, body: null }).code, "TOO_MANY_ATTEMPTS");
});

test("expectOk returns the body below 400 and throws above", () => {
  assert.deepEqual(expectOk({ status: 200, body: { seq: 3 } }, "turn"), { seq: 3 });
  assert.throws(() => expectOk({ status: 404, body: { error: { code: "THREAD_NOT_FOUND", message: "no" } } }, "thread"),
    (err: unknown) => err instanceof ToolError && err.code === "THREAD_NOT_FOUND");
});
