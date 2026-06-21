# Phase 4 — Git Accounts per Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect multiple GitHub accounts to the daemon (each = a git identity + a server-side ed25519 SSH key, uploaded to GitHub via a transient PAT) and bind one immutably to each workspace, so every terminal/repo under that workspace automatically commits and pushes as the right account — with standard clone URLs and no key cross-talk. Account management runs over authenticated HTTPS; **private keys and the PAT are never returned by any API and the PAT is never persisted**.

**Architecture:** A new `accounts.json` config triplet (mirroring `remotes.json`) + a `keys/` dir (mode `0700`) under `<appdir>/daemon/`. A new daemon `AccountsService` (`apps/daemon/src/accounts.ts`) shells out — via `execFile`/`spawn` with **arg arrays, never a shell string** — to `ssh-keygen` (key generation) and `git config` (per-account include files + global `includeIf` rules), and uses Node's global `fetch` to upload the key + read identity from GitHub. Four endpoints (`GET/POST /api/accounts`, `DELETE /api/accounts/:id`, `POST /api/accounts/:id/test`) are exposed and — unlike `PUT /api/config/daemon` — are **allowed over the remote HTTP transport**. The per-workspace git mechanism is `git config --global includeIf.gitdir:<realpath>/.path <includeFile>`; terminals inherit it because they spawn under the daemon's pinned `HOME` and git reads `~/.gitconfig`. The web client gains `ApiClient` account methods, a store accounts slice (mirroring remotes), a "GitHub" section in `SettingsModal` (ServerSwitcher CRUD shape), and a promoted workspace-creation `Modal` with an account picker `Dropdown`.

**Tech Stack:** TypeScript, Zod (`@orquester/config`), Fastify (daemon), Node `child_process.execFile`/`spawn` + global `fetch` (Node 22), `ssh-keygen`/`git`/`ssh` CLIs, React 18 + Zustand (web), Tailwind, lucide-react.

## Global Constraints

- **No new runtime dependencies.** `ssh-keygen`, `git`, `ssh` are host binaries; `fetch` is global in Node 18+ (this repo runs Node 22).
- **`execFile`/`spawn` with arg arrays for ALL git/ssh-keygen/ssh calls** — inputs (label, paths, identity) are user/network-controlled. Do **not** reuse the shell-based `run()` in `registry.ts:333-342` (which calls `exec(command)`).
- **Secrets never leak.** No endpoint ever returns `keyPath` or any private-key material; the PAT is held in memory for one connect request and discarded — never written to `accounts.json` or any response.
- **Pin `HOME`** to one source of truth — `process.env.HOME ?? homedir()` — for every git invocation, so the include file lands in the same `~` that PTY sessions read (sessions spawn with `env: { ...process.env, ... }` and no HOME override; see `sessions.ts:54`).
- **Drive all global git edits through `git config --global`** (file locking + clean replace/unset of `includeIf` keys).
- **Cross-platform (macOS + Linux).** The daemon runs on the Linux VPS AND, bundled in the desktop app, on a local macOS machine — the git mechanism must work on both:
  - **Platform-aware `includeIf` matcher:** `gitdir/i` (case-insensitive) on macOS/Windows, `gitdir:` on Linux, chosen at runtime via `process.platform` in `gitdirCondition()`. A case-sensitive matcher on macOS's case-insensitive FS can silently fail to match. Bind and unbind use the SAME matcher so removal works.
  - **`fs.realpath(workspaceDir)` + mandatory TRAILING SLASH** (git resolves symlinks when matching — essential on macOS: `/var`→`/private/var`, `/tmp`→`/private/tmp`).
  - **Quote the key path in `core.sshCommand`** (`ssh -i "<keyPath>" …`) so spaces (`/Users/First Last/…`) don't break it.
  - **Binary preflight:** `requireBinaries()` fails with a clear message if `git`/`ssh-keygen` are absent (macOS: Xcode CLT; Linux: git + openssh-client).
  - On a **local macOS daemon the rules land in the user's real `~/.gitconfig`** (additive, scoped to workspace dirs). For local testing, run the daemon with a sandboxed `HOME` (e.g. `HOME=/tmp/orq-home pnpm dev:daemon:bare`) to avoid editing your own gitconfig.
  - **Windows is deferred** (path-format + ACL key-perm differences).
- **`core.sshCommand` = `ssh -i <keyPath> -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new`.** `IdentitiesOnly=yes` makes multi-account deterministic; `accept-new` is a belt on top of the Phase-0 `known_hosts` seed so the first push never hangs the PTY on a host-authenticity prompt.
- **Binding is immutable** — set at workspace creation, never changed (no rebind endpoint). Re-account = delete + recreate the workspace.
- Verification is `pnpm check` (= `pnpm -r typecheck`) + runtime curl/Playwright; the repo has **no test runner** — do not add one.
- Match existing code style (comment density, naming, the `// ---` section dividers in `api-client.ts`/`store`, doc-comments on public methods). One commit per task. Sequence so each task is independently testable.

## Assumptions about Phase 3 (relied upon — see closing note)

This plan **builds on Phase 3** and treats the following as already present (the prompt instructs assuming Phase 3 has landed):

- `packages/config`: `workspacesConfigSchema` / `parseWorkspacesConfig` / `createDefaultWorkspacesConfig` / `workspacesMetaPath(baseDir)` → `<appdir>/daemon/workspaces.json`, entries `{ name, gitAccountId?, createdAt }`; `resolved.workspacesMetaFile` in `ResolvedPaths`.
- `packages/api`: `WorkspaceSummary.gitAccountId?: string | null`; `CreateWorkspaceRequest.gitAccountId?: string`.
- daemon: `POST /api/workspaces` writes the `workspaces.json` entry including `gitAccountId`; `DELETE /api/workspaces/:workspace` prunes that entry and cascades sessions; helpers `readWorkspacesMeta`/`writeWorkspacesMeta` exist alongside `readRemotesFile`/`writeJsonFile`.
- store: `createWorkspace(name, gitAccountId?)`; a `ConfirmDialog` + `ContextMenu`-based delete in `WorkspaceList`.

