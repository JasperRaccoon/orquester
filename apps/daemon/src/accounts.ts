import type {
  AccountSummary,
  AccountTestResult,
  CreateAccountRequest,
  GitProviderId,
  OwnerSummary,
  RepoSummary
} from "@orquester/api";
import {
  type Account,
  type AccountsConfig,
  createDefaultAccountsConfig,
  isValidName,
  parseAccountsConfig,
  serializeAccountsConfig
} from "@orquester/config";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { AccountError } from "./account-error";
import { ensureKnownHosts } from "./known-hosts";
import { providerFor } from "./providers";
import {
  invalidateDispatcher,
  probeServer,
  serverVersionSupportsEd25519
} from "./providers/bitbucket-server";
import {
  buildCredentialFileLine,
  type ConditionalListOptions,
  type ConditionalPage,
  type CreateRepoOpts,
  GitRemoteError,
  type GitProvider,
  type ParsedRepo,
  type ProviderCreds,
  type ProviderIdentity,
  type PullRequestInfo,
  type ReleaseInfo
} from "./providers/types";
import {
  checkoutArgs,
  cloneArgs,
  cloneRefProblem,
  DEFAULT_CLONE_TIMEOUT_MS,
  fetchCommitArgs,
  isFullSha,
  isMissingRemoteRef,
  lsRemoteAllArgs,
  resolveAbbreviatedSha,
  type LsRemoteResult,
  mayBeAbbreviatedSha,
  parseLsRemote,
  parseRemoteUrl,
  redactUrlUserinfo,
  remoteUrlProblem
} from "./workflows/git-remote";

// Re-exported so existing importers (`index.ts`) keep working after the class
// moved to its own module (breaking a provider↔accounts import cycle).
export { AccountError };

const run = promisify(execFile);

/**
 * The process runner AccountsService shells out through for clone and ls-remote (injectable so
 * tests assert the argv/env without running git). Same contract as promisified `execFile`: a
 * non-zero exit rejects with an error carrying `stdout`/`stderr`/`code` (and `killed` on a
 * timeout).
 */
export type AccountsExec = (
  file: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number; maxBuffer?: number }
) => Promise<{ stdout: string; stderr: string }>;

/** Options for `cloneRepo` / `cloneFromInput`. */
interface CloneOptions {
  /**
   * Branch, tag or commit to check out. A full sha is cloned then checked out detached (fetched
   * by id when the clone did not bring it); a name is cloned with `--branch` (a tag leaves a
   * detached HEAD); an abbreviated hex that names no branch/tag is retried as a commit.
   */
  ref?: string;
  /**
   * An automated caller (a workflow's temporary project): the clone is bounded (`timeoutMs`,
   * default 10 min) and never waits on a prompt (`GIT_TERMINAL_PROMPT=0`). Without it the clone
   * runs as the New Project dialog's always has — no ceiling, git's own prompting untouched.
   */
  unattended?: boolean;
  /** Ceiling on the whole clone, every step included (default: 10 min when `unattended`, else none). */
  timeoutMs?: number;
}

/** Options for `lsRemote`. */
interface LsRemoteOptions {
  /** Default 30 s. */
  timeoutMs?: number;
  /**
   * Also resolve the remote's HEAD → `defaultBranch` (default true). git cannot narrow the
   * advertisement to HEAD + heads + tags, so asking for HEAD reads the remote's WHOLE ref list
   * (a GitHub remote's `refs/pull/*` included); `false` reads only `refs/heads/` and
   * `refs/tags/`. A poller can resolve the default branch less often than it polls.
   */
  defaultBranch?: boolean;
}

/** Default ceiling on one `git ls-remote`. */
const LS_REMOTE_TIMEOUT_MS = 30_000;

/** True when a rejected exec was killed by its `timeout`. */
function timedOut(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { killed, code } = error as { killed?: unknown; code?: unknown };
  return killed === true && code !== "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
}

/** Classify a failed remote git command (ls-remote, clone) by its stderr. */
function remoteGitError(what: string, error: unknown, timeoutMs: number): GitRemoteError {
  if (timedOut(error)) {
    return new GitRemoteError(504, `${what} timed out after ${Math.round(timeoutMs / 1000)} s.`, "timeout");
  }
  const detail = redactUrlUserinfo(errText(error));
  if (
    /Authentication failed|Permission denied|could not read (Username|Password)|terminal prompts disabled|HTTP (401|403)|Invalid username or password/i.test(
      detail
    )
  ) {
    return new GitRemoteError(400, `${what}: authentication was rejected. ${detail}`, "auth");
  }
  if (/Repository not found|not found|does not appear to be a git repository|HTTP 404/i.test(detail)) {
    return new GitRemoteError(404, `${what}: the repository was not found. ${detail}`, "not_found");
  }
  return new GitRemoteError(502, `${what}: ${detail}`, "upstream");
}

/** Every provider id, for the "that URL belongs to another provider" hint. */
const PROVIDER_IDS: readonly GitProviderId[] = ["github", "bitbucket-cloud", "bitbucket-server"];

/** Display host for an account summary (what the UI shows next to the login). */
function displayHost(account: Account): string {
  if (account.provider === "bitbucket-cloud") return "bitbucket.org";
  if (account.provider === "bitbucket-server") {
    if (!account.baseUrl) return "";
    try {
      return new URL(account.baseUrl).host;
    } catch {
      return "";
    }
  }
  return "github.com";
}

/**
 * The `core.sshCommand` / `GIT_SSH_COMMAND` for an account. GitHub keeps the
 * historical form verbatim (the user's own `~/.ssh/known_hosts`); every other
 * provider is pinned to the daemon-owned known_hosts file, which carries the
 * bitbucket.org host keys and TOFU'd DC entries.
 *
 * The key path is quoted: core.sshCommand is parsed shell-like and the path may
 * contain spaces (e.g. macOS /Users/First Last/.orquester/...).
 */
function sshCommandFor(account: Account, knownHostsPath: string | null): string {
  const base = `ssh -i "${account.keyPath}" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new`;
  return account.provider !== "github" && knownHostsPath
    ? `${base} -o UserKnownHostsFile="${knownHostsPath}"`
    : base;
}

/**
 * Choose the transport to clone over. SSH is preferred — the account's key is
 * pinned for it and no token ever touches the URL — EXCEPT while a Bitbucket DC
 * key upload is still pending: that key was never installed on the instance, so
 * SSH auth is guaranteed to fail (`Permission denied (publickey)`) even though
 * the instance keeps advertising an SSH clone URL. The token-backed HTTPS URL is
 * the transport that works until `confirmKey()` clears the flag.
 */
