/**
 * One `ISessionManager` over two backends: the PTY sessions (tmux or direct
 * node-pty) and the chat tabs of §5.2.
 *
 * Why a router rather than a second service the routes have to learn about:
 * every existing surface — the tab strip, `GET /api/sessions`, the Attention
 * Center, the command palette, the push gate, the upload sweep, the
 * delete-project cascade, the system-status kill guard — reads exactly one
 * session list today. §7.1's rule is that `agent-chat` is treated as the agent
 * kind at each of those sites, and the cheapest way to make that true (and to
 * keep it true when someone adds the fourteenth site) is for there to be one
 * list.
 *
 * The PTY half owns `sessions.json`: it is the only writer, and the chat half
 * contributes its records through {@link SessionIndexContributor}. Two writers
 * on one atomic file would race each other's `rename()`.
 */

import { EventEmitter } from "node:events";
import { sep } from "node:path";
import type {
  AgentEventRequest,
  CreateSessionRequest,
  SessionActivity,
  SessionSummary
} from "@orquester/api";
import type { ISessionManager } from "../sessions.ts";
import type { ChatSessionManager } from "./chat-sessions.ts";

/**
 * What the router needs from whoever actually creates and destroys a chat
 * thread: the daemon route layer owns account/model validation and the host
 * call, so the router never talks to the host itself.
 */
export interface ChatSessionLifecycle {
  create(req: CreateSessionRequest): Promise<SessionSummary>;
  /** Cascade the host-side thread delete (§6.1). Best-effort; never throws. */
  onClose(id: string): void;
  /**
   * Append the host's `thread.meta-updated` for a rename (§6.1).
   *
   * `opts.seed` says this is the client's auto-seed from the first message,
   * not a rename the user typed — the host must leave such a title
   * replaceable by a provider retitle (§5.1, §7.7).
   */
  onRename(id: string, title: string, opts?: { seed?: boolean }): void;
}

export class ChatAwareSessionManager implements ISessionManager {
  readonly lifecycle = new EventEmitter();

  constructor(
    private readonly pty: ISessionManager,
    private readonly chat: ChatSessionManager,
    private readonly hooks: ChatSessionLifecycle
  ) {
    // One merged lifecycle so every existing subscriber keeps working. The PTY
    // backend also emits "output"; forward it verbatim (the URL watcher reads
    // it) — a chat tab never produces one.
    for (const event of ["created", "exited", "updated", "closed", "activity", "output"] as const) {
      this.pty.lifecycle.on(event, (payload: unknown) => this.lifecycle.emit(event, payload));
    }
    for (const event of ["created", "updated", "closed", "activity"] as const) {
      this.chat.lifecycle.on(event, (payload: unknown) => this.lifecycle.emit(event, payload));
    }
  }

  /** The per-project tab strip: both kinds, one `order` space, ascending. */
  list(projectPath?: string): SessionSummary[] {
    return [...this.pty.list(projectPath), ...this.chat.list(projectPath)].sort(
      (a, b) => a.order - b.order
    );
  }

  get(id: string): SessionSummary | undefined {
    return this.pty.get(id) ?? this.chat.get(id);
  }

  async create(req: CreateSessionRequest): Promise<SessionSummary> {
    if (req.kind === "agent-chat") {
      return this.hooks.create(req);
    }
    return this.pty.create(req);
  }

  /** Next free order in a project, across BOTH kinds. */
  nextOrder(projectPath: string): number {
    return this.list(projectPath).reduce((max, s) => Math.max(max, s.order), -1) + 1;
  }

  close(id: string): boolean {
    if (this.chat.has(id)) {
      // Cascade first: once the tab is forgotten the id is gone and the host
      // thread would be orphaned with its checkpoint refs.
      this.hooks.onClose(id);
      return this.chat.close(id);
    }
    return this.pty.close(id);
  }

