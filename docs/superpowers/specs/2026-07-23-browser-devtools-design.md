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

- Remove `pipe: true`; add `--remote-debugging-port=0` (kernel-assigned, binds `127.0.0.1` only)
  and `--remote-allow-origins=*` (safe: loopback-only port; real auth is at the daemon).
- Read the assigned port back from `browser.wsEndpoint()` and store `debugPort` on the per-project
  `Chrome` entry.
- Everything else unchanged: sandbox retry, profile dirs, per-project lifecycle, screencast, picker.
- Target resolution: a tab's DevTools target id is fetched on demand via the tab's existing
  `CDPSession` — `Target.getTargetInfo` (no args) returns the session's own `targetId`. Resolved at
  WS-upgrade time so a relaunched tab (new target) needs no new client URL.
- New service surface: `browsers.devtoolsEndpoint(tabId)` → `{ port, targetId }`; throws
  `BrowserError` 409 when the tab is not `running`.

### 2. Daemon proxy — two new routes (HTTP transport only, `apps/daemon/src/index.ts`)

**Frontend assets — `GET /devtools-frontend/:browserId/*`**
- Reverse-proxies `*` to `http://127.0.0.1:<debugPort>/devtools/*` for the Chromium owning that
  tab's project, rewriting `Host` to `127.0.0.1:<debugPort>`.
- `inspector.html` references its assets relatively, so everything stays under the
  `/devtools-frontend/<id>/` prefix.
- Served **unauthenticated**, like the SPA bundle: the assets are generic Chrome files; the tab id
  is an unguessable UUID; the sensitive channel is the WS below. Chromium's `/json/*` discovery
  endpoints are **not** exposed (they leak page URLs/titles).
- The daemon strips/normalizes response headers as needed and must add this prefix to the SPA
  fallback's reserved list so unknown paths under it 404 instead of returning `index.html`.

**CDP WebSocket — `GET /ws-devtools/:browserId` (websocket)**
- Sibling of `/ws-browser`: registered outside `/api` (WS can't set headers), authenticated via
  `?token=` with the same `authorizeCredential` check, closes `1008 unauthorized` on failure.
  Token stays redacted from logs.
- On upgrade: validate tab exists and is running → resolve `{port, targetId}` → dial
  `ws://127.0.0.1:<port>/devtools/page/<targetId>` with the `ws` client (add as an explicit daemon
  dependency; today it's only transitive via `@fastify/websocket`), `Host` rewritten to loopback,
  `Origin` stripped → pipe frames both ways; either side closing closes the other.
- Upstream dial failure or a non-running tab closes the client socket; the UI shows the
  placeholder state.

### 3. UI (`packages/ui/src/components/browser/`)

- **State per browser tab:** `devtools: "closed" | "split"` (+ mobile "swap" which reuses the same
  flag). Not persisted across reloads in v1; the split width **is** persisted via a validated
  localStorage helper following the `panel-sizes.ts` pattern (default ~45%, clamped min/max).
- **Toolbar:** a DevTools toggle button (opens/closes the dock; on mobile toggles full-screen
  DevTools) and a pop-out button. Buttons render only when the transport has `browserChannel()`
  (HTTP), matching browser-tab availability.
- **Split (desktop/tablet):** flex row — canvas viewport left, `<iframe>` right, the shared
  `ResizeHandle` divider between them dragging the DevTools pane width.
- **Mobile (existing coarse-pointer/mobile detection in `BrowserView`):** the DevTools toggle swaps
  the tab content to the full-screen iframe; the toolbar keeps a Page ⇄ DevTools switch so
  flipping is one tap. No divider.
- **Iframe URL:** `/devtools-frontend/<id>/inspector.html?wss=<host>/ws-devtools/<id>?token=<cred>`
  (`ws=` instead of `wss=` on plain-HTTP dev). The credential accessor follows the existing
  download-URL pattern on `ApiClient`. Implementation note: the token rides inside the `wss=`
  query value and must survive the frontend's param parsing — verify during implementation; if the
  frontend mangles nested query strings, fall back to a URL-encoded token path segment
  (`/ws-devtools/<id>/<token>`).
- **Lifecycle:** the iframe is keyed on the tab's status generation — when a stopped/crashed tab
  relaunches, the iframe remounts (the DevTools frontend does not auto-reconnect). While the tab
  is not `running`, the pane shows a placeholder instead of the iframe.
- **Pop-out:** `window.open(iframeUrl, "orq-devtools-<id>")` and close the in-tab split. The page
  and DevTools ride independent WS connections, so the tab keeps streaming. On mobile the pop-out
  opens as a new browser tab. Known trade-off: the popped-out URL carries `?token=` and lands in
  that device's browser history — same class as existing `?token=` download links; acceptable for
  a single-user tool, short-lived tickets are a possible later hardening.

### 4. Deploy — Caddyfile carve-out (mandatory)

Add a path matcher for `/devtools-frontend/*` that:
- drops `X-Frame-Options: DENY` and sets no `frame-ancestors 'none'` (otherwise the iframe is
  blocked outright), and
- exempts the path from the strict SPA CSP (the DevTools frontend needs its own workers/inline
  handling); HSTS and the other non-CSP headers stay.

No other infra changes. `pnpm build` is unaffected (no new frontend bundle — Chrome serves its
own).

### 5. Security posture

- The loopback debug port is unauthenticated **on-host** — same trust level as the existing
  scoped-sudo terminal sessions on a single-user box. Note it in AGENTS.md's security section.
- Off-host, every DevTools path goes through the daemon: assets are inert Chrome files behind an
  unguessable tab UUID; the CDP WS requires the bearer credential.
- `--remote-allow-origins=*` is confined to the loopback listener; the daemon strips `Origin`
  when proxying anyway.

## Error handling summary

| Condition | Behavior |
|---|---|
| Tab stopped/crashed | `devtoolsEndpoint` 409 → WS refused → UI placeholder; iframe remounts on relaunch |
| Bad/missing token on `/ws-devtools` | close `1008 unauthorized` (same as `/ws-browser`) |
| Unknown tab id | asset route 404; WS close |
| Upstream Chromium dies mid-session | upstream close propagates to client; tab status events drive the placeholder |
| Chromium missing on host | unchanged: browser tab creation already 409s |

## Out of scope (v1)

- Bottom dock / dock-position picker.
- Native (custom React) console/network panels and picker↔DevTools integration.
- DevTools over the desktop unix-socket transport.
- Short-lived ticket auth for pop-out URLs.
- Persisting the devtools-open state across page reloads.

## Verification

- `pnpm check` clean (the pre-commit gate; no test runner in this repo).
- This checkout runs inside a live Orquester instance — **do not** start a daemon here. Real
  end-to-end verification happens on a deploy or separate checkout: open a browser tab, toggle the
  dock, resize it, pop out, and exercise Console/Elements/Network/Sources against a dev server;
  on mobile verify the full-screen swap; re-run `node scripts/smoke-web.mjs` after deploy.
