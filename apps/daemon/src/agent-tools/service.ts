/**
 * Agent tools — the daemon's `agent-tools.json` (unified MCP design 2026-10-15 §9.6, §7.6, §9.3):
 * Settings › Agent tools (the master switch and the toolsets × agents matrix, with a `revision`),
 * each chat's toolset overrides, toolset declines (30 min) and the approval grants.
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
 * (`findGrant`), stamped `lastUsedAt` on use; a chat's grants and overrides are deleted with its
 * thread; a project grant whose project is missing is dropped only after REPEATED misses over time
 * ({@link PROJECT_GRANT_PRUNE_MISSES} checks spanning {@link PROJECT_GRANT_PRUNE_AFTER_MS}, counted by
 * `findGrant`) — never on one transient miss, never from a read route.
 *
 * Changes are announced on the bus (`agent-tools` / `agentTools.changed`) and a chat's toolset
 * change also through {@link AgentToolsService.onToolsetsChanged} (the chat transport re-lists or
 * restarts the provider session at its next idle point). Listeners run ASYNCHRONOUSLY (a microtask
 * after the change is saved — for an approved toolset card, after the card settled), so no listener
 * can change the outcome of the write or the card that caused it.
 */

import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFile, rename } from "node:fs/promises";

import {
  AGENT_TOOLS_AGENTS,
  isToolsetId,
  TOOLSET_IDS,
  TOOLSETS,
  type AgentToolGrant,
  type AgentToolsChangedPayload,
  type AgentToolsErrorCode,
  type AgentToolsetView,
  type AgentToolsResponse,
  type GrantScope,
  type ThreadAgentToolsResponse,
  type ToolsetId
} from "@orquester/api";
import type { AgentAdapterId } from "@orquester/api/agent-chat";
import {
  AGENT_TOOLSET_DECLINE_MS,
  createDefaultAgentToolsFile,
  findGrant as findGrantIn,
  parseAgentToolsFile,
  removeThreadFromAgentTools,
  resolveThreadToolsets,
  serializeAgentToolsFile,
  toolsetDeclinedUntil,
  type AgentToolGrantQuery,
  type AgentToolGrantRecord,
  type AgentToolsFile
} from "@orquester/config";

import { writeFileAtomic } from "../agent-hooks.ts";

/** The store's refusals: the wire's {@link AgentToolsErrorCode}s (a person-only write is the routes' own) plus `INVALID_ARGUMENT`. */
export type AgentToolsServiceErrorCode = Exclude<AgentToolsErrorCode, "PERMISSION_DENIED"> | "INVALID_ARGUMENT";

/** A refusal the routes answer verbatim: `status` with `{error: {code, message}}`. */
export class AgentToolsError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 503,
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

const EVENT_TOOLSETS_CHANGED = "toolsets-changed";

/** A project grant whose project is missing is pruned after this many `findGrant` misses… */
export const PROJECT_GRANT_PRUNE_MISSES = 3;
/** …spanning at least this long (a transient miss — an unmounted disk, a rename in flight — never prunes). */
export const PROJECT_GRANT_PRUNE_AFTER_MS = 60 * 60 * 1000;

