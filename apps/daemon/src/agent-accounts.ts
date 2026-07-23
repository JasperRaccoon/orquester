import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile, readFile, readFile as fsReadFile, rm, chmod, symlink, lstat, readlink, readdir, rename, copyFile } from "node:fs/promises";
import { dirname, join, isAbsolute } from "node:path";
import { SYSTEM_ACCOUNT_ID, type AgentAccount, type AgentAccountsResponse } from "@orquester/api";
import {
  parseAgentAccounts,
  createDefaultAgentAccounts,
  type AgentAccountRecord,
  type AgentAccountsIndex
} from "@orquester/config";
import { assertOwnedAccountHome, AgentAccountError, ACCOUNT_MARKER } from "./agent-account-paths.ts";
import { detectAgentFromBlob, claudePlanFromBlob, parseCodexIdentity, decodeJwtPayload } from "./agent-account-identity.ts";
import {
  REFRESH_INTERVAL_MS,
  REFRESH_MARGIN_MS,
  selectAccountsToRefresh,
  mergeClaudeRefreshedCreds,
  refreshClaudeToken,
  mergeCodexRefreshedTokens,
  refreshCodexToken
} from "./agent-account-refresh.ts";

export const CLAUDE_AUTH_ENV_UNSET = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"];
// A stray host OPENAI_API_KEY makes codex bill the API instead of the managed
// ChatGPT account; strip it so file-based (auth.json) sign-in wins.
export const CODEX_AUTH_ENV_UNSET = ["OPENAI_API_KEY"];

const CRED_FILENAME = { claude: ".credentials.json", codex: "auth.json" } as const;

export interface AgentAccountsOptions {
  indexFile: string;
  accountsDir: string;
  /** Daemon HOME — the source of the shared Claude/Codex config seeded into homes. */
  userhome: string;
  now: () => number;
  logger?: Pick<Console, "warn">;
  /** Injectable for tests; defaults to the global fetch inside the refresh calls. */
  fetchImpl?: typeof fetch;
}

export class AgentAccountsService {
  readonly events = new EventEmitter();
  private index: AgentAccountsIndex = createDefaultAgentAccounts();
  private refreshTimer?: ReturnType<typeof setInterval>;
  /** Account ids with an in-flight refresh, so the hourly loop and the usage
   *  path never double-spend one account's single-use refresh token. */
  private refreshing = new Set<string>();

  constructor(private readonly opts: AgentAccountsOptions) {}

  async init(): Promise<void> {
    await mkdir(this.opts.accountsDir, { recursive: true });
    try {
      this.index = parseAgentAccounts(JSON.parse(await readFile(this.opts.indexFile, "utf8")));
    } catch {
      this.index = createDefaultAgentAccounts();
    }
  }

  list(): AgentAccountsResponse {
    return {
      accounts: this.index.accounts.map(toApi),
      defaults: { ...this.index.defaults }
    };
  }

  getRecord(id: string): AgentAccountRecord | undefined {
    return this.index.accounts.find((a) => a.id === id);
  }

  homePath(agent: string, id: string): string {
    return join(this.opts.accountsDir, agent, id, "home");
  }

  async importAccount(input: { content?: string; from?: string; label?: string }): Promise<AgentAccount> {
    const raw = await this.readBlob(input);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new AgentAccountError("Credential file is not valid JSON.");
    }
    const agent = detectAgentFromBlob(parsed);
    if (!agent) {
      throw new AgentAccountError("Unrecognized credential file (expected Claude .credentials.json or Codex auth.json).");
    }

    let label: string;
    let email: string | null = null;
    let plan: string | null = null;
    if (agent === "codex") {
      const idn = parseCodexIdentity(parsed);
      email = idn.email;
      label = input.label?.trim() || idn.email || "Codex account";
    } else {
      if (!input.label?.trim()) {
        throw new AgentAccountError("A label is required for Claude accounts (the credentials file has no email).");
      }
      label = input.label.trim();
      plan = claudePlanFromBlob(parsed);
    }

    const id = randomUUID();
    const home = this.homePath(agent, id);
    await mkdir(home, { recursive: true });
    await chmod(home, 0o700);
    await writeFile(join(home, ACCOUNT_MARKER), id, { mode: 0o600 });
    await assertOwnedAccountHome(this.opts.accountsDir, agent, id, home);
    await writeFile(join(home, CRED_FILENAME[agent]), raw, { mode: 0o600 });

