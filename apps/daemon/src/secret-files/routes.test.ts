import assert from "node:assert/strict";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import Fastify, { type InjectOptions, type LightMyRequestResponse } from "fastify";
import { secretFilesRoutes, type SecretVaultResponse, type SecretVaultsResponse } from "@orquester/api";
import { PRINCIPAL_TOKEN_HEADER } from "@orquester/api/agent-chat";
import { createDefaultClientConfig, createDefaultDaemonConfig } from "@orquester/config";
import { createServer } from "../index.ts";
import { mintPrincipalToken } from "../mcp/principal.ts";
import { registerSecretFilesRoutes } from "./routes.ts";
import { REPO, WS, makeHarness, root, type Harness } from "./test-fakes.ts";

// Route-level coverage for /api/secret-files: statuses, the `{ code, message }` envelope, the
// plugin gate, the principal, the bearer on the remote transport, and no secret in any body.
// Inject only — nothing listens; the service runs over the in-memory fakes.

const q = (params: Record<string, string>): string => `?${new URLSearchParams(params).toString()}`;
const vaultQuery = q({ workspace: WS, repoKey: REPO });

async function harness(t: TestContext, options: { enabled?: boolean } = {}) {
  const h = await makeHarness(options);
  const logs: string[] = [];
  const app = Fastify();
  registerSecretFilesRoutes(app, { service: h.service, logger: { warn: (m) => logs.push(m), error: (m) => logs.push(m) } });
  t.after(async () => {
    await app.close();
    await h.service.stop();
  });
  return { h, logs, inject: (request: InjectOptions) => app.inject(request) };
}

function refused(response: LightMyRequestResponse, status: number, code: string): void {
  assert.equal(response.statusCode, status, response.body);
  const body = response.json() as { code: string; message: string };
  assert.equal(body.code, code);
  assert.equal(typeof body.message, "string");
  assert.ok(body.message.length > 0);
}

async function seed(h: Harness): Promise<{ a: string; b: string }> {
  const a = h.clone("a");
  const b = h.clone("b");
  h.fs.put(`${a}/.env`, "KEY=one\n");
  h.fs.put(`${b}/.env`, "KEY=two\n");
  return { a, b };
}

test("setup, read, push, reset, compare and delete answer the contract's shapes", async (t) => {
  const { h, inject } = await harness(t);
  const { a, b } = await seed(h);

  const setup = await inject({
    method: "POST",
    url: secretFilesRoutes.setup,
    payload: { workspace: WS, repoKey: REPO, files: [{ path: ".env", source: { projectPath: a } }], excluded: [] }
  });
  assert.equal(setup.statusCode, 200, setup.body);
  const vault = (setup.json() as SecretVaultResponse).vault;
  assert.equal(vault.workspace, WS);
  assert.equal(vault.clones.find((clone) => clone.projectPath === b)?.files[0]?.state, "modified");

  const list = (await inject({ method: "GET", url: secretFilesRoutes.list })).json() as SecretVaultsResponse;
  assert.deepEqual(list.vaults, [
    { workspace: WS, repoKey: REPO, fileCount: 1, clonesNeedingAttention: 1, newCandidates: 0, updatedAt: vault.updatedAt }
  ]);
  const got = await inject({ method: "GET", url: `${secretFilesRoutes.vault}${vaultQuery}` });
  assert.deepEqual((got.json() as SecretVaultResponse).vault, vault);

  const compare = await inject({ method: "GET", url: `${secretFilesRoutes.compare}${q({ workspace: WS, repoKey: REPO, projectPath: b, path: ".env" })}` });
  assert.deepEqual(compare.json(), { path: ".env", compare: { format: "env", keys: [{ key: "KEY", change: "changed" }] } });

  const candidates = await inject({ method: "GET", url: `${secretFilesRoutes.candidates}${vaultQuery}` });
  assert.equal(candidates.statusCode, 200);

  const files = await inject({ method: "PUT", url: secretFilesRoutes.files, payload: { workspace: WS, repoKey: REPO, exclude: [".env.local"] } });
  assert.deepEqual((files.json() as SecretVaultResponse).vault.excluded, [".env.local"]);

  const pushed = await inject({ method: "POST", url: secretFilesRoutes.push, payload: { workspace: WS, repoKey: REPO, projectPath: b } });
  assert.equal(pushed.statusCode, 200, pushed.body);
  assert.equal(h.fs.read(`${a}/.env`), "KEY=two\n");
  refused(await inject({ method: "POST", url: secretFilesRoutes.push, payload: { workspace: WS, repoKey: REPO, projectPath: b } }), 409, "NOTHING_TO_PUSH");

  h.fs.put(`${a}/.env`, "KEY=three\n");
  const reset = await inject({ method: "POST", url: secretFilesRoutes.reset, payload: { workspace: WS, repoKey: REPO, projectPath: a, files: [".env"] } });
  assert.equal(reset.statusCode, 200, reset.body);
  assert.equal(h.fs.read(`${a}/.env`), "KEY=two\n");

  const deleted = await inject({ method: "DELETE", url: `${secretFilesRoutes.vault}${vaultQuery}` });
  assert.equal(deleted.statusCode, 204);
  assert.equal(deleted.body, "");
  refused(await inject({ method: "GET", url: `${secretFilesRoutes.vault}${vaultQuery}` }), 404, "VAULT_NOT_FOUND");
  refused(await inject({ method: "DELETE", url: `${secretFilesRoutes.vault}${vaultQuery}` }), 404, "VAULT_NOT_FOUND");
});

