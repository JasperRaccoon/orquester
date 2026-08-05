import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import type { CliProxyStatus, CliProxyXaiLink } from "@orquester/api";
import { registerCliProxyRoutes } from "./index";
import {
  parseCliProxyState, createDefaultCliProxyState,
  parseCliProxySecrets, cliproxyDir, cliproxyHomeDir, MODEL_NAME_RE,
  CLAUDE_ARMING_COMPACT_WINDOW, CURATED_PROXY_MODEL_IDS, compactEnvForModel
} from "@orquester/config";

test("state: defaults on garbage, valid passes through", () => {
  const d = parseCliProxyState({ nonsense: true });
  assert.equal(d.enabled, false);
  assert.equal(d.port, 8317);
  const ok = parseCliProxyState({ ...createDefaultCliProxyState(), enabled: true, defaultModel: "kimi-k3" });
  assert.equal(ok.enabled, true);
  assert.equal(ok.defaultModel, "kimi-k3");
});

test("secrets: corrupt fails closed, never defaults", () => {
  assert.equal(parseCliProxySecrets({ apiKey: 42 }), "corrupt");
  assert.equal(parseCliProxySecrets("not even an object"), "corrupt");
  const ok = parseCliProxySecrets({ apiKey: "a", managementSecret: "b", openRouterKey: null });
  assert.notEqual(ok, "corrupt");
});

test("paths + model charset", () => {
  assert.equal(cliproxyDir("/x/daemon"), "/x/daemon/cliproxy");
  assert.equal(cliproxyHomeDir("/x/daemon", "claudex"), "/x/daemon/cliproxy/claude-home-claudex");
  assert.ok(MODEL_NAME_RE.test("moonshotai/kimi-k3"));
  assert.ok(!MODEL_NAME_RE.test("bad model; rm -rf"));
});

test("compactEnvForModel: curated gpt model resolves window + pct", () => {
  assert.deepEqual(compactEnvForModel("gpt-5.6-sol"), {
    maxContextTokens: 200000,
    autoCompactWindow: 200000,
    autoCompactPct: 75
  });
});

test("compactEnvForModel: acc-prefixed model resolves like its bare id", () => {
  assert.deepEqual(compactEnvForModel("acc65eebd90/gpt-5.6-terra"), {
    maxContextTokens: 200000,
    autoCompactWindow: 200000,
    autoCompactPct: 75
  });
});

test("compactEnvForModel: bare claude ids get the arming value only (native window detection)", () => {
  assert.deepEqual(compactEnvForModel("claude-fable-5"), {
    autoCompactWindow: CLAUDE_ARMING_COMPACT_WINDOW
  });
});

test("compactEnvForModel: claude ids NEVER get maxContextTokens (refused when family-classified)", () => {
  assert.deepEqual(compactEnvForModel("acc14137047/claude-opus-5"), {
    autoCompactWindow: CLAUDE_ARMING_COMPACT_WINDOW
  });
});

test("compactEnvForModel: claude compactWindow/pct overrides pass through (bare-id keyed)", () => {
  assert.deepEqual(
    compactEnvForModel("acc14137047/claude-3-5-haiku", { "claude-3-5-haiku": { compactWindow: 200000, compactPct: 80 } }),
    { autoCompactWindow: 200000, autoCompactPct: 80 }
  );
});

test("compactEnvForModel: overrides beat curated defaults, per field", () => {
  assert.deepEqual(
    compactEnvForModel("gpt-5.6-sol", { "gpt-5.6-sol": { compactWindow: 180000, compactPct: 60 } }),
    { maxContextTokens: 200000, autoCompactWindow: 180000, autoCompactPct: 60 }
  );
});

test("compactEnvForModel: a router-shaped id with no configured provider resolves to nothing", () => {
  // Regression for the retired name-shape magic: `moonshotai/…` (and the bare
  // `kimi-k3` alias) used to resolve off a hardcoded curated entry + a
  // `moonshotai/` strip. Compact metadata now comes ONLY from the provider
  // record (see router-providers.test.ts), so an unconfigured id emits nothing.
  assert.equal(compactEnvForModel("moonshotai/kimi-k3"), null);
  assert.equal(compactEnvForModel("kimi-k3"), null);
  assert.equal(compactEnvForModel("moonshotai/kimi-k3", undefined, []), null);
});

