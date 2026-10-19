# Repo-grouped projects in the sidebar

Status: draft, awaiting approval.

## Intent

A workspace often holds several clones of one GitHub repo: `JasperEngine`,
`JasperEngine-2`, `orquester`, `orquester-3`, `orquester-4`. Today they appear
as one flat, alphabetical list of project rows, so it's hard to see which ones
belong together, and there's no quick way to start another clone.

The new sidebar groups a workspace's projects under a header for their repo,
the way T3 Code does. Each header shows an icon and label the user chooses.
Each group also has a "+" button that makes a fresh clone of that repo for a
new piece of work, named after the task, like "Shader optimization" or
"Multiplayer". Projects that don't come from a remote repo keep the current
look and go below the groups under "OTHER PROJECTS".

Target layout (inside the expanded `jaspersito` workspace):

```
⌄ [🦝] JasperRaccoon/JasperEditor      2  +  ⋯
     ◇ JasperEditor
     ◇ JasperEditor2
⌄ [⚙️] JasperRaccoon/JasperEngine      3  +  ⋯
     ◇ JasperEngine            ← active row keeps today's accent bar
     ◇ Shader optimization
     ◇ Multiplayer
› [🟩] JasperRaccoon/orquester         4  +  ⋯   ← collapsed
OTHER PROJECTS
  ◇ Aaaaa
  ◇ CRYPTORISK
(to-do lists, archived footer — unchanged)
```

## Goals

1. Inside the open workspace, group projects by their remote repo. Each group
   gets a header row with these parts, left to right:
   - a collapse chevron
   - the repo icon (about 24px, rounded corners)
   - the repo label
   - a project count badge
   - a "+" button
   - a ⋯ menu (right-click opens the same menu)
2. A repo with only one clone still gets its own header. (User decision.)
3. Projects with no remote `origin` go in an "OTHER PROJECTS" section after
   all groups. That includes non-git folders, local-only repos and failed
   detection. Their rows look exactly like today's.
4. Every repo can have a custom **icon** and a custom **label**. The icon is
   one of:
   - an emoji;
   - an uploaded image. One over 2 MB is shrunk and re-encoded automatically,
     and the user never has to resize it themselves (user decision);
   - the favicon of a website domain the user types, e.g. `matssmile.com` for
     MatsSmile (user decision).

   The icon and label are stored once per repo on the daemon, so
   every workspace, device and client (desktop and web) sees the same ones.
   (User decision.)
5. The "+" on a group makes a **fresh `git clone`** of that repo into a new
   project folder in the same workspace. The user types only the name. (User
   decision.)
6. The repo's icon and label also appear in the opened-agents list. (User
   decision: identity follows the repo everywhere it shows.)

## Non-goals

- No git worktrees, branch creation or PR linking from "+". The new clone
  starts on the repo's default branch.
- No project display names separate from folder names. "Shader optimization"
  is the folder name, and the daemon's `isValidName` already allows spaces.
- No change to which workspace a project belongs to, and no grouping across
  workspaces. Groups live inside the expanded workspace.
- No change to to-do lists, archived projects, the archived footer or the
  workspace accordion.
- No auto-fetched icons (GitHub avatars, favicons). Until the user picks an
  icon, a neutral default shows.

## Anti-goals (would count as failure even if it works)

- Projects silently landing in the wrong group, or vanishing, because repo
  detection failed. Anything uncertain falls back to "OTHER PROJECTS".
- Losing a repo's custom icon or label when its projects are renamed,
  deleted, archived or all removed.
- An uploaded SVG that can run script, or icon bytes or a credential-bearing
  origin URL leaking through an unauthenticated route.
- The favicon fetch letting the daemon be pointed at loopback, private,
  link-local or cloud-metadata addresses (SSRF), directly, through DNS or
  through a redirect.
- Rejecting a large photo with "file too big" and leaving the user to resize
  it themselves.
- Making the sidebar noticeably slower. No extra `git` processes per listing.

## Current state the design builds on

