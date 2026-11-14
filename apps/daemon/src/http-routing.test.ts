/**
 * The daemon's own router (`createServer`), driven through `inject` only:
 *
 * - the remote HTTP transport's bearer hook gates every `/api`, `/events` and
 *   `/mcp` route whatever spelling of the path reaches the router: the router
 *   percent-decodes a path before matching it, so the hook must not decide on
 *   the raw request line alone (`/%61pi/...` is routed to `/api/...`);
 * - a route parameter as long as the agent profile's item ids (a command
 *   `command:<64>/<64>`, a plugin `plugin:<name>@<marketplace>`, percent-encoded)
 *   still matches its route;
 * - the embeddable chat's public `/embed/` files load from any origin without a
 *   bearer, cached by name, and a stale one is a JSON 404 rather than the SPA;
 * - a page loaded before a release switch still gets its hashed assets from the
 *   previous release's build, and nothing else comes from there.
 */

import assert from "node:assert/strict";
import { createWriteStream } from "node:fs";
import { test } from "node:test";
import { agentProfileRoutes, sessionProfileRoutes } from "@orquester/api";
import { agentChatRoutes } from "@orquester/api/agent-chat";
import { createDefaultClientConfig, createDefaultDaemonConfig } from "@orquester/config";
import { createVisualUrlSigner } from "./agent-chat/visual-urls.ts";
import { SecretRequestRegistry } from "./agent-chat/secret-requests.ts";
import { createServer } from "./index.ts";
import { testAuthSessions } from "./auth/testing.ts";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { knowledgeRoutes } from "@orquester/api";
import { KnowledgeService } from "./knowledge/service.ts";
import { FAKE_RUNTIME } from "./knowledge/linking/testing.ts";
import { silentLogger } from "./knowledge/search/test-fakes.ts";
import { FakeKnowledgePlugins, FakeRuntime, fakeEmbedders } from "./knowledge/test-fakes.ts";

type CreateServerArgs = Parameters<typeof createServer>;
const USERNAME = "admin";
const PASSWORD_HASH = "$2a$12$0123456789012345678901uFAKEfakeFAKEfakeFAKEfa";
const { authSessions: AUTH_SESSIONS, bearer: BEARER } = await testAuthSessions();