test("compactEnvForModel: uncurated non-claude id with no override emits nothing", () => {
  assert.equal(compactEnvForModel("glm-5-air"), null);
});

test("compactEnvForModel: an override alone makes an uncurated id resolvable", () => {
  assert.deepEqual(compactEnvForModel("glm-5-air", { "glm-5-air": { contextWindow: 128000 } }), {
    maxContextTokens: 128000,
    autoCompactWindow: 128000
  });
});

test("cliProxyState: modelOverrides roundtrip and absent-field default", () => {
  assert.deepEqual(createDefaultCliProxyState().modelOverrides, {});
  const parsed = parseCliProxyState({
    ...createDefaultCliProxyState(),
    modelOverrides: { "kimi-k3": { compactWindow: 500000 } }
  });
  assert.deepEqual(parsed.modelOverrides, { "kimi-k3": { compactWindow: 500000 } });
});

test("CURATED_PROXY_MODEL_IDS is the OAuth picker order sol, terra, luna (no router models)", () => {
  assert.deepEqual(CURATED_PROXY_MODEL_IDS, ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]);
});

// --- Router-provider HTTP routes (spec 2026-08-04 §2) -------------------------
//
// These drive `registerCliProxyRoutes` against a fake CliProxyRouteManager: the
// routes own only charset/body validation and the result→status-code mapping,
// so the fake records what it was handed and replays scripted manager results.

type RouterMutationResult = { ok: boolean; affectedSessions?: number; error?: string };
type RouterCatalogResult =
  | { ok: true; models: string[] }
  | { ok: false; code: "unknown" | "no-key" | "upstream"; error: string };
type XaiLinkRouteResult =
  | { ok: true; link: CliProxyXaiLink }
  | { ok: false; code: "conflict" | "upstream"; error: string; status?: number };

function fakeRouterRouteManager() {
  const calls = {
    upsert: [] as Array<{ input: unknown; force: boolean }>,
    deleteProvider: [] as Array<{ id: string; force: boolean }>,
    setKey: [] as Array<{ id: string; key: string; force: boolean }>,
    clearKey: [] as Array<{ id: string; force: boolean }>,
    catalog: [] as string[],
    linkXai: 0,
    unlinkXai: [] as Array<{ force: boolean }>
  };
  const results = {
    upsert: { ok: true } as RouterMutationResult,
    deleteProvider: { ok: true } as RouterMutationResult,
    setKey: { ok: true, affectedSessions: 0 } as RouterMutationResult,
    clearKey: { ok: true, affectedSessions: 0 } as RouterMutationResult,
    catalog: { ok: true, models: ["a/b"] } as RouterCatalogResult,
    linkXai: {
      ok: true,
      link: { url: "https://x.ai/device", userCode: "ABCD-EFGH", expiresAt: "2026-08-05T00:30:00Z" }
    } as XaiLinkRouteResult,
    unlinkXai: { ok: true, affectedSessions: 0 } as RouterMutationResult
  };
  const status: CliProxyStatus = {
    state: "off",
    reasons: [],
    detail: null,
    version: null,
    defaultModel: "gpt-5.6-sol",
    backgroundModel: "gpt-5.6-luna",
    modelOverrides: {},
    providers: [],
    routerProviders: [],
    xai: { state: "none", email: null, expiredAt: null, lastQuotaError: null, lastLinkError: null, link: null },
    accounts: [],
    activeSessionCount: 0,
    testedClaudeCliVersion: null
  };
  const manager = {
    status: () => status,
    enable: async () => {},
    disable: async () => ({ ok: true, affectedSessions: 0 }),
    setConfig: async () => ({ ok: true, affectedSessions: 0 }),
    seedProvider: async () => ({
      provider: "codex" as const,
      state: "ok" as const,
      lastVerifiedAt: null
    }),
    unseedProvider: async () => ({
      provider: "codex" as const,
      state: "missing" as const,
      lastVerifiedAt: null
    }),
    upsertRouterProvider: async (input: unknown, force: boolean) => {
      calls.upsert.push({ input, force });
      return results.upsert;
    },
    deleteRouterProvider: async (id: string, force: boolean) => {
      calls.deleteProvider.push({ id, force });
      return results.deleteProvider;
    },
    setRouterKey: async (id: string, key: string, force: boolean) => {
      calls.setKey.push({ id, key, force });
      return results.setKey;
    },
    clearRouterKey: async (id: string, force: boolean) => {
      calls.clearKey.push({ id, force });
      return results.clearKey;
    },
    fetchRouterCatalog: async (id: string) => {
      calls.catalog.push(id);
      return results.catalog;
    },
    linkXai: async () => {
      calls.linkXai += 1;
      return results.linkXai;
    },
    cancelOrUnlinkXai: async (opts: { force?: boolean }) => {
      calls.unlinkXai.push({ force: Boolean(opts.force) });
      return results.unlinkXai;
    }
  };
  return { manager, calls, results, status };
}