test("validation: workspace, repoKey, paths, clones and bodies are refused with their codes", async (t) => {
  const { h, inject } = await harness(t);
  const { a } = await seed(h);
  await h.service.setup({ workspace: WS, repoKey: REPO, files: [{ path: ".env", source: { projectPath: a } }], excluded: [] });

  refused(await inject({ method: "GET", url: `${secretFilesRoutes.vault}${q({ workspace: ".hidden", repoKey: REPO })}` }), 400, "INVALID_REQUEST");
  refused(await inject({ method: "GET", url: `${secretFilesRoutes.vault}${q({ workspace: WS, repoKey: "/etc/passwd" })}` }), 400, "INVALID_REQUEST");
  refused(await inject({ method: "GET", url: secretFilesRoutes.vault }), 400, "INVALID_REQUEST");
  refused(await inject({ method: "GET", url: `${secretFilesRoutes.vault}${q({ workspace: "nope", repoKey: REPO })}` }), 404, "VAULT_NOT_FOUND");
  refused(await inject({ method: "GET", url: `${secretFilesRoutes.candidates}${q({ workspace: WS, repoKey: REPO, path: "a/../b" })}` }), 400, "INVALID_PATH");
  refused(
    await inject({ method: "GET", url: `${secretFilesRoutes.compare}${q({ workspace: WS, repoKey: REPO, projectPath: a, path: ".git/config" })}` }),
    400,
    "INVALID_PATH"
  );
  refused(
    await inject({ method: "GET", url: `${secretFilesRoutes.compare}${q({ workspace: WS, repoKey: REPO, projectPath: a, path: "x.env" })}` }),
    400,
    "FILE_NOT_MANAGED"
  );
  for (const projectPath of ["/ws/other/a", "/tmp", "", root("a", "other")]) {
    refused(await inject({ method: "POST", url: secretFilesRoutes.push, payload: { workspace: WS, repoKey: REPO, projectPath } }), 400, "INVALID_CLONE");
  }
  refused(await inject({ method: "POST", url: secretFilesRoutes.push, payload: [1, 2] }), 400, "INVALID_REQUEST");
  refused(await inject({ method: "POST", url: secretFilesRoutes.push, payload: { workspace: WS, repoKey: REPO, projectPath: a, files: ".env" } }), 400, "INVALID_REQUEST");
  refused(await inject({ method: "POST", url: secretFilesRoutes.setup, payload: { workspace: WS, repoKey: REPO, files: [{ path: "/abs", source: { projectPath: a } }] } }), 400, "INVALID_PATH");
  refused(await inject({ method: "POST", url: secretFilesRoutes.setup, payload: { workspace: WS, repoKey: REPO, files: [{ path: ".env.x" }] } }), 400, "INVALID_REQUEST");
  refused(await inject({ method: "POST", url: secretFilesRoutes.setup, payload: { workspace: WS, repoKey: REPO } }), 400, "INVALID_REQUEST");
  refused(await inject({ method: "PUT", url: secretFilesRoutes.files, payload: { workspace: WS, repoKey: REPO, unmanage: ["x.env"] } }), 400, "FILE_NOT_MANAGED");
});

