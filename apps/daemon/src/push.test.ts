/**
 * Agent pushes (unified MCP design 2026-10-15 §4.1, §5.6, §7.5): `notify_user`'s payload and rate limits (a fake clock),
 * the approval-card push, and `POST /api/push/notify` keyed on the request's principal — never on its body.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import webpush from "web-push";
import type { SessionSummary } from "@orquester/api";
import type { CallerPrincipal } from "@orquester/api/agent-chat";
import { Broadcaster } from "./broadcaster.ts";
import { InjectDaemonApi, withPrincipal } from "./mcp/daemon-api.ts";
import { chatSummary } from "./mcp/fixtures.ts";
import { registerPrincipalHook } from "./mcp/principal.ts";
import { AGENT_PUSH_CREDENTIAL_INTERVAL_MS, AGENT_PUSH_THREAD_INTERVAL_MS, PushService, pushRateKey, registerPushNotifyRoute } from "./push.ts";

/** A PushService over a temp push.json with one subscription, a fake clock, and every payload it sends. */
async function rig(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "orq-push-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const sent: Record<string, unknown>[] = [];
  t.mock.method(webpush, "sendNotification", async (_sub: unknown, payload: string) => {
    sent.push(JSON.parse(payload) as Record<string, unknown>);
    return { statusCode: 201, body: "", headers: {} };
  });
  const clock = { now: Date.parse("2026-10-15T12:00:00.000Z") };
  const errors: unknown[] = [];
  const push = new PushService(join(dir, "push.json"), { error: (...args: unknown[]) => errors.push(args) }, { now: () => clock.now });
  await push.subscribe({ endpoint: "https://push.example.com/device-1", keys: { p256dh: "p", auth: "a" } });
  return { push, sent, clock, errors };
}

const thread = (threadId: string) => pushRateKey({ kind: "agent", threadId, projectPath: "/w/acme/api" });

test("notify_user's push: flattened, capped text, deep-linked to the chat, and never an action button", async (t) => {
  const { push, sent } = await rig(t);
  const r = await push.notifyAgent({ title: "Build\nfinished ‮evil\u0007", body: "All 412 tests pass.\nReady for review.", sessionId: "c1" }, thread("c1"));
  assert.deepEqual(r, { ok: true, sent: 1 });
  assert.deepEqual(sent, [{ title: "Build finished evil", body: "All 412 tests pass.\nReady for review.", tag: "session-c1", sessionId: "c1" }]);
  assert.equal("actions" in sent[0]!, false);
  // An external client's push names no chat: a generic tag, no deep link.
  await push.notifyAgent({ title: "x".repeat(500) }, null);
  assert.deepEqual({ ...sent[1], title: (sent[1]!.title as string).length }, { title: 120, body: "", tag: "orquester-agent", sessionId: "" });
});

test("rate limits: one push per chat per 5 minutes, one per external credential per minute, none for a person; every accepted call takes its slot", async (t) => {
  const { push, sent, clock } = await rig(t);
  assert.equal((await push.notifyAgent({ title: "a" }, thread("c1"))).ok, true);
  const refused = await push.notifyAgent({ title: "b" }, thread("c1"));
  assert.deepEqual(refused, { ok: false, retryAfterMs: AGENT_PUSH_THREAD_INTERVAL_MS });
  assert.equal((await push.notifyAgent({ title: "other chat" }, thread("c2"))).ok, true, "chats are limited separately");
  clock.now += AGENT_PUSH_THREAD_INTERVAL_MS - 1;
  assert.deepEqual(await push.notifyAgent({ title: "c" }, thread("c1")), { ok: false, retryAfterMs: 1 });
  clock.now += 1;
  assert.equal((await push.notifyAgent({ title: "d" }, thread("c1"))).ok, true);

  const credential = pushRateKey({ kind: "external", credentialId: "cred_1" });
  assert.deepEqual(credential, { key: "credential:cred_1", intervalMs: AGENT_PUSH_CREDENTIAL_INTERVAL_MS });
  assert.equal((await push.notifyAgent({ title: "e" }, credential)).ok, true);
  assert.equal((await push.notifyAgent({ title: "f" }, credential)).ok, false);
  clock.now += AGENT_PUSH_CREDENTIAL_INTERVAL_MS;
  assert.equal((await push.notifyAgent({ title: "g" }, credential)).ok, true);

  assert.equal(pushRateKey({ kind: "user" }), null);
  for (const title of ["h", "i", "j"]) assert.equal((await push.notifyAgent({ title }, null)).ok, true, "a person's own pushes are not limited");
  assert.deepEqual(sent.map((p) => p.title), ["a", "other chat", "d", "e", "g", "h", "i", "j"]);
});

