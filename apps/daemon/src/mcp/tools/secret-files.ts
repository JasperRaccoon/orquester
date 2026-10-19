// Catalog family module `secret-files` (spec docs/superpowers/specs/2026-10-19-secret-files-plugin-design.md §8):
// `secret_files_status` (read; chat and external) and `push_secret_files` (Admin, chat only, never grantable).
//
// Both are in-process clients of the daemon's secret-files routes (`secretFilesRoutes`) through DaemonApi only. A vault
// is `(workspace, repoKey)`: the project's workspace and its `ProjectSummary.repoKey` (the workspace's project listing).
// Nothing here ever carries a secret VALUE: the routes answer paths, opaque versions, states and key-name compares, and
// every view below copies only those fields (never a whole route body), so a value a route sent by mistake still stops
// here.
//
// `push_secret_files` pushes from the chat's OWN project only. Its card names the repo, the source clone, each file's
// added/removed/changed variable names (line counts for non-KEY=VALUE files) and the other clones the push overwrites.
// The card pins each file's vault version and its compare; `run` re-reads both and refuses `PREVIEW_STALE` on a change,
// then pushes exactly the previewed files with the chat's principal (the daemon records the agent's thread).

import { basename } from "node:path";
import { z } from "zod";
import {
  pluginRoutes,
  SECRET_FILE_PATH_MAX,
  SECRET_FILES_MAX_PER_VAULT,
  SECRET_FILES_PLUGIN_ID,
  secretFilesRoutes,
  type ApprovalPreviewSection,
  type PluginsResponse,
  type ProjectSummary,
  type SecretFileCompare,
  type SecretFileCompareResponse,
  type SecretFilesClone,
  type SecretFilesCloneRequest,
  type SecretFileState,
  type SecretVaultDetail,
  type SecretVaultResponse
} from "@orquester/api";

import { resolveProject } from "../addressing.ts";
import { defineTool, DESTRUCTIVE, READ_ONLY, type AnyOrquesterTool, type ApprovalPreview, type ScopeClaim, type ScopeContext } from "../catalog/contract.ts";
import type { DaemonApi } from "../daemon-api.ts";
import { daemonError, expectOk, ToolError } from "../errors.ts";
import { clipText, MAX_ECHO_CHARS, MAX_RESULT_BYTES, resultBytes } from "../result.ts";
import { agentLabel } from "./workflow-preview.ts";

/** A variable name or path as a result or a card shows it, at most. */
const MAX_NAME_CHARS = 200;

// ---------------------------------------------------------------------------
// Reads (DaemonApi only)
// ---------------------------------------------------------------------------

interface Target {
  workspace: string;
  name: string;
  /** `<workspace>/<project>`. */
  label: string;
}

/** The project a status call reads: the named one, else the chat caller's own; an external caller must name one. */
async function statusTarget(project: string | undefined, ctx: Pick<ScopeContext, "api" | "caller">): Promise<Target & { path: string }> {
  if (project !== undefined) return named(await resolveProject(ctx.api, project));
  const own = ownProjectName(ctx.caller);
  if (own) return named(await resolveProject(ctx.api, own));
  throw new ToolError(
    ctx.caller.kind === "thread" ? "PROJECT_NOT_FOUND" : "INVALID_ARGUMENT",
    ctx.caller.kind === "thread" ? "This chat has no project: pass project (list_projects)." : "project is required: an absolute path or \"<workspace>/<project>\"."
  );
}

function named(ref: { workspace: string | null; name: string | null; path: string }): Target & { path: string } {
  // resolveProject only answers a project with both names.
  return { workspace: ref.workspace!, name: ref.name!, label: `${ref.workspace}/${ref.name}`, path: ref.path };
}

/** The chat caller's own project as `<workspace>/<project>`, or null (external, or a chat with no project). */
function ownProjectName(caller: ScopeContext["caller"]): string | null {
  return caller.kind === "thread" && caller.projectPath ? `${caller.workspace}/${basename(caller.projectPath)}` : null;
}

/** The project's row in its workspace's listing (its `repoKey`). */
async function projectSummary(api: DaemonApi, target: Target): Promise<ProjectSummary> {
  const projects = expectOk<ProjectSummary[]>(await api.request("GET", `/api/workspaces/${encodeURIComponent(target.workspace)}/projects`));
  const found = Array.isArray(projects) ? projects.find((project) => project.name === target.name) : undefined;
  if (!found) throw new ToolError("PROJECT_NOT_FOUND", `No project ${clipText(target.label, MAX_ECHO_CHARS)}. Use list_projects.`);
  return found;
}