test("plugin off: mutations 409 SECRET_FILES_DISABLED, reads 200; an unreadable store 503; other failures a fixed 500", async (t) => {
  const { h, inject, logs } = await harness(t);
  const { a, b } = await seed(h);
  await h.service.setup({ workspace: WS, repoKey: REPO, files: [{ path: ".env", source: { projectPath: a } }], excluded: [] });
  h.plugin.set(false);
  await h.settle();

  for (const request of [
    { method: "POST", url: secretFilesRoutes.setup, payload: { workspace: WS, repoKey: REPO, files: [], excluded: [] } },
    { method: "PUT", url: secretFilesRoutes.files, payload: { workspace: WS, repoKey: REPO, exclude: [".env.local"] } },
    { method: "POST", url: secretFilesRoutes.push, payload: { workspace: WS, repoKey: REPO, projectPath: b } },
    { method: "POST", url: secretFilesRoutes.reset, payload: { workspace: WS, repoKey: REPO, projectPath: b } },
    { method: "DELETE", url: `${secretFilesRoutes.vault}${vaultQuery}` }
  ] as InjectOptions[]) {
    refused(await inject(request), 409, "SECRET_FILES_DISABLED");
  }
  for (const url of [
    secretFilesRoutes.list,
    `${secretFilesRoutes.vault}${vaultQuery}`,
    `${secretFilesRoutes.candidates}${vaultQuery}`,
    `${secretFilesRoutes.compare}${q({ workspace: WS, repoKey: REPO, projectPath: b, path: ".env" })}`
  ]) {
    assert.equal((await inject({ method: "GET", url })).statusCode, 200, url);
  }

  h.plugin.set(true);
  await h.settle();
  h.store.writable = false;
  refused(await inject({ method: "POST", url: secretFilesRoutes.push, payload: { workspace: WS, repoKey: REPO, projectPath: b } }), 503, "SECRET_FILES_UNAVAILABLE");
  h.store.writable = true;

  // A failure the service doesn't know: a fixed message, and only its kind is logged.
  const failing = h.projects.splice(0);
  const broken = await makeHarness({
    overrides: {
      listProjects: async () => {
        throw new Error("boom SUPERSECRET_IN_ERROR");
      }
    }
  });
  t.after(() => broken.service.stop());
  const app = Fastify();
  const brokenLogs: string[] = [];
  registerSecretFilesRoutes(app, { service: broken.service, logger: { warn: (m) => brokenLogs.push(m), error: (m) => brokenLogs.push(m) } });
  t.after(() => app.close());
  const response = await app.inject({ method: "GET", url: `${secretFilesRoutes.candidates}${vaultQuery}` });
  refused(response, 500, "SECRET_FILES_ERROR");
  assert.doesNotMatch(response.body + JSON.stringify(brokenLogs) + JSON.stringify(logs), /SUPERSECRET/);
  h.projects.push(...failing);
});

