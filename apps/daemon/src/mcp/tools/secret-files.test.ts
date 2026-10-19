/**
 * `secret_files_status` and `push_secret_files` (secret files spec §8) through the executor, against a fake DaemonApi:
 * the status of the chat's own project, a named one, no vault, the plugin off; the push refused before any card (no
 * project, no repo, no vault, nothing modified, an unmanaged path, the plugin off); its card (repo, source clone, each
 * file's variable names, the clones it overwrites, a warning; never grantable), approve / deny, a stale preview, and the
 * request it sends (body and the chat's principal). A planted value the fake routes slip into extra fields never
 * reaches a result or a card.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { CallerPrincipal } from "@orquester/api/agent-chat";
import type { ProjectSummary, SecretFileCompare, SecretFileState, SecretVaultDetail } from "@orquester/api";

import { FakeApprovalPort } from "../catalog/approval-double.ts";
import type { ThreadCaller } from "../catalog/contract.ts";
import type { DaemonMethod, DaemonRequestOptions, DaemonResponse } from "../daemon-api.ts";
import { executeToolCall } from "../executor.ts";
import { FakeDaemonApi } from "../testing.ts";

/** A value no result or card may ever carry. */
const PLANTED = "sk-live-PLANTED-VALUE-0042";
const REPO = "github.com/acme/api";

/** The fake API, also recording each request's principal (the executor binds it). */
class PrincipalApi extends FakeDaemonApi {
  principals: Array<{ method: DaemonMethod; path: string; principal?: CallerPrincipal }> = [];
  override async request(method: DaemonMethod, path: string, opts?: DaemonRequestOptions): Promise<DaemonResponse> {
    this.principals.push({ method, path, ...(opts?.principal ? { principal: opts.principal } : {}) });
    return super.request(method, path, opts);
  }
}

type Clones = Record<string, Record<string, SecretFileState>>;

function vaultOf(root: string, clones: Clones, version = "v1"): SecretVaultDetail {
  const paths = [".env", "config/creds.json", "apps/web/.env.local"];
  return {
    workspace: "acme", repoKey: REPO, fileCount: paths.length, clonesNeedingAttention: 1, newCandidates: 1, updatedAt: "2026-10-19T10:00:00.000Z",
    // `content` is no field of the contract: a route that sent one by mistake must still not leak it.
    files: paths.map((path) => ({ path, version: `${version}-${path}`, updatedAt: "2026-10-19T10:00:00.000Z", updatedBy: { kind: "user" }, content: PLANTED }) as never),
    excluded: [], candidates: [".env.test"],
    clones: Object.entries(clones).map(([name, files]) => ({
      projectPath: join(root, "acme", name), projectName: name,
      files: Object.entries(files).map(([path, state]) => ({ path, state, ...(state === "refused" ? { refusal: "tracked" as const } : {}) })),
      needsAttention: Object.values(files).some((state) => ["modified", "deleted", "missing-dir", "refused"].includes(state))
    }))
  };
}

const BEFORE: Clones = {
  api: { ".env": "modified", "config/creds.json": "modified", "apps/web/.env.local": "synced" },
  "api-2": { ".env": "synced", "config/creds.json": "outdated", "apps/web/.env.local": "synced" },
  "api-3": { ".env": "modified", "config/creds.json": "missing-dir", "apps/web/.env.local": "refused" }
};
const AFTER: Clones = {
  api: { ".env": "synced", "config/creds.json": "synced", "apps/web/.env.local": "synced" },
  "api-2": { ".env": "synced", "config/creds.json": "synced", "apps/web/.env.local": "synced" },
  "api-3": { ".env": "modified", "config/creds.json": "missing-dir", "apps/web/.env.local": "refused" }
};

const ENV_COMPARE: SecretFileCompare = {
  format: "env",
  // `value` is no field of the contract: a route that sent one by mistake must still not leak it.
  keys: ([
    { key: "API_TOKEN", change: "changed" }, { key: "NEW_FLAG", change: "added" }, { key: "OLD_URL", change: "removed" }, { key: "PORT", change: "same" }
  ] as const).map((entry) => ({ ...entry, value: PLANTED }))
};