export class AgentToolsService {
  private state: AgentToolsFile = createDefaultAgentToolsFile();
  /** Why the store is read-only this run, or null. */
  private blockedReason: string | null = null;
  private writes: Promise<void> = Promise.resolve();
  private readonly events = new EventEmitter();
  /** What each chat's running provider session advertises (the chat transport reports it), for `appliesAtNextIdle`. */
  private advertised: ((threadId: string) => readonly string[] | null) | null = null;
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
      this.opts.publish?.({ revision: this.state.revision, ...(threadId !== undefined ? { threadId } : {}) });
    } catch {
      // A bus failure never undoes a saved change.
    }
  }

  // -------------------------------------------------------------------------
  // Settings (§9.2)
  // -------------------------------------------------------------------------

  /** `GET /api/agent-tools`. A read: never writes. */
  settingsView(): AgentToolsResponse {
    const file = this.state;
    const toolsets: AgentToolsetView[] = TOOLSETS.map((toolset) => {
      const catalogDefaults = { ...toolset.defaults } as Record<AgentAdapterId, boolean>;
      const defaults = { ...catalogDefaults };
      const row = ownRow(file.toolsets.defaults, toolset.id);
      for (const agent of Object.keys(defaults) as AgentAdapterId[]) {
        if (toolset.locked) {
          defaults[agent] = true;
          continue;
        }
        const cell = row ? ownCell(row, agent) : undefined;
        if (cell !== undefined) defaults[agent] = cell;
      }
      return { id: toolset.id, label: toolset.label, locked: toolset.locked, tools: [...toolset.tools], catalogDefaults, defaults };
    });
    return {
      revision: file.revision,
      enabled: file.enabled,
      toolsets,
      grants: [...file.grants].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(wireGrant)
    };
  }

  /**
   * `PUT /api/agent-tools/settings`: `{revision, enabled?, defaults?}`. A stale revision is 409;
   * an unknown toolset or agent, a non-boolean cell, a locked toolset's cell 400.
   */
  updateSettings(body: unknown): AgentToolsResponse {
    const record = asRecord(body);
    if (!record) throw invalid("The body must be an object.");
    for (const key of Object.keys(record)) {
      if (key !== "revision" && key !== "enabled" && key !== "defaults") throw invalid(`Unknown field "${key.slice(0, 40)}".`);
    }
    if (typeof record.revision !== "number" || !Number.isSafeInteger(record.revision)) throw invalid("revision must be the integer from GET /api/agent-tools.");
    if (record.enabled !== undefined && typeof record.enabled !== "boolean") throw invalid("enabled must be a boolean.");
    const cells: [ToolsetId, AgentAdapterId, boolean | null][] = [];
    if (record.defaults !== undefined) {
      const defaults = asRecord(record.defaults);
      if (!defaults) throw invalid("defaults must be an object of toolset → agent → boolean | null.");
      for (const [toolsetId, row] of Object.entries(defaults)) {
        if (!isToolsetId(toolsetId)) throw invalid(`Unknown toolset "${toolsetId.slice(0, 40)}".`);
        const toolset = TOOLSETS.find((t) => t.id === toolsetId)!;
        const agents = asRecord(row);
        if (!agents) throw invalid(`defaults.${toolsetId} must be an object of agent → boolean | null.`);
        for (const [agent, value] of Object.entries(agents)) {
          if (!(AGENT_TOOLS_AGENTS as readonly string[]).includes(agent)) throw invalid(`Unknown agent "${agent.slice(0, 40)}".`);
          if (value !== null && typeof value !== "boolean") throw invalid(`defaults.${toolsetId}.${agent} must be a boolean or null.`);
          if (toolset.locked) throw new AgentToolsError(400, "TOOLSET_LOCKED", `${toolset.label} is always on.`);
          cells.push([toolsetId, agent as AgentAdapterId, value as boolean | null]);
        }
      }
    }
    if (record.revision !== this.state.revision) {
      throw new AgentToolsError(409, "REVISION_MISMATCH", "Agent tool settings changed meanwhile; reload them and try again.");
    }
    this.mutate((file) => {
      const defaults: Record<string, Record<string, boolean>> = { ...file.toolsets.defaults };
      for (const [toolsetId, agent, value] of cells) {
        const row = { ...(ownRow(defaults, toolsetId) ?? {}) };
        if (value === null) delete row[agent];
        else row[agent] = value;
        if (Object.keys(row).length === 0) delete defaults[toolsetId];
        else defaults[toolsetId] = row;
      }
      return {
        ...file,
        revision: file.revision + 1,
        ...(typeof record.enabled === "boolean" ? { enabled: record.enabled } : {}),
        toolsets: { ...file.toolsets, defaults }
      };
    });
    this.publish();
    this.emitToolsetsChanged(null);
    return this.settingsView();
  }

  // -------------------------------------------------------------------------
  // Chat toolsets (§9.2, §9.3)
  // -------------------------------------------------------------------------

  /** The toolsets on in a chat now, in catalog order (the manifest reads it). */
  resolvedToolsets(threadId: string, agent: string): ToolsetId[] {
    return resolveThreadToolsets(this.state, { threadId, agent, toolsets: TOOLSETS }).filter(isToolsetId);
  }

  /** Whether `toolset` is on in the chat now. */
  isToolsetOn(threadId: string, agent: string, toolset: ToolsetId): boolean {
    return this.resolvedToolsets(threadId, agent).includes(toolset);
  }

  /** The chat transport reports what each running provider session advertises (`appliesAtNextIdle`). */
  setAdvertisedToolsets(source: (threadId: string) => readonly string[] | null): void {
    this.advertised = source;
  }

  /** `GET agentChatRoutes.agentTools(id)`. */
  threadView(threadId: string, info: AgentToolsThreadInfo): ThreadAgentToolsResponse {
    const file = this.state;
    const overrides: Partial<Record<ToolsetId, boolean>> = {};
    for (const [toolset, on] of Object.entries(ownRow(file.toolsets.threads, threadId) ?? {})) {
      if (isToolsetId(toolset) && typeof on === "boolean") overrides[toolset] = on;
    }
    const resolved = this.resolvedToolsets(threadId, info.agent);
    const advertised = this.advertised?.(threadId) ?? null;
    const declines: Partial<Record<ToolsetId, string>> = {};
    for (const toolset of TOOLSET_IDS) {
      const until = this.toolsetDeclinedUntil(threadId, toolset);
      if (until !== null) declines[toolset] = until;
    }
    return {
      threadId,
      agent: info.agent,
      overrides,
      resolved,
      workflowOwned: info.workflowOwned,
      appliesAtNextIdle: advertised !== null && !sameSet(advertised, resolved),
      declines,
      grants: this.grantsFor(threadId, info.projectPath).map(wireGrant)
    };
  }

  /**
   * `PUT agentChatRoutes.agentTools(id)`: `{toolsets: {id: boolean | null}}` — set or clear the
   * chat's overrides. Locked or unknown toolsets are refused.
   */
  updateThreadToolsets(threadId: string, body: unknown, info: AgentToolsThreadInfo): ThreadAgentToolsResponse {
    const record = asRecord(body);
    if (!record || Object.keys(record).some((key) => key !== "toolsets")) throw invalid('The body must be {"toolsets": {<toolset>: true | false | null}}.');
    const toolsets = asRecord(record.toolsets);
    if (!toolsets) throw invalid("toolsets must be an object of toolset → boolean | null.");
    const changes: [ToolsetId, boolean | null][] = [];
    for (const [toolsetId, value] of Object.entries(toolsets)) {
      if (!isToolsetId(toolsetId)) throw invalid(`Unknown toolset "${toolsetId.slice(0, 40)}".`);
      if (value !== null && typeof value !== "boolean") throw invalid(`toolsets.${toolsetId} must be a boolean or null.`);
      if (TOOLSETS.find((t) => t.id === toolsetId)!.locked) throw new AgentToolsError(400, "TOOLSET_LOCKED", "Chats & delegation is always on.");
      changes.push([toolsetId, value as boolean | null]);
    }
    if (changes.length > 0) {
      this.setThreadOverrides(threadId, changes);
      this.publish(threadId);
      this.emitToolsetsChanged(threadId);
    }
    return this.threadView(threadId, info);
  }

  /** An approved toolset card: the chat override is ON (persisted), then the change is announced. */
  enableToolsetForThread(threadId: string, toolset: ToolsetId): void {
    this.setThreadOverrides(threadId, [[toolset, true]]);
    this.publish(threadId);
    this.emitToolsetsChanged(threadId);
  }

  /** A denied toolset card: asking for it again in this chat is refused for 30 min. Returns until when (ISO). */
  recordToolsetDecline(threadId: string, toolset: ToolsetId): string {
    const at = this.now();
    this.mutate((file) => ({
      ...file,
      toolsetDeclines: { ...file.toolsetDeclines, [threadId]: { ...(ownRow(file.toolsetDeclines, threadId) ?? {}), [toolset]: new Date(at).toISOString() } }
    }));
    this.publish(threadId);
    return new Date(at + AGENT_TOOLSET_DECLINE_MS).toISOString();
  }

  /** ISO time from which `toolset` may be asked for again in the chat, or null. */
  toolsetDeclinedUntil(threadId: string, toolset: ToolsetId): string | null {
    const until = toolsetDeclinedUntil(this.state, threadId, toolset, this.now());
    return until === null ? null : new Date(until).toISOString();
  }

  /**
   * Listen for a chat's toolsets changing (`threadId`), or every chat's (`null`: a settings change).
   * Called asynchronously (a microtask after the change was applied and, for a toolset card, after
   * the card settled); a listener's result or error never affects the write or the card.
   *
   * Timing for an approved toolset card: the listener runs AFTER the card settles but BEFORE the
   * awaiting `request()` resumes in the executor — `request_toolset`'s result has not been sent to
   * the provider yet. A listener must not restart or re-list the chat's session synchronously; it
   * schedules that for the chat's next idle point.
   */
  onToolsetsChanged(listener: (threadId: string | null) => void): () => void {
    this.events.on(EVENT_TOOLSETS_CHANGED, listener);
    return () => this.events.off(EVENT_TOOLSETS_CHANGED, listener);
  }

  /** Listeners run in a microtask: after the caller (e.g. the card settling) is done, never inside it. */
  private emitToolsetsChanged(threadId: string | null): void {
    const listeners = this.events.listeners(EVENT_TOOLSETS_CHANGED) as ((id: string | null) => void)[];
    if (listeners.length === 0) return;
    queueMicrotask(() => {
      for (const listener of listeners) {
        try {
          listener(threadId);
        } catch (error) {
          this.opts.logger?.warn?.("agent-tools: a toolsets-changed listener failed", error instanceof Error ? error.name : typeof error);
        }
      }
    });
  }

  private setThreadOverrides(threadId: string, changes: readonly [ToolsetId, boolean | null][]): void {
    this.mutate((file) => {
      const row: Record<string, boolean> = { ...(ownRow(file.toolsets.threads, threadId) ?? {}) };
      for (const [toolset, value] of changes) {
        if (value === null) delete row[toolset];
        else row[toolset] = value;
      }
      const threads: Record<string, Record<string, boolean>> = { ...file.toolsets.threads };
      if (Object.keys(row).length === 0) delete threads[threadId];
      else threads[threadId] = row;
      return { ...file, toolsets: { ...file.toolsets, threads } };
    });
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

  /** The chat is gone (its tab closed): its overrides, declines and chat grants go with it. */
  removeThread(threadId: string): void {
    const file = this.state;
    const touches =
      Object.prototype.hasOwnProperty.call(file.toolsets.threads, threadId) ||
      Object.prototype.hasOwnProperty.call(file.toolsetDeclines, threadId) ||
      Object.prototype.hasOwnProperty.call(file.unreadableCells?.threads ?? {}, threadId) ||
      Object.prototype.hasOwnProperty.call(file.unreadableCells?.toolsetDeclines ?? {}, threadId) ||
      file.grants.some((g) => g.scope === "chat" && g.threadId === threadId);
    if (!touches || this.blockedReason !== null) return;
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

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function invalid(message: string): AgentToolsError {
  return new AgentToolsError(400, "INVALID_ARGUMENT", message);
}

function ownRow<T>(matrix: Record<string, T>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(matrix, key) ? matrix[key] : undefined;
}

function ownCell(row: Record<string, boolean>, key: string): boolean | undefined {
  if (!Object.prototype.hasOwnProperty.call(row, key)) return undefined;
  return typeof row[key] === "boolean" ? row[key] : undefined;
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...left].every((x) => right.has(x));
}

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
