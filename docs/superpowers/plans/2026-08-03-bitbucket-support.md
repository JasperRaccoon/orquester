# Bitbucket Cloud + Server/DC Provider Support — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Bitbucket Cloud and Bitbucket Server/Data Center as first-class git-hosting providers at full parity with GitHub (account connect, SSH key auto-upload, repo picker, clone, create-repo), per `docs/superpowers/specs/2026-08-03-bitbucket-support-design.md`.

**Architecture:** A `GitProvider` interface with per-provider modules under `apps/daemon/src/providers/` behind the existing `AccountsService`, which keeps the provider-agnostic lifecycle (keygen, `includeIf` binding, credential files). The account schema gains a `provider` discriminant with a zod-preprocess migration. UI renames the GitHub settings section to "Git hosting" with a provider picker.

**Tech Stack:** TypeScript 5.8 ESM, zod, Fastify 4, `node:test` + tsx (daemon tests), React 18 + zustand (UI), undici `Agent` for custom-CA fetch.

## Global Constraints

- **Never launch/restart/stop the daemon** (AGENTS.md ⛔). Verify with `pnpm check` + unit tests + code review only.
- Commit to the **current branch as-is** (no new branches) — AGENTS.md Git rule.
- `pnpm check` (repo root) must be clean before every commit.
- Daemon tests: `pnpm --filter @orquester/daemon test` (all) or, from `apps/daemon/`, `node --import tsx --test src/<file>.test.ts` (one file).
- ESM everywhere; no daemon build step (tsx runs TS directly).
- Secrets never cross the wire: tokens, private keys, CA file **paths** ok in summaries but never key/token material. `toSummary()` is the only egress.
- All git/ssh invocations via `execFile` arg arrays, `HOME` pinned (existing `AccountsService` invariants).
- Persisted-shape changes need tolerant parsing (zod preprocess/defaults) — old `accounts.json` files must load unchanged.
- Provider id strings are exactly: `"github"`, `"bitbucket-cloud"`, `"bitbucket-server"`.
- Bitbucket Cloud REST base: `https://api.bitbucket.org/2.0`; git HTTPS username: literal `x-bitbucket-api-token-auth`; SSH host: always `ssh.bitbucket.org` (rewrite `bitbucket.org` — old host dies 2026-11-12).
- Bitbucket DC: REST via `Authorization: Bearer`; **never derive clone URLs** — read `links.clone[]`; tolerate `name:"http"` meaning https; absent `ssh` entry ⇒ HTTPS-only.

## File Structure

| File | Responsibility |
|---|---|
| `packages/config/src/index.ts` | account schema: provider fields + legacy migration |
| `packages/api/src/index.ts` | wire types: `AccountSummary` (+provider/host/login/mirror), `CreateAccountRequest` union, `OwnerSummary`, `RepoSummary.httpsUrl`, reference client |
| `apps/daemon/src/account-error.ts` | `AccountError` moved out of `accounts.ts` (avoids provider↔accounts import cycle) |
| `apps/daemon/src/providers/types.ts` | `GitProvider` interface + shared types + `buildCredentialFileLine` |
| `apps/daemon/src/providers/github.ts` | GitHub impl (absorbs `repos.ts` + REST bits of `accounts.ts`) |
| `apps/daemon/src/providers/bitbucket-cloud.ts` | Bitbucket Cloud impl |
| `apps/daemon/src/providers/bitbucket-server.ts` | Bitbucket DC impl (CA-aware fetch, probe) |
| `apps/daemon/src/providers/index.ts` | `providerFor()` registry |
| `apps/daemon/src/known-hosts.ts` | daemon-owned known_hosts file: path + seeding |
| `apps/daemon/src/accounts.ts` | generic lifecycle; delegates provider specifics |
| `apps/daemon/src/repos.ts` | **deleted** (absorbed into `providers/github.ts`) |
| `apps/daemon/src/index.ts` | routes: create-account union, owners, confirm-key, provider-aware clone |
| `packages/ui/src/lib/api-client.ts`, `store/app.ts` | client plumbing (`listOwners`, `confirmAccountKey`, widened `addAccount`) |
| `packages/ui/src/icons/Bitbucket.tsx` | Bitbucket glyph (lucide has none) |
| `packages/ui/src/components/settings/SettingsModal.tsx` | `GitHubSettings` → `GitHostingSettings` (provider picker, DC fields, expiry, manual-key modal) |
| `packages/ui/src/components/sidebar/WorkspaceList.tsx`, `NewProjectModal.tsx` | provider-aware labels/placeholders/owners |

Tests live in `apps/daemon/src/*.test.ts` (existing pattern; `node:test` + tsx). UI has no test runner — typecheck + review.

---

### Task 1: Account schema — provider fields + legacy migration

**Files:**
- Modify: `packages/config/src/index.ts:429-478`
- Test: `apps/daemon/src/accounts-schema.test.ts` (create)

**Interfaces:**
- Produces: `Account` gains `provider: "github"|"bitbucket-cloud"|"bitbucket-server"`, `login: string`, and optional `loginRef`, `email`, `baseUrl`, `caCertPath`, `sshHost`, `tokenExpiresAt`, `remoteKeyId: string`, `keyUploadPending: boolean`. Legacy `githubLogin`/`githubKeyId` payloads migrate transparently. Exports `gitProviderIdSchema`, type `GitProviderId`.

- [ ] **Step 1: Write the failing test** — `apps/daemon/src/accounts-schema.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { parseAccountsConfig } from "@orquester/config";

const legacyAccount = {
  id: "a1", label: "work", githubLogin: "octo", gitName: "Octo", gitEmail: "o@x.com",
  publicKey: "ssh-ed25519 AAAA octo", keyPath: "/keys/a1", githubKeyId: 123,
  token: "ghp_x", createdAt: "2025-01-01T00:00:00.000Z"
};

test("legacy github account payload migrates (githubLogin→login, githubKeyId→remoteKeyId, provider default)", () => {
  const cfg = parseAccountsConfig({ version: 1, accounts: [legacyAccount] });
  const a = cfg.accounts[0];
  assert.equal(a.provider, "github");
  assert.equal(a.login, "octo");
  assert.equal(a.remoteKeyId, "123");
  assert.equal((a as Record<string, unknown>).githubLogin, undefined);
});

test("new-shape bitbucket-server account round-trips", () => {
  const cfg = parseAccountsConfig({ version: 1, accounts: [{
    id: "b1", label: "corp", provider: "bitbucket-server", login: "jdoe",
    loginRef: "jdoe", baseUrl: "https://bb.corp.com/bitbucket",
    caCertPath: "/keys/b1.ca.pem", sshHost: "bb.corp.com:7999",
    gitName: "J Doe", gitEmail: "j@corp.com", publicKey: "ssh-ed25519 AAAA j",
    keyPath: "/keys/b1", token: "t", tokenExpiresAt: "2027-01-01T00:00:00.000Z",
    createdAt: "2026-08-03T00:00:00.000Z"
  }] });
  const a = cfg.accounts[0];
  assert.equal(a.provider, "bitbucket-server");
  assert.equal(a.baseUrl, "https://bb.corp.com/bitbucket");
  assert.equal(a.sshHost, "bb.corp.com:7999");
});

test("already-migrated payload is untouched (idempotent)", () => {
  const once = parseAccountsConfig({ version: 1, accounts: [legacyAccount] });
  const twice = parseAccountsConfig(JSON.parse(JSON.stringify(once)));
  assert.deepEqual(twice, once);
});
```

- [ ] **Step 2: Run to verify it fails** — from `apps/daemon/`: `node --import tsx --test src/accounts-schema.test.ts` → FAIL (`provider` undefined / `login` invalid).

- [ ] **Step 3: Implement** — in `packages/config/src/index.ts`, replace `accountSchema`/`parseAccountsConfig` (keep the doc banner, generalize its wording from "GitHub PAT" to "provider token"):

```ts
export const gitProviderIdSchema = z.enum(["github", "bitbucket-cloud", "bitbucket-server"]);
export type GitProviderId = z.infer<typeof gitProviderIdSchema>;

export const accountSchema = z.object({
  id: z.string(),
  /** User-facing label (e.g. "work", "personal"). */
  label: z.string().min(1),
  /** Which forge this account belongs to. Legacy records default to github. */
  provider: gitProviderIdSchema.default("github"),
  /** Provider login (GitHub login, Bitbucket nickname, DC username). */
  login: z.string(),
  /** Secondary id some APIs need: BB Cloud account UUID (braces included), DC user slug. */
  loginRef: z.string().optional(),
  /** BB Cloud only: Atlassian account email (REST Basic auth username). */
  email: z.string().optional(),
  /** bitbucket-server only: instance base URL including any context path. */
  baseUrl: z.string().optional(),
  /** bitbucket-server only: absolute path to a PEM CA bundle under keys/. */
  caCertPath: z.string().optional(),
  /** Resolved SSH endpoint, "host" or "host:port" (e.g. "ssh.bitbucket.org", "bb.corp.com:7999"). */
  sshHost: z.string().optional(),
  /** ISO expiry of the stored token (Bitbucket tokens always expire; user-entered). */
  tokenExpiresAt: z.string().optional(),
  /** `git config user.name` for this account. */
  gitName: z.string(),
  /** `git config user.email` for this account. */
  gitEmail: z.string(),
  /** OpenSSH public key (safe to expose). */
  publicKey: z.string(),
  /** Absolute path to the private key on the daemon host. NEVER exposed by any API. */
  keyPath: z.string(),
  /** Id of the uploaded key on the provider (GitHub numeric id / BB key UUID), for later removal. */
  remoteKeyId: z.string().optional(),
  /** True while a DC instance rejected token key-upload and the user must paste the key manually. */
  keyUploadPending: z.boolean().optional(),
  /** Provider token at rest (0600); NEVER exposed by any API. */
  token: z.string().optional(),
  createdAt: z.string()
});

/** Migrates pre-provider records: githubLogin→login, githubKeyId→remoteKeyId (stringified). */
const legacyAccountPreprocess = z.preprocess((value) => {
  if (!value || typeof value !== "object") return value;
  const rec = { ...(value as Record<string, unknown>) };
  if (typeof rec.githubLogin === "string" && typeof rec.login !== "string") {
    rec.login = rec.githubLogin;
  }
  delete rec.githubLogin;
  if (typeof rec.githubKeyId === "number" && rec.remoteKeyId === undefined) {
    rec.remoteKeyId = String(rec.githubKeyId);
  }
  delete rec.githubKeyId;
  return rec;
}, accountSchema);

export const accountsConfigSchema = z.object({
  version: z.literal(1).default(1),
  accounts: z.array(legacyAccountPreprocess).default([])
});
```

