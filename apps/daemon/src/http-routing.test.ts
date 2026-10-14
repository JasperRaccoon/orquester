/**
 * The daemon's own router (`createServer`), driven through `inject` only:
 *
 * - the remote HTTP transport's bearer hook gates every `/api`, `/events` and
 *   `/mcp` route whatever spelling of the path reaches the router: the router
 *   percent-decodes a path before matching it, so the hook must not decide on
 *   the raw request line alone (`/%61pi/...` is routed to `/api/...`);
 * - a route parameter as long as the agent profile's item ids (a command
 *   `command:<64>/<64>`, a plugin `plugin:<name>@<marketplace>`, percent-encoded)
 *   still matches its route.
 */

import assert from "node:assert/strict";
import { createWriteStream } from "node:fs";
import { test } from "node:test";
import { agentProfileRoutes } from "@orquester/api";
import { agentChatRoutes } from "@orquester/api/agent-chat";
import { createDefaultClientConfig, createDefaultDaemonConfig } from "@orquester/config";
import { createVisualUrlSigner } from "./agent-chat/visual-urls.ts";
import { SecretRequestRegistry } from "./agent-chat/secret-requests.ts";
import { createServer } from "./index.ts";

type CreateServerArgs = Parameters<typeof createServer>;
const USERNAME = "admin";
const PASSWORD_HASH = "$2a$12$0123456789012345678901uFAKEfakeFAKEfakeFAKEfa";
const BEARER = `Bearer ${Buffer.from(`${USERNAME}:${PASSWORD_HASH}`).toString("base64")}`;

function remoteApp(services: Record<string, unknown>) {
  const config = createDefaultDaemonConfig({ env: {} });
  config.transports.http.username = USERNAME;
  config.transports.http.passwordHash = PASSWORD_HASH;
  const root = "/nonexistent-orquester-auth-path-test";
  const resolved = { daemonDir: root, baseDir: root, workspacesDir: root, workspacesMetaFile: `${root}/workspaces.json`, fsRoot: root } as unknown as CreateServerArgs[1];
  return createServer(
    config,
    resolved,
    createDefaultClientConfig(`${root}/daemon.sock`),
    createWriteStream("/dev/null"),
    services as unknown as CreateServerArgs[4],
    { authRequired: true, mode: "remote" }
  );
}

test("the bearer hook refuses percent-encoded spellings of a gated path", async () => {
  let reads = 0;
  const app = remoteApp({
    agentProfile: {
      overview: async () => {
        reads += 1;
        return { agents: [] };
      }
    }
  });
  try {
    for (const url of [
      "/api/agent-profile",
      "/%61pi/agent-profile",
      "/%61%70%69/agent-profile",
      "/%41pi/agent-profile",
      "/api/agent-profil%65",
      "/%65vents",
      "/%6dcp"
    ]) {
      const res = await app.inject({ method: "GET", url });
      assert.ok(res.statusCode === 401 || res.statusCode === 404, `${url} answered ${res.statusCode}`);
    }
    assert.equal(reads, 0);
    const authorized = await app.inject({ method: "GET", url: "/%61pi/agent-profile", headers: { authorization: BEARER } });
    assert.equal(authorized.statusCode, 200);
    assert.equal(reads, 1);
    // The public auth-info endpoint stays public.
    assert.equal((await app.inject({ method: "GET", url: "/api/auth/info" })).statusCode, 200);
  } finally {
    await app.close();
  }
});

