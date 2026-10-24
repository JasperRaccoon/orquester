/**
 * "Knowledge Graph" as a {@link PluginUpdater} of `PluginsService`: one
 * target (the myKG runtime), its versions in the record's own fields. The first
 * install is the pinned, tested myKG (from its hashed lock); after that, latest =
 * the newest patch of the pinned myKG minor line on PyPI. Supported where uv
 * ships a standalone build and the pinned lock has wheels (Linux x64/arm64 glibc and musl, macOS arm64).
 * A release that failed to install is not retried by the hourly check while a
 * working one is in place (each try is a large download); a manual check is.
 */
import { KNOWLEDGE_GRAPH_PLUGIN_ID } from "@orquester/api";
import { knowledgeRuntimeDir } from "@orquester/config";
import { PluginsError } from "../../plugins/errors.ts";
import type { HostLibc } from "../../plugins/ts-rust/installer.ts";
import type { PluginUpdateTarget, PluginUpdater } from "../../plugins/updater.ts";
import {
  type KnowledgeInstallerDeps,
  type MykgRelease,
  KnowledgeInstallError,
  clearKnowledgeStaging,
  defaultKnowledgeInstallerDeps,
  installKnowledgeRuntime,
  knowledgeRuntimeReady,
  pruneKnowledgeVersions,
  removeKnowledgeRuntime,
  resolveMykgRelease
} from "./installer.ts";
import { MYKG_PROMPTS_ROOT, overlayDigest } from "./overlay.ts";
import {
  EMBEDDING_MODEL,
  type EmbeddingModelSpec,
  MYKG_LINE,
  MYKG_PINNED_VERSION,
  TIKTOKEN_ENCODINGS,
  type TiktokenEncodingSpec,
  type UvBuild,
  uvBuildFor
} from "./pins.ts";

export interface KnowledgeGraphUpdaterOptions {
  baseDir: string;
  platform: string;
  arch: string;
  libc: HostLibc;
  /** The daemon's env: only PATH and proxy/TLS settings reach the install's children. */
  env: NodeJS.ProcessEnv;
  /** Network, process runner and clock; the real ones by default. */
  deps?: KnowledgeInstallerDeps;
  /**
   * Fixtures for tests: the overlay, the locks, the uv build (null: unsupported), the model and
   * the tiktoken encodings; the pinned ones by default.
   */
  overlayRoot?: string;
  locksDir?: string;
  uv?: UvBuild | null;
  model?: EmbeddingModelSpec;
  encodings?: readonly TiktokenEncodingSpec[];
}

export function createKnowledgeGraphUpdater(options: KnowledgeGraphUpdaterOptions): PluginUpdater {
  const { platform, arch } = options;
  const runtimeDir = knowledgeRuntimeDir(options.baseDir);
  const deps = options.deps ?? defaultKnowledgeInstallerDeps;
  const uv = options.uv !== undefined ? options.uv : uvBuildFor(platform, arch, options.libc);
  const model = options.model ?? EMBEDDING_MODEL;
  const encodings = options.encodings ?? TIKTOKEN_ENCODINGS;
  const overlayRoot = options.overlayRoot ?? MYKG_PROMPTS_ROOT;
  // The shipped overlay does not change while the daemon runs; read once.
  let digest: Promise<string> | null = null;
  const currentDigest = (): Promise<string> => {
    digest ??= overlayDigest(MYKG_LINE, overlayRoot).catch((error) => {
      digest = null;
      throw error;
    });
    return digest;
  };

  const target: PluginUpdateTarget<MykgRelease> = {
    name: "myKG",
    available: uv !== null,
    // Turning it on installs the version Orquester tested; later checks offer newer patches.
    firstInstall: MYKG_PINNED_VERSION,
    versions: (state) => state,
    versionsIn: (state) => state,
    // An install whose overlay is not the shipped one (an Orquester update changed the
    // prompts), or that lacks a tiktoken encoding, counts as missing: the next check repairs it.
    hasFiles: async (version) =>
      knowledgeRuntimeReady(runtimeDir, version, { overlayDigestNow: await currentDigest(), model, encodings }),
    // With an older overlay it still runs (as KnowledgeRuntimeTracker serves it): a rollback target.
    hasInstalled: (version) => knowledgeRuntimeReady(runtimeDir, version, { model }),
    resolve: (signal, pinned) => resolveMykgRelease(deps, signal, pinned),
    install: (release, signal) => {
      if (!uv) throw new KnowledgeInstallError("download", `uv has no build for ${platform}/${arch}`);
      return installKnowledgeRuntime(runtimeDir, release, deps, {
        uv,
        env: options.env,
        signal,
        overlayRoot,
        model,
        encodings,
        ...(options.locksDir ? { locksDir: options.locksDir } : {})
      });
    },
    prune: (keep) => pruneKnowledgeVersions(runtimeDir, keep)
  };

  return {
    id: KNOWLEDGE_GRAPH_PLUGIN_ID,
    checkFailedMessage: "Knowledge Graph runtime update check failed",
    skipFailedOnSchedule: true,
    supported: () => uv !== null,
    unsupported: () =>
      new PluginsError(409, "PLUGIN_UNSUPPORTED", `The Knowledge Graph runtime has no build for ${platform}/${arch}.`),
    target: () => target,
    clearStaging: () => clearKnowledgeStaging(runtimeDir),
    clearRecords: (state) => {
      delete state.current;
      delete state.previous;
      delete state.skippedVersion;
    },
    removeFiles: () => removeKnowledgeRuntime(runtimeDir),
    errorRecord: (error, at, version) => ({
      at,
      step: error instanceof KnowledgeInstallError ? error.step : "check",
      message: error instanceof Error ? error.message : String(error),
      ...(version ? { version } : {})
    }),
    view: () => ({}),
    now: () => deps.now()
  };
}
