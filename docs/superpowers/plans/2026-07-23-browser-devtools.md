# Browser Tab DevTools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Embed the real Chrome DevTools (Console, Elements, Sources, Network, …) into Orquester's browser tabs, proxied through the daemon with auth — width-resizable right dock + pop-out window on desktop, full-screen swap on mobile.

**Architecture:** Switch the per-project headless Chromium from CDP-over-stdio-pipe to a loopback `--remote-debugging-port=0`. The daemon reverse-proxies (a) Chrome's own prebuilt DevTools frontend at `GET /devtools-frontend/:browserId/*` (unauthenticated, like the SPA bundle) and (b) the per-tab CDP WebSocket at `GET /ws-devtools/:browserId` (`?token=` auth, sibling of `/ws-browser`), rewriting the `Host` header to loopback. The UI renders the frontend in a same-origin iframe inside `BrowserView`.

**Tech Stack:** TypeScript 5.8 ESM, Fastify 4 + `@fastify/websocket`, `puppeteer-core` 24, `ws` (new explicit dep), React 18, Tailwind, existing `ResizeHandle`/`useResizeDrag`.

**Spec:** `docs/superpowers/specs/2026-07-23-browser-devtools-design.md`

## Global Constraints

- **⛔ Never launch/restart/stop a daemon in this checkout** — it runs inside a live Orquester instance. Verify with `pnpm check` + unit tests + code review only.
- Pre-commit gate: `pnpm check` (repo-wide `tsc --noEmit`). Daemon unit tests: `pnpm --filter @orquester/daemon test` (node:test via tsx).
- ESM everywhere; relative imports in the daemon end in `.js` (e.g. `./devtools.js`).
- Commit to the **current branch as-is** (even `main`); no new branches. Stage files by name.
- Comments only for non-obvious WHY; match surrounding style.
- Wire/HTTP types live in `packages/api`; this feature adds **no new wire types** (the DevTools channel carries Chrome's own protocol, not ours).
- The DevTools feature is HTTP-transport-only, matching browser tabs (`api.browserChannel()` / `buildDevtoolsUrl()` return null on the desktop unix socket).
- Default HTTP endpoint `127.0.0.1:47831`; the debug port must bind loopback only (puppeteer's default for `--remote-debugging-port=0`).

---

### Task 1: Chromium debug port — launch switch + `devtools.ts` helpers

**Files:**
- Create: `apps/daemon/src/devtools.ts`
- Create: `apps/daemon/src/devtools.test.ts`
- Modify: `apps/daemon/src/browsers.ts` (imports ~line 20, `Chrome` interface ~line 76, `launch()`/`tryLaunch()` ~lines 385–427, new public methods after `dispatchTouch` ~line 318)

**Interfaces:**
- Consumes: existing `BrowserError`, `Tab`, `chromeFor`, `ensurePage`, `mustGet` in `browsers.ts`.
- Produces (later tasks rely on these exact signatures):
  - `parseDebugPort(wsEndpoint: string): number | null` (from `devtools.js`)
  - `sanitizeDevtoolsPath(rest: string): string | null` (from `devtools.js`; implemented in Task 2's test-first steps but the file is created here)
  - `Chrome` gains `debugPort: number`
  - `BrowserManager.devtoolsPort(id: string): Promise<number>` — throws `BrowserError("Browser tab is not running", 409)` when the project's Chromium isn't up; **does not launch**.
  - `BrowserManager.devtoolsEndpoint(id: string): Promise<{ port: number; targetId: string }>` — launches the page if needed (lazy restored tabs), 409 if it still isn't running.

- [ ] **Step 1: Write the failing test**

Create `apps/daemon/src/devtools.test.ts`:

```ts
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { parseDebugPort } from "./devtools.js";

test("parseDebugPort extracts the loopback port from a puppeteer wsEndpoint", () => {
  assert.equal(parseDebugPort("ws://127.0.0.1:41573/devtools/browser/abc-def"), 41573);
});

test("parseDebugPort rejects garbage, missing ports and out-of-range values", () => {
  assert.equal(parseDebugPort("not a url"), null);
  assert.equal(parseDebugPort(""), null);
  assert.equal(parseDebugPort("ws://127.0.0.1/devtools/browser/x"), null);
  assert.equal(parseDebugPort("ws://127.0.0.1:0/devtools/browser/x"), null);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @orquester/daemon exec node --import tsx --test src/devtools.test.ts`
Expected: FAIL — `Cannot find module './devtools.js'`.

- [ ] **Step 3: Create `apps/daemon/src/devtools.ts` with the port parser**

```ts
/**
 * Helpers for the embedded-DevTools proxy: the daemon reverse-proxies the
 * Chromium debug endpoint (frontend assets + per-tab CDP WebSocket) so the
 * real, version-matched DevTools frontend can attach to a browser tab. Pure
 * functions only — the routes live in index.ts, the port ownership in
 * browsers.ts.
 */

/** Extract the loopback debug port from puppeteer's browser.wsEndpoint()
 *  (`ws://127.0.0.1:<port>/devtools/browser/<id>`). Null when unparseable. */
export function parseDebugPort(wsEndpoint: string): number | null {
  try {
    const port = Number(new URL(wsEndpoint).port);
    return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @orquester/daemon exec node --import tsx --test src/devtools.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Switch the launch off the stdio pipe**

In `apps/daemon/src/browsers.ts`:

Add to the imports (after the `./browser-pick.js` import block):

```ts
import { parseDebugPort } from "./devtools.js";
```

Change the `Chrome` interface:

```ts
interface Chrome {
  browser: Browser;
  sandboxed: boolean;
  /** Loopback remote-debugging port (DevTools frontend + CDP WS proxy). */
  debugPort: number;
}
```

Replace `launch()` (keep `tryLaunch()` as-is) with:

```ts
  private async launch(projectPath: string): Promise<Chrome> {
    await this.closingChromes.get(projectPath);
    const executablePath = this.opts.resolveChromium();
    if (!executablePath) throw new BrowserError("No chromium/chrome binary found on the daemon host", 409);
    const hash = createHash("sha256").update(projectPath).digest("hex").slice(0, 16);
    const userDataDir = join(this.opts.profilesDir, hash);
    await mkdir(userDataDir, { recursive: true, mode: 0o700 });
    // No `pipe: true`: puppeteer then launches with --remote-debugging-port=0
    // (kernel-assigned, bound to 127.0.0.1), which the embedded-DevTools proxy
    // needs — CDP over the stdio pipe exposes no endpoint DevTools can attach
    // to. --remote-allow-origins is belt-and-suspenders: the daemon's WS proxy
    // sends no Origin header, and the port never leaves loopback.
    const base = {
      executablePath, userDataDir, headless: true as const,
      defaultViewport: null,
      args: [
        "--headless=new", "--no-first-run", "--no-default-browser-check",
        "--disable-dev-shm-usage", "--mute-audio", "--remote-allow-origins=*"
      ]
    };
    try {
      return await this.launchWith(base, true);
    } catch (error) {
      // Sandbox unavailable (no userns / setuid helper) is the one retryable
      // launch failure — retry unsandboxed and FLAG it; never silently. It can
      // surface two ways: puppeteer.launch() throws with a "sandbox" message, or
      // (on hosts where the setuid sandbox aborts *after* the pipe connects) the
      // browser connects and then crashes when the first renderer target starts,
      // reported as "Target closed" / "Protocol error". Probing in tryLaunch()
      // turns the latter into a throw here so both take the unsandboxed path.
      if (!isRetryableSandboxFailure(error)) throw error;
      return await this.launchWith({ ...base, args: [...base.args, "--no-sandbox"] }, false);
    }
  }

  private async launchWith(options: Parameters<typeof puppeteer.launch>[0], sandboxed: boolean): Promise<Chrome> {
    const browser = await this.tryLaunch(options);
    const debugPort = parseDebugPort(browser.wsEndpoint());
    if (debugPort === null) {
      await browser.close().catch(() => undefined);
      throw new BrowserError("Chromium did not expose a debugging endpoint", 500);
    }
    return { browser, sandboxed, debugPort };
  }
```

- [ ] **Step 6: Add the two DevTools accessors**

In `browsers.ts`, insert after `dispatchTouch()` (before `shutdown()`):

```ts
  /** Loopback debug port of the tab's (already running) Chromium — for the
   *  DevTools asset proxy. Deliberately does NOT launch anything: assets are
   *  only fetched once the iframe renders, i.e. after the tab is up. */
  async devtoolsPort(id: string): Promise<number> {
    const tab = this.mustGet(id);
    const pending = this.chromes.get(tab.record.projectPath);
    if (!pending) throw new BrowserError("Browser tab is not running", 409);
    return (await pending).debugPort;
  }

  /** Resolve the CDP endpoint the DevTools frontend attaches to. Routed by our
   *  stable tab id and resolved at WS-upgrade time so the iframe URL survives
   *  tab relaunches (Chrome's target id changes; ours doesn't). Launches the
   *  page if needed so DevTools on a lazily-restored tab works. */
  async devtoolsEndpoint(id: string): Promise<{ port: number; targetId: string }> {
    const tab = this.mustGet(id);
    await this.ensurePage(tab);
    const cdp = tab.cdp;
    if (!cdp || tab.status !== "running") throw new BrowserError("Browser tab is not running", 409);
    // Target.getTargetInfo with no targetId returns the session's own target.
    const info = await cdp.send("Target.getTargetInfo");
    const chrome = await this.chromeFor(tab.record.projectPath);
    return { port: chrome.debugPort, targetId: info.targetInfo.targetId };
  }
```

- [ ] **Step 7: Typecheck + full daemon tests**

Run: `pnpm check`
Expected: clean (all packages).
Run: `pnpm --filter @orquester/daemon test`
Expected: PASS (existing suites + devtools.test.ts).

- [ ] **Step 8: Commit**

```bash
git add apps/daemon/src/devtools.ts apps/daemon/src/devtools.test.ts apps/daemon/src/browsers.ts
git commit -m "feat(daemon): expose Chromium remote-debugging port for DevTools embedding"
```

---

### Task 2: DevTools frontend asset proxy route

**Files:**
- Modify: `apps/daemon/src/devtools.ts` (add `sanitizeDevtoolsPath`)
- Modify: `apps/daemon/src/devtools.test.ts` (add tests)
- Modify: `apps/daemon/src/index.ts` (new route after the `DELETE /api/browsers/:id` route ~line 2031; SPA-fallback reserved prefixes ~line 2531)

**Interfaces:**
- Consumes: `services.browsers.devtoolsPort(id)` (Task 1), `BrowserError` (already imported in index.ts for the browser CRUD routes).
- Produces: `GET /devtools-frontend/:browserId/*` — streams Chrome's `/devtools/*` assets. Task 5's iframe loads `/devtools-frontend/<id>/inspector.html?...`.

- [ ] **Step 1: Write the failing tests for the path sanitizer**

Append to `apps/daemon/src/devtools.test.ts`:

```ts
import { sanitizeDevtoolsPath } from "./devtools.js";

test("sanitizeDevtoolsPath accepts normal frontend asset paths", () => {
  assert.equal(sanitizeDevtoolsPath("inspector.html"), "inspector.html");
  assert.equal(sanitizeDevtoolsPath("front_end/entrypoints/inspector/inspector.js"),
    "front_end/entrypoints/inspector/inspector.js");
});

test("sanitizeDevtoolsPath rejects traversal, empty segments and junk", () => {
  assert.equal(sanitizeDevtoolsPath("../json/list"), null);
  assert.equal(sanitizeDevtoolsPath("a/../../json"), null);
  assert.equal(sanitizeDevtoolsPath("a//b"), null);
  assert.equal(sanitizeDevtoolsPath(""), null);
  assert.equal(sanitizeDevtoolsPath("a\\b"), null);
  assert.equal(sanitizeDevtoolsPath("%2e%2e/json"), null);
  assert.equal(sanitizeDevtoolsPath("a".repeat(3000)), null);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @orquester/daemon exec node --import tsx --test src/devtools.test.ts`
Expected: FAIL — `sanitizeDevtoolsPath` is not exported.

- [ ] **Step 3: Implement the sanitizer**

Append to `apps/daemon/src/devtools.ts`:

```ts
/**
 * Validate the wildcard tail of /devtools-frontend/:browserId/* before it is
 * appended to the upstream /devtools/ path. Rejects traversal (raw or
 * percent-encoded), backslashes, empty segments and absurd lengths — the
 * upstream also serves /json/* (page URLs/titles), which must stay unreachable
 * through this proxy.
 */
export function sanitizeDevtoolsPath(rest: string): string | null {
  if (typeof rest !== "string" || rest.length === 0 || rest.length > 2048) return null;
  if (rest.includes("\\") || rest.includes("\0")) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(rest);
  } catch {
    return null;
  }
  if (decoded.includes("\\") || decoded.includes("\0")) return null;
  for (const candidate of [rest, decoded]) {
    if (candidate.split("/").some((s) => s === "" || s === "." || s === "..")) return null;
  }
  return rest;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @orquester/daemon exec node --import tsx --test src/devtools.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Add the proxy route to `index.ts`**

Add imports at the top of `apps/daemon/src/index.ts` (with the other `node:` imports):

```ts
import { request as httpRequest, type IncomingMessage } from "node:http";
```

and (with the local imports):

```ts
import { sanitizeDevtoolsPath } from "./devtools.js";
```

Insert after the `DELETE /api/browsers/:id` route (inside `createServer`, so `services`/`app` are in scope):

```ts
  // Embedded-DevTools frontend assets — reverse-proxied from the tab's own
  // Chromium, which serves a prebuilt, version-matched DevTools bundle at
  // /devtools/*. Unauthenticated by design: these are generic Chrome files at
  // the same trust level as the SPA bundle, behind an unguessable tab UUID —
  // the sensitive channel is the authenticated /ws-devtools proxy. Chromium's
  // /json/* discovery endpoints are deliberately NOT reachable here (the
  // sanitizer pins the path under /devtools/).
  app.get<{ Params: { browserId: string; "*": string } }>(
    "/devtools-frontend/:browserId/*",
    async (request, reply) => {
      const rest = sanitizeDevtoolsPath(request.params["*"]);
      if (!rest) {
        return reply.code(404).send({ code: "NOT_FOUND", message: "Route not found." });
      }
      let port: number;
      try {
        port = await services.browsers.devtoolsPort(request.params.browserId);
      } catch (error) {
        const status = error instanceof BrowserError ? error.statusCode : 500;
        return reply.code(status).send({ code: "BROWSER_UNAVAILABLE", message: "Browser tab is not running." });
      }
      const upstream = await new Promise<IncomingMessage>((resolvePromise, rejectPromise) => {
        const req = httpRequest(
          {
            host: "127.0.0.1",
            port,
            path: `/devtools/${rest}`,
            method: "GET",
            // Chrome 403s any non-localhost Host (DNS-rebinding guard); the
            // public hostname from the Caddy hop must never reach it.
            headers: { host: `127.0.0.1:${port}` }
          },
          resolvePromise
        );
        req.on("error", rejectPromise);
        req.end();
      }).catch(() => null);
      if (!upstream) {
        return reply.code(502).send({ code: "BROWSER_UNAVAILABLE", message: "DevTools upstream unreachable." });
      }
      void reply.header("cache-control", "no-store");
      const contentType = upstream.headers["content-type"];
      if (contentType) void reply.header("content-type", contentType);
      return reply.code(upstream.statusCode ?? 502).send(upstream);
    }
  );
```

- [ ] **Step 6: Reserve the new prefixes in the SPA fallback**

In the `setNotFoundHandler` block (~line 2531), extend `isApi`:

```ts
      const isApi =
        url.startsWith("/api") ||
        url.startsWith("/health") ||
        url.startsWith("/events") ||
        url.startsWith("/mcp") ||
        url.startsWith("/devtools-frontend") ||
        url.startsWith("/ws-devtools");
```

- [ ] **Step 7: Typecheck + tests**

Run: `pnpm check` — expected clean.
Run: `pnpm --filter @orquester/daemon test` — expected PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/daemon/src/devtools.ts apps/daemon/src/devtools.test.ts apps/daemon/src/index.ts
git commit -m "feat(daemon): proxy Chromium's bundled DevTools frontend per browser tab"
```

---

### Task 3: `/ws-devtools/:browserId` CDP WebSocket proxy

**Files:**
- Modify: `apps/daemon/package.json` (add `ws` + `@types/ws`)
- Modify: `apps/daemon/src/index.ts` (new WS route after the `/ws-browser` register block ~line 2494)

**Interfaces:**
- Consumes: `services.browsers.devtoolsEndpoint(id)` (Task 1), `authorizeCredential` (already imported), `websocketPlugin` (already imported), the `options.authRequired` flag.
- Produces: `GET /ws-devtools/:browserId?token=<cred>` websocket — a transparent byte pipe to `ws://127.0.0.1:<port>/devtools/page/<targetId>`. Task 4's `buildDevtoolsUrl` points the frontend's `ws=`/`wss=` param here.

- [ ] **Step 1: Add the `ws` dependency**

Run:
```bash
pnpm --filter @orquester/daemon add ws@^8.18.0
pnpm --filter @orquester/daemon add -D @types/ws@^8.5.13
```
Expected: `apps/daemon/package.json` gains both; lockfile updates. (`ws` was previously only a transitive dep of `@fastify/websocket` — the proxy dials upstream with it, so it must be direct.)

- [ ] **Step 2: Add the WS proxy route**

Add the import at the top of `apps/daemon/src/index.ts`:

```ts
import { WebSocket as UpstreamWebSocket } from "ws";
```

Insert after the `/ws-browser` register block (after its closing `});` ~line 2494):

```ts
  // Embedded-DevTools CDP WebSocket — the real DevTools frontend speaks raw
  // CDP to the tab's page target through this authenticated pipe (sibling of
  // /ws-browser: ?token= because browsers can't set WS headers). Routed by our
  // stable tab id; the volatile Chrome target id is resolved at upgrade time,
  // so the iframe URL survives tab relaunches. DevTools attaches as a SECOND
  // CDP session on the page — multi-session is native since Chrome 63 and does
  // not disturb the screencast/picker session.
  void app.register(async (instance) => {
    await instance.register(websocketPlugin);
    instance.get<{ Params: { browserId: string } }>(
      "/ws-devtools/:browserId",
      { websocket: true },
      (socket, request) => {
        if (options.authRequired) {
          const token = (request.query as { token?: string }).token;
          if (!authorizeCredential(token, config.transports.http.username, config.transports.http.passwordHash)) {
            socket.close(1008, "unauthorized");
            return;
          }
        }
        void (async () => {
          let endpoint: { port: number; targetId: string };
          try {
            endpoint = await services.browsers.devtoolsEndpoint(request.params.browserId);
          } catch {
            socket.close(1011, "browser tab not running");
            return;
          }
          const upstream = new UpstreamWebSocket(
            `ws://127.0.0.1:${endpoint.port}/devtools/page/${endpoint.targetId}`,
            {
              // Host must read as loopback (Chrome's DNS-rebinding guard); no
              // Origin header is sent, so --remote-allow-origins never bites.
              headers: { host: `127.0.0.1:${endpoint.port}` },
              // CDP responses can be MBs (Page.captureScreenshot, source text);
              // ws' 100 MiB default is fine, set explicitly for intent.
              maxPayload: 256 * 1024 * 1024
            }
          );
          // Frontend messages that arrive before the upstream handshake
          // completes must not be dropped — DevTools sends its enable batch
          // immediately on open.
          const pending: Array<{ data: Buffer; binary: boolean }> = [];
          upstream.on("open", () => {
            for (const m of pending) upstream.send(m.data, { binary: m.binary });
            pending.length = 0;
          });
          socket.on("message", (data: Buffer, isBinary: boolean) => {
            if (upstream.readyState === UpstreamWebSocket.OPEN) upstream.send(data, { binary: isBinary });
            else if (upstream.readyState === UpstreamWebSocket.CONNECTING) pending.push({ data, binary: isBinary });
          });
          upstream.on("message", (data, isBinary) => {
            try {
              socket.send(data as Buffer, { binary: isBinary });
            } catch {
              /* client socket closing */
            }
          });
          upstream.on("close", () => socket.close());
          upstream.on("error", () => socket.close(1011, "devtools upstream error"));
          socket.on("close", () => upstream.close());
          socket.on("error", () => upstream.close());
        })();
      }
    );
  });
