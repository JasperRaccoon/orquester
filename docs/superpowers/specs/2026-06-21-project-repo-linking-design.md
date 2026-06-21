# Project ↔ GitHub repo linking — Design

**Date:** 2026-06-21
**Status:** Draft (awaiting spec review)

## Overview

Two related changes to the workspace/project flow:

1. **Bug fix** — connected git accounts disappear from the workspace-creation
   dropdown after a daemon restart, and only reappear after visiting Settings →
   GitHub. Root cause is a stale client list, not a daemon problem.
2. **Feature** — let a **project** inside a workspace be created from a GitHub
   **repo**: pick one the workspace's account can access, paste a repo URL
   (public or private), or create a brand-new repo. A repo cloned into the
   project directory means any agent session launched there can read the repo's
   `AGENTS.md` / `CLAUDE.md` with no extra work.

### Goal

One sentence: when creating a project in a git-linked workspace, offer to clone
an existing repo (picked or by URL) or create a new one, reusing the workspace
account's GitHub token (for REST) and SSH key (for clones).

## Decisions (locked)

| Decision | Choice |
| --- | --- |
| Credential model for list/create | **Persist a scoped GitHub token** per account at rest (`0600`, never returned by any API) |
| Which account a project's repo comes from | **The workspace's linked account** (`workspace.gitAccountId`); repo features are offered only when the workspace has a linked account with a token |
| Repo owner scope (list + create) | **Personal + orgs** — list owned/collaborator/org repos; "create new" lets you choose the owner (your login or an org you can create in) |
| Code structure | **Extend in place** (Approach A): one project route with a discriminated body; REST helpers in a small `repos.ts`; clone on `AccountsService` |
| New-repo defaults | `private` + `auto_init: true` (gives a default branch + README to clone) |
| Project ↔ repo persistence | **None new** — rely on the cloned repo's `.git/config` remote (no `projects.json` for the MVP) |
| Clone transport | **SSH only**, using the account's existing key; the token is never used on a clone command line |

## Key architectural insight

The token and the SSH key serve **disjoint** purposes, which keeps secrets off
git command lines:

| Operation | Credential | Already exists? |
| --- | --- | --- |
| List repos (`GET /user/repos`) | token (REST) | token must be persisted (new) |
| List orgs (`GET /user/orgs`) | token (REST) | " |
| Create repo (`POST /user/repos` or `/orgs/:org/repos`) | token (REST) | " |
| Clone a repo (public or private) | SSH key (`git clone git@github.com:…`) | **yes** — key registered on GitHub, wired via `core.sshCommand` |

So the token appears only in `Authorization: Bearer` headers to `api.github.com`
(via the existing `github()` helper, `apps/daemon/src/accounts.ts:344`), and the
clone uses the existing per-account SSH key. No token ever enters a clone URL or
argv.

---

## Part 1 — The dropdown bug

### Root cause

The workspace-creation dropdown (`packages/ui/src/components/sidebar/WorkspaceList.tsx:184`)
renders `store.accounts` unconditionally — there is **no** verified/tested flag
(the account schema has none). `store.accounts` is populated only by
`loadAccounts()`, which is wired into the **one-time** startup path
(`initConnections`, `packages/ui/src/store/app.ts:652`) but **omitted from the
reconnect fan-out** (`establish()`, `app.ts:545`, which reloads
workspaces/sessions/registry only). After a daemon restart the client reconnects
through `establish()` and never re-fetches accounts, so the list is stale/empty.

Clicking "Test" only *appears* to fix it: reaching the button means opening
Settings → GitHub, whose `useEffect` calls `loadAccounts()`
(`SettingsModal.tsx:277`) and refills the store.

### Fix

Add `get().loadAccounts()` to the `Promise.all([...])` in `establish()`
(`app.ts:545`), so accounts reload on every (re)connect exactly like
workspaces/sessions/registry. One line. Ship this first (independent of Part 2).

---

## Part 2 — Project from repo

### A. Account & token model — `packages/config` + `apps/daemon/src/accounts.ts`

