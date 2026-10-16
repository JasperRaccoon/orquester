// Catalog family module `saved-prompts` (list_saved_prompts, update_saved_prompts) — unified MCP
// design 2026-10-15 §4 rows 24–25, §4.1 "Saved prompts" (D-16), plan Task 12. Both audiences.
//
// Tiers of `update_saved_prompts` (chat callers; external callers are full trust):
// - create: Act — the daemon stamps `createdBy: agent` from the call's principal;
// - update / delete of an agent-created prompt no workflow references: Act;
// - of a prompt no agent created (the user's): Admin, family `saved-prompts`;
// - of any prompt a workflow's agent block references (`usedByWorkflows`): Admin, family
//   `workflows` — the card names those workflows and shows the change, because a referenced
//   prompt is live workflow code; never grantable.
// The prompt's kind is read in `scope()`, which resolves the call's tier and family on the claim
// (`ScopeClaim.resolved`, read by `tier(args, scope)`); `approval()` reads it again and pins what it
// showed; `run` re-reads it before writing — a prompt that became referenced meanwhile is refused
// (`PERMISSION_DENIED`, call again) or `PREVIEW_STALE` after a card. Pinning is external-only, and
// the daemon refuses pinning an agent-created prompt from anyone but the user.
//
// Project prompts are shared by every checkout of one Git repository (`repoKey`, the daemon's
// canonical origin identity; a folder without an origin keeps a folder-only prompt). Which project
// a call claims is the project the prompt belongs to AS ADDRESSED — never the stored `projectPath`,
// which is only the checkout that first saved it (and may be gone): a chat's own checkout claims its
// own project for its repository's prompts, so the user's checkouts use their shared prompts like
// their own, and naming a sibling checkout of the same repository is the caller's own project too
// (it lists the very same prompts). Everything else stays as the matrix says: the user's prompts are
// Admin in every mode, a workflow-referenced one is Admin `workflows`, and a project that is not a
// checkout of the caller's repository is cross-project.

import { basename, join } from "node:path";
import { z } from "zod";
import {
  SAVED_PROMPT_BODY_MAX,
  SAVED_PROMPT_DESCRIPTION_MAX,
  SAVED_PROMPT_TAG_MAX,
  SAVED_PROMPT_TAGS_MAX,
  SAVED_PROMPT_TITLE_MAX,
  TOOL_APPROVAL_REASON_MAX_CHARS,
  type ApprovalPreviewSection,
  type CreateSavedPromptRequest,
  type SavedPrompt,
  type UpdateSavedPromptRequest
} from "@orquester/api";
import { projectNamesFor, resolveProject } from "../addressing.ts";
import type { DaemonApi } from "../daemon-api.ts";
import { daemonError, ToolError } from "../errors.ts";
import { clipText, fitJsonBytes, MAX_ECHO_CHARS, MAX_RESULT_BYTES, resultBytes } from "../result.ts";
import {
  closedWorld,
  defineTool,
  READ_ONLY,
  type AdminFamily,
  type AnyOrquesterTool,
  type ApprovalPreview,
  type CallContext,
  type ScopeClaim,
  type ScopeContext,
  type Tier
} from "../catalog/contract.ts";
import { agentLabel } from "./desktop-preview.ts";

const ROUTE = "/api/saved-prompts";

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** Where a call looks: a project's path as the store spells it (`<workspacesDir>/<ws>/<p>`), or the global prompts. */
interface Place {
  projectPath: string | null;
  /** `ws/p`, or "" for the global prompts. */
  label: string;
  /** The project's Git repository identity: its prompts are shared by every checkout of it. */
  repoKey?: string;
  /** The list read while resolving the place (one read per resolution: a later resolution reads again). */
  prompts?: SavedPrompt[];
}

const GLOBAL: Place = { projectPath: null, label: "" };

/** A project named `ws/p` as a {@link Place}, with its repository identity (read from the library's list). */
async function projectPlace(api: DaemonApi, workspace: string, name: string): Promise<Place> {
  const place: Place = { projectPath: join(api.workspacesDir, workspace, name), label: `${workspace}/${name}` };
  const { prompts, projectRepoKey } = await listing(api, place);
  return { ...place, prompts, ...(projectRepoKey ? { repoKey: projectRepoKey } : {}) };
}