  /**
   * `prefix` is the project (exact) or the workspace above it (`prefix + sep`),
   * matching `SessionManager.closeByProjectPrefix`. The separator is
   * `path.sep`, never a hardcoded `/`: on Windows — the documented no-tmux /
   * desktop host — deleting a workspace would otherwise leave every chat tab
   * under it open and every host thread orphaned.
   */
  closeByProjectPrefix(prefix: string): void {
    for (const id of this.chat.list().map((s) => s.id)) {
      const summary = this.chat.get(id);
      if (!summary) continue;
      const project = summary.projectPath;
      if (project === prefix || project.startsWith(prefix + sep)) {
        this.close(id);
      }
    }
    this.pty.closeByProjectPrefix(prefix);
  }

  rename(id: string, title: string, opts?: { seed?: boolean }): SessionSummary | undefined {
    if (this.chat.has(id)) {
      const current = this.chat.get(id);
      const renamed = this.chat.rename(id, title, current?.refId ?? id);
      if (renamed) this.hooks.onRename(id, renamed.title, opts);
      return renamed;
    }
    return this.pty.rename(id, title);
  }

  /**
   * §6.1: reorder is unchanged, and it now spans both kinds — `ids` is the
   * whole strip. Each backend is told the new index of the tabs it owns, so a
   * chat tab dragged between two terminals lands where the user dropped it.
   */
  reorder(projectPath: string, ids: string[]): void {
    let chatMoved = false;
    ids.forEach((id, index) => {
      if (!this.chat.has(id)) return;
      const summary = this.chat.get(id);
      if (!summary || summary.projectPath !== projectPath) return;
      if (this.chat.setOrder(id, index)) chatMoved = true;
    });
    // The PTY backend ignores ids it does not own, so the full list is safe to
    // hand over and it assigns the same indices from the same array.
    this.pty.reorder(projectPath, ids);
    if (chatMoved) this.persistIndexNow();
  }

  activity(id: string): SessionActivity | undefined {
    return this.chat.has(id) ? this.chat.get(id)?.activity : this.pty.activity(id);
  }

  /**
   * A chat session is **accepted and ignored**, never 404'd (SEAMS §2, W10).
   *
   * The account home's user-level `settings.json` carries Orquester's managed
   * terminal hooks, and a chat launch sets `ORQUESTER_SESSION_ID` too (spec
   * §3.1 requires it), so those hooks fire with a chat session id. The protocol
   * is the only activity source for a chat thread, so the event is dropped —
   * but answering 404 would make a hook look broken to the user's agent, and
   * the route's contract is "never break an agent".
   */
  agentEvent(id: string, req: AgentEventRequest): boolean {
    if (this.chat.has(id)) return true;
    return this.pty.agentEvent(id, req);
  }

  // --- PTY-only surface: a chat tab has no terminal ------------------------

  async scrollback(id: string): Promise<string> {
    return this.chat.has(id) ? "" : this.pty.scrollback(id);
  }

  buffer(id: string): string {
    return this.chat.has(id) ? "" : this.pty.buffer(id);
  }

  input(id: string, data: string): void {
    if (this.chat.has(id)) return;
    this.pty.input(id, data);
  }

  resize(id: string, cols: number, rows: number): void {
    if (this.chat.has(id)) return;
    this.pty.resize(id, cols, rows);
  }

  subscribe(
    id: string,
    onOutput: (data: string) => void,
    onExit: (code: number) => void
  ): () => void {
    if (this.chat.has(id)) return () => undefined;
    return this.pty.subscribe(id, onOutput, onExit);
  }

  // --- lifecycle -----------------------------------------------------------

  shutdown(): void {
    // Chat tabs are host-owned and survive a daemon restart exactly as the
    // threads do; there is nothing to detach.
    this.pty.shutdown();
  }

  closeAll(): void {
    for (const id of this.chat.list().map((s) => s.id)) this.close(id);
    this.pty.closeAll();
  }

  async reattach(): Promise<void> {
    await this.pty.reattach();
  }

  liveAccountIds(): Set<string> {
    const ids = this.pty.liveAccountIds();
    for (const id of this.chat.liveAccountIds()) ids.add(id);
    return ids;
  }

  persistIndexNow(): void {
    this.pty.persistIndexNow();
  }
}
