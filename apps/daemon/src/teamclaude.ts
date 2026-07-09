import type {
  AddonEntry,
  RegistryInstallState,
  TeamClaudeAccountSummary,
  TeamClaudeStatus
} from "@orquester/api";
import {
  createDefaultTeamClaudeConfig,
  parseTeamClaudeConfig,
  type TeamClaudeConfig
} from "@orquester/config";
import { TEAMCLAUDE_README } from "@orquester/registry";
import { exec, spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  accessSync,
  chmodSync,
  constants,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync
} from "node:fs";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";

const execAsync = promisify(exec);

const DEF = {
  id: "teamclaude",
  name: "TeamClaude",
  description: "Multi-account Claude proxy with automatic quota-based rotation for Claude Code.",
  bin: ["teamclaude"],
  versionFlag: "version",
  installCmd: "npm install -g @karpeleslab/teamclaude",
  updateCmd: "npm update -g @karpeleslab/teamclaude",
  readmeMarkdown: TEAMCLAUDE_README
} as const;

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
  const exts =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean)
      : [""];
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

function teamclaudeUserConfigPath(): string {
  if (process.env.TEAMCLAUDE_CONFIG) return process.env.TEAMCLAUDE_CONFIG;
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) return join(xdg, "teamclaude.json");
  const home = process.env.HOME || process.env.USERPROFILE || "";
  return join(home, ".config", "teamclaude.json");
}

function writeJson0600(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    /* ignore */
  }
  renameSync(tmp, path);
}

function loadOrquesterState(path: string): TeamClaudeConfig {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return parseTeamClaudeConfig(raw);
  } catch {
    return createDefaultTeamClaudeConfig();
  }
}

interface TcAccountRaw {
  name?: string;
  type?: string;
  priority?: number;
  disabled?: boolean;
  orgName?: string;
  accessToken?: string;
  refreshToken?: string;
  apiKey?: string;
}

interface TcConfigRaw {
  proxy?: { port?: number; apiKey?: string; host?: string };
  switchThreshold?: number;
  accounts?: TcAccountRaw[];
}

function readTcConfig(): TcConfigRaw | null {
  try {
    return JSON.parse(readFileSync(teamclaudeUserConfigPath(), "utf8")) as TcConfigRaw;
  } catch {
    return null;
  }
}

function writeTcConfig(next: TcConfigRaw): void {
  writeJson0600(teamclaudeUserConfigPath(), next);
}

function accountSummaries(cfg: TcConfigRaw | null): TeamClaudeAccountSummary[] {
  const list = cfg?.accounts ?? [];
  return list
    .filter((a) => typeof a.name === "string" && a.name.length > 0)
    .map((a) => ({
      name: a.name as string,
      type: typeof a.type === "string" ? a.type : undefined,
      priority: typeof a.priority === "number" ? a.priority : undefined,
      disabled: a.disabled === true,
      hasCredentials: Boolean(a.accessToken || a.refreshToken || a.apiKey),
      orgName: typeof a.orgName === "string" ? a.orgName : undefined
    }));
}

export interface ClaudeLaunchEnv {
  env: Record<string, string>;
}

/**
 * Owns TeamClaude install/update, orquester enablement toggle, headless proxy
 * process, credential management helpers, and Claude-session launch env.
 */
export class TeamClaudeService {
  readonly events = new EventEmitter();
  private installState: RegistryInstallState = "idle";
  private installError?: string;
  private version?: string;
  private resolvedBin?: string;
  private state: TeamClaudeConfig;
  private child: ChildProcess | null = null;
  private lastError?: string;
  private starting: Promise<void> | null = null;

  constructor(private readonly statePath: string) {
    this.state = loadOrquesterState(statePath);
    this.resolvedBin = resolveBin([...DEF.bin]);
  }

  async init(): Promise<void> {
    this.resolvedBin = resolveBin([...DEF.bin]);
    if (this.resolvedBin) {
      await this.detectVersion();
    }
    if (this.state.enabled && this.resolvedBin) {
      await this.ensureRunning().catch((err) => {
        this.lastError = err instanceof Error ? err.message : String(err);
        console.error("teamclaude: failed to start proxy on boot", err);
      });
    }
  }

