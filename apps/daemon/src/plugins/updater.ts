/**
 * What `PluginsService` needs from a plugin it downloads and keeps up to date
 * (`updates: true` in the catalog). The service owns plugins.json, the job
 * queue, the hourly timer, rollback and the last error; an updater says where
 * the plugin's versions live in its record, what "latest" is, and how one
 * release is installed, checked for and removed.
 *
 * "Better TS Typecheck" (`ts-rust/updater.ts`) has one target per engine;
 * "Knowledge Graph" (`knowledge/install/updater.ts`) has one.
 */
import type { PluginId, PluginInfo } from "@orquester/api";
import type { PluginEngineVersions, PluginInstalledVersion, PluginLastError, PluginState } from "@orquester/config";
import type { PluginsError } from "./errors.ts";

/** A release a target resolved: what its `install` downloads. */
export interface PluginRelease {
  version: string;
}

/**
 * The set of versions one check works on (ts-rust: one engine). A check keeps
 * the target it started with, so its outcome is recorded where it began.
 */
export interface PluginUpdateTarget<R extends PluginRelease = PluginRelease> {
  /** In log lines: "tsrs", "myKG". */
  readonly name: string;
  /** Whether this host has a build of the target; a check stops before anything when not. */
  readonly available: boolean;
  /** The target's versions in the plugin's record (read only). */
  versions(state: PluginState): PluginEngineVersions;
  /** The same, to write: created in `state` when missing. */
  versionsIn(state: PluginState): PluginEngineVersions;
  /** Whether `version`'s files are in place and usable; false makes a check repair it. */
  hasFiles(version: string): Promise<boolean>;
  /**
   * Whether `version` is installed and runs, though `hasFiles` may want it repaired
   * (Knowledge Graph: installed with an older prompt overlay): what rollback and
   * "keep it as previous" ask. `hasFiles` when absent.
   */
  hasInstalled?(version: string): Promise<boolean>;
  /**
   * The version a first install (no current version in the record) installs, resolved as
   * `pinned`; later checks resolve the latest. The latest from the start when absent.
   */
  readonly firstInstall?: string;
  /** The latest release, or `pinned` exactly. */
  resolve(signal: AbortSignal, pinned?: string): Promise<R>;
  /** Install `release` (staged, verified, smoke-tested, renamed into place). */
  install(release: R, signal: AbortSignal): Promise<PluginInstalledVersion>;
  /** Delete every installed version not named in `keep`. */
  prune(keep: readonly string[]): Promise<void>;
}

export interface PluginUpdater {
  readonly id: PluginId;
  /** "TypeScript engine update check failed": logged when a check throws past its own recording. */
  readonly checkFailedMessage: string;
  /**
   * When set, a scheduled check does not retry a release whose install failed
   * last time (`lastError.version`) while a working version is installed; a
   * manual check does. For a plugin whose install is a large download.
   */
  readonly skipFailedOnSchedule?: boolean;
  /** Whether this host has a build at all (turning on and checks are refused when not). */
  supported(): boolean;
  /** The refusal for `supported() === false`. */
  unsupported(): PluginsError;
  /** The target the record points at now. */
  target(state: PluginState): PluginUpdateTarget;
  /** Empty the staging dirs (whatever is in them was left by a daemon that stopped mid-install). */
  clearStaging(): Promise<void>;
  /** "Remove downloads": forget every installed version in the record (keep everything else). */
  clearRecords(state: PluginState): void;
  /** "Remove downloads": delete the installed files. */
  removeFiles(): Promise<void>;
  /** The `lastError` to record for a failed check of `version` (undefined when it failed before one was known). */
  errorRecord(error: unknown, at: string, version: string | undefined): PluginLastError;
  /** Fields of `PluginInfo` the updater sets itself (ts-rust: the engine's source, `engine`, `engines`). */
  view(state: PluginState): Partial<Pick<PluginInfo, "source" | "engine" | "engines">>;
  now(): Date;
}
