# 04 · Remote access, multi-machine and connectivity: T3 Code vs Orquester

Date: 2026-10-22. T3 Code at `ed9b7ca9` (compared against `e8d87689`). Orquester at `dcab9eed`.
T3 paths are relative to `t3code_codebase/`; Orquester paths are relative to the repo root.
"(new)" marks work that landed in the 652 commits since `e8d87689`; I checked file ages with
`git cat-file -e e8d87689:<path>` and the commit log.

## Executive summary

The two products have different shapes. **T3** treats every machine as an *environment* with its
own identity. One client connects to many environments at once, each over several routes
(LAN, Tailscale, SSH-forwarded, T3 Connect relay tunnel), with per-device scoped sessions.
**Orquester** has one daemon per client at a time (a server switcher). It authenticates with a
single shared username/password credential and reaches extra compute by **renting boxes**
(21 providers, Tailscale or public URL, reverse-dialing `orq-agent`).

What Orquester lacks most in this domain:

1. **Device pairing and revocable per-device sessions.** Today the bearer is a static,
   password-equivalent value with no expiry and no per-device revocation.
2. **Built-in HTTPS reachability without Caddy.** T3 has Tailscale Serve and the T3 Connect relay.
3. **Actionable connection diagnosis.**
4. **Using a machine you already own** (an SSH host or a home Mac) as an execution target.

What Orquester does better: rented-VM provisioning, `orq-agent` auto-update, honoring a project's
devcontainer, the Secret-files vault, tmux-survivable sessions, and a login throttle.

Terminology note: `apps/daemon/src/device-link.ts` is **not** device pairing. It drives agent
*account* device-code logins (Grok/Codex, RFC 8628) (`device-link.ts:55-63`).
`apps/daemon/src/known-hosts.ts` pins Bitbucket SSH host keys for git (`known-hosts.ts:4-30`), and
`accounts-remote` is git `ls-remote`. None of the three is a client-connectivity feature.

---

## 1. They have, we don't

