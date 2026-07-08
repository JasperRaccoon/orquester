# PWA for the Orquester web client — design

Date: 2026-07-08. Status: approved for implementation.

## Goal

Make the web client (apps/web, served by the daemon behind Caddy) an installable
Progressive Web App: standalone app-like display on mobile/desktop, a service worker
with an offline app-shell fallback, and Web Push notifications that fire when an
agent session rings the terminal bell ("needs your attention"). The Electron desktop
app must be completely unaffected.

## Current state (verified by exploration)

- `apps/web/public/site.webmanifest` exists and is linked from `apps/web/index.html`,
  with `icon-192.png` / `icon-512.png` present in `apps/web/public/` — but
  `"display": "browser"` blocks installability and `theme_color` is `#ab4ccb`
  (app shell is neutral dark `#111111`/`#0a0a0a`).
- No service worker anywhere; no `vite-plugin-pwa`/workbox; no Notification/Push API use.
- Daemon serves the SPA un-gated via `@fastify/static` (`wildcard: true`) with an
  SPA fallback that returns `index.html` for ANY missing GET path — so `/sw.js`
  must genuinely exist in `dist` (Vite copies `public/` into `dist`).
- Caddy CSP already allows a same-origin classic SW (`worker-src 'self' blob:`,
  `script-src 'self'`); `manifest-src` is absent (falls back to `default-src 'self'`).
- Auth bearer = `base64(username:bcryptHash)`, stored in localStorage, sent as
  `Authorization: Bearer` — and as `?token=` on `/ws` and `/api/fs/download` only.
- Never-cache surfaces: `/health` (4s liveness probe), `/api/*`, `/events` (NDJSON
  stream), `/ws`, `/api/sessions/:id/output` (streaming), `/mcp`.
- Daemon-side attention signal exists: `ActivityTracker`/`BellScanner`
  (`apps/daemon/src/ansi-activity.ts`) — sessions emit internal lifecycle
  `activity { id, type: "bell" }` (`apps/daemon/src/sessions.ts`), cleared on input.
  It is NOT on the `/events` Broadcaster; a push service must subscribe to the
  session manager's lifecycle emitter directly (same as the broadcaster wiring in
  `apps/daemon/src/index.ts:211-274`).
- No web-push/VAPID dependency exists. Node 20, ESM, tsx (no daemon build step).
- Persistence pattern for new daemon state: path helper + zod schema +
  `createDefault*`/`parse*` in `packages/config/src/index.ts`, a field on
  `ResolvedPaths`, JSON file under `<appdir>/daemon/`, atomic tmp+rename write
  (like `sessions.json`), `chmod 0600` for secret material (like `accounts.json`).

## Design

### A. Installable app shell (apps/web only)

1. **Manifest** — rewrite `apps/web/public/site.webmanifest`:
   - `name` "Orquester", `short_name` "Orquester", `description` short one-liner.
   - `id: "/"`, `start_url: "/"`, `scope: "/"`.
   - `display: "standalone"`.
   - `theme_color: "#111111"`, `background_color: "#111111"` (matches shell; the
     Electron prepaint uses the same value).
   - icons: keep `icon-192.png` + `icon-512.png` with `purpose: "any"`, plus the
     same files declared again with `purpose: "maskable"`.
2. **index.html head**:
   - `theme-color` → `#111111`.
   - viewport gains `viewport-fit=cover`.
   - Add `mobile-web-app-capable`, `apple-mobile-web-app-capable`,
     `apple-mobile-web-app-status-bar-style: black-translucent`,
     `apple-mobile-web-app-title: Orquester`.
3. **Safe areas** — in `apps/web/src/styles.css` (web-only file) pad the app root
   with `env(safe-area-inset-top/bottom)` so the standalone iOS status bar / home
   indicator don't overlap the TopBar / MobileKeyBar. Inets are 0 in normal
   browsers, so this is inert outside standalone mode. No `packages/ui` changes.
