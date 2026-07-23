# Browser Tab DevTools — Design

Date: 2026-07-23
Status: approved (brainstorm complete)

## Goal

Give Orquester's browser tabs (Design Mode) the full Chrome DevTools experience — Console,
Elements, Sources (real breakpoints), Network, Performance, Memory — by embedding the **real
Chrome DevTools frontend** served by the project's own headless Chromium, proxied through the
daemon with auth. No custom panel reimplementation.

## Decisions (approved)

- **Approach:** proxy Chromium's own remote-debugging endpoint and its bundled, version-matched
  DevTools frontend. Not chii/chobitsu, not custom React panels, not the `chrome-devtools-frontend`
  npm package (it ships unbuilt source).
- **Desktop UI:** right-side dock inside the browser tab — browser viewport left, DevTools right,
  width-resizable via the existing `ResizeHandle` pattern — plus a **pop-out** to a real separate
  window (`window.open`), like undocking real Chrome DevTools. Bottom dock is out of scope for v1.
- **Mobile UI:** full-screen swap — the DevTools iframe takes over the whole tab, with a one-tap
  Page ⇄ DevTools switcher in the browser toolbar. No splits on mobile.
- **Availability:** HTTP transport only, same as browser tabs today (the local desktop unix-socket
  transport has no browser channel).

## Background constraints (from codebase exploration)

- One Chromium **process per project**, one puppeteer `Page` + `CDPSession` per tab
  (`apps/daemon/src/browsers.ts`). Launch currently uses `pipe: true` — CDP over stdio, **no
  debugging port**, so today nothing external can attach.
- Since Chrome 63 a page accepts multiple simultaneous CDP sessions; DevTools can attach alongside
  the daemon's screencast/picker session. Known interference is limited to both sides driving the
  same global knobs (emulation, screencast) — accepted as a documented quirk (e.g. DevTools device
  toolbar vs. our viewport toggle).
- Chromium's debug endpoint serves a prebuilt DevTools frontend at `/devtools/inspector.html`,
  always version-matched. Two proxy gotchas: Chrome rejects non-localhost `Host` headers
  (DNS-rebinding protection) and, since Chrome 111, rejects WS upgrades whose `Origin` isn't
  allowlisted (`--remote-allow-origins`).
- Caddy stamps the strict SPA CSP **and `X-Frame-Options: DENY` on every response**; without a
  carve-out the proxied `inspector.html` could not be iframed at all.

## Architecture

### 1. Chromium launch: pipe → loopback debug port (`apps/daemon/src/browsers.ts`)

- Remove `pipe: true` — puppeteer itself then launches Chromium with `--remote-debugging-port=0`
  (kernel-assigned, binds `127.0.0.1` only; verified in puppeteer-core's ChromeLauncher, which adds
  the flag whenever no `--remote-debugging-*` arg is present — do not pass it manually).
- **Do not** add `--remote-allow-origins`: the daemon's proxy sends no `Origin` header, so Chrome's
  CDP origin check passes without an allowlist; `*` would needlessly nullify that defense (a
  hostile page probing loopback *with* an Origin should stay rejected).
- Read the assigned port back from `browser.wsEndpoint()` and store `debugPort` on the per-project
  `Chrome` entry.
- Everything else unchanged: sandbox retry, profile dirs, per-project lifecycle, screencast, picker.
- Target resolution: a tab's DevTools target id is fetched on demand via the tab's existing
  `CDPSession` — `Target.getTargetInfo` (no args) returns the session's own `targetId`. Resolved at
  WS-upgrade time so a relaunched tab (new target) needs no new client URL.
- New service surface: `browsers.devtoolsPort(tabId)` → `number` (never launches) and
  `browsers.devtoolsEndpoint(tabId)` → `{ port, targetId }`; **both throw `BrowserError` 409 unless
  the tab is already `running`** — neither launches Chromium (an unauthenticated asset request and
  an authenticated WS request alike must not spawn a host process; the DevTools toggle is only
  offered on a running tab).

### 2. Daemon proxy — two new routes (**remote/HTTP transport only**, `apps/daemon/src/index.ts`)

Both routes are registered **only when `options.mode === "remote"`**. `createServer` also builds the
unauthenticated unix-socket transport; neither route may exist there (matching how `/mcp` is
remote-gated).

**Frontend assets — `GET /devtools-frontend/:browserId/*`**
- Reverse-proxies `*` to `http://127.0.0.1:<debugPort>/devtools/*` for the Chromium owning that
  tab's project, rewriting `Host` to `127.0.0.1:<debugPort>`.
- `inspector.html` references its assets relatively, so everything stays under the
  `/devtools-frontend/<id>/` prefix.
- Unauthenticated within the remote transport, like the SPA bundle: the assets are generic Chrome
  files behind an unguessable tab UUID. Containment of the *active* frontend (it can read the
  same-origin credential) is done client-side — the iframe is sandboxed to an opaque origin and the
  `@devtools` CSP locks `connect-src`/`form-action` (see §3, §4). Chromium's `/json/*` discovery
  endpoints are **not** exposed (they leak page URLs/titles).