/** The repo's vault in the workspace, or null when there is none. */
async function readVault(api: DaemonApi, workspace: string, repoKey: string): Promise<SecretVaultDetail | null> {
  const res = await api.request("GET", secretFilesRoutes.vault, { query: { workspace, repoKey } });
  if (res.status === 404 && (res.body as { code?: unknown } | null)?.code === "VAULT_NOT_FOUND") return null;
  if (res.status >= 400) throw daemonError(res);
  return (res.body as SecretVaultResponse).vault;
}

/** Whether the Secret files plugin is on; null when the plugin list could not be read. */
async function pluginEnabled(api: DaemonApi): Promise<boolean | null> {
  const res = await api.request("GET", pluginRoutes.list);
  if (res.status >= 400) return null;
  const plugin = (res.body as PluginsResponse | null)?.plugins?.find((p) => p.id === SECRET_FILES_PLUGIN_ID);
  return plugin ? plugin.enabled === true : null;
}

/** A compare as a result or card shows it: names and counts only, picked field by field. */
export type CompareView =
  | { format: "env"; added: string[]; removed: string[]; changed: string[]; unchanged: number }
  | { format: "lines"; linesAdded: number; linesRemoved: number }
  | { format: "missing"; missingIn: "clone" | "vault" };

const nameOf = (key: unknown): string => clipText(String(key), MAX_NAME_CHARS);
const count = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

function compareView(compare: SecretFileCompare): CompareView {
  switch (compare.format) {
    case "env": {
      const keys = Array.isArray(compare.keys) ? compare.keys : [];
      const of = (change: string) => keys.filter((entry) => entry.change === change).map((entry) => nameOf(entry.key));
      return { format: "env", added: of("added"), removed: of("removed"), changed: of("changed"), unchanged: keys.filter((entry) => entry.change === "same").length };
    }
    case "lines":
      return { format: "lines", linesAdded: count(compare.linesAdded), linesRemoved: count(compare.linesRemoved) };
    default:
      return { format: "missing", missingIn: compare.side === "left" ? "clone" : "vault" };
  }
}

/** The clone's copy of `path` against the vault's (clone = left). A refusal is an answer, never a throw. */
async function readCompare(api: DaemonApi, vault: SecretVaultDetail, clone: SecretFilesClone, path: string): Promise<{ compare: CompareView } | { error: string }> {
  const res = await api.request("GET", secretFilesRoutes.compare, { query: { workspace: vault.workspace, repoKey: vault.repoKey, projectPath: clone.projectPath, path } });
  if (res.status >= 400) {
    const error = daemonError(res);
    return { error: `${error.code}: ${error.message}` };
  }
  const body = res.body as SecretFileCompareResponse | null;
  if (!body?.compare) return { error: "The daemon answered no compare." };
  return { compare: compareView(body.compare) };
}

const cloneLabel = (vault: SecretVaultDetail, clone: { projectName: string }) => `${vault.workspace}/${clone.projectName}`;
const stateOf = (clone: SecretFilesClone, path: string): SecretFileState | undefined => clone.files.find((file) => file.path === path)?.state;

/** The vault's clone for a project of its workspace. */
function cloneOf(vault: SecretVaultDetail, target: Target): SecretFilesClone | undefined {
  return target.workspace === vault.workspace ? vault.clones.find((clone) => clone.projectName === target.name) : undefined;
}

// ---------------------------------------------------------------------------
// secret_files_status
// ---------------------------------------------------------------------------

/** States the compare is read for: the clone holds a copy that differs from the vault's current one. */
const COMPARED: readonly SecretFileState[] = ["modified", "outdated"];

function cloneView(vault: SecretVaultDetail, clone: SecretFilesClone, current: boolean): Record<string, unknown> {
  return {
    project: cloneLabel(vault, clone),
    ...(current ? { current: true } : {}),
    needsAttention: clone.needsAttention === true,
    files: clone.files.map((file) => ({ path: nameOf(file.path), state: file.state, ...(file.refusal ? { refusal: file.refusal } : {}) }))
  };
}