function routerRouteApp(mode: "local" | "remote", manager: ReturnType<typeof fakeRouterRouteManager>["manager"]) {
  const daemonDir = join(mkdtempSync(join(tmpdir(), "orq-cliproxy-router-routes-")), "daemon");
  const app = Fastify();
  registerCliProxyRoutes(app, {
    manager,
    mode,
    daemonDir,
    agentAccounts: { homePath: () => daemonDir, markProxyOwned: async () => {} }
  });
  return app;
}

test("PUT /api/cliproxy/providers/:id validates the provider id charset and body before the manager", async () => {
  const { manager, calls } = fakeRouterRouteManager();
  const app = routerRouteApp("remote", manager);
  await app.ready();

  const badId = await app.inject({
    method: "PUT",
    url: "/api/cliproxy/providers/Bad_Id",
    payload: { label: "X", baseUrl: "https://x.example/v1", models: [] }
  });
  assert.equal(badId.statusCode, 400);
  assert.match(badId.json().error, /provider id/);

  const badBody = await app.inject({
    method: "PUT",
    url: "/api/cliproxy/providers/tokenrouter",
    payload: { label: "TokenRouter" }
  });
  assert.equal(badBody.statusCode, 400);
  assert.equal(calls.upsert.length, 0, "no manager call for a malformed request");

  const ok = await app.inject({
    method: "PUT",
    url: "/api/cliproxy/providers/tokenrouter",
    payload: {
      label: "TokenRouter",
      baseUrl: "https://api.tokenrouter.com/v1",
      preset: "tokenrouter",
      models: [{ name: "moonshotai/kimi-k3-free" }],
      force: true
    }
  });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().state, "off", "success resolves the full CliProxyStatus");
  assert.equal(calls.upsert.length, 1);
  assert.deepEqual(calls.upsert[0], {
    input: {
      id: "tokenrouter",
      label: "TokenRouter",
      baseUrl: "https://api.tokenrouter.com/v1",
      preset: "tokenrouter",
      models: [{ name: "moonshotai/kimi-k3-free" }]
    },
    force: true
  });
  await app.close();
});

test("router mutations map manager errors to 400/404 and restart refusals to 409", async () => {
  const { manager, results } = fakeRouterRouteManager();
  const app = routerRouteApp("remote", manager);
  await app.ready();

  results.upsert = { ok: false, error: 'provider id "codex" is reserved' };
  const invalid = await app.inject({
    method: "PUT",
    url: "/api/cliproxy/providers/tokenrouter",
    payload: { label: "T", baseUrl: "https://x.example/v1", models: [] }
  });
  assert.equal(invalid.statusCode, 400);
  assert.match(invalid.json().error, /reserved/);

  results.upsert = { ok: false, affectedSessions: 3 };
  const gated = await app.inject({
    method: "PUT",
    url: "/api/cliproxy/providers/tokenrouter",
    payload: { label: "T", baseUrl: "https://x.example/v1", models: [] }
  });
  assert.equal(gated.statusCode, 409);
  assert.equal(gated.json().affectedSessions, 3);

  results.deleteProvider = { ok: false, error: "unknown provider" };
  const missing = await app.inject({ method: "DELETE", url: "/api/cliproxy/providers/nope" });
  assert.equal(missing.statusCode, 404);

  results.setKey = { ok: false, error: "TokenRouter rejected this key" };
  const rejected = await app.inject({
    method: "POST",
    url: "/api/cliproxy/providers/tokenrouter/key",
    payload: { key: "sk-bad" }
  });
  assert.equal(rejected.statusCode, 400);
  assert.match(rejected.json().error, /rejected this key/);

  results.clearKey = { ok: false, affectedSessions: 1 };
  const clearGated = await app.inject({
    method: "DELETE",
    url: "/api/cliproxy/providers/tokenrouter/key"
  });
  assert.equal(clearGated.statusCode, 409);
  assert.equal(clearGated.json().affectedSessions, 1);
  await app.close();
});