- `ProjectSummary.repoId` (`packages/api/src/index.ts:114-129`), filled by
  `detectRepoId` (`apps/daemon/src/repo-id.ts`) in `listProjects`
  (`apps/daemon/src/index.ts:~4919-4942`):
  - **Remote origin:** normalized `host/owner/repo` with no scheme or user, a
    lowercased host and no `.git`, e.g. `github.com/JasperRaccoon/JasperEngine`.
  - **Local-only repo:** an absolute realpath.
  - **Otherwise:** absent.
- The client only receives the normalized id. The origin URL itself is never
  sent.
- Sidebar code:
  - `WorkspaceList.tsx` is the accordion. Only the open workspace mounts
    `WorkspaceProjects`.
  - `WorkspaceProjects.tsx` renders the flat `ProjectRow`s (:185), then the
    to-do lists, then `ArchivedFooter`.
  - Search is `matchesSidebarQuery(query, p.name)`.
- `NewProjectModal` takes only `{open, onClose}`, resets to "empty" mode on
  every open, and always targets `currentWorkspace`. Clone has two paths:
  - **Server-side:** needs the workspace's git account; request
    `{source:"clone", url, name?}`.
  - **Typed `git clone` with a review step:** used when there's no account.
  - A default-name clone of an existing repo returns 409
    (`accounts.ts:790-797`).
- Opened agents: `groupAgentSessionsByRepo` (`lib/opened-agents.ts`) already
  orders cards by `repoId`, but no repo header is rendered.
- No live project or workspace list events exist. Saved prompts and to-dos are
  the model for a daemon store with broadcast events.
- No emoji picker exists in `packages/ui`.

## Design

### 1. Grouping (UI only)

- A pure function in `packages/ui/src/lib/` turns the open workspace's visible
  projects into `{ groups: RepoGroup[], other: ProjectSummary[] }`.