```

- [ ] **Step 3: Typecheck + tests**

Run: `pnpm check` — expected clean.
Run: `pnpm --filter @orquester/daemon test` — expected PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/daemon/package.json pnpm-lock.yaml apps/daemon/src/index.ts
git commit -m "feat(daemon): authenticated CDP WebSocket proxy for embedded DevTools"
```

---

### Task 4: Client plumbing — `buildDevtoolsUrl` + split persistence

**Files:**
- Modify: `packages/ui/src/lib/api-client.ts` (new method right after `buildDownloadUrl`, ~line 328)
- Modify: `packages/ui/src/lib/panel-sizes.ts` (new section at the end)

**Interfaces:**
- Consumes: `ApiClient`'s existing `this.transportKind` (`"http" | "unix"`) and `this.connection.endpoint` / `this.connection.password` (exactly as `buildDownloadUrl` uses them).
- Produces (Task 5 relies on these exact names):
  - `ApiClient.buildDevtoolsUrl(browserId: string): string | null`
  - `DEVTOOLS_SPLIT_DEFAULT = 0.45`, `DEVTOOLS_SPLIT_MIN = 0.2`, `DEVTOOLS_SPLIT_MAX = 0.8`
  - `clampDevtoolsSplit(fraction: number): number`
  - `loadDevtoolsSplit(): number`
  - `persistDevtoolsSplit(fraction: number): void`

