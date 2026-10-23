/**
 * The box service over the daemon's own services: Git hosting accounts (`AccountsService`), the
 * managed agent account homes, the plugin switch (`PluginsService`) and the `/events` broadcaster.
 * `startDaemon` calls {@link createDaemonBoxService} with the other modules' parts (hub, adapters,
 * bootstrap, Tailscale, sync, tooling, the Blacksmith driver).
 */

import { readFile } from "node:fs/promises";

import { EPHEMERAL_VMS_PLUGIN_ID, type PluginsResponse } from "@orquester/api";
import { parseAccountsConfig } from "@orquester/config";

import type { AccountsService } from "../../accounts.ts";
import type { AgentAccountsService } from "../../agent-accounts.ts";
import type { Broadcaster } from "../../broadcaster.ts";
import type { PluginsService } from "../../plugins/plugins-service.ts";
import type { BoxAgentId } from "../contracts.ts";
import { createBoxService, type BoxService, type BoxServiceDeps } from "./index.ts";
import { knownHostsForBox } from "./known-hosts.ts";
import type { ManagedAgentHome } from "./lifecycle.ts";

const BOX_AGENTS: readonly string[] = ["claude", "codex", "grok"] satisfies BoxAgentId[];

export interface DaemonBoxHost {
  baseDir: string;
  /** `<appdir>/daemon/keys` (the daemon-owned known_hosts lives there). */
  keysDir: string;
  /** The daemon user's home (its `~/.ssh/known_hosts`). */
  home: string;
  /** `accounts.json`: an account's git endpoint (provider, hosts) for the box's SSH-only git setup. */
  accountsFile: string;
  accounts: AccountsService;
  agentAccounts: Pick<AgentAccountsService, "list" | "homePath">;
  plugins: Pick<PluginsService, "get" | "events">;
  broadcaster: Pick<Broadcaster, "publish">;
  /** The daemon's configured public origin, when it has one. */
  publicOrigin: () => string | null;
  logger?: Pick<Console, "warn" | "error" | "log">;
}

/** The parts other box modules provide. */
export type DaemonBoxParts = Pick<
  BoxServiceDeps,
  "providers" | "hub" | "buildBootstrap" | "tailscale" | "configSync" | "tooling" | "blacksmith" | "agentBuilds" | "localTailscale" | "daemonHttp"
>;

/** Every managed account home of an agent that runs in boxes (the setup's `config` step syncs each). */
export function managedAgentHomes(agentAccounts: Pick<AgentAccountsService, "list" | "homePath">): ManagedAgentHome[] {
  return agentAccounts
    .list()
    .accounts.filter((account) => BOX_AGENTS.includes(account.agent))
    .map((account) => ({ agent: account.agent as BoxAgentId, accountId: account.id, home: agentAccounts.homePath(account.agent, account.id) }));
}

export function createDaemonBoxService(host: DaemonBoxHost, parts: DaemonBoxParts): BoxService {
  const { accounts } = host;
  return createBoxService({
    baseDir: host.baseDir,
    ...parts,
    accounts: {
      list: () => accounts.list(),
      token: (accountId) => accounts.hostingToken(accountId),
      resolveClone: (accountId, input) => accounts.resolveCloneTarget(accountId, input),
      createRepo: async (accountId, options) => ({ url: await accounts.cloneUrlForRepo(accountId, await accounts.createRepo(accountId, options)) })
    },
    git: {
      identity: async (accountId) => {
        const account = (await accounts.list()).find((candidate) => candidate.id === accountId);
        return account && account.gitName && account.gitEmail ? { name: account.gitName, email: account.gitEmail } : null;
      },
      // Read per call from accounts.json (public fields only; the token stays where it is).
      endpoint: async (accountId) => {
        try {
          const account = parseAccountsConfig(JSON.parse(await readFile(host.accountsFile, "utf8"))).accounts.find((candidate) => candidate.id === accountId);
          if (!account) return null;
          return {
            provider: account.provider,
            login: account.login,
            ...(account.email !== undefined ? { email: account.email } : {}),
            ...(account.baseUrl !== undefined ? { baseUrl: account.baseUrl } : {}),
            ...(account.sshHost !== undefined ? { sshHost: account.sshHost } : {})
          };
        } catch {
          return null;
        }
      },
      knownHosts: (hostName, port) => knownHostsForBox({ keysDir: host.keysDir, home: host.home, host: hostName, port })
    },
    managedAgentHomes: () => managedAgentHomes(host.agentAccounts),
    pluginEnabled: async () => (await host.plugins.get(EPHEMERAL_VMS_PLUGIN_ID)).enabled,
    onPluginChange: (listener) => {
      const onChanged = (response: PluginsResponse) =>
        listener(response.plugins.some((plugin) => plugin.id === EPHEMERAL_VMS_PLUGIN_ID && plugin.enabled));
      host.plugins.events.on("changed", onChanged);
      return () => void host.plugins.events.off("changed", onChanged);
    },
    publish: (channel, type, payload) => host.broadcaster.publish(channel, type, payload),
    publicOrigin: host.publicOrigin,
    ...(host.logger ? { logger: host.logger } : {})
  });
}