/**
 * `project` resolved; a chat caller naming none means its own project (none: the global prompts).
 * A chat naming another checkout of its own project's repository gets its own project: both list
 * the same shared prompts, so the call is one in the chat's own project (see the header).
 */
async function placeOf(project: string | undefined, ctx: ScopeContext): Promise<Place> {
  const caller = ctx.caller;
  const ownNames = caller.kind === "thread" && caller.projectPath && caller.workspace ? { workspace: caller.workspace, name: basename(caller.projectPath) } : null;
  const ownPlace = () => projectPlace(ctx.api, ownNames!.workspace, ownNames!.name);
  if (project === undefined) return ownNames ? ownPlace() : GLOBAL;
  const names = await resolveProject(ctx.api, project);
  if (!names.workspace || !names.name) throw new ToolError("PROJECT_NOT_FOUND", "Saved prompts belong to a project inside a workspace.");
  const place = await projectPlace(ctx.api, names.workspace, names.name);
  if (ownNames === null || place.repoKey === undefined || (names.workspace === ownNames.workspace && names.name === ownNames.name)) return place;
  const own = await ownPlace();
  return own.repoKey === place.repoKey ? own : place;
}

/** Every global prompt, plus `place`'s project prompts (the route's list rows: `createdBy`, `usedByWorkflows`), and its repository. */
async function listing(api: DaemonApi, place: Place): Promise<{ prompts: SavedPrompt[]; projectRepoKey?: string }> {
  const res = await api.request("GET", ROUTE, place.projectPath ? { query: { projectPath: place.projectPath } } : undefined);
  if (res.status >= 400) throw daemonError(res);
  const body = res.body as { prompts?: unknown; projectRepoKey?: unknown } | null;
  const prompts = Array.isArray(body?.prompts) ? (body.prompts as SavedPrompt[]) : [];
  return typeof body?.projectRepoKey === "string" && body.projectRepoKey ? { prompts, projectRepoKey: body.projectRepoKey } : { prompts };
}

async function listPrompts(api: DaemonApi, place: Place): Promise<SavedPrompt[]> {
  return place.prompts ?? (await listing(api, place)).prompts;
}

/** The prompt `id` among the global prompts and `place`'s own. */
async function findPrompt(api: DaemonApi, place: Place, id: string): Promise<SavedPrompt> {
  const prompt = (await listPrompts(api, place)).find((row) => row.id === id);
  if (!prompt) {
    const where = place.projectPath ? `the global prompts or ${place.label}'s` : "the global prompts";
    throw new ToolError(
      "SAVED_PROMPT_NOT_FOUND",
      `No saved prompt with id ${JSON.stringify(clipText(id, MAX_ECHO_CHARS))} among ${where}; list_saved_prompts shows the ids — pass the prompt's project.`
    );
  }
  return prompt;
}

const isAgentCreated = (prompt: SavedPrompt): boolean => prompt.createdBy?.kind === "agent";
const workflowsOf = (prompt: SavedPrompt) => prompt.usedByWorkflows ?? [];

/** What an agent's edit of `prompt` is (§4.1). */
function editKind(prompt: SavedPrompt): { tier: Tier; family?: AdminFamily } {
  if (workflowsOf(prompt).length > 0) return { tier: "admin", family: "workflows" };
  return isAgentCreated(prompt) ? { tier: "act" } : { tier: "admin", family: "saved-prompts" };
}

// ---------------------------------------------------------------------------
// list_saved_prompts
// ---------------------------------------------------------------------------

type PromptRow = Omit<SavedPrompt, "body" | "projectPath"> & {
  /**
   * `null`: global. Else the checkout that first saved it; left out for a repository prompt saved
   * in a checkout of another workspace, for a chat below Full access (ruling S13, as for workflows).
   */
  projectPath?: string | null;
  scope: "global" | "project";
  bodyChars: number;
  body?: string;
  bodyTruncated?: true;
  /** Workflows in other workspaces using it, counted only (ruling S13: a chat below Full access). */
  usedByWorkflowsElsewhere?: number;
};

/**
 * The workflows a caller may see by name (§5.2, ruling S13): every one for external callers and
 * Full-access chats; for other chats, those of the chat's own workspace — the rest only counted (a
 * workflow whose workspace is unknown counts as elsewhere: fail closed).
 */