(`Account`, `AccountsConfig`, `createDefaultAccountsConfig`, `parseAccountsConfig` stay as-is — they now flow through the preprocess.)

- [ ] **Step 4: Run to verify it passes** — same command → 3 PASS.
- [ ] **Step 5: `pnpm check`** — expect **type errors** where `githubLogin`/`githubKeyId` are still read (`accounts.ts`, `repos.ts` untouched yet is fine — they use their own types; the failures will be in `accounts.ts` `toSummary`/`add`). Fix ONLY the mechanical renames inside `apps/daemon/src/accounts.ts`: `account.githubLogin` → `account.login`, `githubKeyId: upload.id` → `remoteKeyId: String(upload.id)` (and the `Account` literal fields `provider: "github" as const, login, remoteKeyId`). Behavior unchanged.
- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat(config): provider-discriminated account schema with legacy migration"`

---

### Task 2: Wire types + reference client

**Files:**
- Modify: `packages/api/src/index.ts:96-167` (types), `:1137-1160` (reference client)
- Modify: `packages/ui/src/lib/api-client.ts:244-277` (only if typecheck requires the rename)

**Interfaces:**
- Produces (consumed by every later task):

```ts
export type GitProviderId = "github" | "bitbucket-cloud" | "bitbucket-server";

export interface AccountSummary {
  id: string; label: string;
  provider: GitProviderId;
  login: string;
  /** @deprecated mirror of `login` for stale clients. */
  githubLogin: string;
  /** Display host ("github.com", "bitbucket.org", or the DC host[:port]). */
  host: string;
  gitName: string; gitEmail: string; publicKey: string;
  repoAccess: boolean;
  tokenExpiresAt?: string;
  /** DC manual key-upload pending; `manualKeyUrl` deep-links the paste page. */
  keyPending?: boolean;
  manualKeyUrl?: string;
  createdAt: string;
}

export type CreateAccountRequest =
  | { provider?: "github"; label: string; token: string }
  | { provider: "bitbucket-cloud"; label: string; email: string; token: string; tokenExpiresAt?: string }
  | { provider: "bitbucket-server"; label: string; baseUrl: string; username: string; token: string;
      caCertPem?: string; tokenExpiresAt?: string };

export interface OwnerSummary { id: string; label: string; kind: "user" | "org" | "workspace" | "project" }
```

- [ ] **Step 1: Edit types** — apply the block above in place of the current `AccountSummary`/`CreateAccountRequest` (keep `AccountTestResult` as-is but reword its doc to "an `ssh -T` probe against the account's provider"). Add to `RepoSummary`: `/** HTTPS clone URL (fallback transport when SSH is unavailable). */ httpsUrl?: string;` and generalize `sshUrl`'s doc to "SSH clone URL (provider-specific form)". Reword `CreateProjectRequest`'s doc "GitHub account" → "git account".
- [ ] **Step 2: Reference client** — in `HttpOrquesterApiClient` rename `listOrgs` → `listOwners(accountId): Promise<OwnerSummary[]>` (same `GET /api/accounts/${id}/orgs` path).
- [ ] **Step 3: `pnpm check`** — fix fallout mechanically: `packages/ui/src/lib/api-client.ts` `listOrgs` → `listOwners` returning `OwnerSummary[]`; `store/app.ts` and `NewProjectModal.tsx`/`WorkspaceList.tsx`/`SettingsModal.tsx` references `account.githubLogin` → `account.login` (UI behavior identical since daemon mirrors both — full UI rework comes in Tasks 11–13; here only make types compile, keep `listOrgs` store action delegating to `api.listOwners` and mapping `owners.map(o => o.id)` so the modal's `string[]` state still works).
- [ ] **Step 4: Commit** — `git commit -am "feat(api): provider-aware account wire types + OwnerSummary"`

---

### Task 3: `AccountError` extraction + provider types + registry

**Files:**
- Create: `apps/daemon/src/account-error.ts`, `apps/daemon/src/providers/types.ts` (`providers/index.ts` is created in Task 4, when the first provider exists)
- Modify: `apps/daemon/src/accounts.ts:23-31` (re-export)
- Test: `apps/daemon/src/providers/credential-line.test.ts` (create)

**Interfaces:**
- Produces:

```ts
// account-error.ts (moved verbatim from accounts.ts L23-31)
export class AccountError extends Error { constructor(public readonly status: number, message: string) { super(message); } }

// providers/types.ts
export interface ProviderCreds { token: string; email?: string; baseUrl?: string; username?: string; caCertPath?: string }
export interface ProviderIdentity { login: string; loginRef?: string; name: string; email: string }
export interface KeyUpload { keyId?: string; manualUrl?: string }
export interface ParsedRepo { owner: string; repo: string }
export interface CloneUrls { ssh?: string; https: string }
export interface CredentialSpec { host: string; username: string }
export interface SshProbe { target: string; port?: number; parse: (text: string) => { ok: boolean; login?: string; message?: string } }
export interface CreateRepoOpts { owner: string; name: string; visibility: "private" | "public"; description?: string }
export interface UrlContext { baseUrl?: string; sshHost?: string }

export interface GitProvider {
  readonly id: GitProviderId;                       // from @orquester/api
  readonly scopesHint: string;
  getIdentity(creds: ProviderCreds): Promise<ProviderIdentity>;
  uploadSshKey(creds: ProviderCreds, identity: ProviderIdentity, publicKey: string, label: string): Promise<KeyUpload>;
  findSshKey(creds: ProviderCreds, identity: ProviderIdentity, publicKey: string): Promise<{ keyId: string } | null>;
  removeSshKey(creds: ProviderCreds, identity: ProviderIdentity, keyId: string): Promise<void>;
  listRepos(creds: ProviderCreds): Promise<RepoSummary[]>;
  listOwners(creds: ProviderCreds, identity: ProviderIdentity): Promise<OwnerSummary[]>;
  createRepo(creds: ProviderCreds, identity: ProviderIdentity, opts: CreateRepoOpts): Promise<RepoSummary>;
  parseRepoUrl(input: string, ctx: UrlContext): ParsedRepo | null;
  cloneUrls(creds: ProviderCreds, ref: ParsedRepo): Promise<CloneUrls>;
  sshProbe(ctx: UrlContext & { login: string }): SshProbe | null;
  credentialSpec(ctx: UrlContext & { login: string; email?: string }): CredentialSpec;
}

/** One git-credential-store line; username+token percent-encoded. */
export function buildCredentialFileLine(spec: CredentialSpec, token: string): string {
  return `https://${encodeURIComponent(spec.username)}:${encodeURIComponent(token)}@${spec.host}\n`;
}

// providers/index.ts
export function providerFor(id: GitProviderId): GitProvider  // throws AccountError(500) on unknown
```

- [ ] **Step 1: Failing test** — `apps/daemon/src/providers/credential-line.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { buildCredentialFileLine } from "./types";

test("encodes reserved characters in username and token", () => {
  assert.equal(
    buildCredentialFileLine({ host: "bitbucket.org", username: "x-bitbucket-api-token-auth" }, "AT+A/T=T"),
    "https://x-bitbucket-api-token-auth:AT%2BA%2FT%3DT@bitbucket.org\n"
  );
});

