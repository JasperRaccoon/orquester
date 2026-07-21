import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile, readFile, readFile as fsReadFile, rm, chmod } from "node:fs/promises";
import { dirname, join, isAbsolute } from "node:path";
import { SYSTEM_ACCOUNT_ID, type AgentAccount, type AgentAccountsResponse } from "@orquester/api";
import {
  parseAgentAccounts,
  createDefaultAgentAccounts,
  type AgentAccountRecord,
  type AgentAccountsIndex
} from "@orquester/config";
import { assertOwnedAccountHome, AgentAccountError, ACCOUNT_MARKER } from "./agent-account-paths.ts";
import { detectAgentFromBlob, claudePlanFromBlob, parseCodexIdentity } from "./agent-account-identity.ts";
import {
  REFRESH_INTERVAL_MS,
  REFRESH_MARGIN_MS,
  selectAccountsToRefresh,
  mergeClaudeRefreshedCreds,
  refreshClaudeToken
} from "./agent-account-refresh.ts";

export const CLAUDE_AUTH_ENV_UNSET = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"];

const CRED_FILENAME = { claude: ".credentials.json", codex: "auth.json" } as const;

export interface AgentAccountsOptions {
  indexFile: string;
  accountsDir: string;
  now: () => number;
  logger?: Pick<Console, "warn">;
}

export class AgentAccountsService {
  readonly events = new EventEmitter();
  private index: AgentAccountsIndex = createDefaultAgentAccounts();
  private refreshTimer?: ReturnType<typeof setInterval>;

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
    if (agent === "claude") {
      return { env: { CLAUDE_CONFIG_DIR: home }, unset: [...CLAUDE_AUTH_ENV_UNSET], accountId: id };
    }
    return { env: { CODEX_HOME: home }, accountId: id };
  }

  async markNeedsReauth(id: string, value: boolean): Promise<void> {
    const record = this.getRecord(id);
    if (!record || record.needsReauth === value) return;
    record.needsReauth = value;
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

  private async readClaudeExpiry(id: string): Promise<number | null> {
    try {
      const creds = JSON.parse(await fsReadFile(join(this.homePath("claude", id), ".credentials.json"), "utf8"));
      const exp = creds?.claudeAiOauth?.expiresAt;
      return typeof exp === "number" ? exp : null;
    } catch {
      return null;
    }
  }

  private async refreshIdleAccounts(live: Set<string>): Promise<void> {
    const now = this.opts.now();
    const expiries = new Map<string, number | null>();
    for (const a of this.index.accounts) {
      // Only Claude self-refreshes here; Codex is left to its CLI (see spec 1.5).
      expiries.set(a.id, a.agent === "claude" ? await this.readClaudeExpiry(a.id) : now + REFRESH_INTERVAL_MS * 10);
    }
    const due = selectAccountsToRefresh(this.index.accounts, live, expiries, now, REFRESH_MARGIN_MS).filter(
      (a) => a.agent === "claude"
    );
    for (const acct of due) {
      const home = this.homePath("claude", acct.id);
      await assertOwnedAccountHome(this.opts.accountsDir, "claude", acct.id, home);
      const credsPath = join(home, ".credentials.json");
      let creds: any;
      try {
        creds = JSON.parse(await fsReadFile(credsPath, "utf8"));
      } catch {
        continue;
      }
      const refreshToken = creds?.claudeAiOauth?.refreshToken;
      if (typeof refreshToken !== "string") continue;
      const out = await refreshClaudeToken(refreshToken);
      if (out.ok) {
        await writeFile(credsPath, JSON.stringify(mergeClaudeRefreshedCreds(creds, out)), { mode: 0o600 });
        if (acct.needsReauth) await this.markNeedsReauth(acct.id, false);
      } else if (out.invalidGrant) {
        await this.markNeedsReauth(acct.id, true);
      }
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
