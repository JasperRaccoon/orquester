import type {
  AddonEntry,
  RegistryInstallState,
  TeamClaudeAccountSummary,
  TeamClaudeSettingsUpdate,
  TeamClaudeStatus,
  TeamClaudeStormRamp
} from "@orquester/api";
import {
  createDefaultTeamClaudeConfig,
  parseTeamClaudeConfig,
  type TeamClaudeConfig
} from "@orquester/config";
import { TEAMCLAUDE_README } from "@orquester/registry";
import { randomBytes, randomUUID } from "node:crypto";
import { exec, spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  accessSync,
  chmodSync,
  constants,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { sessionEnvBase, sessionPath } from "./tmux";

const execAsync = promisify(exec);

const LOGO_URL = "https://avatars.githubusercontent.com/u/58999683?v=4";

const DEFAULT_STORM: TeamClaudeStormRamp = {
  enabled: true,
  startConc: 1,
  stepConc: 1,
  stepMs: 250,
  windowMs: 30000
};

const DEF = {
  id: "teamclaude",
  name: "TeamClaude",
  description: "Multi-account Claude proxy with automatic quota-based rotation for Claude Code.",
  bin: ["teamclaude"],
  versionFlag: "version",
  installCmd: "npm install -g @karpeleslab/teamclaude",
  updateCmd: "npm update -g @karpeleslab/teamclaude",
  readmeMarkdown: TEAMCLAUDE_README,
  logoUrl: LOGO_URL
} as const;

const SAFE_CHILD_ENV_KEYS = new Set([
  "CI",
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOGNAME",
  "NODE_EXTRA_CA_CERTS",
  "NO_PROXY",
  "NPM_CONFIG_PREFIX",
  "PATH",
  "SHELL",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "TEMP",
  "TMP",
  "TMPDIR",
  "USER",
  "USERNAME",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "npm_config_prefix",
  "HTTP_PROXY",
  "HTTPS_PROXY"
]);

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
  quotaProbeSeconds?: number;
  warmupSeconds?: number;
  autoUpdate?: boolean;
  upstream?: string;
  stormRamp?: Partial<TeamClaudeStormRamp>;
  sx?: { apiKey?: string; mode?: "always" | "429" | "off" };
  accounts?: TcAccountRaw[];
  routes?: unknown[];
}