async function rig(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "mcp-secret-files-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const dir of ["acme/api", "acme/api-2", "acme/api-3", "acme/plain", "beta/api"]) await mkdir(join(root, dir), { recursive: true });
  const api = new PrincipalApi(); api.fsRoot = root; api.workspacesDir = root;
  const row = (workspace: string, name: string, repo = true): ProjectSummary => ({
    workspace, name, path: join(root, workspace, name), ...(repo ? { repoKey: REPO, repoName: "acme/api" } : {})
  });
  const state = { enabled: true, vault: vaultOf(root, BEFORE), after: vaultOf(root, AFTER, "v2"), envCompare: ENV_COMPARE };
  api
    .on("GET", "/api/workspaces/acme/projects", { status: 200, body: [row("acme", "api"), row("acme", "api-2"), row("acme", "api-3"), row("acme", "plain", false)] })
    .on("GET", "/api/workspaces/beta/projects", { status: 200, body: [row("beta", "api")] })
    .on("GET", "/api/plugins", () => ({ status: 200, body: { plugins: [{ id: "secret-files", enabled: state.enabled }] } }))
    .on("GET", "/api/secret-files/vault", ({ query }) =>
      query?.workspace === "acme" && query.repoKey === REPO
        ? { status: 200, body: { vault: state.vault } }
        : { status: 404, body: { code: "VAULT_NOT_FOUND", message: "No vault." } })
    .on("GET", "/api/secret-files/compare", ({ query }) => ({
      status: 200,
      body: {
        path: query?.path,
        compare: query?.path === ".env" ? state.envCompare : { format: "lines", linesAdded: 3, linesRemoved: 1, text: PLANTED },
        content: PLANTED
      }
    }))
    .on("POST", "/api/secret-files/push", () => ({ status: 200, body: { vault: state.after } }));
  const chat = (name: string | null, over: Partial<ThreadCaller> = {}): ThreadCaller => {
    const projectPath = name === null ? "" : join(root, name.split("/")[0]!, name.split("/")[1]!);
    return {
      kind: "thread", threadId: "thread-1", title: "Env fix", projectPath, workspace: name === null ? "" : name.split("/")[0]!, cwd: projectPath || root,
      agentId: "claude", callId: "c1", runtimeMode: "full-access", planning: false, workflowOwned: false, exchange: null, ...over
    };
  };
  const exec = (name: string, args: Record<string, unknown>, opts: { who?: ThreadCaller; port?: FakeApprovalPort } = {}): Promise<CallToolResult> =>
    executeToolCall({ approvals: opts.port ?? null, now: () => 0 }, { name, arguments: args }, { caller: opts.who ?? { kind: "external" }, api, signal: new AbortController().signal });
  return { root, api, state, chat, exec };
}

function ok(result: CallToolResult): Record<string, any> {
  assert.ok(!result.isError, JSON.stringify(result.structuredContent));
  assert.ok(!JSON.stringify(result).includes(PLANTED), "a result carries a secret value");
  return result.structuredContent as Record<string, any>;
}

function refused(result: CallToolResult, code: string): string {
  assert.equal(result.isError, true, JSON.stringify(result.structuredContent));
  const record = result.structuredContent as { code: string; message: string };
  assert.equal(record.code, code, record.message);
  return record.message;
}

const pushes = (api: PrincipalApi) => api.calls.filter((call) => call.method === "POST" && call.path === "/api/secret-files/push");

// ---------------------------------------------------------------------------
// secret_files_status
// ---------------------------------------------------------------------------

test("secret_files_status for the chat's own project: files, every clone's states, and its own compare by name only", async (t) => {
  const { api, chat, exec } = await rig(t);
  const r = ok(await exec("secret_files_status", {}, { who: chat("acme/api", { runtimeMode: "approval-required" }) }));
  assert.equal(r.project, "acme/api");
  assert.equal(r.repoKey, REPO);
  assert.equal(r.pluginEnabled, true);
  assert.deepEqual(r.vault.files.map((file: { path: string }) => file.path), [".env", "config/creds.json", "apps/web/.env.local"]);
  assert.deepEqual(r.vault.newCandidates, [".env.test"]);
  assert.deepEqual(r.clones.map((clone: { project: string; current?: boolean }) => [clone.project, clone.current === true]), [["acme/api", true], ["acme/api-2", false], ["acme/api-3", false]]);
  assert.deepEqual(r.clones[2].files[2], { path: "apps/web/.env.local", state: "refused", refusal: "tracked" });
  assert.equal(r.compare.project, "acme/api");
  assert.deepEqual(r.compare.files, [
    { path: ".env", state: "modified", compare: { format: "env", added: ["NEW_FLAG"], removed: ["OLD_URL"], changed: ["API_TOKEN"], unchanged: 1 } },
    { path: "config/creds.json", state: "modified", compare: { format: "lines", linesAdded: 3, linesRemoved: 1 } }
  ]);
  // Only the own clone's differing files are compared; a synced one is not.
  assert.deepEqual(api.calls.filter((call) => call.path === "/api/secret-files/compare").map((call) => [call.query!.projectPath.endsWith("/acme/api"), call.query!.path]), [[true, ".env"], [true, "config/creds.json"]]);
});

