/**
 * Agent tools — the daemon's `agent-tools.json` (unified MCP design 2026-10-15 §9.6, §7.6): the
 * approval grants. Every chat tool is on in every chat; there are no toolset switches to store
 * (an older build's are kept in the file verbatim and never read, `@orquester/config`).
 *
 * The durability model of `saved-prompts.ts`:
 * - in-memory state mirrored to the file with an atomic tmp+rename write (0600); writes are
 *   SERIALIZED and each one serializes the state when it runs, so the last write carries the last
 *   state;
 * - a file this build cannot parse is MOVED ASIDE (`agent-tools.json.corrupt-<stamp>`) and the
 *   defaults apply — with NO grants (fail closed); a file that cannot be read, or a corrupt one
 *   that cannot be moved, makes the store read-only for this run (defaults, no grants, every
 *   mutation refused 503) so nothing is written over it;
 * - whatever the file holds that this build does not know is written back verbatim
 *   (`@orquester/config`'s tolerant parse/serialize).
 *
 * Grants (§7.6, MUST 8): honoured only for `full-access`, non workflow-owned callers
 * (`findGrant`), stamped `lastUsedAt` on use; a chat's grants are deleted with its thread; a
 * project grant whose project is missing is dropped only after REPEATED misses over time
 * ({@link PROJECT_GRANT_PRUNE_MISSES} checks spanning {@link PROJECT_GRANT_PRUNE_AFTER_MS}, counted by
 * `findGrant`) — never on one transient miss, never from a read route.
 *
 * Changes are announced on the bus (`agent-tools` / `agentTools.changed`).
 */

import { randomUUID } from "node:crypto";
import { readFile, rename } from "node:fs/promises";

import {
  type AgentToolGrant,
  type AgentToolsChangedPayload,
  type AgentToolsErrorCode,
  type AgentToolsResponse,
  type GrantScope,
  type ThreadAgentToolsResponse
} from "@orquester/api";
import type { AgentAdapterId } from "@orquester/api/agent-chat";
import {
  createDefaultAgentToolsFile,
  findGrant as findGrantIn,
  parseAgentToolsFile,
  removeThreadFromAgentTools,
  serializeAgentToolsFile,
  type AgentToolGrantQuery,
  type AgentToolGrantRecord,
  type AgentToolsFile
} from "@orquester/config";

import { writeFileAtomic } from "../agent-hooks.ts";

/** The store's refusals: the wire's {@link AgentToolsErrorCode}s (a person-only write is the routes' own). */
export type AgentToolsServiceErrorCode = Exclude<AgentToolsErrorCode, "PERMISSION_DENIED">;

/** A refusal the routes answer verbatim: `status` with `{error: {code, message}}`. */
export class AgentToolsError extends Error {
  constructor(
    readonly status: 404 | 503,
    readonly code: AgentToolsServiceErrorCode,
    message: string
  ) {
    super(message);
    this.name = "AgentToolsError";
  }
}

/** What the thread routes know of a chat (its agent and trait), resolved by the daemon. */
export interface AgentToolsThreadInfo {
  agent: AgentAdapterId;
  projectPath: string;
  workflowOwned: boolean;
}

/** A grant to record when a card is approved with a grant choice. */
export interface NewAgentToolGrant {
  family: string;
  scope: GrantScope;
  /** The caller's project (canonical); "" with none. */
  projectPath: string;
  threadId: string;
  targetProjectPath?: string;
  workflowId?: string;
}

export interface AgentToolsServiceOptions {
  /** `agentToolsFile(baseDir)`. */
  file: string;
  /** Publish `agentTools.changed` on the `agent-tools` channel. */
  publish?(payload: AgentToolsChangedPayload): void;
  /** Whether a project still exists (project grants of a long-missing project are pruned). Default: yes. */
  projectExists?(path: string): boolean;
  now?: () => number;
  newId?: () => string;
  logger?: { warn?: (...args: unknown[]) => void; error?: (...args: unknown[]) => void };
}

/** A project grant whose project is missing is pruned after this many `findGrant` misses… */
export const PROJECT_GRANT_PRUNE_MISSES = 3;
/** …spanning at least this long (a transient miss — an unmounted disk, a rename in flight — never prunes). */
export const PROJECT_GRANT_PRUNE_AFTER_MS = 60 * 60 * 1000;

