import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import Fastify, { type FastifyInstance, type LightMyRequestResponse } from "fastify";
import {
  MAX_UPLOAD_BYTES,
  agentProfileRoutes,
  type AgentProfileSnapshot,
  type ProfileMutationResponse
} from "@orquester/api";
import { AgentProfileError, profileErrors } from "./errors.ts";
import { registerAgentProfileRoutes, type AgentProfileRouteDeps } from "./routes.ts";
import { AgentProfileService } from "./service.ts";
import { FakeProfileAdapter, fakeItem } from "./testing.ts";

const roots: string[] = [];
const apps: FastifyInstance[] = [];
after(async () => {
  await Promise.all(apps.map((app) => app.close()));
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

type Service = AgentProfileRouteDeps["service"];
type Call = { method: keyof Service; args: unknown[] };

const SNAPSHOT: AgentProfileSnapshot = {
  agent: "claude",
  installed: true,
  revision: "rev",
  instructions: { path: "/p", exists: false, bytes: 0, lines: 0, revision: "", warnings: [] },
  items: [],
  fileErrors: [],
  readAt: "2026-09-28T12:00:00.000Z"
};
const MUTATION: ProfileMutationResponse = { snapshot: SNAPSHOT, itemIds: ["x"], notes: [] };

interface Harness {
  app: FastifyInstance;
  calls: Call[];
  importsDir: string;
  /** The next service call throws this. */
  failWith(error: unknown): void;
  /** What `scanUpload` saw in its file while it ran. */
  uploaded: { path: string; bytes: string }[];
}

async function harness(options: { scanUploadError?: unknown } = {}): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "orq-profile-routes-"));
  roots.push(root);
  const importsDir = join(root, "tmp", "agent-profile-imports");
  const calls: Call[] = [];
  const uploaded: { path: string; bytes: string }[] = [];
  let failure: unknown;
  const record =
    <T>(method: keyof Service, result: (...args: unknown[]) => T | Promise<T>) =>
    async (...args: unknown[]): Promise<T> => {
      calls.push({ method, args });
      if (failure !== undefined) {
        const error = failure;
        failure = undefined;
        throw error;
      }
      return result(...args);
    };
  const service: Service = {
    overview: record("overview", () => ({ agents: [] })),
    snapshot: record("snapshot", () => SNAPSHOT),
    readItem: record("readItem", () => ({ kind: "hook", item: fakeItem("hook", "h"), hook: { event: "Stop", command: "t" } })),
    create: record("create", () => MUTATION),
    createFromImport: record("createFromImport", () => MUTATION),
    update: record("update", () => MUTATION),
    setEnabled: record("setEnabled", () => MUTATION),
    remove: record("remove", () => MUTATION),
    trust: record("trust", () => MUTATION),
    copy: record("copy", () => MUTATION),
    readInstructions: record("readInstructions", () => ({ text: "hi", info: SNAPSHOT.instructions })),
    writeInstructions: record("writeInstructions", () => MUTATION),
    migrateLegacyInstructions: record("migrateLegacyInstructions", () => MUTATION),
    scanGit: record("scanGit", () => ({ importId: "g", candidates: [], notes: [] })),
    scanUpload: record("scanUpload", async (_agent, _name, path) => {
      uploaded.push({ path: path as string, bytes: await readFile(path as string, "utf8") });
      if (options.scanUploadError !== undefined) throw options.scanUploadError;
      return { importId: "u", candidates: [], notes: [] };
    }),
    assertCanScanUpload: (agent) => {
      calls.push({ method: "assertCanScanUpload", args: [agent] });
      if (failure !== undefined) {
        const error = failure;
        failure = undefined;
        throw error;
      }
    },
    listMarketplacePlugins: record("listMarketplacePlugins", () => [{ name: "p", installed: true }])
  };
  const app = Fastify({ logger: false });
  registerAgentProfileRoutes(app, { service, importsDir });
  await app.ready();
  apps.push(app);
  return {
    app,
    calls,
    importsDir,
    uploaded,
    failWith: (error) => {
      failure = error;
    }
  };
}

function errorOf(response: LightMyRequestResponse): { code: string; message: string } {
  const body = response.json() as { error?: { code: string; message: string } };
  assert.ok(body.error, `expected an error body, got ${response.body}`);
  return body.error;
}