test("router key routes require a key and pass force through (body for POST, query for DELETE)", async () => {
  const { manager, calls } = fakeRouterRouteManager();
  const app = routerRouteApp("remote", manager);
  await app.ready();

  const noKey = await app.inject({
    method: "POST",
    url: "/api/cliproxy/providers/tokenrouter/key",
    payload: { key: "   " }
  });
  assert.equal(noKey.statusCode, 400);
  assert.equal(calls.setKey.length, 0);

  const set = await app.inject({
    method: "POST",
    url: "/api/cliproxy/providers/tokenrouter/key",
    payload: { key: "  sk-tr-1  ", force: true }
  });
  assert.equal(set.statusCode, 200);
  assert.deepEqual(set.json(), { ok: true, affectedSessions: 0 });
  assert.deepEqual(calls.setKey, [{ id: "tokenrouter", key: "sk-tr-1", force: true }]);

  const cleared = await app.inject({
    method: "DELETE",
    url: "/api/cliproxy/providers/tokenrouter/key?force=true"
  });
  assert.equal(cleared.statusCode, 200);
  assert.deepEqual(calls.clearKey, [{ id: "tokenrouter", force: true }]);

  const deleted = await app.inject({ method: "DELETE", url: "/api/cliproxy/providers/tokenrouter?force=true" });
  assert.equal(deleted.statusCode, 200);
  assert.deepEqual(calls.deleteProvider, [{ id: "tokenrouter", force: true }]);
  await app.close();
});

test("catalog route maps unknown → 404, no-key → 409, upstream → 502, and is 403 over the socket", async () => {
  const { manager, results, calls } = fakeRouterRouteManager();
  // Unlike the other GETs, the catalog fetch makes an OUTBOUND request with the
  // stored key, so it follows the mutation transport rule: refused on the socket.
  const local = routerRouteApp("local", manager);
  await local.ready();
  assert.equal(
    (await local.inject({ method: "GET", url: "/api/cliproxy/providers/tokenrouter/catalog" })).statusCode,
    403
  );
  await local.close();

  const app = routerRouteApp("remote", manager);
  await app.ready();

  const ok = await app.inject({ method: "GET", url: "/api/cliproxy/providers/tokenrouter/catalog" });
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(ok.json(), { models: ["a/b"] });
  assert.deepEqual(calls.catalog, ["tokenrouter"]);

  results.catalog = { ok: false, code: "unknown", error: "unknown provider" };
  assert.equal(
    (await app.inject({ method: "GET", url: "/api/cliproxy/providers/nope/catalog" })).statusCode,
    404
  );

  results.catalog = { ok: false, code: "no-key", error: "no API key stored for this provider" };
  const noKey = await app.inject({ method: "GET", url: "/api/cliproxy/providers/tokenrouter/catalog" });
  assert.equal(noKey.statusCode, 409);
  assert.match(noKey.json().error, /no API key/);

  results.catalog = { ok: false, code: "upstream", error: "upstream responded 500" };
  const upstream = await app.inject({ method: "GET", url: "/api/cliproxy/providers/tokenrouter/catalog" });
  assert.equal(upstream.statusCode, 502);
  await app.close();
});