test("agent profile item routes match ids longer than the router's default 100-character parameter", async () => {
  const seen: string[] = [];
  const app = remoteApp({
    agentProfile: {
      readItem: async (_agent: string, id: string) => {
        seen.push(id);
        return { kind: "command", item: { id }, document: { frontmatter: {}, body: "" } };
      }
    }
  });
  try {
    const id = `command:${"a".repeat(64)}/${"b".repeat(64)}`;
    const res = await app.inject({
      method: "GET",
      url: agentProfileRoutes.item("claude", id),
      headers: { authorization: BEARER }
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(seen, [id]);
  } finally {
    await app.close();
  }
});

test("an agent page's signed route passes the bearer hook on its signature alone; minting still needs the bearer", async () => {
  const page = "t1-0f8fad5b-d9cb-469f-a165-70867728950e-html";
  const signer = createVisualUrlSigner(Buffer.alloc(32, 3));
  const resolved: string[] = [];
  const app = remoteApp({
    agentChat: {
      routeDeps: () => ({
        isHostHealthy: () => true,
        chatSession: (id: string) => (id === "t1" ? { id } : undefined),
        attachmentPath: async (_id: string, attachmentId: string) => {
          resolved.push(attachmentId);
          return null;
        },
        visualUrls: signer
      })
    }
  });
  try {
    // Minting is an ordinary chat route: the bearer gates it.
    assert.equal((await app.inject({ method: "POST", url: agentChatRoutes.visualUrl("t1", page) })).statusCode, 401);
    const minted = await app.inject({
      method: "POST",
      url: agentChatRoutes.visualUrl("t1", page),
      headers: { authorization: BEARER }
    });
    assert.equal(minted.statusCode, 200, minted.body);
    const { path } = minted.json() as { path: string };
    // The frame's request carries no bearer: the signature authorises it.
    assert.equal((await app.inject({ method: "GET", url: path })).statusCode, 404, "past the hook, to a gone file");
    assert.deepEqual(resolved, [page]);
    // Without a valid signature the route itself refuses.
    assert.equal((await app.inject({ method: "GET", url: agentChatRoutes.visual("t1", page) })).statusCode, 403);
    // The bare prefix is no page route: gated like any other /api path.
    assert.equal((await app.inject({ method: "GET", url: "/api/agent-visuals" })).statusCode, 401);
    // Percent-encoded spellings: the router decodes them onto the page route,
    // whose own signature check still refuses an unsigned request — and with a
    // valid signature they reach the same handler, never a gated one.
    assert.equal((await app.inject({ method: "GET", url: `/api/agent%2Dvisuals/t1/${page}` })).statusCode, 403);
    assert.equal((await app.inject({ method: "GET", url: `/%61pi/agent-visuals/t1/${page}` })).statusCode, 403);
    const encodedSigned = path.replace("/api/agent-visuals/", "/api/agent%2Dvisuals/");
    assert.equal((await app.inject({ method: "GET", url: encodedSigned })).statusCode, 404, "past the hook, to a gone file");
    // An encoded traversal stays a page-route parameter, refused by the signature.
    for (const url of [
      `/api/agent-visuals/t1/..%2F..%2Fsessions`,
      `/api/agent-visuals/..%2Fsessions/x`,
      `/api/agent-visuals/t1/${page}%2F..%2F..%2F..%2Fagent-profile`
    ]) {
      const res = await app.inject({ method: "GET", url });
      assert.ok(res.statusCode === 403 || res.statusCode === 404 || res.statusCode === 401, `${url} answered ${res.statusCode}`);
    }
    // The mint route stays gated in any spelling.
    assert.equal(
      (await app.inject({ method: "POST", url: `/%61pi/sessions/t1/visuals/${page}/url` })).statusCode,
      401
    );
    assert.deepEqual(resolved, [page, page], "only signed requests ever reached the host");
  } finally {
    await app.close();
  }
});

test("the session-tool call route is socket-only, and the socket still requires the agent host's bearer", async () => {
  const route = "/api/agent-host/session-tools/call";
  const body = { threadId: "t", callId: "c", name: "echo", arguments: {} };
  // Remote HTTP: not mounted at all, even for an authenticated caller.
  const remote = remoteApp({});
  try {
    const res = await remote.inject({ method: "POST", url: route, headers: { authorization: BEARER }, payload: body });
    assert.equal(res.statusCode, 404);
  } finally {
    await remote.close();
  }
  // The unix socket: mounted, but only the host's own token passes.
  const config = createDefaultDaemonConfig({ env: {} });
  const root = "/nonexistent-orquester-auth-path-test";
  const resolved = { daemonDir: root, baseDir: root, workspacesDir: root, workspacesMetaFile: `${root}/workspaces.json`, fsRoot: root } as unknown as CreateServerArgs[1];
  const seen: Array<string | undefined> = [];
  const local = createServer(
    config,
    resolved,
    createDefaultClientConfig(`${root}/daemon.sock`),
    createWriteStream("/dev/null"),
    {
      agentChat: {
        authorizeHostRequest: (authorization: string | undefined) => {
          seen.push(authorization);
          return authorization === "Bearer host-token";
        },
        sessionToolThread: () => null,
        // `createServer` mounts the chat routes off these; none is called here.
        routeDeps: () => undefined,
        protectedPids: () => []
      }
    } as unknown as CreateServerArgs[4],
    { authRequired: false, mode: "local" }
  );
  try {
    const anonymous = await local.inject({ method: "POST", url: route, payload: body });
    assert.equal(anonymous.statusCode, 401);
    const host = await local.inject({ method: "POST", url: route, headers: { authorization: "Bearer host-token" }, payload: body });
    assert.equal(host.statusCode, 404, "past the gate: the thread is unknown");
    assert.deepEqual(seen, [undefined, "Bearer host-token"]);
  } finally {
    await local.close();
  }
});

test("the request_secret routes are mounted on remote HTTP behind its bearer, never echoing an answer", async () => {
  const secretRequests = new SecretRequestRegistry({ publish: () => {} });
  const chatSession = (id: string) => (id === "t1" ? { id } : undefined);
  const app = remoteApp({
    secretRequests,
    agentChat: { routeDeps: () => ({ chatSession, isHostHealthy: () => true }), protectedPids: () => [] }
  });
  try {
    const list = "/api/sessions/t1/secret-requests";
    const answer = "/api/sessions/t1/secret-requests/r1";
    const payload = { answer: "provide", value: "never-echoed-value" };
    assert.equal((await app.inject({ method: "GET", url: list })).statusCode, 401);
    const anonymous = await app.inject({ method: "POST", url: answer, payload });
    assert.equal(anonymous.statusCode, 401);
    assert.equal((await app.inject({ method: "GET", url: list, headers: { authorization: BEARER } })).statusCode, 200);
    const unknown = await app.inject({ method: "POST", url: answer, headers: { authorization: BEARER }, payload });
    assert.equal(unknown.statusCode, 404, "past the gate: no such request");
    assert.ok(!unknown.body.includes("never-echoed-value"));
  } finally {
    await app.close();
  }
});