function pickCloneUrl(
  account: Pick<Account, "keyUploadPending">,
  urls: { ssh?: string; https?: string }
): string | undefined {
  return account.keyUploadPending ? (urls.https ?? urls.ssh) : (urls.ssh ?? urls.https);
}

/** Derive the repo name (the dir `git clone` would create) from a clone URL. */
function repoNameFrom(cloneUrl: string): string {
  const tail = cloneUrl.split("/").pop() ?? "";
  return tail.replace(/\.git$/i, "");
}

/**
 * Read a DC instance's SSH endpoint ("host" / "host:port") off the clone URLs
 * the API reported for its repos. Admins can move SSH to another host/port, so
 * it is never derived from the base URL — an instance with no readable repo
 * simply has no SSH endpoint yet (see `ensureSshHost`).
 */
function sshHostFromRepos(repos: RepoSummary[]): string | undefined {
  const ssh = repos.find((repo) => repo.sshUrl.startsWith("ssh://"))?.sshUrl;
  if (!ssh) {
    return undefined;
  }
  try {
    const url = new URL(ssh);
    return `${url.hostname}${url.port ? `:${url.port}` : ""}`;
  } catch {
    return undefined;
  }
}

/** Single-quote a value for a `source`-able env file (`'` → `'\''`). */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Owns connected git accounts: their server-side SSH keys, their provider
 * identity, and the per-workspace git binding (`includeIf` + an include file).
 * Everything forge-specific (REST, URL grammars, credential hosts, SSH probes)
 * is delegated to a `GitProvider`; this class stays provider-agnostic.
 *
 * Security invariants:
 *   - The private key never leaves the host; no method returns `keyPath`.
 *   - The provider token is persisted at rest (accounts.json, 0600) for REST
 *     (list/create repos) and is NEVER returned by any API / never crosses the
 *     wire — clients only see `repoAccess`. On a bound workspace it is ALSO
 *     written to local 0600 files (a git-credentials store, gh hosts.yml for
 *     GitHub, a `<id>.env` helper for Bitbucket) so that workspace's
 *     terminals/agents can authenticate HTTPS git as the account — same-host,
 *     same-user trust boundary, off any command line.
 *   - Every git/ssh/ssh-keygen call uses execFile (arg array, no shell) because
 *     labels/identity/paths are user- or network-controlled.
 *   - All global git edits go through `git config --global`; HOME is pinned so
 *     the include lands in the same `~` that PTY sessions read.
 */
export class AccountsService {
  /** Pinned HOME — the one `~` the daemon (and its terminals) use. */
  private readonly home = process.env.HOME ?? homedir();

  /** Runs git for clone and ls-remote (a fake in tests). */
  private readonly exec: AccountsExec;
  /** False keeps `ensureKnownHosts` off the network (tests). */
  private readonly refreshKnownHosts: boolean;

  constructor(
    /** Absolute path to accounts.json (resolved by the daemon via accountsConfigPath). */
    private readonly configPath: string,
    /** Absolute path to <appdir>/daemon/keys (created 0700 in prepareDirs). */
    private readonly keysDirPath: string,
    options: { exec?: AccountsExec; refreshKnownHosts?: boolean } = {}
  ) {
    this.exec = options.exec ?? (run as AccountsExec);
    this.refreshKnownHosts = options.refreshKnownHosts ?? true;
  }

  // --- Persistence ---------------------------------------------------------

  /**
   * Read accounts.json. A missing file is the normal first-run case (empty
   * config); anything else — unreadable, invalid JSON, schema mismatch — throws
   * instead of silently returning an empty config, because the next `write()`
   * would persist that loss. Same refuse-to-overwrite posture as sessions.json.
   */
  private async read(): Promise<AccountsConfig> {
    let raw: string;
    try {
      raw = await readFile(this.configPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return createDefaultAccountsConfig();
      }
      throw new AccountError(500, "accounts.json is unreadable; refusing to overwrite it.");
    }
    try {
      return parseAccountsConfig(JSON.parse(raw));
    } catch {
      throw new AccountError(500, "accounts.json is unreadable; refusing to overwrite it.");
    }
  }

