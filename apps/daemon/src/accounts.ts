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
  parseAccountsConfig
} from "@orquester/config";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { AccountError } from "./account-error";
import { ensureKnownHosts } from "./known-hosts";
import { providerFor } from "./providers";
import { probeServer, serverVersionSupportsEd25519 } from "./providers/bitbucket-server";
import {
  buildCredentialFileLine,
  type CreateRepoOpts,
  type ProviderCreds,
  type ProviderIdentity
} from "./providers/types";

// Re-exported so existing importers (`index.ts`) keep working after the class
// moved to its own module (breaking a provider↔accounts import cycle).
export { AccountError };

const run = promisify(execFile);

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
export function sshCommandFor(account: Account, knownHostsPath: string | null): string {
  const base = `ssh -i "${account.keyPath}" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new`;
  return account.provider !== "github" && knownHostsPath
    ? `${base} -o UserKnownHostsFile="${knownHostsPath}"`
    : base;
}

/** Derive the repo name (the dir `git clone` would create) from a clone URL. */
export function repoNameFrom(cloneUrl: string): string {
  const tail = cloneUrl.split("/").pop() ?? "";
  return tail.replace(/\.git$/i, "");
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

  constructor(
    /** Absolute path to accounts.json (resolved by the daemon via accountsConfigPath). */
    private readonly configPath: string,
    /** Absolute path to <appdir>/daemon/keys (created 0700 in prepareDirs). */
    private readonly keysDirPath: string
  ) {}

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
    await writeFile(this.configPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
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
  private async find(id: string): Promise<Account | undefined> {
    return (await this.read()).accounts.find((a) => a.id === id);
  }

  /** 404-throwing wrapper around `find()`. */
  private async requireAccount(id: string): Promise<Account> {
    const account = await this.find(id);
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
   * The daemon-owned known_hosts path for non-GitHub accounts (created/seeded on
   * demand), or null for GitHub (unchanged behavior) — and null if the file
   * cannot be written, in which case ssh falls back to the user's own file.
   */
  private async knownHosts(account: Account): Promise<string | null> {
    if (account.provider === "github") {
      return null;
    }
    return ensureKnownHosts(this.keysDirPath).catch(() => null);
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
          const repos = await provider.listRepos(creds);
          const ssh = repos.find((repo) => repo.sshUrl.startsWith("ssh://"))?.sshUrl;
          if (ssh) {
            const url = new URL(ssh);
            sshHost = `${url.hostname}${url.port ? `:${url.port}` : ""}`;
          }
        } catch {
          /* HTTPS-only account (SSH disabled, or no readable repo yet) */
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
    await rm(join(this.keysDirPath, `${account.id}.ca.pem`), { force: true }).catch(() => undefined);
    const config = await this.read();
    config.accounts = config.accounts.filter((a) => a.id !== id);
    await this.write(config);
  }

  /** Probe auth: `ssh -T` against the account's provider with this account's key. */
  async test(id: string): Promise<AccountTestResult> {
    const account = await this.requireAccount(id);
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
    cwd: string
  ): Promise<{ name: string }> {
    const account = await this.requireAccount(accountId);
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
    // DC clone URLs are authoritative (never derived), so prefer whatever the
    // API reported and fall back to HTTPS when SSH is disabled on the instance.
    const cloneUrl =
      urls.ssh && account.provider !== "bitbucket-server" ? urls.ssh : urls.ssh ?? urls.https;
    const name = destName ?? repoNameFrom(cloneUrl);
    if (existsSync(join(cwd, name))) {
      throw new AccountError(409, "A project with this name already exists.");
    }
    await this.cloneRepo(accountId, cloneUrl, name, cwd);
    return { name };
  }

  /**
   * Clone a repo into a project dir. SSH URLs pin the account's key through
   * `GIT_SSH_COMMAND` (no token in the URL/argv) rather than relying on
   * `includeIf` timing; HTTPS URLs point git at the account's 0600 credential
   * store (plus its CA bundle on DC). `cwd` is the workspace dir, `destName` the
   * new project subdir. Errors surface stderr so the route can map them to 4xx.
   */
  async cloneRepo(id: string, url: string, destName: string, cwd: string): Promise<void> {
    const account = await this.requireAccount(id);
    const configArgs: string[] = [];
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: this.home };
    if (/^https?:\/\//i.test(url)) {
      configArgs.push("-c", `credential.helper=store --file=${this.credentialsPath(account)}`);
      if (account.caCertPath) {
        configArgs.push("-c", `http.sslCAInfo=${account.caCertPath}`);
      }
    } else {
      env.GIT_SSH_COMMAND = sshCommandFor(account, await this.knownHosts(account));
    }
    try {
      await run("git", [...configArgs, "clone", url, destName], { cwd, env });
    } catch (error) {
      const detail = errText(error);
      if (/HTTP 410/.test(detail)) {
        throw new AccountError(
          400,
          "Bitbucket rejected the stored credential (410) — app passwords were removed July 2026; reconnect with a scoped API token."
        );
      }
      throw new AccountError(502, `Could not clone the repository: ${detail}`);
    }
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
  async writeIncludeFile(account: Account): Promise<string> {
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