function expectError(response: LightMyRequestResponse, status: number, code: string, message?: RegExp): string {
  assert.equal(response.statusCode, status, response.body);
  const error = errorOf(response);
  assert.equal(error.code, code, error.message);
  if (message) assert.match(error.message, message);
  return error.message;
}

const R = agentProfileRoutes;

// ---------------------------------------------------------------------------
// Every route, happy path
// ---------------------------------------------------------------------------

test("every route reaches its service method with parsed arguments", async () => {
  const h = await harness();
  const cases: Array<{
    method: "GET" | "POST" | "PUT" | "DELETE";
    url: string;
    payload?: unknown;
    status?: number;
    call: Call;
  }> = [
    { method: "GET", url: R.overview, call: { method: "overview", args: [] } },
    { method: "GET", url: R.snapshot("codex"), call: { method: "snapshot", args: ["codex"] } },
    { method: "GET", url: R.item("claude", "command:git/pr"), call: { method: "readItem", args: ["claude", "command:git/pr"] } },
    {
      method: "POST",
      url: R.items("grok"),
      payload: { draft: { kind: "hook", hook: { event: "Stop", command: "echo hi", timeoutSec: 5, extra: 1 } } },
      status: 201,
      call: { method: "create", args: ["grok", { kind: "hook", hook: { event: "Stop", command: "echo hi", timeoutSec: 5 } }, "fail"] }
    },
    {
      method: "POST",
      url: R.items("grok"),
      payload: { import: { importId: "imp", picks: ["skills/a"] }, onConflict: "keep-both" },
      status: 201,
      call: { method: "createFromImport", args: ["grok", "imp", ["skills/a"], "keep-both"] }
    },
    {
      method: "PUT",
      url: R.item("opencode", "skill:review"),
      payload: { revision: "r1", draft: { kind: "skill", document: { name: "review", body: "# Hi\n" } } },
      call: {
        method: "update",
        args: ["opencode", "skill:review", "r1", { kind: "skill", document: { name: "review", frontmatter: {}, body: "# Hi\n" } }]
      }
    },
    {
      method: "DELETE",
      url: `${R.item("claude", "mcp:jira")}?revision=r2`,
      call: { method: "remove", args: ["claude", "mcp:jira", "r2"] }
    },
    {
      method: "POST",
      url: R.itemEnabled("claude", "mcp:jira"),
      payload: { revision: "r3", enabled: false },
      call: { method: "setEnabled", args: ["claude", "mcp:jira", "r3", false] }
    },
    {
      method: "POST",
      url: R.itemTrust("codex", "hook:Stop:0123456789abcdef"),
      payload: { revision: "r4" },
      call: { method: "trust", args: ["codex", "hook:Stop:0123456789abcdef", "r4"] }
    },
    {
      method: "POST",
      url: R.itemCopy("claude", "skill:review"),
      payload: { toAgent: "grok", onConflict: "replace" },
      call: { method: "copy", args: ["claude", "skill:review", "grok", "replace"] }
    },
    { method: "GET", url: R.instructions("grok"), call: { method: "readInstructions", args: ["grok"] } },
    {
      method: "PUT",
      url: R.instructions("grok"),
      payload: { text: "line 1\n\tline 2\n", revision: "" },
      call: { method: "writeInstructions", args: ["grok", "line 1\n\tline 2\n", ""] }
    },
    {
      method: "POST",
      url: R.instructionsMigrateLegacy("grok"),
      payload: { revision: "r5" },
      call: { method: "migrateLegacyInstructions", args: ["grok", "r5"] }
    },
    {
      method: "POST",
      url: R.importGit("claude"),
      payload: { url: " https://github.com/o/r/tree/main/skills " },
      call: { method: "scanGit", args: ["claude", "https://github.com/o/r/tree/main/skills"] }
    },
    {
      method: "GET",
      url: R.marketplacePlugins("claude", "claude-plugins official"),
      call: { method: "listMarketplacePlugins", args: ["claude", "claude-plugins official"] }
    }
  ];
  for (const entry of cases) {
    h.calls.length = 0;
    const response = await h.app.inject({ method: entry.method, url: entry.url, payload: entry.payload as object });
    assert.equal(response.statusCode, entry.status ?? 200, `${entry.method} ${entry.url}: ${response.body}`);
    assert.deepEqual(h.calls, [entry.call], `${entry.method} ${entry.url}`);
  }
  const plugins = await h.app.inject({ method: "GET", url: R.marketplacePlugins("claude", "m") });
  assert.deepEqual(plugins.json(), { plugins: [{ name: "p", installed: true }] });
});

