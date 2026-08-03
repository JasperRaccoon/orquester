# Bitbucket Cloud + Bitbucket Server/Data Center Support — Design

**Date:** 2026-08-03
**Status:** Approved (brainstorm complete; implementation plan pending)

## Goal

Workspace git identities currently support GitHub only. Add **Bitbucket Cloud** and
**Bitbucket Server / Data Center** ("Bitbucket Enterprise") as first-class providers with
**full parity**: connect an account with a token, generate + auto-upload an SSH key, list
repos in the project picker, clone, and create repos — for both Bitbucket variants.

Decisions made during brainstorming:

| Decision | Choice |
|---|---|
| Scope depth | Full parity (identity + SSH, repo picker, create-repo) for Cloud **and** Server/DC |
| Transport | SSH-first, HTTPS+token fallback (DC with SSH disabled, key upload rejected) |
| Self-signed DC certs | Supported in v1 via a **per-account CA field** |
| Session CLI parity | No `gh` equivalent exists (`acli` has no Bitbucket); expose the token via a **0600 helper file** agents can source on demand — no third-party CLI dependency, no token in default session env |
| Architecture | **Provider interface** (`GitProvider`) behind the existing `AccountsService`; per-provider modules; provider discriminant on the account schema with zod-default migration |

## Background: what is and isn't GitHub-coupled today

Workspace creation is `mkdir` + metadata + an optional `gitAccountId` binding. The delivery
mechanism — per-account ed25519 key, `includeIf`-scoped gitconfig (`user.*`,
`core.sshCommand`, credential helper), 0600 git-credentials file, selected by workspace
directory realpath — is **already provider-agnostic**. The GitHub coupling lives in:

- `packages/config` `accountSchema`: required `githubLogin`, no provider/host fields.
- `apps/daemon/src/accounts.ts`: `api.github.com` REST (`/user`, `/user/keys`,
  `/user/emails`), `ssh -T git@github.com` + `Hi <login>!` parsing,
  `credential.https://github.com.helper`, git-credentials host literal, `gh` `hosts.yml`.
- `apps/daemon/src/repos.ts`: GitHub-only repo/org/create REST (duplicate fetch helper).
- `apps/daemon/src/index.ts` `normalizeRepoUrl`: accepts only github.com forms; rewrites
  everything (including `owner/repo` shorthand) to `git@github.com:`.
- `packages/api`: `AccountSummary.githubLogin`, GitHub-flavored docs.
- `packages/ui`: `GitHubSettings` section, PAT placeholders, `@{githubLogin}` labels,
  GitHub-only clone-URL placeholder.

`git.ts`, session spawning, and workspace binding need no functional change.

## Provider landscape facts the design depends on (researched 2026-08-03)

**Bitbucket Cloud**

- App passwords were **permanently removed 2026-07-28**. The only viable stored credential
  is an **Atlassian API token with scopes** (created manually at id.atlassian.com;
  **mandatory expiry, 1 day–1 year**). Plain (unscoped) API tokens fail for git and for
  Bitbucket REST — connect-time validation must catch this.
- Three identities for one credential: REST = Basic `email:token`; git-over-HTTPS username
  = literal `x-bitbucket-api-token-auth`; SSH-key API addresses the user by
  **`account_id`/UUID** (usernames are not discoverable via API since GDPR).
- Scopes: `read:repository`, `write:repository`, `read:workspace`, `read:user`,
  `read:ssh-key`, `write:ssh-key` (all `:bitbucket`).
- SSH host is migrating: `git@bitbucket.org:` → **`git@ssh.bitbucket.org:`**; the old host
  is refused after **2026-11-12**, and API `links.clone` may still emit the old host during
  the window → always rewrite. known_hosts must be pre-seeded (pins +
  `https://bitbucket.org/site/ssh` refresh).
- SSH keys are **globally unique** across all Bitbucket accounts — fits the
  one-generated-key-per-account model; map the 409 to a clear "already registered to
  another account" error.
- REST budget ~1,000 req/h floor → cache repo/workspace listings; back off on 429.

**Bitbucket Server / Data Center**

- Entirely different API: `{baseUrl}/rest/api/1.0/…` (stable Server 5.x → DC 10.4).
  `{baseUrl}` may include a context path. Unauthenticated probe
  `GET {base}/rest/api/1.0/application-properties` → `{version, displayName}` identifies
  the instance and version.