Where a step extends a Phase-3 handler, it quotes the **shape** Phase 3 leaves and shows the exact lines to add. If, on landing, a referenced Phase-3 helper has a slightly different name, adapt the call site — the Phase-4 logic is unchanged.

---

### Task 1: Config — `accounts.json` schema + `keysDir`

**Files:**
- Modify: `packages/config/src/index.ts` (add after the `remotes.json` block, ~line 262; add path helpers near `daemonConfigPath`, ~line 87)

**Interfaces:**
- Produces: `accountsConfigSchema`, `AccountsConfig`, `createDefaultAccountsConfig()`, `parseAccountsConfig()`, `accountsConfigPath(baseDir)` → `<appdir>/daemon/accounts.json`, `keysDir(baseDir)` → `<appdir>/daemon/keys`.

- [ ] **Step 1: Add the two path helpers** — immediately after `daemonConfigPath` (~line 89):

```ts
export function accountsConfigPath(baseDir: string): string {
  return joinPath(daemonConfigDir(baseDir), "accounts.json");
}

/** Per-account SSH keys live here (created mode 0700 by the daemon). */
export function keysDir(baseDir: string): string {
  return joinPath(daemonConfigDir(baseDir), "keys");
}
```

- [ ] **Step 2: Add the accounts schema + helpers** — after the `parseRemotesConfig` block (~line 262), before the `ClientConfig` section:

```ts
// accounts.json (connected GitHub/git accounts; daemon-side).
//
// Each account owns a server-side ed25519 key (private key at `keyPath`, never
// returned by any API) and a git identity. The GitHub PAT used to connect is
// transient and is NEVER persisted here.

export const accountSchema = z.object({
  id: z.string(),
  /** User-facing label (e.g. "work", "personal"). */
  label: z.string().min(1),
  /** GitHub login the PAT authenticated as. */
  githubLogin: z.string(),
  /** `git config user.name` for this account (editable in the UI). */
  gitName: z.string(),
  /** `git config user.email` for this account (editable in the UI). */
  gitEmail: z.string(),
  /** OpenSSH public key (safe to expose). */
  publicKey: z.string(),
  /** Absolute path to the private key on the daemon host. NEVER exposed by any API. */
  keyPath: z.string(),
  /** Id of the key on GitHub (for later removal); absent if the upload id was unknown. */
  githubKeyId: z.number().optional(),
  createdAt: z.string()
});

export const accountsConfigSchema = z.object({
  version: z.literal(1).default(1),
  accounts: z.array(accountSchema).default([])
});

export type Account = z.infer<typeof accountSchema>;
export type AccountsConfig = z.infer<typeof accountsConfigSchema>;

export function createDefaultAccountsConfig(): AccountsConfig {
  return accountsConfigSchema.parse({ accounts: [] });
}

export function parseAccountsConfig(value: unknown): AccountsConfig {
  return accountsConfigSchema.parse(value);
}
```

- [ ] **Step 3: Typecheck**

Run: `pnpm check`
Expected: PASS. `@orquester/config` compiles in isolation (the new exports are additive; nothing consumes them yet). Other packages are unaffected.

- [ ] **Step 4: Commit**

```bash
git add packages/config/src/index.ts
git commit -m "feat(config): accounts.json schema + accountsConfigPath/keysDir helpers"
```

---

### Task 2: API contract — account types

**Files:**
- Modify: `packages/api/src/index.ts` (add after the `WorkspaceSummary`/`CreateWorkspaceRequest` block, ~line 56)

**Interfaces:**
- Produces: `AccountSummary` (the account **without** `keyPath`/`githubKeyId` — public metadata + public key only), `CreateAccountRequest`, `AccountTestResult`.

- [ ] **Step 1: Add the account types** — after `CreateWorkspaceRequest` (~line 56), before `CreateProjectRequest`:

```ts
/**
 * Public view of a connected git account. Deliberately omits `keyPath` and any
 * private-key material — the daemon never returns where/what the private key is.
 */
export interface AccountSummary {
  id: string;
  label: string;
  githubLogin: string;
  gitName: string;
  gitEmail: string;
  /** OpenSSH public key (safe to display/copy). */
  publicKey: string;
  createdAt: string;
}

export interface CreateAccountRequest {
  /** User-facing label; also used in the SSH key comment + GitHub key title. */
  label: string;
  /** GitHub PAT — used transiently to upload the key + read identity, then discarded. */
  token: string;
}

/** Result of `POST /api/accounts/:id/test` (an `ssh -T git@github.com` probe). */
export interface AccountTestResult {
  ok: boolean;
  /** GitHub login parsed from the "Hi <login>!" greeting, when ok. */
  login?: string;
  /** Human-readable detail (success greeting or failure reason). */
  message?: string;
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm check`
Expected: PASS. `@orquester/api` compiles; the new interfaces are additive and unused so far.

- [ ] **Step 3: Commit**

```bash
git add packages/api/src/index.ts
git commit -m "feat(api): AccountSummary + CreateAccountRequest + AccountTestResult"
```

---

### Task 3: Daemon `AccountsService` — keygen, GitHub connect, test, remove, bind

**Files:**
- Create: `apps/daemon/src/accounts.ts`

**Interfaces:**
- Consumes: `parseAccountsConfig`/`createDefaultAccountsConfig`/`type Account`/`type AccountsConfig` (Task 1); `AccountSummary`/`CreateAccountRequest`/`AccountTestResult` (Task 2). (`accountsConfigPath`/`keysDir` are resolved by the daemon in Task 4 and passed into the constructor.)
- Produces: `class AccountsService` (`constructor(configPath, keysDirPath)`) with `list()`, `add()`, `remove(id, boundWorkspaces)`, `test(id)`, and the binding helpers `writeIncludeFile(account)`, `bindWorkspace(accountId, workspaceDir)`, `unbindWorkspace(workspaceDir)`. `class AccountError extends Error { status: number }`.

- [ ] **Step 1: Create the file** with the full implementation:

