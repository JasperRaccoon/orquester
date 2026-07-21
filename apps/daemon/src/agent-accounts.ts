import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile, readFile, rm, chmod } from "node:fs/promises";
import { dirname, join, isAbsolute } from "node:path";
import type { AgentAccount, AgentAccountsResponse } from "@orquester/api";
import {
  parseAgentAccounts,
  createDefaultAgentAccounts,
  type AgentAccountRecord,
  type AgentAccountsIndex
} from "@orquester/config";
import { assertOwnedAccountHome, AgentAccountError, ACCOUNT_MARKER } from "./agent-account-paths.ts";
import { detectAgentFromBlob, claudePlanFromBlob, parseCodexIdentity } from "./agent-account-identity.ts";

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

  async resolveLaunchEnv(
    agent: string,
    accountId?: string
  ): Promise<{ env: Record<string, string>; unset?: string[] } | null> {
    if (agent !== "claude" && agent !== "codex") return null;
    const id = accountId ?? this.index.defaults[agent] ?? null;
    if (!id) return null;
    const record = this.getRecord(id);
    if (!record || record.agent !== agent) return null;
    const home = this.homePath(agent, id);
    await assertOwnedAccountHome(this.opts.accountsDir, agent, id, home);
    if (agent === "claude") {
      return { env: { CLAUDE_CONFIG_DIR: home }, unset: [...CLAUDE_AUTH_ENV_UNSET] };
    }
    return { env: { CODEX_HOME: home } };
  }

  async markNeedsReauth(id: string, value: boolean): Promise<void> {
    const record = this.getRecord(id);
    if (!record || record.needsReauth === value) return;
    record.needsReauth = value;
    await this.persist();
    this.emitChanged();
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