- Credential: **HTTP access token**. Use **`Authorization: Bearer`** everywhere (new DC
  10.x disables Basic auth by default; 403 body "Basic Authentication has been disabled"
  is a distinct detectable error). Git-over-HTTPS: Basic with real username + token.
- **Never derive clone URLs** — read `repo.links.clone[]`. SSH default port 7999, possibly
  a different host than HTTPS (`plugin.ssh.baseurl`), never includes the context path;
  HTTPS is `{base}/scm/KEY/slug.git`. `name` is `"http"` even for https hrefs; the `ssh`
  entry is absent when the admin disabled SSH → account becomes HTTPS-only.
- `POST /rest/ssh/1.0/keys` `{"text": "<pubkey>"}` adds the caller's key, **but** tokens
  are documented as unable to "update user account details" and behavior varies → on
  401/403 fall back to manual paste with deep link
  `{base}/plugins/servlet/ssh/account/keys`, then verify via `GET /rest/ssh/1.0/keys`.
- Self-signed / internal-CA TLS is common; both git (`http.<url>.sslCAInfo`) and the
  daemon's fetch (custom agent CA) must honor a per-account CA bundle.
- Host keys are unstable (regenerated if the PEM is lost) and unpublished → TOFU with
  `accept-new` into a daemon-owned known_hosts; entries for non-22 ports need
  `[host]:port` bracket form. ed25519 needs Server ≥ 6.6; fall back to RSA-4096 for older
  instances (version known from the probe).

## §1 Data model & migration

`packages/config` `accountSchema` gains:

```ts
provider: z.enum(["github", "bitbucket-cloud", "bitbucket-server"]).default("github"),
login: z.string(),                      // renamed from githubLogin
loginRef: z.string().optional(),        // BB Cloud: account UUID; DC: userSlug
email: z.string().optional(),           // BB Cloud: Atlassian email (REST Basic auth)
baseUrl: z.string().optional(),         // DC only: instance base URL incl. context path
caCertPath: z.string().optional(),      // DC only: PEM bundle path under keys/
sshHost: z.string().optional(),         // resolved SSH endpoint ("ssh.bitbucket.org",
                                        // "[host]:7999", …); absent for github
tokenExpiresAt: z.string().optional(),  // ISO; BB tokens always expire
remoteKeyId: z.string().optional(),     // replaces githubKeyId (string: BB key UUIDs)
```

Migration: a `z.preprocess` on `parseAccountsConfig` maps legacy `githubLogin` → `login`,
`githubKeyId` → `remoteKeyId` (stringified); `provider` defaults to `"github"`. Existing
`accounts.json` files load unchanged.

Hardening (existing gap): a corrupt/unparseable `accounts.json` currently silently resets
to an empty config, and the next write persists the loss. Change `read()` to
refuse-to-overwrite on corrupt input (same posture as `sessions.json`).

Wire types (`packages/api`):

- `AccountSummary`: add `provider`, `host` (display string, e.g. `bitbucket.mycorp.com`;
  empty for cloud providers is fine), `tokenExpiresAt?`; rename `githubLogin` → `login`
  **but keep `githubLogin` as a deprecated mirror of `login`** so stale desktop bundles
  keep rendering.
- `CreateAccountRequest` becomes a discriminated union:
  ```ts
  { provider?: "github"; label: string; token: string }
  { provider: "bitbucket-cloud"; label: string; email: string; token: string }
  { provider: "bitbucket-server"; label: string; baseUrl: string; username: string;
    token: string; caCertPem?: string }
  ```
- `RepoSummary`: unchanged shape; docs generalized; add `httpsUrl?: string` for the
  HTTPS-fallback clone path (filled from `links.clone` on DC, derived on Cloud/GitHub).
- New `OwnerSummary { id: string; label: string; kind: "user" | "org" | "workspace" | "project" }`
  returned by the owners endpoint (GitHub keeps `user`/`org`).

`workspaceMeta.gitAccountId` is already provider-agnostic — untouched.

## §2 Daemon provider layer

New `apps/daemon/src/providers/`:

```
providers/
  types.ts             // GitProvider interface, ProviderCreds, shared fetch/error helpers
  github.ts            // absorbs repos.ts + GitHub REST bits of accounts.ts
  bitbucket-cloud.ts   // api.bitbucket.org/2.0, Basic email:token
  bitbucket-server.ts  // {baseUrl}/rest/api/1.0, Bearer, CA-aware fetch
  index.ts             // providerFor(account | provider-id) registry
```

