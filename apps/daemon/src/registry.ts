import type {
  OpenResult,
  RegistryActionResult,
  RegistryEntry,
  RegistryKind,
  RegistryResponse
} from "@orquester/api";
import { REGISTRY, type RegistryEntryDef } from "@orquester/registry";
import { exec, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { accessSync, constants, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";

/** Runtime shape after token expansion. */
interface RegistryDef {
  id: string;
  name: string;
  kind: RegistryKind;
  bin: string[];
  args?: string[];
  launchViaShell?: boolean;
  env?: Record<string, string>;
  envFile?: string;
  enabled?: boolean;
  /** When false, disabled at rest even if the bin resolves (a runtime service enables it). */
  enabledAtRest?: boolean;
  versionFlag?: string;
  installCmd?: string;
  updateCmd?: string;
}

function expand(tokens: readonly string[]): string[] {
  const e = process.env;
  const HOME = e.HOME || e.USERPROFILE || "";
  const LOCAL = e.LOCALAPPDATA || "";
  const PF = e.ProgramFiles || e["ProgramFiles(x86)"] || "";
  return tokens
    .filter(Boolean)
    .map((t) =>
      t
        .replace(/\$LOCALAPPDATA/g, LOCAL)
        .replace(/\$PROGRAMFILES/g, PF)
        .replace(/\$HOME/g, HOME)
    );
}

function isExecutable(p: string): boolean {
  try {
    accessSync(p, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveBin(cands: string[]): string | undefined {
  const dirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  const exts = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean) : [""];
  for (const c of cands) {
    if (isAbsolute(c) && isExecutable(c)) return c;
    for (const d of dirs) {
      for (const x of exts) {
        const f = join(d, c + x);
        if (isExecutable(f)) return f;
      }
    }
  }
  return undefined;
}

/**
 * Chromium binaries that puppeteer/playwright tooling drops into the daemon
 * user's caches (~/.cache/puppeteer/chrome/<ver>/chrome-linux64/chrome,
 * ~/.cache/ms-playwright/chromium-<rev>/chrome-linux[64]/chrome). They are not on
 * PATH — so the plain probe misses them — but puppeteer-core drives them fine,
 * and on a VPS they're often the ONLY Chromium present (installed by agent
 * tooling). Probed as fallback candidates for the "chromium" registry entry so
 * browser tabs (Design Mode) light up on such hosts. resolveBin() filters by
 * executability, so listing paths that don't exist is harmless.
 */
function chromiumCacheCandidates(): string[] {
  if (process.platform === "win32") {
    return [];
  }
  const home = process.env.HOME || "";
  if (!home) {
    return [];
  }
  const out: string[] = [];
  const layouts: Array<{ root: string; match: RegExp; leaf: string[] }> = [
    { root: join(home, ".cache", "puppeteer", "chrome"), match: /^linux-/, leaf: ["chrome-linux64", "chrome"] },
    { root: join(home, ".cache", "puppeteer", "chrome"), match: /^mac-/, leaf: ["chrome-mac-arm64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"] },
    { root: join(home, ".cache", "ms-playwright"), match: /^chromium-\d+$/, leaf: ["chrome-linux64", "chrome"] },
    { root: join(home, ".cache", "ms-playwright"), match: /^chromium-\d+$/, leaf: ["chrome-linux", "chrome"] }
  ];
  for (const { root, match, leaf } of layouts) {
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    // Descending name sort ≈ newest version first (good enough for a fallback).
    for (const name of entries.filter((n) => match.test(n)).sort().reverse()) {
      out.push(join(root, name, ...leaf));
    }
  }
  return out;
}

function osOpener(): string[] {
  if (process.platform === "win32") return ["explorer"];
  if (process.platform === "darwin") return ["open"];
  return ["xdg-open"];
}

/** Materialize static defs (from @orquester/registry) into runtime defs. */
function materialize(list: readonly RegistryEntryDef[]): RegistryDef[] {
  return list.map((s) => {
    const expanded = expand(s.bin);
    const bin = s.bin.length === 0 && (s.kind === "file-explorer" || s.kind === "browser") ? osOpener() : expanded;
    const d: RegistryDef = { id: s.id, name: s.name, kind: s.kind, bin };
    if (s.args && s.args.length > 0) d.args = [...s.args];
    if (s.launchViaShell) d.launchViaShell = true;
    if (s.env && Object.keys(s.env).length > 0) d.env = { ...s.env };
    if (s.enabledAtRest === false) d.enabledAtRest = false;
    if (s.versionFlag) d.versionFlag = s.versionFlag;
    const installCmd = process.platform === "win32" && s.installCmdWin32 ? s.installCmdWin32 : s.installCmd;
    if (installCmd) d.installCmd = installCmd;
    if (s.updateCmd) d.updateCmd = s.updateCmd;
    return d;
  });
}

const DEFAULT_SHELLS: RegistryDef[] = materialize(REGISTRY.shells as readonly RegistryEntryDef[]);
const DEFAULT_AGENTS: RegistryDef[] = materialize(REGISTRY.agents as readonly RegistryEntryDef[]);
const DEFAULT_IDES: RegistryDef[] = materialize(REGISTRY.ides as readonly RegistryEntryDef[]);
const DEFAULT_FILE_EXPLORERS: RegistryDef[] = materialize(REGISTRY.fileExplorers as readonly RegistryEntryDef[]);
const DEFAULT_BROWSERS: RegistryDef[] = materialize(REGISTRY.browsers as readonly RegistryEntryDef[]);

/** The platform's generic "open this" command. */
function osOpenerForKind(kind: RegistryKind): string[] {
  if (kind === "file-explorer" || kind === "browser") return osOpener();
  return [];
}

/**
 * Owns the catalog of launchable shells, agents, IDEs, file explorers and
 * browsers. Resolves each entry's binary against PATH (and common install
 * paths) once and caches it; an entry is `enabled` only when a candidate bin
 * was found (and it was not explicitly disabled).
 */
export class RegistryService {
  private entries = new Map<string, RegistryEntry>();
  /** Runtime defs, keyed by id — retained so reresolve/setRuntimeState can recompute. */
  private defs = new Map<string, RegistryDef>();
  /**
   * Per-entry runtime enable/disable overlaid on top of the static/bin-resolution
   * state (set by daemon services such as the CliProxyManager). Survives reresolve.
   */
  private runtimeState = new Map<string, { enabled: boolean; disabledReason?: string }>();
  /** Emits "changed" with the updated RegistryEntry (broadcast to clients). */
  readonly events = new EventEmitter();

  constructor(private readonly daemonDir: string) {}

  async init(): Promise<void> {
    const defs: RegistryDef[] = [
      ...DEFAULT_SHELLS,
      ...DEFAULT_AGENTS,
      ...DEFAULT_IDES,
      ...DEFAULT_FILE_EXPLORERS,
      ...DEFAULT_BROWSERS,
      ...(await this.loadOverrides("shells.json", "shell")),
      ...(await this.loadOverrides("agents.json", "agent")),
      ...(await this.loadOverrides("ides.json", "ide")),
      ...(await this.loadOverrides("file-explorers.json", "file-explorer")),
      ...(await this.loadOverrides("browsers.json", "browser"))
    ];

    this.entries.clear();
    this.defs.clear();
    for (const def of defs) {
      this.defs.set(def.id, def);
      this.entries.set(def.id, await this.resolveDef(def));
    }
    // Detect installed agent versions in the background (cached); each result
    // patches the entry and emits "changed".
    void this.detectVersions();
  }

  list(): RegistryResponse {
    const byKind = (kind: RegistryKind) =>
      [...this.entries.values()].filter((entry) => entry.kind === kind).map(publicEntry);
    return {
      shells: byKind("shell"),
      agents: byKind("agent"),
      ides: byKind("ide"),
      fileExplorers: byKind("file-explorer"),
      browsers: byKind("browser")
    };
  }

  get(id: string): RegistryEntry | undefined {
    return this.entries.get(id);
  }

  /**
   * Overlay runtime enable/disable state on an entry (used by daemon services to
   * gate launchers behind backing infrastructure). Recomputes effective `enabled`
   * through the single pure function and broadcasts the sanitized entry.
   */
  setRuntimeState(id: string, s: { enabled: boolean; disabledReason?: string }): void {
    const def = this.defs.get(id);
    const entry = this.entries.get(id);
    if (!def || !entry) {
      return;
    }
    this.runtimeState.set(id, { enabled: s.enabled, disabledReason: s.disabledReason });
    const { enabled, disabledReason } = this.computeEnabled(def, entry.resolvedBin);
    this.patch(id, { enabled, disabledReason });
  }

  /**
   * Re-run bin resolution + env-file load for one entry, preserving install and
   * runtime state, then broadcast the sanitized entry. Lets a service pick up a
   * freshly written env file without resurrecting a runtime-disabled launcher.
   */
  async reresolve(id: string): Promise<void> {
    const def = this.defs.get(id);
    const entry = this.entries.get(id);
    if (!def || !entry) {
      return;
    }
    const resolvedBin = resolveBin(this.candidatesFor(def));
    const envFromFile = await this.loadEnvFile(def.id, def.envFile);
    const env = mergeEnv(def.env, envFromFile);
    const { enabled, disabledReason } = this.computeEnabled(def, resolvedBin);
    this.patch(id, { env, resolvedBin, enabled, disabledReason });
  }

  /** Launch an ide/file-explorer/browser on a path (fire-and-forget). */
  openTarget(targetId: string, path: string): OpenResult {
    const entry = this.entries.get(targetId);
    if (!entry?.resolvedBin || !entry.enabled) {
      return { ok: false, message: `Target "${targetId}" is not available.` };
    }

    const arg = entry.kind === "browser" ? pathToFileURL(path).href : path;
    try {
      const child = spawn(entry.resolvedBin, [arg], { detached: true, stdio: "ignore" });
      child.unref();
      return { ok: true };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : "spawn failed" };
    }
  }

  /** Start an install (background); status flows via `events`. Returns immediately. */
  install(id: string): { started: boolean } {
    const entry = this.entries.get(id);
    if (!entry?.installCmd || entry.installState === "installing") {
      return { started: false };
    }
    this.runManaged(id, entry.installCmd);
    return { started: true };
  }

  /** Start an update (background); same semantics as install. */
  update(id: string): { started: boolean } {
    const entry = this.entries.get(id);
    if (!entry?.updateCmd || entry.installState === "installing") {
      return { started: false };
    }
    this.runManaged(id, entry.updateCmd);
    return { started: true };
  }

  /** Run the live version flag for an entry (manual endpoint). */
  async version(id: string): Promise<RegistryActionResult> {
    const entry = this.entries.get(id);
    if (!entry?.resolvedBin || !entry.versionFlag) {
      return { ok: false, exitCode: -1, output: "No bin or version flag for this entry." };
    }
    return run(`"${entry.resolvedBin}" ${entry.versionFlag}`);
  }

  /** Run an install/update command, broadcasting status; re-resolve on success. */
  private runManaged(id: string, command: string): void {
    this.patch(id, { installState: "installing", installError: undefined });
    void run(command).then((result) => {
      if (result.ok) {
        const def = this.defs.get(id);
        const resolvedBin = def ? resolveBin(this.candidatesFor(def)) : undefined;
        const { enabled, disabledReason } = def
          ? this.computeEnabled(def, resolvedBin)
          : { enabled: Boolean(resolvedBin), disabledReason: undefined };
        this.patch(id, {
          resolvedBin,
          enabled,
          disabledReason,
          installState: "idle",
          installError: undefined,
          version: undefined
        });
        void this.detectVersion(id);
      } else {
        this.patch(id, { installState: "error", installError: result.output.slice(-4000) });
      }
    });
  }

  private patch(id: string, partial: Partial<RegistryEntry>): void {
    const entry = this.entries.get(id);
    if (!entry) {
      return;
    }
    Object.assign(entry, partial);
    this.events.emit("changed", publicEntry(entry));
  }

  private async detectVersions(): Promise<void> {
    await Promise.all(
      [...this.entries.values()]
        .filter((e) => e.kind === "agent" && e.enabled && e.versionFlag)
        .map((e) => this.detectVersion(e.id))
    );
  }

  private async detectVersion(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry?.resolvedBin || !entry.versionFlag) {
      return;
    }
    const result = await run(`"${entry.resolvedBin}" ${entry.versionFlag}`);
    if (result.ok) {
      const version = result.output.split("\n").find((l) => l.trim())?.trim().slice(0, 80);
      this.patch(id, { version });
    }
  }

  /** Bin candidates for an entry (chromium gets extra cache-path fallbacks). */
  private candidatesFor(def: RegistryDef): string[] {
    return def.id === "chromium" && def.kind === "browser"
      ? [...def.bin, ...chromiumCacheCandidates()]
      : def.bin;
  }

  /**
   * The single source of truth for effective `enabled` (and its runtime reason),
   * used by init, install success, reresolve and setRuntimeState alike. An entry
   * is enabled only when its bin resolved, it is not statically disabled, it is not
   * disabled at rest, and no runtime override turned it off. The disabledReason is
   * surfaced only when a runtime override provides one and the entry is off.
   */
  private computeEnabled(def: RegistryDef, resolvedBin: string | undefined): { enabled: boolean; disabledReason?: string } {
    const runtime = this.runtimeState.get(def.id);
    // A runtime override (from a backing service) wins outright; without one,
    // `enabledAtRest` sets the default. So `enabledAtRest:false` disables a
    // launcher at rest yet still lets the service turn it on when its
    // infrastructure is healthy — it must not veto the runtime decision.
    const runtimeDecision = runtime ? runtime.enabled : def.enabledAtRest !== false;
    const enabled = Boolean(resolvedBin) && def.enabled !== false && runtimeDecision;
    const disabledReason = !enabled && runtime?.disabledReason ? runtime.disabledReason : undefined;
    return { enabled, disabledReason };
  }

  private async resolveDef(def: RegistryDef): Promise<RegistryEntry> {
    const resolvedBin = resolveBin(this.candidatesFor(def));
    const envFromFile = await this.loadEnvFile(def.id, def.envFile);
    const env = mergeEnv(def.env, envFromFile);
    const { enabled, disabledReason } = this.computeEnabled(def, resolvedBin);
    return {
      id: def.id,
      name: def.name,
      kind: def.kind,
      bin: def.bin,
      args: def.args,
      launchViaShell: def.launchViaShell,
      env,
      resolvedBin,
      enabled,
      disabledReason,
      versionFlag: def.versionFlag,
      installCmd: def.installCmd,
      updateCmd: def.updateCmd,
      installState: "idle"
    };
  }

  private async loadEnvFile(id: string, explicitPath?: string): Promise<Record<string, string> | undefined> {
    const path = explicitPath ? envFilePath(this.daemonDir, explicitPath) : defaultEnvFilePath(this.daemonDir, id);
    if (!path) {
      return undefined;
    }
    try {
      return parseEnvFile(await readFile(path, "utf8"));
    } catch {
      return undefined;
    }
  }

  /** Load and normalize <daemonDir>/<file> (array of partial defs), if present. */
  private async loadOverrides(file: string, kind: RegistryKind): Promise<RegistryDef[]> {
    try {
      const raw = await readFile(join(this.daemonDir, file), "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) {
        return [];
      }
      return parsed
        .map((item) => normalizeDef(item, kind))
        .filter((def): def is RegistryDef => def !== null);
    } catch {
      return [];
    }
  }
}

const KINDS: RegistryKind[] = ["shell", "agent", "ide", "file-explorer", "browser"];

function normalizeDef(item: unknown, defaultKind: RegistryKind): RegistryDef | null {
  if (typeof item !== "object" || item === null) {
    return null;
  }
  const obj = item as Record<string, unknown>;
  const id = typeof obj.id === "string" ? obj.id : undefined;
  const name = typeof obj.name === "string" ? obj.name : undefined;
  const bin =
    typeof obj.bin === "string"
      ? [obj.bin]
      : Array.isArray(obj.bin)
        ? obj.bin.filter((b): b is string => typeof b === "string")
        : [];
  const args =
    typeof obj.args === "string"
      ? [obj.args]
      : Array.isArray(obj.args)
        ? obj.args.filter((a): a is string => typeof a === "string")
        : undefined;
  const env =
    typeof obj.env === "object" && obj.env !== null && !Array.isArray(obj.env)
      ? Object.fromEntries(
          Object.entries(obj.env as Record<string, unknown>).filter(
            (e): e is [string, string] => typeof e[1] === "string"
          )
        )
      : undefined;
  const envFile = typeof obj.envFile === "string" ? obj.envFile : undefined;

  if (!id || !name || bin.length === 0) {
    return null;
  }

  return {
    id,
    name,
    kind: KINDS.includes(obj.kind as RegistryKind) ? (obj.kind as RegistryKind) : defaultKind,
    bin,
    args: args && args.length > 0 ? args : undefined,
    launchViaShell: obj.launchViaShell === true ? true : undefined,
    env: env && Object.keys(env).length > 0 ? env : undefined,
    envFile,
    enabled: typeof obj.enabled === "boolean" ? obj.enabled : undefined,
    enabledAtRest: obj.enabledAtRest === false ? false : undefined,
    versionFlag: typeof obj.versionFlag === "string" ? obj.versionFlag : undefined,
    installCmd: typeof obj.installCmd === "string" ? obj.installCmd : undefined,
    updateCmd: typeof obj.updateCmd === "string" ? obj.updateCmd : undefined
  };
}

function defaultEnvFilePath(daemonDir: string, id: string): string | undefined {
  if (!/^[A-Za-z0-9._-]+$/.test(id)) {
    return undefined;
  }
  return join(daemonDir, "env", `${id}.env`);
}

function envFilePath(daemonDir: string, path: string): string {
  return isAbsolute(path) ? path : join(daemonDir, path);
}

function mergeEnv(...parts: Array<Record<string, string> | undefined>): Record<string, string> | undefined {
  const merged = Object.assign({}, ...parts.filter(Boolean));
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function publicEntry(entry: RegistryEntry): RegistryEntry {
  const { env: _env, ...rest } = entry;
  return { ...rest };
}

export function parseEnvFile(raw: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const parsed = parseEnvLine(line);
    if (parsed) {
      env[parsed.key] = parsed.value;
    }
  }
  return env;
}

function parseEnvLine(line: string): { key: string; value: string } | undefined {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) {
    return undefined;
  }

  const assignment = trimmed.startsWith("export ") ? trimmed.slice("export ".length).trimStart() : trimmed;
  const eq = assignment.indexOf("=");
  if (eq <= 0) {
    return undefined;
  }

  const key = assignment.slice(0, eq).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    return undefined;
  }

  return { key, value: parseEnvValue(assignment.slice(eq + 1).trim()) };
}

function parseEnvValue(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value
      .slice(1, -1)
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\r")
      .replace(/\\t/g, "\t")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  return value;
}

/** Run a shell command to completion, capturing combined output (capped). */
function run(command: string): Promise<RegistryActionResult> {
  return new Promise((resolve) => {
    exec(command, { timeout: 10 * 60_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      const output = `${stdout ?? ""}${stderr ?? ""}`.slice(0, 64_000);
      const exitCode = error && typeof error.code === "number" ? error.code : error ? 1 : 0;
      resolve({ ok: !error, exitCode, output });
    });
  });
}