- [ ] **Step 1: Add `buildDevtoolsUrl` to `ApiClient`**

Insert directly after `buildDownloadUrl` in `packages/ui/src/lib/api-client.ts`:

```ts
  /**
   * URL of the embedded DevTools frontend for a browser tab, or null when the
   * transport can't reach it (the desktop unix socket — same availability as
   * browser tabs). The frontend assets are proxied from the tab's Chromium;
   * the ws/wss param points the frontend at the daemon's authenticated CDP
   * proxy, with the bearer riding as ?token= (the /ws-browser trick). The
   * token therefore appears in the iframe/pop-out URL — accepted for a
   * single-user tool; see the design doc's security note.
   */
  buildDevtoolsUrl(browserId: string): string | null {
    if (this.transportKind !== "http") {
      return null;
    }
    const base = this.connection.endpoint.replace(/\/$/, "");
    const hostPath = `${base.replace(/^https?:\/\//, "")}/ws-devtools/${browserId}`;
    const wsValue = this.connection.password
      ? `${hostPath}?token=${encodeURIComponent(this.connection.password)}`
      : hostPath;
    const param = base.startsWith("https") ? "wss" : "ws";
    return `${base}/devtools-frontend/${browserId}/inspector.html?${param}=${encodeURIComponent(wsValue)}`;
  }
```

Implementation note (from the spec): the token rides inside the URL-encoded `wss=` value; the DevTools frontend decodes its query params and appends the whole value after `wss://`, which is the pattern browserless uses. If deploy-time verification (Task 7) shows the frontend mangling the nested `?token=`, the fallback is a token **path segment** instead: daemon route `/ws-devtools/:browserId/:token` (token also accepted from the path in the auth check) and `hostPath` becomes `${base…}/ws-devtools/${browserId}/${encodeURIComponent(password)}`.

- [ ] **Step 2: Add the split store to `panel-sizes.ts`**

Append at the end of `packages/ui/src/lib/panel-sizes.ts`:

```ts
/* ── Browser DevTools split (global width fraction) ─────────────────────── */

/**
 * Width of the DevTools dock as a fraction of the browser tab's row. A global
 * scalar (not per-project): DevTools wants roughly the same share everywhere,
 * and the fraction adapts to any container width. Same persistence contract
 * as the stores above: SSR-safe, error-swallowing, validated + clamped on load.
 */
const DEVTOOLS_SPLIT_KEY = "orquester:devtools-split";

export const DEVTOOLS_SPLIT_DEFAULT = 0.45;
export const DEVTOOLS_SPLIT_MIN = 0.2;
export const DEVTOOLS_SPLIT_MAX = 0.8;

/** Clamp into the split range; non-finite input falls back to the default. */
export function clampDevtoolsSplit(fraction: number): number {
  if (!Number.isFinite(fraction)) {
    return DEVTOOLS_SPLIT_DEFAULT;
  }
  return Math.min(DEVTOOLS_SPLIT_MAX, Math.max(DEVTOOLS_SPLIT_MIN, fraction));
}

/** Load the persisted split fraction (clamped), or the default on any failure. */
export function loadDevtoolsSplit(): number {
  try {
    if (typeof localStorage === "undefined") {
      return DEVTOOLS_SPLIT_DEFAULT;
    }
    const raw = localStorage.getItem(DEVTOOLS_SPLIT_KEY);
    if (!raw) {
      return DEVTOOLS_SPLIT_DEFAULT;
    }
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed >= 1) {
      return DEVTOOLS_SPLIT_DEFAULT;
    }
    return clampDevtoolsSplit(parsed);
  } catch {
    return DEVTOOLS_SPLIT_DEFAULT;
  }
}

/** Persist the split fraction; a storage failure is non-fatal. */
export function persistDevtoolsSplit(fraction: number): void {
  try {
    if (typeof localStorage === "undefined") {
      return;
    }
    localStorage.setItem(DEVTOOLS_SPLIT_KEY, String(clampDevtoolsSplit(fraction)));
  } catch {
    /* ignore quota/availability errors — the split stays in-memory only */
  }
}
```

- [ ] **Step 3: Typecheck**

Run: `pnpm check` — expected clean.

- [ ] **Step 4: Commit**

```bash
git add packages/ui/src/lib/api-client.ts packages/ui/src/lib/panel-sizes.ts
git commit -m "feat(ui): DevTools URL builder and split-width persistence"
```

---

### Task 5: `BrowserView` — dock split, pop-out, mobile swap

**Files:**
- Modify: `packages/ui/src/components/browser/BrowserView.tsx`

**Interfaces:**
- Consumes: `api.buildDevtoolsUrl(browser.id)`, `loadDevtoolsSplit`/`persistDevtoolsSplit`/`clampDevtoolsSplit`/`DEVTOOLS_SPLIT_*` (Task 4), `ResizeHandle` (`packages/ui/src/components/ui/resize-handle.tsx`), existing `useIsDesktop`.
- Produces: the user-facing feature. No exports consumed elsewhere.

Behavior contract (from the spec):
- Desktop: toggle button opens a **right dock** (viewport left, iframe right) separated by a vertical `ResizeHandle`; dragging resizes the dock width; the fraction persists; double-click resets to default.
- Pop-out button opens the DevTools URL in a separate window and closes the dock.
- Mobile (`!useIsDesktop()`): the toggle swaps the whole tab to the DevTools iframe; **the screencast subscription is paused** while swapped (no frames to a hidden canvas; re-subscribe re-primes on switch-back).
- The iframe remounts when the tab's status changes (DevTools doesn't auto-reconnect after a relaunch); non-running tabs show a placeholder.
- Both buttons render only when `buildDevtoolsUrl` returns non-null (HTTP transport).