- A project is grouped when its `repoId` is present and is **not** an absolute
  path. Reuse the path check `repoTitle` already does (`/`, `\` or a drive
  letter), and share one helper with `opened-agents.ts`.
- **Default label:** the `repoId` without its host segment (`JasperRaccoon/JasperEngine`),
  which is `repoTitle`'s current output.
- **Label shown:** the custom label if set, otherwise the default. The header
  tooltip always shows the full `repoId`.
- **Order:**
  - Groups sort naturally and case-insensitively by the label shown.
  - Projects inside a group, and in "OTHER PROJECTS", sort by name as today.
- **Search:**
  - A project row matches on its name, as today.
  - A group shows if its label or `repoId` matches, in which case all its
    projects show, or if any of its projects match, in which case only those
    projects show.
  - A group with no match is hidden.
  - While a search is active, every shown group is expanded no matter its
    saved collapse state.
- **Collapse state** is saved per device in localStorage key
  `orquester:collapsed-repo-groups`, as a list of `repoId`s that is global
  across workspaces. It's parsed and validated the same way as
  `sidebar-view.ts` and kept in sync with `useSyncExternalStore`.
  - Default is expanded.
  - The group holding the active project is shown expanded even when it's in
    the collapsed list, so the active row is never hidden.
- **"OTHER PROJECTS"** is a small uppercase section header (match
  `SectionHeader` in `parts.tsx` or the mockup), followed by today's
  `ProjectRow`s. Hide the header when it has no rows. When the workspace has
  no groups at all, the section header is still shown as long as it has
  rows, so the layout stays consistent.
- `ProjectRow` stays the same apart from indentation inside a group. The
  active accent bar, workflow temp marker and project ⋯ menu all stay.
- Search hits from other workspaces (`WorkspaceList.tsx:110-123, 259-270`)
  stay flat rows.

### 2. Repo identity store (daemon + config + API)

**Persisted record**, schema in `packages/config`, file path from a new helper
next to `savedPromptsPath`, e.g. `repoIdentitiesPath(appdir)` →
`repo-identities.json`:

```ts
interface RepoIdentityRecord {
  repoId: string;                 // normalized remote id; never an absolute path
  label?: string;                 // trimmed, 1–80 chars
  icon?:
    | { kind: "emoji"; value: string }                       // one grapheme cluster, ≤ 32 bytes
    | {
        kind: "image";
        file: string;
        contentType: string;
        version: string;
        source?: { kind: "favicon"; domain: string }; // absent = uploaded by the user
      };
  updatedAt: string;              // ISO
}
```

- **Parsing:** tolerant, following `parseSavedPromptsConfig`.
  - Keep unknown top-level keys and unknown record fields.
  - Keep rejected records rather than dropping them.
  - Throw on a broken outer shape so the daemon moves the file aside.
- **Daemon service:** follows `SavedPromptsService`, with a serialized write
  chain, atomic 0600 writes and move-aside on corruption.
- **Image files** live in a daemon-owned directory from a config path helper,
  e.g. `<appdir>/daemon/repo-icons/`.
  - Files are named from a random id plus an extension, never from `repoId`.
  - Replacing or resetting an icon deletes the old file after the record
    write succeeds.
- A record with neither `label` nor `icon` is removed.

**Validation on every route:**

- `repoId`: non-empty, ≤ 512 chars, not absolute, no `..` segments, no control
  characters.
- Image upload:
  - Raw `application/octet-stream` body through the existing
    `upload-stream.ts` helpers, with `repoId` and `contentType` in the query.
  - Size cap is **2 MB**, checked against the declared length and while
    streaming.
  - Allowed content types are `image/png`, `image/jpeg`, `image/webp` and
    `image/svg+xml`. Favicons may also be `image/x-icon`; that is accepted
    only from the favicon fetch, not from uploads.
  - The daemon sniffs magic bytes for PNG, JPEG, WebP and ICO
    (`00 00 01 00`), and checks that an SVG parses as XML with a root `<svg>`.
    A mismatch is a 400.
  - The daemon never resizes images; it only enforces the cap. Shrinking
    happens in the client before upload (§3a).

**Routes**, with paths and request/response types defined first in
`packages/api` and then implemented in the daemon. Names are indicative; the
builder may align them with existing conventions.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/repo-identities` | `{ identities: RepoIdentity[] }`. No image bytes; each image icon has `version` for cache-busting |
| PUT | `/api/repo-identities/label` | `{ repoId, label: string \| null }`. `null` clears it |
| PUT | `/api/repo-identities/emoji` | `{ repoId, emoji: string }`. Replaces any image icon |
| POST | `/api/repo-identities/icon?repoId=…&contentType=…` | binary upload. Replaces any emoji icon |
| POST | `/api/repo-identities/favicon` | `{ repoId, domain }`. The daemon fetches and stores the site's icon (§3b). Replaces the current icon only on success |
| GET | `/api/repo-identities/icon?repoId=…` | image bytes |
| DELETE | `/api/repo-identities/icon?repoId=…` | back to the default icon |

- All routes are on the normal authenticated remote transport and the
  socket. Don't add a `?token=` exemption.
- Image GET responses send:
  - the stored `Content-Type`
  - `X-Content-Type-Options: nosniff`
  - `Content-Security-Policy: sandbox; default-src 'none'; style-src 'unsafe-inline'`
  - `Cache-Control: private, max-age=31536000, immutable` (the URL carries `version`)
- The UI fetches image bytes through the shared API client with auth, and shows
  them in an `<img>` from `URL.createObjectURL`, reusing
  `hooks/use-object-url.ts`. Never use `<object>`, `<iframe>` or
  `dangerouslySetInnerHTML`, so an SVG can't run script.
- **Live updates:**
  - Each change publishes on a new broadcaster channel, e.g. `repoIdentities`,
    with event `repoIdentity.changed`. The payload is the full record, or
    `{ repoId, deleted: true }`.
  - The UI store applies events the same way `applySavedPromptEvent` does, so
    other devices update without reloading.
  - The store loads the full list on connect and reconnect.
- The identity store is the source of truth for icons and labels only. It
  never changes grouping, which is still driven by each project's live
  `repoId`.

### 3. Header ⋯ menu and editors

The repo group's ⋯ menu uses the existing `ContextMenu`, which has no
submenus. Items:

- **Change icon…** opens a small dialog with three choices:
  - **Emoji:** a single text field. The OS emoji picker works there.
    Validated client-side and on the daemon as exactly one grapheme cluster
    using `Intl.Segmenter`. No emoji-picker dependency.
  - **Image:** a file input that accepts any image the browser can decode,
    with a preview. If the file would go over the cap, it's shrunk first
    (§3a), and the preview notes the change, e.g. "Compressed 6.3 MB →
    84 KB".
  - **Website:** a domain field, e.g. `matssmile.com`. Submitting asks the
    daemon to fetch that site's icon (§3b).
    - While it runs, the dialog shows a spinner. On success it shows the
      result; on failure, an inline error such as "Couldn't reach
      matssmile.com" or "No icon found on matssmile.com".
    - When the current icon came from a favicon, the field is prefilled with
      its domain, so submitting again refreshes it.
  - The dialog also has "Remove icon" when an icon is set.

### 3a. Shrinking large uploads (client)

A UI helper, e.g. `prepareRepoIconUpload(file) → { blob, contentType, originalBytes }`,
runs before every upload.

- **Sent unchanged:** a PNG, JPEG, WebP or SVG of 2 MB or less.
- **Re-encoded:** anything else, meaning a file over 2 MB or a decodable type
  outside the allowed list (GIF, BMP, AVIF, HEIC where Safari can decode it).
  1. Decode with `createImageBitmap`. Load SVGs and other formats it rejects
     through an `<img>` from an object URL instead.
  2. Draw onto a canvas scaled so the longest side is ≤ 512 px. Never upscale.
  3. Encode as `image/webp` at quality 0.9.
  4. If the browser didn't produce WebP (check `blob.type`; older Safari falls
     back to PNG), encode as PNG instead.
  5. While the result is still over 2 MB, lower the quality in steps down to
     0.6, then halve the dimensions. Give up below 64 px with "That image is
     too large to use".