/** A result over the cap drops the compares' name lists (counts stay), then the clones' synced rows. */
function fitStatus(result: Record<string, unknown>): Record<string, unknown> {
  if (resultBytes(result) <= MAX_RESULT_BYTES) return result;
  const compare = result.compare as { files: Array<{ compare?: CompareView }> } | undefined;
  if (compare) {
    for (const file of compare.files) {
      if (file.compare?.format === "env") {
        const c = file.compare;
        (file as Record<string, unknown>).compare = { format: "env", addedCount: c.added.length, removedCount: c.removed.length, changedCount: c.changed.length, unchanged: c.unchanged };
      }
    }
    result.truncated = true;
  }
  if (resultBytes(result) <= MAX_RESULT_BYTES) return result;
  for (const clone of result.clones as Array<{ files: Array<{ state: string }>; syncedFiles?: number }>) {
    const synced = clone.files.filter((file) => file.state === "synced").length;
    clone.files = clone.files.filter((file) => file.state !== "synced");
    if (synced > 0) clone.syncedFiles = synced;
  }
  result.truncated = true;
  return result;
}

const secretFilesStatus = defineTool({
  name: "secret_files_status",
  title: "Secret files status",
  description:
    "The Secret files vault of a project's repo in its workspace: the managed files (.env and others), every clone's state per file (synced, outdated, modified, deleted, missing, refused), and for your project which variable names differ from the vault. Names only: never a value.",
  chatNote: "project defaults to this chat's. A modified file can be pushed to the vault and every clone with push_secret_files.",
  input: {
    project: z.string().min(1).optional().describe("Path or workspace/project.")
  },
  audiences: ["external", "chat"],
  toolset: "secret-files",
  tier: "read",
  async scope(args, ctx) {
    const target = await statusTarget(args.project, ctx);
    return { projects: [target.path], sessions: [], reads: "metadata", writes: false, causesTurnIn: [] };
  },
  annotations: READ_ONLY,
  resultKind: "json",
  async run(args, ctx) {
    const { api } = ctx;
    const target = await statusTarget(args.project, ctx);
    const [summary, enabled] = await Promise.all([projectSummary(api, target), pluginEnabled(api)]);
    const plugin = enabled === null ? {} : { pluginEnabled: enabled };
    const off = enabled === false ? " The Secret files plugin is off: the user turns it on in Settings → Plugins." : "";
    if (!summary.repoKey) {
      return { project: target.label, repoKey: null, ...plugin, vault: null, note: `${target.label} has no git origin remote, so it belongs to no repo and has no secret-files vault.${off}` };
    }
    const vault = await readVault(api, target.workspace, summary.repoKey);
    const repo = { project: target.label, workspace: target.workspace, repoKey: summary.repoKey, ...(summary.repoName ? { repoName: summary.repoName } : {}) };
    if (!vault) {
      return { ...repo, ...plugin, vault: null, note: `The repo ${summary.repoKey} has no secret-files vault in workspace ${target.workspace}.${off || " The user sets one up from the repo's \"Secret files…\" dialog."}` };
    }
    // The compare is for the caller's own project (a chat's), or the project an external caller named.
    const focusName = ownProjectName(ctx.caller);
    const focus: Target = focusName ? { workspace: focusName.split("/")[0]!, name: focusName.split("/")[1]!, label: focusName } : target;
    const focusClone = cloneOf(vault, focus);
    const result: Record<string, unknown> = {
      ...repo,
      ...plugin,
      vault: {
        fileCount: vault.fileCount,
        clonesNeedingAttention: vault.clonesNeedingAttention,
        updatedAt: vault.updatedAt,
        files: vault.files.map((file) => ({
          path: nameOf(file.path),
          updatedAt: file.updatedAt,
          updatedBy: {
            kind: file.updatedBy?.kind === "agent" ? "agent" : "user",
            ...(file.updatedBy?.threadId ? { threadId: file.updatedBy.threadId } : {}),
            ...(file.updatedBy?.projectName ? { fromProject: `${vault.workspace}/${file.updatedBy.projectName}` } : {})
          }
        })),
        ...(vault.candidates?.length ? { newCandidates: vault.candidates.map(nameOf) } : {})
      },
      clones: vault.clones.map((clone) => cloneView(vault, clone, clone === focusClone))
    };
    if (focusClone) {
      const files = focusClone.files.filter((file) => COMPARED.includes(file.state));
      const compares = await Promise.all(files.map((file) => readCompare(api, vault, focusClone, file.path)));
      result.compare = {
        project: cloneLabel(vault, focusClone),
        against: "the vault's current version (added = only in this clone)",
        files: files.map((file, i) => ({ path: nameOf(file.path), state: file.state, ...compares[i]! }))
      };
    } else if (focusName) {
      result.note = `This chat's project ${focusName} is not a clone of ${summary.repoKey} in workspace ${vault.workspace}.`;
    }
    if (enabled === false) result.note = `${result.note ? `${result.note as string} ` : ""}The Secret files plugin is off: nothing is synced until the user turns it on.`;
    return fitStatus(result);
  }
});

