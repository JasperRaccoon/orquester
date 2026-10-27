/**
 * `BoxToolingProvisioner` (spec §10): puts every per-session tooling plugin
 * (today Better TS Typecheck) into a box, and tells new sessions in that box
 * what to load — in the box's own paths, so a host path never reaches it.
 *
 * Per box and plugin, a provision:
 *  1. asks the plugin for the box's plan (`ToolingPlugin.plan`), given the
 *     box's target (os, arch, libc) and its paths (data dir, workspaces root
 *     mapped with `hostToBoxPath`);
 *  2. for each artifact: makes sure the host cache holds the archive verified
 *     against its sha512 integrity (`cache.ts`), then installs it in the box
 *     unless already there (`install.ts`: upload, extract, smoke test, rename);
 *  3. writes the plugin's files (its preload, then its state file) and only
 *     then stores the contribution for new sessions in that box.
 *
 * A failure leaves the box with what it had — files, versions and the
 * contribution new sessions get — and is reported as the box's status for
 * that plugin (`toolingStatus`, and `PluginInfo.boxes` through the plugins
 * service). Provisions of one box run one at a time; one requested while
 * another waits joins it.
 *
 * A box is provisioned again when a plugin reports a change (on/off, engine,
 * a new version) or the workspaces root moves (`workspacesChanged`): every
 * connected box this process provisioned gets it now,
 * the rest when they reconnect. After a daemon restart a project box that
 * finished setup is provisioned when it connects.
 */

import { realpath } from "node:fs/promises";
import { posix, resolve, win32 } from "node:path";

import {
  type BoxPathMap,
  type BoxSysInfo,
  type PluginBoxToolingState,
  type PluginBoxToolingStatus,
  hostToBoxPath
} from "@orquester/api";
import {
  boxToolVersionDir,
  boxToolingPluginDir,
  boxToolDir,
  toolingJoinPath
} from "@orquester/config";

import type {
  BoxConnection,
  BoxHub,
  BoxRegistry,
  BoxToolingProvisioner,
  SessionToolingContribution
} from "../contracts.ts";
import { ToolingArchiveCache } from "./cache.ts";
import { installArtifactInBox, pruneBoxVersions } from "./install.ts";
import { type ToolArtifact, type ToolingPlugin, ToolingStepError, type ToolingTargetContext } from "./types.ts";

export interface BoxToolingProvisionerDeps {
  /** The appdir base: the host archive cache is under it (`boxToolingCacheDir`). */
  baseDir: string;
  hub: Pick<BoxHub, "get" | "onConnectionChange">;
  /** Decides which boxes are provisioned when they connect without a provision in this process. */
  registry?: Pick<BoxRegistry, "get">;
  plugins: readonly ToolingPlugin[];
  /** A getter: the daemon's workspaces root can move at runtime. */
  workspacesDir: () => string;
  now?: () => Date;
  logger?: Pick<Console, "warn" | "error">;
  /** A box's status changed (the plugins service broadcasts `plugins.changed`). */
  onStatusChange?: (boxId: string) => void;
}

/** One plugin's tooling in one box. */
export interface BoxToolingStatusEntry {
  pluginId: string;
  state: PluginBoxToolingState;
  message: string | null;
  updatedAt: string;
}

export interface BoxToolingProvisionerHandle extends BoxToolingProvisioner {
  /** Every plugin's status in the box (empty before its first provision in this process). */
  toolingStatus(boxId: string): BoxToolingStatusEntry[];
  /** One plugin's status in every box, for `PluginInfo.boxes`. */
  pluginStatuses(pluginId: string): PluginBoxToolingStatus[];
  /** Provision in the background (logged, never rejects); joins a provision already waiting. */
  requestProvision(boxId: string): Promise<void>;
  /** The daemon's workspaces root moved: boxes get preloads that bake in the new one. */
  workspacesChanged(): void;
  /** The box is gone: drop its status and contributions. */
  forget(boxId: string): void;
  /** Stop reacting to changes and cancel running provisions. */
  stop(): Promise<void>;
  /** Every requested provision has finished (for tests and shutdown). */
  settled(): Promise<void>;
}