function remoteApp(services: Record<string, unknown>, mode: "local" | "remote" = "remote", serveWeb?: string, webFallback?: string) {
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
    { authSessions: AUTH_SESSIONS, ...services } as unknown as CreateServerArgs[4],
    { authRequired: mode === "remote", mode, serveWeb, webFallback }
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

test("the Agent Profiles routes are on both transports, bearer-gated on the remote one", async () => {
  let reads = 0;
  const services = {
    sessionProfiles: {
      list: async () => {
        reads += 1;
        return { profiles: [], errors: [] };
      }
    }
  };
  const remote = remoteApp(services);
  const local = remoteApp(services, "local");
  try {
    for (const url of [sessionProfileRoutes.list, "/%61pi/session-profiles", sessionProfileRoutes.profile("p1")]) {
      assert.equal((await remote.inject({ method: "GET", url })).statusCode, 401, url);
    }
    assert.equal(reads, 0);
    const authorized = await remote.inject({ method: "GET", url: sessionProfileRoutes.list, headers: { authorization: BEARER } });
    assert.equal(authorized.statusCode, 200, authorized.body);
    // The unix socket is trusted local control: no bearer.
    const socket = await local.inject({ method: "GET", url: sessionProfileRoutes.list });
    assert.equal(socket.statusCode, 200, socket.body);
    assert.equal(reads, 2);
  } finally {
    await remote.close();
    await local.close();
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
  const signer = createVisualUrlSigner();
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

test("the Knowledge Graph routes are bearer-gated on the remote transport, worker routes absent there", async (t) => {
  const appdir = await mkdtemp(join(tmpdir(), "kg-http-"));
  const runtime = new FakeRuntime();
  runtime.set(FAKE_RUNTIME);
  const knowledge = new KnowledgeService({
    appdir,
    plugins: new FakeKnowledgePlugins(true),
    accounts: { list: () => ({ accounts: [] }) },
    session: () => null,
    profiles: { list: async () => ({ profiles: [], errors: [] }), read: async () => { throw new Error("no profiles"); } },
    publisher: { publish() {} },
    toolsChanged: () => {},
    runtime,
    embedders: fakeEmbedders().factory,
    logger: silentLogger()
  });
  await knowledge.start();
  const app = remoteApp({ knowledge });
  t.after(async () => {
    await app.close();
    await knowledge.stop();
    await rm(appdir, { recursive: true, force: true });
  });
  const gated: { method: "GET" | "POST" | "PUT"; url: string; payload?: object }[] = [
    { method: "GET", url: knowledgeRoutes.status },
    { method: "GET", url: knowledgeRoutes.settings },
    { method: "PUT", url: knowledgeRoutes.settings, payload: { concurrency: 2 } },
    { method: "GET", url: knowledgeRoutes.collections },
    { method: "GET", url: knowledgeRoutes.entries },
    { method: "GET", url: knowledgeRoutes.graph },
    { method: "POST", url: knowledgeRoutes.search, payload: { query: "seo" } },
    { method: "POST", url: knowledgeRoutes.save, payload: { entries: [] } },
    { method: "POST", url: knowledgeRoutes.rebuild, payload: {} }
  ];
  for (const route of gated) {
    const res = await app.inject({ method: route.method, url: route.url, ...(route.payload ? { payload: route.payload } : {}) });
    assert.equal(res.statusCode, 401, `${route.method} ${route.url} without a bearer answered ${res.statusCode}`);
  }
  const status = await app.inject({ method: "GET", url: knowledgeRoutes.status, headers: { authorization: BEARER } });
  assert.equal(status.statusCode, 200, status.body);
  const collections = await app.inject({ method: "GET", url: knowledgeRoutes.collections, headers: { authorization: BEARER } });
  assert.equal(collections.statusCode, 200, collections.body);
  for (const url of [knowledgeRoutes.workerNext, knowledgeRoutes.workerSubmit]) {
    const res = await app.inject({ method: "POST", url, payload: {}, headers: { authorization: BEARER } });
    assert.equal(res.statusCode, 404, `${url} must not exist on the remote transport (answered ${res.statusCode})`);
  }
});

async function webDirWithEmbed(t: { after(fn: () => Promise<void>): void }): Promise<string> {
  const webDir = await mkdtemp(join(tmpdir(), "orq-web-"));
  t.after(() => rm(webDir, { recursive: true, force: true }));
  await mkdir(join(webDir, "embed", "chunks"), { recursive: true });
  await mkdir(join(webDir, "assets"));
  await writeFile(join(webDir, "index.html"), "<!doctype html><title>spa</title>");
  await writeFile(join(webDir, "assets", "app.1a2b3c4d.js"), "export {};");
  await writeFile(join(webDir, "embed", "manifest.json"), JSON.stringify({ contract: 1, entry: "agent-chat.3f9a2c1d.js" }));
  await writeFile(join(webDir, "embed", "agent-chat.3f9a2c1d.js"), "export const contract = 1;");
  await writeFile(join(webDir, "embed", "chunks", "katex.5e6f7a8b.js"), "export {};");
  return webDir;
}

test("embed files load cross-origin without a bearer: hashed ones immutable, the manifest revalidated", async (t) => {
  const app = remoteApp({}, "remote", await webDirWithEmbed(t));
  try {
    for (const method of ["GET", "HEAD"] as const) {
      for (const url of ["/embed/agent-chat.3f9a2c1d.js", "/embed/chunks/katex.5e6f7a8b.js"]) {
        const res = await app.inject({ method, url });
        assert.equal(res.statusCode, 200, `${method} ${url}`);
        assert.equal(res.headers["access-control-allow-origin"], "*");
        assert.equal(res.headers["cross-origin-resource-policy"], "cross-origin");
        assert.equal(res.headers["cache-control"], "public, max-age=31536000, immutable");
      }
    }
    const manifest = await app.inject({ method: "GET", url: "/embed/manifest.json" });
    assert.equal(manifest.statusCode, 200);
    assert.equal(manifest.json().entry, "agent-chat.3f9a2c1d.js");
    assert.equal(manifest.headers["access-control-allow-origin"], "*");
    assert.equal(manifest.headers["cache-control"], "no-cache");

    const preflight = await app.inject({
      method: "OPTIONS",
      url: "/embed/agent-chat.3f9a2c1d.js",
      headers: { origin: "https://viewer.example", "access-control-request-method": "GET" }
    });
    assert.equal(preflight.statusCode, 204);
    assert.equal(preflight.headers["access-control-allow-origin"], "*");
    assert.match(String(preflight.headers["access-control-allow-methods"]), /GET/);
  } finally {
    await app.close();
  }
});

test("a missing embed file is a cross-origin JSON 404, not the SPA; other web paths keep their behaviour", async (t) => {
  const app = remoteApp({}, "remote", await webDirWithEmbed(t));
  try {
    for (const method of ["GET", "HEAD"] as const) {
      const miss = await app.inject({ method, url: "/embed/agent-chat.deadbeef.js" });
      assert.equal(miss.statusCode, 404, method);
      assert.match(String(miss.headers["content-type"]), /application\/json/);
      assert.equal(miss.headers["access-control-allow-origin"], "*");
      assert.equal(miss.headers["cross-origin-resource-policy"], "cross-origin");
      assert.doesNotMatch(String(miss.headers["cache-control"] ?? ""), /immutable/);
    }
    assert.equal((await app.inject({ method: "GET", url: "/embed/agent-chat.deadbeef.js" })).json().code, "NOT_FOUND");

    const asset = await app.inject({ method: "GET", url: "/assets/app.1a2b3c4d.js" });
    assert.equal(asset.statusCode, 200);
    assert.equal(asset.headers["access-control-allow-origin"], undefined);
    assert.equal(asset.headers["cross-origin-resource-policy"], undefined);
    assert.doesNotMatch(String(asset.headers["cache-control"]), /immutable/);
    for (const url of ["/workspace/project", "/embedded"]) {
      const spa = await app.inject({ method: "GET", url });
      assert.equal(spa.statusCode, 200, url);
      assert.match(spa.body, /<title>spa<\/title>/);
      assert.equal(spa.headers["access-control-allow-origin"], undefined);
    }
  } finally {
    await app.close();
  }
});

/** The previous release's build: its own index, service worker and chunks, one a symlink out of it. */
async function previousWebDir(t: { after(fn: () => Promise<void>): void }): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "orq-web-prev-")));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, "assets"));
  await mkdir(join(dir, "embed", "chunks"), { recursive: true });
  await writeFile(join(dir, "index.html"), "<!doctype html><title>previous</title>");
  await writeFile(join(dir, "sw.js"), "/* previous sw */");
  await writeFile(join(dir, "secret.txt"), "previous secret");
  await writeFile(join(dir, "assets", "Chat-Ab3_x9Zq.js"), "export const previous = 1;");
  await writeFile(join(dir, "assets", "notes.txt"), "previous notes");
  await symlink(join(dir, "secret.txt"), join(dir, "assets", "Leak-Zz9_8Yy7.js"));
  await writeFile(join(dir, "embed", "chunks", "mermaid.0a1b2c3d.js"), "export const previous = 2;");
  await writeFile(join(dir, "embed", "manifest.json"), JSON.stringify({ contract: 1, entry: "agent-chat.0a1b2c3d.js" }));
  return dir;
}

