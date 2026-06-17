import type {
  OpenResult,
  RegistryActionResult,
  RegistryEntry,
  RegistryKind,
  RegistryResponse
} from "@orquester/api";
import { REGISTRY, type RegistryEntryDef } from "@orquester/registry";
import { exec, spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { readFile } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";

/** Runtime shape after token expansion. */
interface RegistryDef {
  id: string;
  name: string;
  kind: RegistryKind;
  bin: string[];
  enabled?: boolean;
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
    if (s.versionFlag) d.versionFlag = s.versionFlag;
    if (s.installCmd) d.installCmd = s.installCmd;
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
    for (const def of defs) {
      this.entries.set(def.id, this.resolveDef(def));
    }
  }

  list(): RegistryResponse {
    const byKind = (kind: RegistryKind) =>
      [...this.entries.values()].filter((entry) => entry.kind === kind);
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

  async version(id: string): Promise<RegistryActionResult> {
    const entry = this.entries.get(id);
    if (!entry?.resolvedBin || !entry.versionFlag) {
      return { ok: false, exitCode: -1, output: "No bin or version flag for this entry." };
    }
    return run(`"${entry.resolvedBin}" ${entry.versionFlag}`);
  }

  async install(id: string): Promise<RegistryActionResult> {
    const entry = this.entries.get(id);
    if (!entry?.installCmd) {
      return { ok: false, exitCode: -1, output: "No install command for this entry." };
    }
    const result = await run(entry.installCmd);
    await this.init();
    return result;
  }

  async update(id: string): Promise<RegistryActionResult> {
    const entry = this.entries.get(id);
    if (!entry?.updateCmd) {
      return { ok: false, exitCode: -1, output: "No update command for this entry." };
    }
    return run(entry.updateCmd);
  }

  private resolveDef(def: RegistryDef): RegistryEntry {
    const resolvedBin = resolveBin(def.bin);
    return {
      id: def.id,
      name: def.name,
      kind: def.kind,
      bin: def.bin,
      resolvedBin,
      enabled: Boolean(resolvedBin) && def.enabled !== false,
      versionFlag: def.versionFlag,
      installCmd: def.installCmd,
      updateCmd: def.updateCmd
    };
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

  if (!id || !name || bin.length === 0) {
    return null;
  }

  return {
    id,
    name,
    kind: KINDS.includes(obj.kind as RegistryKind) ? (obj.kind as RegistryKind) : defaultKind,
    bin,
    enabled: typeof obj.enabled === "boolean" ? obj.enabled : undefined,
    versionFlag: typeof obj.versionFlag === "string" ? obj.versionFlag : undefined,
    installCmd: typeof obj.installCmd === "string" ? obj.installCmd : undefined,
    updateCmd: typeof obj.updateCmd === "string" ? obj.updateCmd : undefined
  };
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