test("a rate-limited slot is taken even when nobody is subscribed, so the limit cannot be probed around", async (t) => {
  const { push, sent } = await rig(t);
  await push.unsubscribe("https://push.example.com/device-1");
  assert.deepEqual(await push.notifyAgent({ title: "a" }, thread("c1")), { ok: true, sent: 0 });
  assert.equal((await push.notifyAgent({ title: "b" }, thread("c1"))).ok, false);
  assert.deepEqual(sent, []);
});

test("an approval card pushes \"Approval needed: <title>\" for its chat, with no action button, debounced per chat", async (t) => {
  const { push, sent, clock } = await rig(t);
  const session = chatSummary({ id: "c7", title: "Implement auth", projectPath: "/w/acme/api" }) as SessionSummary;
  await push.notifyApprovalNeeded(session, "Claude wants to create the workflow \"Nightly\"");
  assert.deepEqual(sent, [{ title: "Approval needed: Claude wants to create the workflow \"Nightly\"", body: "Implement auth in api", tag: "session-c7", sessionId: "c7" }]);
  await push.notifyApprovalNeeded(session, "Another card");
  assert.equal(sent.length, 1, "a second card within the debounce window does not push again");
  clock.now += 30_000;
  await push.notifyApprovalNeeded(session, "x".repeat(400));
  assert.equal((sent[1]!.title as string).length, 120);
  assert.ok(sent.every((payload) => !("actions" in payload)));
});

test("POST /api/push/notify: validated body, the agent's push always deep-links to its own chat, 429 RATE_LIMITED past the limit", async (t) => {
  const { push, sent } = await rig(t);
  const app = Fastify();
  t.after(() => app.close());
  registerPrincipalHook(app);
  registerPushNotifyRoute(app, push);
  const api = new InjectDaemonApi({ app, authorization: undefined, agentChat: null, broadcaster: new Broadcaster(), fsRoot: "/w", workspacesDir: "/w" });
  const agent: CallerPrincipal = { kind: "agent", threadId: "c1", projectPath: "/w/acme/api" };
  const asAgent = withPrincipal(api, agent);

  for (const body of [{}, { title: "  " }, { title: "x".repeat(121) }, { title: "ok", body: "y".repeat(301) }, { title: "ok", body: 7 }, { title: "ok", sessionId: 7 }]) {
    const res = await asAgent.request("POST", "/api/push/notify", { body });
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal((res.body as { code: string }).code, "INVALID_ARGUMENT");
  }
  // A title with nothing visible once flattened is refused like an empty one.
  assert.equal((await asAgent.request("POST", "/api/push/notify", { body: { title: "\u202e\u200b\u0007" } })).status, 400);
  // A refused body takes no slot.
  const first = await asAgent.request("POST", "/api/push/notify", { body: { title: "Done", body: "PR is up", sessionId: "someone-else" } });
  assert.deepEqual(first, { status: 200, body: { sent: 1 } });
  assert.deepEqual(sent[0], { title: "Done", body: "PR is up", tag: "session-c1", sessionId: "c1" });
  const again = await asAgent.request("POST", "/api/push/notify", { body: { title: "Again" } });
  assert.equal(again.status, 429);
  assert.deepEqual(again.body, { code: "RATE_LIMITED", message: "Too many notifications: try again in 300 s.", retryAfterSeconds: 300 });
  // The user (no principal token) is not limited and may name a chat to open.
  const user = await api.request("POST", "/api/push/notify", { body: { title: "From me", sessionId: "c9" } });
  assert.equal(user.status, 200);
  assert.deepEqual(sent.at(-1), { title: "From me", body: "", tag: "session-c9", sessionId: "c9" });
  // An external credential is limited per credential.
  const external = withPrincipal(api, { kind: "external", credentialId: "cred_x" });
  assert.equal((await external.request("POST", "/api/push/notify", { body: { title: "1" } })).status, 200);
  assert.equal((await external.request("POST", "/api/push/notify", { body: { title: "2" } })).status, 429);
});