// ---------------------------------------------------------------------------
// push_secret_files
// ---------------------------------------------------------------------------

/** States whose clones a push updates: their copy is (or would be) the vault's. */
const UPDATED_BY_PUSH: readonly SecretFileState[] = ["synced", "outdated", "missing"];

interface PushPlan {
  own: Target;
  repoKey: string;
  repoName?: string;
  vault: SecretVaultDetail;
  clone: SecretFilesClone;
  /** The files pushed: requested (or all) and `modified` in the chat's clone. */
  files: string[];
  /** Requested files that are not modified there (left alone). */
  skipped: Array<{ path: string; state: SecretFileState | "unmanaged" }>;
  /** Per other clone, the pushed files it receives (with its state now). */
  updates: Array<{ clone: SecretFilesClone; files: Array<{ path: string; state: SecretFileState }> }>;
  /** Per other clone, the pushed files it keeps flagged (its copy differs or is refused). */
  flagged: Array<{ clone: SecretFilesClone; files: Array<{ path: string; state: SecretFileState }> }>;
}

/** What a push would do now, or a refusal before any card. */
async function pushPlan(files: readonly string[] | undefined, ctx: Pick<ScopeContext, "api" | "caller">): Promise<PushPlan> {
  const { api } = ctx;
  const ownName = ownProjectName(ctx.caller);
  if (!ownName) throw new ToolError("PROJECT_NOT_FOUND", "This chat has no project: secret files are pushed from the chat's own project only.");
  const own = named(await resolveProject(api, ownName));
  const summary = await projectSummary(api, own);
  if (!summary.repoKey) throw new ToolError("VAULT_NOT_FOUND", `${own.label} has no git origin remote, so it has no secret-files vault.`);
  const [vault, enabled] = await Promise.all([readVault(api, own.workspace, summary.repoKey), pluginEnabled(api)]);
  if (enabled === false) throw new ToolError("SECRET_FILES_DISABLED", "The Secret files plugin is off: ask the user to turn it on in Settings → Plugins.");
  if (!vault) throw new ToolError("VAULT_NOT_FOUND", `The repo ${summary.repoKey} has no secret-files vault in workspace ${own.workspace}: ask the user to set one up from the repo's "Secret files…" dialog.`);
  const clone = cloneOf(vault, own);
  if (!clone) throw new ToolError("INVALID_CLONE", `${own.label} is not one of the vault's clones (an archived project is not synced).`);
  const managed = new Set(vault.files.map((file) => file.path));
  const requested = files !== undefined ? [...new Set(files)] : clone.files.map((file) => file.path);
  const unmanaged = requested.filter((path) => !managed.has(path));
  if (files !== undefined && unmanaged.length > 0) {
    throw new ToolError("FILE_NOT_MANAGED", `Not managed by the vault: ${unmanaged.map((path) => `"${clipText(path, MAX_ECHO_CHARS)}"`).join(", ")}. secret_files_status lists its files.`);
  }
  const pushed = requested.filter((path) => stateOf(clone, path) === "modified");
  const skipped = files !== undefined ? requested.filter((path) => !pushed.includes(path)).map((path) => ({ path, state: stateOf(clone, path) ?? ("unmanaged" as const) })) : [];
  if (pushed.length === 0) {
    const what = files !== undefined ? "None of the requested files is" : "No file is";
    throw new ToolError("NOTHING_TO_PUSH", `${what} modified in ${own.label}: nothing to push. secret_files_status shows each file's state.`);
  }
  const updates: PushPlan["updates"] = [];
  const flagged: PushPlan["flagged"] = [];
  for (const other of vault.clones) {
    if (other === clone) continue;
    const rows = pushed.map((path) => ({ path, state: stateOf(other, path) })).filter((row): row is { path: string; state: SecretFileState } => row.state !== undefined);
    const receives = rows.filter((row) => UPDATED_BY_PUSH.includes(row.state));
    const keeps = rows.filter((row) => !UPDATED_BY_PUSH.includes(row.state));
    if (receives.length > 0) updates.push({ clone: other, files: receives });
    if (keeps.length > 0) flagged.push({ clone: other, files: keeps });
  }
  return { own, repoKey: summary.repoKey, ...(summary.repoName ? { repoName: summary.repoName } : {}), vault, clone, files: pushed, skipped, updates, flagged };
}