4. **Service worker** — new hand-written `apps/web/public/sw.js` (classic script,
   root scope; Vite copies it verbatim into `dist/`):
   - **Never intercepts** non-GET requests, or GETs whose path starts with `/api`,
     `/events`, `/ws`, `/health`, `/mcp` — return without calling `respondWith`
     so the network handles them natively (streams, auth, tokens untouched).
   - Navigations (`request.mode === "navigate"`): network-first; on network failure
     serve cached `/index.html` (offline shell → the app renders its own
     disconnected/reconnect state).
   - `/assets/*` (content-hashed): cache-first, trim runtime cache to ~60 entries.
   - Root static files (icons, manifest): stale-while-revalidate or network-first —
     implementer's choice, keep simple.
   - `install`: `self.skipWaiting()`; `activate`: `clients.claim()` + delete caches
     not in the current cache-name list. Version the cache names with a constant.
   - **Push handlers** (contract in section C): `push` → parse JSON payload
     `{ title, body, tag, sessionId }` → `showNotification(title, { body, tag,
     icon: "/icon-192.png", badge: "/icon-192.png", data: { sessionId } })`.
     `notificationclick` → close notification, focus an existing client window if
     any, else `clients.openWindow("/")`.
5. **Registration** — new `apps/web/src/pwa.ts` imported from `apps/web/src/main.tsx`:
   `if (import.meta.env.PROD && "serviceWorker" in navigator)` register `/sw.js`
   on window load. Registration lives in the web host only — never `packages/ui`,
   so Electron/desktop never touches it.
6. **Caddy** — `deploy/Caddyfile` CSP: add `manifest-src 'self'` (explicitness only;
   nothing else changes — SW already allowed by `worker-src 'self'`).

### B. Daemon: Web Push backend

1. **Dependency**: `web-push` (+ dev `@types/web-push`) in `apps/daemon`.
2. **Config (`packages/config/src/index.ts`)**: `pushConfigPath(baseDir)` →
   `<appdir>/daemon/push.json`; new `ResolvedPaths.pushConfigFile`; schema:

   ```ts
   pushConfigSchema = z.object({
     version: z.literal(1),
     vapid: z.object({ publicKey: z.string(), privateKey: z.string(), subject: z.string() }).nullable(),
     subscriptions: z.array(z.object({
       endpoint: z.string(),
       keys: z.object({ p256dh: z.string(), auth: z.string() }),
       createdAt: z.string(),
       userAgent: z.string().optional()
     }))
   })
   ```

   plus `createDefaultPushConfig()` and `parsePushConfig()` following the existing
   sidecar patterns.
3. **Service** — new `apps/daemon/src/push.ts`, `PushService`:
   - Loads/creates `push.json` (atomic tmp+rename write, `chmod 0600` — the VAPID
     private key is secret material).
   - `ensureVapid()`: lazily generate keys via `webpush.generateVAPIDKeys()` on
     first need, subject `mailto:orquester@example.com`, persist.
   - `info()` → `{ supported: true, vapidPublicKey, subscriptionCount }`.
   - `subscribe(sub)` upserts by `endpoint`; `unsubscribe(endpoint)` removes.
   - `notifyAttention(session: SessionSummary)`: debounce per session id (min 30s
     between pushes for the same session); payload
     `{ title: "<session title> needs your attention", body: "<project dir name>",
     tag: "session-<id>", sessionId }`; send to every subscription via
     `webpush.sendNotification`; on 404/410 responses drop that subscription and
     persist. Errors are logged, never thrown into the daemon.
   - `sendTest()` → sends a fixed test payload to all subscriptions, returns count.
4. **Wiring (`apps/daemon/src/index.ts`)**: instantiate `PushService` in
   `startDaemon`; next to the existing broadcaster lifecycle wiring subscribe to
   the session manager lifecycle `activity` events and call
   `pushService.notifyAttention(...)` only when `type === "bell"` and the session
   `kind === "agent"` (shell beeps must not push). Pass the service into
   `createServer` alongside the other services.