/**
 * The box paths a plugin renders with, in the box's path syntax: its data
 * dir's `tooling/` layout and the host workspaces roots mapped into the box
 * (`hostToBoxPath`: unchanged on POSIX boxes, under `C:\orq\` on Windows).
 */
export function toolingTargetContext(input: {
  boxId: string;
  sys: Pick<BoxSysInfo, "os" | "arch" | "libc" | "dataDir">;
  paths: BoxPathMap;
  pluginId: string;
  /** Absolute host paths. */
  hostWorkspacesRoots: readonly string[];
}): ToolingTargetContext {
  const { os, arch, libc, dataDir } = input.sys;
  const rules = os === "win32" ? win32 : posix;
  if (!rules.isAbsolute(dataDir)) throw new ToolingStepError("resolve", `the box reports no absolute data dir (${dataDir})`);
  const workspacesRoots: string[] = [];
  for (const root of input.hostWorkspacesRoots) {
    const boxRoot = hostToBoxPath(input.paths, root);
    if (!workspacesRoots.includes(boxRoot)) workspacesRoots.push(boxRoot);
  }
  return {
    boxId: input.boxId,
    target: { os, arch, libc },
    path: rules,
    pluginDir: boxToolingPluginDir(os, dataDir, input.pluginId),
    versionDir: (tool, version) => boxToolVersionDir(os, dataDir, tool, version),
    versionsDir: (tool) => toolingJoinPath(os, boxToolDir(os, dataDir, tool), "versions"),
    workspacesRoots
  };
}

/** Box states after setup, in which a reconnecting project box gets its tooling again. */
const SET_UP_STATES = new Set(["ready", "unreachable"]);

interface BoxEntry {
  /** The tail of this box's provision queue. */
  queue: Promise<void>;
  /** A provision queued behind the running one, which later requests join. */
  waiting: Promise<void> | null;
  /** Provisioned at least once by this process: re-provisioned on plugin changes. */
  known: boolean;
  /** A plugin changed while the box was away: provision when it connects. */
  stale: boolean;
  statuses: Map<string, BoxToolingStatusEntry>;
  contributions: Map<string, SessionToolingContribution>;
  /** Archives the last good plan of each plugin uses (kept in the host cache). */
  artifacts: Map<string, ToolArtifact[]>;
  /** `forget` ran: a provision still running for it changes nothing any more. */
  forgotten: boolean;
}