- **Schema** (`packages/config/src/index.ts:314`, `accountSchema`): add
  `token: z.string().optional()` — the GitHub PAT. Persisted in `accounts.json`
  under `<appdir>/daemon/`. Ensure that file is written `0600` (the `keys/` dir
  is already `0700`; the token now warrants the same care).
- **Wire projection** (`AccountSummary`, `packages/api/src/index.ts:68`): add
  `repoAccess: boolean`, derived as `!!account.token` in `toSummary()`
  (`accounts.ts:70`). The token itself is **never** returned (same guarantee as
  `keyPath` / `githubKeyId`).
- **New accounts:** the connect flow already collects a PAT and currently
  discards it (`accounts.ts:178`). Stop discarding it, and **expand the requested
  scopes** from `write:public_key, user:email, read:user` to also include
  `repo` + `read:org` (update the scope hint in `github()`, `accounts.ts:366`,
  and any connect-time copy in the UI).
- **Existing accounts** (token already discarded): new route
  `POST /api/accounts/:id/token` with `{ token }`. The handler validates via
  `GET /user` and **rejects if the returned login ≠ the account's `githubLogin`**
  (prevents wiring the wrong identity / a typo'd token), then stores it. No new
  broadcast channel is required — the store action refetches accounts after a
  successful call so `repoAccess` flips in the UI (`accounts.changed` event is a
  possible future nicety, out of scope; single-user).

### B. Daemon endpoints — `apps/daemon/src/index.ts`

All under the existing `/api/accounts` and `/api/workspaces` auth policy
(allowed remotely; no key/token material returned).

- `GET /api/accounts/:id/repos` → `RepoSummary[]`. Lists everything the account
  can reach: `GET /user/repos?affiliation=owner,collaborator,organization_member&per_page=100&sort=pushed`,
  following pagination (`Link` header) to completion. 400 if the account has no
  token (`repoAccess:false`) — same precondition code as the project route below.
- `GET /api/accounts/:id/orgs` → `string[]` of org logins
  (`GET /user/orgs`). The UI composes the create-owner list as
  `[account.githubLogin, ...orgs]`.
- Extend `POST /api/workspaces/:workspace/projects` (`index.ts:510`) to accept a
  **discriminated** body (default keeps today's behavior).

### C. Wire contracts — `packages/api/src/index.ts`

```ts
export interface RepoSummary {
  fullName: string;       // "owner/name"
  owner: string;
  name: string;
  private: boolean;
  sshUrl: string;         // git@github.com:owner/name.git
  defaultBranch: string;
  description: string | null;
}

// replaces the current CreateProjectRequest ({ name: string })
export type CreateProjectRequest =
  | { source?: "empty"; name: string }
  | { source: "clone"; url: string; name?: string }          // url: full URL, git@…, or owner/repo
  | { source: "create"; owner: string; name: string; visibility: "private" | "public"; description?: string };
```

`source` is optional and defaults to `"empty"` so existing callers (and the
"New Folder" path) keep working unchanged. `AccountSummary` gains
`repoAccess: boolean`.

### D. REST helpers — `apps/daemon/src/repos.ts` (new)

A small module of token-only functions (no `AccountsService` dependency), reusing
the same fetch/error shape as the existing `github()` helper:

- `listRepos(token): Promise<RepoSummary[]>` — paginated `GET /user/repos`.
- `listOrgs(token): Promise<string[]>` — `GET /user/orgs`.
- `createRepo(token, { owner, login, name, visibility, description }): Promise<RepoSummary>`
  — `POST /user/repos` when `owner === login`, else `POST /orgs/:owner/repos`;
  body includes `private: visibility === "private"`, `auto_init: true`.

`AccountsService` exposes thin wrappers that keep the token private —
`listRepos(id)` / `listOrgs(id)` / `createRepo(id, opts)` look up the account,
read its token, and delegate to `repos.ts`. This is the only place the token is
read.

### E. Clone primitive — `apps/daemon/src/accounts.ts`

The current `git()` helper is `private` and returns `void` (`accounts.ts:319`).
Add a public:

```ts
cloneRepo(id, sshUrl, destName, cwd): Promise<void>
```

It runs `git clone <sshUrl> <destName>` with `cwd` set to the workspace dir and
`GIT_SSH_COMMAND` set explicitly from the account's key —
`ssh -i "<keyPath>" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new`
(the exact string already built at `accounts.ts:266`). Setting
`GIT_SSH_COMMAND` makes the clone use the right key deterministically rather than
relying on `includeIf` evaluation timing during clone. `HOME` is pinned as in the
other git calls. Errors (auth failure, repo not found, destination exists) are
surfaced with stderr so the route can map them to 4xx + a useful message.

### F. Project route orchestration — `apps/daemon/src/index.ts:510`

Branch on `source`:

- `"empty"` (or absent) — today's behavior: `mkdir` the validated name.
- `"clone"` — normalize `url` (`https://github.com/owner/repo(.git)`,
  `git@github.com:owner/repo.git`, or `owner/repo`) to the SSH form; derive
  `destName` from `name ?? repo name`; validate with `isValidName`
  (`index.ts:1062`); reject if the dir already exists (409); call
  `accounts.cloneRepo(workspaceAccountId, sshUrl, destName, workspaceDir)`.
- `"create"` — `accounts.createRepo(workspaceAccountId, …)` (REST), then
  `cloneRepo` the returned `sshUrl` into the project dir.

In all repo modes the account id is resolved from the **workspace's**
`gitAccountId` (read from `workspaces.json`); 400 if the workspace has no linked
account or the account has no token. The response stays `ProjectSummary`.

### G. UI — `packages/ui`

- **Promote project creation to a modal.** Today it's an inline `NewItemInput`
  in `ProjectList.tsx:71`. Replace the "New Project" action with a modal
  (mirroring `WorkspaceList.tsx:150`) offering three modes:
  - **Empty** — name only (current behavior; also the "New Folder" path).
  - **Clone** — a searchable repo picker (from `GET /api/accounts/:id/repos`)
    *and* a "paste a URL" field; optional name override.
  - **Create new** — owner dropdown (`[githubLogin, ...orgs]`), name,
    visibility (default **Private**), optional description.
- **Gating:** resolve the current workspace's account from
  `workspace.gitAccountId` + `store.accounts`. If the workspace has no linked
  account → only **Empty**. If it has an account with `repoAccess:false` → repo
  modes are disabled with an **"Enable repo access"** CTA that opens Settings →
  GitHub (the token field).
- **Settings → GitHub:** add a token field / "Enable repo access" affordance per
  account that calls `POST /api/accounts/:id/token`, then refetches accounts.
- **Plumbing:** extend `createProject` (store `app.ts:915`) →
  `workspaceService.createProject` (`workspace-service.ts:26`) →
  `ApiClient.createProject` (`api-client.ts:200`) to carry the discriminated
  payload. Add `ApiClient.listRepos(accountId)` / `listOrgs(accountId)` /
  `setAccountToken(accountId, token)`. Repo/org lists load lazily when the modal
  opens.
- **agents.md/claude.md:** no work — it's just a file in the cloned dir that
  agent sessions read via their cwd.

### H. Security

- Token never crosses the wire outbound (only `repoAccess:boolean`); `?token=`
  log redaction already exists; ensure the new token is not logged. `accounts.json`
  written `0600`.
- Token validated against `githubLogin` on save (wrong-account guard).
- Clones use SSH only — no token in argv/URL. The `keyPath` placed in
  `GIT_SSH_COMMAND` is a filesystem path, not key material.
- `POST /api/accounts/:id/token` follows the existing `/api/accounts` auth
  (allowed remotely). `PUT /api/config/daemon` remains socket-only — unchanged.

## Files touched

**New**

- `apps/daemon/src/repos.ts` — `listRepos` / `listOrgs` / `createRepo` (token-only REST).
- `packages/ui/src/components/sidebar/NewProjectModal.tsx` — the three-mode modal
  (name may differ; could also live alongside `ProjectList.tsx`).

**Modified**

- `packages/config/src/index.ts` — `accountSchema.token?`.
- `apps/daemon/src/accounts.ts` — keep + persist token; `repoAccess` in
  `toSummary`; expanded scopes; `setToken(id, token)` (with `GET /user`
  validation); `listRepos/listOrgs/createRepo` wrappers; public `cloneRepo`;
  ensure `accounts.json` `0600`.
- `apps/daemon/src/index.ts` — `POST /api/accounts/:id/token`,
  `GET /api/accounts/:id/repos`, `GET /api/accounts/:id/orgs`; discriminated
  `POST /api/workspaces/:workspace/projects`.
- `packages/api/src/index.ts` — `RepoSummary`, discriminated `CreateProjectRequest`,
  `AccountSummary.repoAccess`, client methods.
- `packages/ui/src/store/app.ts` — `loadAccounts()` in `establish()` (**the bug
  fix**); `createProject` accepts the payload; repo/org/token actions.
- `packages/ui/src/services/workspace-service.ts`,
  `packages/ui/src/lib/api-client.ts` — carry the new payload + new endpoints.
- `packages/ui/src/components/sidebar/ProjectList.tsx` — open the modal.
- `packages/ui/src/components/settings/SettingsModal.tsx` — token field /
  "Enable repo access".

## Non-goals (YAGNI)

- No `projects.json` / per-project metadata file — `.git/config` is the source of
  truth for a project's remote.
- No non-GitHub hosts (the system is GitHub-only; host is hardcoded).
- No HTTPS-with-token clone path (SSH covers public + private for github.com).
- No OAuth/GitHub-App flow, no token refresh, no token-scope introspection
  beyond the `GET /user` identity check.
- No live cross-client broadcast of token/repo-access changes (single-user;
  refetch-after-mutation is enough).
- No repo deletion, archival, branch/PR management — creation + clone only.
- No "link an existing local project to a repo after the fact" — repo choice is
  at project-creation time only.

## Edge cases

- **Workspace has no linked account** → only Empty mode; repo endpoints 400.
- **Account has no token** (existing account) → repo modes disabled with the
  "Enable repo access" CTA; `repoAccess:false`.
- **Wrong/expired/revoked token** → `GET /user` (on save) or the REST list fails;
  surface GitHub's message; saving a mismatched-login token is rejected.
- **Destination dir already exists** → 409 with a clear message (don't clobber).
- **Private org repo with SSO not authorized for the key** → clone fails at SSH;
  surface stderr (user must authorize the key for the org — outside our control).
- **URL variants** — accept `https://…(.git)`, `git@…`, and `owner/repo`
  shorthand; all normalize to `git@github.com:owner/repo.git`.
- **Name collisions / invalid names** — derived/override name runs through
  `isValidName`; reject up front.
- **`auto_init` + clone race** — `auto_init:true` means the repo has a commit by
  the time `POST /user/repos` returns, so the immediate clone is non-empty.
- **Large repo lists / pagination** — follow `Link` headers to completion;
  picker is searchable client-side.

## Build order

1. **Bug fix** (Part 1) — one line, independent; ship first.
2. **Token model + capture/migration** (A) + `repoAccess` surfacing + Settings
   token field.
3. **List endpoints** (B/D) + **clone primitive** (E) + project route `clone`
   mode (F) + modal **Clone/Empty** (G).
4. **Create-repo** (createRepo in D + route `create` mode) + modal **Create** mode.

## Verification

No test runner in the repo (`pnpm check` is the gate), so:

1. `pnpm check` (typecheck across the workspace) is clean.
2. Manual + Playwright against the running web app:
   - **Bug fix:** connect an account; restart the daemon; reload the client;
     confirm the account is still in the workspace-creation dropdown **without**
     visiting Settings.
   - **Token:** enable repo access on an existing account; confirm `repoAccess`
     flips and repo modes enable.
   - **Clone (picker):** create a project from a picked **private** org repo;
     confirm it clones and a launched agent session can read its `AGENTS.md`/`CLAUDE.md`.
   - **Clone (URL):** repeat with a pasted public URL and a `owner/repo` shorthand.
   - **Create:** create a new private repo under the user and under an org;
     confirm it exists on GitHub and is cloned into the project dir.
   - **Negative:** wrong-login token rejected; clone into an existing dir → 409;
     workspace without an account shows only Empty.
