/**
 * MCP Apps — the consent an app's request waits on (spec 2026-10-14 §3): a
 * call to a tool its server does not mark read-only, a chat message, a file
 * to save. Asked in the chat's banner dock, as an approval is
 * (`ChatBannerDock` renders the front request of its session), one at a time,
 * never a modal. Pure; the dock subscribes, frames ask.
 *
 * Nobody to ask is an answer of its own (`undefined`): a session whose dock
 * is not mounted — a read-only drill-in, a tab not on screen — cannot be
 * asked, and the app is told so rather than told the user declined.
 */

export type McpAppConsentKind = "tool" | "message" | "download";

export interface McpAppConsentRequest {
  readonly id: string;
  readonly sessionId: string;
  readonly kind: McpAppConsentKind;
  /** The MCP server the app belongs to. */
  readonly appName: string;
  /** "Run show_chart?", "Send a message?", "Save report.pdf?". */
  readonly title: string;
  /** What is asked about, verbatim: the arguments, the message, the file names. */
  readonly detail: string;
}

interface Entry {
  readonly request: McpAppConsentRequest;
  readonly owner: string;
  readonly resolve: (allowed: boolean | undefined) => void;
}

const EMPTY: readonly McpAppConsentRequest[] = Object.freeze([]);

export class McpAppConsentQueue {
  private readonly entries = new Map<string, Entry[]>();
  private readonly views = new Map<string, readonly McpAppConsentRequest[]>();
  private readonly docks = new Map<string, number>();
  private readonly listeners = new Set<() => void>();
  private nextId = 0;

  /** A dock that can ask for `sessionId` is mounted; the returned function unmounts it. */
  attachDock(sessionId: string): () => void {
    this.docks.set(sessionId, (this.docks.get(sessionId) ?? 0) + 1);
    let attached = true;
    return () => {
      if (!attached) return;
      attached = false;
      const left = (this.docks.get(sessionId) ?? 1) - 1;
      if (left > 0) {
        this.docks.set(sessionId, left);
        return;
      }
      this.docks.delete(sessionId);
      // Nobody can answer these any more.
      this.settle((entry) => entry.request.sessionId === sessionId, undefined);
    };
  }

  /**
   * Ask. Resolves `true` (allowed), `false` (declined), or `undefined` when no
   * dock can ask for the session. `owner` names the frame asking, so an
   * unmounting frame withdraws its own ({@link withdraw}).
   */
  ask(owner: string, input: Omit<McpAppConsentRequest, "id">): Promise<boolean | undefined> {
    if ((this.docks.get(input.sessionId) ?? 0) === 0) {
      return Promise.resolve(undefined);
    }
    const request: McpAppConsentRequest = { ...input, id: `mcp-consent-${++this.nextId}` };
    return new Promise((resolve) => {
      const list = this.entries.get(input.sessionId) ?? [];
      this.entries.set(input.sessionId, [...list, { request, owner, resolve }]);
      this.changed(input.sessionId);
    });
  }

  /** The user's answer to one request. */
  answer(id: string, allowed: boolean): void {
    this.settle((entry) => entry.request.id === id, allowed);
  }

  /** A frame went away: what it still waits on is declined. */
  withdraw(owner: string): void {
    this.settle((entry) => entry.owner === owner, false);
  }

  /** The session's waiting requests, oldest first. Stable until the next change. */
  pending(sessionId: string): readonly McpAppConsentRequest[] {
    return this.views.get(sessionId) ?? EMPTY;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private settle(match: (entry: Entry) => boolean, allowed: boolean | undefined): void {
    for (const [sessionId, list] of [...this.entries]) {
      const settled = list.filter(match);
      if (settled.length === 0) continue;
      const rest = list.filter((entry) => !match(entry));
      if (rest.length === 0) this.entries.delete(sessionId);
      else this.entries.set(sessionId, rest);
      this.changed(sessionId);
      for (const entry of settled) entry.resolve(allowed);
    }
  }

  private changed(sessionId: string): void {
    const list = this.entries.get(sessionId);
    if (list === undefined || list.length === 0) this.views.delete(sessionId);
    else this.views.set(sessionId, Object.freeze(list.map((entry) => entry.request)));
    for (const listener of [...this.listeners]) listener();
  }
}

/** The app-wide queue the frames and the docks share. */
export const mcpAppConsents = new McpAppConsentQueue();