test("keeps a DC port in the host", () => {
  assert.equal(
    buildCredentialFileLine({ host: "bb.corp.com:8443", username: "jdoe" }, "tok"),
    "https://jdoe:tok@bb.corp.com:8443\n"
  );
});
```

- [ ] **Step 2: Run → FAIL** (module not found).
- [ ] **Step 3: Implement** — create `account-error.ts` and `providers/types.ts` exactly per the Interfaces block. In `accounts.ts` delete the local `AccountError` class and add `export { AccountError } from "./account-error";` at the top (all existing `index.ts` imports keep working).
- [ ] **Step 4: Run → PASS**, then `pnpm check`.
- [ ] **Step 5: Commit** — `git commit -am "feat(daemon): GitProvider interface, AccountError extraction, credential-line builder"`

---

### Task 4: `providers/github.ts` — absorb `repos.ts` + GitHub REST

**Files:**
- Create: `apps/daemon/src/providers/github.ts`, `apps/daemon/src/providers/index.ts`
- Delete: `apps/daemon/src/repos.ts`
- Modify: `apps/daemon/src/accounts.ts` (imports of `./repos` → `./providers/github`)
- Test: `apps/daemon/src/providers/github.test.ts` (create)

**Interfaces:**
- Consumes: Task 3 types.
- Produces: `githubProvider: GitProvider` (id `"github"`); `providerFor("github")` works.

- [ ] **Step 1: Failing test** — `apps/daemon/src/providers/github.test.ts` (pure parts only):

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { githubProvider } from "./github";

test("parseRepoUrl accepts https, ssh and shorthand forms", () => {
  const ctx = {};
  assert.deepEqual(githubProvider.parseRepoUrl("https://github.com/o/r", ctx), { owner: "o", repo: "r" });
  assert.deepEqual(githubProvider.parseRepoUrl("git@github.com:o/r.git", ctx), { owner: "o", repo: "r" });
  assert.deepEqual(githubProvider.parseRepoUrl("o/r", ctx), { owner: "o", repo: "r" });
  assert.equal(githubProvider.parseRepoUrl("https://bitbucket.org/o/r", ctx), null);
});

test("credentialSpec and sshProbe match today's behavior", () => {
  assert.deepEqual(githubProvider.credentialSpec({ login: "octo" }), { host: "github.com", username: "octo" });
  const probe = githubProvider.sshProbe({ login: "octo" })!;
  assert.equal(probe.target, "git@github.com");
  assert.deepEqual(probe.parse("Hi octo! You've successfully authenticated"), { ok: true, login: "octo", message: "Hi octo! You've successfully authenticated" });
});

test("cloneUrls derives both transports", async () => {
  assert.deepEqual(await githubProvider.cloneUrls({ token: "t" }, { owner: "o", repo: "r" }),
    { ssh: "git@github.com:o/r.git", https: "https://github.com/o/r.git" });
});
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement `providers/github.ts`** — move code, don't rewrite:
  - Move from `repos.ts` (then delete the file): the `github()` fetch helper, `toRepoSummary`, `nextPageUrl`, `listRepos`, `listOrgs`, `createRepo`, `GITHUB_API` — verbatim, adjusting only the `AccountError` import to `../account-error`. In `toRepoSummary` additionally set `httpsUrl: repo.clone_url` (GitHub JSON field).
  - Implement the `GitProvider` methods on an exported `githubProvider` object:
    - `getIdentity(creds)` — port the `GET /user` + `GET /user/emails` + noreply-fallback logic from `accounts.ts add()` L147–178 verbatim (returns `{ login, name, email }`).
    - `uploadSshKey` — `POST /user/keys {title: label, key}` (from `add()` L140-143); return `{ keyId: String(upload.id) }` when numeric, else `{}`.
    - `findSshKey` — `GET /user/keys`, match entry whose `key` field equals the first two space-separated fields of `publicKey`; return `{ keyId: String(id) }` or null.
    - `removeSshKey` — `DELETE /user/keys/${keyId}`.
    - `listOwners(creds, identity)` — `[{ id: identity.login, label: identity.login, kind: "user" }, ...orgs.map(o => ({ id: o, label: o, kind: "org" }))]` using the moved `listOrgs`.
    - `createRepo(creds, identity, opts)` — the moved `createRepo(token, {...opts, login: identity.login})`, mapped through `toRepoSummary`.
    - `parseRepoUrl` — port the three regexes from `index.ts` `normalizeRepoUrl` L3775-3777 returning `{owner, repo}` instead of an SSH string.
    - `cloneUrls` — `{ ssh: \`git@github.com:${owner}/${repo}.git\`, https: \`https://github.com/${owner}/${repo}.git\` }`.
    - `sshProbe({login})` — `{ target: "git@github.com", parse: text => { const m = /Hi ([^!]+)!/.exec(text); return m ? { ok: true, login: m[1], message: text.slice(0,200) } : { ok: false, message: text.slice(0,200) || "No greeting from GitHub." }; } }`.
    - `credentialSpec({login})` — `{ host: "github.com", username: login }`.
    - `scopesHint = "write:public_key, user:email, read:user, repo, read:org"`.
  - Create `providers/index.ts`:

```ts
import type { GitProviderId } from "@orquester/api";
import { AccountError } from "../account-error";
import type { GitProvider } from "./types";
import { githubProvider } from "./github";

const REGISTRY: Partial<Record<GitProviderId, GitProvider>> = { github: githubProvider };

export function providerFor(id: GitProviderId): GitProvider {
  const provider = REGISTRY[id];
  if (!provider) throw new AccountError(500, `Unknown git provider: ${id}`);
  return provider;
}
```

  - In `accounts.ts`: replace `import * as repos from "./repos"` (or named imports) with `import { githubProvider } from "./providers/github"` and route `listRepos`/`listOrgs`/`createRepo` through it (`listOrgs` still returns `string[]` here; route/API switch happens in Task 9). **Do not** refactor `add()`/`setToken()`/`test()` yet.
- [ ] **Step 4: Run → PASS**; `pnpm --filter @orquester/daemon test` (all green); `pnpm check`.
- [ ] **Step 5: Commit** — `git commit -am "refactor(daemon): absorb repos.ts into providers/github implementing GitProvider"`

---

### Task 5: `providers/bitbucket-cloud.ts`

**Files:**
- Create: `apps/daemon/src/providers/bitbucket-cloud.ts`
- Modify: `apps/daemon/src/providers/index.ts` (register)
- Test: `apps/daemon/src/providers/bitbucket-cloud.test.ts` (create)

**Interfaces:**
- Consumes: Task 3 types.
- Produces: `bitbucketCloudProvider: GitProvider` (id `"bitbucket-cloud"`); exported pure helpers `parseCloudRepoUrl`, `toCloudRepoSummary` for tests.

- [ ] **Step 1: Failing test:**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { bitbucketCloudProvider, toCloudRepoSummary } from "./bitbucket-cloud";

test("parseRepoUrl accepts bitbucket.org https/ssh (old + new host)/shorthand", () => {
  const ctx = {};
  assert.deepEqual(bitbucketCloudProvider.parseRepoUrl("https://bitbucket.org/ws/r", ctx), { owner: "ws", repo: "r" });
  assert.deepEqual(bitbucketCloudProvider.parseRepoUrl("git@bitbucket.org:ws/r.git", ctx), { owner: "ws", repo: "r" });
  assert.deepEqual(bitbucketCloudProvider.parseRepoUrl("git@ssh.bitbucket.org:ws/r.git", ctx), { owner: "ws", repo: "r" });
  assert.deepEqual(bitbucketCloudProvider.parseRepoUrl("ws/r", ctx), { owner: "ws", repo: "r" });
  assert.equal(bitbucketCloudProvider.parseRepoUrl("https://github.com/o/r", ctx), null);
});

test("cloneUrls always emits the NEW ssh host", async () => {
  assert.deepEqual(await bitbucketCloudProvider.cloneUrls({ token: "t" }, { owner: "ws", repo: "r" }),
    { ssh: "git@ssh.bitbucket.org:ws/r.git", https: "https://bitbucket.org/ws/r.git" });
});

test("toCloudRepoSummary rewrites the API's (possibly stale) ssh host and maps fields", () => {
  const s = toCloudRepoSummary({
    full_name: "ws/r", slug: "r", is_private: true, mainbranch: { name: "main" }, description: null,
    links: { clone: [
      { name: "https", href: "https://user@bitbucket.org/ws/r.git" },
      { name: "ssh", href: "git@bitbucket.org:ws/r.git" }
    ] }
  });
  assert.equal(s.sshUrl, "git@ssh.bitbucket.org:ws/r.git");
  assert.equal(s.httpsUrl, "https://bitbucket.org/ws/r.git");   // credentials stripped from href
  assert.equal(s.fullName, "ws/r");
  assert.equal(s.owner, "ws");
  assert.equal(s.private, true);
  assert.equal(s.defaultBranch, "main");
});

test("credentialSpec uses the static token username; sshProbe parses the Cloud greeting", () => {
  assert.deepEqual(bitbucketCloudProvider.credentialSpec({ login: "nick" }),
    { host: "bitbucket.org", username: "x-bitbucket-api-token-auth" });
  const probe = bitbucketCloudProvider.sshProbe({ login: "nick" })!;
  assert.equal(probe.target, "git@ssh.bitbucket.org");
  assert.equal(probe.parse("authenticated via ssh key.\nYou can use git to connect to Bitbucket. logged in as nick.").ok, true);
});
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** — full module:

```ts
import type { OwnerSummary, RepoSummary } from "@orquester/api";
import { AccountError } from "../account-error";
import type { CloneUrls, CreateRepoOpts, CredentialSpec, GitProvider, KeyUpload,
  ParsedRepo, ProviderCreds, ProviderIdentity, SshProbe, UrlContext } from "./types";

const API = "https://api.bitbucket.org/2.0";
const SSH_HOST = "ssh.bitbucket.org";
export const CLOUD_GIT_USERNAME = "x-bitbucket-api-token-auth";
const SCOPES = "read:repository, write:repository, read:workspace, read:user, read:ssh-key, write:ssh-key (all :bitbucket, on a SCOPED API token)";

function authHeader(creds: ProviderCreds): string {
  // Atlassian API tokens authenticate REST via Basic email:token — NOT Bearer.
  return "Basic " + Buffer.from(`${creds.email ?? ""}:${creds.token}`).toString("base64");
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function bb(creds: ProviderCreds, method: string, pathOrUrl: string, body?: unknown, retry = 2): Promise<any> {
  const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${API}${pathOrUrl}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: authHeader(creds),
      Accept: "application/json",
      "User-Agent": "orquester",
      ...(body ? { "Content-Type": "application/json" } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  if (res.status === 429 && retry > 0) {
    // Bitbucket REST has a ~1,000 req/h floor — back off and retry.
    await sleep((3 - retry) * 2000);
    return bb(creds, method, pathOrUrl, body, retry - 1);
  }
  if (!res.ok) {
    const text = (await res.text().catch(() => "")).slice(0, 200);
    const hint = res.status === 401 || res.status === 403
      ? ` (use a SCOPED Atlassian API token — plain tokens fail; scopes: ${SCOPES}; REST username is your Atlassian account EMAIL)` : "";
    throw new AccountError(res.status === 401 || res.status === 403 ? 400 : 502,
      `Bitbucket ${method} ${pathOrUrl} → ${res.status}${hint}. ${text}`);
  }
  return res.status === 204 ? undefined : res.json();
}

/** Follows Bitbucket's `{values, next}` pagination. */
async function bbAll(creds: ProviderCreds, firstPath: string): Promise<any[]> {
  const out: any[] = [];
  let url: string | undefined = firstPath;
  while (url) {
    const page = await bb(creds, "GET", url);
    out.push(...(page.values ?? []));
    url = page.next;
  }
  return out;
}

export function toCloudRepoSummary(repo: any): RepoSummary {
  const fullName: string = repo.full_name;
  const [owner] = fullName.split("/");
  const clones: Array<{ name: string; href: string }> = repo.links?.clone ?? [];
  const httpsRaw = clones.find(c => c.name === "https")?.href;
  return {
    fullName,
    owner,
    name: repo.slug ?? fullName.split("/")[1],
    private: !!repo.is_private,
    // The API may still emit the legacy bitbucket.org ssh host during the
    // 2026 migration window — always build the new-host form ourselves.
    sshUrl: `git@${SSH_HOST}:${fullName}.git`,
    httpsUrl: httpsRaw ? httpsRaw.replace(/^https:\/\/[^@/]*@/, "https://") : `https://bitbucket.org/${fullName}.git`,
    defaultBranch: repo.mainbranch?.name ?? "",
    description: repo.description ?? null
  };
}