5. **Routes** (registered normally in `createServer`; the existing auth hook
   bearer-gates them on remote HTTP automatically):
   - `GET /api/push/info` → `PushInfoResponse` (triggers lazy VAPID generation).
   - `POST /api/push/subscriptions` body `PushSubscribeRequest` → 204.
   - `DELETE /api/push/subscriptions` body `PushUnsubscribeRequest` → 204.
   - `POST /api/push/test` → `{ sent: number }`.

### C. Wire contract (`packages/api/src/index.ts`) — EXACT, both sides code to this

```ts
export interface PushInfoResponse {
  supported: boolean;
  vapidPublicKey: string;
  subscriptionCount: number;
}

export interface PushSubscriptionKeys {
  p256dh: string;
  auth: string;
}

export interface PushSubscribeRequest {
  endpoint: string;
  keys: PushSubscriptionKeys;
  userAgent?: string;
}

export interface PushUnsubscribeRequest {
  endpoint: string;
}

export interface PushTestResponse {
  sent: number;
}
```

Push message payload (daemon → service worker, JSON):
`{ "title": string, "body": string, "tag": string, "sessionId": string }`.

### D. UI: notifications toggle (packages/ui, web runtime only)

1. **`packages/ui/src/lib/push.ts`** (new): browser-side helpers —
   `pushSupported()` (`"serviceWorker" in navigator && "PushManager" in window &&
   "Notification" in window`), `urlBase64ToUint8Array()`, `getSubscription()`,
   `enablePush(api)` (requestPermission → `registration.pushManager.subscribe({
   userVisibleOnly: true, applicationServerKey })` using `GET /api/push/info` →
   `POST /api/push/subscriptions`), `disablePush(api)` (unsubscribe + DELETE).
2. **`packages/ui/src/lib/api-client.ts`**: `pushInfo()`, `pushSubscribe(req)`,
   `pushUnsubscribe(req)`, `pushTest()` — thin `send()` wrappers like the rest.
3. **Settings** — in `AppSettings` (`SettingsModal.tsx`), a "Push notifications"
   `Field` + `Switch`, rendered only when `runtime === "web"` AND `pushSupported()`.
   Switch state = current `pushManager.getSubscription()` presence (async on mount).
   If `Notification.permission === "denied"`, show the switch disabled with a hint
   to unblock in browser settings. Next to it a small "Send test" button (calls
   `pushTest()`), visible only while enabled. Desktop never renders any of this.

### E. Docs

- `AGENTS.md`: add PWA to the features line; add a gotcha bullet: `/sw.js` +
  `site.webmanifest` must exist in `apps/web/dist` (the SPA fallback otherwise
  returns HTML for them), push state lives in `<appdir>/daemon/push.json` (0600,
  holds the VAPID private key), and pushes fire from agent-session bells.

## Explicitly out of scope

- No `vite-plugin-pwa`/workbox, no precache manifest.
- No offline functionality beyond the cached app shell.
- No desktop/Electron changes (`apps/desktop` untouched).
- No new `/events` broadcast channel for attention (push service hooks the internal
  lifecycle emitter directly).
- No per-workspace/per-session notification preferences (one global toggle =
  subscription existence).

## Verification (no daemon may be started — we run inside a live instance)

- `pnpm check` clean (the pre-commit gate).
- `pnpm build` succeeds; `apps/web/dist/` contains `sw.js`, `site.webmanifest`,
  icons; `dist/index.html` carries the new meta tags.
- Confirm `mime@3` (via `@fastify/static`→`@fastify/send`) maps `.webmanifest` →
  `application/manifest+json` by inspecting `node_modules` mime db; if it does not,
  add an explicit content-type for `.webmanifest` in the static registration.
- Static review of sw.js against the never-cache list (auth/streaming surfaces).
