/**
 * Ephemeral AI VMs in the running daemon: every box module put together over the daemon's own
 * services, in the order `startDaemon` needs them (spec 2026-10-19; module map `README.md`).
 *
 * 1. {@link createDaemonBoxes} — before the session manager exists: the hub, the box service (its
 *    record store is the hub's, through a late reference that breaks the service ↔ hub cycle), the
 *    config sync, the tooling provisioner and the box terminals the session manager wraps.
 * 2. `start()` — right after `plugins.start()` and before `sessions.reattach()`: the box records
 *    load (a reattached box terminal finds its box), the plugin switch is followed.
 * 3. `attach(...)` — once the session list, the browser tabs, the temporary-box tools and the agent
 *    chat exist: the token broker, dev-server forwards, the agent host's view of box projects, the
 *    MCP bridge, the Template command runner, and the temporary-box tools (connected only while the
 *    plugin is on, so the box tools are hidden while it is off).
 * 4. Routes, per transport: {@link DaemonBoxes.registerRoutes}.
 * 5. `stop()` at shutdown.
 *
 * The plugin switch gates the boxes: while it is off the hub refuses every box, the reconciler is
 * stopped, nothing is created, the box tools are not advertised and the config watches stop. Box
 * records and the hub stay loaded, so a box project's paths keep routing to its (unreachable) box
 * instead of the empty stub, and a closed chat's temporary boxes are still destroyed.
 *
 * Config sync (spec §8.3): every live project box keeps its managed account homes, and every
 * scope a chat's launch synced, under `BoxConfigSync.watch` from its setup (or the daemon's start,
 * or the plugin's switch-on) until its destroy (`BoxConfigWatches`).
 */

import { EPHEMERAL_VMS_PLUGIN_ID, type PluginsResponse } from "@orquester/api";
import { agentAccountsDir, boxMcpSettingsPath, boxPendingTerminalKillsPath, type StoredBox } from "@orquester/config";
import type { FastifyInstance } from "fastify";

import type { AccountsService } from "../accounts.ts";
import type { AgentAccountsService } from "../agent-accounts.ts";
import { registerBoxHostRoutes } from "../agent-chat/box-host-routes.ts";
import type { AgentChatService } from "../agent-chat/service.ts";
import type { AgentProfileService } from "../agent-profile/service.ts";
import type { Broadcaster } from "../broadcaster.ts";
import type { BrowserManager } from "../browsers.ts";
import type { PluginsService } from "../plugins/plugins-service.ts";
import { createTsRustToolingPlugin } from "../plugins/ts-rust/box-tooling.ts";
import type { RegistryService } from "../registry.ts";
import type { ISessionManager, SessionIndexContributor } from "../sessions";
import { buildBootstrap } from "./bootstrap/bootstrap.ts";
import { nodeCredentialFiles } from "./broker/credentials.ts";
import { createAgentTokenBroker } from "./broker/broker.ts";
import { registerTokenBroker, registerTokenBrokerRoutes } from "./broker/register.ts";
import type { AgentTokenBroker, BoxRegistry } from "./contracts.ts";
import { createBlacksmithSetupDriver } from "./github/blacksmith-setup.ts";
import { verifyGithubOidc } from "./github/oidc.ts";
import {
  createBoxAgentBuilds,
  createBoxHub,
  registerBoxHubRoutes,
  type BoxAgentBuilds,
  type BoxHubServer,
  type BoxRecordStore as HubRecordStore
} from "./hub/index.ts";
import { BOX_PROVIDERS } from "./providers/index.ts";
import { BoxBrowsers } from "./remote/browser/box-browsers.ts";
import { BoxDesktops } from "./remote/desktop/index.ts";
import { BoxDevForwards } from "./remote/exec/dev-forwards.ts";
import { createBoxGitRouteResolver } from "./remote/exec/git.ts";
import { registerBoxStatsRoute } from "./remote/exec/stats.ts";
import { BoxAwareSessionManager, BoxTerminalManager, composeIndexContributors } from "./remote/exec/terminals.ts";
import { registerBoxGitAuth, workspaceAccountFromFiles } from "./remote/git-auth.ts";
import { registerMcpBridge } from "./remote/mcp-bridge.ts";
import { createDaemonBoxService, managedAgentHomes } from "./service/daemon-wiring.ts";
import { registerBoxMcpRunInBoxRoutes } from "./service/mcp-run-in-box.ts";
import type { BoxService } from "./service/index.ts";
import { knownHostsForBox } from "./service/known-hosts.ts";
import {
  BoxConfigSyncService,
  BoxConfigWatches,
  BoxTranscriptSyncService,
  boxConfigChangesPublisher,
  registerBoxConfigChangeRoutes
} from "./sync/index.ts";
import { createTailscaleKeys, type TailscaleCredentials as TailscaleApiCredentials } from "./tailscale/keys.ts";
import { createBoxGuiInstaller, type BoxGuiInstaller } from "./remote/gui/index.ts";
import type { TemporaryBoxes } from "./temporary/contract.ts";
import type { TemporaryBoxTools } from "./temporary/tools.ts";
import { createBoxToolingProvisioner, type BoxToolingProvisionerHandle } from "./tooling/provisioner.ts";
import type { TailscaleCredentials } from "./service/settings.ts";