  private async write(config: AccountsConfig): Promise<void> {
    await mkdir(dirname(this.configPath), { recursive: true });
    // 0600: accounts.json holds the provider token at rest (same care as keys/, 0700).
    // `mode` only applies on create, so chmod afterwards to also fix existing files.
    // serializeAccountsConfig mirrors legacy githubLogin/githubKeyId on github
    // records so a rolled-back (pre-provider) daemon can still parse the file.
    await writeFile(this.configPath, `${JSON.stringify(serializeAccountsConfig(config), null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await chmod(this.configPath, 0o600).catch(() => undefined);
  }

  /**
   * Strip `keyPath`/`remoteKeyId`/`token`/`caCertPath` — the public projection
   * the API returns. `repoAccess` reflects whether a token is persisted, never
   * the token.
   */
  private toSummary(account: Account): AccountSummary {
    return {
      id: account.id,
      label: account.label,
      provider: account.provider,
      login: account.login,
      // Mirrored for stale clients that still read `githubLogin`.
      githubLogin: account.login,
      host: displayHost(account),
      gitName: account.gitName,
      gitEmail: account.gitEmail,
      publicKey: account.publicKey,
      repoAccess: !!account.token,
      ...(account.tokenExpiresAt ? { tokenExpiresAt: account.tokenExpiresAt } : {}),
      ...(account.keyUploadPending
        ? {
            keyPending: true,
            ...(account.baseUrl
              ? { manualKeyUrl: `${account.baseUrl.replace(/\/+$/, "")}/plugins/servlet/ssh/account/keys` }
              : {})
          }
        : {}),
      createdAt: account.createdAt
    };
  }

  /** Internal lookup (keeps `keyPath` in process; never returned to clients). */
  private async requireAccount(id: string): Promise<Account> {
    const account = (await this.read()).accounts.find((a) => a.id === id);
    if (!account) {
      throw new AccountError(404, "Account not found.");
    }
    return account;
  }

  /**
   * Non-throwing: `token` may be "" for tokenless (SSH-only) accounts. Paths
   * that need REST keep the `assertToken()` gate in front of provider calls.
   */
  private credsOf(account: Account): ProviderCreds {
    return {
      token: account.token ?? "",
      email: account.email,
      baseUrl: account.baseUrl,
      username: account.login,
      caCertPath: account.caCertPath
    };
  }

  private identityOf(account: Account): ProviderIdentity {
    return {
      login: account.login,
      loginRef: account.loginRef,
      name: account.gitName,
      email: account.gitEmail
    };
  }

  /** Instance coordinates a provider needs to build URLs/probes for an account. */
  private urlCtx(account: Account): {
    baseUrl?: string;
    sshHost?: string;
    login: string;
    email?: string;
  } {
    return {
      baseUrl: account.baseUrl,
      sshHost: account.sshHost,
      login: account.login,
      email: account.email
    };
  }

  /**
   * DC only: `sshHost` is discovered from a repo's clone links at connect time,
   * so an account connected before its instance had any readable repo has none —
   * and would keep reporting "HTTPS-only" forever. Re-resolve it lazily
   * (best-effort, before SSH-dependent operations) and persist what we find.
   */
  private async ensureSshHost(account: Account): Promise<Account> {
    if (account.provider !== "bitbucket-server" || account.sshHost || !account.token) {
      return account;
    }
    let sshHost: string | undefined;
    try {
      sshHost = sshHostFromRepos(
        await providerFor(account.provider).listRepos(this.credsOf(account))
      );
    } catch {
      return account; /* offline/forbidden — keep the account as-is */
    }
    if (!sshHost) {
      return account; /* genuinely HTTPS-only (SSH disabled on the instance) */
    }
    const config = await this.read();
    const stored = config.accounts.find((a) => a.id === account.id);
    if (!stored) {
      return account;
    }
    stored.sshHost = sshHost;
    await this.write(config);
    return stored;
  }

  /**
   * The daemon-owned known_hosts path for non-GitHub accounts (created/seeded on
   * demand), or null for GitHub (unchanged behavior) — and null if the file
   * cannot be written, in which case ssh falls back to the user's own file.
   */
  private async knownHosts(account: Account): Promise<string | null> {
    if (account.provider === "github") {
      return null;
    }
    return ensureKnownHosts(this.keysDirPath, { refresh: this.refreshKnownHosts }).catch(() => null);
  }

  // --- CRUD ----------------------------------------------------------------

  async list(): Promise<AccountSummary[]> {
    return (await this.read()).accounts.map((a) => this.toSummary(a));
  }

  /**
   * Connect a git account: generate an SSH key, upload it to the provider with
   * the token, read the identity, then persist (the token is kept at rest, 0600,
   * for REST list/create repos; the private key never leaves `keyPath`). On any
   * failure after keygen, the generated files are cleaned up so a retry is
   * idempotent.
   *
   * Provider specifics: Bitbucket Cloud needs the Atlassian account email (REST
   * Basic auth username); Bitbucket Server/DC needs the instance base URL + a
   * username, is probed BEFORE the token is used (wrong-context-path detection +
   * the ed25519-vs-RSA version gate), and may store a per-account CA bundle.
   */
  async add(req: CreateAccountRequest): Promise<AccountSummary> {
    const providerId: GitProviderId = req.provider ?? "github";
    const provider = providerFor(providerId);
    const label = req.label?.trim();
    const token = req.token?.trim();
    if (!label) {
      throw new AccountError(400, "A label is required.");
    }
    if (!token) {
      throw new AccountError(
        400,
        providerId === "github" ? "A GitHub token is required." : "A provider token is required."
      );
    }

    const email =
      req.provider === "bitbucket-cloud" ? req.email?.trim() : undefined;
    if (providerId === "bitbucket-cloud" && !email) {
      throw new AccountError(400, "The Atlassian account email is required.");
    }
    const baseUrl =
      req.provider === "bitbucket-server" ? req.baseUrl?.trim().replace(/\/+$/, "") : undefined;
    const username = req.provider === "bitbucket-server" ? req.username?.trim() : undefined;
    const caCertPem = req.provider === "bitbucket-server" ? req.caCertPem?.trim() : undefined;
    if (providerId === "bitbucket-server") {
      if (!baseUrl) {
        throw new AccountError(400, "The Bitbucket Server base URL is required.");
      }
      if (!username) {
        throw new AccountError(400, "The Bitbucket Server username is required.");
      }
    }
    // Bitbucket tokens always expire; the expiry is user-entered (no API exposes it).
    const tokenExpiresAt =
      req.provider === "bitbucket-cloud" || req.provider === "bitbucket-server"
        ? req.tokenExpiresAt?.trim() || undefined
        : undefined;

    await this.requireBinaries();

    const id = randomUUID();
    const keyPath = join(this.keysDirPath, id);
    // 0700 dir already created in prepareDirs; ssh-keygen writes the private key
    // 0600 and the .pub 0644.
    await mkdir(this.keysDirPath, { recursive: true, mode: 0o700 }).catch(() => undefined);

    const cleanup = async (caPath?: string): Promise<void> => {
      await rm(keyPath, { force: true }).catch(() => undefined);
      await rm(`${keyPath}.pub`, { force: true }).catch(() => undefined);
      if (caPath) {
        invalidateDispatcher(caPath);
        await rm(caPath, { force: true }).catch(() => undefined);
      }
    };

    // 1) DC only: persist the CA bundle FIRST — the probe (and every later REST
    //    call) must already trust an internal-CA/self-signed instance.
    let caCertPath: string | undefined;
    if (caCertPem) {
      caCertPath = join(this.keysDirPath, `${id}.ca.pem`);
      await writeFile(caCertPath, caCertPem.endsWith("\n") ? caCertPem : `${caCertPem}\n`, {
        encoding: "utf8",
        mode: 0o600
      });
      await chmod(caCertPath, 0o600).catch(() => undefined);
    }

    // 2) DC only: probe the instance unauthenticated (validates the base URL /
    //    context path) and gate the key algorithm on its version.
    let keygenArgs = ["-t", "ed25519", "-f", keyPath, "-N", "", "-C", `orquester:${label}`];
    if (providerId === "bitbucket-server") {
      try {
        const props = await probeServer(baseUrl!, caCertPath);
        if (!serverVersionSupportsEd25519(props.version)) {
          // ed25519 needs Server ≥ 6.6 — older instances only accept RSA.
          keygenArgs = ["-t", "rsa", "-b", "4096", "-f", keyPath, "-N", "", "-C", `orquester:${label}`];
        }
      } catch (error) {
        await cleanup(caCertPath);
        throw error instanceof AccountError
          ? error
          : new AccountError(502, `Could not reach the Bitbucket Server instance: ${errText(error)}`);
      }
    }

    // 3) Generate the key.
    try {
      await run("ssh-keygen", keygenArgs);
    } catch (error) {
      await cleanup(caCertPath);
      throw new AccountError(500, `Could not generate an SSH key: ${errText(error)}`);
    }

    try {
      const publicKey = (await readFile(`${keyPath}.pub`, "utf8")).trim();
      const creds: ProviderCreds = { token, email, baseUrl, username, caCertPath };

      // 4) Who does this token authenticate as?
      const identity = await provider.getIdentity(creds);
      if (!identity.login) {
        throw new AccountError(502, "The provider did not return a login for this token.");
      }

      // 5) Upload the public key (DC may hand back a manual-paste URL instead).
      const upload = await provider.uploadSshKey(creds, identity, publicKey, `orquester:${label}`);

      // 6) Resolve the SSH endpoint. Cloud is fixed (the old host dies
      //    2026-11-12); DC is read best-effort off a repo's clone links (admins
      //    can move it to another host/port); GitHub keeps the ssh default.
      let sshHost: string | undefined;
      if (providerId === "bitbucket-cloud") {
        sshHost = "ssh.bitbucket.org";
      } else if (providerId === "bitbucket-server") {
        try {
          sshHost = sshHostFromRepos(await provider.listRepos(creds));
        } catch {
          /* unreachable/forbidden listing — `ensureSshHost` retries later */
        }
      }

      // 7) Persist (the token is kept at rest, 0600, for REST list/create repos;
      //    toSummary strips it — only `repoAccess` is ever returned).
      const account: Account = {
        id,
        label,
        provider: providerId,
        login: identity.login,
        ...(identity.loginRef !== undefined ? { loginRef: identity.loginRef } : {}),
        ...(email !== undefined ? { email } : {}),
        ...(baseUrl !== undefined ? { baseUrl } : {}),
        ...(caCertPath !== undefined ? { caCertPath } : {}),
        ...(sshHost !== undefined ? { sshHost } : {}),
        ...(tokenExpiresAt ? { tokenExpiresAt } : {}),
        gitName: identity.name || identity.login,
        gitEmail: identity.email || `${label}@users.noreply.local`,
        publicKey,
        keyPath,
        ...(upload.keyId !== undefined ? { remoteKeyId: upload.keyId } : {}),
        ...(upload.manualUrl ? { keyUploadPending: true } : {}),
        token,
        createdAt: new Date().toISOString()
      };
      const config = await this.read();
      config.accounts.push(account);
      await this.write(config);
      // CLI auth is global (not workspace-scoped), so wire it as soon as the
      // account is connected; the include file's HTTPS creds follow on bind.
      await this.syncCliAuth(account);

      return this.toSummary(account);
    } catch (error) {
      // Clean up the orphaned key on any post-keygen failure.
      await cleanup(caCertPath);
      if (error instanceof AccountError) {
        throw error;
      }
      throw new AccountError(502, `Could not connect the account: ${errText(error)}`);
    }
  }

  /**
   * Disconnect an account. Blocked (409) while bound to any workspace — the
   * caller passes the names currently bound to it. Otherwise removes the key
   * from the provider (best-effort, when a token + remote id are known) and
   * deletes every local file for the account.
   */
  async remove(id: string, boundWorkspaces: string[]): Promise<void> {
    const account = await this.requireAccount(id);
    if (boundWorkspaces.length > 0) {
      throw new AccountError(
        409,
        `In use by ${boundWorkspaces.length} workspace(s): ${boundWorkspaces.join(", ")}.`
      );
    }
    // Best-effort: an expired/revoked token or an offline instance must not
    // block the local disconnect (the key would otherwise linger as dead data).
    if (account.remoteKeyId && account.token) {
      try {
        await providerFor(account.provider).removeSshKey(
          this.credsOf(account),
          this.identityOf(account),
          account.remoteKeyId
        );
      } catch {
        /* leave the remote key; the user can delete it in the provider UI */
      }
    }
    await rm(account.keyPath, { force: true }).catch(() => undefined);
    await rm(`${account.keyPath}.pub`, { force: true }).catch(() => undefined);
    await rm(this.credentialsPath(account), { force: true }).catch(() => undefined);
    await rm(this.includePath(account), { force: true }).catch(() => undefined);
    await rm(this.cliEnvPath(account), { force: true }).catch(() => undefined);
    if (account.caCertPath) {
      // Release the pooled TLS dispatcher before deleting its CA bundle.
      invalidateDispatcher(account.caCertPath);
    }
    await rm(join(this.keysDirPath, `${account.id}.ca.pem`), { force: true }).catch(() => undefined);
    const config = await this.read();
    config.accounts = config.accounts.filter((a) => a.id !== id);
    await this.write(config);
  }

  /** Probe auth: `ssh -T` against the account's provider with this account's key. */
  async test(id: string): Promise<AccountTestResult> {
    const account = await this.ensureSshHost(await this.requireAccount(id));
    const probe = providerFor(account.provider).sshProbe(this.urlCtx(account));
    if (!probe) {
      return { ok: false, message: "SSH is not available for this account (HTTPS-only)." };
    }
    // `ssh -T` normally exits non-zero (no shell is granted), so we parse
    // stdout/stderr through the provider rather than trusting the exit code.
    try {
      const knownHosts = await this.knownHosts(account);
      const { stdout, stderr } = await run(
        "ssh",
        [
          "-i",
          account.keyPath,
          "-o",
          "IdentitiesOnly=yes",
          "-o",
          "StrictHostKeyChecking=accept-new",
          ...(knownHosts ? ["-o", `UserKnownHostsFile=${knownHosts}`] : []),
          "-o",
          "BatchMode=yes",
          ...(probe.port ? ["-p", String(probe.port)] : []),
          "-T",
          probe.target
        ],
        { env: { ...process.env, HOME: this.home } }
      ).catch((error: { stdout?: string; stderr?: string }) => ({
        stdout: error.stdout ?? "",
        stderr: error.stderr ?? ""
      }));
      return probe.parse(`${stdout}${stderr}`.trim());
    } catch (error) {
      return { ok: false, message: errText(error) };
    }
  }

  // --- Provider token & repos (REST) --------------------------------------

  /**
   * Persist a provider token for an existing account (e.g. one connected before
   * the token was kept). Validates it against the provider and REJECTS it if the
   * returned login differs from the account's `login` — guarding against wiring
   * a typo'd token or a different identity. The token is stored at rest (0600);
   * it is never returned (only `repoAccess` flips).
   */
  async setToken(id: string, token: string, tokenExpiresAt?: string): Promise<void> {
    const trimmed = token?.trim();
    if (!trimmed) {
      throw new AccountError(400, "A token is required.");
    }
    const account = await this.requireAccount(id);
    const identity = await providerFor(account.provider).getIdentity({
      ...this.credsOf(account),
      token: trimmed
    });
    if (!identity.login) {
      throw new AccountError(502, "The provider did not return a login for this token.");
    }
    if (identity.login !== account.login) {
      throw new AccountError(
        400,
        `This token authenticates as "${identity.login}", but this account is "${account.login}". Use a token for the right account.`
      );
    }
    const config = await this.read();
    const stored = config.accounts.find((a) => a.id === id);
    if (!stored) {
      throw new AccountError(404, "Account not found.");
    }
    stored.token = trimmed;
    if (tokenExpiresAt) {
      stored.tokenExpiresAt = tokenExpiresAt;
    }
    await this.write(config);
    // Newly-authorized: refresh the per-account include file (adds the HTTPS
    // credential helper for all its bound workspaces at once) and CLI auth.
    await this.writeIncludeFile(stored);
    await this.syncCliAuth(stored);
  }

  /** Route-friendly 400 precondition for the REST-backed endpoints. */
  private assertToken(account: Account): void {
    if (!account.token) {
      throw new AccountError(400, "This account has no token. Enable repo access first.");
    }
  }

  /** List repos the account can reach (delegated to the provider). */
  async listRepos(id: string): Promise<RepoSummary[]> {
    const account = await this.requireAccount(id);
    this.assertToken(account);
    return providerFor(account.provider).listRepos(this.credsOf(account));
  }

  /**
   * Owners the account can create repos under: the user + GitHub orgs, Bitbucket
   * Cloud workspaces, or DC projects (+ the personal `~project`).
   */
  async listOwners(id: string): Promise<OwnerSummary[]> {
    const account = await this.requireAccount(id);
    this.assertToken(account);
    return providerFor(account.provider).listOwners(this.credsOf(account), this.identityOf(account));
  }

  /**
   * Create a repo for the account. `owner` is an id from `listOwners` (the
   * account's own login, a GitHub org, a Bitbucket workspace or a DC project).
   */
  async createRepo(id: string, opts: CreateRepoOpts): Promise<RepoSummary> {
    const account = await this.requireAccount(id);
    this.assertToken(account);
    return providerFor(account.provider).createRepo(
      this.credsOf(account),
      this.identityOf(account),
      opts
    );
  }

  /**
   * Parse a user-entered repo reference with the bound account's provider
   * grammar, resolve its clone URLs and clone it into `cwd`. A URL that belongs
   * to a *different* provider gets a specific error instead of a generic parse
   * failure.
   */
  async cloneFromInput(
    accountId: string,
    input: string,
    destName: string | undefined,
    cwd: string,
    opts: CloneOptions = {}
  ): Promise<{ name: string }> {
    const account = await this.ensureSshHost(await this.requireAccount(accountId));
    const provider = providerFor(account.provider);
    const parsed = provider.parseRepoUrl(input, this.urlCtx(account));
    if (!parsed) {
      const other = PROVIDER_IDS.filter((providerId) => providerId !== account.provider).some(
        (providerId) => providerFor(providerId).parseRepoUrl(input, {}) !== null
      );
      throw new AccountError(
        400,
        other
          ? `That URL belongs to a different provider — this workspace is bound to a ${account.provider} account.`
          : "Could not parse the repository URL for this account's provider."
      );
    }
    const urls = await provider.cloneUrls(this.credsOf(account), parsed);
    // SSH first (the account's key is pinned for it); fall back to HTTPS when
    // the transport is unavailable — a DC instance with SSH disabled, or an
    // SSH-only one where the admin turned off HTTP(S) SCM hosting — or when the
    // key upload is still pending (see `pickCloneUrl`). DC clone URLs are
    // authoritative (never derived), so whatever the API reported is used.
    const cloneUrl = pickCloneUrl(account, urls);
    if (!cloneUrl) {
      throw new AccountError(502, "The repository exposes no clone URL (neither HTTP(S) nor SSH).");
    }
    const name = destName ?? repoNameFrom(cloneUrl);
    // The derived name lands in `join(cwd, name)`; a repo literally named "." or
    // ".." would otherwise resolve outside the workspace dir.
    if (!isValidName(name)) {
      throw new AccountError(400, "The repository resolves to an invalid project name.");
    }
    if (existsSync(join(cwd, name))) {
      throw new AccountError(409, "A project with this name already exists.");
    }
    await this.cloneRepo(accountId, cloneUrl, name, cwd, opts);
    return { name };
  }

  /**
   * Clone a repo the daemon just created through the provider API. Picks the
   * transport exactly like `cloneFromInput` (SSH unless the account's key upload
   * is still pending), so the create flow stays usable on a DC account waiting
   * for its manual key paste.
   */
  async cloneCreatedRepo(
    id: string,
    repo: Pick<RepoSummary, "sshUrl" | "httpsUrl">,
    destName: string,
    cwd: string
  ): Promise<void> {
    const account = await this.requireAccount(id);
    const cloneUrl = pickCloneUrl(account, { ssh: repo.sshUrl, https: repo.httpsUrl });
    if (!cloneUrl) {
      throw new AccountError(502, "The repository exposes no clone URL (neither HTTP(S) nor SSH).");
    }
    await this.cloneRepo(id, cloneUrl, destName, cwd);
  }

  /**
   * The `-c` config and env a remote git command runs with — exactly what a clone uses. SSH URLs
   * pin the account's key through `GIT_SSH_COMMAND` (no token in the URL/argv) rather than relying
   * on `includeIf` timing; HTTPS URLs point git at the account's 0600 credential store (plus its
   * CA bundle on DC). With no account (`null`, a public repo) every configured credential helper
   * is reset, so nothing ambient answers for it; an anonymous SSH read is refused by its callers
   * (it would offer this host's own keys and agent). `noPrompt` sets `GIT_TERMINAL_PROMPT=0`: an
   * unattended git must fail, never wait on a prompt.
   */
  private async remoteTransport(
    account: Account | null,
    url: string,
    opts: { batchSsh?: boolean; noPrompt?: boolean } = {}
  ): Promise<{ configArgs: string[]; env: NodeJS.ProcessEnv }> {
    const configArgs: string[] = [];
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: this.home };
    if (opts.noPrompt) env.GIT_TERMINAL_PROMPT = "0";
    const batch = opts.batchSsh ? " -o BatchMode=yes" : "";
    if (/^https?:\/\//i.test(url)) {
      if (account) {
        configArgs.push("-c", `credential.helper=store --file=${this.credentialsPath(account)}`);
        if (account.caCertPath) {
          configArgs.push("-c", `http.sslCAInfo=${account.caCertPath}`);
        }
      } else {
        configArgs.push("-c", "credential.helper=");
      }
    } else if (account) {
      env.GIT_SSH_COMMAND = `${sshCommandFor(account, await this.knownHosts(account))}${batch}`;
    }
    return { configArgs, env };
  }

  /**
   * Clone a repo into a project dir, optionally at a ref (see `CloneOptions`), over the account's
   * transport (`remoteTransport`). `cwd` is the workspace dir, `destName` the new project subdir.
   * An `unattended` clone is bounded by `timeoutMs` (default 10 min) and prompt-free; the New
   * Project dialog's is neither (a `timeoutMs` alone still bounds it). A clone whose checkout fails is
   * removed again, so a failed ref never leaves a half-made project behind. Errors surface stderr
   * so the route can map them to 4xx.
   */
  async cloneRepo(
    id: string,
    url: string,
    destName: string,
    cwd: string,
    opts: CloneOptions = {}
  ): Promise<void> {
    const account = await this.requireAccount(id);
    const ref = opts.ref;
    if (ref !== undefined) {
      const problem = cloneRefProblem(ref);
      if (problem) {
        throw new AccountError(400, problem);
      }
    }
    const timeoutMs = opts.timeoutMs ?? (opts.unattended === true ? DEFAULT_CLONE_TIMEOUT_MS : undefined);
    const deadline = timeoutMs === undefined ? undefined : Date.now() + timeoutMs;
    const remaining = () => (deadline === undefined ? undefined : Math.max(1_000, deadline - Date.now()));
    const { configArgs, env } = await this.remoteTransport(account, url, { noPrompt: opts.unattended === true });
    const dest = join(cwd, destName);
    const git = (args: string[], at: string) =>
      this.exec("git", [...configArgs, ...args], {
        cwd: at,
        env,
        ...(deadline === undefined ? {} : { timeout: remaining() })
      });

    const cloneFailure = (error: unknown): AccountError => {
      if (timedOut(error)) {
        return new GitRemoteError(
          504,
          `Could not clone the repository: timed out after ${Math.round((timeoutMs ?? 0) / 1000)} s.`,
          "timeout"
        );
      }
      const detail = redactUrlUserinfo(errText(error));
      if (/HTTP 410/.test(detail)) {
        return new AccountError(
          400,
          "Bitbucket rejected the stored credential (410) — app passwords were removed July 2026; reconnect with a scoped API token."
        );
      }
      return new AccountError(502, `Could not clone the repository: ${detail}`);
    };

    // A commit is checked out after a plain clone; a name rides `--branch`, and an abbreviated
    // hex that names no branch or tag is retried as a commit.
    let commit = ref !== undefined && isFullSha(ref) ? ref : undefined;
    try {
      await git(cloneArgs(url, destName, commit === undefined ? ref : undefined), cwd);
    } catch (error) {
      if (ref === undefined || !mayBeAbbreviatedSha(ref) || timedOut(error) || !isMissingRemoteRef(errText(error))) {
        throw cloneFailure(error);
      }
      commit = ref;
      try {
        await git(cloneArgs(url, destName), cwd);
      } catch (retryError) {
        throw cloneFailure(retryError);
      }
    }
    if (commit === undefined) {
      return;
    }
    try {
      try {
        await git(checkoutArgs(commit), dest);
      } catch (error) {
        if (timedOut(error)) throw error;
        // Not among the cloned refs (a fork's PR head, a sha no branch holds any more): fetch it
        // by id — GitHub and Bitbucket serve reachable commits — then check that out. A fetch
        // needs the FULL id: an abbreviation (Bitbucket Cloud lists 12 hex) is first resolved
        // against every ref the remote advertises (GitHub's refs/pull/*, DC's refs/pull-requests/*).
        let full = commit;
        if (!isFullSha(commit)) {
          const { stdout } = await git(lsRemoteAllArgs(), dest);
          const resolved = resolveAbbreviatedSha(stdout, commit);
          if (resolved === null) {
            throw new Error(
              `${commit} is an abbreviated commit id that no branch or advertised ref of the remote resolves (a PR from a fork?) — use a branch or the full sha`
            );
          }
          full = resolved;
        }
        await git(fetchCommitArgs(full), dest);
        await git(checkoutArgs("FETCH_HEAD"), dest);
      }
    } catch (error) {
      await rm(dest, { recursive: true, force: true }).catch(() => undefined);
      if (timedOut(error)) {
        throw cloneFailure(error);
      }
      throw new AccountError(
        400,
        `Cloned, but could not check out ${commit}: ${redactUrlUserinfo(errText(error))}`
      );
    }
  }

  /**
   * `git ls-remote` over the account's clone transport (`remoteTransport`, plus SSH BatchMode);
   * `accountId: null` reads a public repo anonymously. Returns the remote's branches, its tags
   * (an annotated tag's `commit` is its peeled `^{}` sha) and, unless `defaultBranch: false`, the
   * branch its HEAD names. No shell; bounded by `timeoutMs` (default 30 s). Failures are
   * `GitRemoteError`s (`auth`, `not_found`, `timeout`, `upstream`) whose message never carries a
   * credential.
   */
  async lsRemote(
    accountId: string | null,
    url: string,
    opts: LsRemoteOptions = {}
  ): Promise<LsRemoteResult> {
    const trimmed = url.trim();
    const problem = remoteUrlProblem(trimmed);
    if (problem) {
      throw new GitRemoteError(400, problem, "unsupported");
    }
    const account = accountId === null ? null : await this.requireAccount(accountId);
    if (account === null && !/^(https?|git):\/\//i.test(trimmed)) {
      // Anonymous SSH would offer this host's own keys and agent, and trust its known_hosts.
      throw new GitRemoteError(
        400,
        "Reading a repository over SSH needs a git account. For a public repository use its https:// URL.",
        "unsupported"
      );
    }
    const { configArgs, env } = await this.remoteTransport(account, trimmed, { batchSsh: true, noPrompt: true });
    const timeoutMs = opts.timeoutMs ?? LS_REMOTE_TIMEOUT_MS;
    const args =
      opts.defaultBranch === false
        ? [...configArgs, "ls-remote", "--heads", "--tags", "--", trimmed]
        : [...configArgs, "ls-remote", "--symref", "--", trimmed];
    try {
      const { stdout } = await this.exec("git", args, {
        cwd: this.home,
        env,
        timeout: timeoutMs,
        // A remote advertising every PR ref runs to megabytes; never truncate the list.
        maxBuffer: 64 * 1024 * 1024
      });
      return parseLsRemote(stdout);
    } catch (error) {
      throw remoteGitError("git ls-remote", error, timeoutMs);
    }
  }

  /**
   * Resolve the provider, the repo and the credentials a REST listing of `url` runs with. With an
   * account, its provider's grammar (anchored to its instance on DC) must parse the URL; its token
   * authenticates, and an account with no token reads anonymously. With none, the URL's host picks
   * the provider (github.com, bitbucket.org) and the read is anonymous; any other host has no
   * anonymous REST (`unsupported`).
   */
  private async restTarget(
    accountId: string | null,
    url: string
  ): Promise<{ provider: GitProvider; repo: ParsedRepo; creds: ProviderCreds | null }> {
    const trimmed = url.trim();
    if (accountId !== null) {
      const account = await this.requireAccount(accountId);
      const provider = providerFor(account.provider);
      const repo = provider.parseRepoUrl(trimmed, this.urlCtx(account));
      if (!repo) {
        throw new GitRemoteError(
          400,
          `That repository URL does not belong to this ${account.provider} account.`,
          "unsupported"
        );
      }
      return { provider, repo, creds: account.token ? this.credsOf(account) : null };
    }
    const host = parseRemoteUrl(trimmed)?.host;
    const providerId: GitProviderId | null =
      host === "github.com" ? "github" : host === "bitbucket.org" ? "bitbucket-cloud" : null;
    const provider = providerId ? providerFor(providerId) : null;
    const repo = provider?.parseRepoUrl(trimmed, {}) ?? null;
    if (!provider || !repo) {
      throw new GitRemoteError(
        400,
        "Pull requests and releases can be read without an account only on github.com and bitbucket.org.",
        "unsupported"
      );
    }
    return { provider, repo, creds: null };
  }

  /**
   * One page (≤ 50) of the repo's pull requests, most recently updated first, with ETag support
   * (`{notModified: true}` when `opts.etag` still matches). Never returns a token.
   */
  async listPullRequests(
    accountId: string | null,
    url: string,
    opts: ConditionalListOptions = {}
  ): Promise<ConditionalPage<PullRequestInfo>> {
    const { provider, repo, creds } = await this.restTarget(accountId, url);
    return provider.listPullRequests(creds, repo, opts);
  }

  /** One page of the repo's releases, newest first (GitHub only; others `{items: [], unsupported: true}`). */
  async listReleases(
    accountId: string | null,
    url: string,
    opts: ConditionalListOptions = {}
  ): Promise<ConditionalPage<ReleaseInfo>> {
    const { provider, repo, creds } = await this.restTarget(accountId, url);
    return provider.listReleases(creds, repo, opts);
  }

  /**
   * Finish the Bitbucket DC manual-key flow: the instance refused the token-based
   * key upload, the user pasted the public key on the SSH keys page, and this
   * verifies it landed (then clears the pending flag).
   */
  async confirmKey(id: string): Promise<AccountSummary> {
    const account = await this.requireAccount(id);
    this.assertToken(account);
    const found = await providerFor(account.provider).findSshKey(
      this.credsOf(account),
      this.identityOf(account),
      account.publicKey
    );
    if (!found) {
      throw new AccountError(
        404,
        "The key is not on the server yet — paste it at the SSH keys page, then retry."
      );
    }
    const config = await this.read();
    const stored = config.accounts.find((a) => a.id === id);
    if (!stored) {
      throw new AccountError(404, "Account not found.");
    }
    stored.remoteKeyId = found.keyId;
    delete stored.keyUploadPending;
    await this.write(config);
    return this.toSummary(stored);
  }

  // --- Per-workspace git binding ------------------------------------------

  /** Path of the per-account include file (one file per account, reused by all its workspaces). */
  private includePath(account: Account): string {
    return join(this.keysDirPath, `${account.id}.gitconfig`);
  }

  /** Path of the per-account HTTPS credential store (token at rest, 0600). */
  private credentialsPath(account: Account): string {
    return join(this.keysDirPath, `${account.id}.git-credentials`);
  }

  /** Path of the per-account CLI helper env file (Bitbucket; token at rest, 0600). */
  private cliEnvPath(account: Account): string {
    return join(this.keysDirPath, `${account.id}.env`);
  }

  /**
   * Write/refresh the per-account include file: identity + sshCommand, and —
   * when a token is present — HTTPS credentials. This file is pulled into every
   * repo under a bound workspace via the `includeIf` rule, so everything set
   * here applies to that workspace's terminals/agents and ONLY them.
   */
  private async writeIncludeFile(account: Account): Promise<string> {
    const includePath = this.includePath(account);
    const sshCommand = sshCommandFor(account, await this.knownHosts(account));
    await this.git(["config", "--file", includePath, "user.name", account.gitName]);
    await this.git(["config", "--file", includePath, "user.email", account.gitEmail]);
    await this.git(["config", "--file", includePath, "core.sshCommand", sshCommand]);

    // HTTPS auth for this account's workspaces: when a token exists, stash it in
    // a 0600 credential-store file and point a host-scoped `credential.helper`
    // at it (here, inside the includeIf'd file — so HTTPS git push/pull/clone
    // works for repos under a bound workspace, and only there). The token rides
    // a file git reads, never a command line/argv. The host + username are
    // provider-specific (Bitbucket Cloud authenticates git as the literal
    // `x-bitbucket-api-token-auth`). Tokenless → strip both.
    const spec = providerFor(account.provider).credentialSpec(this.urlCtx(account));
    const credsPath = this.credentialsPath(account);
    const credentialKey = `credential.https://${spec.host}.helper`;
    if (account.token) {
      await writeFile(credsPath, buildCredentialFileLine(spec, account.token), {
        encoding: "utf8",
        mode: 0o600
      });
      await chmod(credsPath, 0o600).catch(() => undefined);
      await this.git(["config", "--file", includePath, credentialKey, `store --file=${credsPath}`]);
    } else {
      await rm(credsPath, { force: true }).catch(() => undefined);
      await this.git(["config", "--file", includePath, "--unset", credentialKey]).catch(() => undefined);
    }

    // DC with an internal/self-signed CA: teach git to trust the same bundle the
    // daemon's REST calls use, scoped to the instance URL.
    if (account.caCertPath && account.baseUrl) {
      await this.git([
        "config",
        "--file",
        includePath,
        `http.${account.baseUrl}.sslCAInfo`,
        account.caCertPath
      ]);
    }
    return includePath;
  }

  /**
   * Make the account's token usable from terminals/agents.
   *
   * GitHub: `<HOME>/.config/gh/hosts.yml` (0600, under the pinned HOME) so the
   * `gh` CLI is authenticated as this account — repo creation, PRs, other API
   * calls from inside a session. `gh` itself must be installed on the host (it
   * is not an npm package); when absent this file simply sits unused. hosts.yml
   * is keyed by host, so with multiple accounts the most-recently-synced wins.
   *
   * Bitbucket (both variants): no `gh` equivalent exists, so write a 0600
   * `<keys>/<id>.env` helper file agents can `source` on demand — it is never
   * injected into session env.
   *
   * No-op without a token.
   */
  private async syncCliAuth(account: Account): Promise<void> {
    if (!account.token) {
      return;
    }
    if (account.provider === "github") {
      const ghDir = join(this.home, ".config", "gh");
      await mkdir(ghDir, { recursive: true });
      const hostsPath = join(ghDir, "hosts.yml");
      const hosts =
        "github.com:\n" +
        `    oauth_token: ${account.token}\n` +
        `    user: ${account.login}\n` +
        "    git_protocol: ssh\n";
      await writeFile(hostsPath, hosts, { encoding: "utf8", mode: 0o600 });
      await chmod(hostsPath, 0o600).catch(() => undefined);
      return;
    }

    const cloud = account.provider === "bitbucket-cloud";
    const envPath = this.cliEnvPath(account);
    const body =
      `BITBUCKET_PROVIDER=${shellQuote(account.provider)}\n` +
      `BITBUCKET_BASE_URL=${shellQuote(cloud ? "https://api.bitbucket.org/2.0" : account.baseUrl ?? "")}\n` +
      `BITBUCKET_USER=${shellQuote(cloud ? account.email ?? "" : account.login)}\n` +
      `BITBUCKET_TOKEN=${shellQuote(account.token)}\n` +
      `BITBUCKET_AUTH=${shellQuote(cloud ? "basic" : "bearer")}\n`;
    await mkdir(this.keysDirPath, { recursive: true, mode: 0o700 }).catch(() => undefined);
    await writeFile(envPath, body, { encoding: "utf8", mode: 0o600 });
    await chmod(envPath, 0o600).catch(() => undefined);
  }

  /**
   * git's `includeIf` condition for a workspace dir. Platform-aware matcher:
   * case-insensitive `gitdir/i` on macOS/Windows (case-insensitive filesystems),
   * case-sensitive `gitdir:` on Linux. Trailing slash = the dir and everything
   * under it. `real` must already be realpath-resolved (git resolves symlinks
   * when matching — e.g. macOS /var → /private/var).
   */
  private gitdirCondition(real: string): string {
    const caseInsensitive = process.platform === "darwin" || process.platform === "win32";
    return `gitdir${caseInsensitive ? "/i" : ""}:${real}/`;
  }

  /**
   * Bind an account to a workspace dir: ensure the include file exists, then
   * register one global `includeIf` rule keyed on the REALPATH of the dir.
   */
  async bindWorkspace(accountId: string, workspaceDir: string): Promise<void> {
    const account = await this.requireAccount(accountId);
    const includePath = await this.writeIncludeFile(account);
    await this.syncCliAuth(account);
    const real = await realpath(workspaceDir);
    await this.git(["config", "--global", `includeIf.${this.gitdirCondition(real)}.path`, includePath]);
  }

  /**
   * Remove a workspace's `includeIf` rule (on workspace delete). Best-effort:
   * unset the value, then drop the now-empty section. Swallows "not found".
   */
  async unbindWorkspace(workspaceDir: string): Promise<void> {
    let real = workspaceDir;
    try {
      real = await realpath(workspaceDir);
    } catch {
      /* dir already gone — fall back to the literal path with the same matcher */
    }
    // Same platform-aware matcher as bindWorkspace so the section name matches.
    const condition = this.gitdirCondition(real);
    await this.git(["config", "--global", "--unset", `includeIf.${condition}.path`]).catch(() => undefined);
    await this.git(["config", "--global", "--remove-section", `includeIf.${condition}`]).catch(() => undefined);
  }

  // --- Helpers -------------------------------------------------------------

  /** Run `git` with HOME pinned (so --global edits the same ~/.gitconfig sessions read). */
  private async git(args: string[]): Promise<void> {
    await run("git", args, { env: { ...process.env, HOME: this.home } });
  }

  /**
   * Fail early with a clear, platform-specific message if `git`/`ssh-keygen`
   * are not on PATH. `git --version` exits 0; `ssh-keygen -?` exits non-zero
   * (usage) but still proves presence — only a spawn ENOENT means "missing".
   */
  private async requireBinaries(): Promise<void> {
    for (const bin of ["git", "ssh-keygen"] as const) {
      try {
        await run(bin, bin === "git" ? ["--version"] : ["-?"]);
      } catch (error) {
        if ((error as { code?: string }).code === "ENOENT") {
          throw new AccountError(
            500,
            `Required tool "${bin}" was not found on the daemon host. macOS: install the Xcode Command Line Tools (xcode-select --install). Linux: install git + openssh-client.`
          );
        }
        /* non-ENOENT (e.g. ssh-keygen's usage exit) → the binary exists, fine. */
      }
    }
  }
}

function errText(error: unknown): string {
  if (error && typeof error === "object" && "stderr" in error && (error as { stderr?: string }).stderr) {
    return String((error as { stderr?: string }).stderr).slice(0, 200);
  }
  return error instanceof Error ? error.message : "unknown error";
}