    const nowIso = new Date(this.opts.now()).toISOString();
    const record: AgentAccountRecord = {
      id,
      agent,
      label,
      email,
      plan,
      needsReauth: false,
      createdAt: nowIso,
      importedAt: nowIso
    };
    this.index.accounts.push(record);
    if (this.index.defaults[agent] == null) this.index.defaults[agent] = id;
    await this.persist();
    this.emitChanged();
    return toApi(record);
  }

  async removeAccount(id: string): Promise<void> {
    const record = this.getRecord(id);
    if (!record) return;
    const home = this.homePath(record.agent, id);
    // Ownership-assert before rm so a swapped/symlinked dir can't redirect the delete.
    await assertOwnedAccountHome(this.opts.accountsDir, record.agent, id, home).catch(() => {
      throw new AgentAccountError(`Refusing to remove unverified account home: ${id}`);
    });
    await rm(join(this.opts.accountsDir, record.agent, id), { recursive: true, force: true });
    this.index.accounts = this.index.accounts.filter((a) => a.id !== id);
    if (this.index.defaults[record.agent] === id) this.index.defaults[record.agent] = null;
    await this.persist();
    this.emitChanged();
  }

  async setDefaults(patch: { claude?: string | null; codex?: string | null }): Promise<AgentAccountsResponse> {
    for (const agent of ["claude", "codex"] as const) {
      if (!(agent in patch)) continue;
      const value = patch[agent] ?? null;
      if (value !== null && !this.index.accounts.some((a) => a.id === value && a.agent === agent)) {
        throw new AgentAccountError(`No ${agent} account with id ${value}`);
      }
      this.index.defaults[agent] = value;
    }
    await this.persist();
    this.emitChanged();
    return this.list();
  }

  /**
   * Resolve the credential-home env for a launch AND the EFFECTIVE account id it
   * pins (explicit selection → per-agent default). The caller records that
   * effective id on the session so liveAccountIds() reflects the account actually
   * in use — a session riding the default must not look idle to the refresher.
   * Returns null (inherit $HOME, no pin) for a non-managed agent, an explicit
   * System launch (SYSTEM_ACCOUNT_ID sentinel — bypasses the default), or when no
   * account resolves.
   */
  async resolveLaunchEnv(
    agent: string,
    accountId?: string
  ): Promise<{ env: Record<string, string>; unset?: string[]; accountId: string } | null> {
    if (agent !== "claude" && agent !== "codex") return null;
    if (accountId === SYSTEM_ACCOUNT_ID) return null;
    const id = accountId ?? this.index.defaults[agent] ?? null;
    if (!id) return null;
    const record = this.getRecord(id);
    if (!record || record.agent !== agent) return null;
    const home = this.homePath(agent, id);
    await assertOwnedAccountHome(this.opts.accountsDir, agent, id, home);
    // A bare home (only credentials) is seen as a fresh install: Claude/Codex read
    // onboarding flags, MCP servers, skills/plugins and settings relative to
    // CLAUDE_CONFIG_DIR/CODEX_HOME. Seed the shared, non-credential config from the
    // system home so managed sessions keep them. Best-effort — never block a launch.
    await this.syncAccountHome(agent, home).catch((e) =>
      this.opts.logger?.warn?.(`account home sync failed for ${agent}/${id}: ${String(e)}`)
    );
    if (agent === "claude") {
      return { env: { CLAUDE_CONFIG_DIR: home }, unset: [...CLAUDE_AUTH_ENV_UNSET], accountId: id };
    }
    return { env: { CODEX_HOME: home }, unset: [...CODEX_AUTH_ENV_UNSET], accountId: id };
  }

  /** System config sources (the daemon's own HOME). The `.claude.json` file sits
   *  at HOME level unless CLAUDE_CONFIG_DIR relocates it into the config dir. */
  private systemClaudeConfigFile(): string {
    const dir = process.env.CLAUDE_CONFIG_DIR;
    return dir ? join(dir, ".claude.json") : join(this.opts.userhome, ".claude.json");
  }
  private systemClaudeDir(): string {
    return process.env.CLAUDE_CONFIG_DIR || join(this.opts.userhome, ".claude");
  }
  private systemCodexHome(): string {
    return process.env.CODEX_HOME || join(this.opts.userhome, ".codex");
  }

  private async syncAccountHome(agent: "claude" | "codex", home: string): Promise<void> {
    if (agent === "claude") {
      await this.seedClaudeConfig(home);
      await this.ensureSymlink(join(this.systemClaudeDir(), "skills"), join(home, "skills"));
      await this.ensureSymlink(join(this.systemClaudeDir(), "plugins"), join(home, "plugins"));
      // settings.json (user hooks + permissions + the daemon's managed hook) is
      // account-agnostic — the managed hook command is identical for every home —
      // so share one file. The daemon's hook installer writes THROUGH the symlink
      // (writeFileAtomic realpaths its target), keeping the share intact.
      await this.ensureSharedFileSymlink(join(this.systemClaudeDir(), "settings.json"), join(home, "settings.json"));
      // Conversation history lives in projects/ — share it so every account sees
      // (and appends to) the same "resume session" list.
      await this.ensureSharedDirSymlink(join(this.systemClaudeDir(), "projects"), join(home, "projects"));
    } else {
      // config.toml (MCPs, model defaults, project trust) and hooks.json hold no
      // identity — auth.json carries that — so share them live. Both are written
      // by the daemon's hook installer, which follows the symlink.
      await this.ensureSharedFileSymlink(join(this.systemCodexHome(), "config.toml"), join(home, "config.toml"));
      await this.ensureSharedFileSymlink(join(this.systemCodexHome(), "hooks.json"), join(home, "hooks.json"));
      await this.ensureSharedDirSymlink(join(this.systemCodexHome(), "sessions"), join(home, "sessions"));
      for (const marker of [".personality_migration", ".sandbox_migration"]) {
        await this.copyIfMissing(join(this.systemCodexHome(), marker), join(home, marker));
      }
    }
  }

  /** Share a conversation-history DIR (Claude projects/, Codex sessions/). If the
   *  home already has its own, best-effort merge its contents into the shared store
   *  (moving only entries the store lacks), then replace it with the symlink. */
  private async ensureSharedDirSymlink(target: string, linkPath: string): Promise<void> {
    try {
      await lstat(target);
    } catch {
      return; // no shared store yet
    }
    let st: Awaited<ReturnType<typeof lstat>> | null = null;
    try {
      st = await lstat(linkPath);
    } catch {
      /* absent */
    }
    if (st) {
      if (st.isSymbolicLink()) {
        if ((await readlink(linkPath).catch(() => null)) === target) return; // already shared
        await rm(linkPath, { force: true }).catch(() => undefined);
      } else if (st.isDirectory()) {
        await this.mergeInto(linkPath, target);
        if ((await readdir(linkPath).catch(() => ["x"])).length > 0) return; // un-mergeable leftovers — leave as-is
        await rm(linkPath, { recursive: true, force: true }).catch(() => undefined);
      } else {
        return; // a regular file where a dir is expected — leave it
      }
    }
    await symlink(target, linkPath).catch((e) => this.opts.logger?.warn?.(`shared dir symlink ${linkPath} failed: ${String(e)}`));
  }

  /** Seed `<home>/.claude.json`. First seed copies the system config minus identity
   *  (oauthAccount/userID) with onboarding forced true; later launches only refresh
   *  the MCP list, preserving the identity/state Claude has since written. */
  private async seedClaudeConfig(home: string): Promise<void> {
    let sys: any;
    try {
      sys = JSON.parse(await fsReadFile(this.systemClaudeConfigFile(), "utf8"));
    } catch {
      return; // no system config to seed from
    }
    const homeFile = join(home, ".claude.json");
    let existing: any = null;
    try {
      existing = JSON.parse(await fsReadFile(homeFile, "utf8"));
    } catch {
      /* first seed */
    }
    let next: any;
    if (!existing || Object.keys(existing).length === 0) {
      next = { ...sys };
      delete next.oauthAccount;
      delete next.userID;
      next.hasCompletedOnboarding = true;
    } else {
      next = { ...existing, mcpServers: sys.mcpServers ?? existing.mcpServers ?? {}, hasCompletedOnboarding: true };
    }
    const serialized = JSON.stringify(next);
    if (JSON.stringify(existing) === serialized) return; // idempotent: no write churn
    await writeFile(homeFile, serialized, { mode: 0o600 });
  }

  private async ensureSymlink(target: string, linkPath: string): Promise<void> {
    try {
      await lstat(linkPath);
      return; // already present (symlink or real dir) — leave it
    } catch {
      /* not present */
    }
    try {
      await lstat(target); // only link to something that exists
    } catch {
      return;
    }
    await symlink(target, linkPath).catch((e) => this.opts.logger?.warn?.(`symlink ${linkPath} failed: ${String(e)}`));
  }

  /** Recursively move everything from `src` into `dst`: move whole entries the
   *  store lacks, and for a directory that exists on both sides recurse so
   *  differently-named session files inside a shared project dir all land in the
   *  store. A same-named file (same session id ⇒ a duplicate) is left in the store
   *  and its src copy dropped, so `src` ends up empty and can become the symlink. */
  private async mergeInto(src: string, dst: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(src, { withFileTypes: true });
    } catch {
      return;
    }
    await mkdir(dst, { recursive: true }).catch(() => undefined);
    for (const e of entries) {
      const s = join(src, e.name);
      const d = join(dst, e.name);
      let dStat: Awaited<ReturnType<typeof lstat>> | null = null;
      try {
        dStat = await lstat(d);
      } catch {
        /* absent in the store */
      }
      if (!dStat) {
        await rename(s, d).catch(() => undefined); // move the whole entry
      } else if (e.isDirectory() && dStat.isDirectory()) {
        await this.mergeInto(s, d); // recurse into a colliding dir
        await rm(s, { recursive: true, force: true }).catch(() => undefined); // drop the now-duplicate-only subtree
      }
      // else: file/type collision (duplicate) → keep the store's, drop nothing here
    }
  }

  /** Like ensureSymlink, but for daemon-written shared config FILES (settings.json,
   *  config.toml, hooks.json): replace a stale regular file or wrong symlink so the
   *  home always points at the single shared source. Never touches a directory. */
  private async ensureSharedFileSymlink(target: string, linkPath: string): Promise<void> {
    try {
      await lstat(target);
    } catch {
      return; // no system file to share yet
    }
    let st: Awaited<ReturnType<typeof lstat>> | null = null;
    try {
      st = await lstat(linkPath);
    } catch {
      /* absent */
    }
    if (st) {
      if (st.isSymbolicLink() && (await readlink(linkPath).catch(() => null)) === target) return; // already correct
      if (st.isDirectory()) return; // never replace a directory
      await rm(linkPath, { force: true }).catch(() => undefined);
    }
    await symlink(target, linkPath).catch((e) => this.opts.logger?.warn?.(`shared symlink ${linkPath} failed: ${String(e)}`));
  }

  private async copyIfMissing(src: string, dst: string): Promise<void> {
    try {
      await lstat(dst);
      return;
    } catch {
      /* missing */
    }
    await copyFile(src, dst).catch(() => undefined); // src may not exist — fine
  }

  async markNeedsReauth(id: string, value: boolean): Promise<void> {
    const record = this.getRecord(id);
    if (!record || record.needsReauth === value) return;
    record.needsReauth = value;
    await this.persist();
    this.emitChanged();
  }

  /** Record whether the CLIProxyAPI proxy owns this account's token refresh. While
   *  `owned`, the account service must not refresh it (the proxy is the single
   *  refresher — two refreshers of one rotating token invalidate each other).
   *  Un-owning restores Orquester's refresh responsibility. */
  async markProxyOwned(id: string, owned: boolean): Promise<void> {
    const record = this.getRecord(id);
    if (!record || (record.proxyOwned ?? false) === owned) return;
    record.proxyOwned = owned;
    await this.persist();
    this.emitChanged();
  }

  startRefresher(getLiveAccountIds: () => Set<string>): void {
    if (this.refreshTimer) return;
    const run = () => void this.refreshIdleAccounts(getLiveAccountIds()).catch((e) => this.opts.logger?.warn?.(`account refresh failed: ${String(e)}`));
    this.refreshTimer = setInterval(run, REFRESH_INTERVAL_MS);
    this.refreshTimer.unref?.();
    run(); // once on start (after reattach, callers pass current live ids)
  }

  stopRefresher(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = undefined;
  }

  /** Access-token expiry in unix ms, or null if unknown. Claude stores it in
   *  `.credentials.json`; Codex embeds it in the access-token JWT `exp` (seconds). */
  private async readExpiry(agent: "claude" | "codex", id: string): Promise<number | null> {
    try {
      const home = this.homePath(agent, id);
      if (agent === "claude") {
        const creds = JSON.parse(await fsReadFile(join(home, ".credentials.json"), "utf8"));
        const exp = creds?.claudeAiOauth?.expiresAt;
        return typeof exp === "number" ? exp : null;
      }
      const auth = JSON.parse(await fsReadFile(join(home, "auth.json"), "utf8"));
      const claims = typeof auth?.tokens?.access_token === "string" ? decodeJwtPayload(auth.tokens.access_token) : null;
      const exp = claims?.exp;
      return typeof exp === "number" ? exp * 1000 : null;
    } catch {
      return null;
    }
  }

  /** Refresh one managed account's OAuth token and persist it in place. De-duped
   *  per account so two callers can't spend the same single-use refresh token. */
  private async refreshAccount(agent: "claude" | "codex", id: string): Promise<void> {
    if (this.refreshing.has(id)) return;
    this.refreshing.add(id);
    try {
      const record = this.getRecord(id);
      if (!record || record.agent !== agent) return;
      // Owner rule: the proxy is the sole refresher for a seeded (proxy-owned)
      // account. Skip so two refreshers can't invalidate the same rotating token.
      if (record.proxyOwned) return;
      const home = this.homePath(agent, id);
      await assertOwnedAccountHome(this.opts.accountsDir, agent, id, home);
      const credsPath = join(home, CRED_FILENAME[agent]);
      let creds: any;
      try {
        creds = JSON.parse(await fsReadFile(credsPath, "utf8"));
      } catch {
        return;
      }
      if (agent === "claude") {
        const refreshToken = creds?.claudeAiOauth?.refreshToken;
        if (typeof refreshToken !== "string") return;
        const out = await refreshClaudeToken(refreshToken, this.opts.fetchImpl);
        if (out.ok) {
          await writeFile(credsPath, JSON.stringify(mergeClaudeRefreshedCreds(creds, out, this.opts.now())), { mode: 0o600 });
          if (record.needsReauth) await this.markNeedsReauth(id, false);
        } else if (out.invalidGrant) {
          await this.markNeedsReauth(id, true);
        }
      } else {
        const refreshToken = creds?.tokens?.refresh_token;
        if (typeof refreshToken !== "string") return;
        const out = await refreshCodexToken(refreshToken, this.opts.fetchImpl);
        if (out.ok) {
          await writeFile(credsPath, JSON.stringify(mergeCodexRefreshedTokens(creds, out)), { mode: 0o600 });
          if (record.needsReauth) await this.markNeedsReauth(id, false);
        } else if (out.invalidGrant) {
          await this.markNeedsReauth(id, true);
        }
      }
    } finally {
      this.refreshing.delete(id);
    }
  }

  /** Refresh-and-persist before displaying an idle account's usage, so viewing a
   *  rarely-used account never strands an expiring token. Accounts with a live
   *  session are left to their own CLI (that's the single-use-token race gate). */
  async ensureFreshForUsage(agent: "claude" | "codex", id: string, live: Set<string>): Promise<void> {
    // `live` is a snapshot: a session could start for this account during the
    // refresh below and its CLI could rotate the same single-use refresh token.
    // The window is sub-second; worst case one side gets invalid_grant and the
    // account is flagged needsReauth (recoverable by re-import), not silent data
    // loss. The intra-daemon `refreshing` guard covers the common case.
    if (live.has(id)) return;
    const record = this.getRecord(id);
    if (!record || record.agent !== agent) return;
    const exp = await this.readExpiry(agent, id);
    if (exp != null && exp > this.opts.now() + REFRESH_MARGIN_MS) return;
    await this.refreshAccount(agent, id);
  }

  private async refreshIdleAccounts(live: Set<string>): Promise<void> {
    const now = this.opts.now();
    const expiries = new Map<string, number | null>();
    for (const a of this.index.accounts) {
      expiries.set(a.id, await this.readExpiry(a.agent, a.id));
    }
    const due = selectAccountsToRefresh(this.index.accounts, live, expiries, now, REFRESH_MARGIN_MS);
    for (const acct of due) {
      await this.refreshAccount(acct.agent, acct.id);
    }
  }

  async persist(): Promise<void> {
    await mkdir(dirname(this.opts.indexFile), { recursive: true });
    await writeFile(this.opts.indexFile, JSON.stringify(this.index, null, 2), { mode: 0o600 });
  }

  private emitChanged(): void {
    this.events.emit("changed", this.list());
  }

  private async readBlob(input: { content?: string; from?: string }): Promise<string> {
    if (input.content !== undefined) {
      if (input.from?.trim()) throw new AgentAccountError("Provide either uploaded content or a host path, not both.");
      if (!input.content.trim()) throw new AgentAccountError("Uploaded credentials file is empty.");
      return input.content;
    }
    if (!input.from?.trim() || !isAbsolute(input.from.trim())) {
      throw new AgentAccountError("A credential file (upload) or an absolute host path is required.");
    }
    return readFile(input.from.trim(), "utf8");
  }
}

function toApi(r: AgentAccountRecord): AgentAccount {
  return {
    id: r.id,
    agent: r.agent,
    label: r.label,
    email: r.email,
    plan: r.plan,
    needsReauth: r.needsReauth,
    createdAt: r.createdAt,
    importedAt: r.importedAt
  };
}
