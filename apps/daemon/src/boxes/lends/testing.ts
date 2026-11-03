/**
 * The world of the lending tests: a real broker and a real box store over a temp appdir, the host's
 * logins in memory (`FakeFiles`), and the "VM" a `localBoxConnection()` writing real files under that
 * appdir. Time comes from `t.mock.timers` (`Date.now` and `setTimeout`); waits go through
 * {@link LendWorld.lends}'s `settled()` drain.
 */

import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";

import type { BoxLendAgent } from "@orquester/api";
import type { CallerPrincipal } from "@orquester/api/agent-chat";
import { agentAccountsDir, agentAccountsFile, type StoredBox } from "@orquester/config";

import type { AccountRefreshOutcome } from "../../agent-accounts.ts";
import { createAgentTokenBroker } from "../broker/broker.ts";
import { credentialPath } from "../broker/credentials.ts";
import { claudeCreds, FakeFiles, jwt, MIN, NOW, storedBox } from "../broker/testing.ts";
import type { AgentTokenBroker, BoxAgentId, BoxHub } from "../contracts.ts";
import { StoreBoxRegistry } from "../service/registry.ts";
import { BoxStore } from "../service/store.ts";
import { localBoxConnection, type LocalBoxConnection } from "../testing.ts";
import { AccountLends, hasActiveLend } from "./service.ts";

export { MIN, NOW };
export const BOX = "box-1";
export const PROJECT = "/ws/w/p";
export const HOUR = 60 * MIN;

/** The markers a test looks for in everything a VM receives. */
export const REFRESH_MARKER = "refresh-SECRET-MARKER";
export const ID_TOKEN_MARKER = "id-token-SECRET-MARKER";

export function chat(threadId: string, projectPath = PROJECT): CallerPrincipal {
  return { kind: "agent", threadId, projectPath };
}

/** A host `.credentials.json`, the refresh token being the marker. */
export function claudeLogin(accessToken: string, expiresAt: number): string {
  return claudeCreds(accessToken, expiresAt, REFRESH_MARKER);
}

/** A host `auth.json` with an unmistakable refresh token and id token. */
export function codexLogin(label: string, expiresAt: number): string {
  return JSON.stringify({
    OPENAI_API_KEY: null,
    auth_mode: "chatgpt",
    last_refresh: "2026-10-19T00:00:00Z",
    tokens: {
      access_token: jwt({ exp: Math.floor(expiresAt / 1000), label, "https://api.openai.com/auth": { chatgpt_account_id: "ws-claim" } }),
      account_id: "ws-1",
      id_token: ID_TOKEN_MARKER,
      refresh_token: REFRESH_MARKER
    }
  });
}

export interface LendWorld {
  base: string;
  store: BoxStore;
  files: FakeFiles;
  connection: LocalBoxConnection;
  registry: StoreBoxRegistry;
  broker: AgentTokenBroker;
  lends: AccountLends;
  /** Editable: `needsReauth`, new accounts. */
  accounts: { id: string; agent: string; label: string; needsReauth: boolean }[];
  sessions: { id: string; projectPath: string; accountId?: string }[];
  hostLocal: Set<string>;
  closedChats: Set<string>;
  refreshCalls: string[];
  /** What the provider answers a refresh with. Default: rewrite the login with a token good for 8 hours. */
  refreshImpl: (agent: BoxAgentId, id: string) => Promise<AccountRefreshOutcome>;
  enabled: { value: boolean };
  published: { count: number };
  warnings: string[];
  addAccount(agent: BoxLendAgent, id: string, label: string, expiresAt: number): void;
  hostPath(agent: BoxLendAgent, id: string): string;
  /** The login file on the "VM"; the host's are in memory, so one path means one file. */
  vmPath(agent: BoxLendAgent, id: string): string;
  vmIndexPath: string;
  readVm(path: string): Promise<string | null>;
  /** The link drops or returns, as the hub reports it. */
  setConnected(connected: boolean): void;
  /** A new service over the same records, as a daemon restart builds it (not started). */
  newService(): AccountLends;
}

