# claudex Addon — Build Plan Part 1 of 3: Daemon (working proxy: install · seed · route · spawn)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **This is the first of three plans that together ship the whole addon — all written now, none deferred:**
> - **Part 1 (this file):** daemon — verified binary install, credential seeding + per-account prefix routing, proxy lifecycle, launcher enablement.
> - **Part 2 — `2026-07-23-claudex-addon-frontend.md`:** wire contract + `ApiClient`/store, Settings "Model proxy" UI, launcher **model + account chips**, disabled rendering, tab badges, usage attribution.
> - **Part 3 — `2026-07-23-claudex-addon-workflow-deploy.md`:** the canonical claudemix tri-model workflow, in-session §8 routing verification, deploy + full live end-to-end.

**Goal:** Turn the Phase-1 scaffolding into a **working headless proxy**: the daemon downloads and SHA-256-verifies the stock CLIProxyAPI release binary, generates config, spawns/adopts the proxy, seeds Codex/Claude OAuth **by file conversion** from existing managed accounts (no browser flow) with a per-account routing prefix, seeds the dedicated claude-homes, and flips the `claudex`/`claudemix` launchers on when healthy — all verified by the daemon test suite plus a real on-VPS enable/seed/launch that never touches the live daemon.

**Architecture:** Extend `CliProxyManager` (Phase 1) with three new pure/injected modules — `cliproxy-install.ts` (verified binary install), `cliproxy-seed.ts` (credential conversion) — and wire real adapters + `enable()` orchestration in `index.ts`. The proxy runs as an `orqsvc-cliproxy` tmux service session (Phase-1 methods) or a direct child fallback. UI, wire-client, usage attribution, the claudemix workflow, and deploy are **Phase 3/4** (roadmap at the end).

**Tech Stack:** TypeScript 5.8 ESM, Node 20, node:test (`apps/daemon` `pnpm test`), tmux ≥ 3.2, CLIProxyAPI stock release (linux amd64).

## Global Constraints

- **⛔ Never launch/restart/bind the live Orquester daemon** (47831 / daemon.sock). Verify with `pnpm check` + `apps/daemon` unit tests, and the on-VPS live task (Task 9) which uses a **throwaway appdir + spare port**, never the real daemon.
- `pnpm check` clean after every task; daemon tests: `cd apps/daemon && node --import tsx --test src/<file>` per task, full suite at close-out.
- **Ship the stock release binary — no Go/source build** (spike F3). Pin version + per-platform SHA-256 in code; digest is the integrity check, not the tag.
- **Seed credentials by conversion** (spike F4/F5); device-auth is a later fallback (Phase 3). Field mappings are fixed in spec §4.
- Secrets: `secrets.json` authoritative (0600, fail-closed on corrupt — Phase-1 `parseCliProxySecrets` returns `"corrupt"`); `config.yaml`/`token` are projections; only the management `secret-key` is hashed by the proxy.
- `/api/cliproxy` mutations are HTTP-bearer-only, refused over the Unix socket (Phase-1 `refusedOnSocket` pattern — reuse it for the new mutation routes).
- Model names validated against `MODEL_NAME_RE` (Phase-1, `@orquester/config`).
- Commit per task, by-name staging (no `git add -A`), directly to `main` (no branches/worktrees).
- Pinned CLIProxyAPI: **v7.2.95**, asset `CLIProxyAPI_7.2.95_linux_amd64.tar.gz`, sha256 `826604e2dbf11913b0f373047f7bca1829eb2bab8a45d3a1916cc2534c7a9fd5` (verified in the spike; update deliberately on bump).

## File Structure (Phase 2)

```
apps/daemon/src/cliproxy-install.ts        CREATE  download + sha256 verify + atomic install + rollback
apps/daemon/src/cliproxy-install.test.ts   CREATE
apps/daemon/src/cliproxy-seed.ts           CREATE  managed-cred → CodexTokenStorage/ClaudeTokenStorage converters
apps/daemon/src/cliproxy-seed.test.ts      CREATE
apps/daemon/src/cliproxy.ts                MODIFY  enable() install+project+seedHome; persistence-lost re-parent; provider status; seed coupling
apps/daemon/src/cliproxy-manager.test.ts   MODIFY  new enable/seed/status/reparent tests
apps/daemon/src/agent-accounts.ts          MODIFY  proxy-owned skip in refresh (dual-refresher owner rule)
apps/daemon/src/agent-accounts.test.ts     MODIFY
apps/daemon/src/index.ts                   MODIFY  real spawnDirect; enable install adapter; seed/openrouter routes; seedHome wiring
packages/api/src/index.ts                  MODIFY  CliProxySeedRequest + providers/accounts population in status
docs/superpowers/spikes/2026-07-23-claudex-phase2-live.md   CREATE  Task 9 live-verification log
```