/** POSIX shells a Template command is typed into, in order of preference (it is POSIX shell syntax). */
const TEMPLATE_SHELLS = ["bash", "zsh", "sh"];

export interface DaemonBoxesDeps {
  /** The appdir base. */
  baseDir: string;
  /** `<appdir>/daemon/keys`. */
  keysDir: string;
  /** The daemon user's home. */
  home: string;
  env: NodeJS.ProcessEnv;
  accounts: AccountsService;
  agentAccounts: AgentAccountsService;
  plugins: PluginsService;
  broadcaster: Pick<Broadcaster, "publish">;
  /** The agent/shell catalog (`RegistryService`): shells for box terminals, the OpenCode binary. */
  catalog: Pick<RegistryService, "get" | "list">;
  /** A getter: PUT /api/config/daemon moves it. */
  workspacesDir: () => string;
  /** `accounts.json` and `workspaces.json` (git auth of project boxes reads them per request). */
  accountsFile: string;
  workspacesMetaFile: string;
  /** Atomic JSON write (the daemon's `writeJsonFile`). */
  writeJson: (file: string, value: unknown) => Promise<void>;
  /** The session PATH every terminal gets (MCP servers bridged for box chats start with it). */
  sessionPath: () => string;
  logger: Pick<Console, "log" | "info" | "warn" | "error">;
  /**
   * Installs Chromium and the desktop stack in a Linux box for its project's Browser and Desktop
   * tabs (default: `createBoxGuiInstaller()` from `remote/gui`; tests pass a fake).
   */
  guiInstaller?: BoxGuiInstaller;
}

/** What `attach` needs once the daemon's session list, browser tabs and chat services exist. */
export interface DaemonBoxesAttachment {
  /** The daemon's one session list (PTY, box terminals and chats). */
  sessions: ISessionManager & {
    hostLocalAccountIds(): ReadonlySet<string>;
    setBoxProjectPredicate(isBoxProject: (projectPath: string) => boolean): void;
  };
  browsers: ConstructorParameters<typeof BoxDevForwards>[0]["browsers"] & Pick<BrowserManager, "setRemoteChrome">;
  agentChat: AgentChatService;
  agentProfile: Pick<AgentProfileService, "snapshot">;
  temporaryBoxTools: TemporaryBoxTools;
}