export function parseCloudRepoUrl(input: string): ParsedRepo | null {
  const part = "[A-Za-z0-9._-]+";
  const httpsRe = new RegExp(`^https?://bitbucket\\.org/(${part})/(${part}?)(?:\\.git)?/?$`, "i");
  const sshRe = new RegExp(`^git@(?:ssh\\.)?bitbucket\\.org:(${part})/(${part}?)(?:\\.git)?$`, "i");
  const shortRe = new RegExp(`^(${part})/(${part})$`);
  const m = input.match(httpsRe) ?? input.match(sshRe) ?? input.match(shortRe);
  return m ? { owner: m[1], repo: m[2] } : null;
}

export const bitbucketCloudProvider: GitProvider = {
  id: "bitbucket-cloud",
  scopesHint: SCOPES,

  async getIdentity(creds): Promise<ProviderIdentity> {
    if (!creds.email) throw new AccountError(400, "The Atlassian account email is required.");
    const user = await bb(creds, "GET", "/user");
    if (!user?.uuid) throw new AccountError(502, "Bitbucket did not return the account identity.");
    return {
      login: user.nickname || user.display_name || "bitbucket-user",
      loginRef: user.uuid,                       // "{...}" braces included
      name: user.display_name || user.nickname || "bitbucket-user",
      email: creds.email
    };
  },

  async uploadSshKey(creds, identity, publicKey, label): Promise<KeyUpload> {
    try {
      const key = await bb(creds, "POST",
        `/users/${encodeURIComponent(identity.loginRef!)}/ssh-keys`, { key: publicKey, label });
      return { keyId: key?.uuid ?? undefined };
    } catch (error) {
      if (error instanceof AccountError && /409/.test(error.message)) {
        throw new AccountError(409,
          "Bitbucket rejected the key: an identical SSH key is already registered to another Bitbucket account or workspace (keys are globally unique).");
      }
      throw error;
    }
  },

  async findSshKey(creds, identity, publicKey) {
    const body = publicKey.trim().split(/\s+/).slice(0, 2).join(" ");
    const keys = await bbAll(creds, `/users/${encodeURIComponent(identity.loginRef!)}/ssh-keys`);
    const hit = keys.find(k => typeof k.key === "string" && k.key.trim().startsWith(body));
    return hit ? { keyId: hit.uuid } : null;
  },

  async removeSshKey(creds, identity, keyId) {
    await bb(creds, "DELETE", `/users/${encodeURIComponent(identity.loginRef!)}/ssh-keys/${encodeURIComponent(keyId)}`);
  },

  async listRepos(creds): Promise<RepoSummary[]> {
    const workspaces = await bbAll(creds, "/user/workspaces");
    const out: RepoSummary[] = [];
    for (const ws of workspaces) {
      const repos = await bbAll(creds, `/repositories/${encodeURIComponent(ws.slug)}?role=member&pagelen=100`);
      out.push(...repos.map(toCloudRepoSummary));
    }
    return out;
  },

  async listOwners(creds): Promise<OwnerSummary[]> {
    const workspaces = await bbAll(creds, "/user/workspaces");
    return workspaces.map(ws => ({ id: ws.slug, label: ws.name ?? ws.slug, kind: "workspace" as const }));
  },

  async createRepo(creds, _identity, opts: CreateRepoOpts): Promise<RepoSummary> {
    const slug = opts.name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
    const repo = await bb(creds, "POST",
      `/repositories/${encodeURIComponent(opts.owner)}/${encodeURIComponent(slug)}`,
      { scm: "git", is_private: opts.visibility === "private", description: opts.description ?? "" });
    return toCloudRepoSummary(repo);
  },

  parseRepoUrl(input: string, _ctx: UrlContext): ParsedRepo | null {
    return parseCloudRepoUrl(input.trim());
  },

  async cloneUrls(_creds, ref): Promise<CloneUrls> {
    return {
      ssh: `git@${SSH_HOST}:${ref.owner}/${ref.repo}.git`,
      https: `https://bitbucket.org/${ref.owner}/${ref.repo}.git`
    };
  },

  sshProbe(_ctx): SshProbe {
    return {
      target: `git@${SSH_HOST}`,
      parse: (text) => {
        const m = /logged in as ([^\s.]+)/i.exec(text);
        return m ? { ok: true, login: m[1], message: text.slice(0, 200) }
                 : { ok: false, message: text.slice(0, 200) || "No greeting from Bitbucket." };
      }
    };
  },

  credentialSpec(_ctx): CredentialSpec {
    return { host: "bitbucket.org", username: CLOUD_GIT_USERNAME };
  }
};
```

  Register in `providers/index.ts`: `"bitbucket-cloud": bitbucketCloudProvider`.
- [ ] **Step 4: Run → PASS**; `pnpm check`.
- [ ] **Step 5: Commit** — `git commit -am "feat(daemon): bitbucket-cloud provider"`

---

### Task 6: `providers/bitbucket-server.ts`

**Files:**
- Create: `apps/daemon/src/providers/bitbucket-server.ts`
- Modify: `apps/daemon/src/providers/index.ts` (register), `apps/daemon/package.json` (add dependency `undici`)
- Test: `apps/daemon/src/providers/bitbucket-server.test.ts` (create)

**Interfaces:**
- Consumes: Task 3 types.
- Produces: `bitbucketServerProvider: GitProvider`; exported helpers `probeServer(baseUrl, caCertPath?) → Promise<{version: string, displayName: string}>`, `parseServerRepoUrl(input, ctx)`, `pickCloneUrls(cloneLinks)`, `serverVersionSupportsEd25519(version) → boolean`.

- [ ] **Step 1: Failing test:**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { bitbucketServerProvider, parseServerRepoUrl, pickCloneUrls, serverVersionSupportsEd25519 } from "./bitbucket-server";

const ctx = { baseUrl: "https://bb.corp.com/bitbucket", sshHost: "bb.corp.com:7999" };

test("parseRepoUrl accepts scm/ssh/browse/personal/shorthand forms anchored to the account", () => {
  assert.deepEqual(parseServerRepoUrl("https://bb.corp.com/bitbucket/scm/PRJ/repo.git", ctx), { owner: "PRJ", repo: "repo" });
  assert.deepEqual(parseServerRepoUrl("ssh://git@bb.corp.com:7999/PRJ/repo.git", ctx), { owner: "PRJ", repo: "repo" });
  assert.deepEqual(parseServerRepoUrl("https://bb.corp.com/bitbucket/projects/PRJ/repos/repo/browse", ctx), { owner: "PRJ", repo: "repo" });
  assert.deepEqual(parseServerRepoUrl("https://bb.corp.com/bitbucket/users/jdoe/repos/site/browse", ctx), { owner: "~jdoe", repo: "site" });
  assert.deepEqual(parseServerRepoUrl("PRJ/repo", ctx), { owner: "PRJ", repo: "repo" });
  assert.deepEqual(parseServerRepoUrl("~jdoe/site", ctx), { owner: "~jdoe", repo: "site" });
  assert.equal(parseServerRepoUrl("https://other-host.com/scm/PRJ/repo.git", ctx), null);
  assert.equal(parseServerRepoUrl("https://github.com/o/r", ctx), null);
});

test("pickCloneUrls tolerates name:'http' meaning https and missing ssh", () => {
  assert.deepEqual(pickCloneUrls([
    { name: "http", href: "https://bb.corp.com/bitbucket/scm/PRJ/repo.git" },
    { name: "ssh", href: "ssh://git@bb.corp.com:7999/PRJ/repo.git" }
  ]), { https: "https://bb.corp.com/bitbucket/scm/PRJ/repo.git", ssh: "ssh://git@bb.corp.com:7999/PRJ/repo.git" });
  assert.deepEqual(pickCloneUrls([{ name: "http", href: "https://h/scm/P/r.git" }]),
    { https: "https://h/scm/P/r.git", ssh: undefined });
});

test("credential host includes non-standard ports; strips creds embedded by the API", () => {
  assert.deepEqual(bitbucketServerProvider.credentialSpec({ ...ctx, login: "jdoe" }),
    { host: "bb.corp.com", username: "jdoe" });
  assert.deepEqual(bitbucketServerProvider.credentialSpec({ baseUrl: "https://bb.corp.com:8443/bb", login: "jdoe" }),
    { host: "bb.corp.com:8443", username: "jdoe" });
});

test("ed25519 version gate", () => {
  assert.equal(serverVersionSupportsEd25519("10.4.0"), true);
  assert.equal(serverVersionSupportsEd25519("6.6.1"), true);
  assert.equal(serverVersionSupportsEd25519("6.5.9"), false);
  assert.equal(serverVersionSupportsEd25519("garbage"), true); // unknown → assume modern
});

test("sshProbe uses the account sshHost and reports HTTPS-only when absent", () => {
  const probe = bitbucketServerProvider.sshProbe({ ...ctx, login: "jdoe" })!;
  assert.equal(probe.target, "git@bb.corp.com");
  assert.equal(probe.port, 7999);
  assert.equal(bitbucketServerProvider.sshProbe({ baseUrl: ctx.baseUrl, login: "jdoe" }), null);
});
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** — key code (full module; REST parts follow the same `AccountError` mapping style as Task 5):

```ts
import { readFile } from "node:fs/promises";
import { Agent } from "undici";
import type { OwnerSummary, RepoSummary } from "@orquester/api";
import { AccountError } from "../account-error";
import type { CloneUrls, CreateRepoOpts, CredentialSpec, GitProvider, KeyUpload,
  ParsedRepo, ProviderCreds, ProviderIdentity, SshProbe, UrlContext } from "./types";

