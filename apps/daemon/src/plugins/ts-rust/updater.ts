/**
 * "Better TS Typecheck" as a {@link PluginUpdater}: one target per engine
 * (tsrs, tsc-rs), the active one being the engine plugins.json names when it
 * has a build here, else the platform's default (tsrs where it has one, else
 * tsc-rs). tsc-rs's versions are the record's own fields (as older builds wrote
 * them), tsrs's live under `tsrs`.
 */
import { type TsCheckerEngine, TS_CHECKER_ENGINES, TS_RUST_PLUGIN_ID } from "@orquester/api";
import {
  type PluginEngineVersions,
  type PluginState,
  storedTsCheckerEngine,
  tsRustPluginDir,
  tsrsEngineDir
} from "@orquester/config";
import { TS_CHECKER_ENGINE_CATALOG, tsCheckerEngineEntry } from "../catalog.ts";
import { PluginsError } from "../errors.ts";
import type { PluginUpdateTarget, PluginUpdater } from "../updater.ts";
import {
  type HostLibc,
  type TsRustInstallerDeps,
  type TsRustRelease,
  TS_CHECKER_ENGINE_SPECS,
  TsRustInstallError,
  clearTsRustStaging,
  installTsRustRelease,
  pruneTsRustVersions,
  removeTsRustVersions,
  resolveTsRustRelease,
  tsRustBinaryPath
} from "./installer.ts";
import { stat } from "node:fs/promises";

export interface TsRustUpdaterOptions {
  baseDir: string;
  platform: string;
  arch: string;
  libc: HostLibc;
  installer: TsRustInstallerDeps;
  /** The daemon's env, which the smoke test runs with (minus `ORQUESTER_*`). */
  env: NodeJS.ProcessEnv;
  logger: Pick<Console, "warn">;
}

export interface TsRustUpdater extends PluginUpdater {
  /** Each engine's platform package for this host, or null where it has no build. */
  readonly platformPackages: Readonly<Record<TsCheckerEngine, string | null>>;
  /** The engine used when plugins.json names none with a build here. */
  readonly defaultEngine: TsCheckerEngine;
  /** The engine `state` names when it has a build here, else the platform's default. */
  activeEngine(state: PluginState): TsCheckerEngine;
  /** The refusal for an engine (or, with none, every engine) without a build here. */
  unsupported(engine?: TsCheckerEngine): PluginsError;
}

export function createTsRustUpdater(options: TsRustUpdaterOptions): TsRustUpdater {
  const { platform, arch, libc, installer, env, logger } = options;
  const engineDirs: Record<TsCheckerEngine, string> = {
    "tsc-rs": tsRustPluginDir(options.baseDir),
    tsrs: tsrsEngineDir(options.baseDir)
  };
  const packageFor = (engine: TsCheckerEngine) => TS_CHECKER_ENGINE_SPECS[engine].platformPackage(platform, arch, libc);
  const platformPackages: Record<TsCheckerEngine, string | null> = { tsrs: packageFor("tsrs"), "tsc-rs": packageFor("tsc-rs") };
  const defaultEngine: TsCheckerEngine = platformPackages.tsrs !== null ? "tsrs" : "tsc-rs";

  const activeEngine = (state: PluginState): TsCheckerEngine => {
    const stored = storedTsCheckerEngine(state);
    return stored !== undefined && platformPackages[stored] !== null ? stored : defaultEngine;
  };

  const binaryExists = (engine: TsCheckerEngine, version: string): Promise<boolean> =>
    isFile(tsRustBinaryPath(TS_CHECKER_ENGINE_SPECS[engine], engineDirs[engine], version, platform));

  const targetFor = (engine: TsCheckerEngine): PluginUpdateTarget<TsRustRelease> => {
    const spec = TS_CHECKER_ENGINE_SPECS[engine];
    const platformPackage = platformPackages[engine];
    return {
      name: engine,
      available: platformPackage !== null,
      versions: (state) => engineVersions(state, engine),
      versionsIn: (state) => engineVersionsIn(state, engine),
      hasFiles: (version) => binaryExists(engine, version),
      resolve: (signal, pinned) => {
        if (platformPackage === null) throw new TsRustInstallError("registry", `${engine} has no build here`);
        return resolveTsRustRelease(spec, platformPackage, installer, signal, pinned);
      },
      install: (release, signal) => installTsRustRelease(spec, engineDirs[engine], release, installer, { platform, env, signal }),
      prune: (keep) => pruneTsRustVersions(engineDirs[engine], keep)
    };
  };

  const updater: TsRustUpdater = {
    id: TS_RUST_PLUGIN_ID,
    checkFailedMessage: "TypeScript engine update check failed",
    platformPackages,
    defaultEngine,
    activeEngine,
    supported: () => TS_CHECKER_ENGINES.some((engine) => platformPackages[engine] !== null),
    unsupported: (engine?: TsCheckerEngine) => {
      const where = `${platform}/${arch}`;
      return new PluginsError(
        409,
        "PLUGIN_UNSUPPORTED",
        engine ? `${engine} has no build for ${where}.` : `Neither tsrs nor tsc-rs has a build for ${where}.`
      );
    },
    target: (state) => targetFor(activeEngine(state)),
    clearStaging: async () => {
      for (const engine of TS_CHECKER_ENGINES) {
        await clearTsRustStaging(engineDirs[engine]).catch((error) =>
          logger.warn(`Failed to empty the ${engine} staging dir`, error)
        );
      }
    },
    clearRecords: (state) => {
      for (const versions of [state, state.tsrs]) {
        if (!versions) continue;
        delete versions.current;
        delete versions.previous;
        delete versions.skippedVersion;
      }
    },
    removeFiles: async () => {
      // preload.cjs stays: sessions started while the plugin was on still require it.
      for (const engine of TS_CHECKER_ENGINES) {
        await removeTsRustVersions(engineDirs[engine]);
      }
    },
    errorRecord: (error, at) =>
      error instanceof TsRustInstallError
        ? { at, step: error.step, message: error.message }
        : { at, step: "check", message: error instanceof Error ? error.message : String(error) },
    view: (state) => {
      const engine = activeEngine(state);
      return {
        source: { ...tsCheckerEngineEntry(engine).source },
        engine,
        engines: TS_CHECKER_ENGINE_CATALOG.map((option) => ({
          ...option,
          source: { ...option.source },
          platform: platformPackages[option.id] === null ? "unsupported" : "supported"
        }))
      };
    },
    now: () => installer.now()
  };
  return updater;
}

/** An engine's versions in a ts-rust record: tsc-rs's are the record's own fields, tsrs's under `tsrs`. */
export function engineVersions(state: PluginState, engine: TsCheckerEngine): PluginEngineVersions {
  return engine === "tsrs" ? (state.tsrs ?? {}) : state;
}

/** {@link engineVersions} to write to: tsrs's sub-record is created when the record has none yet. */
function engineVersionsIn(state: PluginState, engine: TsCheckerEngine): PluginEngineVersions {
  if (engine !== "tsrs") return state;
  state.tsrs ??= {};
  return state.tsrs;
}

async function isFile(path: string): Promise<boolean> {
  return stat(path).then(
    (info) => info.isFile(),
    () => false
  );
}