export interface DaemonBoxes {
  service: BoxService;
  registry: BoxRegistry;
  hub: BoxHubServer;
  tooling: BoxToolingProvisionerHandle;
  configSync: BoxConfigSyncService;
  builds: BoxAgentBuilds;
  /** Linux VM desktops: the desktop manager's `boxes` option. */
  desktops: BoxDesktops;
  /** Wrap the host session manager so box projects' terminals run in their box. */
  wrapSessions(createHost: (indexContributor: SessionIndexContributor) => ISessionManager, chatIndex: SessionIndexContributor): ISessionManager;
  /** The git route of box projects (`new GitService({ route })`). */
  gitRoute: ReturnType<typeof createBoxGitRouteResolver>;
  /** The workflow engine's box sandbox. */
  workflowSandbox: { registry: BoxRegistry; hub: BoxHubServer; tooling: BoxToolingProvisionerHandle };
  /** Load the records and follow the plugin switch. Before `sessions.reattach()`. */
  start(): Promise<void>;
  attach(attachment: DaemonBoxesAttachment): Promise<void>;
  /** The Browser tab's URL suggestions: box projects get their box's listening ports. */
  browserSuggestions(projectPath: string, sniffed: string[]): Promise<string[]>;
  /** The daemon's workspaces root moved. */
  workspacesChanged(): void;
  registerRoutes(app: FastifyInstance, mode: "local" | "remote"): void;
  stop(): Promise<void>;
}