- [ ] **Step 1: Imports and state**

In `BrowserView.tsx`, extend the lucide import (line 2-4) to add `Braces` and `ExternalLink`:

```ts
import {
  ArrowLeft, ArrowRight, Braces, Crosshair, ExternalLink, Keyboard, Monitor, RotateCw, ShieldAlert, Smartphone
} from "lucide-react";
```

Add the lib imports:

```ts
import { ResizeHandle } from "../ui/resize-handle";
import {
  DEVTOOLS_SPLIT_DEFAULT, DEVTOOLS_SPLIT_MAX, DEVTOOLS_SPLIT_MIN,
  clampDevtoolsSplit, loadDevtoolsSplit, persistDevtoolsSplit
} from "../../lib/panel-sizes";
```

Inside the component (after the `zoom`/`gesture` state, before the `channel` memo), add:

```tsx
  const devtoolsUrl = useMemo(() => api?.buildDevtoolsUrl(browser.id) ?? null, [api, browser.id]);
  const [devtoolsOpen, setDevtoolsOpen] = useState(false);
  const [devtoolsSplit, setDevtoolsSplit] = useState<number>(loadDevtoolsSplit);
  const rowRef = useRef<HTMLDivElement>(null);
```

After the `isDesktop` declarations add:

```tsx
  // Mobile: DevTools takes the whole tab (a side split is hopeless on a phone
  // and DevTools' UI is dense). The screencast pauses while swapped — no
  // frames for a hidden canvas; re-subscribing re-primes on switch-back.
  const devtoolsFullscreen = !isDesktop && devtoolsOpen;
```