export async function lendWorld(t: TestContext, box: Partial<StoredBox> = {}): Promise<LendWorld> {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: NOW });
  const base = await mkdtemp(join(tmpdir(), "orq-lends-"));
  t.after(() => rm(base, { recursive: true, force: true }));

  const store = new BoxStore({ baseDir: base, logger: { warn: () => undefined, error: () => undefined } });
  await store.load();
  await store.insert(storedBox({ id: BOX, project: { workspace: "w", name: "p", path: PROJECT }, ...box }));

  const connection = localBoxConnection({ boxId: BOX });
  const links = new EventEmitter();
  const hub = {
    get: (boxId: string) => (boxId === BOX ? connection : undefined),
    onConnectionChange: (listener: (boxId: string, connected: boolean) => void) => {
      links.on("change", listener);
      return () => void links.off("change", listener);
    }
  };
  const registry = new StoreBoxRegistry(store, hub as unknown as BoxHub, new Map(), () => Date.now());
  const files = new FakeFiles();
  const homePath = (agent: string, id: string): string => join(agentAccountsDir(base), agent, id, "home");
  const sessionListeners = new Set<() => void>();
  const accounts: LendWorld["accounts"] = [];

  const world: Omit<LendWorld, "broker" | "lends"> = {
    base,
    store,
    files,
    connection,
    registry,
    accounts,
    sessions: [],
    hostLocal: new Set(),
    closedChats: new Set(),
    refreshCalls: [],
    refreshImpl: async (agent, id) => {
      const expiresAt = Date.now() + 8 * HOUR;
      const label = `refreshed-${(world as LendWorld).refreshCalls.length}`;
      files.write(credentialPath(homePath(agent, id), agent), agent === "claude" ? claudeLogin(label, expiresAt) : codexLogin(label, expiresAt));
      return "refreshed";
    },
    enabled: { value: true },
    published: { count: 0 },
    warnings: [],
    addAccount(agent, id, label, expiresAt) {
      accounts.push({ id, agent, label, needsReauth: false });
      files.texts.set(credentialPath(homePath(agent, id), agent), agent === "claude" ? claudeLogin(`${id}-access`, expiresAt) : codexLogin(`${id}-access`, expiresAt));
    },
    hostPath: (agent, id) => credentialPath(homePath(agent, id), agent),
    vmPath: (agent, id) => credentialPath(homePath(agent, id), agent),
    vmIndexPath: agentAccountsFile(base),
    readVm: (path) => readFile(path, "utf8").catch(() => null),
    setConnected(next) {
      connection.setConnected(next);
      links.emit("change", BOX, next);
    },
    newService
  };

  const broker = createAgentTokenBroker({
    accounts: {
      getRecord: (id) => accounts.find((account) => account.id === id),
      homePath,
      refreshNow: (agent, id) => {
        world.refreshCalls.push(id);
        return world.refreshImpl(agent, id);
      }
    },
    registry,
    sessions: () => world.sessions,
    hostLocalAccountIds: () => world.hostLocal,
    onSessionsChanged: (listener) => {
      sessionListeners.add(listener);
      return () => sessionListeners.delete(listener);
    },
    files,
    isAccountLent: (boxId, accountId) => hasActiveLend(registry.get(boxId), accountId, Date.now()),
    now: () => Date.now()
  });

  function newService(): AccountLends {
    const service = new AccountLends({
      baseDir: base,
      accounts: { list: () => ({ accounts }), homePath },
      records: store,
      registry,
      hub,
      broker,
      files,
      sessions: () => world.sessions,
      chatOpen: (threadId) => !world.closedChats.has(threadId),
      enabled: () => world.enabled.value,
      publishChanged: () => {
        world.published.count += 1;
      },
      now: () => Date.now(),
      logger: { warn: (message: string) => void world.warnings.push(message) }
    });
    registry.setLendRuntime(service.runtimeOf);
    return service;
  }

  const lends = newService();
  await lends.start();
  t.after(() => lends.stop());
  return Object.assign(world, { broker, lends });
}