```ts
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
```

- [ ] **Step 2: Typecheck**

Run: `pnpm check`
Expected: `@orquester/daemon` compiles (the service is self-contained; it's wired into routes in Task 4). `packages/config` + `packages/api` already clean.

- [ ] **Step 3: Commit**

```bash
git add apps/daemon/src/accounts.ts
git commit -m "feat(daemon): AccountsService (keygen, GitHub connect, test, bind/unbind)"
```

---

### Task 4: Daemon — accounts endpoints + `keysDir` in prepareDirs + workspace binding

**Files:**
- Modify: `apps/daemon/src/index.ts` (imports ~1-57; `ResolvedPaths` ~62-72 + its construction ~106-114; service construction ~120-141; `prepareDirs` ~966-970; the accounts routes after the remotes routes ~448; extend `POST /api/workspaces` ~379-388 and `DELETE /api/workspaces/:workspace` [Phase 3])

**Interfaces:**
- Consumes: `AccountsService`/`AccountError` (Task 3); `keysDir`/`accountsConfigPath` (Task 1); `AccountSummary`/`AccountTestResult`/`CreateAccountRequest` (Task 2); the Phase-3 `workspaces.json` read/write helpers + the existing `POST`/`DELETE /api/workspaces` handlers.
- Produces: `GET /api/accounts`, `POST /api/accounts`, `DELETE /api/accounts/:id`, `POST /api/accounts/:id/test` (all allowed over remote HTTP); `keysDir` created `0700`; workspace create binds when `gitAccountId` set; workspace delete unbinds.

- [ ] **Step 1: Import the new symbols.**

In the `@orquester/api` import block (top of file) add:

```ts
  AccountSummary,
  AccountTestResult,
  CreateAccountRequest,
```

In the `@orquester/config` import block add `accountsConfigPath` and `keysDir` to the named **value** imports (alongside `remotesConfigPath`).

Add a new import line after the `Broadcaster` import (~line 26):

```ts
import { AccountError, AccountsService } from "./accounts";
```

- [ ] **Step 2: Add `keysDir` + `accountsFile` to `ResolvedPaths`** — extend the interface (~62-72):

```ts
  workspacesDir: string;
  keysDir: string;
  accountsFile: string;
  logsDir: string;
```

and its construction in `startDaemon` (~106-114), after `remotesFile`:

```ts
    workspacesDir: expandVars(config.workspacesDir, paths.vars),
    keysDir: keysDir(paths.baseDir),
    accountsFile: accountsConfigPath(paths.baseDir),
    logsDir: expandVars(config.logsDir, paths.vars),
```

- [ ] **Step 3: Create `keysDir` with mode 0700 in `prepareDirs`** (~966-970):

```ts
async function prepareDirs(resolved: ResolvedPaths): Promise<void> {
  await mkdir(resolved.daemonDir, { recursive: true });
  await mkdir(resolved.logsDir, { recursive: true });
  await mkdir(resolved.workspacesDir, { recursive: true });
  await mkdir(resolved.keysDir, { recursive: true, mode: 0o700 });
}
```

- [ ] **Step 4: Construct the `AccountsService` and put it on `Services`.**

Add to the `Services` interface (~212-218):

```ts
  accounts: AccountsService;
```

In `startDaemon`, after `const sessions = new SessionManager(registry);` (~123):

```ts
  const accounts = new AccountsService(resolved.accountsFile, resolved.keysDir);
```

and include it in the `services` object (~141):

```ts
  const services: Services = { registry, sessions, accounts, broadcaster };
```

Then destructure it in `createServer` (~228):

```ts
  const { registry, sessions, accounts } = services;
```

- [ ] **Step 5: Add the accounts routes** — after the `PUT /api/config/remotes` route (~448), before the file-browser routes. Note: NO `mode === "remote"` guard (deliberate, scoped relaxation — see spec §4.4 / Security model point 6). The `:id/test` static suffix does not collide with `DELETE /api/accounts/:id`.

```ts
  // Connected git accounts. Unlike PUT /api/config/daemon (unix-socket-only),
  // these ARE allowed over remote HTTP: the transport is TLS + password gated,
  // and no response ever returns the private key or the PAT — an authenticated
  // client can create/bind accounts but cannot exfiltrate key material.
  app.get("/api/accounts", async (): Promise<AccountSummary[]> => accounts.list());

  app.post("/api/accounts", async (request, reply): Promise<AccountSummary | void> => {
    try {
      return await accounts.add((request.body ?? {}) as CreateAccountRequest);
    } catch (error) {
      const status = error instanceof AccountError ? error.status : 500;
      const message = error instanceof Error ? error.message : "Could not connect the account.";
      return reply.code(status).send({ code: "ACCOUNT_ERROR", message });
    }
  });

  app.delete<{ Params: { id: string } }>(
    "/api/accounts/:id",
    async (request, reply): Promise<void> => {
      try {
        const bound = (await readWorkspacesMeta(resolved.workspacesMetaFile)).workspaces
          .filter((w) => w.gitAccountId === request.params.id)
          .map((w) => w.name);
        await accounts.remove(request.params.id, bound);
        return reply.code(204).send();
      } catch (error) {
        const status = error instanceof AccountError ? error.status : 500;
        const message = error instanceof Error ? error.message : "Could not remove the account.";
        return reply.code(status).send({ code: "ACCOUNT_ERROR", message });
      }
    }
  );

  app.post<{ Params: { id: string } }>(
    "/api/accounts/:id/test",
    async (request, reply): Promise<AccountTestResult | void> => {
      try {
        return await accounts.test(request.params.id);
      } catch (error) {
        const status = error instanceof AccountError ? error.status : 500;
        const message = error instanceof Error ? error.message : "Could not test the account.";
        return reply.code(status).send({ code: "ACCOUNT_ERROR", message });
      }
    }
  );
```

> If the Phase-3 helper is named differently (e.g. `readWorkspacesConfig`) or `ResolvedPaths.workspacesMetaFile` differs, adapt the two references here; the rest is unchanged.

- [ ] **Step 6: Bind on workspace create.** Phase 3 leaves `POST /api/workspaces` writing the `workspaces.json` entry with `gitAccountId`. Extend it so that, **after** the metadata write, a bound workspace gets its `includeIf` rule. Add after the `await mkdir(path, ...)` + metadata write, before the `return`:

```ts
    // Bind the git account (immutable): write the include file + register the
    // global includeIf rule for this workspace's realpath. Best-effort — a
    // binding failure must not orphan the just-created dir/metadata.
    if (gitAccountId) {
      await services.accounts.bindWorkspace(gitAccountId, path).catch((error) => {
        app.log.error({ err: error }, "git account binding failed");
      });
    }
```

(where `gitAccountId` is read from the request body, the same value Phase 3 wrote into the metadata entry — i.e. `const { name, gitAccountId } = request.body as CreateWorkspaceRequest`).

- [ ] **Step 7: Unbind on workspace delete.** Phase 3's `DELETE /api/workspaces/:workspace` cascades sessions + prunes the metadata entry. Add the unbind alongside that cascade, using the resolved workspace path it already builds:

```ts
    await services.accounts.unbindWorkspace(workspacePath).catch(() => undefined);
```

(place it next to `closeByProjectPrefix` / `rm` in the Phase-3 handler; `workspacePath` = the `join(resolved.workspacesDir, workspace)` that handler computes.)

- [ ] **Step 8: Typecheck**

Run: `pnpm check`
Expected: `apps/daemon` compiles. If Phase 3's exact helper/path names differ, the only edits are the two references in Steps 5/7.

- [ ] **Step 9: Runtime verify against the running daemon** (dev daemon hot-reloads via `tsx watch`; bearer below).

```bash
# Bearer: against the CURRENT tree (hash-only auth) TOKEN is the bare passwordHash.
# If Phase 1 (username) has landed, instead use:  TOKEN=$(printf 'mapacho:%s' "$HASH" | base64)
HASH='$2b$10$d/t5uzBqvZnjBASDICtJue4H2cMlRPyFtvivvMcMhuHgfoFKxoINe'
TOKEN="$HASH"
B="http://127.0.0.1:47831"

# 1) list is empty (or shows existing) and NEVER contains keyPath:
curl -sS -H "Authorization: Bearer $TOKEN" "$B/api/accounts"; echo

# 2) connect with a REAL test PAT (scopes: write:public_key, user:email, read:user).
#    Replace ghp_xxx with a throwaway token on a test GitHub account.
ID=$(curl -sS -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"label":"verify","token":"ghp_xxx"}' "$B/api/accounts" \
  | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d.get("id",""));import sys;sys.stderr.write(json.dumps(d)+"\n")')
echo "created account id=$ID"

# 3) the public list must show login/email/publicKey but NO keyPath:
curl -sS -H "Authorization: Bearer $TOKEN" "$B/api/accounts" \
  | python3 -c 'import sys,json;a=json.load(sys.stdin);print("keyPath leaked!" if any("keyPath" in x for x in a) else "ok: no keyPath");print(a)'

# 4) test → should return the GitHub login:
curl -sS -X POST -H "Authorization: Bearer $TOKEN" "$B/api/accounts/$ID/test"; echo

# 5) delete (works only if not bound to any workspace):
curl -sS -o /dev/null -w "delete HTTP %{http_code}\n" -X DELETE -H "Authorization: Bearer $TOKEN" "$B/api/accounts/$ID"
```

Expected: (1)/(3) never contain `keyPath`; (2) returns `{id,label,githubLogin,gitName,gitEmail,publicKey,createdAt}` and the key now appears on the test GitHub account under *Settings → SSH keys* titled `orquester:verify`; (4) returns `{"ok":true,"login":"<your-login>", ...}`; (5) returns `204`. Then remember to remove the test key from GitHub manually (the PAT was not stored).

- [ ] **Step 10: Commit**

```bash
git add apps/daemon/src/index.ts
git commit -m "feat(daemon): accounts endpoints + keysDir 0700 + workspace git binding"
```

---

### Task 5: Client — `ApiClient` account methods

**Files:**
- Modify: `packages/ui/src/lib/api-client.ts` (import types ~1-19; methods in a new `// --- Accounts` block after `saveRemotes`, ~145)

**Interfaces:**
- Consumes: `AccountSummary`/`CreateAccountRequest`/`AccountTestResult` (Task 2); `this.send` (existing).
- Produces: `listAccounts()`, `createAccount(req)`, `removeAccount(id)`, `testAccount(id)`.

- [ ] **Step 1: Import the account types** — add to the `@orquester/api` import block:

```ts
  AccountSummary,
  AccountTestResult,
  CreateAccountRequest,
```

- [ ] **Step 2: Add the methods** — after `saveRemotes` (~145), in a new section (matching the `// --- … ---` divider style):

```ts
  // --- Git accounts (daemon-persisted; allowed over remote HTTP) -----------

  listAccounts(signal?: AbortSignal): Promise<AccountSummary[]> {
    return this.send("GET", "/api/accounts", { signal });
  }

  createAccount(req: CreateAccountRequest): Promise<AccountSummary> {
    return this.send("POST", "/api/accounts", { body: req });
  }

  removeAccount(id: string): Promise<void> {
    return this.send("DELETE", `/api/accounts/${encodeURIComponent(id)}`);
  }

  testAccount(id: string): Promise<AccountTestResult> {
    return this.send("POST", `/api/accounts/${encodeURIComponent(id)}/test`);
  }
```

- [ ] **Step 3: Typecheck**

Run: `pnpm check`
Expected: `packages/ui` compiles for `api-client.ts` (consumed by the store in Task 6).

- [ ] **Step 4: Commit**

```bash
git add packages/ui/src/lib/api-client.ts
git commit -m "feat(ui): api-client account methods (list/create/remove/test)"
```

---

### Task 6: Client store — accounts slice

**Files:**
- Modify: `packages/ui/src/store/app.ts` (re-export type ~12-22; `AppState` ~199-201 region; store state ~242-260; actions after `removeRemote` ~504)
- Modify: `packages/ui/src/types/index.ts` (re-export `AccountSummary`)

**Interfaces:**
- Consumes: `api.listAccounts`/`createAccount`/`removeAccount`/`testAccount` (Task 5).
- Produces: state `accounts: AccountSummary[]`; actions `loadAccounts()`, `addAccount({label, token}): Promise<AccountSummary>`, `removeAccount(id): Promise<void>`, `testAccount(id): Promise<AccountTestResult>`. Mirrors the remotes slice (load on connect, reload after mutate).

- [ ] **Step 1: Re-export `AccountSummary` from the types barrel** — add `AccountSummary` (and `AccountTestResult`) to both the `import type { … } from "@orquester/api"` list and the `export type { … }` list in `packages/ui/src/types/index.ts`.

- [ ] **Step 2: Import the types in the store** — add `AccountSummary` and `AccountTestResult` to the `from "../types"` import block (~12-22).

- [ ] **Step 3: Declare state + actions on `AppState`.**

Add to the data block (after `workspaces: WorkspaceSummary[];`, ~175):

```ts
  accounts: AccountSummary[];
```

Add to the connection-management action group (after `loadRemotes: () => Promise<void>;`, ~201):

```ts
  // git accounts (daemon-persisted; shared across clients of this daemon)
  loadAccounts: () => Promise<void>;
  addAccount: (input: { label: string; token: string }) => Promise<AccountSummary>;
  removeAccount: (id: string) => Promise<void>;
  testAccount: (id: string) => Promise<AccountTestResult>;
```

- [ ] **Step 4: Seed initial state** — add `accounts: [],` next to `workspaces: [],` (~253).

- [ ] **Step 5: Load accounts on connect** — in `initConnections`, extend the shared-config load (~380) to include accounts:

```ts
    await Promise.all([get().loadAppConfig(), get().loadRemotes(), get().loadAccounts()]);
```

- [ ] **Step 6: Implement the actions** — after `removeRemote` (~504), before `loadWorkspaces`. Accounts live on the active daemon (not the home daemon) because they are daemon-host-specific; use `get().api`:

```ts
  loadAccounts: async () => {
    const api = get().api;
    if (!api) {
      return;
    }
    try {
      set({ accounts: await api.listAccounts() });
    } catch {
      /* keep current (e.g. transport without the endpoint) */
    }
  },

  addAccount: async (input) => {
    const api = get().api;
    if (!api) {
      throw new Error("Not connected.");
    }
    const account = await api.createAccount({ label: input.label.trim(), token: input.token.trim() });
    await get().loadAccounts();
    return account;
  },

  removeAccount: async (id) => {
    await get().api?.removeAccount(id);
    await get().loadAccounts();
  },

  testAccount: async (id) => {
    const api = get().api;
    if (!api) {
      return { ok: false, message: "Not connected." };
    }
    return api.testAccount(id);
  },
```

- [ ] **Step 7: Reset accounts on connection switch** — in `selectConnection`, add `accounts: []` to the reset `set({...})` (~470-478), next to `sessions: []`.

- [ ] **Step 8: Typecheck**

Run: `pnpm check`
Expected: `packages/ui` compiles (store + api-client clean). `addAccount` rethrows so the panel can show GitHub errors.

- [ ] **Step 9: Commit**

```bash
git add packages/ui/src/store/app.ts packages/ui/src/types/index.ts
git commit -m "feat(ui): store accounts slice (load/add/remove/test) mirroring remotes"
```

---

### Task 7: UI — "GitHub" settings section (accounts panel)

**Files:**
- Modify: `packages/ui/src/components/settings/SettingsModal.tsx` (`Section` type + `SECTIONS` ~11-21; `renderSection` ~19-20; add a `GitHubSettings` component)

**Interfaces:**
- Consumes: store `accounts`/`loadAccounts`/`addAccount`/`removeAccount`/`testAccount` (Task 6); `Button`/`Input` (`../ui`); `Github`/`Plus`/`Trash2`/`Loader2`/`Check`/`X` (lucide-react). Mirrors the ServerSwitcher CRUD shape (list rows + per-row remove + inline add form).
- Produces: a new settings section listing accounts (login + git email, Test button + result, Trash to disconnect) and an Add form (label + PAT → Connect, with busy/error).

- [ ] **Step 1: Register the section.** Extend the `Section` union and `SECTIONS` array (~11-17), and `renderSection` (~19-20):

```ts
type Section = "app" | "agents" | "github" | "daemon";

const SECTIONS: { id: Section; label: string; icon: React.ReactNode; desc: string }[] = [
  { id: "app", label: "App", icon: <AppWindow size={16} />, desc: "Titlebar, runtime, active server" },
  { id: "agents", label: "Agents", icon: <Boxes size={16} />, desc: "Install, update and view harness versions" },
  { id: "github", label: "GitHub", icon: <Github size={16} />, desc: "Connect accounts and per-workspace git identities" },
  { id: "daemon", label: "Daemon", icon: <Server size={16} />, desc: "Workspaces dir, external HTTP access" }
];

const renderSection = (id: Section) =>
  id === "app" ? (
    <AppSettings />
  ) : id === "agents" ? (
    <AgentsSettings />
  ) : id === "github" ? (
    <GitHubSettings />
  ) : (
    <DaemonSettings />
  );
```

Add `Github` to the `lucide-react` import (line 2): `Boxes, Check, ChevronLeft, ChevronRight, Download, Github, Loader2, Plus, RefreshCw, Server, Trash2, X` (keep the existing names; add `Check, Github, Loader2, Plus, Trash2, X` if not already imported — `Loader2`/`RefreshCw`/`Download` already are).

- [ ] **Step 2: Load accounts when the section mounts + add the component.** Add `GitHubSettings` (e.g. after `AgentsSettings`, before `AppSettings`):

```tsx
const GitHubSettings: React.FC = () => {
  const accounts = useAppStore((s) => s.accounts);
  const loadAccounts = useAppStore((s) => s.loadAccounts);
  const addAccount = useAppStore((s) => s.addAccount);
  const removeAccount = useAppStore((s) => s.removeAccount);
  const testAccount = useAppStore((s) => s.testAccount);

  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Per-account test state, keyed by id.
  const [tests, setTests] = useState<Record<string, { ok: boolean; text: string } | "busy">>({});

  // Accounts load on connect; refresh on open in case another client changed them.
  useEffect(() => {
    void loadAccounts();
  }, [loadAccounts]);

  const connect = async () => {
    if (!label.trim() || !token.trim()) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await addAccount({ label, token });
      setAdding(false);
      setLabel("");
      setToken("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not connect the account.");
    } finally {
      setBusy(false);
    }
  };

  const runTest = async (id: string) => {
    setTests((t) => ({ ...t, [id]: "busy" }));
    const result = await testAccount(id);
    setTests((t) => ({
      ...t,
      [id]: { ok: result.ok, text: result.ok ? `Connected as ${result.login}` : result.message ?? "Failed" }
    }));
  };

  const disconnect = async (id: string) => {
    setError(null);
    try {
      await removeAccount(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not disconnect.");
    }
  };

  return (
    <div className="space-y-4">
      <div className="divide-y divide-neutral-800 rounded-lg border border-neutral-800">
        {accounts.length === 0 && (
          <p className="px-3 py-4 text-sm text-neutral-600">No accounts connected.</p>
        )}
        {accounts.map((account) => {
          const test = tests[account.id];
          return (
            <div key={account.id} className="group flex items-center gap-3 px-3 py-2.5">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center text-neutral-400">
                <Github size={18} />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-neutral-100">
                  {account.label}
                  <span className="ml-1.5 text-neutral-500">@{account.githubLogin}</span>
                </p>
                <p className="truncate text-xs text-neutral-500">{account.gitEmail}</p>
                {test && test !== "busy" && (
                  <p className={cn("truncate text-xs", test.ok ? "text-emerald-400" : "text-red-400")}>
                    {test.ok ? <Check size={11} className="mr-1 inline" /> : <X size={11} className="mr-1 inline" />}
                    {test.text}
                  </p>
                )}
              </div>
              <Button size="sm" variant="outline" disabled={test === "busy"} onClick={() => void runTest(account.id)}>
                {test === "busy" ? <Loader2 size={13} className="animate-spin" /> : null} Test
              </Button>
              <button
                type="button"
                aria-label="Disconnect account"
                className="flex h-7 w-7 items-center justify-center rounded text-neutral-500 hover:bg-neutral-800 hover:text-red-400"
                onClick={() => void disconnect(account.id)}
              >
                <Trash2 size={13} />
              </button>
            </div>
          );
        })}
      </div>

      {error && <p className="text-xs text-red-400">{error}</p>}

      {adding ? (
        <div className="space-y-2 rounded-lg border border-neutral-800 p-3">
          <Input placeholder="Label (e.g. work)" value={label} onChange={(e) => setLabel(e.target.value)} />
          <Input
            type="password"
            placeholder="GitHub PAT (write:public_key, user:email, read:user)"
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
          <p className="text-xs text-neutral-500">
            The token is used once to upload an SSH key and read your identity, then discarded. It is never stored.
          </p>
          <div className="flex gap-2">
            <Button size="sm" disabled={busy} onClick={() => void connect()}>
              {busy ? <Loader2 size={13} className="animate-spin" /> : null} Connect
            </Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => setAdding(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
          <Plus size={13} /> Add account…
        </Button>
      )}
    </div>
  );
};
```

- [ ] **Step 3: Typecheck**

Run: `pnpm check`
Expected: PASS for `packages/ui` (`cn`, `Button`, `Input`, `useAppStore` already imported in this file; verify `Check`, `Github`, `Loader2`, `Plus`, `Trash2`, `X` are all in the lucide import).

- [ ] **Step 4: Runtime verify in the browser** (Playwright via system Chrome, against the running web app).

Drive: open Settings → GitHub → "Add account…" → enter a label + a test PAT → Connect → confirm the row appears with `@login` + email; click Test → confirm "Connected as <login>"; screenshot. Confirm the PAT field is `type=password` and is cleared after connect.
Expected: account row renders; Test shows the login; no key material visible anywhere in the DOM/network beyond the public key.

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/components/settings/SettingsModal.tsx
git commit -m "feat(ui): GitHub settings section — connect/test/disconnect accounts"
```

---

### Task 8: UI — workspace creation modal with account picker

**Files:**
- Modify: `packages/ui/src/components/sidebar/WorkspaceList.tsx` (promote inline `NewItemInput` create to a `Modal` with name `Input` + account `Dropdown`; resolve `gitAccountId` → label for display)

**Interfaces:**
- Consumes: store `accounts` + `createWorkspace(name, gitAccountId?)` (Phase 3 + Task 6); `setSettingsOpen` (to jump to the panel); `Modal`/`ModalCloseButton`/`Input`/`Button`/`Dropdown`/`DropdownItem`/`DropdownLabel`/`DropdownSeparator` (`../ui`).
- Produces: a "New workspace" modal (name + account picker incl. "No account (default identity)" + "Add account…"); workspace rows show the bound account's label.

- [ ] **Step 1: Replace the file contents.** This keeps the Phase-3 delete affordance (context menu + `ConfirmDialog`) by leaving the row markup hookable; if Phase 3 added `onContextMenu` here, re-apply it to the `<button>` (noted inline). The create flow is promoted to a modal:

```tsx
import React, { useMemo, useState } from "react";
import { Check, Folder, FolderPlus, PanelLeftClose, Plus } from "lucide-react";
import { Button, Dropdown, DropdownItem, DropdownLabel, DropdownSeparator, IconButton, Input, Modal, ModalCloseButton } from "../ui";
import { useAppStore } from "../../store/app";

/** Root sidebar view: the list of workspace folders. */
export const WorkspaceList: React.FC = () => {
  const workspaces = useAppStore((s) => s.workspaces);
  const loading = useAppStore((s) => s.workspacesLoading);
  const accounts = useAppStore((s) => s.accounts);
  const openWorkspace = useAppStore((s) => s.openWorkspace);
  const createWorkspace = useAppStore((s) => s.createWorkspace);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen);

  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [accountId, setAccountId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // id → label, for rendering the bound account on each row.
  const accountLabel = useMemo(() => {
    const map = new Map(accounts.map((a) => [a.id, a.label] as const));
    return (id?: string | null) => (id ? map.get(id) ?? null : null);
  }, [accounts]);

  const close = () => {
    setCreating(false);
    setName("");
    setAccountId(null);
  };

  const submit = async () => {
    if (!name.trim()) {
      return;
    }
    setBusy(true);
    try {
      await createWorkspace(name.trim(), accountId ?? undefined);
      close();
    } finally {
      setBusy(false);
    }
  };

  const pickedLabel = accountId ? accountLabel(accountId) : "No account (default identity)";

  return (
    <>
      <div className="flex h-9 items-center gap-1 px-2">
        <IconButton label="Collapse sidebar" className="hidden md:flex" onClick={toggleSidebar}>
          <PanelLeftClose size={15} />
        </IconButton>
        <span className="flex-1 text-[10px] font-medium uppercase tracking-wider text-neutral-500">
          Workspaces
        </span>
        <IconButton label="New workspace" onClick={() => setCreating(true)}>
          <FolderPlus size={15} />
        </IconButton>
      </div>

      <nav className="flex-1 space-y-px overflow-y-auto px-2 pb-2">
        {loading && workspaces.length === 0 && (
          <p className="px-2 py-2 text-xs text-neutral-600">Loading…</p>
        )}
        {!loading && workspaces.length === 0 && (
          <p className="px-2 py-2 text-xs text-neutral-600">No workspaces yet</p>
        )}
        {workspaces.map((workspace) => {
          const label = accountLabel(workspace.gitAccountId);
          return (
            <button
              key={workspace.path}
              type="button"
              onClick={() => void openWorkspace(workspace.name)}
              // Phase 3 attaches onContextMenu here for the delete menu — re-apply it.
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-neutral-300 transition-colors hover:bg-neutral-800 hover:text-neutral-100"
            >
              <Folder size={15} className="text-neutral-500" />
              <span className="flex-1 truncate">{workspace.name}</span>
              {label && (
                <span className="truncate text-[10px] text-neutral-600" title={`git account: ${label}`}>
                  {label}
                </span>
              )}
              <span className="text-xs text-neutral-600">{workspace.projectCount}</span>
            </button>
          );
        })}
      </nav>

      <Modal open={creating} onClose={close} className="max-w-sm">
        <div className="flex w-full flex-col">
          <div className="flex h-12 shrink-0 items-center justify-between border-b border-neutral-800 px-4">
            <span className="text-sm font-medium text-neutral-100">New workspace</span>
            <ModalCloseButton onClose={close} />
          </div>
          <div className="space-y-3 p-4">
            <div className="space-y-1.5">
              <label className="text-xs text-neutral-400">Name</label>
              <Input
                autoFocus
                placeholder="workspace-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void submit()}
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs text-neutral-400">Git account</label>
              <Dropdown
                width="w-[--radix-none] w-72"
                trigger={
                  <span className="flex h-8 w-72 items-center justify-between rounded-md border border-neutral-700 bg-neutral-900 px-2.5 text-sm text-neutral-200">
                    <span className="truncate">{pickedLabel}</span>
                  </span>
                }
              >
                <DropdownLabel>Identity</DropdownLabel>
                <DropdownItem
                  icon={accountId === null ? <Check size={14} /> : <span className="h-2 w-2" />}
                  onClick={() => setAccountId(null)}
                >
                  No account (default identity)
                </DropdownItem>
                {accounts.map((account) => (
                  <DropdownItem
                    key={account.id}
                    icon={accountId === account.id ? <Check size={14} /> : <span className="h-2 w-2" />}
                    onClick={() => setAccountId(account.id)}
                  >
                    {account.label} <span className="text-neutral-500">@{account.githubLogin}</span>
                  </DropdownItem>
                ))}
                <DropdownSeparator />
                <DropdownItem
                  icon={<Plus size={14} />}
                  onClick={() => {
                    close();
                    setSettingsOpen(true);
                  }}
                >
                  Add account…
                </DropdownItem>
              </Dropdown>
              <p className="text-[11px] text-neutral-500">
                The git identity is bound to this workspace permanently. To change it, delete and recreate the workspace.
              </p>
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <Button size="sm" variant="outline" disabled={busy} onClick={close}>
                Cancel
              </Button>
              <Button size="sm" disabled={busy || !name.trim()} onClick={() => void submit()}>
                {busy ? "Creating…" : "Create"}
              </Button>
            </div>
          </div>
        </div>
      </Modal>
    </>
  );
};
```

> Note: the `width="w-[--radix-none] w-72"` is just a fixed `w-72`; if your `cn` flags the placeholder, use `width="w-72"`. The trigger width matches via the inline `w-72`.

- [ ] **Step 2: Typecheck**

Run: `pnpm check`
Expected: PASS. Relies on Phase-3 `createWorkspace(name, gitAccountId?)` + `WorkspaceSummary.gitAccountId`. If `NewItemInput` is now unused elsewhere, leave the file (other call sites — e.g. `ProjectList` — still use it).

- [ ] **Step 3: Runtime verify in the browser** (Playwright/manual).

Drive: with one account connected, click "New workspace" → type a name → open the picker → select the account → Create → confirm the workspace appears with the account label on its row. Open a terminal in a project inside it and run `git config user.email` → confirm it prints the account email. Then create a second workspace with "No account" → its terminal's `git config user.email` falls back to the global identity.
Expected: bound workspace's terminal reports the account identity; "No account" workspace uses the default.

- [ ] **Step 4: Commit**

```bash
git add packages/ui/src/components/sidebar/WorkspaceList.tsx
git commit -m "feat(ui): workspace-create modal with git account picker + row labels"
```

---

### Task 9: End-to-end verification (no code; document evidence)

**Files:** none (verification task — capture outputs; no commit unless fixing a regression).

- [ ] **Step 1: `pnpm check` is clean across the workspace.**

Run: `pnpm check`
Expected: PASS for `@orquester/config`, `@orquester/api`, `@orquester/daemon`, `@orquester/ui`.

- [ ] **Step 2: Connect → key on GitHub → identity correct.** Using the Task-4 curl block with a real test PAT, connect an account and confirm the key appears at GitHub *Settings → SSH and GPG keys* titled `orquester:<label>`. Confirm `GET /api/accounts` shows the account WITHOUT `keyPath`.

- [ ] **Step 3: `test` returns the login.**

Run: `curl -sS -X POST -H "Authorization: Bearer $TOKEN" "$B/api/accounts/$ID/test"`
Expected: `{"ok":true,"login":"<your-login>", ...}`.

- [ ] **Step 4: Bound workspace uses the account identity + key.** Create a workspace bound to the account (UI or curl `POST /api/workspaces` with `{"name":"e2e","gitAccountId":"<ID>"}`), make a project dir, and in a terminal there:

```bash
# in <workspacesDir>/e2e/<repo> after `git init` (or clone with a STANDARD URL):
git -C "<workspacesDir>/e2e/<repo>" config user.email   # → the account email
git -C "<workspacesDir>/e2e/<repo>" config user.name    # → the account name
git -C "<workspacesDir>/e2e/<repo>" config core.sshCommand  # → ssh -i <keyPath> -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new
```

Also confirm the global rule exists and is realpath+trailing-slash keyed:

```bash
HOME="${HOME}" git config --global --get-regexp 'includeIf\.gitdir:'   # shows the e2e rule
```

Expected: identity + `core.sshCommand` resolve to the account's; a `git clone git@github.com:<you>/<private-repo>.git` inside the workspace uses the right key (no host-key prompt thanks to `accept-new` + the Phase-0 `known_hosts` seed); a commit + push is authored as the account. Create a SECOND account/workspace and confirm no key cross-talk (the right `-i` key is offered, deterministic via `IdentitiesOnly=yes`).

- [ ] **Step 5: No secret leakage.** Confirm `GET /api/accounts` and `POST /api/accounts` responses contain only `{id,label,githubLogin,gitName,gitEmail,publicKey,createdAt}` — never `keyPath`, never the PAT. Grep the daemon log dir for the token (it must not appear).

- [ ] **Step 6: Delete blocked while bound.**

Run: `curl -sS -o /dev/null -w "%{http_code}\n" -X DELETE -H "Authorization: Bearer $TOKEN" "$B/api/accounts/$ID"`
Expected: `409` while a workspace is bound, with a body naming the using-workspace(s). Delete the bound workspace (UI delete / `DELETE /api/workspaces/e2e`) → its `includeIf` rule disappears from `~/.gitconfig` (`git config --global --get-regexp 'includeIf'` no longer lists it) → re-run the account delete → `204`. Then remove the test key from GitHub manually.

---

## Notes for the implementer

- **The dev daemon hot-reloads** via `tsx watch` (`pnpm dev:daemon`, appdir `./.stage`, `:47831`); the web dev server is `pnpm dev:web` (`:5173`). No restart needed after edits.
- **Bearer for curl checks:** the `.stage` daemon's `passwordHash` is `$2b$10$d/t5uzBqvZnjBASDICtJue4H2cMlRPyFtvivvMcMhuHgfoFKxoINe`.
  - Against the **current working tree** (auth is hash-only — Phase 1 username support is not present), `Authorization: Bearer <passwordHash>` works directly.
  - If **Phase 1 has landed** (the credential is `base64("<username>:<hash>")`), compute `TOKEN=$(printf 'mapacho:%s' "$HASH" | base64)` and use that. The Task-4 block has both forms.
- **Node 22 has global `fetch`** — do not import it; no `node-fetch` dependency.
- **`ssh-keygen`/`git`/`ssh`** must be on the daemon host's PATH (they are on the VPS per Phase 0). All three are invoked via `execFile` with arg arrays.
- **`known_hosts`** for `github.com` is seeded in Phase 0; `StrictHostKeyChecking=accept-new` in `core.sshCommand` + the `test`/bind ssh calls is the belt so the first push never hangs the PTY.
- **HOME pinning:** `AccountsService` uses `process.env.HOME ?? homedir()` for every `git`/`ssh` call so `--global` writes the same `~/.gitconfig` that PTY sessions read (sessions inherit `process.env`, `sessions.ts:54`). On the VPS, Phase 0's `daemon.env` sets `HOME=/var/lib/orquester`.
- **Phase 3 dependency (IMPORTANT — flag):** As of this writing the working tree does **not** contain the Phase-3 artifacts this plan builds on (`workspacesConfigSchema`/`workspacesMetaPath` in `packages/config`, `WorkspaceSummary.gitAccountId` / `CreateWorkspaceRequest.gitAccountId` in `packages/api`, the metadata-writing `POST /api/workspaces` + cascading `DELETE /api/workspaces/:workspace`, store `createWorkspace(name, gitAccountId?)`, and the `ConfirmDialog` delete). The prompt directs assuming Phase 3 has landed; **land Phase 3 first.** If a Phase-3 helper/path/field name differs from what's referenced here, the only adaptations needed are: the two `readWorkspacesMeta`/`workspacesMetaFile` references in Task 4 Step 5, the `gitAccountId` destructure + bind call in Task 4 Step 6, the `workspacePath` unbind in Task 4 Step 7, and the `WorkspaceSummary.gitAccountId` read in Task 8. (`ContextMenu` already exists from the tab-reorder work; `ConfirmDialog` is Phase 3's.)
- The accounts endpoints intentionally **omit** the `mode === "remote"` 403 guard that `PUT /api/config/daemon` keeps (`index.ts:310-316`) — this is the spec's decided, scoped relaxation (§4.4 / Security model point 6), safe because no response returns key material and the PAT is never stored.