- [ ] **Step 2: Pause the stream in fullscreen-DevTools mode**

Change the subscribe effect's guard (line ~51) from:

```ts
    if (!channel || !active) return;
```

to:

```ts
    if (!channel || !active || devtoolsFullscreen) return;
```

and its dependency array from `[channel, browser.id, active]` to `[channel, browser.id, active, devtoolsFullscreen]`.

- [ ] **Step 3: Toolbar buttons**

Insert after the Pick button (`</button>` of "Pick element", before the `!isDesktop &&` keyboard button):

```tsx
        {devtoolsUrl && (
          <button type="button" aria-label="Toggle DevTools" onClick={() => setDevtoolsOpen((v) => !v)}
            className={cn("rounded p-1 hover:bg-neutral-800", devtoolsOpen ? "bg-neutral-700 text-neutral-100" : "text-neutral-400")}>
            <Braces size={14} />
          </button>
        )}
        {devtoolsUrl && (
          <button type="button" aria-label="Open DevTools in new window"
            onClick={() => {
              window.open(devtoolsUrl, `orq-devtools-${browser.id}`);
              setDevtoolsOpen(false);
            }}
            className="rounded p-1 text-neutral-400 hover:bg-neutral-800">
            <ExternalLink size={14} />
          </button>
        )}
```

