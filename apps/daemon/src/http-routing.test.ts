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