- An undecodable file shows "That image couldn't be read". Animated images
  keep only their first frame.
- The 2 MB cap and the type check on the daemon stay authoritative. The
  client step is for convenience only.
- Unit-test the step-down decisions with a pure function that takes measured
  sizes. The canvas work itself is a thin wrapper around it.

### 3b. Website favicon (daemon)

**Input.** The domain field accepts `matssmile.com`, `www.matssmile.com` or
`https://matssmile.com/anything`. The daemon reduces it to a hostname with
`URL`, using punycode for IDNs. Rejected:

- IP literals;
- ports and credentials;
- `localhost`;
- single-label names;
- anything over 253 chars.

**Fetch.**

1. GET `https://<host>/` (HTTPS only) with:
   - an 8 s total timeout;
   - at most 3 redirects, each re-checked against the guard below;
   - a 1 MB cap on the HTML;
   - a plain `User-Agent` naming Orquester.
2. Read the `<link>` tags whose `rel` contains `icon` or `apple-touch-icon`
   (or `apple-touch-icon-precomposed`). `mask-icon` is skipped. A small
   tolerant tag scan of the `<head>` is enough; no HTML-parser dependency.
3. Resolve each `href` against the final URL after redirects. `data:` URLs of
   allowed types count as candidates.
4. Try candidates in this order:
   1. SVG `icon`;
   2. `icon` or `apple-touch-icon` with the largest declared `sizes` of at
      least 64 px;
   3. any other `apple-touch-icon`;
   4. any other `icon`;
   5. `/favicon.ico` at the final origin.
5. Try at most 4 fetches. Each one is capped at 2 MB, guarded and sniffed
   like an upload. The first valid image wins.

**Store.** The winning image is saved like an upload, with
`source: { kind: "favicon", domain }`, and broadcast like any other change.
It's a snapshot: the daemon never re-fetches it on its own.

**SSRF guard.** Put this in a small daemon module, e.g. `safe-fetch.ts`, using
the existing `undici` dependency.

- Resolve the host with `dns.lookup(..., { all: true })`. Reject it if **any**
  address is:
  - loopback;
  - private: 10/8, 172.16/12, 192.168/16;
  - link-local: 169.254/16 or fe80::/10;
  - CGNAT 100.64/10;
  - ULA fc00::/7;
  - multicast or unspecified;
  - an IPv4-mapped form of any of the above;
  - a known metadata host.
- Pin the connection to the vetted address through an undici `Agent` with a
  `connect.lookup` that returns it, so DNS rebinding can't swap it.