/** A box that is (or is being set up to be) in use: not on its way out. */
function isLiveState(state: StoredBox["state"]): boolean {
  return state === "provisioning" || state === "ready" || state === "unreachable";
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The Tailscale API credentials of the stored settings (an API token wins over an OAuth client). */
function tailscaleApiCredentials(credentials: TailscaleCredentials): TailscaleApiCredentials | null {
  if (credentials.apiToken) return { apiToken: credentials.apiToken };
  if (credentials.oauthClientId && credentials.oauthClientSecret) {
    return { oauthClientId: credentials.oauthClientId, oauthClientSecret: credentials.oauthClientSecret };
  }
  return null;
}

export function createDaemonBoxes(deps: DaemonBoxesDeps): DaemonBoxes {
  const { logger } = deps;
  const hubLogger = {
    info: (message: string, fields?: Record<string, unknown>) => logger.log(`[boxes] ${message}`, fields ?? ""),
    warn: (message: string, fields?: Record<string, unknown>) => logger.warn(`[boxes] ${message}`, fields ?? "")
  };
  const builds = createBoxAgentBuilds({ appdir: deps.baseDir, logger: hubLogger });
  const gui = deps.guiInstaller ?? createBoxGuiInstaller({ logger: hubLogger });

  // The hub reads and updates box records; the service owns them and needs the hub. The service is
  // built right below, before anything can call the hub.
  let service: BoxService | null = null;
  const owner = (): BoxService => {
    if (!service) throw new Error("The box service is not built yet");
    return service;
  };
  const records: HubRecordStore = {
    get: (boxId) => owner().records.get(boxId),
    update: async (boxId, mutate) => {
      const updated = await owner().records.update(boxId, mutate);
      if (!updated) throw new Error(`There is no box record ${boxId}`);
      return updated;
    }
  };
  const hub = createBoxHub({
    appdir: deps.baseDir,
    records,
    verifyGithubOidc,
    daemonUrls: () => {
      if (!service) return [];
      const connection = service.settings.connectionSettings();
      return [connection.publicUrl, connection.tailscale.daemonUrl].filter((url): url is string => typeof url === "string" && url.length > 0);
    },
    builds,
    enabled: () => service?.enabled() ?? false,
    logger: hubLogger
  });

  const configSync = new BoxConfigSyncService({
    appdir: deps.baseDir,
    hub,
    publish: boxConfigChangesPublisher(deps.broadcaster),
    logger: { warn: (message: string) => logger.warn(`[boxes] ${message}`) } as ConstructorParameters<typeof BoxConfigSyncService>[0]["logger"]
  });
  // Agent config stays in sync for a box's whole life (spec §8.3): every scope a live project box
  // was synced with — at setup or at a chat's launch — stays watched until its destroy or the
  // plugin's switch-off. `watchedSync` is the sync the setup step and the agent host's route use.
  const watches = new BoxConfigWatches({
    sync: configSync,
    active: (boxId) => {
      const record = service?.registry.get(boxId);
      return (service?.enabled() ?? false) && record?.purpose === "project" && isLiveState(record.state);
    },
    logger: { warn: (message) => logger.warn(`[boxes] ${message}`) }
  });
  const watchedSync = watches.syncing(configSync);

  // Plugin tooling in boxes (spec §10): Better TS Typecheck's engine for the box's target.
  // `registry` is read lazily for the same reason as the hub's records.
  const registryRef: Pick<BoxRegistry, "get"> = { get: (boxId) => service?.registry.get(boxId) };
  const tooling = createBoxToolingProvisioner({
    baseDir: deps.baseDir,
    hub,
    registry: registryRef,
    plugins: [createTsRustToolingPlugin({ source: deps.plugins })],
    workspacesDir: deps.workspacesDir,
    logger,
    onStatusChange: () => deps.plugins.boxToolingChanged()
  });
  deps.plugins.setBoxToolingStatusSource((pluginId) => tooling.pluginStatuses(pluginId));

  service = createDaemonBoxService(
    {
      baseDir: deps.baseDir,
      keysDir: deps.keysDir,
      home: deps.home,
      accountsFile: deps.accountsFile,
      accounts: deps.accounts,
      agentAccounts: deps.agentAccounts,
      plugins: deps.plugins,
      broadcaster: deps.broadcaster,
      // A daemon reachable at a fixed public origin may say so; otherwise the plugin's Connection
      // settings name the URL boxes dial.
      publicOrigin: () => deps.env.ORQUESTER_PUBLIC_URL?.trim() || null,
      logger
    },
    {
      providers: BOX_PROVIDERS,
      hub,
      buildBootstrap,
      tailscale: (credentials) => createTailscaleKeys({ credentials: () => tailscaleApiCredentials(credentials) }),
      configSync: watchedSync,
      tooling,
      blacksmith: createBlacksmithSetupDriver(),
      agentBuilds: builds
    }
  );
  const boxes = service;
  const registry = boxes.registry;

  const terminals = new BoxTerminalManager({
    registry,
    hub,
    tooling,
    // Terminals closed while their box was away are ended when it is back, across restarts too.
    pendingKillsFile: boxPendingTerminalKillsPath(deps.baseDir),
    logger: { warn: (message, meta) => logger.warn(`[boxes] ${message}`, meta ?? "") }
  });
  const gitRoute = createBoxGitRouteResolver(registry);
  // Desktops of Linux box projects run in their VM; the GUI installer sets up the desktop stack there.
  const desktops = new BoxDesktops({ registry, hub, tooling, installer: gui });

  // ---- attached later ----------------------------------------------------------------------
  let transcripts: BoxTranscriptSyncService | null = null;
  let broker: AgentTokenBroker | null = null;
  let forwards: BoxDevForwards | null = null;
  let boxBrowsers: BoxBrowsers | null = null;
  let agentChat: AgentChatService | null = null;
  let agentProfile: Pick<AgentProfileService, "snapshot"> | null = null;
  let temporaryBoxTools: TemporaryBoxTools | null = null;
  let disconnectTools: (() => void) | null = null;
  const unsubscribers: (() => void)[] = [];
  /** Boxes whose per-box state (sync baselines, tooling status) was dropped after their destroy. */
  const forgotten = new Set<string>();
  const templatesStarting = new Set<string>();

  /** The box service as the temporary-box tools see it (`boxes/temporary/contract.ts`). */
  const temporaryBoxes: TemporaryBoxes = {
    createTemporaryBox: (input) =>
      boxes.startTemporaryBox({
        threadId: input.threadId,
        kind: input.kind,
        ...(input.provider !== undefined ? { provider: input.provider } : {}),
        ...(input.size !== undefined ? { size: input.size } : {}),
        ...(input.region !== undefined ? { region: input.region } : {}),
        ...(input.image !== undefined ? { image: input.image } : {}),
        lifetimeMinutes: input.lifetimeMinutes,
        purposeNote: input.purposeNote
      }),
    destroyBox: async (boxId, reason) => {
      if (registry.get(boxId)?.state === "destroyed") return;
      await boxes.destroyBox(boxId, reason);
    },
    list: () => boxes.registry.summaries(),
    get: (boxId) => registry.summary(boxId),
    onChange: (listener) => registry.onChange(listener)
  };

  /** The box tools follow the plugin: connected (advertised) while it is on. */
  const followPlugin = (enabled: boolean): void => {
    if (enabled) {
      // Build orq-agent now (when no prebuilt one exists) rather than in the first create request.
      void builds.current().catch(() => undefined);
      if (temporaryBoxTools && !disconnectTools) disconnectTools = temporaryBoxTools.connect({ boxes: temporaryBoxes, hub, registry });
      for (const record of registry.list()) keepConfigInSync(record.id);
    } else {
      // Off means no box traffic at all: live links drop (the boxes keep running and are let back
      // in when the plugin is turned on again).
      hub.disconnectAll("The Ephemeral AI VMs plugin was turned off");
      watches.releaseAll();
      if (disconnectTools) {
        const disconnect = disconnectTools;
        disconnectTools = null;
        disconnect();
      }
    }
  };
  const onPluginsChanged = (response: PluginsResponse): void =>
    followPlugin(response.plugins.some((plugin) => plugin.id === EPHEMERAL_VMS_PLUGIN_ID && plugin.enabled));

  /**
   * A live project box keeps every managed account home watched (what its setup synced; a chat's
   * launch adds its own scope through `watchedSync`). Idempotent; the daemon's restart and the
   * plugin's switch-on start them again for boxes that were set up before.
   */
  const keepConfigInSync = (boxId: string): void => {
    const record = registry.get(boxId);
    if (!record || record.purpose !== "project") return;
    if (!isLiveState(record.state)) {
      watches.release(boxId);
      return;
    }
    if (record.state === "provisioning") return; // the setup's `config` step starts them
    for (const home of managedAgentHomes(deps.agentAccounts)) watches.keep(boxId, { agent: home.agent, configRoots: [home.home] });
  };

  /** A destroyed box: its sync state, tooling status and contributions go. */
  const forgetIfDestroyed = (record: StoredBox | undefined, boxId: string): void => {
    if (!record || !isLiveState(record.state)) watches.release(boxId);
    if (record && record.state !== "destroyed") return;
    if (forgotten.has(boxId)) return;
    forgotten.add(boxId);
    tooling.forget(boxId);
    gui.forget(boxId);
    void configSync.forgetBox(boxId).catch((error) => logger.warn(`[boxes] Could not drop the sync state of box ${boxId}`, errorText(error)));
  };

  /**
   * The Template tab's command (spec §8.2 step 5): typed into a new terminal in the project's box
   * the first time the box is ready. The project record notes the start first, so a restart (or a
   * second change event) never types it twice.
   */
  const startTemplate = async (boxId: string, sessions: DaemonBoxesAttachment["sessions"]): Promise<void> => {
    const record = registry.get(boxId);
    const project = record?.project;
    if (!record || record.state !== "ready" || record.purpose !== "project" || !project) return;
    if (typeof project.templateCommand !== "string" || project.templateStartedAt !== undefined) return;
    if (!hub.get(boxId)?.connected || templatesStarting.has(boxId)) return;
    templatesStarting.add(boxId);
    try {
      const shells = deps.catalog.list().shells.filter((shell) => shell.enabled);
      const shell = TEMPLATE_SHELLS.map((id) => shells.find((entry) => entry.id === id)).find((entry) => entry !== undefined) ?? shells[0];
      if (!shell) {
        logger.warn(`[boxes] Box ${boxId}: no shell is enabled to run the Template command in`);
        return;
      }
      const at = new Date().toISOString();
      await boxes.records.update(boxId, (next) => {
        if (next.project) next.project.templateStartedAt = at;
      });
      await sessions.create({ kind: "shell", refId: shell.id, projectPath: project.path, title: "Setup", initialCommand: project.templateCommand });
    } catch (error) {
      logger.warn(`[boxes] Box ${boxId}: could not start the Template command`, errorText(error));
    } finally {
      templatesStarting.delete(boxId);
    }
  };

  return {
    service: boxes,
    registry,
    hub,
    tooling,
    configSync,
    builds,
    desktops,
    gitRoute,
    workflowSandbox: { registry, hub, tooling },

    wrapSessions(createHost, chatIndex) {
      const host = createHost(composeIndexContributors(chatIndex, terminals.indexContributor()));
      return new BoxAwareSessionManager(host, terminals, deps.catalog);
    },

    async start() {
      await boxes.start();
      unsubscribers.push(
        registry.onChange((boxId) => {
          forgetIfDestroyed(registry.get(boxId), boxId);
          keepConfigInSync(boxId);
        })
      );
      for (const record of registry.list()) if (record.state === "destroyed") forgotten.add(record.id);
    },

    async attach(attachment) {
      const { sessions } = attachment;
      agentChat = attachment.agentChat;
      agentProfile = attachment.agentProfile;
      temporaryBoxTools = attachment.temporaryBoxTools;
      // A closed chat's temporary boxes are destroyed whatever the plugin switch says (they bill either way).
      attachment.temporaryBoxTools.setCleanup(temporaryBoxes);

      // Sessions in box projects never refresh their account on this host (spec §7).
      sessions.setBoxProjectPredicate((path) => registry.locate(path).kind === "box");
      const tokenBroker = createAgentTokenBroker({
        accounts: deps.agentAccounts,
        registry,
        sessions: () => sessions.list(),
        hostLocalAccountIds: () => sessions.hostLocalAccountIds(),
        onSessionsChanged: (listener) => {
          const events = ["created", "updated", "exited", "closed"] as const;
          for (const event of events) sessions.lifecycle.on(event, listener);
          return () => {
            for (const event of events) sessions.lifecycle.off(event, listener);
          };
        },
        files: nodeCredentialFiles(agentAccountsDir(deps.baseDir))
      });
      broker = tokenBroker;
      registerTokenBroker(hub, tokenBroker);
      registerBoxGitAuth(hub, {
        workspaceAccount: workspaceAccountFromFiles({ accountsFile: deps.accountsFile, workspacesMetaFile: deps.workspacesMetaFile }),
        knownHosts: (host, port) => knownHostsForBox({ keysDir: deps.keysDir, home: deps.home, host, port }),
        logger: { warn: (message, meta) => logger.warn(`[boxes] ${message}`, meta ?? "") }
      });
      registerMcpBridge(hub, {
        appdir: deps.baseDir,
        baseEnv: () => ({ PATH: deps.sessionPath(), HOME: deps.home }),
        logger: {
          info: (message, detail) => logger.log(`[boxes] ${message}`, detail ?? ""),
          warn: (message, detail) => logger.warn(`[boxes] ${message}`, detail ?? "")
        }
      });

      // Transcripts: built now, after `registry.init()`, so OpenCode's resolved binary is known.
      const opencode = deps.catalog.get("opencode")?.resolvedBin;
      transcripts = new BoxTranscriptSyncService({
        appdir: deps.baseDir,
        hub,
        logger: { warn: (message: string) => logger.warn(`[boxes] ${message}`) },
        ...(opencode ? { opencode: { hostCommand: opencode } } : {})
      });

      // Agent chats in box projects run their CLI in the box (spec §8.5).
      attachment.agentChat.setBoxes({ registry, tooling });

      // boxes: the Browser tab of a Linux box project runs its Chromium in the box.
      const vmBrowsers = new BoxBrowsers({
        registry,
        hub,
        installer: gui,
        logger: { warn: (message, meta) => logger.warn(`[boxes] ${message}`, meta ?? "") }
      });
      boxBrowsers = vmBrowsers;
      attachment.browsers.setRemoteChrome((projectPath) => vmBrowsers.launcherFor(projectPath));
      void vmBrowsers.sweepConnected().catch((error) => logger.warn("[boxes] Stopping leftover VM browsers failed", errorText(error)));

      forwards = new BoxDevForwards({
        registry,
        hub,
        sessions,
        browsers: attachment.browsers,
        browserRunsInBox: (projectPath) => vmBrowsers.runsInBox(projectPath),
        logger: { warn: (message, meta) => logger.warn(`[boxes] ${message}`, meta ?? "") }
      });
      await forwards.restore().catch((error) => logger.warn("[boxes] Restoring dev-server forwards failed", errorText(error)));

      unsubscribers.push(
        registry.onChange((boxId) => void startTemplate(boxId, sessions)),
        hub.onConnectionChange((boxId, connected) => {
          if (connected) void startTemplate(boxId, sessions);
        })
      );
      for (const record of registry.list()) void startTemplate(record.id, sessions);

      deps.plugins.events.on("changed", onPluginsChanged);
      unsubscribers.push(() => void deps.plugins.events.off("changed", onPluginsChanged));
      followPlugin(boxes.enabled());
    },

    async browserSuggestions(projectPath, sniffed) {
      return forwards ? forwards.suggestions(projectPath, sniffed) : sniffed;
    },

    workspacesChanged() {
      tooling.workspacesChanged();
    },

    // The service's own routes are registered by `createServer` (`services.boxes.registerRoutes`).
    registerRoutes(app, mode) {
      registerBoxConfigChangeRoutes(app, { sync: configSync, logger: { error: (message) => logger.error(`[boxes] ${message}`) } });
      registerBoxStatsRoute(app, { registry, hub });
      registerBoxMcpRunInBoxRoutes(app, {
        file: boxMcpSettingsPath(deps.baseDir),
        snapshot: async (agent) => {
          if (!agentProfile) return { installed: false, items: [] };
          return agentProfile.snapshot(agent);
        },
        writeJson: deps.writeJson,
        enabled: () => boxes.enabled(),
        logger
      });
      if (mode === "remote") {
        // Box-authenticated (BOX_HUB_PUBLIC_ROUTES): boxes dial the remote transport only.
        registerBoxHubRoutes(app, hub);
        return;
      }
      // SOCKET-ONLY: the agent host's token and sync calls (each also checks the host's bearer or the box).
      if (broker) registerTokenBrokerRoutes(app, broker);
      if (agentChat && transcripts) {
        const chat = agentChat;
        registerBoxHostRoutes(app, {
          authorizeHost: (authorization) => chat.authorizeHostRequest(authorization),
          sync: watchedSync,
          transcripts,
          logger
        });
      }
    },

    async stop() {
      for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
      // Box Chromiums end while the links still carry the kill (kill and relaunch, never reattach).
      await boxBrowsers?.stop().catch((error) => logger.warn("[boxes] Closing VM browsers failed", errorText(error)));
      if (disconnectTools) {
        disconnectTools();
        disconnectTools = null;
      }
      await boxes.stop().catch((error) => logger.error("[boxes] Box service stop failed", errorText(error)));
      await forwards?.dispose().catch((error) => logger.warn("[boxes] Closing dev-server forwards failed", errorText(error)));
      await tooling.stop().catch((error) => logger.warn("[boxes] Tooling stop failed", errorText(error)));
      watches.releaseAll();
      await configSync.close().catch((error) => logger.warn("[boxes] Config sync stop failed", errorText(error)));
      terminals.dispose();
      await hub.close().catch((error) => logger.warn("[boxes] Hub close failed", errorText(error)));
    }
  };
}