  listAddons(): AddonEntry[] {
    return [this.toAddonEntry()];
  }

  toAddonEntry(): AddonEntry {
    return {
      id: DEF.id,
      name: DEF.name,
      description: DEF.description,
      readmeMarkdown: DEF.readmeMarkdown,
      installed: Boolean(this.resolvedBin),
      enabled: this.state.enabled,
      resolvedBin: this.resolvedBin,
      version: this.version,
      installCmd: DEF.installCmd,
      updateCmd: DEF.updateCmd,
      installState: this.installState,
      installError: this.installError
    };
  }

  status(): TeamClaudeStatus {
    const cfg = readTcConfig();
    const port = this.state.port || cfg?.proxy?.port || 3456;
    const threshold =
      typeof this.state.switchThreshold === "number"
        ? this.state.switchThreshold
        : typeof cfg?.switchThreshold === "number"
          ? cfg.switchThreshold
          : 0.98;
    return {
      installed: Boolean(this.resolvedBin),
      enabled: this.state.enabled,
      running: this.isRunning(),
      version: this.version,
      port,
      switchThreshold: threshold,
      accounts: accountSummaries(cfg),
      installState: this.installState,
      installError: this.installError,
      lastError: this.lastError,
      readmeMarkdown: DEF.readmeMarkdown
    };
  }

  install(): { started: boolean } {
    if (!DEF.installCmd || this.installState === "installing") return { started: false };
    this.runManaged(DEF.installCmd);
    return { started: true };
  }

  update(): { started: boolean } {
    if (!DEF.updateCmd || this.installState === "installing") return { started: false };
    this.runManaged(DEF.updateCmd);
    return { started: true };
  }

  async setEnabled(enabled: boolean): Promise<TeamClaudeStatus> {
    this.state = { ...this.state, enabled };
    this.persistState();
    if (enabled) {
      if (!this.resolvedBin) {
        this.lastError = "TeamClaude is not installed.";
        this.emitChanged();
        return this.status();
      }
      try {
        await this.ensureRunning();
        this.lastError = undefined;
      } catch (err) {
        this.lastError = err instanceof Error ? err.message : String(err);
      }
    } else {
      await this.stopProxy();
      this.lastError = undefined;
    }
    this.emitChanged();
    return this.status();
  }

  async updateSettings(patch: {
    switchThreshold?: number;
    port?: number;
  }): Promise<TeamClaudeStatus> {
    const next = { ...this.state };
    if (typeof patch.port === "number") next.port = patch.port;
    if (typeof patch.switchThreshold === "number") next.switchThreshold = patch.switchThreshold;
    this.state = parseTeamClaudeConfig(next);
    this.persistState();

    // Mirror into TeamClaude's own config so the proxy process sees them.
    const cfg = readTcConfig() ?? { proxy: {}, accounts: [] };
    cfg.proxy = { ...(cfg.proxy ?? {}), port: this.state.port };
    cfg.switchThreshold = this.state.switchThreshold;
    writeTcConfig(cfg);

    if (this.state.enabled) {
      await this.stopProxy();
      try {
        await this.ensureRunning();
        this.lastError = undefined;
      } catch (err) {
        this.lastError = err instanceof Error ? err.message : String(err);
      }
    }
    this.emitChanged();
    return this.status();
  }

