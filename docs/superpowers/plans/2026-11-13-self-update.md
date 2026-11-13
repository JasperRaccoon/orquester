# Self-update Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the server's commit as its version, detect when a VPS install is behind its GitHub branch (hourly), tell the user, and update from a button.

**Architecture:** The daemon compares its commit with its checkout's `origin` branch through the GitHub compare API and exposes the result plus an update trigger at `/api/self-update`. The trigger writes a request file; a root systemd path unit starts a oneshot that runs the existing `remote-update.sh` through a small wrapper writing a status file. The shared UI shows the state in Settings → About and a toast, and reloads once the daemon comes back on a new commit.

**Tech Stack:** TypeScript (tsx, Fastify, node:test), React (`packages/ui`), bash + systemd.

**Spec:** `docs/superpowers/specs/2026-11-13-self-update-design.md`

## Global Constraints

- Check at boot and every **3 600 000 ms** (one hour); never more often on a timer.
- "Out of date" only when GitHub's compare `status` is `"behind"` (`behind_by > 0`).
- Status file path comes from `ORQUESTER_SELF_UPDATE_STATUS`; its presence is the `canUpdate` capability.
- Request file: `join(daemonConfigDir(baseDir), "update-request")` — add a `selfUpdateRequestPath(baseDir)` helper in `packages/config`.
- Root never writes inside a directory the `orquester` user owns; status lives in `/var/lib/orquester-update/`.
- UI copy in English. Toast: title "Orquester is out of date", message "{N} commit(s) behind {branch}. Update it from Settings.", action "Open settings".
- No new export only for a test; tests through existing seams (AGENTS.md).

## Review Focus

1. Running commit unknown (null) or origin not GitHub → status reports `error`, no toast, no crash. (Task 3 test.)
2. GitHub API 403/rate-limit or network failure → keeps the previous result, records `error`. (Task 3 test.)
3. Double click / two tabs → second POST gets 409, only one request file. (Task 4 test.)
4. Wrapper: request file must be gone after a run, even when `remote-update.sh` fails, or the path unit loops. (Task 5 test.)
5. Client during the restart: `/api/self-update` and `/api/info` fail for minutes; the UI keeps waiting and reloads only on a *different* commit, and shows `failed`/`reverted`. (Task 6 test.)

---

### Task 1: Commit-only server version label

**Files:**
- Modify: `packages/ui/src/lib/server-version.ts`
- Test: `packages/ui/src/lib/server-version.test.ts`

- [ ] **Step 1:** Change the test: `serverVersionLabel({ version: "0.0.0", commit: "5397e75b…40 chars" })` → `"5397e75"`; `{ version: "1.2.3", commit: null }` → `null`; null info → null. Remove assertions about the `version · commit` form.
- [ ] **Step 2:** Run `cd packages/ui && TSX_DISABLE_CACHE=1 node --import tsx --test src/lib/server-version.test.ts` → FAIL.
- [ ] **Step 3:** `serverVersionLabel(info: Pick<ServerInfoResponse, "commit"> | null | undefined): string | null` returns the 7-char short commit or null. Update the doc comment and the `ServerVersionRow` comment in `GeneralSettings.tsx`.
- [ ] **Step 4:** Re-run → PASS.
- [ ] **Step 5:** Commit `fix(settings): show the server's commit as its version`.

### Task 2: API contract

**Files:**
- Create: `packages/api/src/self-update.ts`; Modify: `packages/api/src/index.ts` (add `export * from "./self-update.ts";`)
- Modify: `packages/config/src/index.ts` (add `selfUpdateRequestPath`)