test("an MCP draft keeps only its transport's fields; secret entries pass as set/keep", async () => {
  const h = await harness();
  const response = await h.app.inject({
    method: "POST",
    url: R.items("claude"),
    payload: {
      draft: {
        kind: "mcp",
        mcp: {
          name: "jira",
          transport: "stdio",
          command: "jira-mcp",
          args: ["--flag", "multi\nline"],
          env: [
            { key: "TOKEN", value: "new-secret" },
            { key: "OLD", keep: true }
          ],
          advanced: { timeout: 1000 }
        }
      },
      onConflict: "replace"
    }
  });
  assert.equal(response.statusCode, 201, response.body);
  assert.deepEqual(h.calls[0]!.args, [
    "claude",
    {
      kind: "mcp",
      mcp: {
        name: "jira",
        transport: "stdio",
        command: "jira-mcp",
        args: ["--flag", "multi\nline"],
        env: [
          { key: "TOKEN", value: "new-secret" },
          { key: "OLD", keep: true }
        ],
        advanced: { timeout: 1000 }
      }
    },
    "replace"
  ]);

  h.calls.length = 0;
  const http = await h.app.inject({
    method: "POST",
    url: R.items("claude"),
    payload: {
      draft: {
        kind: "marketplace",
        marketplace: { source: { type: "github", repo: "anthropics/claude-plugins", ref: "main" } }
      }
    }
  });
  assert.equal(http.statusCode, 201, http.body);
  assert.deepEqual(h.calls[0]!.args[1], {
    kind: "marketplace",
    marketplace: { source: { type: "github", repo: "anthropics/claude-plugins", ref: "main" } }
  });
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

test("validation: precise 400s, and nothing reaches the service", async () => {
  const h = await harness();
  const bad: Array<{ method: "POST" | "PUT" | "DELETE"; url: string; payload?: unknown; message: RegExp }> = [
    { method: "POST", url: R.items("claude"), payload: [], message: /must be a JSON object/ },
    { method: "POST", url: R.items("claude"), payload: {}, message: /exactly one of draft or import/ },
    {
      method: "POST",
      url: R.items("claude"),
      payload: { draft: { kind: "skill" }, import: { importId: "i", picks: ["a"] } },
      message: /exactly one of draft or import/
    },
    { method: "POST", url: R.items("claude"), payload: { draft: { kind: "agent" } }, message: /draft\.kind must be one of/ },
    {
      method: "POST",
      url: R.items("claude"),
      payload: { draft: { kind: "mcp", mcp: { name: "x", transport: "stdio", command: "c" } }, onConflict: "merge" },
      message: /onConflict must be one of fail, replace, keep-both/
    },
    {
      method: "POST",
      url: R.items("claude"),
      payload: { draft: { kind: "mcp", mcp: { name: "x", transport: "ws" } } },
      message: /draft\.mcp\.transport must be one of stdio, http, sse/
    },
    {
      method: "POST",
      url: R.items("claude"),
      payload: { draft: { kind: "mcp", mcp: { name: "x", transport: "stdio" } } },
      message: /draft\.mcp\.command must be a string/
    },
    {
      method: "POST",
      url: R.items("claude"),
      payload: { draft: { kind: "mcp", mcp: { name: "x", transport: "http", url: "https://x", env: [] } } },
      message: /draft\.mcp\.env is only for stdio servers/
    },
    {
      method: "POST",
      url: R.items("claude"),
      payload: { draft: { kind: "mcp", mcp: { name: "x", transport: "stdio", command: "c", url: "https://x" } } },
      message: /draft\.mcp\.url is only for http and sse servers/
    },
    {
      method: "POST",
      url: R.items("claude"),
      payload: { draft: { kind: "mcp", mcp: { name: "x", transport: "stdio", command: "c", env: [{ key: "A" }] } } },
      message: /draft\.mcp\.env\[0\] must carry a value or keep: true/
    },
    {
      method: "POST",
      url: R.items("claude"),
      payload: {
        draft: { kind: "mcp", mcp: { name: "x", transport: "stdio", command: "c", env: [{ key: "A", keep: false }] } }
      },
      message: /draft\.mcp\.env\[0\] must carry a value or keep: true/
    },
    {
      method: "POST",
      url: R.items("claude"),
      payload: {
        draft: {
          kind: "mcp",
          mcp: { name: "x", transport: "stdio", command: "c", env: [{ key: "A", value: "v" }, { key: "A", keep: true }] }
        }
      },
      message: /names the key "A" twice/
    },
    {
      method: "POST",
      url: R.items("claude"),
      payload: { draft: { kind: "hook", hook: { event: "Stop", command: "x", timeoutSec: -1 } } },
      message: /draft\.hook\.timeoutSec must be a positive number/
    },
    {
      method: "POST",
      url: R.items("claude"),
      payload: { draft: { kind: "skill", document: { name: "a", frontmatter: [], body: "" } } },
      message: /draft\.document\.frontmatter must be an object/
    },
    {
      method: "POST",
      url: R.items("claude"),
      payload: { draft: { kind: "skill", document: { name: "a\nb", body: "" } } },
      message: /draft\.document\.name must not contain control characters/
    },
    {
      method: "POST",
      url: R.items("claude"),
      payload: { draft: { kind: "plugin", plugin: { plugin: "p", marketplace: "m", spec: "s" } } },
      message: /draft\.plugin must be \{plugin, marketplace\} or \{spec\}/
    },
    {
      method: "POST",
      url: R.items("claude"),
      payload: { draft: { kind: "marketplace", marketplace: { source: { type: "github", repo: "not a repo" } } } },
      message: /draft\.marketplace\.source\.repo must be owner\/repo/
    },
    {
      method: "POST",
      url: R.items("claude"),
      payload: { import: { importId: "i", picks: [] } },
      message: /import\.picks must not be empty/
    },
    {
      method: "PUT",
      url: R.item("claude", "mcp:x"),
      payload: { draft: { kind: "mcp", mcp: { name: "x", transport: "stdio", command: "c" } } },
      message: /revision is required/
    },
    { method: "DELETE", url: R.item("claude", "mcp:x"), message: /revision query parameter is required/ },
    {
      method: "POST",
      url: R.itemEnabled("claude", "mcp:x"),
      payload: { revision: "r", enabled: "no" },
      message: /enabled must be true or false/
    },
    { method: "POST", url: R.itemTrust("codex", "hook:x"), payload: { revision: 3 }, message: /revision must be a string/ },
    { method: "POST", url: R.itemCopy("claude", "skill:x"), payload: { toAgent: "gemini" }, message: /toAgent must be one of/ },
    { method: "PUT", url: R.instructions("claude"), payload: { text: "x" }, message: /revision must be a string/ },
    { method: "POST", url: R.importGit("claude"), payload: { url: "  " }, message: /url is required/ }
  ];
  for (const entry of bad) {
    const response = await h.app.inject({ method: entry.method, url: entry.url, payload: entry.payload as object });
    expectError(response, 400, "INVALID_REQUEST", entry.message);
  }
  assert.deepEqual(h.calls, []);
});

test("validation: an unknown agent in the path is 404 UNKNOWN_AGENT", async () => {
  const h = await harness();
  for (const url of ["/api/agent-profile/gemini", "/api/agent-profile/gemini/items", "/api/agent-profile/gemini/instructions"]) {
    const response = await h.app.inject({ method: url.endsWith("/items") ? "POST" : "GET", url, payload: {} });
    expectError(response, 404, "UNKNOWN_AGENT", /gemini/);
  }
  assert.deepEqual(h.calls, []);
});

test("validation: no refusal quotes a secret value, a git URL or an unparsable body", async () => {
  const h = await harness();
  const secret = "sk-live-TOPSECRET";
  const responses = [
    await h.app.inject({
      method: "POST",
      url: R.items("claude"),
      payload: {
        draft: {
          kind: "mcp",
          mcp: { name: "x", transport: "stdio", command: "c", env: [{ key: "T", value: secret, keep: true }] }
        }
      }
    }),
    await h.app.inject({
      method: "POST",
      url: R.items("claude"),
      payload: { draft: { kind: "mcp", mcp: { name: "x", transport: "stdio", command: "c", env: [{ key: "T", value: 42 }] } } }
    }),
    await h.app.inject({
      method: "POST",
      url: R.importGit("claude"),
      payload: { url: `https://user:${secret}@example.com/${"x".repeat(5000)}` }
    }),
    await h.app.inject({
      method: "POST",
      url: R.items("claude"),
      headers: { "content-type": "application/json" },
      payload: `{"draft": {"kind": "mcp", "mcp": {"env": [{"key": "T", "value": ${secret}}]}}}`
    })
  ];
  for (const response of responses) {
    assert.equal(response.statusCode, 400, response.body);
    assert.equal(errorOf(response).code, "INVALID_REQUEST");
    assert.ok(!response.body.includes(secret), response.body);
  }
  assert.match(errorOf(responses[3]!).message, /not valid JSON/);
  assert.deepEqual(h.calls, []);
});

test("a JSON body over the route limit is 413 in the module's error shape", async () => {
  const h = await harness();
  const response = await h.app.inject({
    method: "PUT",
    url: R.instructions("claude"),
    payload: { text: "x".repeat(4 * 1024 * 1024 + 10), revision: "" }
  });
  expectError(response, 413, "INVALID_REQUEST", /larger than 4 MiB/);
});

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

test("an AgentProfileError answers its own status and code; anything else is a generic 500", async () => {
  const h = await harness();
  h.failWith(profileErrors.conflict());
  expectError(
    await h.app.inject({ method: "POST", url: R.itemEnabled("claude", "mcp:x"), payload: { revision: "r", enabled: true } }),
    409,
    "PROFILE_CONFLICT"
  );
  h.failWith(profileErrors.locked("agent-hook"));
  expectError(await h.app.inject({ method: "DELETE", url: `${R.item("claude", "hook:x")}?revision=r` }), 403, "ITEM_LOCKED");
  h.failWith(profileErrors.cliFailed("claude plugin install", "exit 1"));
  expectError(await h.app.inject({ method: "GET", url: R.snapshot("claude") }), 502, "AGENT_CLI_FAILED");
  h.failWith(new AgentProfileError(503, "AGENT_PROFILE_ERROR", "Imports are not available yet."));
  expectError(
    await h.app.inject({ method: "POST", url: R.importGit("claude"), payload: { url: "https://x" } }),
    503,
    "AGENT_PROFILE_ERROR",
    /Imports are not available yet/
  );
  h.failWith(new Error("ENOENT /home/daemon/.claude.json token=abc"));
  const response = await h.app.inject({ method: "GET", url: R.overview });
  const message = expectError(response, 500, "AGENT_PROFILE_ERROR");
  assert.ok(!message.includes("token=abc"));
});

test("against the real service: not installed, kind checks and name rules come back as their codes", async () => {
  const root = await mkdtemp(join(tmpdir(), "orq-profile-routes-real-"));
  roots.push(root);
  const claude = new FakeProfileAdapter("claude");
  claude.items = [fakeItem("mcp", "jira")];
  const service = new AgentProfileService({
    adapters: { claude, codex: new FakeProfileAdapter("codex") },
    agentInfo: (agent) => ({ installed: agent === "claude" || agent === "codex" }),
    logger: { warn: () => undefined, error: () => undefined }
  });
  const app = Fastify({ logger: false });
  registerAgentProfileRoutes(app, { service, importsDir: join(root, "imports") });
  await app.ready();
  apps.push(app);

  const grok = await app.inject({ method: "GET", url: R.snapshot("grok") });
  assert.equal(grok.statusCode, 200);
  assert.equal((grok.json() as AgentProfileSnapshot).installed, false);
  expectError(await app.inject({ method: "GET", url: R.instructions("grok") }), 404, "AGENT_NOT_INSTALLED");
  expectError(
    await app.inject({
      method: "POST",
      url: R.items("codex"),
      payload: { draft: { kind: "command", document: { name: "x", frontmatter: {}, body: "" } } }
    }),
    400,
    "KIND_NOT_SUPPORTED"
  );
  expectError(
    await app.inject({
      method: "POST",
      url: R.items("claude"),
      payload: { draft: { kind: "mcp", mcp: { name: "has space", transport: "stdio", command: "c" } } }
    }),
    400,
    "INVALID_NAME"
  );
  expectError(
    await app.inject({ method: "POST", url: R.itemEnabled("claude", "mcp:jira"), payload: { revision: "stale", enabled: false } }),
    409,
    "PROFILE_CONFLICT"
  );
  const ok = await app.inject({
    method: "POST",
    url: R.itemEnabled("claude", "mcp:jira"),
    payload: { revision: "rev-jira", enabled: false }
  });
  assert.equal(ok.statusCode, 200, ok.body);
  const body = ok.json() as ProfileMutationResponse;
  assert.deepEqual(body.itemIds, ["mcp:jira"]);
  assert.equal(body.snapshot.items[0]!.enabled, false);
  expectError(
    await app.inject({ method: "POST", url: R.importUpload("claude") + "?name=a.zip", headers: { "content-type": "application/octet-stream" }, payload: Buffer.from("zip") }),
    503,
    "AGENT_PROFILE_ERROR"
  );
  await service.stop();
});

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

test("upload: the octet-stream body is streamed to a temp file under the imports dir, scanned, then removed", async () => {
  const h = await harness();
  const response = await h.app.inject({
    method: "POST",
    url: `${R.importUpload("opencode")}?name=my-skill.zip`,
    headers: { "content-type": "application/octet-stream" },
    payload: Buffer.from("PK fake zip bytes")
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json(), { importId: "u", candidates: [], notes: [] });
  assert.deepEqual(
    h.calls.map((call) => call.method),
    ["assertCanScanUpload", "scanUpload"]
  );
  assert.deepEqual(h.calls[1]!.args.slice(0, 2), ["opencode", "my-skill.zip"]);
  const [seen] = h.uploaded;
  assert.ok(seen);
  assert.equal(seen.bytes, "PK fake zip bytes");
  assert.ok(seen.path.startsWith(h.importsDir), "streamed under agentProfileImportsDir");
  assert.deepEqual(await readdir(h.importsDir), [], "the temp file is gone after the scan");
});

test("upload: the temp file is removed when the scan fails too", async () => {
  const h = await harness({ scanUploadError: profileErrors.importFailed("The zip holds no SKILL.md.") });
  const response = await h.app.inject({
    method: "POST",
    url: `${R.importUpload("claude")}?name=x.md`,
    headers: { "content-type": "application/octet-stream" },
    payload: "---\nname: x\n---\n"
  });
  expectError(response, 400, "IMPORT_FAILED", /no SKILL\.md/);
  assert.equal(h.uploaded[0]?.bytes, "---\nname: x\n---\n", "the scan saw the whole body");
  assert.deepEqual(await readdir(h.importsDir), []);
});

test("upload refusals before the body is read answer Connection: close and never reach the scan", async () => {
  const h = await harness();
  const upload = (query: string, headers: Record<string, string>, payload: string | Buffer = "x") =>
    h.app.inject({ method: "POST", url: `${R.importUpload("claude")}${query}`, headers, payload });
  const octet = { "content-type": "application/octet-stream" };

  const missingName = await upload("", octet);
  expectError(missingName, 400, "INVALID_REQUEST", /name query parameter/);
  assert.equal(missingName.headers.connection, "close");

  expectError(await upload("?name=../x.zip", octet), 400, "INVALID_REQUEST", /file name, not a path/);
  expectError(await upload("?name=a%2Fb.zip", octet), 400, "INVALID_REQUEST", /file name, not a path/);

  const wrongType = await upload("?name=x.zip", { "content-type": "application/json" }, "{}");
  expectError(wrongType, 415, "INVALID_REQUEST", /application\/octet-stream/);

  h.failWith(new AgentProfileError(503, "AGENT_PROFILE_ERROR", "Imports are not available yet."));
  const unavailable = await upload("?name=x.zip", octet);
  expectError(unavailable, 503, "AGENT_PROFILE_ERROR");
  assert.equal(unavailable.headers.connection, "close");

  const oversize = await upload("?name=x.zip", { ...octet, "content-length": String(MAX_UPLOAD_BYTES + 1) }, "tiny");
  expectError(oversize, 413, "UPLOAD_TOO_LARGE");
  assert.equal(oversize.headers.connection, "close");

  const unknown = await h.app.inject({
    method: "POST",
    url: "/api/agent-profile/gemini/imports/upload?name=x.zip",
    headers: octet,
    payload: "x"
  });
  expectError(unknown, 404, "UNKNOWN_AGENT");

  assert.ok(!h.calls.some((call) => call.method === "scanUpload"));
  assert.deepEqual(h.uploaded, []);
});

test("only the upload route accepts an octet-stream body", async () => {
  const h = await harness();
  const response = await h.app.inject({
    method: "POST",
    url: R.items("claude"),
    headers: { "content-type": "application/octet-stream" },
    payload: Buffer.from("bytes")
  });
  expectError(response, 415, "INVALID_REQUEST", /application\/json/);
  assert.deepEqual(h.calls, []);
});