Interface (shape; final naming at implementation time):

```ts
interface GitProvider {
  getIdentity(creds): Promise<{ login; loginRef?; name; email }>;
  uploadSshKey(creds, publicKey, label): Promise<{ keyId: string } | ManualUploadNeeded>;
  removeSshKey(creds, keyId): Promise<void>;                    // best-effort on delete
  listRepos(creds): Promise<RepoSummary[]>;
  listOwners(creds): Promise<OwnerSummary[]>;
  createRepo(creds, opts): Promise<RepoSummary>;
  parseRepoUrl(input, account): { owner; repo } | null;         // provider URL grammar
  cloneUrls(creds, ref): Promise<{ ssh?: string; https: string }>;
  sshProbe(account): { target: string; greetingRe: RegExp } | null; // null = SSH off
  credentialLine(account): { host: string; username: string };  // git-credentials entry
  scopesHint: string;
}
```

Per-provider notes:

- **github.ts** — behavior moved, not changed. `repos.ts` is deleted; its duplicate
  `github()` fetch helper unifies with the one from `accounts.ts`.
- **bitbucket-cloud.ts** — identity via `GET /2.0/user` (cache `account_id`/`uuid` as
  `loginRef`, `nickname` as `login`); key upload `POST /2.0/users/{uuid}/ssh-keys` (409 →
  "this key is already registered to another Bitbucket account"); repos via
  `GET /2.0/user/workspaces` → `GET /2.0/repositories/{ws}?role=member` (paginated,
  cached); create via `POST /2.0/repositories/{ws}/{slug}` with `is_private`; SSH clone
  URLs **always rewritten to `git@ssh.bitbucket.org:`**; credential line
  `https://x-bitbucket-api-token-auth:{token}@bitbucket.org`; SSH probe target
  `git@ssh.bitbucket.org`, greeting `logged in as <login>`.