- Every redirect hop goes through the same check.
- Errors reaching the client name the domain and the failure type
  (unreachable, no icon, blocked address, too large). They never include
  response bodies.

**Rate.** Allow one favicon fetch per `repoId` at a time. A second request
while one is running gets a 409.
- **Rename label…** opens an inline rename, like `NewItemInput`. An empty
  value resets to the default label.
- **Copy repo id** copies the full `repoId`.

### 4. "+" → fresh clone

- **Clone URL:** add an optional `cloneUrl` to `ProjectSummary`. It's the raw
  `origin` URL that `listProjects` already reads from git config, with any
  `user:password@` userinfo removed. SSH `git@host:` forms are kept as they
  are. It's set only when `repoId` is a remote id.
  - Reuse the credential-stripping already in `GitService.remoteUrl`
    (`git.ts:579`) so the rule lives in one place, and don't spawn `git`.
  - Tests must show that no credential reaches the response.
- The group's `cloneUrl` comes from any of its projects. They share the
  normalized id, so any one will do; prefer the active project's, then the
  first by name.
- **`NewProjectModal`** gets an optional `preset` prop:
  `{ kind: "clone-repo"; url: string; repoLabel: string }`.
  - With a preset, it opens in Clone mode with the repo fixed. The modal title
    names the repo, and the URL and repo picker are hidden.
  - The **name field is empty, focused and required**.
  - Typing a name that already exists in the workspace is caught before
    submit, which also avoids the 409.
  - Submit uses the existing paths unchanged:
    - **Workspace has a git account:** a server-side clone with
      `{ source: "clone", url, name }`. A daemon-side error, such as the
      account's provider not matching the origin host, shows in the modal as
      it does today.
    - **No account:** the existing typed `git clone` review flow, with the
      typed name as the folder name.
  - Opening the modal without a preset behaves exactly as it does today.
- `ProjectsView` holds the preset next to `projectModalOpen`, and the group's
  "+" sets both.
- After a **server-side** clone, the new project appears in the group on its
  own: the project list is reloaded after creation, as today, and the new
  folder shares the same `repoId`.
- The **typed-clone** path is used when there's no account, or the account
  has no repo access.
  - `createProjectWithCommand` (`store/app.ts:~2031`) reloads the list while
    the folder is still empty, so at first the project shows under "OTHER
    PROJECTS".
  - When that setup terminal session exits, reload the workspace's project
    list once, so the finished clone moves into its group.
  - Use the existing session-exit signal the store already receives. Don't
    poll or wait on a timer.
  - It's acceptable for it to sit in "OTHER PROJECTS" while the clone is still
    running.

### 5. Opened agents

Opened agents still show as a flat list of cards, but each card picks up the
repo's identity:

- The card shows the repo's icon at about 14px before its project or workspace
  line, but only when the project is grouped (remote `repoId`).
- Search also matches the repo label.
- The group order that `groupAgentSessionsByRepo` already applies stays as is.

### 6. Where identity shows, and caching

"Everywhere" means these places in this change:

- the repo-group headers;
- the opened-agent cards;
- the flat search hits from other workspaces in `WorkspaceList`, which get the
  same small icon.

Recent projects, the command palette, the attention center and the project
header are out of scope.

Icon image bytes are cached once per `(repoId, version)` in the UI store, as a
shared blob URL that is revoked when replaced or when the client disconnects.
Each mounted icon doesn't fetch on its own.

### 7. Identity key

The daemon computes the key, so the client never canonicalizes anything.
`listProjects` adds three fields to `ProjectSummary`, all read off the
checkout's `origin` remote:

- `repoKey`: `repoKeyOf(origin)` from `workflows/git-remote/remote-url.ts`.
  It is lowercased, folds host aliases and reduces Bitbucket Data Center
  paths to one form. This is the key that saved prompts already use.
- `repoName`: `repoDisplayName(origin)`, the original-case `owner/repo` used
  as the default label.
- `cloneUrl`: `stripUrlCredentials(origin)`.

How each part uses them:

- Grouping in the sidebar is keyed by `repoKey`. A project without one goes
  under "OTHER PROJECTS".
- Identity records are keyed by `repoKey`. The contracts are in
  `packages/api/src/repo-identities.ts`, which provides `repoKeyProblem` for
  validation.