  /**
   * Env injected into new Claude Code sessions when the addon is enabled.
   * Throws SessionError-style message if enabled but unhealthy.
   */
  resolveClaudeLaunchEnv(): ClaudeLaunchEnv | null {
    if (!this.state.enabled) return null;
    if (!this.resolvedBin) {
      throw new TeamClaudeError("TeamClaude is enabled but not installed. Install it from Settings → Addons.");
    }
    if (!this.isRunning()) {
      throw new TeamClaudeError(
        "TeamClaude is enabled but the proxy is not running. Check Settings → Addons or try re-enabling."
      );
    }
    const cfg = readTcConfig();
    const port = this.state.port || cfg?.proxy?.port || 3456;
    const apiKey = cfg?.proxy?.apiKey;
    if (!apiKey) {
      throw new TeamClaudeError(
        "TeamClaude is enabled but has no proxy API key yet. Run the proxy once (re-enable) or add an account."
      );
    }
    return {
      env: {
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
        ANTHROPIC_API_KEY: apiKey,
        // Prefer base-URL routing for daemon-spawned sessions (no MITM CA).
        ANTHROPIC_AUTH_TOKEN: apiKey
      }
    };
  }

  async importCredentials(from?: string): Promise<TeamClaudeStatus> {
    const bin = this.requireBin();
    const args = from ? ["import", "--from", from] : ["import"];
    await this.runCli(bin, args);
    await this.tellReload().catch(() => undefined);
    this.emitChanged();
    return this.status();
  }

  async addApiKey(apiKey: string, name?: string): Promise<TeamClaudeStatus> {
    const trimmed = apiKey.trim();
    if (!trimmed) throw new TeamClaudeError("API key is required.");
    const cfg = readTcConfig() ?? { proxy: { port: this.state.port }, accounts: [] };
    if (!cfg.accounts) cfg.accounts = [];
    const accountName = name?.trim() || `api-${cfg.accounts.length + 1}`;
    // Remove existing same-name first.
    cfg.accounts = cfg.accounts.filter((a) => a.name !== accountName);
    cfg.accounts.push({
      name: accountName,
      type: "api",
      accessToken: trimmed,
      priority: 100,
      disabled: false
    });
    if (!cfg.proxy) cfg.proxy = { port: this.state.port };
    writeTcConfig(cfg);
    await this.tellReload().catch(() => undefined);
    this.emitChanged();
    return this.status();
  }

  async removeAccount(name: string): Promise<TeamClaudeStatus> {
    const bin = this.requireBin();
    await this.runCli(bin, ["remove", name]);
    await this.tellReload().catch(() => undefined);
    this.emitChanged();
    return this.status();
  }

  async setAccountDisabled(name: string, disabled: boolean): Promise<TeamClaudeStatus> {
    const bin = this.requireBin();
    await this.runCli(bin, [disabled ? "disable" : "enable", name]);
    await this.tellReload().catch(() => undefined);
    this.emitChanged();
    return this.status();
  }

  async setPriority(name: string, priority: number): Promise<TeamClaudeStatus> {
    const bin = this.requireBin();
    await this.runCli(bin, ["priority", name, String(priority)]);
    await this.tellReload().catch(() => undefined);
    this.emitChanged();
    return this.status();
  }

  /**
   * Best-effort live quota for further usage aggregation. Returns null when
   * proxy is down or status cannot be parsed.
   */
  async fetchUsageSnapshot(): Promise<{
    accounts: Array<{
      name: string;
      sessionPercent?: number;
      weeklyPercent?: number;
      sessionResetsAt?: string;
      weeklyResetsAt?: string;
    }>;
  } | null> {
    if (!this.resolvedBin || !this.isRunning()) return null;
    try {
      const out = await this.runCli(this.resolvedBin, ["status", "--json"], { timeoutMs: 8_000 });
      const parsed = JSON.parse(out) as unknown;
      return normalizeStatusJson(parsed);
    } catch {
      // Fallback: synthesize from config accounts with unknown windows.
      const accounts = accountSummaries(readTcConfig());
      if (accounts.length === 0) return null;
      return { accounts: accounts.map((a) => ({ name: a.name })) };
    }
  }

  async stop(): Promise<void> {
    await this.stopProxy();
  }

  private requireBin(): string {
    const bin = this.resolvedBin ?? resolveBin([...DEF.bin]);
    this.resolvedBin = bin;
    if (!bin) throw new TeamClaudeError("TeamClaude is not installed.");
    return bin;
  }

  private isRunning(): boolean {
    return Boolean(this.child && this.child.exitCode === null && !this.child.killed);
  }