function visibleUses(prompt: SavedPrompt, caller: ScopeContext["caller"]): { usedByWorkflows?: SavedPrompt["usedByWorkflows"]; usedByWorkflowsElsewhere?: number } {
  const uses = workflowsOf(prompt);
  if (uses.length === 0) return {};
  if (caller.kind !== "thread" || caller.runtimeMode === "full-access") return { usedByWorkflows: uses };
  const shown = uses.filter((use) => use.workspace !== undefined && use.workspace === caller.workspace);
  const hidden = uses.length - shown.length;
  return { ...(shown.length > 0 ? { usedByWorkflows: shown } : {}), ...(hidden > 0 ? { usedByWorkflowsElsewhere: hidden } : {}) };
}

/** Whether `caller` may see the path of the checkout that first saved a repository prompt (ruling S13). */
function seesOrigin(prompt: SavedPrompt, caller: ScopeContext["caller"], workspacesDir: string): boolean {
  if (prompt.projectPath === null || !prompt.repoKey) return true;
  if (caller.kind !== "thread" || caller.runtimeMode === "full-access") return true;
  const origin = projectNamesFor(prompt.projectPath, workspacesDir).workspace;
  return origin !== null && origin === caller.workspace;
}

function rowOf(prompt: SavedPrompt, includeBody: boolean, caller: ScopeContext["caller"], workspacesDir: string): PromptRow {
  const { body, usedByWorkflows: _uses, projectPath, ...rest } = prompt;
  return {
    ...rest,
    ...(seesOrigin(prompt, caller, workspacesDir) ? { projectPath } : {}),
    scope: prompt.projectPath === null ? "global" : "project",
    ...visibleUses(prompt, caller),
    bodyChars: body.length,
    ...(includeBody ? { body } : {})
  };
}

function matches(prompt: SavedPrompt, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [prompt.title, prompt.description, prompt.body, ...prompt.tags].some((text) => text.toLowerCase().includes(needle));
}

/** Rows that fit one result, in order; `omittedPrompts` counts those left out; a lone row too big keeps its body's head. */
function fitRows(rows: PromptRow[]): { prompts: PromptRow[]; truncated?: true; omittedPrompts?: number } {
  if (resultBytes({ prompts: rows }) <= MAX_RESULT_BYTES) return { prompts: rows };
  const frame = (omitted: number) => resultBytes({ prompts: [], truncated: true, omittedPrompts: omitted });
  const kept: PromptRow[] = [];
  let used = 0;
  for (const row of rows) {
    const cost = resultBytes(row) + (kept.length ? 1 : 0);
    if (frame(rows.length - kept.length - 1) + used + cost > MAX_RESULT_BYTES) break;
    used += cost;
    kept.push(row);
  }
  if (kept.length === 0 && rows[0]) {
    const first: PromptRow = { ...rows[0], body: "", bodyTruncated: true };
    const room = MAX_RESULT_BYTES - resultBytes({ prompts: [first], truncated: true, omittedPrompts: rows.length - 1 });
    first.body = fitJsonBytes(rows[0].body ?? "", room).text;
    kept.push(first);
  }
  const omitted = rows.length - kept.length;
  return { prompts: kept, truncated: true, ...(omitted > 0 ? { omittedPrompts: omitted } : {}) };
}

const listSavedPrompts = defineTool({
  name: "list_saved_prompts",
  title: "List saved prompts",
  description:
    "The user's saved prompts: global plus one project's (shared by every checkout of its Git repository: repoKey). Rows: id, title, description, tags, scope, projectPath, repoKey, pinned, createdBy (absent: the user's), usedByWorkflows, bodyChars; body with includeBody.",
  chatNote: "Default: this chat's project.",
  externalNote: "Default: global only.",
  input: {
    project: z.string().min(1).optional().describe("Path or \"ws/project\"."),
    query: z.string().optional().describe("Text to find."),
    includeBody: z.boolean().optional()
  },
  audiences: ["external", "chat"],
  toolset: "reads",
  tier: "read",
  async scope(args, ctx) {
    const place = await placeOf(args.project, ctx);
    return { projects: place.projectPath ? [place.projectPath] : [], sessions: [], reads: "metadata", writes: false, causesTurnIn: [] };
  },
  annotations: READ_ONLY,
  resultKind: "json",
  async run(args, ctx) {
    const prompts = (await listPrompts(ctx.api, await placeOf(args.project, ctx)))
      .filter((prompt) => args.query === undefined || matches(prompt, args.query))
      // The project's own first, then the global ones; pinned first within each; then by title.
      .sort((a, b) => Number(a.projectPath === null) - Number(b.projectPath === null) || Number(b.pinned) - Number(a.pinned) || a.title.localeCompare(b.title));
    return fitRows(prompts.map((prompt) => rowOf(prompt, args.includeBody === true, ctx.caller, ctx.api.workspacesDir)));
  }
});