- [ ] **Step 4: The dock/fullscreen layout**

Define the iframe once, right before the `return` statement:

```tsx
  // Keyed on status so a relaunched tab remounts the frontend (it does not
  // auto-reconnect its CDP socket). devtoolsEndpoint launches the page lazily,
  // so rendering before the first state message is fine.
  const devtoolsFrame =
    state && state.status !== "running" && state.status !== "starting" ? (
      <div className="flex h-full items-center justify-center px-4 text-center text-sm text-neutral-500">
        DevTools unavailable — the browser is not running
      </div>
    ) : (
      <iframe
        key={`${browser.id}:${state?.status ?? "init"}`}
        src={devtoolsUrl ?? undefined}
        title="DevTools"
        className="h-full w-full border-0 bg-neutral-950"
      />
    );
```

Wrap the existing viewport `<div ref={wrapRef} …>` in a flex row and append the dock. The full JSX below replaces everything from `<div ref={wrapRef}` to the component's closing `</div>` pair (the existing wrap contents — placeholder branches, canvas, hidden input, PickComposeSheet — are unchanged inside it; only the wrap's `className` gains the conditional `hidden`):

```tsx
      <div ref={rowRef} className="flex min-h-0 flex-1">
        <div ref={wrapRef}
          className={cn("relative min-h-0 min-w-0 flex-1 touch-none overflow-hidden", devtoolsFullscreen && "hidden")}
          onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd}>
          {/* …existing children exactly as before… */}
        </div>
        {devtoolsOpen && isDesktop && devtoolsUrl && (
          <>
            <ResizeHandle
              orientation="vertical"
              aria-label="Resize DevTools"
              getCurrent={() => {
                const w = rowRef.current?.getBoundingClientRect().width ?? 0;
                return w * (1 - devtoolsSplit); // the divider drags the viewport (left) width
              }}
              clamp={(next) => {
                const w = rowRef.current?.getBoundingClientRect().width ?? 0;
                if (!w) return next;
                return Math.min(Math.max(next, w * (1 - DEVTOOLS_SPLIT_MAX)), w * (1 - DEVTOOLS_SPLIT_MIN));
              }}
              onResize={(next) => {
                const w = rowRef.current?.getBoundingClientRect().width ?? 0;
                if (w) setDevtoolsSplit(clampDevtoolsSplit(1 - next / w));
              }}
              onCommit={(next) => {
                const w = rowRef.current?.getBoundingClientRect().width ?? 0;
                if (!w) return;
                const fraction = clampDevtoolsSplit(1 - next / w);
                setDevtoolsSplit(fraction);
                persistDevtoolsSplit(fraction);
              }}
              onReset={() => {
                setDevtoolsSplit(DEVTOOLS_SPLIT_DEFAULT);
                persistDevtoolsSplit(DEVTOOLS_SPLIT_DEFAULT);
              }}
            />
            <div className="min-h-0 shrink-0" style={{ width: `${devtoolsSplit * 100}%` }}>
              {devtoolsFrame}
            </div>
          </>
        )}
        {devtoolsFullscreen && <div className="min-h-0 min-w-0 flex-1">{devtoolsFrame}</div>}
      </div>
```