export function createBoxToolingProvisioner(deps: BoxToolingProvisionerDeps): BoxToolingProvisionerHandle {
  const cache = new ToolingArchiveCache({ baseDir: deps.baseDir });
  const now = deps.now ?? (() => new Date());
  const logger = deps.logger ?? console;
  const boxes = new Map<string, BoxEntry>();
  const lifetime = new AbortController();
  const inflight = new Set<Promise<void>>();
  let stopped = false;

  const entryOf = (boxId: string): BoxEntry => {
    let entry = boxes.get(boxId);
    if (!entry) {
      entry = {
        queue: Promise.resolve(),
        waiting: null,
        known: false,
        stale: false,
        statuses: new Map(),
        contributions: new Map(),
        artifacts: new Map(),
        forgotten: false
      };
      boxes.set(boxId, entry);
    }
    return entry;
  };

  const setStatus = (boxId: string, entry: BoxEntry, pluginId: string, state: PluginBoxToolingState, message: string | null) => {
    if (entry.forgotten) return;
    entry.statuses.set(pluginId, { pluginId, state, message, updatedAt: now().toISOString() });
    try {
      deps.onStatusChange?.(boxId);
    } catch (error) {
      logger.error("Box tooling status listener failed", error);
    }
  };

  const contribute = (entry: BoxEntry, pluginId: string, contribution: SessionToolingContribution | null) => {
    if (entry.forgotten) return;
    if (contribution === null) entry.contributions.delete(pluginId);
    else entry.contributions.set(pluginId, contribution);
  };

  /** Box paths for `plugin` in `connection`'s box: the workspaces root as it is now, real and configured. */
  const contextFor = async (connection: BoxConnection, plugin: ToolingPlugin): Promise<ToolingTargetContext> => {
    const configured = resolve(deps.workspacesDir());
    const real = await realpath(configured).catch(() => configured);
    return toolingTargetContext({
      boxId: connection.boxId,
      sys: connection.sys,
      paths: connection.paths,
      pluginId: plugin.id,
      hostWorkspacesRoots: [real, configured]
    });
  };

  /** One plugin in one box. Resolves the failure message, or null when it succeeded. */
  const provisionPlugin = async (
    boxId: string,
    entry: BoxEntry,
    connection: BoxConnection,
    plugin: ToolingPlugin,
    signal: AbortSignal
  ): Promise<string | null> => {
    setStatus(boxId, entry, plugin.id, "installing", null);
    let step: ToolingStepError["step"] = "resolve";
    try {
      const context = await contextFor(connection, plugin);
      const plan = await plugin.plan(context, signal);
      if (plan.kind === "unsupported") {
        entry.artifacts.delete(plugin.id);
        contribute(entry, plugin.id, null);
        setStatus(boxId, entry, plugin.id, "unsupported", plan.message);
        return null;
      }
      if (plan.kind === "install") {
        for (const artifact of plan.artifacts) {
          step = "download";
          const archivePath = await cache.ensure(artifact, context.target, signal);
          step = "install";
          await installArtifactInBox(connection, context, artifact, { archivePath, signal, now });
        }
      }
      step = "files";
      for (const file of plan.files) {
        await connection.writeFile(file.path, file.content, { mode: file.mode ?? 0o644, mkdirs: true });
      }
      if (plan.kind === "off") {
        contribute(entry, plugin.id, null);
        setStatus(boxId, entry, plugin.id, "off", null);
        return null;
      }
      entry.artifacts.set(plugin.id, plan.artifacts);
      contribute(entry, plugin.id, plan.contribution);
      setStatus(boxId, entry, plugin.id, "ready", plan.summary);
      for (const artifact of plan.artifacts) {
        await pruneBoxVersions(connection, context, artifact.tool, artifact.version);
      }
      return null;
    } catch (error) {
      const failed = error instanceof ToolingStepError ? error : new ToolingStepError(step, error instanceof Error ? error.message : String(error));
      const message = `${failed.step}: ${failed.message}`;
      logger.warn(`Box ${boxId}: ${plugin.id} tooling failed (${message})`);
      // Retried when the box connects again, and on the plugin's next change.
      entry.stale = true;
      setStatus(boxId, entry, plugin.id, "failed", message);
      return message;
    }
  };

  /** Drop cached archives of the tools just installed that no box's last good plan uses. */
  const pruneCache = async (tools: ReadonlySet<string>) => {
    for (const tool of tools) {
      const keep = new Set<string>();
      for (const box of boxes.values()) {
        for (const artifacts of box.artifacts.values()) {
          for (const artifact of artifacts) if (artifact.tool === tool) keep.add(artifact.version);
        }
      }
      await cache.prune(tool, keep).catch((error) => logger.warn(`Failed to prune cached ${tool} archives`, error));
    }
  };

  const runProvision = async (boxId: string, entry: BoxEntry, signal: AbortSignal): Promise<void> => {
    const connection = deps.hub.get(boxId);
    if (!connection?.connected) {
      entry.stale = true;
      throw Object.assign(new Error(`Box ${boxId} is not connected`), { code: "BOX_NOT_CONNECTED" });
    }
    entry.known = true;
    entry.stale = false;
    const failures: string[] = [];
    for (const plugin of deps.plugins) {
      if (signal.aborted) break;
      const failure = await provisionPlugin(boxId, entry, connection, plugin, signal);
      if (failure !== null) failures.push(`${plugin.id}: ${failure}`);
    }
    await pruneCache(new Set([...entry.artifacts.values()].flat().map((artifact) => artifact.tool)));
    if (signal.aborted) throw new Error("cancelled");
    if (failures.length > 0) throw new Error(`Plugin tooling failed in box ${boxId}: ${failures.join("; ")}`);
  };

  const provision = (boxId: string, signal: AbortSignal): Promise<void> => {
    if (stopped) return Promise.reject(new Error("The box tooling provisioner is stopped"));
    const entry = entryOf(boxId);
    if (entry.waiting) return entry.waiting;
    const combined = AbortSignal.any([signal, lifetime.signal]);
    const run = entry.queue.then(() => {
      if (entry.waiting === run) entry.waiting = null;
      return runProvision(boxId, entry, combined);
    });
    entry.waiting = run;
    entry.queue = run.catch(() => undefined);
    return run;
  };

  const requestProvision = (boxId: string): Promise<void> => {
    const run: Promise<void> = provision(boxId, lifetime.signal)
      .catch((error) => {
        if (!stopped) logger.warn(`Box tooling provision of ${boxId} failed`, error instanceof Error ? error.message : error);
      })
      .finally(() => inflight.delete(run));
    inflight.add(run);
    return run;
  };

  const onPluginChange = () => {
    if (stopped) return;
    for (const [boxId, entry] of boxes) {
      if (!entry.known) continue;
      if (deps.hub.get(boxId)?.connected) void requestProvision(boxId);
      else entry.stale = true;
    }
  };
  const unsubscribes = deps.plugins.map((plugin) => plugin.onChange(onPluginChange));
  unsubscribes.push(
    deps.hub.onConnectionChange((boxId, connected) => {
      if (!connected || stopped) return;
      const entry = boxes.get(boxId);
      if (entry?.known) {
        if (entry.stale) void requestProvision(boxId);
        return;
      }
      const record = deps.registry?.get(boxId);
      if (record?.purpose === "project" && SET_UP_STATES.has(record.state)) void requestProvision(boxId);
    })
  );

  const mergedContribution = (boxId: string): SessionToolingContribution => {
    const contributions = [...(boxes.get(boxId)?.contributions.values() ?? [])];
    return {
      pathPrepend: contributions.flatMap((contribution) => contribution.pathPrepend),
      env: Object.assign({}, ...contributions.map((contribution) => contribution.env)) as Record<string, string>,
      nodeRequire: contributions.flatMap((contribution) => contribution.nodeRequire)
    };
  };

  return {
    provision,
    contribution: mergedContribution,
    requestProvision,
    workspacesChanged: onPluginChange,
    toolingStatus(boxId) {
      return [...(boxes.get(boxId)?.statuses.values() ?? [])].map((status) => ({ ...status }));
    },
    pluginStatuses(pluginId) {
      const out: PluginBoxToolingStatus[] = [];
      for (const [boxId, entry] of boxes) {
        const status = entry.statuses.get(pluginId);
        if (status) out.push({ boxId, state: status.state, message: status.message, updatedAt: status.updatedAt });
      }
      return out;
    },
    forget(boxId) {
      const entry = boxes.get(boxId);
      if (!entry) return;
      entry.forgotten = true;
      boxes.delete(boxId);
      try {
        deps.onStatusChange?.(boxId);
      } catch (error) {
        logger.error("Box tooling status listener failed", error);
      }
    },
    async stop() {
      stopped = true;
      for (const unsubscribe of unsubscribes) unsubscribe();
      lifetime.abort();
      await Promise.all([...inflight, ...[...boxes.values()].map((entry) => entry.queue)]).catch(() => undefined);
    },
    async settled() {
      for (;;) {
        const pending = [...inflight, ...[...boxes.values()].map((entry) => entry.queue)];
        await Promise.all(pending).catch(() => undefined);
        const after = [...inflight, ...[...boxes.values()].map((entry) => entry.queue)];
        if (after.length === pending.length && after.every((promise, index) => promise === pending[index])) return;
      }
    }
  };
}