// ---------------------------------------------------------------------------
// update_saved_prompts
// ---------------------------------------------------------------------------

const ACTIONS = ["create", "update", "delete"] as const;

const updateInput = {
  action: z.enum(ACTIONS),
  id: z.string().min(1).optional().describe("The prompt's id (list_saved_prompts), for update and delete."),
  title: z.string().min(1).max(SAVED_PROMPT_TITLE_MAX).optional(),
  body: z.string().min(1).max(SAVED_PROMPT_BODY_MAX).optional().describe("The template text; {project}, {branch}, {diff}, {date}… render when it is used."),
  description: z.string().max(SAVED_PROMPT_DESCRIPTION_MAX).optional().describe("One line under the title."),
  tags: z.array(z.string().max(SAVED_PROMPT_TAG_MAX)).max(SAVED_PROMPT_TAGS_MAX).optional(),
  project: z
    .string()
    .min(1)
    .optional()
    .describe("create: the project it belongs to. update/delete: the project of a project prompt. Absolute path or \"<workspace>/<project>\"."),
  global: z.boolean().optional().describe("create: a global prompt, offered in every project."),
  pinned: z.boolean().optional().describe("Pin it to the top of the library. An agent-created prompt can be pinned only by the user."),
  reason: z.string().max(TOOL_APPROVAL_REASON_MAX_CHARS).optional().describe("Why, shown to the user when the change needs approval.")
};
type UpdateArgs = z.infer<z.ZodObject<typeof updateInput>>;

function checkAction(args: UpdateArgs, external: boolean): void {
  const refuse = (message: string): never => {
    throw new ToolError("INVALID_ARGUMENT", `update_saved_prompts ${args.action}: ${message}`);
  };
  if (args.action === "create") {
    if (args.id !== undefined) refuse("takes no id.");
    if (args.title === undefined || args.body === undefined) refuse("needs title and body.");
    if (args.global === true && args.project !== undefined) refuse("pass project or global, not both.");
    if (external && args.global !== true && args.project === undefined) refuse("pass project, or global: true.");
    return;
  }
  if (args.id === undefined) refuse("needs id.");
  if (args.global !== undefined) refuse("takes no global: name a project prompt's project.");
  const edits = [args.title, args.body, args.description, args.tags, args.pinned].filter((value) => value !== undefined).length;
  if (args.action === "delete" && edits > 0) refuse("takes only id and project.");
  if (args.action === "update" && edits === 0) refuse("needs title, body, description, tags or pinned.");
}

async function targetOf(args: UpdateArgs, ctx: ScopeContext): Promise<{ place: Place; prompt: SavedPrompt | null }> {
  if (args.action === "create") {
    if (args.global === true) return { place: GLOBAL, prompt: null };
    const place = await placeOf(args.project, ctx);
    // A chat with no project of its own never makes a global prompt by omission.
    if (place.projectPath === null) throw new ToolError("INVALID_ARGUMENT", "update_saved_prompts create: this chat has no project; pass project, or global: true.");
    return { place, prompt: null };
  }
  // External callers naming no project look among the global prompts.
  const place = await placeOf(args.project, ctx);
  return { place, prompt: await findPrompt(ctx.api, place, args.id!) };
}

const createdByText = (prompt: SavedPrompt): string =>
  isAgentCreated(prompt)
    ? `Created by ${agentLabel(prompt.createdBy?.agent)}${prompt.createdBy?.title ? ` in the chat "${prompt.createdBy.title}"` : ""}.`
    : "Created by you.";

/** Pins of what a card showed about `prompt`: its revision (`updatedAt`) and the workflows using it. */
function pinsOf(prompt: SavedPrompt): Record<string, string> {
  return {
    [`savedPrompt:${prompt.id}:updatedAt`]: prompt.updatedAt,
    [`savedPrompt:${prompt.id}:workflows`]: workflowsOf(prompt).map((use) => use.workflowId).sort().join(",")
  };
}

