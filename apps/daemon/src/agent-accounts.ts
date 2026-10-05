import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  writeFile,
  readFile,
  rm,
  chmod,
  symlink,
  lstat,
  stat,
  readlink,
  readdir,
  rename,
  copyFile,
  cp,
  link,
  unlink
} from "node:fs/promises";
import { basename, dirname, extname, join, isAbsolute } from "node:path";
import { SYSTEM_ACCOUNT_ID, type AgentAccount, type AgentAccountsResponse } from "@orquester/api";
import {
  parseAgentAccounts,
  createDefaultAgentAccounts,
  type AgentAccountRecord,
  type AgentAccountsIndex
} from "@orquester/config";
import { assertOwnedAccountHome, AgentAccountError, ACCOUNT_MARKER } from "./agent-account-paths.ts";
import {
  detectAgentFromBlob,
  claudePlanFromBlob,
  claudeBlobHasTokens,
  parseCodexIdentity,
  parseGrokIdentity,
  grokAuthEntry,
  decodeJwtPayload
} from "./agent-account-identity.ts";
import {
  REFRESH_INTERVAL_MS,
  REFRESH_MARGIN_MS,
  selectAccountsToRefresh,
  mergeClaudeRefreshedCreds,
  refreshClaudeToken,
  mergeCodexRefreshedTokens,
  refreshCodexToken,
  mergeGrokRefreshedAuth,
  refreshGrokToken
} from "./agent-account-refresh.ts";

const CLAUDE_AUTH_ENV_UNSET = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"];
// A stray host OPENAI_API_KEY makes codex bill the API instead of the managed
// ChatGPT account; strip it so file-based (auth.json) sign-in wins.
const CODEX_AUTH_ENV_UNSET = ["OPENAI_API_KEY"];
// Same rule for grok: XAI_API_KEY switches the CLI to API billing, beating the
// OAuth login in GROK_HOME/auth.json.
const GROK_AUTH_ENV_UNSET = ["XAI_API_KEY"];

/** An account home's directory name: the UUID `importAccount` mints. */
const ACCOUNT_DIR_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The first file under `src` (relative path) whose namesake under `dst` has
 * different bytes, or null when every shared name holds the same content.
 * Symlinks are not followed.
 */