/** Each pushed file's compare against the vault. */
async function planCompares(api: DaemonApi, plan: PushPlan): Promise<Array<{ path: string } & ({ compare: CompareView } | { error: string })>> {
  return Promise.all(plan.files.map(async (path) => ({ path, ...(await readCompare(api, plan.vault, plan.clone, path)) })));
}

/** The pins a card freezes: the pushed list, each file's vault version and its compare. */
function planPins(plan: PushPlan, compares: Awaited<ReturnType<typeof planCompares>>): Record<string, string> {
  const pins: Record<string, string> = { files: JSON.stringify(plan.files) };
  for (const path of plan.files) pins[`vault:${path}`] = plan.vault.files.find((file) => file.path === path)?.version ?? "";
  for (const entry of compares) pins[`compare:${entry.path}`] = JSON.stringify("compare" in entry ? entry.compare : null);
  return pins;
}

const describeState = (state: SecretFileState): string => (state === "missing" ? "added" : state === "outdated" ? "outdated, updated" : "overwritten");

function compareSection(entry: Awaited<ReturnType<typeof planCompares>>[number]): ApprovalPreviewSection {
  const path = nameOf(entry.path);
  if ("error" in entry) return { kind: "text", title: path, text: `The compare could not be read (${entry.error}).` };
  const c = entry.compare;
  if (c.format === "env") {
    const items = [
      ...c.added.map((key) => ({ label: key, change: "added" as const, detail: "only in this clone" })),
      ...c.removed.map((key) => ({ label: key, change: "removed" as const, detail: "only in the vault" })),
      ...c.changed.map((key) => ({ label: key, change: "changed" as const, detail: "value differs" }))
    ];
    if (items.length === 0) return { kind: "text", title: path, text: "No variable differs from the vault (only formatting or comments)." };
    return { kind: "changes", title: `${path} — variables vs the vault (names only; ${c.unchanged} unchanged)`, items };
  }
  if (c.format === "lines") return { kind: "text", title: path, text: `${c.linesAdded} line(s) added, ${c.linesRemoved} removed vs the vault (not a KEY=VALUE file: line counts only).` };
  return { kind: "text", title: path, text: c.missingIn === "vault" ? "The vault has no copy yet." : "This clone has no copy." };
}

function pushPreview(plan: PushPlan, compares: Awaited<ReturnType<typeof planCompares>>, caller: ScopeContext["caller"]): ApprovalPreview {
  const repo = plan.repoName ? `${plan.repoName} (${plan.repoKey})` : plan.repoKey;
  const fileList = plan.files.map(nameOf).join(", ");
  const sections: ApprovalPreviewSection[] = [
    {
      kind: "fields",
      title: "Push secret files",
      rows: [
        { label: "Repo", value: repo },
        { label: "Workspace", value: plan.vault.workspace },
        { label: "From clone", value: plan.own.label },
        { label: "Files", value: fileList },
        ...(plan.skipped.length ? [{ label: "Not pushed", value: plan.skipped.map((row) => `${nameOf(row.path)} (${row.state})`).join(", ") }] : [])
      ]
    },
    ...compares.map(compareSection),
    plan.updates.length > 0
      ? {
          kind: "fields",
          title: "Clones that will be updated",
          rows: plan.updates.map(({ clone, files }) => ({ label: cloneLabel(plan.vault, clone), value: files.map((file) => `${nameOf(file.path)} (${describeState(file.state)})`).join(", ") }))
        }
      : { kind: "text", title: "Clones that will be updated", text: `No other clone of this repo in ${plan.vault.workspace} receives these files.` },
    ...(plan.flagged.length > 0
      ? [{
          kind: "text" as const,
          title: "Clones left flagged",
          text: plan.flagged.map(({ clone, files }) => `${cloneLabel(plan.vault, clone)}: ${files.map((file) => `${nameOf(file.path)} (${file.state})`).join(", ")}`).join("\n")
        }]
      : []),
    {
      kind: "warning",
      level: "caution",
      text: `Approving makes ${plan.own.label}'s copy of ${fileList} the vault's version and overwrites that file in every clone listed above. Older versions stay only in the vault's history.`
    }
  ];
  const n = plan.files.length;
  return {
    title: `${agentLabel(caller)} wants to push ${n} secret file${n === 1 ? "" : "s"} from ${plan.own.label} to the ${plan.repoName ?? plan.repoKey} vault`,
    scopeLabel: `Repo ${plan.repoKey} in workspace ${plan.vault.workspace}`,
    sections,
    pins: planPins(plan, compares)
  };
}

