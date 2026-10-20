/**
 * Fakes for the token broker's tests: in-memory credential files with watchers, an accounts
 * service whose refresh is scripted, a registry with one project box, and a session list.
 */

import type { StoredBox } from "@orquester/config";

import type { AccountRefreshOutcome } from "../../agent-accounts.ts";
import type { BoxAgentId, ProjectLocation } from "../contracts.ts";
import type { AgentTokenBrokerDeps, TokenBrokerSession } from "./broker.ts";
import type { CredentialFiles } from "./credentials.ts";

export const NOW = Date.parse("2026-10-20T00:00:00.000Z");
export const MIN = 60_000;

export class FakeFiles implements CredentialFiles {
  readonly texts = new Map<string, string>();
  readonly lockAges = new Map<string, number>();
  private readonly watchers = new Map<string, Set<() => void>>();
  ownedHomeError: Error | null = null;

  async assertOwnedHome(): Promise<void> {
    if (this.ownedHomeError) throw this.ownedHomeError;
  }

  async read(path: string): Promise<string | null> {
    return this.texts.get(path) ?? null;
  }

  async ageOfNewest(paths: string[]): Promise<number | null> {
    const ages = paths.map((path) => this.lockAges.get(path)).filter((age): age is number => age !== undefined);
    return ages.length === 0 ? null : Math.min(...ages);
  }

  watch(path: string, onChange: () => void): () => void {
    const set = this.watchers.get(path) ?? new Set();
    set.add(onChange);
    this.watchers.set(path, set);
    return () => set.delete(onChange);
  }

  watcherCount(path: string): number {
    return this.watchers.get(path)?.size ?? 0;
  }

  /** Another process (a host CLI, the refresher) rewrote the file. */
  write(path: string, text: string): void {
    this.texts.set(path, text);
    for (const listener of [...(this.watchers.get(path) ?? [])]) listener();
  }
}

export function claudeCreds(accessToken: string, expiresAt: number, refreshToken = "claude-refresh-SECRET"): string {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken,
      refreshToken,
      expiresAt,
      refreshTokenExpiresAt: expiresAt + 30 * 24 * 60 * MIN,
      scopes: ["user:inference", "user:profile", "user:sessions:claude_code"],
      subscriptionType: "max",
      rateLimitTier: "default_claude_max_20x"
    },
    mcpOAuth: { someServer: { accessToken: "mcp-SECRET", refreshToken: "mcp-refresh-SECRET" } }
  });
}

export function jwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "RS256" })}.${b64(payload)}.c2lnbmF0dXJl`;
}

export function codexAuth(expSeconds: number, label = "a"): string {
  return JSON.stringify({
    OPENAI_API_KEY: null,
    auth_mode: "chatgpt",
    last_refresh: "2026-10-19T00:00:00Z",
    tokens: {
      access_token: jwt({ exp: expSeconds, label, "https://api.openai.com/auth": { chatgpt_account_id: "ws-claim" } }),
      account_id: "ws-1",
      id_token: jwt({ email: "codex-id-token-SECRET@example.com" }),
      refresh_token: "codex-refresh-SECRET"
    }
  });
}

export function grokAuth(key: string, expiresAt: number): string {
  return JSON.stringify({
    "https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828": {
      key,
      refresh_token: "grok-refresh-SECRET",
      expires_at: new Date(expiresAt).toISOString(),
      email: "g@example.com",
      oidc_issuer: "https://auth.x.ai",
      oidc_client_id: "b1a00492-073a-47ea-816f-4c329264a828"
    }
  });
}

export function homeOf(agent: BoxAgentId, id: string): string {
  return `/appdir/daemon/agent-accounts/${agent}/${id}/home`;
}

export function storedBox(overrides: Partial<StoredBox> = {}): StoredBox {
  return {
    id: "box-1",
    purpose: "project",
    kind: "linux",
    provider: "hetzner",
    region: "fsn1",
    size: "cx23",
    name: "orq-box-1",
    createdAt: "2026-10-19T00:00:00.000Z",
    state: "ready",
    project: { workspace: "w", name: "p", path: "/ws/w/p" },
    ...overrides
  };
}

export interface BrokerWorld {
  deps: AgentTokenBrokerDeps;
  files: FakeFiles;
  sessions: TokenBrokerSession[];
  hostLocal: Set<string>;
  boxes: Map<string, StoredBox>;
  accounts: Map<string, { id: string; agent: BoxAgentId }>;
  refreshCalls: Array<{ agent: BoxAgentId; id: string; allowHeld: boolean }>;
  /** What `refreshNow` does; defaults to "rewrite the file with a fresh token and answer refreshed". */
  refreshImpl: (agent: BoxAgentId, id: string) => Promise<AccountRefreshOutcome>;
  clock: { now: number };
  sessionsChanged(): void;
}

export function brokerWorld(): BrokerWorld {
  const files = new FakeFiles();
  const sessionListeners = new Set<() => void>();
  const clock = { now: NOW };
  const boxes = new Map<string, StoredBox>([["box-1", storedBox()]]);
  const accounts = new Map<string, { id: string; agent: BoxAgentId }>();
  const world: BrokerWorld = {
    files,
    sessions: [],
    hostLocal: new Set(),
    boxes,
    accounts,
    refreshCalls: [],
    clock,
    sessionsChanged: () => {
      for (const listener of [...sessionListeners]) listener();
    },
    refreshImpl: async (agent, id) => {
      const path = `${homeOf(agent, id)}/${agent === "claude" ? ".credentials.json" : "auth.json"}`;
      const exp = clock.now + 8 * 60 * MIN;
      files.write(
        path,
        agent === "claude"
          ? claudeCreds("claude-access-NEW", exp, "claude-refresh-NEW-SECRET")
          : agent === "codex"
            ? codexAuth(Math.floor(exp / 1000), "new")
            : grokAuth("grok-access-NEW", exp)
      );
      return "refreshed";
    },
    deps: undefined as unknown as AgentTokenBrokerDeps
  };
  world.deps = {
    accounts: {
      getRecord: (id) => accounts.get(id),
      homePath: (agent, id) => homeOf(agent as BoxAgentId, id),
      refreshNow: (agent, id, options) => {
        world.refreshCalls.push({ agent, id, allowHeld: options.allowHeld === true });
        return world.refreshImpl(agent, id);
      }
    },
    registry: {
      get: (boxId) => boxes.get(boxId),
      locate: (path): ProjectLocation => {
        for (const record of boxes.values()) {
          const root = record.project?.path;
          if (record.purpose === "project" && root && (path === root || path.startsWith(`${root}/`))) {
            return { kind: "box", boxId: record.id, record, connection: undefined };
          }
        }
        return { kind: "host" };
      }
    },
    sessions: () => world.sessions,
    hostLocalAccountIds: () => world.hostLocal,
    onSessionsChanged: (listener) => {
      sessionListeners.add(listener);
      return () => sessionListeners.delete(listener);
    },
    files,
    now: () => clock.now
  };
  return world;
}

/** Resolves once `predicate()` holds, re-checked on every microtask turn the test hands it (no timers). */
export async function settle(predicate: () => boolean, turns = 200): Promise<void> {
  for (let i = 0; i < turns; i++) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error("condition never became true");
}