test("a hashed asset the live build lacks comes from the previous build, with the live headers; nothing else does", async (t) => {
  const live = await webDirWithEmbed(t);
  const app = remoteApp({}, "remote", live, await previousWebDir(t));
  await rm(join(live, "embed", "manifest.json"));
  try {
    const liveAsset = await app.inject({ method: "GET", url: "/assets/app.1a2b3c4d.js" });
    const chunk = await app.inject({ method: "GET", url: "/assets/Chat-Ab3_x9Zq.js" });
    assert.equal(chunk.statusCode, 200);
    assert.equal(chunk.body, "export const previous = 1;");
    assert.match(String(chunk.headers["content-type"]), /javascript/);
    assert.equal(chunk.headers["cache-control"], liveAsset.headers["cache-control"]);

    const embedChunk = await app.inject({ method: "GET", url: "/embed/chunks/mermaid.0a1b2c3d.js" });
    assert.equal(embedChunk.statusCode, 200);
    assert.equal(embedChunk.body, "export const previous = 2;");
    assert.equal(embedChunk.headers["cache-control"], "public, max-age=31536000, immutable");
    assert.equal(embedChunk.headers["access-control-allow-origin"], "*");

    // The shell, the service worker and every unhashed file come from the live build or not at all.
    for (const url of ["/", "/index.html", "/sw.js", "/workspace/project"]) {
      const res = await app.inject({ method: "GET", url });
      assert.doesNotMatch(res.body, /previous/, url);
    }
    for (const url of ["/embed/manifest.json", "/assets/notes.txt", "/assets/Leak-Zz9_8Yy7.js"]) {
      const res = await app.inject({ method: "GET", url });
      assert.equal(res.statusCode, 404, url);
      assert.doesNotMatch(res.body, /previous/, url);
    }
    // Out of `assets/` by `..`: never the previous build's file (a path the router resolves to the root gets the SPA).
    for (const url of ["/assets/../secret.txt", "/assets/%2e%2e/secret.txt", "/assets/..%2fsecret.txt", "/assets/%2e%2e/%2e%2e/etc/passwd"]) {
      const res = await app.inject({ method: "GET", url });
      assert.doesNotMatch(res.body, /previous|root:/, url);
    }
  } finally {
    await app.close();
  }
});

test("without a previous build, a missing hashed asset is a JSON 404, not the SPA", async (t) => {
  const app = remoteApp({}, "remote", await webDirWithEmbed(t));
  try {
    for (const method of ["GET", "HEAD"] as const) {
      const miss = await app.inject({ method, url: "/assets/Chat-Ab3_x9Zq.js" });
      assert.equal(miss.statusCode, 404, method);
      assert.match(String(miss.headers["content-type"]), /application\/json/);
    }
  } finally {
    await app.close();
  }
});