/** The card (§7.1 "saved prompt edit: title/body diff, and the workflows that reference it"). */
async function preview(args: UpdateArgs, ctx: ScopeContext): Promise<ApprovalPreview> {
  const agent = ctx.caller.kind === "thread" ? agentLabel(ctx.caller.agentId) : "An agent";
  const { place, prompt } = await targetOf(args, ctx);
  const scopeLabel = scopeLabelOf(place, prompt);
  if (prompt === null) {
    return {
      title: `${agent} wants to save the prompt "${args.title}"${place.projectPath ? ` in ${place.label}` : " for every project"}`,
      scopeLabel,
      sections: [
        { kind: "fields", rows: promptFields({ title: args.title!, description: args.description ?? "", tags: args.tags ?? [] }) },
        { kind: "code", title: "Body", text: args.body! }
      ]
    };
  }
  const uses = workflowsOf(prompt);
  const kind = editKind(prompt);
  const verb = args.action === "delete" ? "delete" : "edit";
  const sections: ApprovalPreviewSection[] = [];
  if (uses.length > 0) {
    sections.push({
      kind: "warning",
      level: "danger",
      text: `${uses.length === 1 ? "A workflow runs" : `${uses.length} workflows run`} this prompt: ${args.action === "delete" ? "deleting it breaks their agent blocks" : "the change applies to their next runs"}.`
    });
    sections.push({ kind: "changes", title: "Workflows that use it", items: uses.map((use) => ({ label: use.name, change: "changed" as const, detail: use.workflowId })) });
  }
  sections.push({ kind: "text", text: createdByText(prompt) });
  if (args.action === "delete") {
    sections.push({ kind: "fields", rows: promptFields(prompt) }, { kind: "code", title: "Body (deleted)", text: prompt.body });
  } else {
    if (args.title !== undefined && args.title.trim() !== prompt.title) sections.push({ kind: "diff", title: "Title", unifiedDiff: unifiedDiff(prompt.title, args.title.trim(), "title") });
    if (args.body !== undefined && args.body !== prompt.body) sections.push({ kind: "diff", title: "Body", unifiedDiff: unifiedDiff(prompt.body, args.body, "body") });
    const rows: { label: string; value: string }[] = [];
    if (args.description !== undefined && args.description.trim() !== prompt.description) {
      rows.push({ label: "Description (before)", value: prompt.description || "—" }, { label: "Description (after)", value: args.description.trim() || "—" });
    }
    if (args.tags !== undefined) rows.push({ label: "Tags (before)", value: prompt.tags.join(", ") || "—" }, { label: "Tags (after)", value: args.tags.join(", ") || "—" });
    if (args.pinned !== undefined) rows.push({ label: "Pinned", value: args.pinned ? "yes" : "no" });
    if (rows.length > 0) sections.push({ kind: "fields", title: "Other changes", rows });
    if (args.title === undefined && args.body === undefined && rows.length === 0) sections.push({ kind: "text", text: "No visible change." });
  }
  return {
    title: `${agent} wants to ${verb} the saved prompt "${prompt.title}"`,
    ...(kind.family ? { family: kind.family } : {}),
    scopeLabel,
    sections,
    pins: pinsOf(prompt),
    ...(uses.length > 0 ? { workflowReferencedPrompt: true } : {})
  };
}

/** The card's scope: global, the project, and — for a repository prompt — that every checkout of it shares the change. */
function scopeLabelOf(place: Place, prompt: SavedPrompt | null): string {
  if (place.projectPath === null || (prompt !== null && prompt.projectPath === null)) return "Global — every project";
  const repoKey = prompt === null ? place.repoKey : prompt.repoKey ?? undefined;
  return repoKey ? `Project ${place.label} — shared by every checkout of ${repoKey}` : `Project ${place.label}`;
}

function promptFields(prompt: { title: string; description: string; tags: readonly string[] }): { label: string; value: string }[] {
  return [
    { label: "Title", value: prompt.title },
    ...(prompt.description ? [{ label: "Description", value: prompt.description }] : []),
    ...(prompt.tags.length > 0 ? [{ label: "Tags", value: prompt.tags.join(", ") }] : [])
  ];
}