export class AgentToolsService {
  private state: AgentToolsFile = createDefaultAgentToolsFile();
  /** Why the store is read-only this run, or null. */
  private blockedReason: string | null = null;
  private writes: Promise<void> = Promise.resolve();
  /** Project grants seen with their project missing: grant id → first miss and count (memory only). */
  private readonly projectMisses = new Map<string, { firstAt: number; count: number }>();

  constructor(private readonly opts: AgentToolsServiceOptions) {}

  // -------------------------------------------------------------------------
  // Load / persist
  // -------------------------------------------------------------------------

  /** Read the file. Missing → defaults (nothing written until the first change). Never throws. */
  async load(): Promise<void> {
    this.state = createDefaultAgentToolsFile();
    this.blockedReason = null;
    let text: string;
    try {
      text = await readFile(this.opts.file, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT") return;
      this.block(`agent-tools.json could not be read (${code ?? "unknown error"})`);
      return;
    }
    try {
      this.state = parseAgentToolsFile(JSON.parse(text));
    } catch (error) {
      await this.quarantine(error instanceof Error ? error.message : String(error));
      return;
    }
    if (this.state.unreadableGrants.length > 0) {
      this.opts.logger?.warn?.(
        `agent-tools.json: ${this.state.unreadableGrants.length} grant(s) this build cannot read are never honoured; they stay in the file.`
      );
    }
  }

  /** Wait for every queued write. */
  flush(): Promise<void> {
    return this.writes;
  }

  /** The current state (do not mutate). */
  snapshot(): AgentToolsFile {
    return this.state;
  }

  /** Whether mutations are refused this run. */
  isReadOnly(): boolean {
    return this.blockedReason !== null;
  }

  private block(reason: string): void {
    this.blockedReason = reason;
    this.state = createDefaultAgentToolsFile();
    this.opts.logger?.error?.(`${reason}. Agent tool settings are read-only and no grant is honoured until it is fixed and the daemon restarts.`);
  }

  private async quarantine(detail: string): Promise<void> {
    const aside = `${this.opts.file}.corrupt-${new Date(this.now()).toISOString().replace(/[:.]/g, "-")}`;
    try {
      await rename(this.opts.file, aside);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      this.block(`agent-tools.json is corrupt (${detail}) and could not be moved aside (${code ?? "unknown error"})`);
      return;
    }
    this.state = createDefaultAgentToolsFile();
    this.opts.logger?.warn?.(`agent-tools.json is corrupt (${detail}); moved it to ${aside}. Defaults apply and no grant is honoured.`);
  }

  /** Apply `change` to a copy of the state, swap it in, and queue the write. Refused while read-only. */
  private mutate(change: (file: AgentToolsFile) => AgentToolsFile): AgentToolsFile {
    if (this.blockedReason !== null) {
      throw new AgentToolsError(503, "AGENT_TOOLS_UNAVAILABLE", "Agent tool settings are read-only until agent-tools.json is fixed and Orquester restarts.");
    }
    this.state = change(this.state);
    void this.persist();
    return this.state;
  }

  private persist(): Promise<void> {
    const write = async (): Promise<void> => {
      if (this.blockedReason !== null) return;
      try {
        await writeFileAtomic(this.opts.file, `${serializeAgentToolsFile(this.state)}\n`, 0o600);
      } catch (error) {
        this.opts.logger?.error?.("Failed to persist agent-tools.json", error instanceof Error ? error.name : typeof error);
      }
    };
    this.writes = this.writes.then(write, write);
    return this.writes;
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  private publish(threadId?: string): void {
    try {
      this.opts.publish?.(threadId !== undefined ? { threadId } : {});
    } catch {
      // A bus failure never undoes a saved change.
    }
  }

  // -------------------------------------------------------------------------
  // Reads (Settings › Agent tools, the chat's Tools chip)
  // -------------------------------------------------------------------------

  /** `GET /api/agent-tools`: every grant, newest first. A read: never writes. */
  settingsView(): AgentToolsResponse {
    return { grants: [...this.state.grants].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(wireGrant) };
  }

  /** `GET agentChatRoutes.agentTools(id)`. */
  threadView(threadId: string, info: AgentToolsThreadInfo): ThreadAgentToolsResponse {
    return {
      threadId,
      agent: info.agent,
      workflowOwned: info.workflowOwned,
      grants: this.grantsFor(threadId, info.projectPath).map(wireGrant)
    };
  }

  // -------------------------------------------------------------------------
  // Grants (§7.6)
  // -------------------------------------------------------------------------

  /** The grant covering a gated call, or null (config `findGrant`); a hit is stamped `lastUsedAt`. */
  findGrant(query: AgentToolGrantQuery): AgentToolGrantRecord | null {
    this.pruneGrantsOfRemovedProjects();
    const grant = findGrantIn(this.state, query);
    if (!grant) return null;
    const lastUsedAt = new Date(this.now()).toISOString();
    if (this.blockedReason === null) {
      this.mutate((file) => ({ ...file, grants: file.grants.map((g) => (g.id === grant.id ? { ...g, lastUsedAt } : g)) }));
    }
    return { ...grant, lastUsedAt };
  }

  /**
   * Record a grant an approved card chose. A matching grant of the same chat (or project) is reused
   * (a `workflows` chat grant gains the workflow id) rather than duplicated. Returns its id; a new
   * grant takes `id` when given (from {@link plannedGrantId}).
   */
  addGrant(input: NewAgentToolGrant, id?: string): string {
    const createdAt = new Date(this.now()).toISOString();
    const existing = this.sameGrant(input);
    if (existing) {
      if (input.workflowId !== undefined) this.appendWorkflow(existing.id, input.workflowId);
      this.publish(input.scope === "chat" ? input.threadId : undefined);
      return existing.id;
    }
    const grant: AgentToolGrantRecord = {
      id: id ?? this.newGrantId(),
      family: input.family,
      scope: input.scope,
      projectPath: input.projectPath,
      ...(input.scope === "chat" ? { threadId: input.threadId } : {}),
      ...(input.targetProjectPath !== undefined ? { targetProjectPath: input.targetProjectPath } : {}),
      ...(input.family === "workflows" ? { workflowIds: input.workflowId !== undefined ? [input.workflowId] : [] } : {}),
      createdAt
    };
    this.mutate((file) => ({ ...file, grants: [...file.grants, grant] }));
    this.publish(input.scope === "chat" ? input.threadId : undefined);
    return grant.id;
  }

  /**
   * The id {@link addGrant} would answer for `input` now — the equal grant's, or a fresh one to pass
   * back to it — without recording anything (a card's grant is recorded only once its call passed
   * the post-card gate re-run; the answer names it before that).
   */
  plannedGrantId(input: NewAgentToolGrant): string {
    return this.sameGrant(input)?.id ?? this.newGrantId();
  }

  private newGrantId(): string {
    return (this.opts.newId ?? (() => `g_${randomUUID()}`))();
  }

  /** The grant of the same chat (or project) `input` would reuse rather than duplicate. */
  private sameGrant(input: NewAgentToolGrant): AgentToolGrantRecord | undefined {
    return this.state.grants.find(
      (grant) =>
        grant.family === input.family &&
        grant.scope === input.scope &&
        grant.projectPath === input.projectPath &&
        (input.scope === "project" || grant.threadId === input.threadId) &&
        (grant.targetProjectPath ?? null) === (input.targetProjectPath ?? null)
    );
  }

  /**
   * Add `workflowId` to the chat's `workflows` grant `grantId` (§7.6) — only when `grantId` IS that
   * chat's `workflows` chat grant in that project. Returns the grant id, or null (a no-op): there is
   * no fallback to "the chat's grant" (ruling: approving once never widens a standing grant).
   */
  recordWorkflowInGrant(input: { threadId: string; callerProjectPath: string; workflowId: string; grantId: string }): string | null {
    const grant = this.state.grants.find(
      (g) =>
        g.id === input.grantId &&
        g.family === "workflows" &&
        g.scope === "chat" &&
        g.threadId === input.threadId &&
        g.projectPath === input.callerProjectPath
    );
    if (!grant) return null;
    if (!(grant.workflowIds ?? []).includes(input.workflowId)) {
      this.appendWorkflow(grant.id, input.workflowId);
      this.publish(input.threadId);
    }
    return grant.id;
  }

  /** The chat's `workflows` chat grant in that project, or null. */
  chatWorkflowGrant(threadId: string, projectPath: string): AgentToolGrantRecord | null {
    return this.state.grants.find((g) => g.family === "workflows" && g.scope === "chat" && g.threadId === threadId && g.projectPath === projectPath) ?? null;
  }

  private appendWorkflow(grantId: string, workflowId: string): void {
    this.mutate((file) => ({
      ...file,
      grants: file.grants.map((g) =>
        g.id === grantId && !(g.workflowIds ?? []).includes(workflowId) ? { ...g, workflowIds: [...(g.workflowIds ?? []), workflowId] } : g
      )
    }));
  }

  /** `DELETE /api/agent-tools/grants/:id`: effective for the next call. */
  revokeGrant(grantId: string): void {
    const grant = this.state.grants.find((g) => g.id === grantId);
    if (!grant) throw new AgentToolsError(404, "GRANT_NOT_FOUND", "No such grant (it may have been revoked already).");
    this.mutate((file) => ({ ...file, grants: file.grants.filter((g) => g.id !== grantId) }));
    this.publish(grant.scope === "chat" ? grant.threadId : undefined);
  }

  /** `DELETE /api/agent-tools/grants[?threadId=]`: every grant, or one chat's. Returns how many. */
  revokeGrants(threadId?: string): number {
    const doomed = this.state.grants.filter((g) => threadId === undefined || (g.scope === "chat" && g.threadId === threadId));
    if (doomed.length === 0) return 0;
    const ids = new Set(doomed.map((g) => g.id));
    this.mutate((file) => ({ ...file, grants: file.grants.filter((g) => !ids.has(g.id)) }));
    this.publish(threadId);
    return doomed.length;
  }

  /** A chat's grants and its project's project grants, newest first. */
  grantsFor(threadId: string, projectPath: string): AgentToolGrantRecord[] {
    return this.state.grants
      .filter((g) => (g.scope === "chat" && g.threadId === threadId) || (g.scope === "project" && projectPath !== "" && g.projectPath === projectPath))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** The chat is gone (its tab closed): its chat grants (and its rows of an older build's legacy keys) go with it. */
  removeThread(threadId: string): void {
    if (this.blockedReason !== null || removeThreadFromAgentTools(this.state, threadId) === this.state) return;
    this.mutate((current) => removeThreadFromAgentTools(current, threadId));
    this.publish();
  }

  /**
   * Count misses of project grants whose project is gone; drop one only once it has missed
   * {@link PROJECT_GRANT_PRUNE_MISSES} times over at least {@link PROJECT_GRANT_PRUNE_AFTER_MS}. A
   * project seen again resets its count.
   */
  private pruneGrantsOfRemovedProjects(): void {
    const exists = this.opts.projectExists;
    if (!exists || this.blockedReason !== null) return;
    const now = this.now();
    const gone: string[] = [];
    for (const grant of this.state.grants) {
      if (grant.scope !== "project" || grant.projectPath === "") continue;
      if (exists(grant.projectPath)) {
        this.projectMisses.delete(grant.id);
        continue;
      }
      const miss = this.projectMisses.get(grant.id) ?? { firstAt: now, count: 0 };
      miss.count += 1;
      this.projectMisses.set(grant.id, miss);
      if (miss.count >= PROJECT_GRANT_PRUNE_MISSES && now - miss.firstAt >= PROJECT_GRANT_PRUNE_AFTER_MS) gone.push(grant.id);
    }
    if (gone.length === 0) return;
    for (const id of gone) this.projectMisses.delete(id);
    const ids = new Set(gone);
    this.mutate((file) => ({ ...file, grants: file.grants.filter((g) => !ids.has(g.id)) }));
    this.publish();
  }
}

// ---------------------------------------------------------------------------

/** A grant as the wire shows it: the known fields only (a newer build's extra keys stay on disk). */
function wireGrant(grant: AgentToolGrantRecord): AgentToolGrant {
  return {
    id: grant.id,
    family: grant.family,
    scope: grant.scope,
    projectPath: grant.projectPath,
    ...(grant.threadId !== undefined ? { threadId: grant.threadId } : {}),
    ...(grant.targetProjectPath !== undefined ? { targetProjectPath: grant.targetProjectPath } : {}),
    ...(grant.workflowIds !== undefined ? { workflowIds: [...grant.workflowIds] } : {}),
    createdAt: grant.createdAt,
    ...(grant.lastUsedAt !== undefined ? { lastUsedAt: grant.lastUsedAt } : {})
  };
}