**Interfaces — Produces:**
```ts
export const selfUpdateRoutes = { status: "/api/self-update" } as const; // GET status, POST start
export type SelfUpdateRunState = "running" | "succeeded" | "failed" | "reverted";
export interface SelfUpdateRun {
  state: SelfUpdateRunState;
  from: string | null;        // commit before the run
  startedAt: string;          // ISO
  finishedAt?: string;
  exitCode?: number;
}
export interface SelfUpdateStatusResponse {
  current: string | null;     // running commit (full sha)
  branch: string;             // "main"
  repo: string | null;        // "owner/name" when origin is on GitHub
  latest: string | null;      // branch head sha
  behindBy: number;           // 0 unless strictly behind
  checkedAt: string | null;
  error: string | null;       // last check's failure, human readable
  canUpdate: boolean;
  run: SelfUpdateRun | null;
}
export function parseSelfUpdateRun(value: unknown): SelfUpdateRun | null; // tolerant: unknown state/shape → null
```
`packages/config`: `export function selfUpdateRequestPath(baseDir: string): string` → `joinPath(daemonConfigDir(baseDir), "update-request")`.

- [ ] **Step 1:** Write the file, export it; `pnpm --filter @orquester/api typecheck` (check the package script name) passes. The parser is exercised by Task 3/6 tests.
- [ ] **Step 2:** Commit `feat(api): self-update contract`.

### Task 3: Daemon update checker

**Files:**
- Create: `apps/daemon/src/self-update/service.ts`
- Test: `apps/daemon/src/self-update/service.test.ts`

**Interfaces:**
- Consumes: `BuildInfo` (`build-info.ts`), `findRepoRoot`, Task 2 types.
- Produces:
```ts
export interface SelfUpdateDeps {
  repoRoot: string | null;
  commit: string | null;
  requestPath: string;              // selfUpdateRequestPath(baseDir)
  statusPath: string | null;        // env ORQUESTER_SELF_UPDATE_STATUS
  fetch?: typeof fetch;
  intervalMs?: number;              // default 3_600_000
  branch?: string;                  // default "main"
}
export class SelfUpdateService {
  constructor(deps: SelfUpdateDeps);
  start(): void;                    // check now, then setInterval(...).unref()
  stop(): void;
  check(): Promise<void>;           // one comparison; never throws
  status(): Promise<SelfUpdateStatusResponse>;
  requestUpdate(): Promise<"started" | "busy" | "unavailable">;
}
export function githubRepoFromRemoteUrl(url: string): string | null; // "owner/name"
```
Origin URL: read `.git/config` under `repoRoot` (`[remote "origin"]` → `url =`); accept `git@github.com:o/r(.git)`, `https://github.com/o/r(.git)`, `ssh://git@github.com/o/r`. Compare request: `GET https://api.github.com/repos/${repo}/compare/${branch}...${commit}` (base = branch, so `base_commit.sha` is the branch head and `status: "behind"`/`behind_by` describe the running commit) with `Accept: application/vnd.github+json`, `User-Agent: orquester-daemon`, 15 s `AbortSignal.timeout`.

- [ ] **Step 1: Failing tests** (temp repo root with a `.git/config`, injected `fetch`):
  - `reports behind with the count and head` — fetch returns `{ status: "behind", behind_by: 3, base_commit: { sha: H } }`; expect `behindBy: 3, latest: H, error: null`, and the URL ends `repos/JasperRaccoon/orquester/compare/main...<commit>`.
  - `ahead or diverged is not out of date` → `behindBy: 0`.
  - `a failed check keeps the last result and records the error` — first call behind 3, second fetch rejects / returns 403 → `behindBy: 3`, `error` non-null.
  - `no GitHub origin or unknown commit reports why and never fetches` — fetch spy not called; `error` set.
  - `githubRepoFromRemoteUrl` accepts the three URL forms, rejects `https://gitlab.com/o/r`.
  - `requestUpdate`: statusPath null → `"unavailable"`; status file `{state:"running"}` → `"busy"`; request file already present → `"busy"`; otherwise writes the request file → `"started"` and a second call → `"busy"`.
  - `status().run` reads the status file through `parseSelfUpdateRun` (garbage → null).
- [ ] **Step 2:** `cd apps/daemon && TSX_DISABLE_CACHE=1 node --import tsx --test src/self-update/service.test.ts` → FAIL.
- [ ] **Step 3:** Implement. Request file written with `writeFile(path, "", { flag: "wx" })` (EEXIST → busy), creating its directory.
- [ ] **Step 4:** Re-run → PASS.
- [ ] **Step 5:** Commit `feat(daemon): check the running commit against GitHub hourly`.