/**
 * Before writing, the prompt as it is NOW: a chat call that passed no card must still be an Act
 * (a workflow may have started using the prompt since `scope()`); a carded or granted one must
 * match what the card showed (§7.2).
 */
async function recheck(args: UpdateArgs, ctx: CallContext): Promise<void> {
  if (ctx.caller.kind !== "thread") return;
  const { prompt } = await targetOf(args, ctx);
  if (prompt === null) return;
  if (ctx.approval) {
    const pins = ctx.approval.pins ?? {};
    const now = pinsOf(prompt);
    for (const [key, value] of Object.entries(pins)) {
      if (now[key] !== value) throw new ToolError("PREVIEW_STALE", `The saved prompt "${clipText(prompt.title, 80)}" changed after the card opened; nothing was done.`);
    }
    return;
  }
  if (editKind(prompt).tier !== "act") {
    throw new ToolError("PERMISSION_DENIED", `The saved prompt "${clipText(prompt.title, 80)}" changed meanwhile (a workflow uses it now): changing it needs the user's approval. Call update_saved_prompts again.`);
  }
}

const updateSavedPrompts = defineTool({
  name: "update_saved_prompts",
  title: "Change saved prompts",
  description:
    "Create, edit or delete a saved prompt in the user's library (the right rail), global or for one project. create: title and body (+ description, tags), in a project or global. update: change title, body, description or tags of the prompt `id`. delete: remove it.",
  chatNote:
    "A prompt you create is marked as made by an agent; you cannot pin prompts. Without project: this chat's project. Editing or deleting a prompt no agent created, or one a workflow uses (usedByWorkflows), asks the user to approve in the chat (up to 30 min); if denied, don't retry — ask the user.",
  externalNote:
    "update and delete look for a project prompt in `project` (else among the global ones). _meta tier admin is the widest: in Orquester chats create and edits of agent-made prompts are act.",
  input: updateInput,
  externalOnlyInput: ["pinned"],
  audiences: ["external", "chat"],
  toolset: "notes",
  // The stored prompt decides (agent-made, used by a workflow): `scope` looks it up and resolves the
  // call's tier and family on the claim. Fail closed when unknown: Admin `workflows`, never grantable.
  tier: (args, scope) => (args.action === "create" ? "act" : (scope.resolved?.tier ?? "admin")),
  adminFamily: (_args, scope) => scope.resolved?.adminFamily ?? "workflows",
  async scope(args, ctx) {
    checkAction(args, ctx.caller.kind === "external");
    const { place, prompt } = await targetOf(args, ctx);
    // A project prompt belongs to the project it was found through (its folder, or a checkout of its
    // repository) — never claimed through its stored path, the first checkout's, which may be gone.
    const projectPath = prompt && prompt.projectPath === null ? null : place.projectPath;
    const claim: ScopeClaim = { projects: projectPath ? [projectPath] : [], sessions: [], reads: "none", writes: true, causesTurnIn: [] };
    if (prompt) {
      const kind = editKind(prompt);
      claim.resolved = { tier: kind.tier, ...(kind.family ? { adminFamily: kind.family } : {}) };
    }
    return claim;
  },
  approval: preview,
  annotations: closedWorld({ readOnlyHint: false, destructiveHint: true, idempotentHint: false }),
  resultKind: "json",
  async run(args, ctx) {
    checkAction(args, ctx.caller.kind === "external");
    await recheck(args, ctx);
    const { place, prompt } = await targetOf(args, ctx);
    if (args.action === "create") {
      const body: CreateSavedPromptRequest = {
        title: args.title!,
        body: args.body!,
        projectPath: place.projectPath,
        ...(args.description !== undefined ? { description: args.description } : {}),
        ...(args.tags !== undefined ? { tags: [...args.tags] } : {}),
        ...(args.pinned !== undefined ? { pinned: args.pinned } : {})
      };
      const res = await ctx.api.request("POST", ROUTE, { body });
      if (res.status >= 400) throw daemonError(res);
      return { prompt: rowOf(res.body as SavedPrompt, true, ctx.caller, ctx.api.workspacesDir) };
    }
    const id = prompt!.id;
    if (args.action === "delete") {
      const res = await ctx.api.request("DELETE", `${ROUTE}/${encodeURIComponent(id)}`);
      if (res.status >= 400) throw daemonError(res);
      return { deleted: true, id };
    }
    const patch: UpdateSavedPromptRequest = {
      ...(args.title !== undefined ? { title: args.title } : {}),
      ...(args.body !== undefined ? { body: args.body } : {}),
      ...(args.description !== undefined ? { description: args.description } : {}),
      ...(args.tags !== undefined ? { tags: [...args.tags] } : {}),
      ...(args.pinned !== undefined ? { pinned: args.pinned } : {})
    };
    const res = await ctx.api.request("PUT", `${ROUTE}/${encodeURIComponent(id)}`, { body: patch });
    if (res.status >= 400) throw daemonError(res);
    return { prompt: rowOf({ ...(res.body as SavedPrompt), ...(prompt!.usedByWorkflows ? { usedByWorkflows: prompt!.usedByWorkflows } : {}) }, true, ctx.caller, ctx.api.workspacesDir) };
  }
});