function mergeStorm(raw?: Partial<TeamClaudeStormRamp> | null, fallback?: TeamClaudeStormRamp): TeamClaudeStormRamp {
  const base = fallback ?? DEFAULT_STORM;
  return {
    enabled: typeof raw?.enabled === "boolean" ? raw.enabled : base.enabled,
    startConc: typeof raw?.startConc === "number" ? raw.startConc : base.startConc,
    stepConc: typeof raw?.stepConc === "number" ? raw.stepConc : base.stepConc,
    stepMs: typeof raw?.stepMs === "number" ? raw.stepMs : base.stepMs,
    windowMs: typeof raw?.windowMs === "number" ? raw.windowMs : base.windowMs
  };
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

function createProxyApiKey(): string {
  return `tc-${randomBytes(24).toString("base64url")}`;
}

function normalizeTcConfigForOrquester(cfg: TcConfigRaw, port: number): boolean {
  let changed = false;
  if (!cfg.proxy) {
    cfg.proxy = {};
    changed = true;
  }
  if (cfg.proxy.port !== port) {
    cfg.proxy.port = port;
    changed = true;
  }
  if (cfg.proxy.host !== "127.0.0.1") {
    cfg.proxy.host = "127.0.0.1";
    changed = true;
  }
  if (typeof cfg.proxy.apiKey !== "string" || !cfg.proxy.apiKey.trim()) {
    cfg.proxy.apiKey = createProxyApiKey();
    changed = true;
  }
  for (const account of cfg.accounts ?? []) {
    if ((account.type === "api" || account.type === "apikey") && !account.apiKey && account.accessToken) {
      account.type = "apikey";
      account.apiKey = account.accessToken;
      delete account.accessToken;
      delete account.refreshToken;
      changed = true;
    } else if (account.type === "api") {
      account.type = "apikey";
      changed = true;
    }
  }
  return changed;
}

function readOrCreateTcConfig(port: number): TcConfigRaw {
  const cfg = readTcConfig() ?? { proxy: {}, accounts: [] };
  if (normalizeTcConfigForOrquester(cfg, port)) {
    writeTcConfig(cfg);
  }
  return cfg;
}

function hasUsableAccount(cfg: TcConfigRaw | null): boolean {
  return Boolean(
    cfg?.accounts?.some(
      (account) => account.disabled !== true && Boolean(account.accessToken || account.refreshToken || account.apiKey)
    )
  );
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
  private readonly pidPath: string;

  constructor(private readonly statePath: string) {
    this.state = loadOrquesterState(statePath);
    this.resolvedBin = resolveBin([...DEF.bin]);
    this.pidPath = join(dirname(statePath), "teamclaude.pid");
  }

  async init(): Promise<void> {
    this.resolvedBin = resolveBin([...DEF.bin]);
    if (this.resolvedBin) {
      await this.detectVersion();
    }
    if (this.state.enabled && this.resolvedBin) {
      await this.ensureRunning().catch((err) => {
        this.lastError = sanitizeErrorText(err instanceof Error ? err.message : String(err));
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
    const quotaProbeSeconds =
      typeof this.state.quotaProbeSeconds === "number"
        ? this.state.quotaProbeSeconds
        : typeof cfg?.quotaProbeSeconds === "number"
          ? cfg.quotaProbeSeconds
          : 0;
    const warmupSeconds =
      typeof this.state.warmupSeconds === "number"
        ? this.state.warmupSeconds
        : typeof cfg?.warmupSeconds === "number"
          ? cfg.warmupSeconds
          : 0;
    const autoUpdate =
      typeof this.state.autoUpdate === "boolean"
        ? this.state.autoUpdate
        : typeof cfg?.autoUpdate === "boolean"
          ? cfg.autoUpdate
          : true;
    const upstream =
      this.state.upstream ||
      (typeof cfg?.upstream === "string" ? cfg.upstream : "https://api.anthropic.com");
    const stormRamp = mergeStorm(cfg?.stormRamp, this.state.stormRamp);
    const sxMode = this.state.sxMode ?? cfg?.sx?.mode ?? "off";
    const sxKeyConfigured = Boolean(cfg?.sx?.apiKey && cfg.sx.apiKey.length > 0);

    return {
      installed: Boolean(this.resolvedBin),
      enabled: this.state.enabled,
      running: this.isRunning(),
      version: this.version,
      logoUrl: DEF.logoUrl,
      port,
      switchThreshold: threshold,
      quotaProbeSeconds,
      warmupSeconds,
      autoUpdate,
      upstream,
      stormRamp,
      sxMode,
      sxKeyConfigured,
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
    return this.updateSettings({ enabled });
  }

  async updateSettings(patch: TeamClaudeSettingsUpdate): Promise<TeamClaudeStatus> {
    const wasEnabled = this.state.enabled;
    const next: TeamClaudeConfig = { ...this.state };
    if (typeof patch.enabled === "boolean") next.enabled = patch.enabled;
    if (typeof patch.port === "number") next.port = patch.port;
    if (typeof patch.switchThreshold === "number") next.switchThreshold = patch.switchThreshold;
    if (typeof patch.quotaProbeSeconds === "number") next.quotaProbeSeconds = patch.quotaProbeSeconds;
    if (typeof patch.warmupSeconds === "number") next.warmupSeconds = patch.warmupSeconds;
    if (typeof patch.autoUpdate === "boolean") next.autoUpdate = patch.autoUpdate;
    if (typeof patch.upstream === "string" && patch.upstream.trim()) next.upstream = patch.upstream.trim();
    if (patch.stormRamp) next.stormRamp = mergeStorm(patch.stormRamp, next.stormRamp);
    if (patch.sxMode) next.sxMode = patch.sxMode;
    this.state = parseTeamClaudeConfig(next);
    this.persistState();

    const cfg = readOrCreateTcConfig(this.state.port);
    cfg.proxy = { ...(cfg.proxy ?? {}), port: this.state.port, host: "127.0.0.1" };
    cfg.switchThreshold = this.state.switchThreshold;
    cfg.quotaProbeSeconds = this.state.quotaProbeSeconds;
    cfg.warmupSeconds = this.state.warmupSeconds;
    cfg.autoUpdate = this.state.autoUpdate;
    cfg.upstream = this.state.upstream;
    cfg.stormRamp = this.state.stormRamp;
    if (typeof patch.sxApiKey === "string") {
      const key = patch.sxApiKey.trim();
      if (key) {
        cfg.sx = { apiKey: key, mode: this.state.sxMode };
      } else if (cfg.sx) {
        delete cfg.sx.apiKey;
        cfg.sx.mode = "off";
      }
    } else if (cfg.sx || this.state.sxMode !== "off") {
      cfg.sx = { ...(cfg.sx ?? {}), mode: this.state.sxMode };
    }
    writeTcConfig(cfg);

    if (this.resolvedBin) {
      try {
        if (typeof patch.quotaProbeSeconds === "number") {
          const arg = patch.quotaProbeSeconds <= 0 ? "off" : String(Math.max(30, patch.quotaProbeSeconds));
          await this.runCli(this.resolvedBin, ["probe", arg]).catch(() => undefined);
        }
        if (typeof patch.warmupSeconds === "number") {
          const arg = patch.warmupSeconds <= 0 ? "off" : String(Math.max(60, patch.warmupSeconds));
          await this.runCli(this.resolvedBin, ["warmup", arg]).catch(() => undefined);
        }
      } catch {
        /* best-effort */
      }
    }

    if (!this.state.enabled) {
      if (wasEnabled) {
        await this.stopProxy();
      }
      this.lastError = undefined;
    } else if (!this.resolvedBin) {
      this.lastError = "TeamClaude is not installed.";
    } else {
      await this.syncProxyAfterConfigChange({ restart: wasEnabled });
    }
    this.emitChanged();
    return this.status();
  }

  /**
   * Env injected into new Claude Code sessions when the addon is enabled.
   * Throws SessionError-style message if enabled but unhealthy.
   */
  async resolveClaudeLaunchEnv(): Promise<ClaudeLaunchEnv | null> {
    if (!this.state.enabled) return null;
    if (!this.resolvedBin) {
      throw new TeamClaudeError("TeamClaude is enabled but not installed. Install it from Settings → Addons.");
    }
    if (!this.isRunning()) {
      await this.ensureRunning();
    }
    const cfg = readOrCreateTcConfig(this.state.port);
    const port = this.state.port || cfg?.proxy?.port || 3456;
    const apiKey = cfg?.proxy?.apiKey;
    if (!apiKey) {
      throw new TeamClaudeError(
        "TeamClaude is enabled but has no proxy API key yet. Re-enable TeamClaude or add an account."
      );
    }
    if (!hasUsableAccount(cfg)) {
      throw new TeamClaudeError("TeamClaude is enabled but has no usable accounts. Add or enable a TeamClaude account.");
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

  async importCredentials(from?: string, content?: string): Promise<TeamClaudeStatus> {
    const bin = this.requireBin();
    if (content !== undefined) {
      if (from?.trim()) {
        throw new TeamClaudeError("Choose either an uploaded credentials file or a daemon-host path, not both.");
      }
      if (!content.trim()) {
        throw new TeamClaudeError("Uploaded credentials file is empty.");
      }
      try {
        JSON.parse(content);
      } catch {
        throw new TeamClaudeError("Uploaded file is not valid JSON.");
      }
      const tmpDir = mkdtempSync(join(tmpdir(), "orquester-tc-creds-"));
      const tmpPath = join(tmpDir, `${randomUUID()}.json`);
      try {
        writeFileSync(tmpPath, content, { encoding: "utf8", mode: 0o600 });
        try {
          chmodSync(tmpPath, 0o600);
        } catch {
          /* ignore */
        }
        await this.runCli(bin, ["import", "--from", tmpPath]);
      } finally {
        try {
          unlinkSync(tmpPath);
        } catch {
          /* ignore */
        }
        try {
          rmSync(tmpDir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }
    } else {
      const args = from ? ["import", "--from", from] : ["import"];
      await this.runCli(bin, args);
    }
    await this.syncProxyAfterConfigChange();
    this.emitChanged();
    return this.status();
  }

  async addApiKey(apiKey: string, name?: string): Promise<TeamClaudeStatus> {
    const trimmed = apiKey.trim();
    if (!trimmed) throw new TeamClaudeError("API key is required.");
    const cfg = readOrCreateTcConfig(this.state.port);
    if (!cfg.accounts) cfg.accounts = [];
    const accountName = name?.trim() || `api-${cfg.accounts.length + 1}`;
    // Remove existing same-name first.
    cfg.accounts = cfg.accounts.filter((a) => a.name !== accountName);
    cfg.accounts.push({
      name: accountName,
      type: "apikey",
      apiKey: trimmed,
      priority: 100,
      disabled: false
    });
    normalizeTcConfigForOrquester(cfg, this.state.port);
    writeTcConfig(cfg);
    await this.syncProxyAfterConfigChange();
    this.emitChanged();
    return this.status();
  }

  async removeAccount(name: string): Promise<TeamClaudeStatus> {
    const bin = this.requireBin();
    await this.runCli(bin, ["remove", name]);
    await this.syncProxyAfterConfigChange();
    this.emitChanged();
    return this.status();
  }

  async setAccountDisabled(name: string, disabled: boolean): Promise<TeamClaudeStatus> {
    const bin = this.requireBin();
    await this.runCli(bin, [disabled ? "disable" : "enable", name]);
    await this.syncProxyAfterConfigChange();
    this.emitChanged();
    return this.status();
  }

  async setPriority(name: string, priority: number): Promise<TeamClaudeStatus> {
    const bin = this.requireBin();
    await this.runCli(bin, ["priority", name, String(priority)]);
    await this.syncProxyAfterConfigChange();
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
    await this.stopRecordedProxy();
    // Ensure a config exists with our preferred port before spawning.
    const cfg = readOrCreateTcConfig(this.state.port);
    cfg.proxy = { ...(cfg.proxy ?? {}), port: this.state.port, host: "127.0.0.1" };
    cfg.switchThreshold = this.state.switchThreshold;
    cfg.quotaProbeSeconds = this.state.quotaProbeSeconds;
    cfg.warmupSeconds = this.state.warmupSeconds;
    cfg.autoUpdate = this.state.autoUpdate;
    cfg.upstream = this.state.upstream;
    cfg.stormRamp = this.state.stormRamp;
    if (cfg.sx || this.state.sxMode !== "off") {
      cfg.sx = { ...(cfg.sx ?? {}), mode: this.state.sxMode };
    }
    writeTcConfig(cfg);

    const env = teamclaudeProcessEnv(this.state.autoUpdate ? "0" : "1");

    const child = spawn(bin, ["server", "--headless"], {
      env,
      stdio: ["ignore", "ignore", "pipe"],
      detached: false
    });
    this.child = child;
    this.writePid(child.pid);
    let stderr = "";
    child.stderr?.on("data", (buf: Buffer) => {
      stderr = (stderr + buf.toString("utf8")).slice(-4000);
    });
    child.on("exit", (code) => {
      this.unlinkPid(child.pid);
      if (this.child === child) {
        this.child = null;
        if (this.state.enabled) {
          this.lastError = sanitizeErrorText(
            `TeamClaude proxy exited (code ${code ?? "?"})${stderr ? `: ${stderr.slice(-200)}` : ""}`
          );
          this.emitChanged();
        }
      }
    });

    // Wait until TeamClaude's own control surface answers or we time out.
    const port = this.state.port;
    const deadline = Date.now() + 15_000;
    try {
      while (Date.now() < deadline) {
        if (!this.isRunning()) {
          throw new TeamClaudeError(
            sanitizeErrorText(`TeamClaude proxy failed to start${stderr ? `: ${stderr.slice(-300)}` : "."}`)
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
    } catch (error) {
      await this.stopProxy();
      throw error;
    }
  }

  private async stopProxy(): Promise<void> {
    const child = this.child;
    this.child = null;
    if (!child) return;
    if (child.killed) {
      this.unlinkPid(child.pid);
      return;
    }
    if (child.exitCode !== null) {
      this.unlinkPid(child.pid);
      return;
    }
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
    this.unlinkPid(child.pid);
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

  private async syncProxyAfterConfigChange(opts: { restart?: boolean } = {}): Promise<void> {
    if (!this.state.enabled) {
      await this.tellReload().catch(() => undefined);
      return;
    }
    try {
      if (opts.restart) {
        await this.stopProxy();
      }
      if (this.isRunning()) {
        await this.tellReload().catch(() => undefined);
      } else {
        await this.ensureRunning();
      }
      this.lastError = undefined;
    } catch (err) {
      this.lastError = sanitizeErrorText(err instanceof Error ? err.message : String(err));
    }
  }

  private writePid(pid: number | undefined): void {
    if (!pid) return;
    try {
      writeFileSync(this.pidPath, `${pid}\n`, { encoding: "utf8", mode: 0o600 });
      chmodSync(this.pidPath, 0o600);
    } catch {
      /* pid tracking is best-effort */
    }
  }

  private unlinkPid(pid: number | undefined): void {
    try {
      const recorded = Number(readFileSync(this.pidPath, "utf8").trim());
      if (pid && recorded !== pid) return;
      unlinkSync(this.pidPath);
    } catch {
      /* already absent */
    }
  }

  private async stopRecordedProxy(): Promise<void> {
    let pid = 0;
    try {
      pid = Number(readFileSync(this.pidPath, "utf8").trim());
    } catch {
      return;
    }
    if (!Number.isInteger(pid) || pid <= 0) {
      this.unlinkPid(undefined);
      return;
    }
    if (!isLikelyTeamClaudePid(pid)) {
      this.unlinkPid(pid);
      return;
    }
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      this.unlinkPid(pid);
      return;
    }
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      if (!pidAlive(pid)) {
        this.unlinkPid(pid);
        return;
      }
      await sleep(100);
    }
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
    this.unlinkPid(pid);
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
        void (async () => {
          await this.detectVersion();
          await this.syncProxyAfterConfigChange({ restart: this.state.enabled });
        })().finally(() => this.emitChanged());
      } else {
        this.installState = "error";
        this.installError = sanitizeErrorText(result.output).slice(-4000);
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
    try {
      const { stdout, stderr } = await execAsync(`"${bin}" ${args.map(shellQuote).join(" ")}`, {
        timeout,
        maxBuffer: 4 * 1024 * 1024,
        env: teamclaudeProcessEnv("1")
      });
      return `${stdout ?? ""}${stderr ?? ""}`;
    } catch (error) {
      throw new TeamClaudeError(commandErrorMessage(error));
    }
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
    exec(
      command,
      { timeout: 10 * 60_000, maxBuffer: 8 * 1024 * 1024, env: teamclaudeProcessEnv("1") },
      (error, stdout, stderr) => {
        const output = sanitizeErrorText(`${stdout ?? ""}${stderr ?? ""}`).slice(0, 64_000);
        resolve({ ok: !error, output });
      }
    );
  });
}

function teamclaudeProcessEnv(disableAutoUpdate: "0" | "1"): NodeJS.ProcessEnv {
  const base = sessionEnvBase();
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (SAFE_CHILD_ENV_KEYS.has(key)) {
      env[key] = value;
    }
  }
  env.CI = "1";
  env.PATH = sessionPath();
  env.TEAMCLAUDE_CONFIG = teamclaudeUserConfigPath();
  env.TEAMCLAUDE_DISABLE_AUTOUPDATE = disableAutoUpdate;
  return env;
}

function commandErrorMessage(error: unknown): string {
  const err = error as { stdout?: unknown; stderr?: unknown; message?: unknown } | null;
  const parts = [
    typeof err?.stdout === "string" ? err.stdout : "",
    typeof err?.stderr === "string" ? err.stderr : "",
    typeof err?.message === "string" ? err.message : ""
  ].filter(Boolean);
  return sanitizeErrorText(parts.join("\n") || "TeamClaude command failed.").slice(-4000);
}

function secretValues(): string[] {
  const cfg = readTcConfig();
  const values: string[] = [];
  const push = (value: unknown) => {
    if (typeof value === "string" && value.length >= 8) values.push(value);
  };
  push(cfg?.proxy?.apiKey);
  push(cfg?.sx?.apiKey);
  for (const account of cfg?.accounts ?? []) {
    push(account.accessToken);
    push(account.refreshToken);
    push(account.apiKey);
  }
  for (const [key, value] of Object.entries(process.env)) {
    if (!value || value.length < 8) continue;
    if (key.startsWith("ORQUESTER_") || /TOKEN|PASSWORD|SECRET|API[_-]?KEY|AUTH/i.test(key)) {
      values.push(value);
    }
  }
  return values;
}

function sanitizeErrorText(input: string): string {
  let output = input;
  for (const value of secretValues()) {
    output = output.split(value).join("[redacted]");
  }
  return output
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi, "$1[redacted]")
    .replace(
      /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\s*[:=]\s*)["']?[^"'\s,}]{8,}/gi,
      "$1[redacted]"
    );
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isLikelyTeamClaudePid(pid: number): boolean {
  if (!pidAlive(pid)) return false;
  if (process.platform === "win32") return true;
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").toLowerCase().includes("teamclaude");
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function probeLocal(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/teamclaude/status`, {
      signal: AbortSignal.timeout(1500)
    });
    if (!res.ok) return false;
    const parsed = (await res.json().catch(() => null)) as unknown;
    if (!parsed || typeof parsed !== "object") return false;
    const root = parsed as Record<string, unknown>;
    const server = root.server;
    if (!server || typeof server !== "object") return false;
    const portValue = (server as Record<string, unknown>).port;
    return portValue === port;
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