  private async ensureRunning(): Promise<void> {
    if (this.isRunning()) return;
    if (this.starting) return this.starting;
    this.starting = this.startProxy().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async startProxy(): Promise<void> {
    const bin = this.requireBin();
    // Ensure a config exists with our preferred port before spawning.
    const cfg = readTcConfig() ?? { proxy: {}, accounts: [] };
    cfg.proxy = { ...(cfg.proxy ?? {}), port: this.state.port, host: "127.0.0.1" };
    cfg.switchThreshold = this.state.switchThreshold;
    writeTcConfig(cfg);

    const env = {
      ...process.env,
      TEAMCLAUDE_CONFIG: teamclaudeUserConfigPath(),
      TEAMCLAUDE_DISABLE_AUTOUPDATE: "1"
    };

    const child = spawn(bin, ["server", "--headless"], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: false
    });
    this.child = child;
    let stderr = "";
    child.stderr?.on("data", (buf: Buffer) => {
      stderr = (stderr + buf.toString("utf8")).slice(-4000);
    });
    child.on("exit", (code) => {
      if (this.child === child) {
        this.child = null;
        if (this.state.enabled) {
          this.lastError = `TeamClaude proxy exited (code ${code ?? "?"})${stderr ? `: ${stderr.slice(-200)}` : ""}`;
          this.emitChanged();
        }
      }
    });

    // Wait until the health endpoint answers or we time out.
    const port = this.state.port;
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (!this.isRunning()) {
        throw new TeamClaudeError(
          `TeamClaude proxy failed to start${stderr ? `: ${stderr.slice(-300)}` : "."}`
        );
      }
      if (await probeLocal(port)) {
        this.lastError = undefined;
        // First boot generates proxy.apiKey into the config — re-read so launch env has it.
        this.emitChanged();
        return;
      }
      await sleep(250);
    }
    throw new TeamClaudeError(`TeamClaude proxy did not become ready on 127.0.0.1:${port} within 15s.`);
  }

  private async stopProxy(): Promise<void> {
    const child = this.child;
    this.child = null;
    if (!child || child.killed) return;
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
        resolve();
      }, 3_000);
      child.once("exit", () => {
        clearTimeout(t);
        resolve();
      });
      try {
        child.kill("SIGTERM");
      } catch {
        clearTimeout(t);
        resolve();
      }
    });
  }

  private async tellReload(): Promise<void> {
    if (!this.isRunning()) return;
    const port = this.state.port;
    try {
      await fetch(`http://127.0.0.1:${port}/teamclaude/reload`, { method: "POST" });
    } catch {
      /* optional control endpoint */
    }
  }

  private runManaged(command: string): void {
    this.installState = "installing";
    this.installError = undefined;
    this.emitChanged();
    void runShell(command).then((result) => {
      if (result.ok) {
        this.resolvedBin = resolveBin([...DEF.bin]);
        this.installState = "idle";
        this.installError = undefined;
        this.version = undefined;
        void this.detectVersion().then(() => this.emitChanged());
      } else {
        this.installState = "error";
        this.installError = result.output.slice(-4000);
        this.emitChanged();
      }
    });
  }

  private async detectVersion(): Promise<void> {
    if (!this.resolvedBin) return;
    try {
      const out = await this.runCli(this.resolvedBin, [DEF.versionFlag], { timeoutMs: 8_000 });
      const line = out.split("\n").find((l) => l.trim())?.trim().slice(0, 80);
      if (line) this.version = line;
    } catch {
      /* leave version undefined */
    }
  }

  private async runCli(
    bin: string,
    args: string[],
    opts: { timeoutMs?: number } = {}
  ): Promise<string> {
    const timeout = opts.timeoutMs ?? 60_000;
    const { stdout, stderr } = await execAsync(`"${bin}" ${args.map(shellQuote).join(" ")}`, {
      timeout,
      maxBuffer: 4 * 1024 * 1024,
      env: {
        ...process.env,
        TEAMCLAUDE_CONFIG: teamclaudeUserConfigPath(),
        TEAMCLAUDE_DISABLE_AUTOUPDATE: "1"
      }
    });
    return `${stdout ?? ""}${stderr ?? ""}`;
  }

  private persistState(): void {
    writeJson0600(this.statePath, this.state);
  }

  private emitChanged(): void {
    this.events.emit("changed", this.toAddonEntry());
    this.events.emit("status", this.status());
  }
}

