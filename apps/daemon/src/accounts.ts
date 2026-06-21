import type { AccountSummary, AccountTestResult, CreateAccountRequest } from "@orquester/api";
import {
  type Account,
  type AccountsConfig,
  createDefaultAccountsConfig,
  parseAccountsConfig
} from "@orquester/config";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

const GITHUB_API = "https://api.github.com";

/** Error carrying the HTTP status the route should reply with. */
export class AccountError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "AccountError";
  }
}

/**
 * Owns connected git accounts: their server-side ed25519 keys, their GitHub
 * identity, and the per-workspace git binding (`includeIf` + an include file).
 *
 * Security invariants:
 *   - The private key never leaves the host; no method returns `keyPath`.
 *   - The GitHub PAT is used for the connect request only, then discarded.
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

  private async read(): Promise<AccountsConfig> {
    try {
      return parseAccountsConfig(JSON.parse(await readFile(this.configPath, "utf8")));
    } catch {
      return createDefaultAccountsConfig();
    }
  }

  private async write(config: AccountsConfig): Promise<void> {
    await mkdir(dirname(this.configPath), { recursive: true });
    await writeFile(this.configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  }

  /** Strip `keyPath`/`githubKeyId` — the public projection the API returns. */
  private toSummary(account: Account): AccountSummary {
    return {
      id: account.id,
      label: account.label,
      githubLogin: account.githubLogin,
      gitName: account.gitName,
      gitEmail: account.gitEmail,
      publicKey: account.publicKey,
      createdAt: account.createdAt
    };
  }

  /** Internal lookup (keeps `keyPath` in process; never returned to clients). */
  private async find(id: string): Promise<Account | undefined> {
    return (await this.read()).accounts.find((a) => a.id === id);
  }

  // --- CRUD ----------------------------------------------------------------

  async list(): Promise<AccountSummary[]> {
    return (await this.read()).accounts.map((a) => this.toSummary(a));
  }

  /**
   * Connect a GitHub account: generate an ed25519 key, upload it to GitHub with
   * the PAT, read the identity, persist (no token, no private key beyond
   * keyPath), discard the PAT. On any failure after keygen, the key files are
   * cleaned up so a retry is idempotent.
   */
  async add(req: CreateAccountRequest): Promise<AccountSummary> {
    const label = req.label?.trim();
    const token = req.token?.trim();
    if (!label) {
      throw new AccountError(400, "A label is required.");
    }
    if (!token) {
      throw new AccountError(400, "A GitHub token is required.");
    }
    await this.requireBinaries();

    const id = randomUUID();
    const keyPath = join(this.keysDirPath, id);

    // 1) Generate the key (0700 dir already created in prepareDirs; ssh-keygen
    //    writes the private key 0600 and the .pub 0644).
    await mkdir(this.keysDirPath, { recursive: true, mode: 0o700 }).catch(() => undefined);
    try {
      await run("ssh-keygen", ["-t", "ed25519", "-f", keyPath, "-N", "", "-C", `orquester:${label}`]);
    } catch (error) {
      throw new AccountError(500, `Could not generate an SSH key: ${errText(error)}`);
    }

    try {
      const publicKey = (await readFile(`${keyPath}.pub`, "utf8")).trim();

      // 2) Upload the public key to GitHub.
      const upload = await this.github(token, "POST", "/user/keys", {
        title: `orquester:${label}`,
        key: publicKey
      });
      const githubKeyId = typeof upload?.id === "number" ? upload.id : undefined;

      // 3) Read identity: login + name, then primary verified email.
      const user = await this.github(token, "GET", "/user");
      const githubLogin = typeof user?.login === "string" ? user.login : "";
      const gitName = typeof user?.name === "string" && user.name ? user.name : githubLogin;
      if (!githubLogin) {
        throw new AccountError(502, "GitHub did not return a login for this token.");
      }

      let gitEmail = "";
      try {
        const emails = (await this.github(token, "GET", "/user/emails")) as unknown;
        if (Array.isArray(emails)) {
          const primary = emails.find(
            (e): e is { email: string; primary?: boolean; verified?: boolean } =>
              typeof e === "object" && e !== null && typeof (e as { email?: unknown }).email === "string"
          );
          const chosen =
            emails.find(
              (e) => (e as { primary?: boolean; verified?: boolean }).primary && (e as { verified?: boolean }).verified
            ) ?? primary;
          gitEmail = (chosen as { email?: string } | undefined)?.email ?? "";
        }
      } catch {
        /* fall through to the noreply fallback */
      }
      if (!gitEmail) {
        const githubId = typeof user?.id === "number" ? user.id : 0;
        gitEmail = `${githubId}+${githubLogin}@users.noreply.github.com`;
      }

      // 4) Persist (no token).
      const account: Account = {
        id,
        label,
        githubLogin,
        gitName,
        gitEmail,
        publicKey,
        keyPath,
        ...(githubKeyId !== undefined ? { githubKeyId } : {}),
        createdAt: new Date().toISOString()
      };
      const config = await this.read();
      config.accounts.push(account);
      await this.write(config);

      // 5) Discard the PAT: nothing else references `token` past this point.
      return this.toSummary(account);
    } catch (error) {
      // Clean up the orphaned key on any post-keygen failure.
      await rm(keyPath, { force: true }).catch(() => undefined);
      await rm(`${keyPath}.pub`, { force: true }).catch(() => undefined);
      if (error instanceof AccountError) {
        throw error;
      }
      throw new AccountError(502, `Could not connect the account: ${errText(error)}`);
    }
  }

  /**
   * Disconnect an account. Blocked (409) while bound to any workspace — the
   * caller passes the names currently bound to it. Otherwise deletes the key
   * files + the account entry. (The PAT was never stored, so the GitHub key is
   * removed manually; the title `orquester:<label>` / `githubKeyId` is shown.)
   */
  async remove(id: string, boundWorkspaces: string[]): Promise<void> {
    const account = await this.find(id);
    if (!account) {
      throw new AccountError(404, "Account not found.");
    }
    if (boundWorkspaces.length > 0) {
      throw new AccountError(
        409,
        `In use by ${boundWorkspaces.length} workspace(s): ${boundWorkspaces.join(", ")}.`
      );
    }
    await rm(account.keyPath, { force: true }).catch(() => undefined);
    await rm(`${account.keyPath}.pub`, { force: true }).catch(() => undefined);
    const config = await this.read();
    config.accounts = config.accounts.filter((a) => a.id !== id);
    await this.write(config);
  }

  /** Probe auth: `ssh -T git@github.com` with this account's key. */
  async test(id: string): Promise<AccountTestResult> {
    const account = await this.find(id);
    if (!account) {
      throw new AccountError(404, "Account not found.");
    }
    // GitHub's `ssh -T` always exits non-zero (it doesn't grant a shell), so we
    // parse stdout/stderr rather than trusting the exit code.
    try {
      const { stdout, stderr } = await run(
        "ssh",
        [
          "-i",
          account.keyPath,
          "-o",
          "IdentitiesOnly=yes",
          "-o",
          "StrictHostKeyChecking=accept-new",
          "-o",
          "BatchMode=yes",
          "-T",
          "git@github.com"
        ],
        { env: { ...process.env, HOME: this.home } }
      ).catch((error: { stdout?: string; stderr?: string }) => ({
        stdout: error.stdout ?? "",
        stderr: error.stderr ?? ""
      }));
      const text = `${stdout}${stderr}`;
      const match = text.match(/Hi ([^!]+)!/);
      if (match) {
        return { ok: true, login: match[1], message: text.trim().slice(0, 200) };
      }
      return { ok: false, message: text.trim().slice(0, 200) || "No greeting from GitHub." };
    } catch (error) {
      return { ok: false, message: errText(error) };
    }
  }

  // --- Per-workspace git binding ------------------------------------------

  /** Path of the per-account include file (one file per account, reused by all its workspaces). */
  private includePath(account: Account): string {
    return join(this.keysDirPath, `${account.id}.gitconfig`);
  }

  /** Write/refresh the per-account include file (identity + sshCommand). */
  async writeIncludeFile(account: Account): Promise<string> {
    const includePath = this.includePath(account);
    // Quote the key path: core.sshCommand is parsed shell-like, and the path may
    // contain spaces (e.g. macOS /Users/First Last/.orquester/...).
    const sshCommand = `ssh -i "${account.keyPath}" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new`;
    await this.git(["config", "--file", includePath, "user.name", account.gitName]);
    await this.git(["config", "--file", includePath, "user.email", account.gitEmail]);
    await this.git(["config", "--file", includePath, "core.sshCommand", sshCommand]);
    return includePath;
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
    const account = await this.find(accountId);
    if (!account) {
      throw new AccountError(404, "Account not found.");
    }
    const includePath = await this.writeIncludeFile(account);
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

  /** Authenticated GitHub REST call; throws AccountError on a non-2xx. */
  private async github(
    token: string,
    method: "GET" | "POST",
    path: string,
    body?: unknown
  ): Promise<Record<string, unknown> & { id?: number; login?: string; name?: string }> {
    const response = await fetch(`${GITHUB_API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "orquester",
        ...(body ? { "Content-Type": "application/json" } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      const hint =
        response.status === 401 || response.status === 403
          ? " (check the token's scopes: write:public_key, user:email, read:user)"
          : "";
      throw new AccountError(
        response.status === 401 || response.status === 403 ? 400 : 502,
        `GitHub ${method} ${path} → ${response.status}${hint}. ${detail.slice(0, 200)}`
      );
    }
    return (await response.json()) as Record<string, unknown>;
  }
}

function errText(error: unknown): string {
  if (error && typeof error === "object" && "stderr" in error && (error as { stderr?: string }).stderr) {
    return String((error as { stderr?: string }).stderr).slice(0, 200);
  }
  return error instanceof Error ? error.message : "unknown error";
}