- **bitbucket-server.ts** — all REST through a CA-aware fetch (per-account https agent
  loading `caCertPath`); connect flow probes `application-properties` **before** touching
  the token (wrong-context-path detection; version gates ed25519 vs RSA-4096 keygen);
  repos via `GET /rest/api/1.0/repos?limit=100` (paginate `nextPageStart`/`isLastPage`);
  owners = projects (`GET /rest/api/1.0/projects` + the user's `~personal` project);
  create `POST /rest/api/1.0/projects/{key}/repos`; clone URLs from `links.clone[]`
  (tolerate `name:"http"`; absent `ssh` → HTTPS-only account); key upload
  `POST /rest/ssh/1.0/keys`, 401/403 → `ManualUploadNeeded` with deep link
  `{base}/plugins/servlet/ssh/account/keys`; credential line uses the real username and
  includes the port when non-standard.

`AccountsService` keeps everything generic and delegates:

- keygen (ed25519 default; RSA-4096 for old DC), key/file lifecycle, redaction;
- `writeIncludeFile` — host/username now from `credentialLine()`; adds
  `http.<baseUrl>.sslCAInfo=<caCertPath>` for CA-bearing accounts; the credential-helper
  config key becomes `credential.<https://host>.helper` per account host;
- `bindWorkspace`/`unbindWorkspace` — unchanged;
- `test()` — target + greeting regex from `sshProbe()`;
- `cliAuthSync` — GitHub: `gh hosts.yml` (unchanged, including its documented
  last-writer-wins limitation); Bitbucket (both variants): write
  `<keys>/<accountId>.env` (0600) containing `BITBUCKET_HOST`, `BITBUCKET_USER`,
  `BITBUCKET_TOKEN`, `BITBUCKET_AUTH` (`basic-email` | `bearer`) — a documented
  convention agents can `source`/read on demand; never injected into session env.

SSH/known_hosts: Bitbucket accounts' `core.sshCommand` gains
`-o UserKnownHostsFile=<appdir>/daemon/keys/known_hosts` (daemon-owned file).
bitbucket.org / ssh.bitbucket.org entries are pre-seeded from pinned constants with a
best-effort refresh from `https://bitbucket.org/site/ssh`; DC hosts TOFU via `accept-new`
with `[host]:port` bracket entries. GitHub accounts keep current behavior.

## §3 Routes, URL parsing, UI, errors, testing

**Routes** (shapes preserved, behavior generalized):

- `POST /api/accounts` — discriminated body; DC validates `baseUrl` via the probe first;
  `caCertPem` stored to `<keys>/<id>.ca.pem` (0600).
- `POST /api/accounts/:id/token` — per-provider identity re-validation; refreshes
  `tokenExpiresAt`.
- `GET /api/accounts/:id/repos` — unchanged shape (+`httpsUrl`).
- `GET /api/accounts/:id/orgs` — returns `OwnerSummary[]` (was `string[]`; UI updated in
  the same change; the reference client in `packages/api` updated too).
- `DELETE /api/accounts/:id` — now best-effort deletes the remote key when `remoteKeyId`
  is set (fixes the existing dead-data gap where GitHub keys were orphaned).
- New `POST /api/accounts/:id/confirm-key` — DC manual-upload flow: re-checks
  `GET /rest/ssh/1.0/keys` for the account's public key, persists success.

**URL parsing**: `normalizeRepoUrl` is replaced by per-provider `parseRepoUrl`, resolved
from the workspace's bound account. Grammars:

- GitHub: as today (`https://github.com/o/r`, `git@github.com:o/r.git`, `o/r`).
- BB Cloud: `https://bitbucket.org/ws/r`, `git@bitbucket.org:ws/r.git`,
  `git@ssh.bitbucket.org:ws/r.git`, `ws/r`.
- DC (anchored to the account's `baseUrl`/`sshHost`): `{base}/scm/KEY/r.git`,
  `ssh://git@host[:port]/KEY/r.git`, browse URLs `{base}/projects/KEY/repos/r/browse`
  (and `~user` personal-repo forms), `KEY/r`.

A URL whose host belongs to a different provider than the workspace's account returns a
specific "this workspace is bound to a <provider> account" error, not generic
`INVALID_URL`. Clone execution prefers SSH; falls back to `httpsUrl` + credential store
when the account is HTTPS-only.

**UI** (`packages/ui`):

- Settings section renamed **"Git hosting"** (`id: "git-hosting"`, `GitHostingSettings`;
  the old `"github"` section id is component-local state, not persisted — safe rename).
- Add-account: provider picker → provider-specific fields. Cloud: email + API token, with
  a deep link to the id.atlassian.com scoped-token page and the exact scope list. DC:
  base URL + username + token + optional CA paste (textarea).
- Account rows: provider icon, `@{login}`, host (DC), and a **token-expiry countdown**
  with a warning state ≤30 days (Bitbucket tokens always expire ≤1 year).
- DC manual-key fallback: modal rendering `publicKey` (already on the wire, currently
  never displayed) with copy button, deep link, and "I've added it" → confirm-key.
- `WorkspaceList` / `NewProjectModal`: `@{login}` field rename + provider icon; clone
  placeholder and copy derived from the bound account's provider; create-mode Owner
  dropdown consumes `OwnerSummary` (Cloud: workspaces; DC: project keys + personal);
  visibility toggle maps server-side to `is_private` (Cloud) / `public` (DC).
- Store/ApiClient: `addAccount` takes the discriminated request; `listOrgs` →
  `listOwners` returning `OwnerSummary[]`.

**Error mapping** (distinct, actionable messages): git HTTP 410 = dead app password;
unscoped-Atlassian-token detection at connect (`GET /2.0/user` fails while the token
"looks" valid → hint to create the *scoped* variant); DC 403 "Basic Authentication has
been disabled" surfaced with using-Bearer context; BB Cloud SSH-key 409 (key owned by
another account); 429 → exponential backoff; TLS failures on DC → "add your instance's CA
to this account" hint.

**Testing**: `pnpm check` gate as usual, plus new unit tests (pattern:
`apps/daemon/src/git.test.ts`) for the pure logic — per-provider `parseRepoUrl` grammars,
credential-line generation, accounts-schema migration (legacy `githubLogin` payloads),
DC clone-link selection (http-name quirk, missing ssh). Live verification against real
Bitbucket Cloud and a disposable DC instance is manual, post-implementation.

## Out of scope (v1)

- GitLab / other forges (the provider interface is the extension point).
- OAuth flows (Cloud API tokens and DC HTTP tokens are paste-a-token by design).
- Bitbucket repo/project/workspace **access tokens** (resource-scoped; can't manage SSH
  keys; Premium-gated) — user-level tokens only.
- `bkt` or any CLI auto-configuration (helper env file is the v1 contract).
- Automatic token renewal (no API exists to mint Atlassian tokens); v1 ships expiry
  warnings + re-paste.
- Smart-mirror-aware cloning on DC (clone links may point at mirrors; v1 uses them as-is).