- Opened agents look up the icon by the project's `repoKey`, taken from the
  project index.
- `repoId` is unchanged, so MCP's `repoId` and `sameRepo` stay the same.

## Constraints (from AGENTS.md)

- Transport types go in `packages/api` first, then daemon handlers and UI
  callers.
- Persisted-data validation lives in `packages/config`, with path helpers
  rather than hardcoded paths. Records written by other app versions are
  tolerated.
- Uploads go as binary streams, not JSON.
- Auth decisions stay on the server, and no credentials appear in responses
  or logs.
- localStorage values are validated before they reach shared UI state.
- `packages/ui` is shared by the desktop and web apps, so check both. The
  layout has to work in the narrow mobile drawer (the screenshots are mobile).

## Tests

- **UI lib:**
  - Grouping: remote vs local vs absent `repoId`, single-clone groups, custom
    vs default labels, ordering, search narrowing, the active-group override
    of collapse.
  - The collapsed-groups localStorage parser.
  - The shared "is remote repo id" helper.
  - The upload shrink step-down decisions: passthrough, re-encode on type,
    re-encode on size, quality then dimension steps, the give-up floor.
- **Config:** identity-store parser round-trip, preserving unknown fields and
  rejected records, and throwing on a bad outer shape.
- **Daemon:**
  - Identity routes: label set and clear, emoji validation, image upload over
    the cap, wrong magic bytes, bad SVG, a GET that sets the security headers,
    old file removed on replace, `repoId` validation, broadcast emitted.
  - `cloneUrl` in `listProjects` with credentials stripped.
  - Favicon:
    - domain normalization and rejection;
    - link-tag scanning and candidate order over fixture HTML;
    - redirect handling;
    - the ICO sniff;
    - the SSRF guard against every blocked range, including IPv4-mapped IPv6
      and a redirect to a private address.
    - Use a local fixture server or an injected fetch/lookup. Tests never hit
      the real network.
  - `detectRepoId` / `normalizeGitUrl`, which have no tests yet.
- Run `pnpm check`, `pnpm test` and `pnpm build`, since this changes emitted
  web and desktop assets.

## Calls I made (not decided by the user)

- Stored icons are limited to 2 MB and to PNG, JPG, WebP or SVG, plus ICO for
  favicons. SVG is only ever shown through `<img>` from a blob URL.
- Shrinking happens in the client with a canvas, so the daemon needs no image
  library. When it re-encodes, it targets WebP with the longest side ≤ 512 px,
  which is plenty for a 24 px icon. Any image type the browser can decode is
  accepted and converted.
- The daemon fetches favicons directly from the site, over HTTPS only, behind
  an SSRF guard. There's no third-party favicon service, so domains aren't
  sent to Google or anyone else. The fetched icon is a snapshot; entering the
  domain again refreshes it.
- Any remote host counts for grouping (GitHub, Bitbucket, others), not only
  GitHub. Local-only repos go to "OTHER PROJECTS".
- Collapse state is per device and global across workspaces, groups start
  expanded, and the active project's group is always expanded.
- A search match on the repo name shows the whole group.
- Emoji input is a validated text field with no picker library.
- Clone URL: `ProjectSummary.cloneUrl` is the origin URL with credentials
  removed.
- In opened agents, identity shows as a small icon on each card rather than
  new group headers.
- "Copy repo id" is the only extra item in the ⋯ menu.
- On a typed (no-account) clone, the project list reloads once when the setup
  terminal exits, so the new clone moves from "OTHER PROJECTS" into its group.
- Identity shows in the group headers, the opened-agent cards and the search
  hits from other workspaces. Recent projects, the command palette and the
  project header are not changed.
- The grouping and identity key is the daemon's existing `repoKeyOf`, the same
  key saved prompts use. It's case-insensitive for every host and the shown
  label keeps the original case.

## Left to the builder

- Exact route names and component and file names, within the shapes above.
- Header visual details (spacing, badge style), matching the existing sidebar
  tokens and the reference mockup.
- Whether `RepoGroup` reuses the `groupAgentSessionsByRepo` types or gets its
  own.
