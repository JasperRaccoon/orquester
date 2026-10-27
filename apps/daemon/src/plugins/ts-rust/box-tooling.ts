/**
 * Better TS Typecheck in boxes (Ephemeral AI VMs spec §10): the plugin's
 * `ToolingPlugin` for the box tooling provisioner (`boxes/tooling/`).
 *
 * - **Engine per target.** The engine plugins.json names when it has a build
 *   for the box, else the box's default: tsrs where it has one (Linux glibc
 *   and musl on x64 and arm64, Apple Silicon macOS), else tsc-rs (Windows,
 *   Intel macOS). tsc-rs's Linux build is statically linked, so one package
 *   serves glibc and musl. A Windows box gets tsc-rs even when the host runs tsrs.
 * - **Version.** The host's current version of that engine, so a box follows
 *   the host's updates and rollbacks; the registry's latest when the host has
 *   none of that engine (a tsrs host's Windows box).
 * - **Release.** Resolved from the npm registry for the box's platform package
 *   exactly as the host installer does (`resolveTsRustRelease`: https tarball,
 *   sha512 integrity required).
 * - **Files.** The box preload (`renderTsRustBoxPreload`, box paths and the
 *   box's workspaces root) and a state file `{ enabled, engine, version }` the
 *   preload reads instead of the host's plugins.json. While the plugin is off
 *   only the state file is written, saying so; the preload is never deleted
 *   (sessions started while it was on still `--require` it).
 */

import type { TsCheckerEngine } from "@orquester/api";
import { TS_CHECKER_ENGINES, TS_RUST_PLUGIN_ID } from "@orquester/api";

import type { ToolTarget } from "../../boxes/contracts.ts";
import { type ToolingPlan, type ToolingPlugin, ToolingStepError, type ToolingTargetContext } from "../../boxes/tooling/types.ts";
import {
  TS_CHECKER_ENGINE_SPECS,
  type TsRustInstallerDeps,
  resolveTsRustRelease,
  tsRustInstallerDepsWithFetch
} from "./installer.ts";
import { renderTsRustBoxPreload } from "./preload.ts";

/** ts-rust's state as boxes need it (`PluginsService.tsRustToolingState`). */
export interface TsRustToolingState {
  enabled: boolean;
  /** The engine plugins.json names, if any. */
  engine: TsCheckerEngine | undefined;
  /** The host's current version of each engine. */
  current: Readonly<Record<TsCheckerEngine, string | null>>;
}

/** What the plugin reads from the plugins service. */
export interface TsRustToolingSource {
  /** Null while plugins.json does not read. */
  tsRustToolingState(): TsRustToolingState | null;
  /** Emits `"changed"` after every plugin state or job change. */
  readonly events: { on(event: "changed", listener: () => void): unknown; off(event: "changed", listener: () => void): unknown };
}

/** The box files' names under `tooling/ts-rust/`. */
export const TS_RUST_BOX_PRELOAD = "preload.cjs";
export const TS_RUST_BOX_STATE = "state.json";

interface TsRustTargetEngines {
  /** Each engine's platform package for the target, or null where it has no build. */
  packages: Readonly<Record<TsCheckerEngine, string | null>>;
  supported: TsCheckerEngine[];
  /** tsrs where it has a build, else tsc-rs; null when neither has one. */
  defaultEngine: TsCheckerEngine | null;
}

function tsRustTargetEngines(target: ToolTarget): TsRustTargetEngines {
  const packageFor = (engine: TsCheckerEngine) =>
    TS_CHECKER_ENGINE_SPECS[engine].platformPackage(target.os, target.arch, target.libc === "musl" ? "musl" : "glibc");
  const packages = { tsrs: packageFor("tsrs"), "tsc-rs": packageFor("tsc-rs") };
  const supported = TS_CHECKER_ENGINES.filter((engine) => packages[engine] !== null);
  return { packages, supported, defaultEngine: packages.tsrs !== null ? "tsrs" : packages["tsc-rs"] !== null ? "tsc-rs" : null };
}

