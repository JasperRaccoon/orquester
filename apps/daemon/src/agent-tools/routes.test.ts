/**
 * The approval-card and agent-tools routes as the daemon mounts them (`createServer`, both
 * transports, driven through `inject`): remote HTTP behind its bearer, the unix socket without one;
 * only a person writes (agent principals 403); no secret ever in a response, event or log line.
 */

import { strict as assert } from "node:assert";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import Fastify from "fastify";
import { createDefaultClientConfig, createDefaultDaemonConfig } from "@orquester/config";
import type { CallerPrincipal } from "@orquester/api/agent-chat";

import { createServer } from "../index.ts";
import { createAgentToolsRuntime, type AgentToolsRuntime } from "./approval-port.ts";
import { registerAgentToolsRuntimeRoutes } from "./routes.ts";

type CreateServerArgs = Parameters<typeof createServer>;
const USERNAME = "admin";
const PASSWORD_HASH = "$2a$12$0123456789012345678901uFAKEfakeFAKEfakeFAKEfa";
const BEARER = `Bearer ${Buffer.from(`${USERNAME}:${PASSWORD_HASH}`).toString("base64")}`;

async function runtime(t: TestContext) {
  const baseDir = await mkdtemp(join(tmpdir(), "orq-agent-tools-routes-"));
  const published: { channel: string; type: string; payload: unknown }[] = [];
  const logged: string[] = [];
  const rt = createAgentToolsRuntime({
    baseDir,
    publish: (channel, type, payload) => published.push({ channel, type, payload }),
    onApprovalsChanged: () => undefined,
    tab: (id) => (id === "t1" ? { projectPath: "/w/ws/p" } : undefined),
    agentOf: () => "claude",
    api: () => null,
    logger: { log: (line: unknown) => logged.push(String(line)), warn: () => undefined, error: () => undefined }
  });
  await rt.load();
  t.after(async () => {
    await rt.shutdown();
    await rm(baseDir, { recursive: true, force: true });
  });
  return { rt, published, logged };
}

function server(rt: AgentToolsRuntime, mode: "local" | "remote") {
  const config = createDefaultDaemonConfig({ env: {} });
  config.transports.http.username = USERNAME;
  config.transports.http.passwordHash = PASSWORD_HASH;
  const root = "/nonexistent-orquester-agent-tools-test";
  const resolved = { daemonDir: root, baseDir: root, workspacesDir: root, workspacesMetaFile: `${root}/workspaces.json`, fsRoot: root } as unknown as CreateServerArgs[1];
  return createServer(
    config,
    resolved,
    createDefaultClientConfig(`${root}/daemon.sock`),
    createWriteStream("/dev/null"),
    {
      agentToolsRuntime: rt,
      agentChat: { authorizeHostRequest: () => false, sessionToolThread: () => null, routeDeps: () => undefined, protectedPids: () => [] }
    } as unknown as CreateServerArgs[4],
    { authRequired: mode === "remote", mode }
  );
}

const ROUTES = [
  { method: "GET", url: "/api/agent-tools" },
  { method: "DELETE", url: "/api/agent-tools/grants" },
  { method: "DELETE", url: "/api/agent-tools/grants/g1" },
  { method: "GET", url: "/api/sessions/t1/agent-tools" },
  { method: "GET", url: "/api/sessions/t1/tool-approvals" },
  { method: "GET", url: "/api/sessions/t1/tool-approvals/a1" },
  { method: "POST", url: "/api/sessions/t1/tool-approvals/a1", payload: { decision: "approve" } }
] as const;

test("remote HTTP: every route is behind the bearer; with it they answer", async (t) => {
  const { rt } = await runtime(t);
  const app = server(rt, "remote");
  try {
    for (const route of ROUTES) {
      const res = await app.inject({ method: route.method, url: route.url, ...("payload" in route ? { payload: route.payload } : {}) });
      assert.equal(res.statusCode, 401, `${route.method} ${route.url} without the bearer`);
    }
    const settings = await app.inject({ method: "GET", url: "/api/agent-tools", headers: { authorization: BEARER } });
    assert.equal(settings.statusCode, 200);
    assert.deepEqual(settings.json(), { grants: [] });
    const chat = await app.inject({ method: "GET", url: "/api/sessions/t1/agent-tools", headers: { authorization: BEARER } });
    assert.deepEqual(chat.json(), { threadId: "t1", agent: "claude", workflowOwned: false, grants: [] });
    assert.equal((await app.inject({ method: "GET", url: "/api/sessions/zz/agent-tools", headers: { authorization: BEARER } })).statusCode, 404);
    assert.equal((await app.inject({ method: "GET", url: "/api/sessions/t1/tool-approvals", headers: { authorization: BEARER } })).statusCode, 200);
  } finally {
    await app.close();
  }
});