test("the daemon serves the routes on both transports with one service; the remote one requires the bearer", async (t) => {
  const h = await makeHarness();
  const { a, b } = await seed(h);
  await h.service.setup({ workspace: WS, repoKey: REPO, files: [{ path: ".env", source: { projectPath: a } }], excluded: [] });
  const dir = await mkdtemp(join(tmpdir(), "orquester-secret-files-server-"));
  type Args = Parameters<typeof createServer>;
  const passwordHash = "$2a$12$0123456789012345678901uFAKEfakeFAKEfakeFAKEfa";
  const bearer = `Bearer ${Buffer.from(`admin:${passwordHash}`).toString("base64")}`;
  const config = createDefaultDaemonConfig({ env: {} });
  config.transports.http.username = "admin";
  config.transports.http.passwordHash = passwordHash;
  const build = (options: Args[5]) =>
    createServer(
      config,
      { daemonDir: dir, workspacesDir: dir, fsRoot: dir } as unknown as Args[1],
      createDefaultClientConfig(join(dir, "daemon.sock")),
      createWriteStream("/dev/null"),
      { secretFiles: h.service } as unknown as Args[4],
      options
    );
  const local = build({ authRequired: false, mode: "local" });
  const remote = build({ authRequired: true, mode: "remote" });
  t.after(async () => {
    await local.close();
    await remote.close();
    await h.service.stop();
    await rm(dir, { recursive: true, force: true });
  });

  assert.equal((await local.inject({ method: "GET", url: secretFilesRoutes.list })).statusCode, 200);
  for (const request of [
    { method: "GET", url: secretFilesRoutes.list },
    { method: "GET", url: `${secretFilesRoutes.vault}${vaultQuery}&token=${encodeURIComponent(bearer.slice(7))}` },
    { method: "POST", url: secretFilesRoutes.push, payload: { workspace: WS, repoKey: REPO, projectPath: b } }
  ] as InjectOptions[]) {
    assert.equal((await remote.inject(request)).statusCode, 401, request.url as string);
  }
  const authed = await remote.inject({ method: "GET", url: `${secretFilesRoutes.vault}${vaultQuery}`, headers: { authorization: bearer } });
  assert.equal(authed.statusCode, 200);

  // An in-chat agent's push (a server-stamped principal) is stamped with its thread.
  const minted = mintPrincipalToken({ kind: "agent", threadId: "thread-42", projectPath: b });
  try {
    const pushed = await local.inject({
      method: "POST",
      url: secretFilesRoutes.push,
      headers: { [PRINCIPAL_TOKEN_HEADER]: minted.token },
      payload: { workspace: WS, repoKey: REPO, projectPath: b }
    });
    assert.equal(pushed.statusCode, 200, pushed.body);
    assert.deepEqual((pushed.json() as SecretVaultResponse).vault.files[0]?.updatedBy, { kind: "agent", threadId: "thread-42", projectName: "b" });
  } finally {
    minted.release();
  }
  // The same service answers on the other transport.
  const fromRemote = await remote.inject({ method: "GET", url: `${secretFilesRoutes.vault}${vaultQuery}`, headers: { authorization: bearer } });
  assert.equal((fromRemote.json() as SecretVaultResponse).vault.files[0]?.updatedBy.kind, "agent");
});

test("no route body ever carries a secret value or content hash", async (t) => {
  const SECRET = "sk_live_SUPERSECRET_route_5xq";
  const { h, inject, logs } = await harness(t);
  const a = h.clone("a");
  const b = h.clone("b");
  h.fs.put(`${a}/.env`, `TOKEN=${SECRET}\nB=1\n`);
  h.fs.put(`${b}/.env`, `TOKEN=${SECRET}-b\n`);
  h.fs.put(`${a}/conf.txt`, `password ${SECRET}\n`);
  const bodies: string[] = [];
  const call = async (request: InjectOptions) => bodies.push((await inject(request)).body);
  await call({ method: "GET", url: `${secretFilesRoutes.candidates}${vaultQuery}` });
  await call({ method: "GET", url: `${secretFilesRoutes.candidates}${q({ workspace: WS, repoKey: REPO, path: "conf.txt" })}` });
  await call({ method: "POST", url: secretFilesRoutes.setup, payload: { workspace: WS, repoKey: REPO, files: [{ path: "conf.txt", source: { merge: true, primary: a } }], excluded: [] } });
  await call({ method: "POST", url: secretFilesRoutes.setup, payload: { workspace: WS, repoKey: REPO, files: [{ path: ".env", source: { merge: true, primary: a } }, { path: "conf.txt", source: { projectPath: a } }], excluded: [] } });
  await call({ method: "GET", url: `${secretFilesRoutes.compare}${q({ workspace: WS, repoKey: REPO, projectPath: b, path: ".env" })}` });
  await call({ method: "GET", url: `${secretFilesRoutes.compare}${q({ workspace: WS, repoKey: REPO, projectPath: b, path: "conf.txt" })}` });
  await call({ method: "POST", url: secretFilesRoutes.push, payload: { workspace: WS, repoKey: REPO, projectPath: b } });
  await call({ method: "GET", url: secretFilesRoutes.list });
  await call({ method: "GET", url: `${secretFilesRoutes.vault}${vaultQuery}` });
  const everything = JSON.stringify({ bodies, events: h.events, logs });
  assert.doesNotMatch(everything, /SUPERSECRET/);
  for (const hash of h.store.blobs.keys()) assert.ok(!everything.includes(hash), "a content hash leaked");
});