export class TeamClaudeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TeamClaudeError";
  }
}

function shellQuote(s: string): string {
  if (/^[a-zA-Z0-9_./:@%+=-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function runShell(command: string): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    exec(command, { timeout: 10 * 60_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      const output = `${stdout ?? ""}${stderr ?? ""}`.slice(0, 64_000);
      resolve({ ok: !error, output });
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function probeLocal(port: number): Promise<boolean> {
  try {
    // Prefer the control/status surface; fall back to any TCP accept.
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      signal: AbortSignal.timeout(1500)
    });
    // Any HTTP response means the proxy is up (401/404 still count).
    return res.status > 0;
  } catch {
    return false;
  }
}

function normalizeStatusJson(parsed: unknown): {
  accounts: Array<{
    name: string;
    sessionPercent?: number;
    weeklyPercent?: number;
    sessionResetsAt?: string;
    weeklyResetsAt?: string;
  }>;
} | null {
  if (!parsed || typeof parsed !== "object") return null;
  const root = parsed as Record<string, unknown>;
  const rawList = Array.isArray(root.accounts)
    ? root.accounts
    : Array.isArray(root)
      ? (root as unknown[])
      : null;
  if (!rawList) return null;
  const accounts = rawList
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const a = item as Record<string, unknown>;
      const name =
        typeof a.name === "string"
          ? a.name
          : typeof a.email === "string"
            ? a.email
            : typeof a.id === "string"
              ? a.id
              : null;
      if (!name) return null;
      const session =
        typeof a.session === "object" && a.session
          ? (a.session as Record<string, unknown>)
          : typeof a.sessionUtilization === "number"
            ? { utilization: a.sessionUtilization }
            : null;
      const weekly =
        typeof a.weekly === "object" && a.weekly
          ? (a.weekly as Record<string, unknown>)
          : typeof a.weeklyUtilization === "number"
            ? { utilization: a.weeklyUtilization }
            : null;
      const sessionPercent = pickPercent(a, session, [
        "sessionPercent",
        "session_utilization",
        "utilization",
        "used"
      ]);
      const weeklyPercent = pickPercent(a, weekly, [
        "weeklyPercent",
        "weekly_utilization",
        "utilization",
        "used"
      ]);
      return {
        name,
        sessionPercent,
        weeklyPercent,
        sessionResetsAt: pickIso(a, session, ["sessionResetsAt", "resetsAt", "reset", "session_reset"]),
        weeklyResetsAt: pickIso(a, weekly, ["weeklyResetsAt", "resetsAt", "reset", "weekly_reset"])
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);
  return accounts.length > 0 ? { accounts } : null;
}

function pickPercent(
  a: Record<string, unknown>,
  nested: Record<string, unknown> | null,
  keys: string[]
): number | undefined {
  for (const k of keys) {
    const v = a[k] ?? nested?.[k];
    if (typeof v === "number" && Number.isFinite(v)) {
      // Accept 0–1 fractions or 0–100 percents.
      return v <= 1 ? v * 100 : v;
    }
  }
  return undefined;
}

function pickIso(
  a: Record<string, unknown>,
  nested: Record<string, unknown> | null,
  keys: string[]
): string | undefined {
  for (const k of keys) {
    const v = a[k] ?? nested?.[k];
    if (typeof v === "string" && v.length > 0) return v;
    if (typeof v === "number" && Number.isFinite(v)) {
      // epoch ms or s
      const ms = v > 1e12 ? v : v > 1e9 ? v * 1000 : NaN;
      if (Number.isFinite(ms)) return new Date(ms).toISOString();
    }
  }
  return undefined;
}