Note: `setPointerCapture` in `useResizeDrag` already keeps the drag alive over the iframe (same reason it survives xterm regions — see the hook's doc comment). The hidden wrap (not unmounted) keeps `hiddenInputRef`/`canvasRef` stable across mobile swaps.

- [ ] **Step 5: Typecheck**

Run: `pnpm check` — expected clean.

- [ ] **Step 6: Commit**

```bash
git add packages/ui/src/components/browser/BrowserView.tsx
git commit -m "feat(ui): DevTools dock, pop-out window, and mobile fullscreen swap in browser tabs"
```

---

### Task 6: Deploy config — Caddyfile CSP island + AGENTS.md notes

**Files:**
- Modify: `deploy/Caddyfile`
- Modify: `AGENTS.md` (browser-tabs feature line in "What Orquester is"; security-posture paragraph)

**Interfaces:** none (config/docs). Without the Caddyfile change the production iframe is blocked by `X-Frame-Options: DENY` and the DevTools bundle by the SPA CSP; local dev (no Caddy) works regardless.

- [ ] **Step 1: Split the header block by path matcher**

Replace the entire `deploy/Caddyfile` with:

```
# Replace the hostname with your real (sub)domain, or a sslip.io host that
# resolves to the VPS IP, e.g. 203-0-113-10.sslip.io
orquester.example.com {
    reverse_proxy 127.0.0.1:47831       # WebSocket upgrade handled automatically
    encode zstd gzip

    # The embedded Chrome DevTools frontend (proxied from the project's headless
    # Chromium under /devtools-frontend/) is its own CSP island: the SPA's strict
    # CSP + X-Frame-Options DENY would block both the bundle (workers, wasm,
    # inline handling) and the same-origin iframe that embeds it. frame-ancestors
    # 'self' still restricts WHO may frame it to the app itself.
    @devtools path /devtools-frontend/*
    header @devtools {
        Strict-Transport-Security "max-age=31536000; includeSubDomains"
        X-Content-Type-Options "nosniff"
        Referrer-Policy "no-referrer"
        Content-Security-Policy "frame-ancestors 'self'"
        -Server
    }

    @app not path /devtools-frontend/*
    header @app {
        Strict-Transport-Security "max-age=31536000; includeSubDomains"
        X-Content-Type-Options "nosniff"
        X-Frame-Options "DENY"
        Referrer-Policy "no-referrer"
        Permissions-Policy "camera=(), microphone=(), geolocation=(), interest-cohort=()"
        # Tune CSP to the SPA: xterm/codemirror use inline styles; WS needs wss:;
        # the file-preview viewers load images/audio/video as blob: object URLs and
        # pdf.js spins up a worker (which can be a blob:), so img/media/worker-src
        # must allow blob:. The HTML preview renders from a blob: iframe and the
        # DevTools panel from a same-origin iframe, so frame-src allows 'self' blob:
        # (frame-ancestors 'none' still forbids the app itself from being framed).
        Content-Security-Policy "default-src 'self'; connect-src 'self' wss:; img-src 'self' data: blob: https://avatars.githubusercontent.com; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; worker-src 'self' blob:; manifest-src 'self'; frame-src 'self' blob:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
        -Server
    }
}
```

- [ ] **Step 2: Update AGENTS.md**

In the "What Orquester is" features paragraph, extend the browser-tabs sentence: after "with an element picker that delivers HTML/CSS/screenshot payloads into agent PTYs", append ", and embedded Chrome DevTools (the browser's own version-matched frontend proxied by the daemon — right-dock split, pop-out window, full-screen on mobile)".

In "Conventions & gotchas", append a bullet:

```markdown
- **Browser-tab Chromium exposes a loopback debug port.** The per-project headless
  Chromium launches with `--remote-debugging-port=0` (not the stdio pipe) so the
  embedded DevTools can attach; the daemon proxies its frontend at
  `/devtools-frontend/:browserId/*` (unauthenticated, generic Chrome assets) and
  its CDP WS at `/ws-devtools/:browserId` (`?token=` auth). The port is
  unauthenticated **on-host** — same trust level as the scoped-sudo terminal
  sessions on this single-user box. Deploys need the Caddyfile's `/devtools-frontend/*`
  header carve-out or the iframe is blocked by `X-Frame-Options: DENY`.
```

- [ ] **Step 3: Typecheck (unchanged code, cheap sanity) + commit**

Run: `pnpm check` — expected clean.

```bash
git add deploy/Caddyfile AGENTS.md
git commit -m "docs(deploy): CSP carve-out and notes for embedded DevTools"
```

---

### Task 7: Final verification + hand-off checklist

**Files:** none (verification only).

- [ ] **Step 1: Full gates**

Run: `pnpm check` — expected clean across all packages.
Run: `pnpm --filter @orquester/daemon test` — expected all suites PASS.
Run: `git status` — expected clean tree, all work committed.

- [ ] **Step 2: Record the manual verification checklist (deploy-time; NOT in this checkout)**

This checkout runs inside a live Orquester — do not start a daemon here. On the next deploy (per `DEPLOY_TO_VPS.md`, including `sudo systemctl restart orquester` and the Caddyfile install + `systemctl reload caddy`), verify:

1. Open a project browser tab → toggle DevTools (Braces icon) → the dock opens and the frontend loads (no blank iframe, no CSP errors in the *client* browser's console).
2. Console: `console.log` from the inspected page appears; evaluating an expression works.
3. Elements: DOM tree renders; hovering highlights elements in the streamed viewport.
4. Network: reload the page from the tab toolbar; requests appear with bodies.
5. Sources: set a breakpoint in a page script; it pauses and steps.
6. Drag the divider (width persists across a page reload; double-click resets), pop out to a window, close/reopen the tab (iframe remounts and reconnects).
7. Mobile viewport (or a phone): the toggle swaps to full-screen DevTools and back; the screencast resumes on switch-back.
8. Regression: element picker, viewport toggle, keyboard/paste input, and tab close (Chromium exits with the last tab) still work — the launch changed from pipe to port.
9. `node scripts/smoke-web.mjs https://<domain>` passes.

Known accepted quirks (from the spec — do not "fix" in this plan): DevTools' device toolbar fights our viewport emulation; the pop-out URL carries `?token=` into that device's history.

- [ ] **Step 3: Report**

Summarize to the user: what shipped, the deploy prerequisite (Caddyfile + restart), and the manual checklist above.