const pushSecretFiles = defineTool({
  name: "push_secret_files",
  title: "Push secret files",
  description:
    "Push this project's modified secret files (.env and others managed by the repo's Secret files vault) to the vault and every other clone of the repo in this workspace. Only this chat's own project. The user approves a card listing the changed variable names and the clones overwritten.",
  input: {
    files: z.array(z.string().min(1).max(SECRET_FILE_PATH_MAX)).min(1).max(SECRET_FILES_MAX_PER_VAULT).optional().describe("Managed paths to push; default every modified one."),
    reason: z.string().max(300).optional().describe("Why, in a sentence: shown on the approval card.")
  },
  audiences: ["chat"],
  toolset: "secret-files",
  tier: "admin",
  adminFamily: "secret-files",
  async scope(args, ctx): Promise<ScopeClaim> {
    const plan = await pushPlan(args.files, ctx);
    // The push writes the chat's own project's vault copy and the other clones' files.
    return { projects: [ctx.caller.kind === "thread" ? ctx.caller.projectPath : "", ...plan.updates.map(({ clone }) => clone.projectPath)].filter(Boolean), sessions: [], reads: "content", writes: true, causesTurnIn: [] };
  },
  async approval(args, ctx): Promise<ApprovalPreview> {
    const plan = await pushPlan(args.files, ctx);
    return pushPreview(plan, await planCompares(ctx.api, plan), ctx.caller);
  },
  annotations: DESTRUCTIVE,
  resultKind: "json",
  async run(args, ctx) {
    const { api } = ctx;
    const plan = await pushPlan(args.files, ctx);
    const pins = ctx.approval?.pins;
    if (pins) {
      const now = planPins(plan, await planCompares(api, plan));
      const changed = Object.keys({ ...pins, ...now }).filter((key) => pins[key] !== now[key]);
      if (changed.length > 0) {
        throw new ToolError("PREVIEW_STALE", "The secret files changed after the card opened (a file, its variables or the vault's version); nothing was pushed. Call push_secret_files again.");
      }
    }
    const body: SecretFilesCloneRequest = { workspace: plan.vault.workspace, repoKey: plan.repoKey, projectPath: plan.clone.projectPath, files: plan.files };
    const after = expectOk<SecretVaultResponse>(await api.request("POST", secretFilesRoutes.push, { body })).vault;
    const updatedClones: Array<{ project: string; files: string[] }> = [];
    const stillFlagged: Array<{ project: string; files: Array<{ path: string; state: SecretFileState }> }> = [];
    for (const clone of after?.clones ?? []) {
      if (clone.projectName === plan.clone.projectName) continue;
      // The vault's version moved: a clone synced with it now received the pushed copy.
      const updated = plan.files.filter((path) => stateOf(clone, path) === "synced");
      const flagged = plan.files
        .map((path) => ({ path, state: stateOf(clone, path) }))
        .filter((row): row is { path: string; state: SecretFileState } => row.state !== undefined && row.state !== "synced");
      if (updated.length > 0) updatedClones.push({ project: cloneLabel(plan.vault, clone), files: updated.map(nameOf) });
      if (flagged.length > 0) stillFlagged.push({ project: cloneLabel(plan.vault, clone), files: flagged.map((row) => ({ path: nameOf(row.path), state: row.state })) });
    }
    const source = after?.clones.find((clone) => clone.projectName === plan.clone.projectName);
    return {
      pushed: plan.files.map(nameOf),
      project: plan.own.label,
      repoKey: plan.repoKey,
      updatedClones,
      ...(stillFlagged.length ? { stillFlagged } : {}),
      ...(plan.skipped.length ? { notPushed: plan.skipped.map((row) => ({ path: nameOf(row.path), state: row.state })) } : {}),
      ...(source ? { sourceStates: source.files.filter((file) => plan.files.includes(file.path)).map((file) => ({ path: nameOf(file.path), state: file.state })) } : {})
    };
  }
});

/** This family in the catalog (`../catalog/index.ts`). */
export const secretFilesFamily: readonly AnyOrquesterTool[] = [secretFilesStatus, pushSecretFiles];