test("secret_files_status for a named project: an external caller names it (required) and gets that clone's compare", async (t) => {
  const { exec } = await rig(t);
  refused(await exec("secret_files_status", {}), "INVALID_ARGUMENT");
  const r = ok(await exec("secret_files_status", { project: "acme/api-2" }));
  assert.equal(r.project, "acme/api-2");
  assert.deepEqual(r.clones.filter((clone: { current?: boolean }) => clone.current).map((clone: { project: string }) => clone.project), ["acme/api-2"]);
  assert.deepEqual(r.compare.files.map((file: { path: string; state: string }) => [file.path, file.state]), [["config/creds.json", "outdated"]]);
});

test("secret_files_status with no vault, no repo, or the plugin off: says so", async (t) => {
  const { state, exec } = await rig(t);
  const none = ok(await exec("secret_files_status", { project: "beta/api" }));
  assert.equal(none.vault, null);
  assert.equal(none.repoKey, REPO);
  assert.match(none.note, /has no secret-files vault in workspace beta/);
  const plain = ok(await exec("secret_files_status", { project: "acme/plain" }));
  assert.equal(plain.repoKey, null);
  assert.match(plain.note, /no git origin remote/);
  state.enabled = false;
  const off = ok(await exec("secret_files_status", { project: "beta/api" }));
  assert.equal(off.pluginEnabled, false);
  assert.match(off.note, /plugin is off/);
  const offWithVault = ok(await exec("secret_files_status", { project: "acme/api" }));
  assert.equal(offWithVault.pluginEnabled, false);
  assert.ok(offWithVault.vault !== null);
  assert.match(offWithVault.note, /nothing is synced/);
});

// ---------------------------------------------------------------------------
// push_secret_files
// ---------------------------------------------------------------------------

test("push_secret_files is chat-only: an external caller has no such tool", async (t) => {
  const { exec } = await rig(t);
  refused(await exec("push_secret_files", {}), "TOOL_NOT_FOUND");
});

test("push_secret_files is refused before any card: no project, no repo, no vault, nothing modified, an unmanaged path, the plugin off", async (t) => {
  const { api, state, chat, exec } = await rig(t);
  const port = new FakeApprovalPort();
  assert.match(refused(await exec("push_secret_files", {}, { who: chat(null), port }), "PROJECT_NOT_FOUND"), /own project/);
  assert.match(refused(await exec("push_secret_files", {}, { who: chat("acme/plain"), port }), "VAULT_NOT_FOUND"), /no git origin remote/);
  assert.match(refused(await exec("push_secret_files", {}, { who: chat("beta/api"), port }), "VAULT_NOT_FOUND"), /no secret-files vault in workspace beta/);
  refused(await exec("push_secret_files", {}, { who: chat("acme/api-2"), port }), "NOTHING_TO_PUSH");
  refused(await exec("push_secret_files", { files: ["apps/web/.env.local"] }, { who: chat("acme/api"), port }), "NOTHING_TO_PUSH");
  assert.match(refused(await exec("push_secret_files", { files: [".env", "nope/.env"] }, { who: chat("acme/api"), port }), "FILE_NOT_MANAGED"), /nope\/\.env/);
  state.enabled = false;
  refused(await exec("push_secret_files", {}, { who: chat("acme/api"), port }), "SECRET_FILES_DISABLED");
  assert.equal(port.cards.length, 0);
  assert.equal(pushes(api).length, 0);
});