Continues in **Part 2** (frontend: Settings "Model proxy" UI, provider chips, seed-from-account picker, model chips + **per-launcher account chips** (claudex→Codex family, claudemix→Claude family; the `NewTabMenu` launcher-id→provider-family remap of spec §5), disabled rendering, `ApiClient`/store wiring, usage scanner/watcher extension) and **Part 3** (claudemix workflow + §8 routing + deploy). This Part 1 lands the daemon half of per-launch account routing — the prefix on seeds and the contributor mapping — so Part 2's chips are pure UI over an already-working mechanism. **Device-auth `login/*` is intentionally out of the whole build** (an optional future add-on needing a management-API sub-spike): seeding from managed accounts covers the actual use case; the Phase-1 `login/*` 501 stubs stay stubbed with the socket-refusal guard added when/if built. Phase 4: claudemix canonical workflow + §8 harness-routing checks + deploy + cost measurement.

---

### Task 1: `cliproxy-install.ts` — verified stock-binary install

**Files:**
- Create: `apps/daemon/src/cliproxy-install.ts`
- Test: `apps/daemon/src/cliproxy-install.test.ts`

**Interfaces:**
- Consumes: `cliproxyDir` (Phase-1 `@orquester/config`).
- Produces:
  - `const CLIPROXY_RELEASE = { version: "v7.2.95", asset: "CLIProxyAPI_7.2.95_linux_amd64.tar.gz", sha256: "826604e2dbf11913b0f373047f7bca1829eb2bab8a45d3a1916cc2534c7a9fd5" } as const`
  - `interface InstallDeps { fetchTarball(url: string, destTmp: string): Promise<void> }` (injected; tests pass a fake that copies a fixture tarball — no network in unit tests).
  - `async function installBinary(daemonDir: string, deps: InstallDeps): Promise<{ installed: boolean; version: string }>` — resolves the release URL (`https://github.com/router-for-me/CLIProxyAPI/releases/download/<version>/<asset>`), downloads to a private temp file under `cliproxyDir/.tmp`, **computes sha256 and rejects on mismatch** (throws `Error("cliproxy binary sha256 mismatch")`), extracts `cli-proxy-api` from the tarball, moves the current `bin/cli-proxy-api` (if any) to `bin.prev/`, atomically installs the new binary 0755, cleans the temp file. Idempotent: if `bin/cli-proxy-api` already exists and records the pinned version in `cliproxy.json`-adjacent marker, skip re-download (caller decides; keep this function pure-install).
  - `async function rollbackBinary(daemonDir: string): Promise<boolean>` — swaps `bin.prev/cli-proxy-api` back to `bin/`; returns false if no prior binary.
  - `function releaseUrl(): string` — the pinned URL.
  - `defaultFetchTarball` — the real `fetch`-to-file implementation (streamed), used by `index.ts`, NOT by unit tests.

- [ ] **Step 1: Write the failing test** — `cliproxy-install.test.ts` (build a fixture tarball in-test with `node:zlib`+`tar`? simpler: use a stored small tar via `child_process` `tar`. Since the repo shells out to tar elsewhere, use it):

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { installBinary, rollbackBinary } from "./cliproxy-install.ts";
const exec = promisify(execFile);

async function makeFixtureTarball(dir: string, content: string) {
  const src = join(dir, "src"); await mkdir(src, { recursive: true });
  await writeFile(join(src, "cli-proxy-api"), content, { mode: 0o755 });
  const tgz = join(dir, "fixture.tgz");
  await exec("tar", ["-czf", tgz, "-C", src, "cli-proxy-api"]);
  const sha = createHash("sha256").update(await readFile(tgz)).digest("hex");
  return { tgz, sha };
}