test("every router mutation is refused (403) over the unix socket, and the legacy openrouter/key route is gone", async () => {
  const { manager, calls } = fakeRouterRouteManager();
  const app = routerRouteApp("local", manager);
  await app.ready();

  const attempts = [
    await app.inject({
      method: "PUT",
      url: "/api/cliproxy/providers/tokenrouter",
      payload: { label: "T", baseUrl: "https://x.example/v1", models: [] }
    }),
    await app.inject({ method: "DELETE", url: "/api/cliproxy/providers/tokenrouter" }),
    await app.inject({
      method: "POST",
      url: "/api/cliproxy/providers/tokenrouter/key",
      payload: { key: "sk-tr-1" }
    }),
    await app.inject({ method: "DELETE", url: "/api/cliproxy/providers/tokenrouter/key" })
  ];
  for (const res of attempts) {
    assert.equal(res.statusCode, 403);
    assert.match(res.json().error, /HTTP transport/);
  }
  assert.equal(calls.upsert.length + calls.deleteProvider.length + calls.setKey.length + calls.clearKey.length, 0);
  await app.close();

  // The legacy single-provider route is replaced by the generic ones.
  const { manager: m2 } = fakeRouterRouteManager();
  const remote = routerRouteApp("remote", m2);
  await remote.ready();
  const legacy = await remote.inject({
    method: "POST",
    url: "/api/cliproxy/openrouter/key",
    payload: { key: "sk-or-1" }
  });
  assert.equal(legacy.statusCode, 404);
  await remote.close();
});

// --- xAI (Grok) link routes (spec 2026-08-05 §B.2) ---------------------------

test("POST /api/cliproxy/xai/link returns the device prompt, maps conflict → 409 and upstream → 502", async () => {
  const { manager, results, calls } = fakeRouterRouteManager();
  const local = routerRouteApp("local", manager);
  await local.ready();
  const refused = await local.inject({ method: "POST", url: "/api/cliproxy/xai/link" });
  assert.equal(refused.statusCode, 403);
  assert.match(refused.json().error, /HTTP transport/);
  assert.equal(calls.linkXai, 0, "a socket mutation must not reach the manager");
  await local.close();

  const app = routerRouteApp("remote", manager);
  await app.ready();

  const ok = await app.inject({ method: "POST", url: "/api/cliproxy/xai/link" });
  assert.equal(ok.statusCode, 200);
  // The user-facing verification prompt, verbatim — no token material.
  assert.deepEqual(ok.json(), {
    url: "https://x.ai/device",
    userCode: "ABCD-EFGH",
    expiresAt: "2026-08-05T00:30:00Z"
  });
  assert.equal(calls.linkXai, 1);

  results.linkXai = { ok: false, code: "conflict", error: "model proxy must be running" };
  const conflict = await app.inject({ method: "POST", url: "/api/cliproxy/xai/link" });
  assert.equal(conflict.statusCode, 409);
  assert.match(conflict.json().error, /must be running/);

  results.linkXai = { ok: false, code: "upstream", error: "management API responded 500", status: 500 };
  const upstream = await app.inject({ method: "POST", url: "/api/cliproxy/xai/link" });
  assert.equal(upstream.statusCode, 502);
  assert.equal(upstream.json().status, 500);
  await app.close();
});

test("DELETE /api/cliproxy/xai/link passes force through and maps the live-session refusal to 409", async () => {
  const { manager, results, calls } = fakeRouterRouteManager();
  const local = routerRouteApp("local", manager);
  await local.ready();
  assert.equal((await local.inject({ method: "DELETE", url: "/api/cliproxy/xai/link" })).statusCode, 403);
  assert.equal(calls.unlinkXai.length, 0);
  await local.close();

  const app = routerRouteApp("remote", manager);
  await app.ready();

  const ok = await app.inject({ method: "DELETE", url: "/api/cliproxy/xai/link" });
  assert.equal(ok.statusCode, 200);
  // Success resolves the full status the wire contract promises, not the gate result.
  assert.equal(ok.json().xai.state, "none");
  assert.deepEqual(calls.unlinkXai, [{ force: false }]);

  results.unlinkXai = { ok: false, affectedSessions: 2 };
  const refusal = await app.inject({ method: "DELETE", url: "/api/cliproxy/xai/link" });
  assert.equal(refusal.statusCode, 409);
  assert.deepEqual(refusal.json(), { ok: false, affectedSessions: 2 });

  results.unlinkXai = { ok: true, affectedSessions: 2 };
  const forced = await app.inject({ method: "DELETE", url: "/api/cliproxy/xai/link?force=true" });
  assert.equal(forced.statusCode, 200);
  assert.deepEqual(calls.unlinkXai.at(-1), { force: true });
  await app.close();
});