### Task 4: Routes and wiring

**Files:**
- Create: `apps/daemon/src/self-update/routes.ts` (`registerSelfUpdateRoutes(app: FastifyInstance, deps: { service: SelfUpdateService }): void`)
- Test: `apps/daemon/src/self-update/routes.test.ts`
- Modify: `apps/daemon/src/index.ts` — build the service next to `buildInfo` (~line 557) with `repoRoot: findRepoRoot(...)` (reuse what `daemonBuildInfo` uses), `statusPath: process.env.ORQUESTER_SELF_UPDATE_STATUS || null`; add to the services object; `start()` it with the other background work and `stop()` on shutdown; register the routes where `registerSecretFilesRoutes` is registered (both transports, behind the `/api` bearer hook).

- [ ] **Step 1: Failing test** with `Fastify()` + a service built on temp paths: GET answers the status shape; POST → 202 `{ started: true }`; second POST → 409 `{ code: "SELF_UPDATE_BUSY" }`; with no status path POST → 409 `{ code: "SELF_UPDATE_UNAVAILABLE" }`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement + wire. **Step 4:** Run → PASS; `pnpm --filter @orquester/daemon typecheck` passes.
- [ ] **Step 5:** Commit `feat(daemon): /api/self-update`.

### Task 5: Host side — units and wrapper

**Files:**
- Create: `deploy/lib/self-update.sh`, `deploy/orquester-update.service`, `deploy/orquester-update.path`, `deploy/lib/self-update.test.mjs`
- Modify: `deploy/install-unit.sh`, `deploy/orquester.service`, root `package.json` test list, `deploy/README.md`