const SCOPES = "an HTTP access token with Repository write (and Project read) permission";
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function base(creds: { baseUrl?: string }): string {
  if (!creds.baseUrl) throw new AccountError(400, "The Bitbucket Server base URL is required.");
  return creds.baseUrl.replace(/\/+$/, "");
}

async function dispatcherFor(caCertPath?: string): Promise<Agent | undefined> {
  if (!caCertPath) return undefined;
  const ca = await readFile(caCertPath, "utf8");
  return new Agent({ connect: { ca } });
}

async function dc(creds: ProviderCreds, method: string, path: string, body?: unknown, retry = 1): Promise<any> {
  const dispatcher = await dispatcherFor(creds.caCertPath);
  const res = await fetch(`${base(creds)}${path}`, {
    method,
    // Bearer works for personal AND project/repo tokens, and survives DC 10.x
    // instances that disable Basic auth.
    headers: { Authorization: `Bearer ${creds.token}`, Accept: "application/json",
      "User-Agent": "orquester", ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    // Non-standard RequestInit key understood by Node's undici-backed fetch.
    ...(dispatcher ? ({ dispatcher } as object) : {})
  });
  if (res.status === 429 && retry > 0) {
    // DC rate limiting (token-bucket, admin-configured) — one backoff retry.
    await sleep(2000);
    return dc(creds, method, path, body, retry - 1);
  }
  if (!res.ok) {
    const text = (await res.text().catch(() => "")).slice(0, 300);
    if (res.status === 403 && /Basic Authentication has been disabled/i.test(text)) {
      throw new AccountError(502, "The instance rejected Basic auth — this is unexpected since Orquester uses Bearer; check for a proxy rewriting the Authorization header.");
    }
    const hint = res.status === 401 || res.status === 403 ? ` (check the token: ${SCOPES})` : "";
    throw new AccountError(res.status === 401 || res.status === 403 ? 400 : 502,
      `Bitbucket Server ${method} ${path} → ${res.status}${hint}. ${text}`);
  }
  return res.status === 204 ? undefined : res.json();
}

/** DC pagination: {values, isLastPage, nextPageStart}. */
async function dcAll(creds: ProviderCreds, path: string): Promise<any[]> {
  const sep = path.includes("?") ? "&" : "?";
  const out: any[] = [];
  let start = 0;
  for (;;) {
    const page = await dc(creds, "GET", `${path}${sep}limit=100&start=${start}`);
    out.push(...(page.values ?? []));
    if (page.isLastPage !== false || page.nextPageStart == null) return out;
    start = page.nextPageStart;
  }
}

/** Unauthenticated instance probe; also used at connect time for context-path validation. */
export async function probeServer(baseUrl: string, caCertPath?: string): Promise<{ version: string; displayName: string }> {
  const dispatcher = await dispatcherFor(caCertPath);
  const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/rest/api/1.0/application-properties`,
    { headers: { Accept: "application/json", "User-Agent": "orquester" }, ...(dispatcher ? ({ dispatcher } as object) : {}) });
  if (!res.ok) throw new AccountError(400,
    `Not a reachable Bitbucket Server/Data Center at this base URL (application-properties → ${res.status}). Check the URL — including any context path like /bitbucket.`);
  const props = await res.json();
  return { version: String(props.version ?? ""), displayName: String(props.displayName ?? "") };
}

export function serverVersionSupportsEd25519(version: string): boolean {
  const m = /^(\d+)\.(\d+)/.exec(version);
  if (!m) return true;
  const [major, minor] = [Number(m[1]), Number(m[2])];
  return major > 6 || (major === 6 && minor >= 6);
}

export function pickCloneUrls(clone: Array<{ name: string; href: string }>): CloneUrls {
  const https = clone.find(c => c.name === "http" || c.name === "https")?.href;
  const ssh = clone.find(c => c.name === "ssh")?.href;
  if (!https) throw new AccountError(502, "The repository exposes no HTTP clone URL.");
  return { https: https.replace(/^(https?:\/\/)[^@/]*@/, "$1"), ssh };
}

export function parseServerRepoUrl(input: string, ctx: UrlContext): ParsedRepo | null {
  const trimmed = input.trim();
  const part = "[A-Za-z0-9._-]+";
  const shortRe = new RegExp(`^(~?${part})/(${part})$`);
  const short = trimmed.match(shortRe);
  if (short) return { owner: short[1], repo: short[2] };
  if (!ctx.baseUrl) return null;
  const baseEsc = ctx.baseUrl.replace(/\/+$/, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const re of [
    new RegExp(`^${baseEsc}/scm/(~?${part})/(${part}?)(?:\\.git)?/?$`, "i"),
    new RegExp(`^${baseEsc}/projects/(${part})/repos/(${part})/browse`, "i"),
    new RegExp(`^${baseEsc}/users/(${part})/repos/(${part})/browse`, "i")
  ]) {
    const m = trimmed.match(re);
    if (m) return { owner: re.source.includes("/users/") ? `~${m[1]}` : m[1], repo: m[2] };
  }
  if (ctx.sshHost) {
    const [host, port] = ctx.sshHost.split(":");
    const sshRe = new RegExp(`^ssh://git@${host.replace(/\./g, "\\.")}${port ? `:${port}` : ""}/(~?${part})/(${part}?)(?:\\.git)?$`, "i");
    const m = trimmed.match(sshRe);
    if (m) return { owner: m[1], repo: m[2] };
  }
  return null;
}
```

  Remaining `bitbucketServerProvider` methods:
  - `getIdentity(creds)` — requires `creds.username` (400 otherwise); `GET /rest/api/1.0/users/${encodeURIComponent(creds.username)}` → `{ login: creds.username, loginRef: user.slug ?? creds.username, name: user.displayName ?? creds.username, email: user.emailAddress ?? "" }`.
  - `uploadSshKey(creds, _identity, publicKey, _label)` — `POST /rest/ssh/1.0/keys` body `{ text: publicKey }`; catch `AccountError` with 400-mapped 401/403 → return `{ manualUrl: `${base(creds)}/plugins/servlet/ssh/account/keys` }` (token can't edit account details on this instance); a 409 in the message → rethrow as `AccountError(409, "This SSH key is already registered on the instance.")`; success → `{ keyId: String(key.id) }`. A 400 mentioning the key algorithm → rethrow `AccountError(400, "The instance rejected the key algorithm/length (admin policy). Reconnect — Orquester will fall back to RSA-4096.")`.
  - `findSshKey` — `GET /rest/ssh/1.0/keys` (dcAll), match `k.text` startsWith the key body (first two fields); → `{ keyId: String(k.id) }` | null.
  - `removeSshKey` — `DELETE /rest/ssh/1.0/keys/${keyId}`.
  - `listRepos` — `dcAll(creds, "/rest/api/1.0/repos?permission=REPO_READ")` mapped: `fullName: \`${r.project.key}/${r.slug}\``, `owner: r.project.key`, `name: r.slug`, `private: !r.public`, `{https, ssh} = pickCloneUrls(r.links.clone)`, `sshUrl: ssh ?? https`, `httpsUrl: https`, `defaultBranch: ""`, `description: r.description ?? null`.
  - `listOwners(creds, identity)` — `dcAll("/rest/api/1.0/projects")` → `{ id: p.key, label: p.name ?? p.key, kind: "project" }`, prepended with `{ id: \`~${identity.loginRef}\`, label: \`${identity.login} (personal)\`, kind: "user" }`.
  - `createRepo(creds, _identity, opts)` — `POST /rest/api/1.0/projects/${encodeURIComponent(opts.owner)}/repos` body `{ name: opts.name, scmId: "git", forkable: true, public: opts.visibility === "public", ...(opts.description ? { description: opts.description } : {}) }`; map like `listRepos`. Note: DC create does **not** auto-init; the clone will be empty — acceptable (`git clone` of an empty repo succeeds with a warning).
  - `cloneUrls(creds, ref)` — `GET /rest/api/1.0/projects/${encodeURIComponent(ref.owner)}/repos/${encodeURIComponent(ref.repo)}` → `pickCloneUrls(repo.links.clone)`.
  - `sshProbe(ctx)` — `ctx.sshHost` absent → `null`; else split `host[:port]` → `{ target: \`git@${host}\`, port: port ? Number(port) : undefined, parse: text => text && !/denied|refused|unable|error/i.test(text) ? { ok: true, login: ctx.login, message: text.slice(0,200) } : { ok: false, message: text.slice(0,200) || "No response from the SSH endpoint." } }`.
  - `credentialSpec(ctx)` — `const u = new URL(ctx.baseUrl!); return { host: u.host, username: ctx.login }` (`URL.host` keeps a non-default port).
  - `scopesHint = SCOPES`.

  Add `"undici": "^6.19.0"` to `apps/daemon/package.json` dependencies; run `pnpm install`. Register `"bitbucket-server": bitbucketServerProvider` in `providers/index.ts`.
- [ ] **Step 4: Run → PASS**; `pnpm check`.
- [ ] **Step 5: Commit** — `git commit -am "feat(daemon): bitbucket-server provider with CA-aware fetch and instance probe"`

---

### Task 7: `known-hosts.ts` — daemon-owned known_hosts

**Files:**
- Create: `apps/daemon/src/known-hosts.ts`
- Test: `apps/daemon/src/known-hosts.test.ts` (create)

**Interfaces:**
- Produces: `ensureKnownHosts(keysDir: string): Promise<string>` — creates/seeds `<keysDir>/known_hosts` (0600) with the pinned bitbucket.org keys (idempotent), returns the path. `KNOWN_HOSTS_SEED: string[]`.

- [ ] **Step 1: Failing test:**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureKnownHosts, KNOWN_HOSTS_SEED } from "./known-hosts";