- **Hardening:** the upstream `http.request` carries a connection/idle timeout and is destroyed when
  the client disconnects (`request.raw` close) — an unauthenticated route must never let requests
  pin daemon→Chromium connections open indefinitely.
- The daemon strips/normalizes response headers as needed and must add this prefix to the SPA
  fallback's reserved list so unknown paths under it 404 instead of returning `index.html`.
- The asset route never launches Chromium (unauthenticated → must not allocate host resources). A
  tab whose Chromium isn't up yet gets a 409; the UI keys the iframe off `browser.status` and
  remounts once the tab reaches `running`.

**CDP WebSocket — `GET /ws-devtools/:browserId` (websocket)**
- Sibling of `/ws-browser`: registered outside `/api` (WS can't set headers), authenticated via
  `?token=` with the same `authorizeCredential` check, closes `1008 unauthorized` on failure.
  Token (plain and percent-encoded) stays redacted from logs via `redactUrlTokens`.
- On upgrade: **attach the client `message` listener synchronously first** (fastify-websocket drops
  messages that arrive before a listener exists — DevTools sends its enable batch immediately),
  buffering into a bounded pre-open queue → resolve `{port, targetId}` (409 if not running) → dial
  `ws://127.0.0.1:<port>/devtools/page/<targetId>` with the `ws` client (add as an explicit daemon
  dependency; today it's only transitive via `@fastify/websocket`), `Host` rewritten to loopback,
  no `Origin` sent → pipe frames both ways; either side closing closes the other.
- **Backpressure & limits:** CDP is stateful, so frames are never dropped — each direction applies
  pause/resume on a high-water mark, a single frame is capped by `maxPayload` (32 MiB), and the
  pre-open client queue is bounded by bytes and count (fail-closed on overflow).
- Upstream dial failure or a non-running tab closes the client socket. Note: a failure while the
  tab stays `running` surfaces as the **DevTools frontend's own** disconnected page inside the
  iframe (no custom health signal in v1); the Orquester placeholder covers only the
  `browser.status`-not-running case.

### 3. UI (`packages/ui/src/components/browser/`)

- **State per browser tab:** `devtools: "closed" | "split"` (+ mobile "swap" which reuses the same
  flag). Not persisted across reloads in v1; the split width **is** persisted via a validated
  localStorage helper following the `panel-sizes.ts` pattern (default ~45%, clamped min/max).
- **Toolbar:** a DevTools toggle button (opens/closes the dock; on mobile toggles full-screen
  DevTools) and a pop-out button. Buttons render only when the transport has `browserChannel()`
  (HTTP), matching browser-tab availability.
- **Split (desktop/tablet):** flex row — canvas viewport left, `<iframe>` right, the shared
  `ResizeHandle` divider between them dragging the DevTools pane width.
- **Mobile:** detection is `useIsDesktop()` = the `(min-width: 768px)` media query — a **width
  breakpoint**, not pointer type (a narrow desktop window gets the mobile swap; a wide touch tablet
  gets the split). Below the breakpoint the DevTools toggle swaps the tab content to the
  full-screen iframe; the toolbar keeps a Page ⇄ DevTools switch so flipping is one tap. No divider.
  The frame subscription is **paused** while swapped, so keying/placeholder must read the
  event-driven `browser.status` prop, not the now-frozen subscription `state`.
- **Iframe URL:** `/devtools-frontend/<id>/inspector.html?wss=<host>/ws-devtools/<id>?token=<cred>`
  (`ws=` instead of `wss=` on plain-HTTP dev). The credential accessor follows the existing
  download-URL pattern on `ApiClient`; `redactUrlTokens` keeps the (percent-encoded) token out of
  logs. If the frontend mangles the nested query at deploy-time verification, the fallback is a
  **short-lived opaque ticket** (a single-use ~30 s token minted by an authenticated endpoint),
  **not** a raw-credential path segment (which would evade log redaction).
- **Security containment (the chosen model):** the iframe is `sandbox`ed **without**
  `allow-same-origin` → opaque origin, so the DevTools frontend cannot read the app's `localStorage`
  (which holds the reconstructable bearer). Defense-in-depth for the pop-out (a real same-origin
  window that *can* read `localStorage`): the `@devtools` CSP locks `connect-src`/`form-action` to
  `'self'`, so the credential can't be exfiltrated off-origin either way. Deploy-time verification
  must confirm the frontend still runs under the opaque origin; if not, drop the sandbox and rely on
  the CSP lock, recording which layer is active.
- **Lifecycle:** the iframe is keyed on `browser.status` — when a stopped/crashed tab relaunches,
  the iframe remounts (the DevTools frontend does not auto-reconnect). While the tab is not
  `running`, the pane shows a placeholder instead of the iframe.
- **Pop-out:** `window.open(iframeUrl, "orq-devtools-<id>", "noopener,noreferrer")` and close the
  in-tab split. The page and DevTools ride independent WS connections, so the tab keeps streaming.
  On mobile the pop-out opens as a new browser tab. Known trade-off: the popped-out URL carries
  `?token=` and lands in that device's browser history — same class as existing `?token=` download
  links; acceptable for a single-user tool, short-lived tickets are a possible later hardening.

### 4. Deploy — Caddyfile carve-out (mandatory)

Add a `path /devtools-frontend/*` matcher whose header block:
- drops `X-Frame-Options: DENY` and sets `frame-ancestors 'self'` (otherwise the iframe is
  blocked outright);
- replaces the strict SPA CSP with a DevTools-tuned one that stays **locked on the
  security-critical directives** — `connect-src 'self'` and `form-action 'self'` (containment: the
  frontend/pop-out can't send the credential off-origin) — while loosening only `script-src`
  (`'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'` for the bundle) and worker/child/img/font;
- **keeps every non-CSP header except X-Frame-Options**, including `Permissions-Policy` (the `@app`
  block is otherwise byte-identical to today's).

No other infra changes. `pnpm build` is unaffected (no new frontend bundle — Chrome serves its
own).

### 5. Security posture

- The loopback debug port is unauthenticated **on-host** — same trust level as the existing
  scoped-sudo terminal sessions on a single-user box. Note it in AGENTS.md's security section.
- **Log redaction must cover the encoded token form.** The `inspector.html` request carries the
  credential percent-encoded inside its `?wss=` value (`…%3Ftoken%3D<cred>`), which the existing
  `[?&]token=` serializer regex does not match — every DevTools asset request would log the
  credential. The request serializer must redact both the plain and encoded forms (a pure
  `redactUrlTokens` helper, unit-tested).
- Off-host, every DevTools path goes through the daemon: assets are behind an unguessable tab UUID;
  the CDP WS requires the bearer credential. Both routes are **remote-only** (never on the
  unauthenticated unix socket).
- **The DevTools frontend is active same-origin code**, and the app origin stores the
  reconstructable bearer (`base64(username:hash)`) in `localStorage`. It's contained two ways: the
  UI iframe is sandboxed to an opaque origin (no `localStorage` access at all), and the `@devtools`
  CSP locks `connect-src`/`form-action` to `'self'` so even the pop-out (same-origin, *can* read
  `localStorage`) can't exfiltrate off-origin. This is the model chosen over serving DevTools from a
  separate origin / behind a per-load ticket (heavier) or accepting the raw same-origin risk.
- No `--remote-allow-origins` is set: the daemon's proxy sends no `Origin`, so Chrome's CDP origin
  check passes without weakening it.

## Error handling summary

| Condition | Behavior |
|---|---|
| Tab stopped/crashed (not running) | both routes 409 → UI shows placeholder (keyed on `browser.status`); iframe remounts on relaunch |
| Bad/missing token on `/ws-devtools` | close `1008 unauthorized` (same as `/ws-browser`) |
| Unknown tab id | asset route 409/404; WS `devtoolsEndpoint` throws → close |
| Client WS floods pre-open queue | bounded queue overflow → close `1011` (fail-closed) |
| Upstream Chromium dies mid-session | upstream close propagates to client; `browser.status` events drive the placeholder |
| Upstream fails while tab still running | DevTools frontend's own disconnected page (no custom health signal in v1) |
| Chromium missing on host | unchanged: browser tab creation already 409s |
| Either new route hit on the unix socket | not registered there (remote-only) → 404 / no upgrade |

## Out of scope (v1)

- Bottom dock / dock-position picker.
- Native (custom React) console/network panels and picker↔DevTools integration.
- DevTools over the desktop unix-socket transport.
- Short-lived ticket auth for pop-out URLs.
- Persisting the devtools-open state across page reloads.

## Verification

- **Deploy-time risk #1:** the host Chromium must actually serve the bundled DevTools frontend at
  `/devtools/inspector.html` under `--headless=new` (full Chrome/Chromium builds do; the old
  `headless_shell` did not). First check after deploy, with a browser tab open:
  `GET /devtools-frontend/<tabId>/inspector.html` must return 200 — a 404/502 means that binary
  can't power this feature (shipping our own frontend assets is explicitly out of scope for v1).
- **Deploy-time risk #2 — sandbox compatibility:** confirm the DevTools frontend actually functions
  inside `sandbox="allow-scripts allow-popups"` (opaque origin). If its own unavailable storage
  breaks it, drop the sandbox attribute and rely on the `@devtools` CSP `connect-src 'self'`
  containment — and record which layer is active.
- `pnpm check` clean, plus `pnpm --filter @orquester/daemon test` — the pure proxy helpers
  (`parseDebugPort`/`sanitizeDevtoolsPath`/`redactUrlTokens`) AND the two proxy routes have
  node:test coverage (auth, remote-only registration, path-traversal, first-message preservation,
  loopback Host rewrite) via `injectWS` + a fake loopback upstream.
- This checkout runs inside a live Orquester instance — **do not** start a daemon here. Real
  end-to-end verification happens on a deploy or separate checkout: open a browser tab, toggle the
  dock, resize it, pop out, and exercise Console/Elements/Network/Sources against a dev server;
  on mobile verify the full-screen swap; re-run `node scripts/smoke-web.mjs` after deploy.