`self-update.sh` (env: `REQUEST_FILE`, `STATUS_FILE`, `UPDATE_SCRIPT`, `REPO_DIR` default `/opt/orquester`, `BRANCH` default `main`): `rm -f "$REQUEST_FILE"` first; write `{"state":"running","from":"<HEAD>","startedAt":"…"}` atomically (tmp + `mv` in the status file's own directory, mode 0644); run `REPO_DIR=… BRANCH=… bash "$UPDATE_SCRIPT"`; map exit 0/3/other → `succeeded`/`reverted`/`failed` and rewrite the status with `finishedAt`, `exitCode`. Wrap the body in `main() { …; }; main "$@"` .

`orquester-update.service`: `Type=oneshot`, `RuntimeDirectory=orquester-update`, `StateDirectory=orquester-update` (mode 0755), `Environment=HOME=/root PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin REQUEST_FILE=/var/lib/orquester/daemon/update-request STATUS_FILE=/var/lib/orquester-update/status.json UPDATE_SCRIPT=/run/orquester-update/remote-update.sh`, `ExecStartPre=/usr/bin/install -m 0700 /opt/orquester/deploy/lib/self-update.sh /opt/orquester/deploy/lib/remote-update.sh /run/orquester-update/`, `ExecStart=/bin/bash /run/orquester-update/self-update.sh`, `TimeoutStartSec=infinity`. No `[Install]`.
`orquester-update.path`: `PathExists=/var/lib/orquester/daemon/update-request`, `Unit=orquester-update.service`, `[Install] WantedBy=paths.target`.
`orquester.service`: add `Environment=ORQUESTER_SELF_UPDATE_STATUS=/var/lib/orquester-update/status.json`.
`install-unit.sh`: install both units when their source exists (same `cmp`/`install` idiom; one `daemon-reload` if anything changed), then `systemctl enable --now orquester-update.path`. Never start the service.

- [ ] **Step 1: Failing test** (`node:test`, temp dirs, stub `UPDATE_SCRIPT` that exits with `$STUB_EXIT`, REPO_DIR a temp git repo): for exits 0, 3, 1 the status file ends `succeeded`/`reverted`/`failed` with that `exitCode` and `from` = the repo HEAD; the request file is gone in every case; while the stub runs it can read status `running` (stub copies the status file aside).
- [ ] **Step 2:** `node --test deploy/lib/self-update.test.mjs` → FAIL. **Step 3:** Implement. **Step 4:** PASS; `bash -n` on all changed scripts; `systemd-analyze verify deploy/orquester-update.service deploy/orquester-update.path` if available (record if not).
- [ ] **Step 5:** Add the test to root `package.json` `test`; document the units and the status file in `deploy/README.md` (one paragraph next to "Deploy health check"). Commit `feat(deploy): self-update units`.

### Task 6: UI — Settings row, toast, reload

**Files:**
- Modify: `packages/ui/src/lib/api-client.ts` — `selfUpdateStatus(signal?): Promise<SelfUpdateStatusResponse>` (GET) and `startSelfUpdate(): Promise<void>` (POST), paths from `selfUpdateRoutes`.
- Create: `packages/ui/src/lib/self-update.logic.ts` + `self-update.logic.test.ts`
- Create: `packages/ui/src/components/status/UpdateAvailableToast.tsx`; Modify `ToastStack.tsx`
- Modify: `packages/ui/src/components/settings/GeneralSettings.tsx` — "Updates" `SettingRow` under Server version.

**Interfaces — Produces (`self-update.logic.ts`):**
```ts
export type UpdatePhase = "idle" | "updating" | "done" | "failed" | "reverted";
/** After a start from `fromCommit`: what the client should show/do given the latest poll (null = request failed). */
export function nextUpdatePhase(fromCommit: string, status: SelfUpdateStatusResponse | null): UpdatePhase;
export function updateToastKey(status: SelfUpdateStatusResponse): string | null; // `latest` when behindBy > 0, else null
export function readDismissedUpdate(storage: Pick<Storage, "getItem">): string | null; // validates a sha, else null
export function writeDismissedUpdate(storage: Pick<Storage, "setItem">, latest: string): void;
```
`nextUpdatePhase`: null → `updating`; `current !== fromCommit` → `done`; `run.state` `failed`/`reverted` with `run.from === fromCommit` → that state; else `updating`.

- [ ] **Step 1: Failing tests** for `nextUpdatePhase` (null poll stays updating; same commit + running stays updating; new commit → done; reverted/failed reported; a stale `failed` run from an older `from` is ignored) and the dismiss round-trip (garbage in storage → null).
- [ ] **Step 2:** Run `cd packages/ui && TSX_DISABLE_CACHE=1 node --import tsx --test src/lib/self-update.logic.test.ts` → FAIL. **Step 3:** Implement the logic.
- [ ] **Step 4:** Components. Settings row: label "Updates"; description by state — "Up to date", "{N} commits behind {branch}", "Couldn't check for updates: {error}", or when `!canUpdate` and behind, "Update with ./deploy.sh deploy". Button "Update" when `canUpdate && behindBy > 0`; on click `startSelfUpdate()`, then poll `selfUpdateStatus` every 3 s, ignoring failures, and on `done` run the existing `reloadApp` (move it to a shared helper in the same file, no new module); `failed`/`reverted` show a `Notice` with "Update failed" / "Update failed; the previous version was restored" and `journalctl -u orquester-update`. Toast: fetch status on mount and hourly via `useApi()`; show when `updateToastKey` is non-null and differs from the dismissed key; "Open settings" → `openSettings("general")` (check the section id) and dismiss; X → dismiss.
- [ ] **Step 5:** Run the logic tests → PASS; `pnpm --filter @orquester/ui typecheck`; check `apps/web` and `apps/desktop` typecheck via `pnpm check:changed`.
- [ ] **Step 6:** Commit `feat(ui): out-of-date toast and one-click update`.

### Task 7: Verify and finish

- [ ] `pnpm check:changed` → green; plus `node --test deploy/lib/self-update.test.mjs deploy/lib/remote-update.test.mjs`.
- [ ] `git diff --check`; review the full diff.
- [ ] Record what wasn't run (a real systemd round-trip on a VPS) in the final report.