/** The engine a box runs: `stored` when it has a build for the target, else the target's default. */
function tsRustEngineForTarget(target: ToolTarget, stored: TsCheckerEngine | undefined): TsCheckerEngine | null {
  const engines = tsRustTargetEngines(target);
  return stored !== undefined && engines.packages[stored] !== null ? stored : engines.defaultEngine;
}

export interface TsRustToolingPluginOptions {
  source: TsRustToolingSource;
  /** Registry access; built over `fetch` (the global one by default). */
  registry?: Pick<TsRustInstallerDeps, "fetchJson">;
  fetch?: typeof fetch;
}

export function createTsRustToolingPlugin(options: TsRustToolingPluginOptions): ToolingPlugin {
  const registry = options.registry ?? tsRustInstallerDepsWithFetch(options.fetch);
  const fingerprint = (): string => JSON.stringify(options.source.tsRustToolingState());

  return {
    id: TS_RUST_PLUGIN_ID,

    async plan(context: ToolingTargetContext, signal: AbortSignal): Promise<ToolingPlan> {
      const state = options.source.tsRustToolingState();
      if (state === null) {
        // The host preload runs the real tsc then too; the box keeps what it had until the file reads.
        throw new ToolingStepError("resolve", "plugins.json does not read");
      }
      const { target } = context;
      const engines = tsRustTargetEngines(target);
      const engine = tsRustEngineForTarget(target, state.engine);
      if (engine === null) {
        const libc = target.libc ? ` (${target.libc})` : "";
        return { kind: "unsupported", message: `Neither tsrs nor tsc-rs has a build for ${target.os}/${target.arch}${libc}.` };
      }
      const statePath = context.path.join(context.pluginDir, TS_RUST_BOX_STATE);
      if (!state.enabled) {
        return { kind: "off", files: [{ path: statePath, content: `${JSON.stringify({ enabled: false })}\n` }] };
      }
      const spec = TS_CHECKER_ENGINE_SPECS[engine];
      const platformPackage = engines.packages[engine] as string;
      let release;
      try {
        release = await resolveTsRustRelease(spec, platformPackage, registry, signal, state.current[engine] ?? undefined);
      } catch (error) {
        throw new ToolingStepError("resolve", error instanceof Error ? error.message : String(error));
      }
      const preloadPath = context.path.join(context.pluginDir, TS_RUST_BOX_PRELOAD);
      const preload = renderTsRustBoxPreload({
        os: target.os,
        statePath,
        workspacesRoots: context.workspacesRoots,
        versionsDirs: { tsrs: context.versionsDir("tsrs"), "tsc-rs": context.versionsDir("tsc-rs") },
        supportedEngines: engines.supported
      });
      return {
        kind: "install",
        artifacts: [
          {
            tool: engine,
            version: release.version,
            url: release.tarball,
            integrity: release.integrity,
            archive: "tar.gz",
            stripPrefix: spec.packageDir,
            entry: spec.binaryName(target.os),
            smokeTest: { args: ["--version"], expectLinePrefix: "Version " }
          }
        ],
        // The preload first: the state file is what turns it on.
        files: [
          { path: preloadPath, content: preload },
          { path: statePath, content: `${JSON.stringify({ enabled: true, engine, version: release.version })}\n` }
        ],
        contribution: { pathPrepend: [], env: {}, nodeRequire: [preloadPath] },
        summary: `${engine} ${release.version}`
      };
    },

    onChange(listener: () => void): () => void {
      // Only what a box gets counts: on/off, the engine, the host's versions — not job progress.
      let last = fingerprint();
      const onChanged = () => {
        const next = fingerprint();
        if (next === last) return;
        last = next;
        listener();
      };
      options.source.events.on("changed", onChanged);
      return () => {
        options.source.events.off("changed", onChanged);
      };
    }
  };
}