// ---------------------------------------------------------------------------
// A unified diff for the card (complete: every changed line is shown)
// ---------------------------------------------------------------------------

/** The longest-common-subsequence table is used while it stays small; past it, the changed middle is one block. */
const LCS_MAX_CELLS = 4_000_000;
const CONTEXT = 3;

type Op = { op: " " | "-" | "+"; line: string };

function lineOps(a: readonly string[], b: readonly string[]): Op[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const middle: Op[] = [];
  if (midA.length > 0 && midB.length > 0 && (midA.length + 1) * (midB.length + 1) <= LCS_MAX_CELLS) {
    const width = midB.length + 1;
    const table = new Uint32Array((midA.length + 1) * width);
    for (let i = midA.length - 1; i >= 0; i -= 1) {
      for (let j = midB.length - 1; j >= 0; j -= 1) {
        table[i * width + j] = midA[i] === midB[j] ? table[(i + 1) * width + j + 1]! + 1 : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < midA.length && j < midB.length) {
      if (midA[i] === midB[j]) {
        middle.push({ op: " ", line: midA[i]! });
        i += 1;
        j += 1;
      } else if (table[(i + 1) * width + j]! >= table[i * width + j + 1]!) {
        middle.push({ op: "-", line: midA[i]! });
        i += 1;
      } else {
        middle.push({ op: "+", line: midB[j]! });
        j += 1;
      }
    }
    for (; i < midA.length; i += 1) middle.push({ op: "-", line: midA[i]! });
    for (; j < midB.length; j += 1) middle.push({ op: "+", line: midB[j]! });
  } else {
    middle.push(...midA.map((line) => ({ op: "-" as const, line })), ...midB.map((line) => ({ op: "+" as const, line })));
  }
  return [...a.slice(0, start).map((line) => ({ op: " " as const, line })), ...middle, ...a.slice(endA).map((line) => ({ op: " " as const, line }))];
}

/** `before` → `after` as a unified diff with 3 lines of context, labelled `name`. */
export function unifiedDiff(before: string, after: string, name: string): string {
  const ops = lineOps(before.split("\n"), after.split("\n"));
  const out = [`--- a/${name}`, `+++ b/${name}`];
  let index = 0;
  while (index < ops.length) {
    if (ops[index]!.op === " ") {
      index += 1;
      continue;
    }
    // One hunk: from CONTEXT lines before this change to CONTEXT lines after the last change it absorbs.
    const from = Math.max(0, index - CONTEXT);
    let to = index;
    for (let k = index; k < ops.length; k += 1) {
      if (ops[k]!.op !== " ") to = k;
      else if (k - to > 2 * CONTEXT) break;
    }
    const end = Math.min(ops.length, to + CONTEXT + 1);
    const lineA = ops.slice(0, from).filter((op) => op.op !== "+").length + 1;
    const lineB = ops.slice(0, from).filter((op) => op.op !== "-").length + 1;
    const hunk = ops.slice(from, end);
    const countA = hunk.filter((op) => op.op !== "+").length;
    const countB = hunk.filter((op) => op.op !== "-").length;
    out.push(`@@ -${countA === 0 ? lineA - 1 : lineA},${countA} +${countB === 0 ? lineB - 1 : lineB},${countB} @@`);
    for (const op of hunk) out.push(`${op.op}${op.line}`);
    index = end;
  }
  return out.join("\n");
}

/** This family in the catalog (`../catalog/index.ts`). */
export const savedPromptsFamily: readonly AnyOrquesterTool[] = [listSavedPrompts, updateSavedPrompts];
