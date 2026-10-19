/**
 * Per-target plugin tooling (Ephemeral AI VMs spec §10): what a built-in
 * plugin that contributes per-session tooling declares for one target, so the
 * box tooling provisioner (`provisioner.ts`) can install it in any box. A
 * plugin implements {@link ToolingPlugin}; Better TS Typecheck's is
 * `plugins/ts-rust/box-tooling.ts`.
 */

import type { posix } from "node:path";

import type { ToolTarget, SessionToolingContribution } from "../contracts.ts";

/** One release archive of one tool, for one target. */
export interface ToolArtifact {
  /** Tool id: part of the host cache key and the box install dir (`tooling/<tool>/versions/<version>`). */
  tool: string;
  version: string;
  /** Where the daemon downloads it (https). Only the daemon downloads; the box gets the verified bytes. */
  url: string;
  /** SRI string with at least one sha512 digest (npm's `dist.integrity`); anything else is refused. */
  integrity: string;
  /** Archive layout. npm tarballs are gzip-compressed tar. */
  archive: "tar.gz";
  /** The directory inside the archive that becomes the version dir (`package/lib`), `/`-separated. */
  stripPrefix: string;
  /** The entry binary, relative to the version dir (`tsc.exe`). */
  entry: string;
  /** Run in the box before the release is moved into place; must exit 0 and print a line starting with `expectLinePrefix`. */
  smokeTest: { args: string[]; expectLinePrefix: string; timeoutMs?: number };
}

/** A small text file the plugin needs in the box (its preload, its state file). */
export interface ToolingFile {
  /** Box path, in the box's syntax. */
  path: string;
  content: string;
  mode?: number;
}

/** Box paths a plugin renders its files and contribution with (all in the box's path syntax). */
export interface ToolingTargetContext {
  boxId: string;
  target: ToolTarget;
  /** The box's path rules (`path.win32` on Windows boxes, else `path.posix`). */
  path: typeof posix;
  /** `<dataDir>/tooling/<pluginId>`: the plugin's own files. */
  pluginDir: string;
  /** `<dataDir>/tooling/<tool>/versions/<version>`: where an artifact is installed. */
  versionDir(tool: string, version: string): string;
  /** `<dataDir>/tooling/<tool>/versions`. */
  versionsDir(tool: string): string;
  /** The workspaces root(s) as box paths: real and configured, when they differ. */
  workspacesRoots: string[];
}

/**
 * What one box gets from one plugin right now:
 * - `install`: the artifacts are installed (or found already installed), then
 *   `files` are written in order, then new sessions get `contribution`.
 * - `off`: the plugin is off. `files` are still written (a state file saying
 *   off, so sessions already running stop using the tooling); nothing is
 *   installed and new sessions get nothing.
 * - `unsupported`: no build for the target; nothing is written.
 */
export type ToolingPlan =
  | {
      kind: "install";
      artifacts: ToolArtifact[];
      files: ToolingFile[];
      contribution: SessionToolingContribution;
      /** One line for the status ("tsrs 0.16.0"). */
      summary: string;
    }
  | { kind: "off"; files: ToolingFile[] }
  | { kind: "unsupported"; message: string };

export interface ToolingPlugin {
  /** The plugin id (`PluginId`): the session-env key and the box dir name. */
  readonly id: string;
  /** Resolve what the box gets now (may query a registry). Throws a {@link ToolingStepError} or any error. */
  plan(context: ToolingTargetContext, signal: AbortSignal): Promise<ToolingPlan>;
  /**
   * Fires when what boxes get may have changed (on/off, engine, a newly
   * installed version): every box it was provisioned to is provisioned again.
   */
  onChange(listener: () => void): () => void;
}

/** Which provisioning step failed; shown in the box's status line. */
export type ToolingStep = "resolve" | "download" | "integrity" | "upload" | "extract" | "smoke-test" | "install" | "files";

export class ToolingStepError extends Error {
  constructor(
    readonly step: ToolingStep,
    message: string
  ) {
    super(message);
    this.name = "ToolingStepError";
  }
}