test("both transports: a card answered over the socket or HTTP; secrets never in a response, event or log; revocation over HTTP", async (t) => {
  const { rt, published, logged } = await runtime(t);
  const local = server(rt, "local");
  const remote = server(rt, "remote");
  const secret = "ghp_SECRET_VALUE_NEVER_SHOWN_123";
  try {
    // The removed toolset writes are gone on both transports (every tool is on in every chat).
    for (const app of [local, remote]) {
      const headers = app === remote ? { authorization: BEARER } : {};
      assert.equal((await app.inject({ method: "PUT", url: "/api/agent-tools/settings", headers, payload: { revision: 0, enabled: false } })).statusCode, 404);
      assert.equal((await app.inject({ method: "PUT", url: "/api/sessions/t1/agent-tools", headers, payload: { toolsets: { notes: false } } })).statusCode, 404);
    }

    // A card with a secret field, answered over HTTP.
    const waiting = rt.approvals.open(
      {
        threadId: "t1",
        tool: "set_workflow_secret",
        kind: "admin",
        family: "workflow-secrets",
        title: "Claude wants to set the workflow secret DEPLOY_TOKEN",
        scope: { label: "Workflow deploy" },
        sections: [{ kind: "fields", rows: [{ label: "Secret", value: "DEPLOY_TOKEN", state: "asked" }] }],
        secretFields: [{ key: "value", label: "DEPLOY_TOKEN" }],
        grantOptions: []
      },
      new AbortController().signal
    );
    const [card] = rt.approvals.list("t1");
    const url = `/api/sessions/t1/tool-approvals/${card!.approvalId}`;
    const answered = await remote.inject({ method: "POST", url, headers: { authorization: BEARER }, payload: { decision: "approve", secrets: { value: secret } } });
    assert.equal(answered.statusCode, 200);
    const outcome = await waiting;
    assert.equal(outcome.outcome === "approved" ? outcome.secrets?.value : null, secret, "the value reaches the waiting call");
    const twice = await local.inject({ method: "POST", url, payload: { decision: "deny" } });
    assert.equal(twice.statusCode, 409);
    const everything = JSON.stringify([answered.body, twice.body, published, logged]);
    assert.ok(!everything.includes(secret), "never in a response, an event or a log line");
    assert.ok(published.some((e) => e.type === "agentChat.toolApproval"));
    assert.equal(logged.filter((line) => line.includes("[tool-approvals]")).length, 1, "one line per decision");

    // Grants: revoke one, revoke all.
    const grantId = rt.tools.addGrant({ family: "desktops", scope: "project", projectPath: "/w/ws/p", threadId: "t1" });
    const query = { family: "desktops", callerRuntimeMode: "full-access", workflowOwned: false, threadId: "t1", projectPath: "/w/ws/p", projects: ["/w/ws/p"] };
    assert.ok(rt.tools.findGrant(query));
    assert.equal((await remote.inject({ method: "DELETE", url: `/api/agent-tools/grants/${grantId}`, headers: { authorization: BEARER } })).statusCode, 204);
    assert.ok(published.some((e) => e.channel === "agent-tools" && e.type === "agentTools.changed"));
    assert.equal(rt.tools.findGrant(query), null, "revoked: the next call cards again");
    assert.equal((await remote.inject({ method: "DELETE", url: `/api/agent-tools/grants/${grantId}`, headers: { authorization: BEARER } })).statusCode, 404);
    rt.tools.addGrant({ family: "desktops", scope: "chat", projectPath: "/w/ws/p", threadId: "t1" });
    const all = await local.inject({ method: "DELETE", url: "/api/agent-tools/grants?threadId=t1" });
    assert.deepEqual(all.json(), { revoked: 1 });
  } finally {
    await local.close();
    await remote.close();
  }
});

test("agent principals are refused on every write and on card answers (403); reads stay open", async (t) => {
  const { rt } = await runtime(t);
  const app = Fastify();
  const principal: CallerPrincipal = { kind: "agent", threadId: "t1", projectPath: "/w/ws/p" };
  app.addHook("onRequest", async (request) => {
    (request as unknown as { principal: CallerPrincipal }).principal = principal;
  });
  registerAgentToolsRuntimeRoutes(app, rt);
  try {
    for (const route of ROUTES) {
      const res = await app.inject({ method: route.method, url: route.url, ...("payload" in route ? { payload: route.payload } : {}) });
      if (route.method === "GET") assert.notEqual(res.statusCode, 403, `${route.url} is a read`);
      else {
        assert.equal(res.statusCode, 403, `${route.method} ${route.url}`);
        assert.equal((res.json() as { error: { code: string } }).error.code, "PERMISSION_DENIED");
      }
    }
    assert.deepEqual(rt.tools.snapshot().grants, [], "nothing changed");
  } finally {
    await app.close();
  }
});