| Feature | T3 evidence (paths) | Orquester status (with evidence) | User value | Port effort |
|---|---|---|---|---|
| **Device pairing: one-time pairing links and QR codes, per-device sessions, revoke a device** | `apps/server/src/auth/PairingGrantStore.ts`, `SessionStore.ts` (`expiresAt`/`revokedAt` :107-131), `auth/http.ts`; `apps/server/src/cli/pair.ts:183,488` (terminal QR); `apps/web/src/components/settings/AuthorizedClientsSettings.tsx` (revoke UI); `apps/web/src/hostedPairing.ts` + `pairingUrl.ts` (secret kept in the URL fragment); docs `docs/internals/environment-auth.md` | **Missing.** One username/password per daemon. The bearer is `base64(user:bcrypt(password))` (`packages/ui/src/lib/auth.ts:26-35`), checked against the stored `passwordHash` (`apps/daemon/src/index.ts:5800-5812`). The bearer equals the stored hash, so it never expires and works from any device. The only way to revoke it is to change the password (`deploy.sh rotate-password`), which logs every device out. Clients cache it in `localStorage` (`auth.ts:73-88`). No pairing link, no QR, no device list. | H | M |
| **Scoped permissions per client** (`orchestration:read`, `terminal:operate`, `filesystem:write`, `access:write`, …) enforced per RPC | `packages/contracts/src/auth.ts:30-47`; `apps/server/src/auth/RpcAuthorization.ts`; `apps/web/src/components/settings/SessionPermissions.tsx` | **Missing.** Every authenticated request has full rights (`index.ts:1996-2035`). The only asymmetry is between transports: config writes are socket-only (`index.ts:2075-2081`). | M | M |
| **External MCP clients get OAuth with a read-only or capped grant** | `apps/server/src/auth/McpOAuth.ts`, `apps/server/src/mcp/McpToolAccess.ts`, `threadAccess.ts` | **Missing.** External `/mcp` clients get the same full-trust bearer, which the user derives by hand with a script (`docs/orquester-mcp.md:67-90`). In-chat tools do have tiers and approval cards, but external clients get none of that. | M | M |
| **T3 Connect relay**: reach a machine behind NAT with no port forwarding, through a Cloudflare tunnel per environment, DPoP-bound bootstrap, sign-in on both ends | `apps/server/src/cloud/CloudLink.ts` (1685 lines); `infra/relay/src/environments/{EnvironmentConnector,ManagedEndpointProvider,ManagedEndpointReaper}.ts`; `packages/shared/src/relayClient.ts` (pinned cloudflared); `apps/server/src/auth/dpop.ts`; docs `docs/internals/t3-connect.md` | **Missing for clients.** Remote access requires a public HTTPS daemon behind Caddy (`deploy/Caddyfile`, README "Deploy") or a URL the user brings. Boxes can use Tailscale, but only for box→daemon traffic (`apps/daemon/src/boxes/service/settings.ts:139-153, 502-528`). | H | L (needs a hosted relay, Cloudflare account, identity provider) |
| **`t3 connect` reachability check with actionable errors**: classifies not linked / connector down / port 7844 blocked / Tailscale exit node / origin 502 / DNS / timeout, each with a fix line, rechecked every 5 min (new) | `apps/server/src/cloud/ConnectReachability.ts:57-160` (new); `apps/server/src/cli/connect.ts:333-375`; `packages/tailscale/src/tailscale.ts:309-338` (exit-node read) | **Partial.** Boxes → Connection has a single "Test connection" probe. It GETs `/api/boxes/agent/linux-x64`, expects a 401, and reports either "Reachable" or the raw error line (`boxes/service/settings.ts:585-611`). It has no cause classification or fix steps, and nothing like it exists for client access. | M | S–M (the Tailscale-mode checks are portable; the cloudflared checks are not needed) |
| **Hop-by-hop connection diagnosis in the client** ("this device → relay → tunnel → host"), with headline, steps, facts, troubleshooting link and **Copy diagnostics** (new) | `packages/client-runtime/src/connection/diagnosis.ts` (new, `locate`/`headline`/`steps` :57-212, `connectionDiagnosisText` :339); `packages/client-runtime/src/connection/errors.ts`; `apps/web/src/components/settings/ConnectionDiagnosisDetails.tsx` (new); `docs/user/t3-connect-troubleshooting.md` (new) | **Missing.** The disconnect toast shows `connectionError ?? "Disconnected"` with a Retry button (`packages/ui/src/components/status/ConnectionStatusToast.tsx:13-55`). The store only sets specific text for 401 ("Incorrect username or password.") and 429 (`packages/ui/src/store/app.ts:1478-1500`). Network failures carry no cause. | M | S–M |
| **Several routes per machine with ordered failover**: LAN, tailnet, SSH, relay. Each route is checked against the public descriptor (environment ID) before any credential is sent, earlier routes are re-preflighted every 60 s, and a flaky route gets a 5-min cooldown | `packages/client-runtime/src/connection/{routes.ts,driver.ts:120-175,supervisor.ts:51-54,603,764}`; `apps/web/src/components/settings/EnvironmentRoutesList.tsx` | **Missing.** A remote is one `baseUrl` (`packages/config/src/index.ts:717-723`). The client sends its bearer to whatever answers that URL. `/api/auth/info` returns no daemon ID that would let the client check identity first (`index.ts:2048-2057`). | M | M |
| **Learned routes**: a connected server reports its LAN and tailnet addresses, and the client adds them as routes that follow address changes | `packages/client-runtime/src/connection/routes.ts:189-300` (`mergeLearnedRoutes`) | **Missing.** | M | M |
| **Connected to many machines at once**: one sidebar across environments, per-environment connection registry, threads keep running on each | `packages/client-runtime/src/connection/registry.ts`; `docs/internals/connection-runtime.md` | **Missing.** One active daemon at a time: `selectConnection` swaps `api` (`store/app.ts:1918`), and `ServerSwitcher.tsx:55-170` is a single-select menu. Rented boxes are the multi-machine story instead. | M | L |
| **Load balancing new threads across machines** (Prefer / Normal / Less often / Manual only, based on CPU and memory) | `apps/web/src/hooks/useLoadBalancedEnvironment.ts`, `apps/web/src/components/settings/LoadBalancingSettings.tsx` | **Missing.** Not applicable while the client holds one daemon at a time. Box placement chooses provider, size and price, not load (`boxes/service/placement.ts:1-5`). | L | L |
| **"Run on" → add a project to another machine**, cloning there (rewrites the SSH↔HTTPS URL for the target's credentials) and copying `.env`/`.envrc`/`.dev.vars` (≤1 MiB) through the client (new) | `apps/web/src/components/AddProjectToMachineDialog.tsx` (new); `apps/web/src/lib/addProjectToMachine.ts:24,49-66,140-193` (new); `apps/server/src/workspace/WorkspaceEntries.ts:114` | **Partial.** The repo group's **New clone of …** dialog has a **Runs on** row (`packages/ui/src/components/sidebar/RepoGroupSection.tsx:211`, `NewProjectModal.tsx:252,828`, `components/boxes/location/RunsOnRow.tsx`). It can clone onto a *new rented box*, and the Secret-files vault syncs `.env`-style files into every clone (`docs/superpowers/specs/2026-10-19-secret-files-plugin-design.md:1,30-33`). It cannot target a machine you already own or another Orquester daemon. Moving a project is an explicit non-goal (`docs/superpowers/specs/2026-10-19-ephemeral-ai-vms-design.md`, §2 non-goals). | M | S once a bring-your-own-machine box exists (see §3 #2) |
| **Desktop-managed SSH environment**: pick a host from `~/.ssh/config`, auto-install the server on the remote into `~/.t3/runtime`, start or reuse it, forward the port, askpass for password or 2FA codes, and stop only servers it launched | `packages/ssh/src/tunnel.ts:804-935` (`buildRemoteT3RunnerScript`, `launchOrReuseRemoteServer`, `issueRemotePairingToken`); `packages/ssh/src/config.ts:288` (`discoverSshHosts`); `packages/ssh/src/auth.ts` (askpass); `apps/desktop/src/ssh/DesktopSshEnvironment.ts`. Recent fixes: interrupted SSH pairing reuses setup (`eca0e055`, new), "password or verification code" prompt (`cc93dc10`, new) | **Missing.** `deploy.sh provision` installs over SSH from an operator shell (`deploy.sh:2-26`), not from the app. Box rules say "A box is reached only through `BoxConnection`. No SSH." (`apps/daemon/src/boxes/README.md`), and there is no provider for an existing machine (`packages/api/src/boxes.ts:68`). | H | M (reuse `orq-agent`; see §3 #2) |
| **Tailscale Serve HTTPS in one click or flag** (`t3 serve --tailscale-serve`, `t3 pair --tailscale`), tailnet detection, stderr diagnostics that never echo auth keys | `packages/tailscale/src/tailscale.ts:42-60` (diagnostics), `:287` status, `:430-451` `ensure/disableTailscaleServe`, `:453` probe; `0d876e00` "timed-out tailscale probe no longer outlives its call" (new) | **Missing for clients.** Tailscale is used only for boxes (API keys, tags, ephemeral auth keys: `apps/daemon/src/boxes/tailscale/keys.ts:1-15`). The Remote access setting is bare host and port over plain HTTP (`packages/ui/src/components/settings/ServerSettings.tsx:218-300`), so a phone on the LAN sends the password-equivalent bearer unencrypted and cannot install the PWA (the PWA needs a secure context). | H | S |
| **Server updates pushed from the client, with trial, commit and automatic rollback** (DB snapshot, launcher protocol, update ID correlated after reconnect, refuses when the disk is too full) | `apps/server/src/serviceLauncher.ts` (873 lines); `packages/contracts/src/rpc.ts:477-478` (`server.updateServer[WithProgress]`); `packages/client-runtime/src/connection/outdatedHostUpdate.ts`; `docs/internals/server-updates.md`. New: `a3635a14` (no 10-min download cap), `29a7d804` (service env preserved), `c6fd4ad1` (mobile update check without GitHub API limits) | **Partial.** `./deploy.sh deploy`/`verify`/`rollback <sha>` with a health wait and a browser smoke test (`deploy.sh:25-26,111-123,154`). It is operator-driven over SSH, and rollback is manual. The app has no daemon update action. | M | L |
| **Restart continuation**: an update or crash resumes interrupted agent runs | `apps/server/src/orchestration-v2/{ProviderRuntimeRecoveryService,RestartContinuation}.ts` | **Different by design.** tmux keeps agent processes alive across daemon restarts (README "tmux-backed persistence"; `KillMode=process`), so far less is lost in the first place. Direct-PTY hosts (Windows, stock macOS) have no equivalent. | L | M |
| **Host-freeze notice**: the server reports event-loop stalls, and the client says "X froze for 12s, CPU overloaded (load 9 on 4 cores)" instead of blaming the network (new) | `apps/server/src/observability/EventLoopMonitor.ts`; `packages/client-runtime/src/connection/hostFreeze.ts` (new); `d7bc3a2f`, `45ad8d9f` (new) | **Missing.** `SystemStatusChip` shows live CPU and memory, but nothing measures event-loop stalls, and the reconnect toast cannot tell "host froze" from "network dropped". | M | S |
| **Remote-only desktop** (turn off the local environment) | `apps/web/src/components/settings/LocalEnvironmentSetting.tsx`; `apps/desktop/src/settings/DesktopAppSettings.ts` | **Missing.** The desktop always starts or attaches to a local daemon (`apps/desktop/src/main.ts:778-787`). | L | S |
| **Simulator and emulator Device panel served by the environment** (works over remote routes), including **EAS Simulator hosts** (billed cloud iOS simulators with session, run and idle limits; orphan sessions stopped on restart; tokens added server-side) (new) | `apps/server/src/device/EasDeviceHost.ts` (new, :111, :476-477), `ExpoApi.ts` (new), `SshDeviceHost.ts`, `DeviceHubProxy.ts`; commits `aee25acd`, `99209c7f`, `c273a8f6`, `d18352e3`, `6dc63bd8` (new) | **Missing.** No simctl, adb or simulator code anywhere in the daemon. The closest pieces are Blacksmith macOS boxes (no screen streaming) and Linux virtual desktops (`apps/daemon/src/desktops/`). | M (H for mobile developers) | L |
| **Relay forwards inbound webhooks** to the environment, with an opt-in hold-while-offline inbox | `infra/relay/src/hooks/{HookForwarder,HookInboxObject}.ts`; `docs/internals/t3-connect.md` intro | **Missing.** Workflows have no inbound-webhook trigger; the Git trigger is "Polled, never a webhook" (`packages/api/src/workflows/block-types.ts:72`). This overlaps with the workflows analyst's area. | L | L |
| **Contributor devcontainer** | `.devcontainer/devcontainer.json`, `docs/internals/devcontainer.md` | **Missing** for Orquester's own repo. This is a contributor convenience, not a product feature. | L | S |

## 2. They do it better

1. **Credential model.** T3 sessions expire, can be revoked, are scoped, and can be bound to a
   key with DPoP (`apps/server/src/auth/{SessionStore,dpop,http}.ts`). WebSocket upgrades use
   short-lived tickets, so long-lived tokens stay out of URLs (`docs/internals/environment-auth.md`).

   Orquester's wire bearer is exactly the stored `passwordHash` (`index.ts:2019-2026,
   5800-5812`). It is also the WebSocket `?token=` and the `/api/fs/download?token=`
   (`index.ts:2016-2023`). Concretely:
   - A copy of `daemon.json` is a working login. A normal password hash is not.
   - A phone's `localStorage` holds a permanent credential.
   - The same secret goes into every external MCP client config (`docs/orquester-mcp.md:67-90`).

   The redaction and login throttle (`index.ts:1952-1958, 2003-2032`) reduce exposure but do not
   change these properties.

2. **Reconnect policy.** T3 has **one retry owner per environment**
   (`packages/client-runtime/src/connection/supervisor.ts`):
   - Jittered exponential backoff, 1 s base up to a **5-minute cap** (`:41-42,127-129`). The
     backoff resets only after 30 s of stable connection (`:50, 816-824`).
   - Offline and auth failures wait for a wakeup instead of using up retries.
   - A long mobile suspension replaces the session immediately.

   Orquester spreads retries over several independent loops with different policies:
   - Store loop: **linear, no jitter**, `min(attempt*1000, 8000)`, retrying forever
     (`packages/ui/src/store/app.ts:416-418, 1665-1715`).
   - Terminal channel: linear `min(attempts*500, 5000)`, no jitter
     (`packages/ui/src/lib/transporters/ws-session-channel.ts:192-202`).
   - Chat streams: full jitter, capped at 15 s (`packages/ui/src/lib/agent-chat/stream.logic.ts:143-152`).
   - Also the browser channel and the VNC and audio sockets.

   After a daemon restart, every client and every channel redials in lockstep about every 5–8 s.
   Orquester's wake handling is good: a ping probe for half-dead mobile sockets
   (`ws-session-channel.ts:68-92`) and wake-coalescing (`store/app.ts:1723-1770`). The weak
   points are backoff shape and having one owner.

3. **Failure explanation.** Every T3 failure carries a `hop` and a `failureCause`
   (`packages/client-runtime/src/connection/errors.ts`, `model.ts`). The UI turns that into
   "Mac mini's tunnel is offline" plus steps and a docs anchor (`diagnosis.ts:83-212`).
   Orquester shows "Disconnected" and a Retry button (`ConnectionStatusToast.tsx:41-52`).

4. **Reachability as a first-class status.** T3 checks reachability from the host when
   `t3 connect` finishes, rechecks every 5 minutes, debounces readiness flaps
   (`ConnectReachability.ts:26-33`), and names a Tailscale exit node as the likely culprit
   (`:50-55, 98-109`). Orquester's box connection test is one HTTP status check with the raw error
   text (`boxes/service/settings.ts:585-611`).

5. **Tailscale CLI hygiene.** T3's `packages/tailscale` bounds every CLI call (status 3.5 s,
   serve 10 s), kills the process group after a grace period, and maps stderr to
   `not-logged-in` / `permission-denied` / `no-existing-handler` without echoing stderr, which
   can contain `tskey-` keys (`tailscale.ts:10-60`). Orquester calls only the Tailscale *API* for
   boxes, which is fine there. A client-side Tailscale Serve feature should copy these rules.

6. **Hosted pairing never leaks the secret to the wrong origin.** The pairing secret travels in
   the URL fragment and is stripped from history (`docs/internals/remote.md` "Hosted web is a
   client"; `apps/web/src/hostedPairing.ts:3-7`). Orquester has no pairing link, so this matters
   only once one exists, but it should be built this way from the start.

## 3. Worth copying (ranked by value/effort)

1. **Tailscale Serve HTTPS toggle for Remote access** (H value, S effort).
   - **Daemon:** add a small `apps/daemon/src/tailscale-serve.ts` with `status` (tailnet name,
     MagicDNS host), `ensureServe(localPort)`, `disableServe()` and `probe()`.
   - **Hook-up:** call it when the HTTP transport restarts (`apps/daemon/src/index.ts:1657-1690`).
     Persist the toggle in `daemon.json` through the existing socket-only
     `PUT /api/config/daemon` (`index.ts:2075`), with the schema in `packages/config`.
   - **UI:** add a "Tailscale HTTPS" switch and show the resulting `https://<host>.<tailnet>.ts.net`
     URL in `packages/ui/src/components/settings/ServerSettings.tsx:218-300`.
   - **Crib:** `packages/tailscale/src/tailscale.ts` (`ensureTailscaleServe` :430,
     `disableTailscaleServe` :441, `readTailscaleStatus` :287, `probeTailscaleHttpsEndpoint` :453,
     stderr classification :42-60, timeouts :10-27). Port it to plain `execFile` (no Effect).
   - **Payoff:** HTTPS for the PWA and phone access without Caddy, and the bearer stops travelling
     in cleartext on the LAN.
   - **Caveat:** `trustProxy` is `"127.0.0.1"` only for the remote app (`index.ts:1943`). Tailscale
     Serve also proxies from loopback, so the per-IP throttle needs the `X-Forwarded-For` it sets.
     Verify that.

2. **"Your own machine" box provider** (bring-your-own Mac, Linux or Windows host) (H value, S–M effort).
   - **Why it is cheap here:** the hard parts already exist. The POSIX and PowerShell bootstraps
     fetch and start `orq-agent`, which dials the daemon over Tailscale or the public URL
     (`apps/daemon/src/boxes/bootstrap/bootstrap.ts:14,56-153`; hub auth in
     `apps/daemon/src/boxes/hub/`).
   - **Adapter:** add a `BoxProviderAdapter` in `apps/daemon/src/boxes/providers/byo.ts`. Its
     `create` mints a bootstrap token and returns a one-line install command for the user to
     paste, instead of calling a cloud API. `destroy` stops the agent and wipes its data dir,
     never the machine.
   - **Contract:** add the id to `BOX_PROVIDER_IDS` (`packages/api/src/boxes.ts:68`).
   - **Later, optional SSH-driven install:** crib `packages/ssh/src/tunnel.ts:804-935`
     (launch-or-reuse script, managed-vs-external server ownership), `config.ts:288`
     (`discoverSshHosts`) and `auth.ts` (askpass). That would relax the boxes README's "No SSH"
     rule, so it needs an owner decision.
   - **What it unlocks:** with this provider, **New clone of … → Runs on** covers T3's new "add
     project to another machine", including `.env` files through the Secret-files vault.

3. **Device pairing and revocable sessions** (H value, M effort).
   - **Config:** add an `auth-sessions.json` schema and path helper in `packages/config`
     (tolerant parse) with records `{id, label, createdAt, lastSeenAt, expiresAt?, revokedAt?,
     tokenHash}`.
   - **Daemon:** add `apps/daemon/src/auth-sessions.ts`, and extend the `onRequest` hook
     (`index.ts:1964-2035`) to accept either the legacy password credential or an opaque session
     token. Compare SHA-256 hashes; never store the raw token.
   - **Routes:** `POST /api/auth/pairing` (one-time code, short TTL), `POST /api/auth/redeem`
     (public, throttled), `GET/DELETE /api/auth/sessions`. Contracts go in `packages/api`.
   - **UI:** a "Devices" list with Revoke, a pairing QR, and an `AuthModal` path that accepts
     `#pair=<code>`.
   - **Crib:** `apps/server/src/auth/{PairingGrantStore,SessionStore,http}.ts` (issue, exchange,
     revoke, replace-in-one-transaction), `apps/server/src/cli/pair.ts` (terminal QR),
     `apps/web/src/{hostedPairing,pairingUrl}.ts` (fragment-only secret, history strip),
     `apps/web/src/components/settings/AuthorizedClientsSettings.tsx`.
   - **Also:** give WebSocket and download a short-lived ticket instead of the long-lived bearer
     in `?token=`.
   - **Scope:** keep v1 to one permission level, with scopes deferred. That alone fixes "a lost
     phone requires a password rotation".

4. **Connection diagnosis plus Copy diagnostics** (M value, S effort).
   - **Store:** in `packages/ui/src/store/app.ts`, record `{ phase, attempt, lastFailure:
     {kind: "dns"|"refused"|"tls"|"timeout"|"http", status?, at}, via: url }` alongside
     `connectionError` (1395-1530, 1665-1715).
   - **Diagnosis logic:** add a pure `connection-diagnosis.logic.ts` that maps the failure to
     *headline + steps*. Examples: "This device is offline". "Server answered 502: the daemon
     behind Caddy is down; run `./deploy.sh verify`". "TLS failed: check the certificate or use
     the Tailscale URL". "Repeated timeouts: host may be asleep".
   - **UI:** add a Details popover to `ConnectionStatusToast.tsx` with a Copy diagnostics button
     (client version, daemon version once known, URL, last failure, attempt count).
   - **Boxes:** reuse the same classifier in `boxes/service/settings.ts:585-611`.
   - **Crib:** `packages/client-runtime/src/connection/diagnosis.ts` (`locate`, `headline`,
     `steps`, `connectionDiagnosisText`) and
     `apps/web/src/components/settings/ConnectionDiagnosisDetails.tsx` for the hop-list UI.

5. **One reconnect policy: jittered exponential, a long cap, reset only after a stable
   connection** (M value, S effort).
   - Replace `backoffMs` (`store/app.ts:416`) and `scheduleReconnect`
     (`ws-session-channel.ts:192-202`, and the same in `ws-browser-channel.ts`) with the existing
     `reconnectDelayMs` (`stream.logic.ts:149`).
   - Raise the cap (for example 60 s for the store loop; keep the wake short-circuit so return-to-tab
     still feels instant), and reset attempts only after N seconds connected.
   - Have channels defer to the store's state rather than dial on their own while the store says
     the daemon is unreachable.
   - **Crib:** `supervisor.ts:41-54,127-129,816-824` and `connection/wakeups.ts`.

6. **Host-freeze reporting** (M value, S effort).
   - **Daemon:** sample `perf_hooks.monitorEventLoopDelay()` in `apps/daemon/src/system-status.ts`.
     Keep the last stall over 2 s with load average and CPU count, and expose it in the system
     status payload (`packages/api`).
   - **UI:** on reconnect, if a stall overlaps the gap, show "Host froze for Ns (load X on Y
     cores)" instead of a network message.
   - **Crib:** `apps/server/src/observability/EventLoopMonitor.ts` and
     `packages/client-runtime/src/connection/hostFreeze.ts`.

7. **Multiple URLs per remote with identity check and failover** (M value, M effort).
   - **Config:** change `remoteConnectionSchema` (`packages/config/src/index.ts:717-723`) to
     `routes: string[]`. Keep accepting the old `baseUrl` when reading.
   - **Daemon:** add a stable, public `daemonId` to `/api/auth/info` (`index.ts:2048`). Today it
     is withheld (`index.ts:2059-2060`); exposing an opaque ID is low-risk. The client then probes
     each route without the bearer, uses the first route whose ID matches, and re-probes earlier
     routes once a minute while connected.
   - **Crib:** `packages/client-runtime/src/connection/{routes,driver}.ts` and the
     `BETTER_ROUTE_*` logic in `supervisor.ts:51-54,603,764`.
   - **Payoff:** home LAN → Tailscale → public Caddy URL without manual switching, and the bearer
     is never sent to a stranger on a reused LAN IP.

8. **Read-only and scoped bearer for external MCP clients** (M value, M effort; build on #3).
   - Add a `scope: "full" | "read"` to a session. In `apps/daemon/src/mcp/server.ts`, filter
     tools to the catalog's existing Read tier for read sessions (the catalog already tags tools
     Read, Act and Admin).
   - **Crib:** `apps/server/src/auth/McpOAuth.ts` (PKCE, loopback redirects, approval page) and
     `apps/server/src/mcp/McpToolAccess.ts`.

Not recommended now: the full **T3 Connect relay** and **load balancing**. The relay needs a
hosted Worker, Cloudflare tunnel billing and reaping, an identity provider and DPoP. #1 plus #7
deliver most of its value for a single owner. Load balancing presupposes a multi-daemon client.

## 4. We do it better / they lack

- **Rented compute on demand.** Orquester provisions Linux, GPU, Windows and macOS (Blacksmith)
  boxes across 21 providers. It covers price tables, a reconciler for boxes destroyed outside the
  app, and per-chat temporary boxes approved by the owner (`apps/daemon/src/boxes/providers/`,
  `service/lifecycle.ts`, `service/reconciler.ts`, `temporary/`). T3 has no VM provisioning; the
  `ServerEnvironmentMachine.ts:55-58` matches are host detection only. T3 expects you to already
  own the machine.
- **Credential hygiene for remote execution.** The token broker sends only short-lived access
  tokens to boxes; refresh tokens and git keys stay on the host (`boxes/broker/`; spec
  anti-goals). T3's SSH or remote environments run provider CLIs with whatever credentials
  that host has.
- **Reverse-dial agent with version handshake.** `orq-agent` dials out, so the box needs no
  inbound port. The hub asks outdated agents to update on connect (`boxes/hub/hub.ts:330-339`)
  and heartbeats the link (`:117-153`). This is our equivalent of "server updates pushed to
  remote machines", and it needs no launcher.
- **Tailscale done safely for boxes.** Ephemeral, pre-authorized, tagged auth keys; node cleanup;
  and a tailnet-policy check that warns when `tag:orq-box` is unrestricted
  (`boxes/tailscale/keys.ts:1-60`, `service/settings.ts:139-153`).
- **Honors the user's project devcontainer** when provisioning a box toolchain
  (`boxes/service/toolchain.ts:1-12,162-165`). T3's devcontainer is only for contributors to
  its own repo.
- **Secret-files vault.** Ongoing per-repo sync of `.env`-style files with names-only compare,
  push and reset across every clone (`apps/daemon/src/secret-files/`). T3's `.env` copy is a
  one-shot client relay of up to 1 MiB per file at clone time (`addProjectToMachine.ts:24,62-66`).
- **Sessions survive daemon restarts and redeploys** through tmux and `KillMode=process`, with no
  continuation prompt needed. T3 has to recover and re-prompt interrupted runs
  (`docs/internals/server-updates.md` "Recovering interrupted threads").
- **Hot-reloadable remote transport.** Toggling remote access, host, port or password restarts
  only the HTTP listener; sessions and the unix socket keep running (`index.ts:1657-1690`). T3's
  desktop "Network access" toggle restarts the app (`docs/user/remote-access.md`).
- **Brute-force protection.** A per-IP login throttle that is proxy-aware and sends Retry-After
  (`index.ts:1962, 2003-2032`), and the client honors lockouts (`store/app.ts:1494-1500`). I found
  no comparable limiter in `apps/server/src/auth/`. T3 relies on high-entropy pairing secrets
  instead.
- **Single-command VPS deploy.** Caddy TLS, ufw, a hardened systemd unit, and a post-deploy
  headless browser smoke test with legacy-localStorage fixtures (`deploy.sh`, `deploy/`).
- **Mobile wake handling.** Ping-probing half-dead sockets on visibility regain
  (`ws-session-channel.ts:59-92`) and coalescing wake events (`store/app.ts:1723-1731`) are on par
  with T3's foreground probe.

## Verification notes

- Everything here was checked read-only against source on both sides. I did not run either
  product, any network probe, or any tests.
- File ages for "(new)" come from `git cat-file -e e8d87689:<path>` and
  `git log e8d87689..HEAD`. Refactor-only moves were traced with `--follow`; for example,
  `AuthorizedClientsSettings.tsx` is a file split, not a new feature.
- I did not confirm the T3 relay's server-side behaviour beyond `infra/relay` source and
  `docs/internals/t3-connect.md`, since the hosted relay is not in the repo's runtime.