test("seeds once, idempotently, preserving TOFU-appended entries", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orq-kh-"));
  const path = await ensureKnownHosts(dir);
  await ensureKnownHosts(dir);                       // second call must not duplicate
  const { appendFile } = await import("node:fs/promises");
  await appendFile(path, "[bb.corp.com]:7999 ssh-ed25519 AAAAtofu\n");
  await ensureKnownHosts(dir);                       // must keep the TOFU line
  const text = await readFile(path, "utf8");
  for (const line of KNOWN_HOSTS_SEED) assert.equal(text.split("\n").filter(l => l === line).length, 1);
  assert.ok(text.includes("[bb.corp.com]:7999 ssh-ed25519 AAAAtofu"));
});
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement:**

```ts
import { appendFile, chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

// bitbucket.org host keys as served by https://bitbucket.org/site/ssh
// (post-2023 rotation; verified 2026-08-03). ssh.bitbucket.org (the 2026
// replacement SSH host) and DC hosts are TOFU'd via StrictHostKeyChecking=
// accept-new into this same file.
export const KNOWN_HOSTS_SEED = [
  "bitbucket.org ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQDQeJzhupRu0u0cdegZIa8e86EG2qOCsIsD1Xw0xSeiPDlCr7kq97NLmMbpKTX6Esc30NuoqEEHCuc7yWtwp8dI76EEEB1VqY9QJq6vk+aySyboD5QF61I/1WeTwu+deCbgKMGbUijeXhtfbxSxm6JwGrXrhBdofTsbKRUsrN1WoNgUa8uqN1Vx6WAJw1JHPhglEGGHea6QICwJOAr/6mrui/oB7pkaWKHj3z7d1IC4KWLtY47elvjbaTlkN04Kc/5LFEirorGYVbt15kAUlqGM65pk6ZBxtaO3+30LVlORZkxOh+LKL/BvbZ/iRNhItLqNyieoQj/uh/7Iv4uyH/cV/0b4WDSd3DptigWq84lJubb9t/DnZlrJazxyDCulTmKdOR7vs9gMTo+uoIrPSb8ScTtvw65+odKAlBj59dhnVp9zd7QUojOpXlL62Aw56U4oO+FALuevvMjiWeavKhJqlR7i5n9srYcrNV7ttmDw7kf/97P5zauIhxcjX+xHv4M=",
  "bitbucket.org ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBPIQmuzMBuKdWeF4+a2sjSSpBK0iqitSQ+5BM9KhpexuGt20JpTVM7u5BDZngncgrqDMbWdxMWWOGtZ9UgbqgZE=",
  "bitbucket.org ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIIazEu89wgQZ4bqs3d63QSMzYVa0MuJ2e2gKTKqu+UUO"
];

export async function ensureKnownHosts(keysDir: string): Promise<string> {
  const path = join(keysDir, "known_hosts");
  let existing = "";
  try { existing = await readFile(path, "utf8"); } catch { await writeFile(path, "", { mode: 0o600 }); }
  const lines = new Set(existing.split("\n"));
  const missing = KNOWN_HOSTS_SEED.filter(l => !lines.has(l));
  if (missing.length > 0) await appendFile(path, missing.map(l => l + "\n").join(""));
  await chmod(path, 0o600);
  return path;
}
```

- [ ] **Step 4: Run → PASS**; `pnpm check`.
- [ ] **Step 5: Commit** — `git commit -am "feat(daemon): daemon-owned known_hosts with pinned bitbucket.org keys"`

---

### Task 8: `AccountsService` — delegate to providers

**Files:**
- Modify: `apps/daemon/src/accounts.ts` (the bulk of the task)
- Test: extend `apps/daemon/src/accounts-schema.test.ts` is NOT the place — this task is verified by `pnpm check` + existing suite + Tasks 9–10 route behavior; the pure additions (`sshCommandFor`) get a test in `apps/daemon/src/accounts-ssh.test.ts` (create).

**Interfaces:**
- Consumes: `providerFor`, `GitProvider`, `buildCredentialFileLine`, `ensureKnownHosts`, `probeServer`, `serverVersionSupportsEd25519`.
- Produces (used by Task 9 routes):
  - `add(req: CreateAccountRequest): Promise<AccountSummary>` (union-aware)
  - `toSummary(account: Account): AccountSummary` (provider/host/login/mirror/keyPending/manualKeyUrl/tokenExpiresAt)
  - `confirmKey(id: string): Promise<AccountSummary>`
  - `listOwners(id: string): Promise<OwnerSummary[]>` (replaces `listOrgs`)
  - `cloneFromInput(accountId: string, input: string, destName: string | undefined, cwd: string): Promise<{ name: string }>`
  - `remove(id, boundWorkspaces)` — also deletes the remote key (best-effort) + `.env`/`.ca.pem` files
  - exported pure helper `sshCommandFor(account: Account, knownHostsPath: string | null): string`

- [ ] **Step 1: Failing test** — `apps/daemon/src/accounts-ssh.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { sshCommandFor } from "./accounts";

const gh = { provider: "github", keyPath: "/k/a" } as never;
const bb = { provider: "bitbucket-cloud", keyPath: "/k/b" } as never;

test("github keeps today's exact core.sshCommand", () => {
  assert.equal(sshCommandFor(gh, "/k/known_hosts"),
    'ssh -i "/k/a" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new');
});

test("bitbucket accounts pin the daemon-owned known_hosts", () => {
  assert.equal(sshCommandFor(bb, "/k/known_hosts"),
    'ssh -i "/k/b" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile="/k/known_hosts"');
});
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Refactor `accounts.ts`** — the changes, method by method (keep every existing security invariant comment; update the class doc from "GitHub" to "provider"). Shared private helpers used below — define them once near `find()`:

```ts
/** 404-throwing wrapper around the existing async find(). */
private async requireAccount(id: string): Promise<Account> {
  const account = await this.find(id);
  if (!account) throw new AccountError(404, "Unknown account.");
  return account;
}
/**
 * Non-throwing: token may be "" for tokenless (SSH-only) accounts. REST-needing
 * paths keep the existing requireToken() gate in front of provider calls.
 */