async function firstDifferingFile(src: string, dst: string, rel = ""): Promise<string | null> {
  const entries = await readdir(join(src, rel), { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const path = join(rel, entry.name);
    const other = await lstat(join(dst, path)).catch(() => null);
    if (other === null) continue;
    if (entry.isDirectory()) {
      if (!other.isDirectory()) return path;
      const nested = await firstDifferingFile(src, dst, path);
      if (nested !== null) return nested;
    } else if (entry.isFile()) {
      if (!other.isFile()) return path;
      const [a, b] = await Promise.all([readFile(join(src, path)), readFile(join(dst, path))]);
      if (!a.equals(b)) return path;
    }
  }
  return null;
}

/** The agent families with managed (per-account HOME) credentials. */
type ManagedAgent = "claude" | "codex" | "grok";

const CRED_FILENAME = { claude: ".credentials.json", codex: "auth.json", grok: "auth.json" } as const;

interface AgentAccountsOptions {
  indexFile: string;
  accountsDir: string;
  /** Daemon HOME — the source of the shared Claude/Codex config seeded into homes. */
  userhome: string;
  now: () => number;
  logger?: Pick<Console, "warn">;
}

export class AgentAccountsService {
  readonly events = new EventEmitter();
  private index: AgentAccountsIndex = createDefaultAgentAccounts();
  private refreshTimer?: ReturnType<typeof setInterval>;
  /** Account ids with an in-flight refresh, so the hourly loop and the usage
   *  path never double-spend one account's single-use refresh token. */
  private refreshing = new Set<string>();
  /** Per agent: the tail of its account-home syncs. Two launches (of one account or of two)
   *  merge into the same shared dirs, so their syncs never interleave. Never rejects. */
  private syncChains = new Map<ManagedAgent, Promise<void>>();

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
    } else if (agent === "grok") {
      const idn = parseGrokIdentity(parsed);
      email = idn.email;
      label = input.label?.trim() || idn.email || "Grok account";
    } else {
      if (!claudeBlobHasTokens(parsed)) {
        throw new AgentAccountError(
          'Claude credential file contains no OAuth tokens (probably a stale or logged-out keychain entry). Log in to Claude Code again, or export with `security find-generic-password -s "Claude Code-credentials" -a "$USER" -w`.'
        );
      }
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

  /**
   * Remove the account homes the index no longer lists.
   *
   * Deleting an account removes its home, but a CLI still running under it
   * writes its next transcript line and so re-creates the path — as a plain
   * directory, not the shared-history link, and with nothing that would ever
   * sync it again (only registered accounts are synced). Such a home showed up
   * in the conversation list as an account that does not exist.
   *
   * Its shared history is first moved into the shared store (only what the
   * store lacks); a home holding a transcript the store has with DIFFERENT
   * content is left alone and reported, never deleted. Homes of accounts a live
   * session still names (`inUse`) are skipped. Answers the paths removed.
   */
  async pruneOrphanHomes(inUse: ReadonlySet<string>): Promise<string[]> {
    const removed: string[] = [];
    const registered = new Set(this.index.accounts.map((a) => a.id));
    for (const agent of ["claude", "codex", "grok"] as const) {
      const familyDir = join(this.opts.accountsDir, agent);
      const names = await readdir(familyDir, { withFileTypes: true }).catch(() => []);
      for (const entry of names) {
        const id = entry.name;
        if (!entry.isDirectory() || registered.has(id) || inUse.has(id) || !ACCOUNT_DIR_NAME.test(id)) {
          continue;
        }
        const dir = join(familyDir, id);
        const run = (this.syncChains.get(agent) ?? Promise.resolve()).then(async () => {
          const shared = this.sharedHistoryDir(agent);
          const own = join(dir, "home", basename(shared));
          const ownStat = await lstat(own).catch(() => null);
          if (ownStat?.isDirectory()) {
            const conflict = await firstDifferingFile(own, shared);
            if (conflict !== null) {
              this.opts.logger?.warn?.(
                `orphan account home ${agent}/${id} kept: ${conflict} differs from the shared copy`
              );
              return;
            }
            await this.mergeInto(own, shared);
          }
          await rm(dir, { recursive: true, force: true });
          removed.push(dir);
        });
        this.syncChains.set(agent, run.catch(() => undefined));
        await run.catch((e) =>
          this.opts.logger?.warn?.(`orphan account home ${agent}/${id} not removed: ${String(e)}`)
        );
      }
    }
    return removed;
  }

  /** The shared conversation-history dir every account home of `agent` links to. */
  private sharedHistoryDir(agent: ManagedAgent): string {
    return agent === "claude"
      ? join(this.systemClaudeDir(), "projects")
      : join(agent === "codex" ? this.systemCodexHome() : this.systemGrokHome(), "sessions");
  }

  async setDefaults(
    patch: { claude?: string | null; codex?: string | null; grok?: string | null }
  ): Promise<AgentAccountsResponse> {
    for (const agent of ["claude", "codex", "grok"] as const) {
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
    if (agent !== "claude" && agent !== "codex" && agent !== "grok") return null;
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
    await this.serializedSync(agent, id, home);
    if (agent === "claude") {
      return { env: { CLAUDE_CONFIG_DIR: home }, unset: [...CLAUDE_AUTH_ENV_UNSET], accountId: id };
    }
    if (agent === "grok") {
      return { env: { GROK_HOME: home }, unset: [...GROK_AUTH_ENV_UNSET], accountId: id };
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
  private systemGrokHome(): string {
    return process.env.GROK_HOME || join(this.opts.userhome, ".grok");
  }

  /**
   * `syncAccountHome`, one at a time per agent: a merge that lists an account's
   * real `commands/` while another sync of the same account turns it into the
   * shared link would read the shared entries through that link and drop them
   * as "duplicates" of themselves, and two accounts moving the same name into
   * the shared dir at once would overwrite each other.
   */
  private serializedSync(agent: ManagedAgent, accountId: string, home: string): Promise<void> {
    const run = (this.syncChains.get(agent) ?? Promise.resolve()).then(() =>
      this.syncAccountHome(agent, accountId, home).catch((e) =>
        this.opts.logger?.warn?.(`account home sync failed for ${agent}/${accountId}: ${String(e)}`)
      )
    );
    this.syncChains.set(agent, run);
    return run;
  }

  private async syncAccountHome(agent: ManagedAgent, accountId: string, home: string): Promise<void> {
    if (agent === "grok") {
      // config.toml carries the critical `[compat.claude] hooks = false` (grok
      // reads Claude-compat surfaces via $HOME, and double-reporting hooks would
      // corrupt session status) plus the enabled-plugins list; trusted_folders
      // keeps the workspace pre-trusted. Both are user/daemon-written and
      // identity-free — share them, like codex's config.toml.
      await this.ensureSharedFileSymlink(join(this.systemGrokHome(), "config.toml"), join(home, "config.toml"));
      await this.ensureSharedFileSymlink(
        join(this.systemGrokHome(), "trusted_folders.toml"),
        join(home, "trusted_folders.toml")
      );
      // Hook script, plugins and skills are account-agnostic; the daemon's hook
      // installer writes through the symlink, keeping the share intact.
      await this.ensureSymlink(join(this.systemGrokHome(), "hooks"), join(home, "hooks"));
      await this.ensureSymlink(join(this.systemGrokHome(), "plugins"), join(home, "plugins"));
      await this.ensureSymlink(join(this.systemGrokHome(), "skills"), join(home, "skills"));
      // Conversation history — every account sees the same resume list.
      await this.ensureSharedDirSymlink(join(this.systemGrokHome(), "sessions"), join(home, "sessions"));
      // Agent profile §5: the global instruction file, slash commands and rules
      // are the owner's and account-agnostic — one copy, edited once, loaded by
      // every account. (`agents/` is deliberately not shared: out of scope.)
      await this.ensureSharedUserFileSymlink(join(this.systemGrokHome(), "AGENTS.md"), join(home, "AGENTS.md"), accountId);
      await this.ensureSharedConfigDirSymlink(join(this.systemGrokHome(), "commands"), join(home, "commands"), accountId);
      await this.ensureSharedConfigDirSymlink(join(this.systemGrokHome(), "rules"), join(home, "rules"), accountId);
      return;
    }
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
      // Agent profile §5: the global instructions and slash commands.
      await this.ensureSharedUserFileSymlink(join(this.systemClaudeDir(), "CLAUDE.md"), join(home, "CLAUDE.md"), accountId);
      await this.ensureSharedConfigDirSymlink(join(this.systemClaudeDir(), "commands"), join(home, "commands"), accountId);
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
      // Agent profile §5: user skills. Codex writes its bundled skills into
      // `<CODEX_HOME>/skills/.system` at every start, so an account that has
      // run holds a real `skills/` with at least that in it; the merge drops
      // the account's `.system` when the shared dir has one (Codex re-creates
      // it — through the link — on the next start) and never loses a user skill.
      await this.ensureSharedConfigDirSymlink(join(this.systemCodexHome(), "skills"), join(home, "skills"), accountId, {
        bundledDir: ".system"
      });
      // …and the global instruction file, which Codex reads from `$CODEX_HOME/AGENTS.md`.
      await this.ensureSharedUserFileSymlink(join(this.systemCodexHome(), "AGENTS.md"), join(home, "AGENTS.md"), accountId);
    }
  }

  /**
   * Share a user-authored config DIR (Claude/Grok `commands/`, Grok `rules/`,
   * Codex `skills/`) — agent profile §5.
   *
   * - The shared dir is created (0700) when absent, so the link never dangles
   *   and an item the owner adds later is seen by every account at once. It is
   *   only created inside an agent home that exists.
   * - A real dir already in the account home is merged into the shared one
   *   first (`mergeKeepingBoth`): nothing is ever dropped but an identical
   *   duplicate; on a name collision both are kept, the account's copy renamed
   *   `<name>-<accountId prefix>`. `bundledDir` names a CLI-owned entry that is
   *   discarded instead when the shared dir already has it.
   * - Only a dir the merge emptied is replaced by the link; leftovers (a move
   *   that failed) leave the account's dir in place, to be tried again.
   * - A wrong symlink is replaced (removing a link removes no data); a regular
   *   file where a dir belongs is left alone.
   */
  private async ensureSharedConfigDirSymlink(
    target: string,
    linkPath: string,
    accountId: string,
    options: { bundledDir?: string } = {}
  ): Promise<void> {
    const shared = await stat(target).catch(() => null);
    if (shared && !shared.isDirectory()) {
      this.opts.logger?.warn?.(`shared config ${target} is not a directory; not linking ${linkPath}`);
      return;
    }
    if (!shared) {
      if (!(await stat(dirname(target)).catch(() => null))?.isDirectory()) return; // agent home not set up
      try {
        await mkdir(target, { mode: 0o700 });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") {
          this.opts.logger?.warn?.(`creating shared dir ${target} failed: ${String(e)}`);
          return;
        }
      }
    }
    const st = await lstat(linkPath).catch(() => null);
    if (st) {
      if (st.isSymbolicLink()) {
        const current = await readlink(linkPath).catch(() => null);
        if (current === target) return; // already shared
        this.opts.logger?.warn?.(`replacing the link ${linkPath} -> ${current ?? "?"} with the shared ${target}`);
        await rm(linkPath, { force: true }).catch(() => undefined);
      } else if (st.isDirectory()) {
        if (await samePath(linkPath, target)) return; // the "shared" dir IS this account's (a system home set to it)
        await this.mergeKeepingBoth(linkPath, target, accountId, options.bundledDir);
        if ((await readdir(linkPath).catch(() => ["x"])).length > 0) {
          this.opts.logger?.warn?.(`could not merge all of ${linkPath} into ${target}; left in place`);
          return;
        }
        await rm(linkPath, { recursive: true, force: true }).catch(() => undefined);
      } else {
        this.opts.logger?.warn?.(`${linkPath} is not a directory; not linking it to ${target}`);
        return;
      }
    }
    await symlink(target, linkPath).catch((e) => this.opts.logger?.warn?.(`shared config dir symlink ${linkPath} failed: ${String(e)}`));
  }

  /**
   * Move every entry of the account's `src` dir into the shared `dst` dir, one
   * level deep (a skill dir or a command file is one item — never merged
   * file-by-file with another item of the same name):
   * - absent in `dst` → moved;
   * - present and byte-for-byte identical → the account's duplicate dropped;
   * - present and different → both kept, the account's renamed
   *   `<name>-<id8>` (before the extension for a file: `review-1a2b3c4d.md`);
   * - `bundledDir` (Codex's `.system`) → the account's copy dropped when `dst`
   *   has one, else moved like any other entry.
   */
  private async mergeKeepingBoth(src: string, dst: string, accountId: string, bundledDir?: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(src, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      // `src` must still be the account's own real dir: through a link to `dst` every entry would
      // compare equal to itself and be removed as a duplicate.
      if (!(await lstat(src).catch(() => null))?.isDirectory()) return;
      const s = join(src, e.name);
      const d = join(dst, e.name);
      const existing = await lstat(d).catch(() => null);
      if (existing && (await samePath(s, d))) continue;
      if (!existing) {
        await moveEntry(s, d).catch((err) => this.opts.logger?.warn?.(`moving ${s} to ${d} failed: ${String(err)}`));
        continue;
      }
      if (e.name === bundledDir || (await sameTree(s, d))) {
        await rm(s, { recursive: true, force: true }).catch(() => undefined);
        continue;
      }
      const isFile = !e.isDirectory();
      const renamed = await freeName(dst, suffixedName(e.name, `-${accountPrefix(accountId)}`, isFile), isFile);
      await moveEntry(s, join(dst, renamed)).catch((err) =>
        this.opts.logger?.warn?.(`moving ${s} to ${join(dst, renamed)} failed: ${String(err)}`)
      );
    }
  }

  /**
   * Share a user-authored config FILE (Claude `CLAUDE.md`, Grok `AGENTS.md`) —
   * agent profile §5. Unlike `ensureSharedFileSymlink` (daemon-written files,
   * where a stale home copy is simply replaced) this file is the owner's text,
   * so an account's own copy is never deleted unread:
   *
   * - no shared file yet → the account's file is MOVED to the shared path;
   * - both exist, identical → the account's duplicate is dropped;
   * - both exist, different → the shared one wins and the account's is kept
   *   beside it as `<name>.account-<id8>.bak` (a name no CLI loads).
   *
   * The link is made even while the shared file does not exist. That dangling
   * link is deliberate: every CLI reads it as a missing file (probed on
   * 2026-09-28 against Claude Code 2.1.280 and Grok 1.0.34 with strace: the
   * open/stat answers ENOENT and startup carries on), and the file appears in
   * every account the moment the owner — or a session, writing through the
   * link — creates it. Only made inside an agent home that exists.
   */
  private async ensureSharedUserFileSymlink(target: string, linkPath: string, accountId: string): Promise<void> {
    if (!(await stat(dirname(target)).catch(() => null))?.isDirectory()) return; // agent home not set up
    const st = await lstat(linkPath).catch(() => null);
    if (st) {
      if (st.isSymbolicLink()) {
        const current = await readlink(linkPath).catch(() => null);
        if (current === target) return; // already shared
        this.opts.logger?.warn?.(`replacing the link ${linkPath} -> ${current ?? "?"} with the shared ${target}`);
        await rm(linkPath, { force: true }).catch(() => undefined);
      } else if (st.isFile()) {
        if (await samePath(linkPath, target)) return; // the "shared" file IS this account's
        // Followed: a shared file that is itself a link (a dotfiles repo) counts as the file it names.
        const shared = await stat(target).catch(() => null);
        try {
          if (!shared) {
            // Never onto a dangling link at `target`: moveEntry refuses an existing name.
            await moveEntry(linkPath, target);
          } else if (await sameFileContent(linkPath, target)) {
            await rm(linkPath, { force: true });
          } else {
            const backup = await freeName(dirname(target), `${basename(target)}.account-${accountPrefix(accountId)}.bak`, true);
            await moveEntry(linkPath, join(dirname(target), backup));
            this.opts.logger?.warn?.(
              `${linkPath} differed from the shared ${target}; the account's copy was kept as ${join(dirname(target), backup)}`
            );
          }
        } catch (e) {
          this.opts.logger?.warn?.(`could not merge ${linkPath} into ${target}; left in place: ${String(e)}`);
          return;
        }
      } else {
        this.opts.logger?.warn?.(`${linkPath} is not a file; not linking it to ${target}`);
        return;
      }
    }
    await symlink(target, linkPath).catch((e) => this.opts.logger?.warn?.(`shared file symlink ${linkPath} failed: ${String(e)}`));
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
      sys = JSON.parse(await readFile(this.systemClaudeConfigFile(), "utf8"));
    } catch {
      return; // no system config to seed from
    }
    const homeFile = join(home, ".claude.json");
    let existing: any = null;
    try {
      existing = JSON.parse(await readFile(homeFile, "utf8"));
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
  private async readExpiry(agent: ManagedAgent, id: string): Promise<number | null> {
    try {
      const home = this.homePath(agent, id);
      if (agent === "claude") {
        const creds = JSON.parse(await readFile(join(home, ".credentials.json"), "utf8"));
        const exp = creds?.claudeAiOauth?.expiresAt;
        return typeof exp === "number" ? exp : null;
      }
      if (agent === "grok") {
        const entry = grokAuthEntry(JSON.parse(await readFile(join(home, "auth.json"), "utf8")));
        const at = typeof entry?.expires_at === "string" ? Date.parse(entry.expires_at) : NaN;
        return Number.isFinite(at) ? at : null;
      }
      const auth = JSON.parse(await readFile(join(home, "auth.json"), "utf8"));
      const claims = typeof auth?.tokens?.access_token === "string" ? decodeJwtPayload(auth.tokens.access_token) : null;
      const exp = claims?.exp;
      return typeof exp === "number" ? exp * 1000 : null;
    } catch {
      return null;
    }
  }

  /** Refresh one managed account's OAuth token and persist it in place. De-duped
   *  per account so two callers can't spend the same single-use refresh token. */
  private async refreshAccount(agent: ManagedAgent, id: string): Promise<void> {
    if (this.refreshing.has(id)) return;
    this.refreshing.add(id);
    try {
      const record = this.getRecord(id);
      if (!record || record.agent !== agent) return;
      const home = this.homePath(agent, id);
      await assertOwnedAccountHome(this.opts.accountsDir, agent, id, home);
      const credsPath = join(home, CRED_FILENAME[agent]);
      let creds: any;
      try {
        creds = JSON.parse(await readFile(credsPath, "utf8"));
      } catch {
        return;
      }
      if (agent === "claude") {
        const refreshToken = creds?.claudeAiOauth?.refreshToken;
        if (typeof refreshToken !== "string") return;
        const out = await refreshClaudeToken(refreshToken);
        if (out.ok) {
          await writeFile(credsPath, JSON.stringify(mergeClaudeRefreshedCreds(creds, out, this.opts.now())), { mode: 0o600 });
          if (record.needsReauth) await this.markNeedsReauth(id, false);
        } else if (out.invalidGrant) {
          await this.markNeedsReauth(id, true);
        }
      } else if (agent === "grok") {
        const refreshToken = grokAuthEntry(creds)?.refresh_token;
        if (typeof refreshToken !== "string" || !refreshToken) return;
        const out = await refreshGrokToken(refreshToken);
        if (out.ok) {
          await writeFile(credsPath, JSON.stringify(mergeGrokRefreshedAuth(creds, out, this.opts.now())), { mode: 0o600 });
          if (record.needsReauth) await this.markNeedsReauth(id, false);
        } else if (out.invalidGrant) {
          await this.markNeedsReauth(id, true);
        }
      } else {
        const refreshToken = creds?.tokens?.refresh_token;
        if (typeof refreshToken !== "string") return;
        const out = await refreshCodexToken(refreshToken);
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
  async ensureFreshForUsage(agent: ManagedAgent, id: string, live: Set<string>): Promise<void> {
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

  private async persist(): Promise<void> {
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

/** The first 8 characters of an account id, filename-safe (ids are UUIDs). */
function accountPrefix(accountId: string): string {
  return accountId.slice(0, 8).replace(/[^A-Za-z0-9_-]/g, "_");
}

/** `review.md` + `-x` → `review-x.md` for a file; `my-skill` + `-x` → `my-skill-x` for a dir or a dotfile. */
function suffixedName(name: string, suffix: string, isFile: boolean): string {
  const ext = isFile ? extname(name) : "";
  return ext && ext !== name ? `${name.slice(0, -ext.length)}${suffix}${ext}` : `${name}${suffix}`;
}

/** `name` if nothing in `dir` holds it, else `name` with `-2`, `-3`, … before its extension. */
async function freeName(dir: string, name: string, isFile: boolean): Promise<string> {
  for (let n = 1; ; n += 1) {
    const candidate = n === 1 ? name : suffixedName(name, `-${n}`, isFile);
    if (!(await lstat(join(dir, candidate)).catch(() => null))) return candidate;
  }
}

/**
 * Rename, or copy-then-remove across filesystems. Never overwrites `dst`
 * (EEXIST): `rename(2)` silently replaces a file, so a non-directory is
 * hard-linked into place first (a link never replaces), then unlinked. A
 * directory rename cannot replace anything but an empty directory.
 */
async function moveEntry(src: string, dst: string): Promise<void> {
  const st = await lstat(src);
  try {
    if (st.isDirectory()) {
      await rename(src, dst);
    } else {
      await link(src, dst);
      await unlink(src);
    }
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== "EXDEV" && !(code === "EPERM" && !st.isDirectory())) throw e;
    await cp(src, dst, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
    await rm(src, { recursive: true, force: true });
  }
}

/** Both paths name the same file or directory (same device and inode, links followed). */
async function samePath(a: string, b: string): Promise<boolean> {
  const [sa, sb] = await Promise.all([stat(a).catch(() => null), stat(b).catch(() => null)]);
  return sa !== null && sb !== null && sa.dev === sb.dev && sa.ino === sb.ino;
}

/** Two files' bytes, links followed. */
async function sameFileContent(a: string, b: string): Promise<boolean> {
  try {
    return (await readFile(a)).equals(await readFile(b));
  } catch {
    return false;
  }
}

/** Same kind and same bytes, recursively (a symlink compares by its target text). */
async function sameTree(a: string, b: string): Promise<boolean> {
  try {
    const [sa, sb] = await Promise.all([lstat(a), lstat(b)]);
    if (sa.isSymbolicLink() || sb.isSymbolicLink()) {
      return sa.isSymbolicLink() && sb.isSymbolicLink() && (await readlink(a)) === (await readlink(b));
    }
    if (sa.isFile() && sb.isFile()) {
      return sa.size === sb.size && (await readFile(a)).equals(await readFile(b));
    }
    if (sa.isDirectory() && sb.isDirectory()) {
      const [ea, eb] = await Promise.all([readdir(a), readdir(b)]);
      if (ea.length !== eb.length) return false;
      const names = new Set(eb);
      for (const name of ea) {
        if (!names.has(name) || !(await sameTree(join(a, name), join(b, name)))) return false;
      }
      return true;
    }
    return false;
  } catch {
    return false;
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