test("push_secret_files: the card names the repo, the source clone, each file's variable names and the clones overwritten — never a value, never a grant", async (t) => {
  const { api, chat, exec } = await rig(t);
  const port = new FakeApprovalPort();
  const r = ok(await exec("push_secret_files", { reason: "Rotated the API token" }, { who: chat("acme/api"), port }));
  assert.equal(port.cards.length, 1);
  const card = port.cards[0]!;
  assert.equal(card.kind, "admin");
  assert.equal(card.family, "secret-files");
  assert.equal(card.tool, "push_secret_files");
  assert.deepEqual(card.grantOptions, [], "never grantable, even in full access");
  assert.equal(card.reason, "Rotated the API token");
  assert.match(card.title, /Claude wants to push 2 secret files from acme\/api to the acme\/api vault/);
  assert.ok(!JSON.stringify(card).includes(PLANTED), "the card carries a secret value");
  const fields = card.sections.find((section) => section.kind === "fields" && section.title === "Push secret files");
  assert.ok(fields && fields.kind === "fields");
  assert.deepEqual(fields.rows.map((row) => [row.label, row.value]), [
    ["Repo", `acme/api (${REPO})`], ["Workspace", "acme"], ["From clone", "acme/api"], ["Files", ".env, config/creds.json"]
  ]);
  const env = card.sections.find((section) => section.kind === "changes");
  assert.ok(env && env.kind === "changes");
  assert.match(env.title, /^\.env — variables vs the vault/);
  assert.deepEqual(env.items.map((item) => [item.label, item.change]), [["NEW_FLAG", "added"], ["OLD_URL", "removed"], ["API_TOKEN", "changed"]]);
  assert.ok(card.sections.some((section) => section.kind === "text" && section.title === "config/creds.json" && /3 line\(s\) added, 1 removed/.test(section.text)));
  const clones = card.sections.find((section) => section.kind === "fields" && section.title === "Clones that will be updated");
  assert.ok(clones && clones.kind === "fields");
  assert.deepEqual(clones.rows.map((row) => [row.label, row.value]), [["acme/api-2", ".env (overwritten), config/creds.json (outdated, updated)"]]);
  assert.ok(card.sections.some((section) => section.kind === "text" && section.title === "Clones left flagged" && /acme\/api-3: \.env \(modified\), config\/creds\.json \(missing-dir\)/.test(section.text)));
  const warning = card.sections.find((section) => section.kind === "warning");
  assert.ok(warning && warning.kind === "warning" && /overwrites that file in every clone listed above/.test(warning.text));
  // The scope names the chat's project and the clone it overwrites.
  assert.deepEqual(card.scope.projects?.map((project) => project.path.split("/").slice(-2).join("/")).sort(), ["acme/api", "acme/api-2"]);

  // Approved: exactly the previewed files, from the chat's clone, as the chat's agent principal.
  const sent = pushes(api);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0]!.body, { workspace: "acme", repoKey: REPO, projectPath: join(api.workspacesDir, "acme", "api"), files: [".env", "config/creds.json"] });
  const principal = api.principals.find((call) => call.method === "POST" && call.path === "/api/secret-files/push")!.principal;
  assert.equal(principal?.kind, "agent");
  assert.equal(principal?.kind === "agent" ? principal.threadId : null, "thread-1");
  assert.deepEqual(r.pushed, [".env", "config/creds.json"]);
  assert.deepEqual(r.updatedClones, [{ project: "acme/api-2", files: [".env", "config/creds.json"] }]);
  assert.deepEqual(r.stillFlagged, [{ project: "acme/api-3", files: [{ path: ".env", state: "modified" }, { path: "config/creds.json", state: "missing-dir" }] }]);
  assert.deepEqual(r.sourceStates, [{ path: ".env", state: "synced" }, { path: "config/creds.json", state: "synced" }]);
});

test("push_secret_files: named files push only the modified ones; the rest are reported, not pushed", async (t) => {
  const { api, chat, exec } = await rig(t);
  const r = ok(await exec("push_secret_files", { files: [".env", "apps/web/.env.local"] }, { who: chat("acme/api"), port: new FakeApprovalPort() }));
  assert.deepEqual((pushes(api)[0]!.body as { files: string[] }).files, [".env"]);
  assert.deepEqual(r.notPushed, [{ path: "apps/web/.env.local", state: "synced" }]);
});

test("push_secret_files: a denied card pushes nothing", async (t) => {
  const { api, chat, exec } = await rig(t);
  const port = new FakeApprovalPort({ outcome: "denied", approvalId: "", reason: "not now" });
  assert.match(refused(await exec("push_secret_files", {}, { who: chat("acme/api"), port }), "APPROVAL_DENIED"), /not now/);
  assert.equal(pushes(api).length, 0);
});

test("push_secret_files: a file that changed while the card waited is PREVIEW_STALE, and nothing is pushed", async (t) => {
  const { api, state, chat, exec } = await rig(t);
  const port = new FakeApprovalPort(() => {
    state.envCompare = { format: "env", keys: [{ key: "API_TOKEN", change: "changed" }, { key: "ANOTHER", change: "added" }] };
    return { outcome: "approved", approvalId: "" };
  });
  refused(await exec("push_secret_files", {}, { who: chat("acme/api"), port }), "PREVIEW_STALE");
  assert.equal(pushes(api).length, 0);
  // A vault version moved by another push is stale too.
  state.envCompare = ENV_COMPARE;
  port.answerWith(() => {
    state.vault = { ...state.vault, files: state.vault.files.map((file) => ({ ...file, version: `${file.version}-other` })) };
    return { outcome: "approved", approvalId: "" };
  });
  refused(await exec("push_secret_files", {}, { who: chat("acme/api"), port }), "PREVIEW_STALE");
  assert.equal(pushes(api).length, 0);
});

test("push_secret_files: never while planning, never for a workflow-owned chat", async (t) => {
  const { chat, exec } = await rig(t);
  const port = new FakeApprovalPort();
  refused(await exec("push_secret_files", {}, { who: chat("acme/api", { planning: true }), port }), "PERMISSION_DENIED");
  refused(await exec("push_secret_files", {}, { who: chat("acme/api", { workflowOwned: true }), port }), "ADMIN_NOT_AVAILABLE");
  assert.equal(port.cards.length, 0);
});