private credsOf(account: Account): ProviderCreds {
  return { token: account.token ?? "", email: account.email, baseUrl: account.baseUrl,
           username: account.login, caCertPath: account.caCertPath };
}
private identityOf(account: Account): ProviderIdentity {
  return { login: account.login, loginRef: account.loginRef, name: account.gitName, email: account.gitEmail };
}
private urlCtx(account: Account) {
  return { baseUrl: account.baseUrl, sshHost: account.sshHost, login: account.login, email: account.email };
}
```

  - **Harden `read()` (spec §1):** the current catch-all silently resets a corrupt `accounts.json` to empty (and the next `write()` persists the loss). Split the catch: file-missing (`ENOENT`) → default empty config (unchanged); anything else (unreadable/unparseable/schema-invalid) → `throw new AccountError(500, "accounts.json is unreadable; refusing to overwrite it.")` — mirroring `readWorkspacesMetaStrict`'s posture in `index.ts`.
  - Export the helper:

```ts
export function sshCommandFor(account: Account, knownHostsPath: string | null): string {
  const base = `ssh -i "${account.keyPath}" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new`;
  return account.provider !== "github" && knownHostsPath
    ? `${base} -o UserKnownHostsFile="${knownHostsPath}"` : base;
}
```

  - Replace the three inline sshCommand strings (`test()`, `cloneRepo()`, `writeIncludeFile()`) with `sshCommandFor(account, await this.knownHosts())` where `private async knownHosts()` = `ensureKnownHosts(this.keysDirPath)` for non-github accounts (null for github).
  - **`add(req: CreateAccountRequest)`**:
    1. Validate per-variant (label always; github/cloud/server token; cloud `email`; server `baseUrl` + `username`).
    2. For `bitbucket-server`: write `caCertPem` (if present) to `<keys>/<id>.ca.pem` mode 0600 **first**; `const props = await probeServer(baseUrl, caPath)`; keygen type = `serverVersionSupportsEd25519(props.version) ? "ed25519" : "rsa"` — RSA adds `-b 4096` to the `ssh-keygen` argv. All other providers: ed25519, unchanged argv.
    3. `const provider = providerFor(req.provider ?? "github")`; `const creds: ProviderCreds = { token, email, baseUrl, username, caCertPath }`; `const identity = await provider.getIdentity(creds)`.
    4. keygen (existing code), then `const upload = await provider.uploadSshKey(creds, identity, publicKey, \`orquester:${label}\`)`.
    5. Persist the `Account` with: `provider: req.provider ?? "github"`, `login: identity.login`, `loginRef: identity.loginRef`, `email` (cloud), `baseUrl`/`caCertPath` (server), `gitName: identity.name`, `gitEmail: identity.email || \`${label}@users.noreply.local\``, `remoteKeyId: upload.keyId`, `keyUploadPending: upload.manualUrl ? true : undefined`, `tokenExpiresAt: req.provider && req.provider !== "github" ? req.tokenExpiresAt : undefined`, `sshHost`:
       - cloud → `"ssh.bitbucket.org"`;
       - server → best-effort from the first repo: `try { const repos = await provider.listRepos(creds); const ssh = repos.find(r => r.sshUrl.startsWith("ssh://"))?.sshUrl; sshHost = ssh ? new URL(ssh).host.replace("git@", "") : undefined } catch {}` — implement as `new URL(ssh)` → `\`${u.hostname}${u.port ? ":" + u.port : ""}\``;
       - github → undefined.
    6. `syncCliAuth(account)` (renamed from `syncGitHubCliAuth`, see below). Existing keygen-failure cleanup stays; extend it to also rm the `.ca.pem`.
  - **`toSummary()`** — return the Task 2 shape: `provider`, `login`, `githubLogin: account.login` (mirror), `host` = `"github.com"` | `"bitbucket.org"` | `new URL(account.baseUrl!).host`, `tokenExpiresAt`, `keyPending: account.keyUploadPending || undefined`, `manualKeyUrl: account.keyUploadPending && account.baseUrl ? \`${account.baseUrl.replace(/\/+$/, "")}/plugins/servlet/ssh/account/keys\` : undefined`. Still strips `keyPath`/`token`/`remoteKeyId`/`caCertPath`.
  - **`test(id)`** — `const probe = providerFor(account.provider).sshProbe(this.urlCtx(account))`; `null` → `{ ok: false, message: "SSH is not available for this account (HTTPS-only)." }`; else run the existing `ssh` execFile with `probe.target`, adding `["-p", String(probe.port)]` when set and the `sshCommandFor` options (as discrete argv entries, not a string); return `probe.parse(stdout+stderr)`. Private helper `urlCtx(account)` = `{ baseUrl: account.baseUrl, sshHost: account.sshHost, login: account.login, email: account.email }`.
  - **`setToken(id, token, tokenExpiresAt?)`** — provider-generalized: `const identity = await provider.getIdentity({ ...this.credsOf(stored), token: trimmed })`; mismatch check `identity.login !== stored.login` (keep the existing message shape); persist `tokenExpiresAt` when provided.
  - **`writeIncludeFile(account)`** — compute `const spec = providerFor(account.provider).credentialSpec(this.urlCtx(account))`; the credential config key becomes `` `credential.https://${spec.host}.helper` ``; the creds file content becomes `buildCredentialFileLine(spec, account.token)`; `core.sshCommand` via `sshCommandFor`; when `account.caCertPath`: also `git config --file <include> http.${account.baseUrl}.sslCAInfo ${account.caCertPath}` (key literally `http.<baseUrl>.sslCAInfo`). Tokenless cleanup unsets the per-host key it set.
  - **`syncCliAuth(account)`** — github: existing hosts.yml body unchanged. Bitbucket (both): write `<keys>/<id>.env` mode 0600:

```
BITBUCKET_PROVIDER=<provider>
BITBUCKET_BASE_URL=<https://api.bitbucket.org/2.0 | account.baseUrl>
BITBUCKET_USER=<account.email (cloud) | account.login (server)>
BITBUCKET_TOKEN=<token>
BITBUCKET_AUTH=<basic (cloud) | bearer (server)>
```

    (values shell-quoted with single quotes, embedded `'` escaped as `'\''`). No-op without a token, like today.
  - **`remove(id, boundWorkspaces)`** — before deleting local files: `if (account.remoteKeyId && account.token) await providerFor(...).removeSshKey(creds, identityOf(account), account.remoteKeyId).catch(() => undefined);` where `identityOf(account)` = `{ login: account.login, loginRef: account.loginRef, name: account.gitName, email: account.gitEmail }`. Add `<id>.env` and `<id>.ca.pem` to the rm list.
  - **`confirmKey(id)`** — provider `findSshKey(creds, identityOf(account), account.publicKey)`; found → persist `remoteKeyId`, clear `keyUploadPending`, return `toSummary`; not found → `AccountError(404, "The key is not on the server yet — paste it at the SSH keys page, then retry.")`.
  - **`listRepos`/`createRepo`** — delegate to `providerFor(account.provider)` with `credsOf(account)`/`identityOf(account)`. **`listOrgs` → `listOwners(id)`** returning `provider.listOwners(...)`.
  - **`cloneFromInput(accountId, input, destName, cwd)`** — new public method encapsulating the route logic:

```ts
const account = await this.requireAccount(accountId);
const provider = providerFor(account.provider);
const parsed = provider.parseRepoUrl(input, this.urlCtx(account));
if (!parsed) {
  const other = (["github", "bitbucket-cloud", "bitbucket-server"] as const)
    .filter(id => id !== account.provider)
    .some(id => providerFor(id).parseRepoUrl(input, {}) !== null);
  throw new AccountError(400, other
    ? `That URL belongs to a different provider — this workspace is bound to a ${account.provider} account.`
    : "Could not parse the repository URL for this account's provider.");
}
const urls = await provider.cloneUrls(this.credsOf(account), parsed);
const cloneUrl = urls.ssh && account.provider !== "bitbucket-server" ? urls.ssh
  : (urls.ssh ?? urls.https);                    // DC: prefer API-reported ssh, else https
const name = destName ?? repoNameFrom(cloneUrl); // move repoNameFromSshUrl here as repoNameFrom
await this.cloneRepo(accountId, cloneUrl, name, cwd);
return { name };
```

  - **`cloneRepo(id, url, destName, cwd)`** — branch on scheme: `url.startsWith("http")` → argv `["-c", \`credential.helper=store --file=${this.credentialsPath(account)}\`, ...(account.caCertPath ? ["-c", \`http.sslCAInfo=${account.caCertPath}\`] : []), "clone", url, destName]` (no `GIT_SSH_COMMAND`); ssh → existing env path via `sshCommandFor`. Detect a git stderr containing `HTTP 410` and map to `AccountError(400, "Bitbucket rejected the stored credential (410) — app passwords were removed July 2026; reconnect with a scoped API token.")`.
- [ ] **Step 4: Run** — `node --import tsx --test src/accounts-ssh.test.ts` → PASS; `pnpm --filter @orquester/daemon test` all green; `pnpm check` (expect route-level errors for `listOrgs` — fix by temporarily keeping a deprecated `listOrgs` alias delegating to `listOwners` and mapping ids; removed in Task 9).
- [ ] **Step 5: Commit** — `git commit -am "refactor(daemon): AccountsService delegates provider specifics to GitProvider"`

---

### Task 9: Routes

**Files:**
- Modify: `apps/daemon/src/index.ts:1918-2007` (accounts routes), `:1962-1978` (token route)

**Interfaces:**
- Consumes: Task 8 service methods.
- Produces: `POST /api/accounts` (union body), `GET /api/accounts/:id/orgs` → `OwnerSummary[]`, `POST /api/accounts/:id/confirm-key`, token route accepting `{ token, tokenExpiresAt? }`.

- [ ] **Step 1: Edit routes** (no daemon launch; verified by typecheck + review):
  - `POST /api/accounts` — body typed `CreateAccountRequest`; handler unchanged otherwise (`accounts.add(body)` now handles the union).
  - `GET /api/accounts/:id/orgs` — call `accounts.listOwners(id)`; return the array as-is. Remove the Task-8 `listOrgs` alias.
  - Add after the token route:

```ts
// DC manual key-upload flow: the user pasted the public key on the instance;
// verify it's there and clear the pending flag.
app.post("/api/accounts/:id/confirm-key", async (request, reply) => {
  const { id } = request.params as { id: string };
  try {
    return await services.accounts.confirmKey(id);
  } catch (error) {
    const status = error instanceof AccountError ? error.status : 500;
    const message = error instanceof Error ? error.message : "Key confirmation failed.";
    return reply.code(status).send({ code: "ACCOUNT_ERROR", message });
  }
});
```

    (this is the same catch shape the surrounding accounts routes use — mirror `POST /api/accounts/:id/test` exactly if it differs.)
  - Token route — body `{ token?: string; tokenExpiresAt?: string }`, pass both to `accounts.setToken(id, token, tokenExpiresAt)`.
- [ ] **Step 2: `pnpm check`** — clean; `pnpm --filter @orquester/daemon test` — green.
- [ ] **Step 3: Commit** — `git commit -am "feat(daemon): provider-aware account routes + confirm-key"`

---

### Task 10: Project-create clone flow

**Files:**
- Modify: `apps/daemon/src/index.ts:1749-1769` (clone branch), `:3762-3793` (delete `normalizeRepoUrl`; move `repoNameFromSshUrl` → `accounts.ts` `repoNameFrom`)

- [ ] **Step 1: Replace the clone branch** of `POST /api/workspaces/:workspace/projects`:

```ts
if (body.source === "clone") {
  if (typeof body.url !== "string" || body.url.trim().length === 0) {
    return reply.code(400).send({ code: "INVALID_URL", message: "A repository URL is required." });
  }
  // Provider-aware parse + clone (SSH preferred, HTTPS fallback) lives in the service.
  const preferredName = body.name;
  if (preferredName !== undefined && !isValidName(preferredName)) {
    return reply.code(400).send({ code: "INVALID_NAME", message: "Invalid project name." });
  }
  await mkdir(workspaceDir, { recursive: true });
  const { name } = await services.accounts.cloneFromInput(accountId, body.url, preferredName, workspaceDir);
  await pruneArchivedProject(resolved.workspacesMetaFile, workspace, name);
  return { name, workspace, path: join(workspaceDir, name), isArchived: false };
}
```

  Keep the existing 409 `ALREADY_EXISTS` pre-check by moving it into `cloneFromInput` (it knows the final `name`): `if (existsSync(join(cwd, name))) throw new AccountError(409, "A project with this name already exists.")` — import `existsSync` in `accounts.ts`. The `NO_GIT_ACCOUNT` 400 message becomes `"This workspace has no linked git account."`. Delete `normalizeRepoUrl`; `repoNameFromSshUrl` moves to `accounts.ts` as `repoNameFrom` (same body).
- [ ] **Step 2:** `pnpm check` + full daemon test run — green (Task 4's github tests cover the parse dispatch; `cloneFromInput`'s mismatch error is covered by the provider `parseRepoUrl` null tests).
- [ ] **Step 3: Commit** — `git commit -am "feat(daemon): provider-aware project clone flow, drop github-only normalizeRepoUrl"`

---

### Task 11: UI plumbing — api-client + store

**Files:**
- Modify: `packages/ui/src/lib/api-client.ts:244-277`, `packages/ui/src/store/app.ts:620-653,1360-1419`

**Interfaces:**
- Produces (consumed by Tasks 12–13): store actions `addAccount(input: CreateAccountRequest): Promise<AccountSummary>`, `listOwners(accountId): Promise<OwnerSummary[]>`, `confirmAccountKey(id): Promise<void>`, `setAccountToken(accountId, token, tokenExpiresAt?)`.

- [ ] **Step 1: api-client** — widen `createAccount(req: CreateAccountRequest)` (type only); `listOrgs` was already renamed `listOwners` in Task 2; add:

```ts
/** DC manual-key flow: verify the pasted key landed, clear the pending flag. */
confirmAccountKey(accountId: string): Promise<AccountSummary> {
  return this.request(`/api/accounts/${encodeURIComponent(accountId)}/confirm-key`, { method: "POST" });
}
```

  `setAccountToken(accountId, token, tokenExpiresAt?)` — body `{ token, tokenExpiresAt }`.
- [ ] **Step 2: store** — `addAccount: (input: CreateAccountRequest) => Promise<AccountSummary>` (implementation unchanged apart from the type); replace the Task-2 shim `listOrgs` with `listOwners` returning `OwnerSummary[]` verbatim from the API; add `confirmAccountKey` (calls api then `loadAccounts()`); `setAccountToken` gains the optional `tokenExpiresAt` pass-through.
- [ ] **Step 3:** `pnpm check` — fix `NewProjectModal.tsx` compile fallout minimally (it consumes `listOrgs`): switch it to `listOwners` and store `OwnerSummary[]` in its `orgs` state, using `o.id` where a string was used (proper UX in Task 13).
- [ ] **Step 4: Commit** — `git commit -am "feat(ui): provider-aware account plumbing in api-client and store"`

---

### Task 12: Settings — `GitHostingSettings`

**Files:**
- Create: `packages/ui/src/icons/Bitbucket.tsx`
- Modify: `packages/ui/src/components/settings/SettingsModal.tsx:33-57,340-550`

- [ ] **Step 1: Icon** — `packages/ui/src/icons/Bitbucket.tsx`:

```tsx
import React from "react";

/** Bitbucket mark (simple-icons path); lucide has no Bitbucket glyph. */
export const BitbucketIcon: React.FC<{ size?: number; className?: string }> = ({ size = 16, className }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
    <path d="M.778 1.213a.768.768 0 00-.768.892l3.263 19.81c.084.5.515.868 1.022.873H19.95a.772.772 0 00.77-.646l3.27-20.03a.768.768 0 00-.768-.891zM14.52 15.53H9.522L8.17 8.466h7.561z" />
  </svg>
);
```

- [ ] **Step 2: Section rename** — in `SettingsModal.tsx`: `Section` union `"github"` → `"git-hosting"`; nav entry `{ id: "git-hosting", label: "Git hosting", icon: <Github size={16} />, desc: "Connect GitHub/Bitbucket accounts and per-workspace git identities" }`; `renderSection` maps `"git-hosting"` → `<GitHostingSettings />`.
- [ ] **Step 3: Component** — rename `GitHubSettings` → `GitHostingSettings`, restructured (keep the existing hooks/handlers; the diff is additive):
  - New local state: `provider: GitProviderId` (default `"github"`), `email`, `baseUrl`, `username`, `caCertPem`, `tokenExpiresAt` (all `""`), `keyModalFor: AccountSummary | null`.
  - `connect()` builds the discriminated request:

```tsx
const req: CreateAccountRequest =
  provider === "bitbucket-cloud"
    ? { provider, label, token, email, tokenExpiresAt: tokenExpiresAt || undefined }
    : provider === "bitbucket-server"
      ? { provider, label, token, baseUrl, username,
          caCertPem: caCertPem.trim() || undefined, tokenExpiresAt: tokenExpiresAt || undefined }
      : { label, token };
const summary = await addAccount(req);
if (summary.keyPending) setKeyModalFor(summary);
```

  - Add-account form: a three-button provider segmented control (icons: `<Github/>`, `<BitbucketIcon/>`, `<BitbucketIcon/>` + "Data Center" text), then conditional fields:
    - github: label + token (`placeholder="GitHub PAT (write:public_key, user:email, read:user, repo, read:org)"`) — unchanged;
    - bitbucket-cloud: label, email (`placeholder="Atlassian account email"`), token (`placeholder="Scoped API token (read/write:repository, read:workspace, read:user, read/write:ssh-key)"`), optional expiry date input (`type="date"`, hint "Atlassian tokens expire (max 1 year) — enter the expiry you chose"), helper link `<a href="https://id.atlassian.com/manage-profile/security/api-tokens" target="_blank" rel="noreferrer">Create a scoped API token…</a>`;
    - bitbucket-server: label, baseUrl (`placeholder="https://bitbucket.example.com/bitbucket"`), username, token (`placeholder="HTTP access token (Repository write)"`), optional expiry date, CA `<textarea placeholder="PEM CA bundle (optional — for self-signed/internal certificates)"/>`.
  - Account rows: icon by `account.provider` (`Github` vs `BitbucketIcon`); `@{account.login}`; for `bitbucket-server` also a muted `{account.host}`; expiry badge:

```tsx
const days = account.tokenExpiresAt
  ? Math.ceil((Date.parse(account.tokenExpiresAt) - Date.now()) / 86_400_000) : null;
{days !== null && (
  <span className={days <= 30 ? "text-amber-500" : "text-neutral-500"}>
    {days <= 0 ? "token expired" : `token expires in ${days}d`}
  </span>
)}
```

  - Pending-key banner on rows with `account.keyPending`: "SSH key not installed yet" + button "Finish setup" → `setKeyModalFor(account)`.
  - Key modal (rendered like the existing modals in this file): shows `account.publicKey` in a `<pre>` with a Copy button (`navigator.clipboard.writeText`), a link to `account.manualKeyUrl`, and a "I've added it" button calling `confirmAccountKey(account.id)` then closing on success / showing the 404 message inline on failure.
  - Repo-token section placeholders become provider-aware (github keeps `"GitHub PAT (repo, read:org)"`; both bitbuckets: `"API token"` with the account's `scopesHint`-style copy: cloud "scoped Atlassian API token", server "HTTP access token"). Pass `tokenExpiresAt` through `setAccountToken` for bitbucket providers (another date input next to the token field).
- [ ] **Step 4:** `pnpm check`; visual review of the diff.
- [ ] **Step 5: Commit** — `git commit -am "feat(ui): Git hosting settings with provider picker, expiry countdown, DC manual-key flow"`

---

### Task 13: Sidebar — WorkspaceList + NewProjectModal

**Files:**
- Modify: `packages/ui/src/components/sidebar/WorkspaceList.tsx:234-242`, `packages/ui/src/components/sidebar/NewProjectModal.tsx`

- [ ] **Step 1: WorkspaceList** — dropdown item renders provider icon + `@{account.login}` (import `BitbucketIcon`; `account.provider === "github" ? <Github size={12}/> : <BitbucketIcon size={12}/>`). No other changes.
- [ ] **Step 2: NewProjectModal:**
  - `owners` state becomes `OwnerSummary[]` (from Task 11's `listOwners`); owner dropdown renders `o.label` + `(you)` marker when `o.kind === "user"`; `resolvedOwner` default = the `kind === "user"` entry's id, else the first owner's id (Cloud has no "user" entry — repos live in workspaces).
  - Provider-aware clone placeholder:

```tsx
const CLONE_PLACEHOLDER: Record<string, string> = {
  github: "https://github.com/owner/repo, git@github.com:owner/repo.git, or owner/repo",
  "bitbucket-cloud": "https://bitbucket.org/workspace/repo, git@bitbucket.org:workspace/repo.git, or workspace/repo",
  "bitbucket-server": "https://host/scm/KEY/repo.git, ssh://git@host:7999/KEY/repo.git, a repo browse URL, or KEY/repo",
};
// <Input placeholder={CLONE_PLACEHOLDER[account?.provider ?? "github"]} …/>
```

  - Copy fixes: "Add a GitHub token to clone or create repositories." → `` `Add a ${account.provider === "github" ? "GitHub" : "Bitbucket"} token to clone or create repositories.` ``; the doc comment's "GitHub repo" → "repo on the bound account's provider"; `openGitHubSettings` → `openGitHostingSettings` (same body).
- [ ] **Step 3:** `pnpm check`; `pnpm --filter @orquester/daemon test`.
- [ ] **Step 4: Commit** — `git commit -am "feat(ui): provider-aware workspace/project account pickers"`

---

### Task 14: Docs + final verification

**Files:**
- Modify: `AGENTS.md` (features + conventions mentions of "GitHub"), `README.md:61-65,146,199,213`

- [ ] **Step 1: Docs** — AGENTS.md: "per-workspace git/GitHub SSH identities" → "per-workspace git identities (GitHub, Bitbucket Cloud, Bitbucket Server/DC)"; add one convention bullet: "**Git providers.** Provider-specific REST/URL/credential behavior lives in `apps/daemon/src/providers/`; `AccountsService` stays provider-agnostic. Bitbucket Cloud SSH always uses `ssh.bitbucket.org`; DC clone URLs come from `links.clone[]`, never derived." README: update the accounts feature line + the "Connect multiple GitHub accounts" bullet to name all three providers.
- [ ] **Step 2: Full verification** — `pnpm check` clean; `pnpm --filter @orquester/daemon test` all green; `git status` clean after commit.
- [ ] **Step 3: Manual review checklist** (no daemon launch — per AGENTS.md, live verification happens only when the user explicitly drives a separate checkout):
  - grep `githubLogin` — remaining hits must be: the api mirror field, the schema preprocess, and docs.
  - grep `api.github.com` — only in `providers/github.ts`.
  - `toSummary` never emits `token`, `keyPath`, `caCertPath`, `remoteKeyId`.
  - `.env` helper + `.ca.pem` + credentials files all 0600.
- [ ] **Step 4: Commit** — `git commit -am "docs: multi-provider git hosting (GitHub + Bitbucket Cloud/DC)"`

---

## Post-plan live verification (user-driven, separate checkout)

From the spec's verification items, once the user chooses to drive a real daemon: connect a real Bitbucket Cloud account (scoped token) → key auto-upload → workspace bind → clone via picker + pasted URL → Git tab fetch/commit/push over SSH; connect a DC instance (with custom CA if available) → manual-key fallback path → HTTPS clone → Git tab push. Web UI: provider picker, expiry countdown, `smoke-web.mjs` after deploy.