test("installBinary verifies sha256, installs 0755, keeps prior in bin.prev", async () => {
  const root = await mkdtemp(join(tmpdir(), "cliproxy-install-"));
  try {
    const { tgz, sha } = await makeFixtureTarball(root, "#!/bin/sh\necho v1\n");
    const deps = { fetchTarball: async (_url: string, dest: string) => { await exec("cp", [tgz, dest]); } };
    // pin the fixture's sha for the test by monkeypatching is ugly; instead installBinary
    // takes an optional expectedSha override for testability:
    const r = await installBinary(root, deps, sha);
    assert.equal(r.installed, true);
    const bin = join(root, "cliproxy", "bin", "cli-proxy-api");
    assert.equal((await stat(bin)).mode & 0o777, 0o755);
    // second install of a different binary moves the first to bin.prev
    const f2 = await makeFixtureTarball(join(root, "b"), "#!/bin/sh\necho v2\n");
    await installBinary(root, { fetchTarball: async (_u, d) => { await exec("cp", [f2.tgz, d]); } }, f2.sha);
    assert.match(await readFile(bin, "utf8"), /v2/);
    assert.equal(await rollbackBinary(root), true);
    assert.match(await readFile(bin, "utf8"), /v1/); // rolled back
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("installBinary rejects a sha256 mismatch and does not install", async () => {
  const root = await mkdtemp(join(tmpdir(), "cliproxy-install-bad-"));
  try {
    const { tgz } = await makeFixtureTarball(root, "malicious");
    const deps = { fetchTarball: async (_u: string, d: string) => { await exec("cp", [tgz, d]); } };
    await assert.rejects(() => installBinary(root, deps, "0".repeat(64)), /sha256 mismatch/);
    await assert.rejects(stat(join(root, "cliproxy", "bin", "cli-proxy-api")));
  } finally { await rm(root, { recursive: true, force: true }); }
});
```

  Note: give `installBinary(daemonDir, deps, expectedSha = CLIPROXY_RELEASE.sha256)` a third optional arg so tests inject the fixture's real digest; production calls omit it.

- [ ] **Step 2: Run to verify failure** — `cd apps/daemon && node --import tsx --test src/cliproxy-install.test.ts` → FAIL (module missing).
- [ ] **Step 3: Implement** `cliproxy-install.ts` per the Produces block. Extract via `execFile("tar", ["-xzf", tmp, "-C", extractDir, "cli-proxy-api"])` (reuse the shell-out-to-tar pattern the repo already uses in `zip.ts`/`archive.ts`). `defaultFetchTarball` streams `fetch(url)` body to a file.
- [ ] **Step 4: Run test + `pnpm check`** → clean.
- [ ] **Step 5: Commit** — `git add apps/daemon/src/cliproxy-install.ts apps/daemon/src/cliproxy-install.test.ts && git commit -m "feat(daemon): cliproxy stock-binary install with sha256 verify and rollback"`

---

### Task 2: `cliproxy-seed.ts` — managed-credential → proxy auth-file converters

**Files:**
- Create: `apps/daemon/src/cliproxy-seed.ts`
- Test: `apps/daemon/src/cliproxy-seed.test.ts`

**Interfaces:**
- Produces (pure functions — no I/O, fully unit-testable with synthetic blobs):
  - `function jwtClaims(jwt: string): Record<string, unknown>` — base64url-decode the payload segment; `{}` on malformed.
  - `function accountPrefix(accountId: string): string` — the deterministic per-account routing prefix (§2): `"acc" + accountId.replace(/-/g, "").slice(0, 8)`. Slug-safe (matches `MODEL_NAME_RE` path segment). Computed identically here (seed) and in the contributor (launch), so no stored map is needed.
  - `function codexStorageFromAuthJson(authJson: unknown, accountId: string): { file: string; storage: object }` — from the managed Codex `auth.json` shape `{tokens:{id_token,access_token,refresh_token,account_id}, last_refresh}`, produce the `CodexTokenStorage` object per spec §4 (`type:"codex"`, `email`/`account_id` from the id_token claim `https://api.openai.com/auth`, `expired` = RFC3339 of the access_token `exp`) **plus a top-level `prefix: accountPrefix(accountId)`** (CLIProxyAPI flattens it to `Auth.Prefix`), and a filename `codex-<accountPrefix>.json`. Throws `Error("codex auth.json missing tokens")` if shape invalid.
  - `function claudeStorageFromCredentials(creds: unknown, accountId: string): { file: string; storage: object }` — from `{claudeAiOauth:{accessToken,refreshToken,expiresAt}}`, produce `ClaudeTokenStorage` (`type:"claude"`, `expired` = RFC3339 of `expiresAt` ms, `id_token`/`email` blank) **plus `prefix: accountPrefix(accountId)`**, filename `claude-<accountPrefix>.json`.
  - `function accessTokenFreshMs(storage: { expired: string }): number` — ms until the `expired` timestamp (negative if past) — the caller warns/blocks on a stale token to avoid triggering a proxy refresh (dual-refresher).
  - RFC3339 formatting helper (avoid `Date.now()` in pure funcs — take the token's own exp; no wall-clock needed for conversion).

- [ ] **Step 1: Write the failing test** (synthesize a JWT with a known payload — `base64url(JSON)` — no real secrets):

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { codexStorageFromAuthJson, claudeStorageFromCredentials, jwtClaims } from "./cliproxy-seed.ts";

const b64url = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
const fakeJwt = (payload: object) => `x.${b64url(payload)}.y`;

test("codex conversion maps fields from tokens + id_token claim", () => {
  const idClaims = { email: "a@b.com", exp: 111, "https://api.openai.com/auth": { chatgpt_account_id: "acct-123" } };
  const acClaims = { exp: 1785569405 };
  const authJson = {
    tokens: { id_token: fakeJwt(idClaims), access_token: fakeJwt(acClaims), refresh_token: "rt", account_id: "raw" },
    last_refresh: "2026-07-22T07:30:06Z",
  };
  const { file, storage } = codexStorageFromAuthJson(authJson) as any;
  assert.equal(storage.type, "codex");
  assert.equal(storage.email, "a@b.com");
  assert.equal(storage.account_id, "acct-123");
  assert.equal(storage.access_token, authJson.tokens.access_token);
  assert.equal(storage.expired, "2026-08-01T07:30:05Z"); // RFC3339 of exp 1785569405
  assert.match(file, /^codex-.*\.json$/);
});

test("claude conversion maps from claudeAiOauth and stamps a routing prefix", () => {
  const creds = { claudeAiOauth: { accessToken: "at", refreshToken: "rt", expiresAt: 1784791605497 } };
  const { file, storage } = claudeStorageFromCredentials(creds, "14137047-98b2-4cf1") as any;
  assert.equal(storage.type, "claude");
  assert.equal(storage.access_token, "at");
  assert.equal(storage.expired, "2026-07-23T07:26:45Z"); // RFC3339 of 1784791605497 ms
  assert.equal(storage.prefix, "acc14137047");           // acc + first 8 hex, dashes stripped
  assert.match(file, /^claude-acc14137047\.json$/);
});

test("two accounts of one provider get distinct prefixes → individually routable", () => {
  const a = accountPrefix("65eebd90-01d1-4063-b743-c4a5713f5519");
  const b = accountPrefix("14137047-98b2-4cf1-9b54-b18a22a85a62");
  assert.notEqual(a, b);
  assert.equal(a, "acc65eebd90"); // "acc" + first 8 hex of the dash-stripped uuid
});

test("invalid shapes throw, not silently produce garbage", () => {
  assert.throws(() => codexStorageFromAuthJson({}, "x"), /missing tokens/);
  assert.throws(() => claudeStorageFromCredentials({}, "x"), /missing claudeAiOauth/);
});
```

- [ ] **Step 2: Run to verify failure** → FAIL (module missing).
- [ ] **Step 3: Implement** `cliproxy-seed.ts`. RFC3339 from a unix-seconds exp: build it deterministically (`new Date(exp*1000).toISOString().replace(/\.\d+Z$/, "Z")`) — `new Date(n)` with an argument is allowed (only argless `new Date()`/`Date.now()` are workflow-script-forbidden; this is normal daemon code, no such restriction).
- [ ] **Step 4: Run test + `pnpm check`** → clean.
- [ ] **Step 5: Commit** — `git commit -m "feat(daemon): cliproxy credential converters (managed Codex/Claude → proxy auth files)"` (staging both new files by name)

---

### Task 3: Dual-refresher owner rule in `agent-accounts.ts`

**Files:**
- Modify: `apps/daemon/src/agent-accounts.ts` (the `AgentAccountRecord` + `ensureFreshForUsage`/idle-refresh path)
- Modify: `packages/config/src/index.ts` (persisted account record schema: add `proxyOwned?: boolean`)
- Test: `apps/daemon/src/agent-accounts.test.ts` (extend)

**Interfaces:**
- Produces:
  - `AgentAccountRecord.proxyOwned?: boolean` (persisted). New methods on `AgentAccountsService`: `markProxyOwned(id: string, owned: boolean): Promise<void>` (persists the flag, broadcasts the accounts change).
  - `ensureFreshForUsage(id)` and any idle/interval refresh **skip accounts where `proxyOwned === true`** — returning the last-known reading without refreshing (the proxy is the sole refresher). Add a guard at the top of the refresh path.

- [ ] **Step 1: Write the failing test:**

```ts
test("a proxy-owned account is never refreshed by the account service", async () => {
  const { svc, fakeRefresh } = await makeAccountsHarnessWithRefreshSpy(); // extend existing harness
  const id = await importCodexFixtureAccount(svc);
  await svc.markProxyOwned(id, true);
  await svc.ensureFreshForUsage(id);
  assert.equal(fakeRefresh.callCount, 0, "proxy-owned → no refresh (single refresher)");
  await svc.markProxyOwned(id, false);
  await svc.ensureFreshForUsage(id); // still may skip if fresh; force-expire in the harness
  assert.ok(fakeRefresh.callCount >= 1, "ownership released → refresh resumes");
});
```

  (Adapt to `agent-accounts.test.ts`'s actual harness — reuse its account-import + refresh-stub setup; if no refresh spy exists, inject one via the same seam the existing refresh tests use.)

- [ ] **Step 2: Run to verify failure** → FAIL.
- [ ] **Step 3: Implement** the `proxyOwned` field + `markProxyOwned` + the refresh guard.
- [ ] **Step 4: Run `agent-accounts.test.ts` + `pnpm check`** → clean.
- [ ] **Step 5: Commit** — `git commit -m "feat(daemon): proxy-owned account flag skips account-service refresh (single-refresher rule)"`

---

### Task 4: `enable()` orchestration — install → project → spawn → seedHome

**Files:**
- Modify: `apps/daemon/src/cliproxy.ts` (`enable()`, add an injected `install` adapter + `seedHomes` step; use Phase-1 `renderConfigYaml`/`writeProjections`/`seedHome`)
- Modify: `apps/daemon/src/cliproxy-manager.test.ts`

**Interfaces:**
- Consumes: Task 1 `installBinary`, Phase-1 `writeProjections`/`seedHome`, Phase-1 secrets loader.
- Produces (extend `CliProxyAdapters`):
  - `install(): Promise<{ version: string }>` — injected; production wires `installBinary(daemonDir, { fetchTarball: defaultFetchTarball })`. Tests fake it to drop a dummy binary at `cliproxy/bin/cli-proxy-api`.
  - `systemClaudeDir(): string` — injected source dir for `seedHome` (production: `CLAUDE_CONFIG_DIR || ~/.claude`).
  - `enable()` new order (each surfaced via the `building`/`downloading` `detail`): load-or-init secrets (fail-closed on corrupt → `error`, no writes); `await adapters.install()`; `writeProjections(daemonDir, secrets, state)`; `await seedHome(daemonDir, "claudex", sysDir)` + `"claudemix"`; `spawn(false)`; probe until healthy → on healthy set state + `setRuntimeState` for both entries per seeded-provider availability; persist. Idempotent + async as in Phase 1.

- [ ] **Step 1: Write the failing tests:**

```ts
test("enable installs, projects config+token+env, seeds both homes, spawns, enables launchers", async () => {
  const seen = { installed: 0, homes: new Set<string>() };
  const mgr = makeManager({
    install: async () => { seen.installed++; await dropDummyBinary(daemonDir); return { version: "v7.2.95" }; },
    systemClaudeDir: () => sysDir,
    tmux: fakeTmux, probe: async () => ({ ok: true, reachable: true, models: ["gpt-5.6-sol"] }),
    /* seedHomes observed via fs after enable */
  });
  await mgr.enable();
  assert.equal(seen.installed, 1);
  assert.ok(existsSync(join(daemonDir, "cliproxy", "config.yaml")));
  assert.ok(existsSync(join(daemonDir, "cliproxy", "token")));
  assert.ok(existsSync(join(daemonDir, "cliproxy", "claude-home-claudex", ".orq-cliproxy-home")));
  assert.equal(mgr.status().state, "healthy");
  assert.equal(fakeRegistry.enabledCalls.get("claudex"), true);
});

test("corrupt secrets.json → enable latches error, installs nothing, writes no config", async () => {
  await writeFile(secretsPath, "{ not json");
  const mgr = makeManager({ install: async () => { throw new Error("should not install"); } });
  await mgr.enable();
  assert.equal(mgr.status().state, "error");
  assert.ok(mgr.status().reasons.some(r => /corrupt|secret/i.test(r)));
  assert.ok(!existsSync(join(daemonDir, "cliproxy", "config.yaml")));
});
```

- [ ] **Step 2: Run to verify failure** → FAIL.
- [ ] **Step 3: Implement** the orchestration in `enable()`, threading the two new adapters.
- [ ] **Step 4: Run `cliproxy-manager.test.ts` + `pnpm check`** → clean.
- [ ] **Step 5: Commit** — `git commit -m "feat(daemon): cliproxy enable() installs, projects, seeds homes, spawns, enables launchers"`

---

### Task 5: Provider status + seed coupling in the manager

**Files:**
- Modify: `apps/daemon/src/cliproxy.ts` (`status()` populates `providers`/`accounts`; a `seedProvider` entry point; registry coupling on missing creds)
- Modify: `packages/api/src/index.ts` (`CliProxySeedRequest`)
- Modify: `apps/daemon/src/cliproxy-manager.test.ts`

**Interfaces:**
- Consumes: Task 2 converters, Task 4 enable.
- Produces:
  - `async seedProvider(req: { provider: "codex"|"claude"; accountId: string }, read: (provider, accountId) => Promise<unknown>): Promise<CliProxyProviderStatus>` — reads the managed credential (injected reader), converts (Task 2), **checks `accessTokenFreshMs` > a threshold (e.g. 5 min) — else returns `{state:"expired"}` with a "token stale; refresh in Orquester first" reason** (avoids the dual-refresher rotation), writes the auth file 0600 into `auth/`, records the `(provider, accountId)` proxy-owned mapping (caller marks the account via Task 3), re-probes, updates provider status. Hot-discovered by the proxy (no restart).
  - `status()`: `providers[]` from a per-credential probe of the auth-dir contents mapped to `codex|claude|openrouter`; `accounts[]` from the seeded mapping (`{id, provider, label, email?}`). Registry coupling: a provider going `missing`/`expired` disables the dependent entry with `disabledReason` (`claudex` needs codex OR openrouter; `claudemix` needs claude).
  - `interface CliProxySeedRequest { provider: "codex" | "claude"; accountId: string }` in `packages/api`.

- [ ] **Step 1: Write the failing tests:** seed writes an auth file + marks provider ok; a stale token is refused with `expired`; status reflects per-provider state; `claudemix` disabled when claude provider absent. (Fake the credential reader with Task-2-shaped fixtures.)
- [ ] **Step 2: Run to verify failure** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run tests + `pnpm check`** → clean.
- [ ] **Step 5: Commit** — `git commit -m "feat(daemon): cliproxy provider status probing + credential seeding with freshness guard"`

---

### Task 6: persistence-lost re-parent fix

**Files:**
- Modify: `apps/daemon/src/cliproxy.ts` (`checkHealth`/`becomeHealthy`/`handleSessionSetChanged` interaction)
- Modify: `apps/daemon/src/cliproxy-manager.test.ts`

**Interfaces:**
- Fixes the Phase-1 final-review note: a `persistence-lost` (out-of-tmux, `external:true`) proxy must NOT be silently relabeled `healthy` with `external` cleared while it's still outside tmux. Correct behavior: while `external` and tmux is available, `checkHealth` keeps the status reason `persistence-lost` (probe-healthy but durability-degraded) and, when `liveDependentSessionCount() === 0`, performs the re-parent (kill the external proxy, `spawn` under tmux, clear `external` only after a tmux-hosted spawn succeeds). `handleSessionSetChanged` triggers the same evaluation on session drain. Guard the re-parent so it only runs when tmux is actually available (no-tmux mode legitimately stays `external`).

- [ ] **Step 1: Write the failing test:**

```ts
test("persistence-lost proxy is re-parented under tmux once sessions drain, not just relabeled", async () => {
  // boot-adopt an out-of-tmux own proxy (probe ok, no tmux session) → external + persistence-lost
  const mgr = await makeManagerAdoptingExternal();
  assert.ok(mgr.status().reasons.includes("persistence-lost"));
  // with a live dependent session, a health tick must NOT clear external
  fakeSessions.count = 1; await mgr.checkHealth();
  assert.ok(mgr.status().reasons.includes("persistence-lost"));
  // sessions drain → re-parent happens: external cleared AFTER a tmux spawn
  fakeSessions.count = 0; mgr.handleSessionSetChanged(); await settle();
  assert.equal(fakeTmux.newServiceSessionCalls, 1);
  assert.ok(!mgr.status().reasons.includes("persistence-lost"));
});
```

- [ ] **Step 2: Run to verify failure** → FAIL (current code relabels healthy without re-parenting).
- [ ] **Step 3: Implement** the corrected interaction.
- [ ] **Step 4: Run tests + `pnpm check`** → clean.
- [ ] **Step 5: Commit** — `git commit -m "fix(daemon): re-parent a persistence-lost cliproxy under tmux on drain instead of relabeling healthy"`

---

### Task 7: Real adapters + `/api/cliproxy` seed/openrouter routes + wiring

**Files:**
- Modify: `apps/daemon/src/index.ts`
- Modify: `apps/daemon/src/cliproxy-manager.test.ts` or a small route test (Fastify `inject`, both transports)

**Interfaces:**
- Consumes: Tasks 1–6.
- Produces (in `startDaemon`/`createServer`):
  - Real `install` adapter: `() => installBinary(resolved.daemonDir, { fetchTarball: defaultFetchTarball })`.
  - Real `spawnDirect(bin, args)`: `child_process.spawn(bin, args, { cwd: cliproxyDir, detached:false, stdio:"ignore" })` returning `{ kill }` (Phase-1 stub was `() => null`; now the no-tmux fallback actually runs).
  - Real `systemClaudeDir()`.
  - Routes (mutations HTTP-only via the Phase-1 `refusedOnSocket` guard; replace the Phase-1 501 stubs where they now have implementations):
    - `POST /api/cliproxy/accounts/seed` — body `CliProxySeedRequest`; reads the managed credential via `agentAccounts`, calls `cliproxy.seedProvider(...)`, then `agentAccounts.markProxyOwned(accountId, true)` (owner rule). Returns provider status.
    - `POST /api/cliproxy/openrouter/key` — validates, stores via Phase-1 `setOpenRouterKey`, re-projects config, restart-gated (force-confirm) since the OpenRouter key is a `config.yaml` projection.
  - `seedHome` is now invoked from `enable()` (Task 4), so the `cliproxyContributor` `CLAUDE_CONFIG_DIR` points at a genuinely-seeded home — no separate wiring needed here, but add an assertion in Task 9.
  - **Per-launch account routing (spec §2):** extend `cliproxyContributor(entryId, ctx, daemonDir)` (Phase-1) so that when `ctx.accountId` is a real account (not `System`/undefined), it prefixes the effective model with that account's prefix — `ANTHROPIC_MODEL`/`CLAUDE_CODE_SUBAGENT_MODEL` = `` `${accountPrefix(ctx.accountId)}/${effectiveModel}` `` (import `accountPrefix` from Task 2). For `claudex` a Kimi pick ignores the account (OpenRouter is keyless — no prefix); for `claudemix` the account prefixes the default Claude main-loop model. `ctx.accountId` already flows to the contributor (Phase-1 launch context) and is already persisted on the session record for stock agents, so reattach re-pins the same account with no new persistence work. Add a unit test: contributor with `{accountId:"14137047-…", model:"gpt-5.6-sol"}` on `claudex` → env `ANTHROPIC_MODEL=acc14137047/gpt-5.6-sol`; with `accountId` undefined → unprefixed.

- [ ] **Step 1: Write the failing tests:** seed route on remote transport calls `seedProvider` + `markProxyOwned` and returns status; seed route on the Unix socket → 403; openrouter/key route stores + re-projects and is restart-gated.
- [ ] **Step 2: Run to verify failure** → FAIL.
- [ ] **Step 3: Implement** adapters + routes.
- [ ] **Step 4: Run the FULL daemon suite + `pnpm check`** → clean (this task changes shared wiring).
- [ ] **Step 5: Commit** — `git commit -m "feat(daemon): real cliproxy install/spawn adapters + seed and openrouter-key routes"`

---

### Task 8: Close-out review (daemon)

- [ ] **Step 1:** Full battery: `pnpm check` clean; `cd apps/daemon && node --import tsx --test $(find src -name '*.test.ts')` all pass.
- [ ] **Step 2:** Diff-audit vs the spike-updated spec §1/§3/§4: stock-binary install + sha256 (Task 1), seed-by-conversion (Tasks 2/5/7), owner rule (Task 3), enable orchestration + seedHome wiring (Task 4), provider status (Task 5), persistence-lost re-parent (Task 6). Every one has a named passing test.
- [ ] **Step 3:** `superpowers:requesting-code-review`; fix findings (fold blocking fixes in, commit).
- [ ] **Step 4: Commit** review fixes.

---

### Task 9: Live on-VPS verification (manual — throwaway appdir + spare port, NOT the live daemon)

**Files:**
- Create: `docs/superpowers/spikes/2026-07-23-claudex-phase2-live.md` (log)

This exercises the **real daemon modules** end-to-end against a real proxy, without touching the live daemon: a tiny `tsx` script calls `installBinary` → `writeProjections` → `codexStorageFromAuthJson`/`claudeStorageFromCredentials` → writes auth files → spawns the installed binary on a **spare port (18317)** with a throwaway `--config` under `~/claudex-p2/` → probes `/v1/models` → runs `claude -p` on `gpt-5.6-sol` and `kimi-k3`. Mirrors the Task-0 spike but through Phase-2 code, proving the modules compose. Seed only while access tokens are fresh (reuse the spike's freshness check); scrub the dir (live tokens) after.

- [ ] **Step 1:** Write and run the `tsx` harness script (spare port, throwaway appdir); capture `/v1/models` + the two functional replies.
- [ ] **Step 1b (prefix routing — the per-account feature):** seed **both** Claude accounts (`7f46e0…` and `14137047…`) via `claudeStorageFromCredentials`, each with its `accountPrefix`. Then confirm `<prefixA>/claude-…` and `<prefixB>/claude-…` route to the *distinct* accounts — e.g. hit the proxy with each prefixed model and assert the two responses come from different accounts (distinguish via the account email in a probe, or a per-account rate-limit header). This is the live proof of spec §2's per-launch account selection. (Seed only while both access tokens are fresh; the 2nd Claude account was fresh in the sub-spike.)
- [ ] **Step 2:** Verify the seeded auth files were produced by `cliproxy-seed.ts` (not hand-rolled) **and carry the `prefix` field**, config by `renderConfigYaml`, binary by `installBinary` (sha256 match logged).
- [ ] **Step 3:** Kill the spare proxy; **scrub `~/claudex-p2/`** (holds live tokens). Confirm no managed-account auth file was rewritten (no refresh/rotation).
- [ ] **Step 4:** Record results in the log doc; commit the log. (Do **not** run the 30-min cost measurement — deferred pending explicit go-ahead.)

---

## Self-Review (performed at write time)

- **Spec coverage (Phase-2 scope):** §1 stock-binary install + rollback → Task 1; §4 seed-by-conversion + owner rule + **per-account prefix** → Tasks 2/3/5/7; §2 per-launch **account routing** (prefix stamping + contributor mapping — daemon half) → Tasks 2/5/7; §1 enable orchestration + seedHome wiring (Phase-1 carryover) → Task 4; §3 seed/openrouter routes + socket refusal → Task 7; §1 persistence-lost re-parent (Phase-1 review note) → Task 6; provider status/§3 → Task 5; live prefix-routing proof → Task 9. Continued in Parts 2–3 (both planned now, not deferred): the account/model **chip UI** (daemon half done here), wire-client, launcher rendering, usage attribution, claudemix workflow + §8 routing, deploy. Only the 30-min cost measurement stays gated on explicit go-ahead (spends quota); device-auth `login/*` is a cut optional add-on (managed-account seeding covers the use case).
- **Placeholder scan:** none — the only injected fakes are test doubles; production adapters are named (`defaultFetchTarball`, real `spawnDirect`).
- **Type consistency:** `CliProxyProviderStatus`/`CliProxyStatus` (Phase-1 `@orquester/api`) is what Task 5 populates and Task 7 serves; `installBinary(daemonDir, deps, expectedSha?)` identical in Tasks 1/4/7; `CliProxySeedRequest` single-sourced (Task 5) and consumed (Task 7); converter return `{file, storage}` identical in Tasks 2/5.
- **Decomposition note:** UI + claudemix + deploy are intentionally separate plans — each Phase here produces daemon-testable software, and Phase 2 ends at "a real proxy the daemon can enable, seed, and serve," verified by Task 9.
