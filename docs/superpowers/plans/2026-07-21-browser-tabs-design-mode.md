# Browser Tabs + Design Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Server-side per-project headless Chromium streamed as interactive browser tabs (CDP screencast over a new binary `/ws-browser` channel), with a Design Mode element picker that delivers HTML/CSS/screenshot payloads into agent PTYs.

**Architecture:** A new daemon `BrowserManager` (sibling of the session manager — never touch `sessions.ts`'s tmux invariants) owns one headless Chromium per project, launched via `puppeteer-core` against the host chromium binary and driven over raw CDP. Pixels flow as JPEG binary frames over a new multiplexed `/ws-browser` WebSocket; input, navigation, viewport and picker control flow back as JSON. The picker is an injected in-page script (ported from Orca's design) whose payload is server-side re-sanitized, then composed client-side into a Markdown block delivered through the *existing* session upload + bracketed-paste input routes.

**Tech Stack:** TypeScript 5.8 ESM, Fastify 4 + @fastify/websocket, puppeteer-core (new, daemon-only), zod (config only), React 18 + zustand (UI), canvas rendering.

**Spec:** `docs/superpowers/specs/2026-07-21-browser-tab-design-mode-design.md`

## Global Constraints

- **NEVER launch/restart/stop the daemon in this checkout** — a live daemon is serving this workspace. Verification = `pnpm check` + standalone smoke scripts that never bind `127.0.0.1:47831`/`daemon.sock`. Final end-to-end verification happens against a **separate checkout** (Task 13).
- **No test runner exists.** The gate for every task is `pnpm check` (repo-wide `tsc --noEmit`) plus the smoke scripts included below. Do not add vitest/jest.
- ESM everywhere; strict TS; packages import each other's TS source directly (no build step for the daemon).
- Commit to the **current branch** (`main`) as-is; stage files by name; HEREDOC commit messages ending with `Co-Authored-By: Claude <noreply@anthropic.com>`.
- zod schemas live **only** in `@orquester/config`. Wire types live **only** in `@orquester/api` (pure TS, no zod).
- Constants locked by the spec: desktop viewport `1280×800 dsf 1`, mobile `390×844 dsf 2 + touch`, JPEG quality `60`, htmlSnippet cap `4096` chars, screenshot cap `2 MB`, suggestions cap `8/project`, binary frame = `[u8 type=1][36-byte tabId][JPEG]`, send-skip high-water mark `1.5 MB` of `bufferedAmount`.
- Smoke scripts go in the scratchpad dir, NOT the repo. Scratchpad: `/var/lib/orquester/tmp/claude-999/-var-lib-orquester-workspaces-jaspersito-orquester/2d90eb2a-8018-4186-8c93-583ed0fb8c74/scratchpad` (referred to as `$SCRATCH` below).

## File Structure

```
packages/api/src/index.ts                 MODIFY  browser wire types + WS message types
packages/config/src/index.ts              MODIFY  browsers.json schema + path helpers
apps/daemon/package.json                  MODIFY  + puppeteer-core
apps/daemon/src/browser-pick.ts           CREATE  picker script string + payload clamp (pure, no I/O)
apps/daemon/src/browsers.ts               CREATE  BrowserManager (chromium lifecycle, screencast, input, pick)
apps/daemon/src/url-watcher.ts            CREATE  dev-server URL detection from PTY output (pure)
apps/daemon/src/sessions.ts               MODIFY  emit lifecycle "output" events (2 lines × 2 backends)
apps/daemon/src/index.ts                  MODIFY  boot wiring, /api/browsers routes, /ws-browser handler
packages/ui/src/lib/transporters/ws-browser-channel.ts  CREATE  BrowserChannel (binary WS client)
packages/ui/src/lib/transporter.ts        MODIFY  optional browserChannel() on Transporter
packages/ui/src/lib/transporters/http-transporter.ts    MODIFY  implement browserChannel()
packages/ui/src/lib/api-client.ts         MODIFY  browser CRUD + channel accessor
packages/ui/src/lib/design-feedback.ts    CREATE  Markdown formatter (Orca port)
packages/ui/src/store/app.ts              MODIFY  browsers state, events, tabs, actions
packages/ui/src/components/browser/BrowserView.tsx      CREATE  canvas + toolbar + input
packages/ui/src/components/browser/PickComposeSheet.tsx CREATE  pick → agent compose UI
packages/ui/src/components/browser/index.ts             CREATE  barrel
packages/ui/src/components/main/MainView.tsx            MODIFY  render branch + icon
packages/ui/src/components/topbar/NewTabMenu.tsx        MODIFY  "Browser" entry (registry-gated)
AGENTS.md / deploy/README.md              MODIFY  docs + chromium provisioning note
```

**Known spec deviation (flag at review):** the spec says browser-tab `order` interleaves with session tabs via the existing reorder flow; `/api/sessions/reorder` is sessions-only, so v1 renders browser tabs **after** session tabs, ordered among themselves. Cross-kind drag-reorder is deferred.

---

### Task 1: Wire types (`@orquester/api`) + config schema/paths (`@orquester/config`)

**Files:**
- Modify: `packages/api/src/index.ts` (append after the session types, around line 810)
- Modify: `packages/config/src/index.ts` (next to `sessionsIndexPath` / the session record schema)

**Interfaces:**
- Produces (used by every later task): `BrowserSummary`, `BrowserViewportMode`, `BrowserStatus`, `CreateBrowserRequest`, `BrowserSuggestionsResponse`, `BrowserPickPayload`, `BrowserPickTarget`, `BrowserStateMessage`, `BrowserServerJsonMessage`, `BrowserClientMessage`, `BROWSER_FRAME_TYPE_JPEG`; config: `browserRecordSchema`, `parseBrowsersFile`, `createDefaultBrowsersFile`, `browsersIndexPath(baseDir)`, `browserProfilesDir(baseDir)`, `BrowserRecord`, `BrowsersFile`.

- [ ] **Step 1: Add the API types**

Append to `packages/api/src/index.ts` after `SessionInputMessage` (~line 799):

```ts
// Browsers — a server-side headless Chromium tab owned by the daemon (one
// Chromium PROCESS per project, one CDP page per tab). Streamed over /ws-browser.

export type BrowserViewportMode = "desktop" | "mobile";

export type BrowserStatus = "stopped" | "starting" | "running" | "crashed" | "error";

export interface BrowserSummary {
  id: string;
  projectPath: string;
  /** Last known URL (persisted; re-navigated to on relaunch). */
  url: string;
  /** Last known page title ("" until first load). */
  title: string;
  viewportMode: BrowserViewportMode;
  /** Per-project tab sort key (ascending); assigned by the daemon. */
  order: number;
  createdAt: string;
  status: BrowserStatus;
  /** False when Chromium had to be launched with --no-sandbox (UI shows a warning). */
  sandboxed: boolean;
  /** Launch/runtime error tail when status === "error". */
  errorMessage?: string;
}

export interface CreateBrowserRequest {
  projectPath: string;
  /** Initial URL; defaults to "about:blank". */
  url?: string;
}

export interface BrowserSuggestionsResponse {
  /** Detected dev-server origins for the project, most recent first (≤ 8). */
  urls: string[];
}

// Design Mode pick payload. Extracted in-page, then RE-CLAMPED server-side
// (see apps/daemon/src/browser-pick.ts) — page output is hostile.

export interface BrowserPickTarget {
  tagName: string;
  /** Verified-unique CSS selector (bottom-up, :nth-of-type disambiguated). */
  selector: string;
  /** Human-readable ancestor path, e.g. "div#app > main > button.save". */
  elementPath: string;
  cssClasses: string[];
  /** Allow-listed attributes only. */
  attributes: Record<string, string>;
  /** ~16-property getComputedStyle subset. */
  computedStyles: Record<string, string>;
  rectViewport: { x: number; y: number; width: number; height: number };
  accessibility: { role: string; name: string };
  /** React _debugSource, when the dev build provides it: "file:line:col". */
  reactSource?: string;
  reactComponents?: string[];
  textSnippet: string;
  /** outerHTML, scripts stripped, ≤ 4096 chars. */
  htmlSnippet: string;
}

export interface BrowserPickPayload {
  page: {
    /** Origin + path only (query/hash stripped). */
    url: string;
    title: string;
    viewport: { width: number; height: number };
    viewportMode: BrowserViewportMode;
  };
  target: BrowserPickTarget;
  /** Cropped PNG (element rect + 8px pad), base64, ≤ 2 MB; omitted on overflow. */
  screenshotBase64?: string;
}

// /ws-browser wire protocol. Server→client pixels are BINARY frames:
// [u8 type=BROWSER_FRAME_TYPE_JPEG][36-byte tab id (uuid ascii)][JPEG bytes].
// Everything else is JSON text.

export const BROWSER_FRAME_TYPE_JPEG = 1;

export interface BrowserStateMessage {
  t: "state";
  id: string;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  viewportMode: BrowserViewportMode;
  status: BrowserStatus;
  sandboxed: boolean;
}

export type BrowserServerJsonMessage =
  | BrowserStateMessage
  | { t: "picked"; id: string; payload: BrowserPickPayload }
  | { t: "end"; id: string }
  | { t: "pong" };

export type BrowserClientMessage =
  | { t: "sub"; id: string }
  | { t: "unsub"; id: string }
  | {
      t: "pointer";
      id: string;
      kind: "move" | "down" | "up";
      x: number;
      y: number;
      button: "none" | "left" | "middle" | "right";
      modifiers: number;
      clickCount: number;
    }
  | { t: "wheel"; id: string; x: number; y: number; dx: number; dy: number }
  | {
      t: "key";
      id: string;
      kind: "down" | "up" | "char";
      key: string;
      code: string;
      text?: string;
      modifiers: number;
    }
  | {
      t: "touch";
      id: string;
      kind: "start" | "move" | "end";
      points: Array<{ x: number; y: number }>;
    }
  | { t: "nav"; id: string; action: "goto" | "back" | "forward" | "reload"; url?: string }
  | { t: "viewport"; id: string; mode: BrowserViewportMode }
  | { t: "pick"; id: string; on: boolean }
  | { t: "ping" };
```

- [ ] **Step 2: Add config schema + path helpers**

In `packages/config/src/index.ts`, find `sessionsIndexPath` (grep for it) and add beside it:

```ts
export function browsersIndexPath(baseDir: string): string {
  return join(daemonConfigDir(baseDir), "browsers.json");
}

export function browserProfilesDir(baseDir: string): string {
  return join(daemonConfigDir(baseDir), "browser-profiles");
}
```

Find `sessionRecordSchema` (grep) and add beside it, mirroring its style:

```ts
/** One persisted browser tab. The Chromium PROCESS does not survive a daemon
 *  restart (it is a daemon child, unlike tmux) — only the tab record does;
 *  first subscribe after boot relaunches and re-navigates. */
export const browserRecordSchema = z.object({
  id: z.string().min(1),
  projectPath: z.string(),
  url: z.string(),
  title: z.string().default(""),
  viewportMode: z.enum(["desktop", "mobile"]).default("desktop"),
  order: z.number(),
  createdAt: z.string()
});

export const browsersFileSchema = z.object({
  version: z.literal(1),
  browsers: z.array(browserRecordSchema).default([])
});

export type BrowserRecord = z.infer<typeof browserRecordSchema>;
export type BrowsersFile = z.infer<typeof browsersFileSchema>;

export function parseBrowsersFile(value: unknown): BrowsersFile {
  return browsersFileSchema.parse(value);
}

export function createDefaultBrowsersFile(): BrowsersFile {
  return { version: 1, browsers: [] };
}
```

- [ ] **Step 3: Typecheck**

Run: `pnpm check`
Expected: clean (types are additive; nothing consumes them yet).

- [ ] **Step 4: Commit**

```bash
git add packages/api/src/index.ts packages/config/src/index.ts
git commit -m "$(cat <<'EOF'
Add browser-tab wire types and browsers.json schema

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Daemon `browser-pick.ts` — picker script + payload clamp

**Files:**
- Create: `apps/daemon/src/browser-pick.ts`
- Smoke test: `$SCRATCH/smoke-clamp.ts` (NOT committed)

**Interfaces:**
- Consumes: `BrowserPickPayload`, `BrowserPickTarget` from `@orquester/api`.
- Produces: `PICKER_SCRIPT: string` (in-page IIFE; reports via `window.__orquesterPick(json)` CDP binding), `armPickerExpression(on: boolean): string`, `clampBrowserPickPayload(raw: unknown): BrowserPickPayload | null` (returns null on structurally invalid input). Used by Task 3.

- [ ] **Step 1: Write the module**

Create `apps/daemon/src/browser-pick.ts`:

```ts
import type { BrowserPickPayload, BrowserPickTarget } from "@orquester/api";

// Hard budgets — the page is hostile; everything it reports gets re-clamped
// here regardless of what the in-page script promised. (Pattern from Orca's
// clampGrabPayload: guest-side budget + independent daemon-side re-validation.)
export const HTML_SNIPPET_MAX = 4096;
export const TEXT_SNIPPET_MAX = 400;
export const SELECTOR_MAX = 512;
export const ELEMENT_PATH_MAX = 512;
export const ATTR_VALUE_MAX = 256;
export const MAX_CLASSES = 24;
export const MAX_REACT_COMPONENTS = 8;
export const SCREENSHOT_MAX_BYTES = 2 * 1024 * 1024;

const ATTR_ALLOW = new Set([
  "id", "class", "name", "type", "role", "href", "src", "alt",
  "title", "placeholder", "for", "action", "method"
]);

const SECRET_RE =
  /(access_token|api[_-]?key|authorization|cookie|csrf|password|secret|bearer|session[_-]?id)[=:][^&\s"']*/gi;

const STYLE_PROPS = [
  "display", "position", "width", "height", "margin", "padding", "color",
  "background-color", "border", "border-radius", "font-family", "font-size",
  "font-weight", "line-height", "text-align", "z-index"
] as const;

function str(v: unknown, max: number): string {
  return typeof v === "string" ? v.slice(0, max).replace(SECRET_RE, "$1=<redacted>") : "";
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.round(v) : 0;
}

function stripUrl(v: unknown): string {
  if (typeof v !== "string") return "";
  try {
    const u = new URL(v);
    return `${u.origin}${u.pathname}`;
  } catch {
    return "";
  }
}

/**
 * Re-validate a raw payload reported by the in-page picker script. Returns a
 * fresh object built field-by-field (never the input), or null when the shape
 * is not salvageable. Screenshot is attached later by the manager (it comes
 * from CDP, not from the page).
 */
export function clampBrowserPickPayload(raw: unknown): BrowserPickPayload | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, any>;
  const page = r.page, target = r.target;
  if (typeof page !== "object" || page === null) return null;
  if (typeof target !== "object" || target === null) return null;
  if (typeof target.selector !== "string" || typeof target.tagName !== "string") return null;

  const attributes: Record<string, string> = {};
  if (typeof target.attributes === "object" && target.attributes !== null) {
    for (const [k, v] of Object.entries(target.attributes as Record<string, unknown>)) {
      const key = k.toLowerCase();
      if (ATTR_ALLOW.has(key) || key.startsWith("aria-")) {
        attributes[key] = str(v, ATTR_VALUE_MAX);
      }
    }
  }

  const computedStyles: Record<string, string> = {};
  if (typeof target.computedStyles === "object" && target.computedStyles !== null) {
    for (const prop of STYLE_PROPS) {
      const v = (target.computedStyles as Record<string, unknown>)[prop];
      if (typeof v === "string") computedStyles[prop] = v.slice(0, 128);
    }
  }

  const rect = target.rectViewport ?? {};
  const clamped: BrowserPickTarget = {
    tagName: str(target.tagName, 64).toLowerCase(),
    selector: str(target.selector, SELECTOR_MAX),
    elementPath: str(target.elementPath, ELEMENT_PATH_MAX),
    cssClasses: Array.isArray(target.cssClasses)
      ? target.cssClasses.slice(0, MAX_CLASSES).map((c: unknown) => str(c, 96))
      : [],
    attributes,
    computedStyles,
    rectViewport: { x: num(rect.x), y: num(rect.y), width: num(rect.width), height: num(rect.height) },
    accessibility: {
      role: str(target.accessibility?.role, 64),
      name: str(target.accessibility?.name, 200)
    },
    textSnippet: str(target.textSnippet, TEXT_SNIPPET_MAX),
    htmlSnippet: str(target.htmlSnippet, HTML_SNIPPET_MAX)
  };
  if (typeof target.reactSource === "string" && target.reactSource) {
    clamped.reactSource = str(target.reactSource, 300);
  }
  if (Array.isArray(target.reactComponents) && target.reactComponents.length > 0) {
    clamped.reactComponents = target.reactComponents
      .slice(0, MAX_REACT_COMPONENTS)
      .map((c: unknown) => str(c, 96));
  }

  return {
    page: {
      url: stripUrl(page.url),
      title: str(page.title, 200),
      viewport: { width: num(page.viewport?.width), height: num(page.viewport?.height) },
      viewportMode: page.viewportMode === "mobile" ? "mobile" : "desktop"
    },
    target: clamped
  };
}

/** Expression evaluated to arm/disarm the picker after PICKER_SCRIPT is installed. */
export function armPickerExpression(on: boolean): string {
  return `window.__orqPicker && window.__orqPicker.${on ? "arm" : "disarm"}()`;
}

/**
 * In-page picker (Orca "grab" design, remoted): a shadow-DOM overlay
 * click-catcher; elementFromPoint hit-testing; on click, extract a budgeted
 * payload and report it through the CDP binding window.__orquesterPick.
 * Idempotent: installing twice is a no-op. Runs in the page's main world.
 */
export const PICKER_SCRIPT = String.raw`
(() => {
  if (window.__orqPicker) return;
  const MAXH = ${HTML_SNIPPET_MAX}, MAXT = ${TEXT_SNIPPET_MAX};
  let host = null, box = null, label = null, current = null, armed = false;

  function ensureOverlay() {
    if (host) return;
    host = document.createElement("div");
    host.style.cssText = "position:fixed;inset:0;z-index:2147483647;cursor:crosshair;";
    const root = host.attachShadow({ mode: "open" });
    box = document.createElement("div");
    box.style.cssText = "position:fixed;pointer-events:none;border:2px solid #38bdf8;background:rgba(56,189,248,.15);";
    label = document.createElement("div");
    label.style.cssText = "position:fixed;pointer-events:none;background:#0c4a6e;color:#e0f2fe;font:11px monospace;padding:2px 6px;border-radius:3px;max-width:60vw;overflow:hidden;white-space:nowrap;";
    root.append(box, label);
    host.addEventListener("mousemove", onMove, true);
    host.addEventListener("click", onClick, true);
    host.addEventListener("contextmenu", (e) => { e.preventDefault(); disarm(); }, true);
  }

  function under(x, y) {
    host.style.pointerEvents = "none";
    const el = document.elementFromPoint(x, y);
    host.style.pointerEvents = "all";
    return el && el !== document.documentElement && el !== document.body ? el : null;
  }

  function onMove(e) {
    current = under(e.clientX, e.clientY);
    if (!current) { box.style.display = label.style.display = "none"; return; }
    const r = current.getBoundingClientRect();
    box.style.display = "block";
    box.style.left = r.left + "px"; box.style.top = r.top + "px";
    box.style.width = r.width + "px"; box.style.height = r.height + "px";
    label.style.display = "block";
    label.style.left = r.left + "px";
    label.style.top = (r.top > 24 ? r.top - 22 : r.bottom + 4) + "px";
    label.textContent = current.tagName.toLowerCase()
      + (current.id ? "#" + current.id : "")
      + " " + Math.round(r.width) + "×" + Math.round(r.height);
  }

  function cssPath(el) {
    // Bottom-up unique selector: prefer #id; else tag:nth-of-type, verified unique.
    if (el.id) return "#" + CSS.escape(el.id);
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.body) {
      let part = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
        if (same.length > 1) part += ":nth-of-type(" + (same.indexOf(node) + 1) + ")";
      }
      parts.unshift(part);
      const sel = parts.join(" > ");
      try { if (document.querySelectorAll(sel).length === 1) return sel; } catch {}
      node = parent;
    }
    return parts.join(" > ");
  }

  function readable(el) {
    const parts = [];
    let node = el;
    for (let i = 0; node && node.nodeType === 1 && i < 8; i++, node = node.parentElement) {
      parts.unshift(node.tagName.toLowerCase()
        + (node.id ? "#" + node.id : "")
        + (node.classList.length ? "." + node.classList[0] : ""));
    }
    return parts.join(" > ");
  }

  function react(el) {
    // Walk React fiber for component names + _debugSource (dev builds only).
    const key = Object.keys(el).find((k) => k.startsWith("__reactFiber$"));
    if (!key) return {};
    const names = []; let source;
    let fiber = el[key];
    for (let i = 0; fiber && i < 30; i++, fiber = fiber.return) {
      const t = fiber.type;
      const name = typeof t === "function" ? (t.displayName || t.name) : null;
      if (name && names.length < 8 && names[names.length - 1] !== name) names.push(name);
      const d = fiber._debugSource;
      if (!source && d && d.fileName) source = d.fileName + ":" + d.lineNumber + ":" + (d.columnNumber ?? 0);
    }
    return { reactSource: source, reactComponents: names.length ? names : undefined };
  }

  function extract(el) {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const styles = {};
    for (const p of ["display","position","width","height","margin","padding","color",
                     "background-color","border","border-radius","font-family","font-size",
                     "font-weight","line-height","text-align","z-index"]) {
      styles[p] = cs.getPropertyValue(p);
    }
    const attrs = {};
    for (const a of el.attributes) attrs[a.name] = a.value;
    const clone = el.cloneNode(true);
    clone.querySelectorAll && clone.querySelectorAll("script,style").forEach((n) => n.remove());
    const rx = react(el);
    return {
      page: {
        url: location.href, title: document.title,
        viewport: { width: innerWidth, height: innerHeight }
      },
      target: {
        tagName: el.tagName, selector: cssPath(el), elementPath: readable(el),
        cssClasses: Array.from(el.classList).slice(0, 24),
        attributes: attrs, computedStyles: styles,
        rectViewport: { x: r.left, y: r.top, width: r.width, height: r.height },
        accessibility: {
          role: el.getAttribute("role") || "",
          name: el.getAttribute("aria-label") || el.getAttribute("alt") || el.getAttribute("title") || ""
        },
        textSnippet: (el.innerText || "").slice(0, MAXT),
        htmlSnippet: (clone.outerHTML || "").slice(0, MAXH),
        ...rx
      }
    };
  }

  function onClick(e) {
    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
    if (!current) return;
    let payload;
    try { payload = extract(current); } catch (err) { payload = { error: String(err) }; }
    disarm();
    try { window.__orquesterPick(JSON.stringify(payload)); } catch {}
  }

  function arm() {
    if (armed) return; armed = true;
    ensureOverlay();
    document.documentElement.appendChild(host);
  }
  function disarm() {
    armed = false; current = null;
    if (host && host.parentNode) host.parentNode.removeChild(host);
    if (box) box.style.display = "none";
    if (label) label.style.display = "none";
  }
  window.__orqPicker = { arm, disarm };
})();
`;
```

- [ ] **Step 2: Smoke-test the clamp (hostile inputs)**

Write `$SCRATCH/smoke-clamp.ts`:

```ts
import assert from "node:assert";
import { clampBrowserPickPayload, HTML_SNIPPET_MAX } from "../../workspaces/jaspersito/orquester/apps/daemon/src/browser-pick.js";

// 1. Valid minimal payload survives.
const ok = clampBrowserPickPayload({
  page: { url: "http://localhost:5173/app?access_token=SHHH#x", title: "T", viewport: { width: 1280, height: 800 } },
  target: { tagName: "BUTTON", selector: "#save", elementPath: "div > button", cssClasses: ["btn"],
    attributes: { id: "save", onclick: "evil()", "aria-label": "Save" },
    computedStyles: { color: "red", "--evil": "x" },
    rectViewport: { x: 1.4, y: 2, width: 80, height: 24 },
    accessibility: { role: "button", name: "Save" },
    textSnippet: "Save", htmlSnippet: "<button>Save</button>" }
});
assert(ok, "valid payload rejected");
assert.equal(ok!.page.url, "http://localhost:5173/app", "query/hash not stripped");
assert.equal(ok!.target.attributes.onclick, undefined, "onclick not filtered");
assert.equal(ok!.target.attributes["aria-label"], "Save");
assert.equal(ok!.target.computedStyles["--evil"], undefined, "non-allow-listed style kept");

// 2. Oversized html clamped; secrets redacted.
const big = clampBrowserPickPayload({
  page: { url: "http://x.dev/", title: "", viewport: {} },
  target: { tagName: "div", selector: "div", htmlSnippet: "password=hunter2 " + "x".repeat(10_000) }
});
assert(big!.target.htmlSnippet.length <= HTML_SNIPPET_MAX, "html not clamped");
assert(!big!.target.htmlSnippet.includes("hunter2"), "secret not redacted");

// 3. Garbage → null, never a throw.
for (const junk of [null, 42, "x", {}, { page: {} }, { page: {}, target: {} }, { page: {}, target: { selector: 1, tagName: "a" } }]) {
  assert.equal(clampBrowserPickPayload(junk), null, `junk accepted: ${JSON.stringify(junk)}`);
}
console.log("clamp smoke: OK");
```

Run: `cd /var/lib/orquester/workspaces/jaspersito/orquester && node --import tsx $SCRATCH/smoke-clamp.ts`
Expected: `clamp smoke: OK` (fix import path if the relative hop differs — use an absolute path to `apps/daemon/src/browser-pick.ts`).

- [ ] **Step 3: `pnpm check`** — Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add apps/daemon/src/browser-pick.ts
git commit -m "$(cat <<'EOF'
Add Design Mode picker script and hostile-payload clamp

In-page overlay picker (ported from Orca's grab design: elementFromPoint
hit-testing, unique-selector build, React _debugSource extraction) plus an
independent server-side re-validator with budgets and secret redaction.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Daemon `BrowserManager`

**Files:**
- Modify: `apps/daemon/package.json` (add `"puppeteer-core": "^24.0.0"` to dependencies, then `pnpm install`)
- Create: `apps/daemon/src/browsers.ts`
- Smoke test: `$SCRATCH/smoke-browser-manager.ts` (NOT committed)

**Interfaces:**
- Consumes: `PICKER_SCRIPT`, `armPickerExpression`, `clampBrowserPickPayload`, `SCREENSHOT_MAX_BYTES` (Task 2); `BrowserSummary`, `BrowserStateMessage`, `BrowserViewportMode`, `BrowserPickPayload` (Task 1); `parseBrowsersFile`, `createDefaultBrowsersFile`, `BrowserRecord` (Task 1).
- Produces (used by Tasks 5–6):

```ts
export interface BrowserSink {
  onFrame(jpeg: Buffer): void;
  onState(state: BrowserStateMessage): void;
  onPicked(payload: BrowserPickPayload): void;
  onEnd(): void;
}
export class BrowserManager {
  lifecycle: EventEmitter; // "created" | "updated" | "closed" (BrowserSummary / {id})
  constructor(opts: { indexFile: string; profilesDir: string; resolveChromium: () => string | undefined });
  load(): Promise<void>;
  list(projectPath?: string): BrowserSummary[];
  get(id: string): BrowserSummary | undefined;
  create(projectPath: string, url?: string): Promise<BrowserSummary>;
  close(id: string): Promise<void>;
  closeForProject(projectPath: string): Promise<void>; // cascade on project delete
  subscribe(id: string, sink: BrowserSink): Promise<() => void>;
  navigate(id: string, action: "goto" | "back" | "forward" | "reload", url?: string): Promise<void>;
  setViewport(id: string, mode: BrowserViewportMode): Promise<void>;
  setPick(id: string, on: boolean): Promise<void>;
  dispatchPointer(id, kind, x, y, button, modifiers, clickCount): void;
  dispatchWheel(id, x, y, dx, dy): void;
  dispatchKey(id, kind, key, code, text, modifiers): void;
  dispatchTouch(id, kind, points): void;
  shutdown(): Promise<void>;
}
export class BrowserError extends Error { statusCode: number }
```

- [ ] **Step 1: Add the dependency**

In `apps/daemon/package.json` dependencies add `"puppeteer-core": "^24.0.0"`, then run `pnpm install` from the repo root. puppeteer-core downloads **no** browser — it drives the host binary only.

- [ ] **Step 2: Write `apps/daemon/src/browsers.ts`**

```ts
import { EventEmitter } from "node:events";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join, dirname } from "node:path";
import puppeteer, { type Browser, type CDPSession, type Page } from "puppeteer-core";
import {
  type BrowserPickPayload,
  type BrowserStateMessage,
  type BrowserStatus,
  type BrowserSummary,
  type BrowserViewportMode
} from "@orquester/api";
import { type BrowserRecord, createDefaultBrowsersFile, parseBrowsersFile } from "@orquester/config";
import {
  PICKER_SCRIPT,
  SCREENSHOT_MAX_BYTES,
  armPickerExpression,
  clampBrowserPickPayload
} from "./browser-pick.js";

export class BrowserError extends Error {
  constructor(message: string, public statusCode = 400) {
    super(message);
  }
}

export interface BrowserSink {
  onFrame(jpeg: Buffer): void;
  onState(state: BrowserStateMessage): void;
  onPicked(payload: BrowserPickPayload): void;
  onEnd(): void;
}

const VIEWPORTS: Record<BrowserViewportMode, { width: number; height: number; deviceScaleFactor: number; mobile: boolean }> = {
  desktop: { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false },
  mobile: { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }
};

const MOBILE_UA =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36";

interface Tab {
  record: BrowserRecord;
  status: BrowserStatus;
  sandboxed: boolean;
  errorMessage?: string;
  page: Page | null;
  cdp: CDPSession | null;
  sinks: Set<BrowserSink>;
  streaming: boolean;
  picking: boolean;
  loading: boolean;
}

interface Chrome {
  browser: Browser;
  sandboxed: boolean;
}

export class BrowserManager {
  readonly lifecycle = new EventEmitter();
  private readonly tabs = new Map<string, Tab>();
  private readonly chromes = new Map<string, Promise<Chrome>>();

  constructor(
    private readonly opts: {
      indexFile: string;
      profilesDir: string;
      resolveChromium: () => string | undefined;
    }
  ) {}

  async load(): Promise<void> {
    let file = createDefaultBrowsersFile();
    try {
      file = parseBrowsersFile(JSON.parse(await readFile(this.opts.indexFile, "utf8")));
    } catch {
      /* first boot or unreadable — start empty; a corrupt file must not block boot */
    }
    for (const record of file.browsers) {
      this.tabs.set(record.id, {
        record, status: "stopped", sandboxed: true, page: null, cdp: null,
        sinks: new Set(), streaming: false, picking: false, loading: false
      });
    }
  }

  list(projectPath?: string): BrowserSummary[] {
    return [...this.tabs.values()]
      .filter((t) => !projectPath || t.record.projectPath === projectPath)
      .sort((a, b) => a.record.order - b.record.order || a.record.createdAt.localeCompare(b.record.createdAt))
      .map((t) => this.summary(t));
  }

  get(id: string): BrowserSummary | undefined {
    const tab = this.tabs.get(id);
    return tab ? this.summary(tab) : undefined;
  }

  async create(projectPath: string, url = "about:blank"): Promise<BrowserSummary> {
    if (!this.opts.resolveChromium()) {
      throw new BrowserError("No chromium/chrome binary found on the daemon host", 409);
    }
    const orders = this.list(projectPath).map((b) => b.order);
    const record: BrowserRecord = {
      id: randomUUID(), projectPath, url, title: "",
      viewportMode: "desktop", order: (orders.length ? Math.max(...orders) : 0) + 1,
      createdAt: new Date().toISOString()
    };
    const tab: Tab = {
      record, status: "stopped", sandboxed: true, page: null, cdp: null,
      sinks: new Set(), streaming: false, picking: false, loading: false
    };
    this.tabs.set(record.id, tab);
    await this.persist();
    this.lifecycle.emit("created", this.summary(tab));
    return this.summary(tab);
  }

  async close(id: string): Promise<void> {
    const tab = this.tabs.get(id);
    if (!tab) return;
    this.tabs.delete(id);
    for (const sink of tab.sinks) sink.onEnd();
    tab.sinks.clear();
    await tab.page?.close().catch(() => undefined);
    // Last tab of the project → kill its Chromium (the "no open browser tab →
    // no Chromium running" rule from the spec).
    const project = tab.record.projectPath;
    if (![...this.tabs.values()].some((t) => t.record.projectPath === project)) {
      const pending = this.chromes.get(project);
      this.chromes.delete(project);
      if (pending) (await pending.catch(() => null))?.browser.close().catch(() => undefined);
    }
    await this.persist();
    this.lifecycle.emit("closed", { id });
  }

  async closeForProject(projectPath: string): Promise<void> {
    for (const tab of [...this.tabs.values()]) {
      if (tab.record.projectPath === projectPath) await this.close(tab.record.id);
    }
  }

  async subscribe(id: string, sink: BrowserSink): Promise<() => void> {
    const tab = this.mustGet(id);
    tab.sinks.add(sink);
    try {
      await this.ensurePage(tab);
      await this.startScreencast(tab);
      sink.onState(this.state(tab));
      // Prime the canvas immediately — screencast only emits on change.
      const shot = await tab.cdp!.send("Page.captureScreenshot", { format: "jpeg", quality: 60 });
      sink.onFrame(Buffer.from(shot.data, "base64"));
    } catch (error) {
      tab.status = "error";
      tab.errorMessage = error instanceof Error ? error.message.slice(0, 500) : String(error);
      this.emitUpdated(tab);
      sink.onState(this.state(tab));
    }
    return () => {
      tab.sinks.delete(sink);
      if (tab.sinks.size === 0) void this.stopScreencast(tab);
    };
  }

  async navigate(id: string, action: "goto" | "back" | "forward" | "reload", url?: string): Promise<void> {
    const tab = this.mustGet(id);
    await this.ensurePage(tab);
    const page = tab.page!;
    try {
      if (action === "goto" && url) {
        const target = /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `http://${url}`;
        await page.goto(target, { waitUntil: "domcontentloaded", timeout: 30_000 });
      } else if (action === "back") await page.goBack({ waitUntil: "domcontentloaded", timeout: 30_000 });
      else if (action === "forward") await page.goForward({ waitUntil: "domcontentloaded", timeout: 30_000 });
      else if (action === "reload") await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });
    } catch {
      /* navigation errors render Chromium's own error page — streamed like anything */
    }
    await this.syncRecord(tab);
  }

  async setViewport(id: string, mode: BrowserViewportMode): Promise<void> {
    const tab = this.mustGet(id);
    tab.record.viewportMode = mode;
    if (tab.cdp) await this.applyViewport(tab);
    await this.persist();
    this.emitUpdated(tab);
    this.pushState(tab);
  }

  async setPick(id: string, on: boolean): Promise<void> {
    const tab = this.mustGet(id);
    await this.ensurePage(tab);
    tab.picking = on;
    await tab.cdp!.send("Runtime.evaluate", { expression: on ? PICKER_SCRIPT : "0" });
    await tab.cdp!.send("Runtime.evaluate", { expression: armPickerExpression(on) });
  }

  dispatchPointer(id: string, kind: "move" | "down" | "up", x: number, y: number,
    button: "none" | "left" | "middle" | "right", modifiers: number, clickCount: number): void {
    const cdp = this.tabs.get(id)?.cdp;
    if (!cdp) return;
    const type = kind === "move" ? "mouseMoved" : kind === "down" ? "mousePressed" : "mouseReleased";
    void cdp.send("Input.dispatchMouseEvent", { type, x, y, button, modifiers, clickCount }).catch(() => undefined);
  }

  dispatchWheel(id: string, x: number, y: number, dx: number, dy: number): void {
    const cdp = this.tabs.get(id)?.cdp;
    if (!cdp) return;
    void cdp.send("Input.dispatchMouseEvent", {
      type: "mouseWheel", x, y, button: "none", deltaX: dx, deltaY: dy
    }).catch(() => undefined);
  }

  dispatchKey(id: string, kind: "down" | "up" | "char", key: string, code: string,
    text: string | undefined, modifiers: number): void {
    const cdp = this.tabs.get(id)?.cdp;
    if (!cdp) return;
    const type = kind === "down" ? "keyDown" : kind === "up" ? "keyUp" : "char";
    void cdp.send("Input.dispatchKeyEvent", { type, key, code, text, modifiers }).catch(() => undefined);
  }

  dispatchTouch(id: string, kind: "start" | "move" | "end", points: Array<{ x: number; y: number }>): void {
    const cdp = this.tabs.get(id)?.cdp;
    if (!cdp) return;
    const type = kind === "start" ? "touchStart" : kind === "move" ? "touchMove" : "touchEnd";
    void cdp.send("Input.dispatchTouchEvent", {
      type, touchPoints: kind === "end" ? [] : points.map((p) => ({ x: p.x, y: p.y }))
    }).catch(() => undefined);
  }

  async shutdown(): Promise<void> {
    for (const tab of this.tabs.values()) {
      for (const sink of tab.sinks) sink.onEnd();
      tab.sinks.clear();
    }
    for (const pending of this.chromes.values()) {
      (await pending.catch(() => null))?.browser.close().catch(() => undefined);
    }
    this.chromes.clear();
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private mustGet(id: string): Tab {
    const tab = this.tabs.get(id);
    if (!tab) throw new BrowserError("Unknown browser tab", 404);
    return tab;
  }

  private summary(tab: Tab): BrowserSummary {
    return {
      ...tab.record,
      status: tab.status,
      sandboxed: tab.sandboxed,
      ...(tab.errorMessage ? { errorMessage: tab.errorMessage } : {})
    };
  }

  private state(tab: Tab): BrowserStateMessage {
    return {
      t: "state", id: tab.record.id, url: tab.record.url, title: tab.record.title,
      loading: tab.loading, canGoBack: false, canGoForward: false,
      viewportMode: tab.record.viewportMode, status: tab.status, sandboxed: tab.sandboxed
    };
  }

  private pushState(tab: Tab): void {
    const state = this.state(tab);
    for (const sink of tab.sinks) sink.onState(state);
  }

  private emitUpdated(tab: Tab): void {
    this.lifecycle.emit("updated", this.summary(tab));
  }

  private chromeFor(projectPath: string): Promise<Chrome> {
    let pending = this.chromes.get(projectPath);
    if (!pending) {
      pending = this.launch(projectPath);
      this.chromes.set(projectPath, pending);
      pending.catch(() => this.chromes.delete(projectPath));
    }
    return pending;
  }

  private async launch(projectPath: string): Promise<Chrome> {
    const executablePath = this.opts.resolveChromium();
    if (!executablePath) throw new BrowserError("No chromium/chrome binary found on the daemon host", 409);
    const hash = createHash("sha256").update(projectPath).digest("hex").slice(0, 16);
    const userDataDir = join(this.opts.profilesDir, hash);
    await mkdir(userDataDir, { recursive: true, mode: 0o700 });
    const base = {
      executablePath, userDataDir, pipe: true, headless: true as const,
      defaultViewport: null,
      args: ["--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-dev-shm-usage", "--mute-audio"]
    };
    try {
      return { browser: await puppeteer.launch(base), sandboxed: true };
    } catch (error) {
      // Sandbox unavailable (no userns / setuid helper) is the one retryable
      // launch failure — retry unsandboxed and FLAG it; never silently.
      const msg = error instanceof Error ? error.message : String(error);
      if (!/sandbox/i.test(msg)) throw error;
      const browser = await puppeteer.launch({ ...base, args: [...base.args, "--no-sandbox"] });
      return { browser, sandboxed: false };
    }
  }

  private async ensurePage(tab: Tab): Promise<void> {
    if (tab.page && !tab.page.isClosed()) return;
    tab.status = "starting";
    this.emitUpdated(tab);
    const chrome = await this.chromeFor(tab.record.projectPath);
    tab.sandboxed = chrome.sandboxed;
    const page = await chrome.browser.newPage();
    tab.page = page;
    tab.cdp = await page.createCDPSession();
    tab.streaming = false;
    await this.applyViewport(tab);
    await tab.cdp.send("Runtime.enable");
    await tab.cdp.send("Runtime.addBinding", { name: "__orquesterPick" });
    tab.cdp.on("Runtime.bindingCalled", (event) => {
      if (event.name === "__orquesterPick") void this.onPickReport(tab, event.payload);
    });
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) void this.syncRecord(tab);
    });
    page.on("load", () => { tab.loading = false; void this.syncRecord(tab); });
    page.on("close", () => {
      if (this.tabs.get(tab.record.id) !== tab) return; // our own close()
      tab.page = null; tab.cdp = null; tab.streaming = false;
      tab.status = "crashed";
      this.emitUpdated(tab);
      this.pushState(tab);
    });
    tab.status = "running";
    tab.errorMessage = undefined;
    if (tab.record.url && tab.record.url !== "about:blank") {
      tab.loading = true;
      void page.goto(tab.record.url, { waitUntil: "domcontentloaded", timeout: 30_000 })
        .catch(() => undefined)
        .finally(() => { tab.loading = false; void this.syncRecord(tab); });
    }
    this.emitUpdated(tab);
  }

  private async applyViewport(tab: Tab): Promise<void> {
    const vp = VIEWPORTS[tab.record.viewportMode];
    await tab.cdp!.send("Emulation.setDeviceMetricsOverride", vp);
    await tab.cdp!.send("Emulation.setTouchEmulationEnabled", { enabled: vp.mobile });
    await tab.cdp!.send("Emulation.setUserAgentOverride", vp.mobile ? { userAgent: MOBILE_UA } : { userAgent: "" });
  }

  private async startScreencast(tab: Tab): Promise<void> {
    if (tab.streaming || !tab.cdp) return;
    tab.streaming = true;
    const vp = VIEWPORTS[tab.record.viewportMode];
    tab.cdp.on("Page.screencastFrame", (frame) => {
      // ALWAYS ack (CDP stalls otherwise); per-socket send-skips happen in the
      // ws handler via bufferedAmount, not here.
      void tab.cdp?.send("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => undefined);
      const jpeg = Buffer.from(frame.data, "base64");
      for (const sink of tab.sinks) sink.onFrame(jpeg);
    });
    await tab.cdp.send("Page.startScreencast", {
      format: "jpeg", quality: 60, maxWidth: vp.width, maxHeight: vp.height, everyNthFrame: 1
    });
  }

  private async stopScreencast(tab: Tab): Promise<void> {
    if (!tab.streaming || !tab.cdp) return;
    tab.streaming = false;
    await tab.cdp.send("Page.stopScreencast").catch(() => undefined);
    tab.cdp.removeAllListeners("Page.screencastFrame");
  }

  private async onPickReport(tab: Tab, raw: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    const payload = clampBrowserPickPayload(parsed);
    if (!payload) return;
    payload.page.viewportMode = tab.record.viewportMode;
    tab.picking = false;
    try {
      const r = payload.target.rectViewport;
      if (r.width > 0 && r.height > 0 && tab.cdp) {
        const shot = await tab.cdp.send("Page.captureScreenshot", {
          format: "png",
          clip: {
            x: Math.max(0, r.x - 8), y: Math.max(0, r.y - 8),
            width: r.width + 16, height: r.height + 16, scale: 1
          }
        });
        if (Buffer.byteLength(shot.data, "base64") <= SCREENSHOT_MAX_BYTES) {
          payload.screenshotBase64 = shot.data;
        }
      }
    } catch {
      /* screenshot is best-effort; the payload ships without it */
    }
    for (const sink of tab.sinks) sink.onPicked(payload);
  }

  private async syncRecord(tab: Tab): Promise<void> {
    if (!tab.page || tab.page.isClosed()) return;
    const url = tab.page.url();
    const title = await tab.page.title().catch(() => tab.record.title);
    if (url !== tab.record.url || title !== tab.record.title) {
      tab.record.url = url;
      tab.record.title = title;
      await this.persist();
      this.emitUpdated(tab);
    }
    // canGoBack/Forward need real history state; fetch per push.
    const state = this.state(tab);
    if (tab.cdp) {
      try {
        const h = await tab.cdp.send("Page.getNavigationHistory");
        state.canGoBack = h.currentIndex > 0;
        state.canGoForward = h.currentIndex < h.entries.length - 1;
      } catch { /* page gone */ }
    }
    for (const sink of tab.sinks) sink.onState(state);
  }

  private async persist(): Promise<void> {
    const file = {
      version: 1 as const,
      browsers: [...this.tabs.values()].map((t) => t.record)
    };
    const tmp = `${this.opts.indexFile}.tmp`;
    await mkdir(dirname(this.opts.indexFile), { recursive: true });
    await writeFile(tmp, JSON.stringify(file, null, 2), "utf8");
    await rename(tmp, this.opts.indexFile);
  }
}
```

- [ ] **Step 3: `pnpm check`** — Expected: clean. (If puppeteer-core's `launch` option types differ in the installed major — e.g. `headless: true` vs `"shell"` — fix to match the installed version's types; the intent is new-headless mode.)

- [ ] **Step 4: Smoke-test against a real chromium (skips cleanly if absent)**

Write `$SCRATCH/smoke-browser-manager.ts` (adjust the import to the absolute repo path):

```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import assert from "node:assert";
import { BrowserManager } from "/var/lib/orquester/workspaces/jaspersito/orquester/apps/daemon/src/browsers.js";

const bin = ["google-chrome-stable", "google-chrome", "chromium", "chromium-browser"]
  .map((b) => { try { return execSync(`command -v ${b}`).toString().trim(); } catch { return ""; } })
  .find(Boolean);
if (!bin) { console.log("SKIP: no chromium on host"); process.exit(0); }

const dir = mkdtempSync(join(tmpdir(), "orq-browser-smoke-"));
const mgr = new BrowserManager({
  indexFile: join(dir, "browsers.json"),
  profilesDir: join(dir, "profiles"),
  resolveChromium: () => bin
});
await mgr.load();
const tab = await mgr.create("/tmp/fake-project", "data:text/html,<h1 id=hi>hello</h1><button id=go>go</button>");
let frames = 0; let picked: unknown = null;
const unsub = await mgr.subscribe(tab.id, {
  onFrame: () => { frames += 1; },
  onState: () => {},
  onPicked: (p) => { picked = p; },
  onEnd: () => {}
});
await new Promise((r) => setTimeout(r, 3000));
assert(frames >= 1, "no frames received");
await mgr.setPick(tab.id, true);
// Simulate the user's pick click at the <h1>.
mgr.dispatchPointer(tab.id, "move", 30, 30, "none", 0, 0);
await new Promise((r) => setTimeout(r, 300));
mgr.dispatchPointer(tab.id, "down", 30, 30, "left", 0, 1);
mgr.dispatchPointer(tab.id, "up", 30, 30, "left", 0, 1);
await new Promise((r) => setTimeout(r, 1500));
assert(picked, "no pick payload");
assert((picked as any).target.selector.length > 0, "empty selector");
console.log("browser-manager smoke: OK — frames:", frames, "selector:", (picked as any).target.selector);
unsub();
await mgr.close(tab.id);
await mgr.shutdown();
process.exit(0);
```

Run: `node --import tsx $SCRATCH/smoke-browser-manager.ts`
Expected: `browser-manager smoke: OK …` (or `SKIP: no chromium on host` — then install chromium locally or defer to Task 13 staging).

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/package.json apps/daemon/src/browsers.ts pnpm-lock.yaml
git commit -m "$(cat <<'EOF'
Add BrowserManager: per-project headless Chromium with CDP screencast

One Chromium process per project (launched on first tab subscribe, killed
with the project's last tab), one CDP page per browser tab. JPEG screencast
to subscriber sinks, Input.dispatch* passthrough, Emulation-based
desktop/mobile viewport, picker injection via Runtime binding, browsers.json
persistence (tab records survive restarts; processes do not).

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Daemon `UrlWatcher` + session output hook

**Files:**
- Create: `apps/daemon/src/url-watcher.ts`
- Modify: `apps/daemon/src/sessions.ts` — the two `pty.onData` handlers (tmux backend ~line 334, local backend ~line 772)
- Smoke test: `$SCRATCH/smoke-url-watcher.ts` (NOT committed)

**Interfaces:**
- Produces: `class UrlWatcher { ingest(projectPath: string, chunk: string): void; suggestions(projectPath: string): string[] }` — used by Task 5's routes.
- Produces: sessions `lifecycle` now also emits `"output"` with `{ id: string; data: string }` — consumed by Task 5's boot wiring.

- [ ] **Step 1: Write `apps/daemon/src/url-watcher.ts`**

```ts
/**
 * Detects dev-server URLs in PTY output (Vite/Next/CRA banners), per project.
 * Keeps ORIGINS ONLY (no path/query — avoids token leaks), most recent first,
 * capped at 8. ANSI is stripped before matching. Pure and synchronous; the
 * per-chunk cost is one `includes("http")` guard.
 */
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;
const URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d{2,5})?/gi;
const MAX_PER_PROJECT = 8;

export class UrlWatcher {
  private readonly byProject = new Map<string, string[]>();

  ingest(projectPath: string, chunk: string): void {
    if (!projectPath || !chunk.includes("http")) return;
    const clean = chunk.replace(ANSI_RE, "");
    const matches = clean.match(URL_RE);
    if (!matches) return;
    const list = this.byProject.get(projectPath) ?? [];
    for (const raw of matches) {
      // Normalize 0.0.0.0 (bind-all banner) to localhost — that's what the
      // server-side Chromium should actually dial.
      const origin = raw.toLowerCase().replace("0.0.0.0", "localhost");
      const at = list.indexOf(origin);
      if (at !== -1) list.splice(at, 1);
      list.unshift(origin);
    }
    this.byProject.set(projectPath, list.slice(0, MAX_PER_PROJECT));
  }

  suggestions(projectPath: string): string[] {
    return this.byProject.get(projectPath) ?? [];
  }
}
```

- [ ] **Step 2: Emit output on the session lifecycle**

In `apps/daemon/src/sessions.ts`, in **both** `pty.onData` handlers (tmux backend ~line 334 and the local backend ~line 772), add one line after the existing `session.emitter.emit("output", data);`:

```ts
      this.lifecycle.emit("output", { id, data });
```

(Match each handler's actual variable names — the local backend may capture the id differently; mirror the `activity` emit already present in the same closure.)

- [ ] **Step 3: Smoke-test the watcher**

Write `$SCRATCH/smoke-url-watcher.ts`:

```ts
import assert from "node:assert";
import { UrlWatcher } from "/var/lib/orquester/workspaces/jaspersito/orquester/apps/daemon/src/url-watcher.js";

const w = new UrlWatcher();
w.ingest("/p/a", "\x1b[32m  ➜  Local:   http://localhost:5173/\x1b[0m\n");
w.ingest("/p/a", "  ➜  Network: http://0.0.0.0:5173/app?secret=x\n");
w.ingest("/p/a", "listening on http://127.0.0.1:3000\n");
assert.deepEqual(w.suggestions("/p/a"), ["http://127.0.0.1:3000", "http://localhost:5173"]);
assert.deepEqual(w.suggestions("/p/b"), []);
w.ingest("/p/a", "no urls here"); // includes("http") short-circuit path
for (let i = 0; i < 20; i++) w.ingest("/p/a", `x http://localhost:${4000 + i} x`);
assert.equal(w.suggestions("/p/a").length, 8, "cap not enforced");
console.log("url-watcher smoke: OK");
```

Run: `node --import tsx $SCRATCH/smoke-url-watcher.ts` — Expected: `url-watcher smoke: OK`.

- [ ] **Step 4: `pnpm check`** — Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/url-watcher.ts apps/daemon/src/sessions.ts
git commit -m "$(cat <<'EOF'
Detect dev-server URLs from PTY output for browser suggestions

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Daemon boot wiring + `/api/browsers` routes

**Files:**
- Modify: `apps/daemon/src/index.ts` — resolved paths (~line 200), service construction (~line 226–334), `Services` type (grep `interface Services`), shutdown path (grep `async stop` / where `sessions.shutdown` is called), routes (after the sessions routes, ~line 1900)
- Modify: the `prepareDirs` helper (grep it) to mkdir `browserProfilesDir`

**Interfaces:**
- Consumes: `BrowserManager`, `BrowserError` (Task 3), `UrlWatcher` (Task 4), `browsersIndexPath`, `browserProfilesDir` (Task 1), api types (Task 1).
- Produces: routes `GET/POST /api/browsers`, `DELETE /api/browsers/:id`, `GET /api/browsers/suggestions`; events channel `"browser"`; `services.browsers: BrowserManager` and `services.urlWatcher: UrlWatcher` available to Task 6's `/ws-browser`.

- [ ] **Step 1: Resolve paths + dirs**

In the `resolved` object literal (~line 200) add:

```ts
    browsersIndexFile: browsersIndexPath(paths.baseDir),
    browserProfilesDir: browserProfilesDir(paths.baseDir),
```

Import both from `@orquester/config`. Extend the resolved-paths type the object satisfies (grep for where `sessionsIndexFile` is declared in that type) with `browsersIndexFile: string; browserProfilesDir: string;`. In `prepareDirs`, mkdir `resolved.browserProfilesDir` with `{ recursive: true, mode: 0o700 }` alongside the existing dirs.

- [ ] **Step 2: Construct + wire services (in `startDaemon`, after the `todos.lifecycle` wiring ~line 332)**

```ts
  // Server-side browser tabs (Design Mode). Chromium resolves through the
  // registry's probed browser entries; no bundled download.
  const browsers = new BrowserManager({
    indexFile: resolved.browsersIndexFile,
    profilesDir: resolved.browserProfilesDir,
    resolveChromium: () =>
      registry.list().browsers.find((b) => b.enabled && b.resolvedBin)?.resolvedBin
  });
  await browsers.load();
  browsers.lifecycle.on("created", (b) => broadcaster.publish("browser", "browser.created", b));
  browsers.lifecycle.on("updated", (b) => broadcaster.publish("browser", "browser.updated", b));
  browsers.lifecycle.on("closed", (p) => broadcaster.publish("browser", "browser.closed", p));

  // Dev-server URL suggestions: fed from every session's PTY output.
  const urlWatcher = new UrlWatcher();
  sessions.lifecycle.on("output", ({ id, data }: { id: string; data: string }) => {
    const summary = sessions.get(id);
    if (summary?.projectPath) urlWatcher.ingest(summary.projectPath, data);
  });
```

Add `browsers` and `urlWatcher` to the `Services` interface and the `services` literal (~line 334). If `registry.list()` is not the exact accessor for resolved entries, grep `RegistryService` for the method returning `RegistryResponse` and use that.

- [ ] **Step 3: Shutdown + project-delete cascade**

Where the daemon's `stop()` detaches sessions (grep `shutdown()` call on the session manager in `cli.ts`/`index.ts`), add `await services.browsers.shutdown();`. Where project deletion cascade-closes sessions (grep the projects DELETE route for the cascade), add `await services.browsers.closeForProject(projectPath);` with the same path variable.

- [ ] **Step 4: Routes (after the sessions routes block)**

```ts
  // Browser tabs — server-side Chromium (Design Mode). CRUD only here; the
  // live stream + input ride /ws-browser.
  app.get("/api/browsers", async (request): Promise<BrowserSummary[]> => {
    const { projectPath } = request.query as { projectPath?: string };
    return services.browsers.list(projectPath);
  });

  app.post("/api/browsers", async (request, reply): Promise<BrowserSummary> => {
    const body = request.body as CreateBrowserRequest;
    if (!body?.projectPath) {
      reply.code(400);
      throw new Error("projectPath is required");
    }
    try {
      return await services.browsers.create(body.projectPath, body.url);
    } catch (error) {
      if (error instanceof BrowserError) reply.code(error.statusCode);
      throw error;
    }
  });

  app.delete("/api/browsers/:id", async (request): Promise<{ ok: true }> => {
    await services.browsers.close((request.params as { id: string }).id);
    return { ok: true };
  });

  app.get("/api/browsers/suggestions", async (request): Promise<BrowserSuggestionsResponse> => {
    const { projectPath } = request.query as { projectPath?: string };
    return { urls: projectPath ? services.urlWatcher.suggestions(projectPath) : [] };
  });
```

Match the file's actual route/error idiom (look at the neighboring `/api/sessions` routes and mirror their reply/error envelope exactly — if they use a helper for errors, use it).

- [ ] **Step 5: `pnpm check`** — Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add apps/daemon/src/index.ts
git commit -m "$(cat <<'EOF'
Wire BrowserManager into daemon boot, events, and /api/browsers routes

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Daemon `/ws-browser` handler

**Files:**
- Modify: `apps/daemon/src/index.ts` — register directly after the existing `/ws` block (~line 2178)

**Interfaces:**
- Consumes: `services.browsers` (Task 5), `BrowserClientMessage`, `BROWSER_FRAME_TYPE_JPEG` (Task 1), `BrowserSink` (Task 3), the same `authorizeCredential` guard `/ws` uses.
- Produces: the wire protocol Task 7's `BrowserChannel` speaks.

- [ ] **Step 1: Add the endpoint (inside the same encapsulated register pattern as `/ws`, or a sibling one)**

```ts
  // Browser-tab streaming: binary JPEG frames out, JSON control in. Kept off
  // /ws so the terminal channel's text-only fast path is untouched.
  void app.register(async (instance) => {
    await instance.register(websocketPlugin);
    instance.get("/ws-browser", { websocket: true }, (socket, request) => {
      if (options.authRequired) {
        const token = (request.query as { token?: string }).token;
        if (!authorizeCredential(token, config.transports.http.username, config.transports.http.passwordHash)) {
          socket.close(1008, "unauthorized");
          return;
        }
      }

      const subs = new Map<string, () => void>();
      const SEND_HWM = 1_500_000; // skip frames when the socket is backed up (mobile data)
      const sendJson = (msg: unknown) => {
        try { socket.send(JSON.stringify(msg)); } catch { /* closing */ }
      };
      const sendFrame = (id: string, jpeg: Buffer) => {
        if (socket.bufferedAmount > SEND_HWM) return; // latest-frame-wins; CDP acks continue
        const header = Buffer.alloc(37);
        header.writeUInt8(BROWSER_FRAME_TYPE_JPEG, 0);
        header.write(id, 1, 36, "ascii");
        try { socket.send(Buffer.concat([header, jpeg])); } catch { /* closing */ }
      };

      socket.on("message", async (raw, isBinary) => {
        if (isBinary) return; // client never sends binary
        let msg: BrowserClientMessage;
        try { msg = JSON.parse(raw.toString()); } catch { return; }
        if (msg.t === "ping") { sendJson({ t: "pong" }); return; }
        const id = "id" in msg ? msg.id : undefined;
        if (!id) return;

        if (msg.t === "sub") {
          subs.get(id)?.();
          const placeholder = () => {};
          subs.set(id, placeholder);
          const unsub = await services.browsers.subscribe(id, {
            onFrame: (jpeg) => sendFrame(id, jpeg),
            onState: (state) => sendJson(state),
            onPicked: (payload) => sendJson({ t: "picked", id, payload }),
            onEnd: () => sendJson({ t: "end", id })
          }).catch(() => null);
          if (!unsub) { subs.delete(id); sendJson({ t: "end", id }); return; }
          if (subs.get(id) !== placeholder) { unsub(); return; } // raced by unsub — honor it
          subs.set(id, unsub);
        } else if (msg.t === "unsub") {
          subs.get(id)?.(); subs.delete(id);
        } else if (msg.t === "pointer") {
          services.browsers.dispatchPointer(id, msg.kind, msg.x, msg.y, msg.button, msg.modifiers, msg.clickCount);
        } else if (msg.t === "wheel") {
          services.browsers.dispatchWheel(id, msg.x, msg.y, msg.dx, msg.dy);
        } else if (msg.t === "key") {
          services.browsers.dispatchKey(id, msg.kind, msg.key, msg.code, msg.text, msg.modifiers);
        } else if (msg.t === "touch") {
          services.browsers.dispatchTouch(id, msg.kind, msg.points);
        } else if (msg.t === "nav") {
          await services.browsers.navigate(id, msg.action, msg.url).catch(() => undefined);
        } else if (msg.t === "viewport") {
          await services.browsers.setViewport(id, msg.mode).catch(() => undefined);
        } else if (msg.t === "pick") {
          await services.browsers.setPick(id, msg.on).catch(() => undefined);
        }
      });

      socket.on("close", () => {
        for (const unsub of subs.values()) unsub();
        subs.clear();
      });
    });
  });
```

- [ ] **Step 2: `pnpm check`** — Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add apps/daemon/src/index.ts
git commit -m "$(cat <<'EOF'
Add /ws-browser: multiplexed binary screencast + JSON control channel

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: UI transport — `BrowserChannel` + api-client methods

**Files:**
- Create: `packages/ui/src/lib/transporters/ws-browser-channel.ts`
- Modify: `packages/ui/src/lib/transporter.ts` (add optional `browserChannel?()`)
- Modify: `packages/ui/src/lib/transporters/http-transporter.ts` (implement it, mirroring how `sessionChannel()` uses `getSessionChannel`)
- Modify: `packages/ui/src/lib/transporters/index.ts` (export)
- Modify: `packages/ui/src/lib/api-client.ts` (CRUD methods + `browserChannel()` accessor)

**Interfaces:**
- Consumes: `BrowserClientMessage`, `BrowserServerJsonMessage`, `BrowserStateMessage`, `BrowserPickPayload`, `BrowserSummary`, `CreateBrowserRequest`, `BrowserSuggestionsResponse`, `BROWSER_FRAME_TYPE_JPEG` (Task 1).
- Produces (used by Tasks 8–9):

```ts
export interface BrowserStreamHandlers {
  onFrame(jpeg: ArrayBuffer): void;
  onState(state: BrowserStateMessage): void;
  onPicked(payload: BrowserPickPayload): void;
  onEnd(): void;
}
export class WsBrowserChannel {
  open(id: string, handlers: BrowserStreamHandlers): { close(): void };
  send(msg: BrowserClientMessage): void; // pointer/wheel/key/touch/nav/viewport/pick
  wake(): void;
}
// transporter.ts: Transporter gains `browserChannel?(): WsBrowserChannel | undefined`
// api-client.ts: listBrowsers(projectPath?), createBrowser(req), closeBrowser(id),
//                browserSuggestions(projectPath), browserChannel()
```

- [ ] **Step 1: Write `ws-browser-channel.ts`** — clone `WsSessionChannel`'s connection lifecycle (reconnect backoff, `wake()` ping/pong, credential, module-level channel map) with these deltas; keep the same private method structure so the two files diff cleanly:

```ts
import type {
  BrowserClientMessage,
  BrowserPickPayload,
  BrowserServerJsonMessage,
  BrowserStateMessage
} from "@orquester/api";

export interface BrowserStreamHandlers {
  onFrame(jpeg: ArrayBuffer): void;
  onState(state: BrowserStateMessage): void;
  onPicked(payload: BrowserPickPayload): void;
  onEnd(): void;
}

/**
 * Multiplexes every browser tab's screencast + control for one daemon over a
 * single WebSocket (sibling of WsSessionChannel; kept separate so terminals'
 * text-only path is untouched). Binary frames carry pixels:
 * [u8 type=1][36-byte tab id ascii][JPEG]. There is no replay semantic — on
 * reconnect the daemon re-primes with a fresh screenshot frame.
 */
export class WsBrowserChannel {
  private ws: WebSocket | null = null;
  private readonly subs = new Map<string, BrowserStreamHandlers>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private attempts = 0;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly wsUrl: string, private credential?: string) {
    this.connect();
  }

  setCredential(credential?: string): void {
    if (credential === this.credential) return;
    this.credential = credential;
    this.reconnect();
  }

  open(id: string, handlers: BrowserStreamHandlers): { close(): void } {
    this.subs.set(id, handlers);
    this.send({ t: "sub", id });
    return {
      close: () => {
        if (this.subs.delete(id)) this.send({ t: "unsub", id });
      }
    };
  }

  send(msg: BrowserClientMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
    // Dropped while offline: subs re-subscribe on reconnect; input during a
    // blip is simply lost (no replay semantic for a live stream).
  }

  wake(): void {
    // Identical body to WsSessionChannel.wake() — copy it verbatim.
  }

  private connect(): void {
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.credential
        ? `${this.wsUrl}?token=${encodeURIComponent(this.credential)}`
        : this.wsUrl);
    } catch {
      this.scheduleReconnect();
      return;
    }
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    ws.onopen = () => {
      this.attempts = 0;
      for (const id of this.subs.keys()) this.send({ t: "sub", id });
    };

    ws.onmessage = (event: MessageEvent) => {
      if (event.data instanceof ArrayBuffer) {
        const bytes = new Uint8Array(event.data);
        if (bytes.length < 37 || bytes[0] !== 1 /* BROWSER_FRAME_TYPE_JPEG */) return;
        const id = new TextDecoder().decode(bytes.subarray(1, 37));
        this.subs.get(id)?.onFrame(event.data.slice(37));
        return;
      }
      if (typeof event.data !== "string") return;
      let msg: BrowserServerJsonMessage;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (msg.t === "pong") { this.clearPongDeadline(); return; }
      const handlers = this.subs.get(msg.id);
      if (!handlers) return;
      if (msg.t === "state") handlers.onState(msg);
      else if (msg.t === "picked") handlers.onPicked(msg.payload);
      else if (msg.t === "end") handlers.onEnd();
    };

    ws.onclose = () => { /* copy WsSessionChannel's onclose verbatim */ };
    ws.onerror = () => { try { ws.close(); } catch { /* ignore */ } };
  }

  // clearPongDeadline / reconnect / scheduleReconnect: copy from
  // WsSessionChannel verbatim (same fields, same semantics).
}

const channels = new Map<string, WsBrowserChannel>();

export function wakeBrowserChannels(): void {
  for (const channel of channels.values()) channel.wake();
}

export function getBrowserChannel(httpBaseUrl: string, credential?: string): WsBrowserChannel {
  const wsUrl = `${httpBaseUrl.replace(/^http/, "ws").replace(/\/$/, "")}/ws-browser`;
  const existing = channels.get(wsUrl);
  if (existing) {
    existing.setCredential(credential);
    return existing;
  }
  const channel = new WsBrowserChannel(wsUrl, credential);
  channels.set(wsUrl, channel);
  return channel;
}
```

The three "copy verbatim" bodies are in `ws-session-channel.ts:68-99` and `:155-202` — reproduce them exactly (they reference only the class's own fields, all of which exist here).

- [ ] **Step 2: Extend `Transporter`** (`packages/ui/src/lib/transporter.ts`) — after `sessionChannel?()`:

```ts
  /**
   * Optional multiplexed browser-tab channel (screencast + control). Present on
   * HTTP transports only; the desktop unix socket omits it (v1 — browser tabs
   * are HTTP-transport-only, which includes desktop-remote).
   */
  browserChannel?(): import("./transporters/ws-browser-channel").WsBrowserChannel;
```

(If the file avoids inline `import()` types, add a top type-only import instead — follow the file's style.)

- [ ] **Step 3: Implement in `http-transporter.ts`** — find its `sessionChannel()` implementation and add the sibling, using the same base-url + credential fields it already holds:

```ts
  browserChannel(): WsBrowserChannel {
    return getBrowserChannel(this.baseUrl, this.credential);
  }
```

(Match the actual field names in that class; also hook `wakeBrowserChannels()` wherever `wakeSessionChannels()` is called — grep for it, likely the store's `wakeConnections`.)

- [ ] **Step 4: api-client methods** (`packages/ui/src/lib/api-client.ts`, next to the session methods ~line 585):

```ts
  listBrowsers(projectPath?: string): Promise<BrowserSummary[]> {
    return this.get("/api/browsers", projectPath ? { projectPath } : undefined);
  }

  createBrowser(body: CreateBrowserRequest): Promise<BrowserSummary> {
    return this.post("/api/browsers", body);
  }

  closeBrowser(id: string): Promise<void> {
    return this.delete(`/api/browsers/${id}`);
  }

  browserSuggestions(projectPath: string): Promise<BrowserSuggestionsResponse> {
    return this.get("/api/browsers/suggestions", { projectPath });
  }

  /** Undefined on transports without browser streaming (desktop unix socket). */
  browserChannel(): WsBrowserChannel | undefined {
    return this.transporter.browserChannel?.();
  }
```

Match the class's real request-helper names (`this.get`/`this.post`/etc. — read the neighbors and mirror; they may unwrap `ApiEnvelope`).

- [ ] **Step 5: `pnpm check`** — Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add packages/ui/src/lib/transporters/ws-browser-channel.ts packages/ui/src/lib/transporter.ts packages/ui/src/lib/transporters/http-transporter.ts packages/ui/src/lib/transporters/index.ts packages/ui/src/lib/api-client.ts
git commit -m "$(cat <<'EOF'
Add browser-tab transport: WsBrowserChannel + ApiClient browser methods

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: UI store — browsers state, events, tabs

**Files:**
- Modify: `packages/ui/src/store/app.ts`

**Interfaces:**
- Consumes: `BrowserSummary` (Task 1), api-client methods (Task 7).
- Produces (used by Task 9): store slice `browsers: BrowserSummary[]`; actions `openBrowser(url?: string): Promise<void>`, browser-aware `closeTab`; `ProjectTab` variant `{ id: string; type: "browser"; browser: BrowserSummary }`; `useProjectTabs()` returns browser tabs after session tabs.

- [ ] **Step 1: State + type.** Add to the state interface (next to `sessions`, ~line 549): `browsers: BrowserSummary[];` with initial value `[]`. Extend `ProjectTab` (~line 373):

```ts
  | { id: string; type: "browser"; browser: BrowserSummary }
```

- [ ] **Step 2: Load.** Where `establish` loads sessions (grep `listSessions` in the store), load browsers in parallel and tolerate absence (older daemons 404):

```ts
      api.listBrowsers().then((browsers) => set({ browsers })).catch(() => set({ browsers: [] }));
```

- [ ] **Step 3: Action.** Next to `openGit` (~line 1467):

```ts
  openBrowser: async (url) => {
    const { api, currentProject } = get();
    if (!api || !currentProject) return;
    const browser = await api.createBrowser({ projectPath: currentProject.path, url });
    set((state) => ({
      browsers: upsertBrowser(state.browsers, browser),
      activeTabByProject: { ...state.activeTabByProject, [currentProject.path]: browser.id }
    }));
  },
```

Add `openBrowser: (url?: string) => Promise<void>;` to the actions interface, and a helper next to `upsertSession` (grep it and mirror its shape):

```ts
function upsertBrowser(browsers: BrowserSummary[], browser: BrowserSummary): BrowserSummary[] {
  const at = browsers.findIndex((b) => b.id === browser.id);
  if (at === -1) return [...browsers, browser];
  const next = browsers.slice();
  next[at] = browser;
  return next;
}
```

- [ ] **Step 4: closeTab.** In `closeTab` (~line 1487) handle the third kind:

```ts
  closeTab: async (id) => {
    const api = get().api;
    const isSession = get().sessions.some((s) => s.id === id);
    const isBrowser = !isSession && get().browsers.some((b) => b.id === id);
    set((state) =>
      isSession ? removeSession(state, id)
      : isBrowser ? removeBrowser(state, id)
      : removeLocalTab(state, id));
    if (isSession) await api?.closeSession(id).catch(() => undefined);
    else if (isBrowser) await api?.closeBrowser(id).catch(() => undefined);
  },
```

Also update `requestCloseTab` (~line 1496): a browser tab needs no live-process confirm — treat it like a local tab there.

- [ ] **Step 5: Removal + active reassignment.** Add `removeBrowser` next to `removeSession` (~line 1885) and thread browsers through `firstTabId`/`reassignActive` (~lines 1851–1883): add a `browsers: BrowserSummary[]` parameter to both, picked after sessions —

```ts
    sessions.find((s) => s.projectPath === path)?.id ??
    browsers.find((b) => b.projectPath === path)?.id ??
    fileTabs[path]?.[0]?.id ?? ...
```

— and update **every** caller (`removeSession`, `removeLocalTab`, the new `removeBrowser`) to pass `state.browsers` (or the just-filtered list in `removeBrowser`):

```ts
function removeBrowser(state: AppState, id: string): Partial<AppState> {
  const browsers = state.browsers.filter((b) => b.id !== id);
  return {
    browsers,
    activeTabByProject: reassignActive(
      state.activeTabByProject, id, state.sessions, browsers,
      state.fileTabsByProject, state.gitTabsByProject, state.todoTabsByContext
    )
  };
}
```

- [ ] **Step 6: Events.** In `applyEvent` (~line 1804), before the `channel !== "sessions"` early-return:

```ts
    if (event.channel === "browser") {
      if (event.type === "browser.created" || event.type === "browser.updated") {
        const summary = event.payload as BrowserSummary;
        set((state) => ({ browsers: upsertBrowser(state.browsers, summary) }));
      } else if (event.type === "browser.closed") {
        const { id } = event.payload as { id: string };
        set((state) => removeBrowser(state, id));
      }
      return;
    }
```

- [ ] **Step 7: Tabs.** In `useProjectTabs` (~line 2059) add the slice selector `const browsers = useAppStore((s) => s.browsers);`, build

```ts
    const browserTabs = browsers
      .filter((b) => b.projectPath === key)
      .slice()
      .sort((a, b) => a.order - b.order || a.createdAt.localeCompare(b.createdAt))
      .map<ProjectTab>((browser) => ({ id: browser.id, type: "browser", browser }));
```

and return `[...sessionTabs, ...browserTabs, ...fileTabs, ...gitTabs, ...todoTabs]` (browser tabs render after sessions — the documented v1 ordering deviation). Add `browsers` to the `useMemo` deps.

- [ ] **Step 8: `pnpm check`** — Expected: clean (MainView's render switch may now be non-exhaustive — if it errors, add a temporary `tab.type === "browser" ? null :` branch; Task 9 replaces it).

- [ ] **Step 9: Commit**

```bash
git add packages/ui/src/store/app.ts
git commit -m "$(cat <<'EOF'
Add server-authoritative browser tabs to the UI store

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: UI — `BrowserView` component + MainView/menu wiring

**Files:**
- Create: `packages/ui/src/components/browser/BrowserView.tsx`
- Create: `packages/ui/src/components/browser/index.ts` (`export { BrowserView } from "./BrowserView";`)
- Modify: `packages/ui/src/components/main/MainView.tsx` (icon + render branch)
- Modify: `packages/ui/src/components/topbar/NewTabMenu.tsx` ("Browser" entry + suggestions)

**Interfaces:**
- Consumes: `WsBrowserChannel`/`BrowserStreamHandlers` (Task 7), store slice + `openBrowser` (Task 8), `api.browserChannel()`/`api.browserSuggestions()` (Task 7).
- Produces: `<BrowserView browser={BrowserSummary} active={boolean} />`; a `pendingPick` state consumed by Task 10's compose sheet (declare it now: `const [pick, setPick] = useState<BrowserPickPayload | null>(null);`).

- [ ] **Step 1: Write `BrowserView.tsx`** — the component below is complete except the compose sheet (Task 10 fills the `{pick && …}` slot). Key mechanics: subscribe only while `active`; paint frames onto a canvas via `createImageBitmap`; map client coords → server-viewport CSS pixels through the letterbox scale; pinch-zoom/pan as a client-side CSS transform; a hidden input captures mobile keystrokes.

```tsx
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft, ArrowRight, Crosshair, Monitor, RotateCw, ShieldAlert, Smartphone
} from "lucide-react";
import type { BrowserPickPayload, BrowserStateMessage, BrowserSummary } from "@orquester/api";
import { useAppStore } from "../../store/app";
import { cn } from "../../lib/cn";

const VIEWPORT = { desktop: { w: 1280, h: 800 }, mobile: { w: 390, h: 844 } } as const;

/** CDP Input modifier bits: 1=Alt, 2=Ctrl, 4=Meta, 8=Shift. */
function modifiersOf(e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): number {
  return (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
}

export const BrowserView: React.FC<{ browser: BrowserSummary; active: boolean }> = ({ browser, active }) => {
  const api = useAppStore((s) => s.api);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const hiddenInputRef = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<BrowserStateMessage | null>(null);
  const [urlDraft, setUrlDraft] = useState(browser.url === "about:blank" ? "" : browser.url);
  const [urlFocused, setUrlFocused] = useState(false);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [picking, setPicking] = useState(false);
  const [pick, setPick] = useState<BrowserPickPayload | null>(null);
  const [zoom, setZoom] = useState({ scale: 1, tx: 0, ty: 0 });
  const gesture = useRef<{ dist: number; scale: number; tx: number; ty: number; cx: number; cy: number } | null>(null);

  const channel = useMemo(() => api?.browserChannel(), [api]);
  const vp = VIEWPORT[state?.viewportMode ?? browser.viewportMode];

  // Subscribe while active; the canvas keeps its last frame when hidden (grid
  // view shows it frozen). No replay semantic: resubscribe re-primes.
  useEffect(() => {
    if (!channel || !active) return;
    const canvas = canvasRef.current;
    const handle = channel.open(browser.id, {
      onFrame: (jpeg) => {
        void createImageBitmap(new Blob([jpeg], { type: "image/jpeg" })).then((bmp) => {
          const ctx = canvas?.getContext("2d");
          if (!canvas || !ctx) return;
          if (canvas.width !== bmp.width || canvas.height !== bmp.height) {
            canvas.width = bmp.width;
            canvas.height = bmp.height;
          }
          ctx.drawImage(bmp, 0, 0);
          bmp.close();
        });
      },
      onState: (s) => {
        setState(s);
        if (!urlFocused) setUrlDraft(s.url === "about:blank" ? "" : s.url);
      },
      onPicked: (payload) => { setPicking(false); setPick(payload); },
      onEnd: () => {}
    });
    return () => handle.close();
    // urlFocused deliberately omitted: resubscribing on focus would flash the stream.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel, browser.id, active]);

  // Client coords → server-viewport CSS pixels through letterbox scale + zoom.
  const toPage = useCallback((clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect(); // includes the zoom transform
    const x = ((clientX - rect.left) / rect.width) * vp.w;
    const y = ((clientY - rect.top) / rect.height) * vp.h;
    if (x < 0 || y < 0 || x > vp.w || y > vp.h) return null;
    return { x: Math.round(x), y: Math.round(y) };
  }, [vp.w, vp.h]);

  const send = channel?.send.bind(channel);

  const onPointer = (kind: "move" | "down" | "up") => (e: React.PointerEvent) => {
    if (e.pointerType === "touch") return; // touch goes through onTouch* below
    const p = toPage(e.clientX, e.clientY);
    if (!p || !send) return;
    if (kind === "down") { canvasRef.current?.focus(); hiddenInputRef.current?.focus({ preventScroll: true }); }
    const button = e.button === 2 ? "right" : e.button === 1 ? "middle" : kind === "move" && e.buttons === 0 ? "none" : "left";
    send({ t: "pointer", id: browser.id, kind, x: p.x, y: p.y, button, modifiers: modifiersOf(e), clickCount: 1 });
  };

  const onWheel = (e: React.WheelEvent) => {
    const p = toPage(e.clientX, e.clientY);
    if (p && send) send({ t: "wheel", id: browser.id, x: p.x, y: p.y, dx: e.deltaX, dy: e.deltaY });
  };

  // Touch: 1 finger → forwarded taps/drags; 2 fingers → client-side pinch/pan.
  const onTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length === 2) {
      const [a, b] = [e.touches[0], e.touches[1]];
      gesture.current = {
        dist: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY),
        scale: zoom.scale, tx: zoom.tx, ty: zoom.ty,
        cx: (a.clientX + b.clientX) / 2, cy: (a.clientY + b.clientY) / 2
      };
      return;
    }
    const t = e.touches[0];
    const p = t && toPage(t.clientX, t.clientY);
    if (p && send) send({ t: "touch", id: browser.id, kind: "start", points: [p] });
  };
  const onTouchMove = (e: React.TouchEvent) => {
    if (e.touches.length === 2 && gesture.current) {
      e.preventDefault();
      const [a, b] = [e.touches[0], e.touches[1]];
      const g = gesture.current;
      const scale = Math.min(4, Math.max(1, g.scale * (Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) / g.dist)));
      const cx = (a.clientX + b.clientX) / 2, cy = (a.clientY + b.clientY) / 2;
      setZoom({ scale, tx: g.tx + cx - g.cx, ty: g.ty + cy - g.cy });
      return;
    }
    const t = e.touches[0];
    const p = t && toPage(t.clientX, t.clientY);
    if (p && send) send({ t: "touch", id: browser.id, kind: "move", points: [p] });
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    if (gesture.current) {
      if (e.touches.length < 2) gesture.current = null;
      if (zoom.scale <= 1.02) setZoom({ scale: 1, tx: 0, ty: 0 });
      return;
    }
    send?.({ t: "touch", id: browser.id, kind: "end", points: [] });
    hiddenInputRef.current?.focus({ preventScroll: true });
  };

  const onKey = (kind: "down" | "up") => (e: React.KeyboardEvent) => {
    if (!send) return;
    e.preventDefault();
    send({ t: "key", id: browser.id, kind, key: e.key, code: e.code, modifiers: modifiersOf(e) });
    if (kind === "down" && e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
      send({ t: "key", id: browser.id, kind: "char", key: e.key, code: e.code, text: e.key, modifiers: modifiersOf(e) });
    }
  };

  const navigate = (action: "goto" | "back" | "forward" | "reload", url?: string) =>
    send?.({ t: "nav", id: browser.id, action, url });

  const togglePick = () => {
    const on = !picking;
    setPicking(on);
    send?.({ t: "pick", id: browser.id, on });
  };

  const loadSuggestions = () => {
    void api?.browserSuggestions(browser.projectPath).then((r) => setSuggestions(r.urls)).catch(() => undefined);
  };

  return (
    <div className="flex h-full w-full flex-col bg-neutral-950">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-neutral-800 bg-neutral-900/40 px-2">
        <button type="button" aria-label="Back" disabled={!state?.canGoBack} onClick={() => navigate("back")}
          className="rounded p-1 text-neutral-400 enabled:hover:bg-neutral-800 disabled:opacity-40">
          <ArrowLeft size={14} />
        </button>
        <button type="button" aria-label="Forward" disabled={!state?.canGoForward} onClick={() => navigate("forward")}
          className="rounded p-1 text-neutral-400 enabled:hover:bg-neutral-800 disabled:opacity-40">
          <ArrowRight size={14} />
        </button>
        <button type="button" aria-label="Reload" onClick={() => navigate("reload")}
          className={cn("rounded p-1 text-neutral-400 hover:bg-neutral-800", state?.loading && "animate-spin")}>
          <RotateCw size={14} />
        </button>
        <form
          className="min-w-0 flex-1"
          onSubmit={(e) => { e.preventDefault(); if (urlDraft.trim()) navigate("goto", urlDraft.trim()); }}
        >
          <input
            value={urlDraft}
            onChange={(e) => setUrlDraft(e.target.value)}
            onFocus={() => { setUrlFocused(true); loadSuggestions(); }}
            onBlur={() => setUrlFocused(false)}
            list={`browser-suggestions-${browser.id}`}
            placeholder="Enter URL (e.g. localhost:5173)"
            spellCheck={false} autoCapitalize="off" autoCorrect="off"
            className="w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-200 outline-none focus:border-neutral-500"
          />
          <datalist id={`browser-suggestions-${browser.id}`}>
            {suggestions.map((url) => <option key={url} value={url} />)}
          </datalist>
        </form>
        <button type="button" aria-label="Toggle viewport"
          onClick={() => send?.({ t: "viewport", id: browser.id, mode: (state?.viewportMode ?? browser.viewportMode) === "desktop" ? "mobile" : "desktop" })}
          className="rounded p-1 text-neutral-400 hover:bg-neutral-800">
          {(state?.viewportMode ?? browser.viewportMode) === "desktop" ? <Monitor size={14} /> : <Smartphone size={14} />}
        </button>
        <button type="button" aria-label="Pick element" onClick={togglePick}
          className={cn("rounded p-1 hover:bg-neutral-800", picking ? "text-sky-400" : "text-neutral-400")}>
          <Crosshair size={14} />
        </button>
        {state && !state.sandboxed && (
          <span title="Chromium is running without its sandbox on this host">
            <ShieldAlert size={14} className="text-amber-500" />
          </span>
        )}
      </div>

      <div ref={wrapRef} className="relative min-h-0 flex-1 touch-none overflow-hidden"
        onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd}>
        {state?.status === "crashed" || state?.status === "error" ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-neutral-400">
            <span>{state.status === "crashed" ? "Browser crashed" : (browser.errorMessage ?? "Browser failed to start")}</span>
            <button type="button" onClick={() => navigate("reload")}
              className="rounded border border-neutral-700 px-3 py-1 text-xs hover:bg-neutral-800">
              Relaunch
            </button>
          </div>
        ) : (
          <canvas
            ref={canvasRef}
            tabIndex={0}
            onPointerMove={onPointer("move")} onPointerDown={onPointer("down")} onPointerUp={onPointer("up")}
            onWheel={onWheel} onKeyDown={onKey("down")} onKeyUp={onKey("up")}
            onContextMenu={(e) => e.preventDefault()}
            className="mx-auto block h-full max-w-full object-contain outline-none"
            style={{
              aspectRatio: `${vp.w} / ${vp.h}`,
              transform: zoom.scale !== 1 ? `translate(${zoom.tx}px, ${zoom.ty}px) scale(${zoom.scale})` : undefined,
              transformOrigin: "0 0"
            }}
          />
        )}
        {/* Off-screen input: keeps the mobile soft keyboard up; keystrokes forward as CDP keys. */}
        <input
          ref={hiddenInputRef}
          aria-hidden
          className="absolute -left-[9999px] top-0 h-px w-px opacity-0"
          autoCapitalize="off" autoCorrect="off"
          onKeyDown={onKey("down")} onKeyUp={onKey("up")}
          onChange={(e) => { e.target.value = ""; }}
        />
        {pick && (
          /* Task 10 replaces this stub with <PickComposeSheet …/> */
          <div className="absolute inset-x-0 bottom-0" data-pick-stub onClick={() => setPick(null)} />
        )}
      </div>
    </div>
  );
};
```

- [ ] **Step 2: MainView wiring** (`packages/ui/src/components/main/MainView.tsx`):
  - Import: `import { Globe } from "lucide-react"` (add to the existing lucide import) and `import { BrowserView } from "../browser";`
  - `cellIcon` (~line 25): add `tab.type === "browser" ? <Globe size={13} /> :` before the git branch.
  - `cellTitle` (~line 37): `tab.type === "browser"` → `tab.browser.title || tab.browser.url || "Browser"`; adjust the existing ternary accordingly.
  - Render switch (~line 301): add before the git branch:

```tsx
                ) : tab.type === "browser" ? (
                  <BrowserView browser={tab.browser} active={active} />
```

- [ ] **Step 3: NewTabMenu entry** (`packages/ui/src/components/topbar/NewTabMenu.tsx`) — in the Tools section after the Git item (~line 81). Gate on the registry's probed browser binaries; when absent, render a disabled hint row (match `DropdownItem`'s disabled affordance; if it has none, render a `DropdownEmpty`):

```tsx
      {registry.browsers.some((b) => b.enabled) ? (
        <DropdownItem icon={<Globe size={14} />} onClick={() => void openBrowser()}>
          Browser
        </DropdownItem>
      ) : (
        <DropdownEmpty>Browser — install chromium on the host</DropdownEmpty>
      )}
```

with `const openBrowser = useAppStore((s) => s.openBrowser);` and `Globe` added to the lucide import. Remove any temporary `null` branch added in Task 8 Step 8.

- [ ] **Step 4: `pnpm check`** — Expected: clean.

- [ ] **Step 5: Visual sanity via the SPA build** — run `pnpm build` (web SPA only; **not** the daemon) and confirm it succeeds. Real interaction verification happens in Task 13 (this checkout must not drive a daemon).

- [ ] **Step 6: Commit**

```bash
git add packages/ui/src/components/browser packages/ui/src/components/main/MainView.tsx packages/ui/src/components/topbar/NewTabMenu.tsx
git commit -m "$(cat <<'EOF'
Add BrowserView: streamed canvas, toolbar, input forwarding, viewport toggle

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: Design-feedback formatter + PickComposeSheet

**Files:**
- Create: `packages/ui/src/lib/design-feedback.ts`
- Create: `packages/ui/src/components/browser/PickComposeSheet.tsx`
- Modify: `packages/ui/src/components/browser/BrowserView.tsx` (replace the `data-pick-stub` slot)
- Modify: `packages/ui/src/components/browser/index.ts`

**Interfaces:**
- Consumes: `BrowserPickPayload` (Task 1), `api.uploadSessionFile` / `api.sendSessionInput` (existing), store `sessions` slice.
- Produces: `formatDesignFeedback(payload, opts: { comment: string; intent: "fix" | "change" | "question"; screenshotPath?: string }): string`; `<PickComposeSheet payload projectPath onClose />`.

- [ ] **Step 1: Write `design-feedback.ts`** (Orca's `browser-annotation-output.ts` format, ported):

```ts
import type { BrowserPickPayload } from "@orquester/api";

export type PickIntent = "fix" | "change" | "question";

/**
 * Render a pick into the Markdown block pasted into an agent's PTY (Orca's
 * "Design Feedback" format). The screenshot is referenced by daemon-side path
 * (uploaded via the session-upload route) — agents like Claude Code read image
 * paths natively.
 */
export function formatDesignFeedback(
  payload: BrowserPickPayload,
  opts: { comment: string; intent: PickIntent; screenshotPath?: string }
): string {
  const { page, target } = payload;
  const lines: string[] = [
    `## Design Feedback: ${target.elementPath || target.selector}`,
    "",
    `**URL:** ${page.url}`,
    `**Viewport:** ${page.viewport.width}×${page.viewport.height} (${page.viewportMode})`,
    `**Intent:** ${opts.intent}`,
    "",
    `**Selector:** \`${target.selector}\``
  ];
  if (target.reactSource) lines.push(`**Source:** ${target.reactSource}`);
  if (target.reactComponents?.length) lines.push(`**React:** ${target.reactComponents.join(" > ")}`);
  lines.push(
    `**Bounds:** ${Math.round(target.rectViewport.width)}×${Math.round(target.rectViewport.height)} at (${Math.round(target.rectViewport.x)}, ${Math.round(target.rectViewport.y)})`
  );
  if (target.cssClasses.length) lines.push(`**Classes:** ${target.cssClasses.join(" ")}`);
  if (target.accessibility.role || target.accessibility.name) {
    lines.push(`**Accessibility:** role=${target.accessibility.role || "-"} name="${target.accessibility.name}"`);
  }
  if (target.textSnippet) lines.push(`**Text:** ${target.textSnippet}`);
  const styles = Object.entries(target.computedStyles);
  if (styles.length) {
    lines.push("", "**Computed styles:**");
    for (const [prop, value] of styles) lines.push(`- ${prop}: ${value}`);
  }
  if (target.htmlSnippet) lines.push("", "**HTML:**", "```html", target.htmlSnippet, "```");
  if (opts.screenshotPath) lines.push("", `**Screenshot:** ${opts.screenshotPath}`);
  lines.push("", `**Feedback:** ${opts.comment.trim() || "(none)"}`);
  return lines.join("\n");
}
```

- [ ] **Step 2: Write `PickComposeSheet.tsx`**:

```tsx
import React, { useMemo, useState } from "react";
import { Send, X } from "lucide-react";
import type { BrowserPickPayload } from "@orquester/api";
import { useAppStore } from "../../store/app";
import { formatDesignFeedback, type PickIntent } from "../../lib/design-feedback";
import { cn } from "../../lib/cn";

/**
 * Bottom sheet shown after an element pick: summary + screenshot thumbnail +
 * comment + intent + target agent session. Delivery reuses the existing
 * routes verbatim: upload the PNG (→ daemon path), then one bracketed-paste
 * input write + "\r" to submit (see session-upload.ts for the paste format).
 */
export const PickComposeSheet: React.FC<{
  payload: BrowserPickPayload;
  projectPath: string;
  onClose: () => void;
}> = ({ payload, projectPath, onClose }) => {
  const api = useAppStore((s) => s.api);
  const sessions = useAppStore((s) => s.sessions);
  const agents = useMemo(
    () => sessions.filter((s) => s.kind === "agent" && s.projectPath === projectPath && s.status === "running"),
    [sessions, projectPath]
  );
  const [targetId, setTargetId] = useState<string>(agents[0]?.id ?? "");
  const [comment, setComment] = useState("");
  const [intent, setIntent] = useState<PickIntent>("fix");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sendToAgent = async () => {
    if (!api || !targetId) return;
    setSending(true);
    setError(null);
    try {
      let screenshotPath: string | undefined;
      if (payload.screenshotBase64) {
        const uploaded = await api.uploadSessionFile(targetId, {
          name: "design-pick.png",
          type: "image/png",
          dataBase64: payload.screenshotBase64
        });
        screenshotPath = uploaded.path;
      }
      const markdown = formatDesignFeedback(payload, { comment, intent, screenshotPath });
      await api.sendSessionInput(targetId, `\x1b[200~${markdown}\x1b[201~\r`);
      onClose();
    } catch {
      setError("Failed to send to agent");
      setSending(false);
    }
  };

  return (
    <div className="absolute inset-x-0 bottom-0 z-10 border-t border-neutral-700 bg-neutral-900 p-3 shadow-2xl">
      <div className="mb-2 flex items-start gap-3">
        {payload.screenshotBase64 && (
          <img
            src={`data:image/png;base64,${payload.screenshotBase64}`}
            alt="Picked element"
            className="max-h-20 max-w-[120px] rounded border border-neutral-700 object-contain"
          />
        )}
        <div className="min-w-0 flex-1">
          <div className="truncate font-mono text-xs text-sky-300">{payload.target.selector}</div>
          {payload.target.reactSource && (
            <div className="truncate font-mono text-[11px] text-neutral-400">{payload.target.reactSource}</div>
          )}
          <div className="truncate text-[11px] text-neutral-500">{payload.target.elementPath}</div>
        </div>
        <button type="button" aria-label="Dismiss" onClick={onClose}
          className="rounded p-1 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200">
          <X size={14} />
        </button>
      </div>
      <textarea
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        placeholder="What should the agent do with this element?"
        rows={2}
        className="mb-2 w-full resize-none rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-xs text-neutral-200 outline-none focus:border-neutral-500"
      />
      <div className="flex items-center gap-2">
        {(["fix", "change", "question"] as const).map((i) => (
          <button key={i} type="button" onClick={() => setIntent(i)}
            className={cn("rounded border px-2 py-0.5 text-[11px] capitalize",
              intent === i ? "border-sky-500 text-sky-300" : "border-neutral-700 text-neutral-400 hover:bg-neutral-800")}>
            {i}
          </button>
        ))}
        <div className="flex-1" />
        <select
          value={targetId}
          onChange={(e) => setTargetId(e.target.value)}
          className="max-w-[40%] rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-xs text-neutral-200"
        >
          {agents.length === 0 && <option value="">No agent session</option>}
          {agents.map((a) => <option key={a.id} value={a.id}>{a.title}</option>)}
        </select>
        <button type="button" disabled={!targetId || sending} onClick={() => void sendToAgent()}
          className="flex items-center gap-1 rounded bg-sky-600 px-3 py-1 text-xs text-white enabled:hover:bg-sky-500 disabled:opacity-50">
          <Send size={12} /> {sending ? "Sending…" : "Send"}
        </button>
      </div>
      {error && <div className="mt-1 text-[11px] text-red-400">{error}</div>}
    </div>
  );
};
```

- [ ] **Step 3: Wire into `BrowserView`** — replace the `data-pick-stub` div with:

```tsx
        {pick && (
          <PickComposeSheet payload={pick} projectPath={browser.projectPath} onClose={() => setPick(null)} />
        )}
```

plus the import, and add `export { PickComposeSheet } from "./PickComposeSheet";` to the barrel.

- [ ] **Step 4: `pnpm check` + `pnpm build`** — Expected: both clean.

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/lib/design-feedback.ts packages/ui/src/components/browser/PickComposeSheet.tsx packages/ui/src/components/browser/BrowserView.tsx packages/ui/src/components/browser/index.ts
git commit -m "$(cat <<'EOF'
Add Design Feedback compose sheet: pick → Markdown → agent PTY

Screenshot uploads through the existing session-upload route; the payload
lands as one bracketed-paste input write with a submitting CR.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: Wake wiring + grid/mobile polish pass

**Files:**
- Modify: `packages/ui/src/store/app.ts` (or wherever `wakeSessionChannels()` is invoked — grep)
- Modify: `packages/ui/src/components/browser/BrowserView.tsx` (only if Step 2 finds gaps)

- [ ] **Step 1: Wake browser channels with session channels.** Grep for `wakeSessionChannels` and add `wakeBrowserChannels()` (from Task 7) beside every call site, with the import.

- [ ] **Step 2: Grid-view audit.** In grid view `MainView` passes `active={tab.id === activeId}` to `BrowserView` (only the focused cell streams; others show the frozen last frame — spec behavior). Verify by reading the render branch you added in Task 9; if `active` is derived differently for grid (`show` vs `active`), ensure BrowserView gets **`active`** (focused-only), unlike GitView which gets `show`. Fix if wrong.

- [ ] **Step 3: `pnpm check` + commit**

```bash
git add -u packages/ui
git commit -m "$(cat <<'EOF'
Wake browser channels on visibility regain; grid streams focused cell only

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

### Task 12: Docs + deployment runbook

**Files:**
- Modify: `AGENTS.md` — add a short "Browser tabs (Design Mode)" bullet in the Features paragraph and a row in "Where to look first" (`apps/daemon/src/browsers.ts`, `packages/ui/src/components/browser/`)
- Modify: `deploy/README.md` (and `DEPLOY_TO_VPS.md.example` if it lists apt packages) — chromium provisioning:

```md
### Browser tabs (Design Mode) — host Chromium

Browser tabs need a chromium/chrome binary on the daemon host. On Ubuntu,
**do not** `apt install chromium` (it's a snap — confined, breaks under the
service's systemd hardening). Install Google Chrome's .deb instead:

    wget -q https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
    sudo apt-get install -y ./google-chrome-stable_current_amd64.deb

The daemon detects it through the registry probe; no config needed. Profiles
(cookies) live under /var/lib/orquester/daemon/browser-profiles (0700).
If Chromium can't sandbox on the host, the daemon retries with --no-sandbox
and the UI shows a shield warning on the tab.
```

- [ ] **Step 1: Make both edits.**
- [ ] **Step 2: `pnpm check`** (docs don't affect it, but keep the habit) — Expected: clean.
- [ ] **Step 3: Commit**

```bash
git add AGENTS.md deploy/README.md
git commit -m "$(cat <<'EOF'
Document browser tabs + chromium provisioning for the VPS

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

### Task 13: End-to-end verification (separate checkout — MANDATORY before calling this done)

Per repo rules this checkout's daemon must never be driven. Clone to a scratch dir and run a staging daemon on a **different port/appdir**:

- [ ] **Step 1: Stage.**

```bash
git clone /var/lib/orquester/workspaces/jaspersito/orquester "$SCRATCH/orq-staging" && cd "$SCRATCH/orq-staging"
pnpm install && pnpm build
ORQUESTER_HTTP_PORT=47999 ORQUESTER_APPDIR="$SCRATCH/orq-staging/.stage" pnpm dev:daemon &
sleep 5 && curl -fsS http://127.0.0.1:47999/health
```

(The committed `.stage` enables HTTP; stage password is `123456`. If `dev:daemon` pins the port via the script, export `ORQUESTER_HTTP_PORT` or edit the staged `.stage/daemon/daemon.json`.)

- [ ] **Step 2: API + stream verification (script or manual):**
  1. `POST /api/browsers {projectPath, url:"http://127.0.0.1:<a-vite-port>"}` (start `pnpm create vite` scratch app or use a `python3 -m http.server`) → expect a `BrowserSummary`, `browser.created` on `GET /events`.
  2. Open `wss://…/ws-browser?token=…` (a small `node` script with `ws`), send `{t:"sub",id}` → expect a `state` JSON then binary frames starting with byte `0x01` + the 36-char id.
  3. Send `{t:"viewport",mode:"mobile"}` → next frames are 390-wide JPEGs; `state.viewportMode==="mobile"`.
  4. Send `{t:"pick",on:true}` then pointer move/down/up at a known element → expect `{t:"picked"}` with selector + htmlSnippet + screenshotBase64.
  5. Create an agent session (or a bash session for PTY visibility), send the compose flow's two calls manually (`/upload` + `/input` with the bracketed-paste Markdown), then `tmux -S .stage/daemon/tmux.sock capture-pane` to confirm the Markdown + image path landed.
  6. `DELETE /api/browsers/:id` → `browser.closed` event; confirm the Chromium process exited (`pgrep -f browser-profiles` empty).
  7. Restart the staging daemon → `GET /api/browsers` still lists a recreated tab record; first `sub` relaunches and renders.
- [ ] **Step 3: SPA pass.** Open `http://127.0.0.1:47999` (staging serves the built SPA), log in, open a Browser tab: frames paint, URL bar navigates (try a public site too), viewport toggles, picker → compose sheet → sends to an agent tab. On a phone (or devtools device mode): touch scroll, pinch zoom, hidden-input typing.
- [ ] **Step 4: Kill the staging daemon and Chromiums; report results honestly** — any step that failed goes back to its task.

---

## Self-Review (performed while writing)

- **Spec coverage:** daemon manager/lifecycle (T3, T5), streaming + backpressure + prime (T3, T6), viewport model (T3, T9), UI tab + BrowserView + gating (T8, T9), picker + clamp + screenshot (T2, T3), delivery via upload + bracketed paste + CR (T10), URL suggestions (T4, T5, T9), events (T5, T8), auth (T6), sandbox fallback + warning (T3, T9), persistence/restart (T3, T13.7), shutdown + project-delete cascade (T5), docs/provisioning (T12), staging verification (T13). Gaps deliberately deferred and documented: cross-kind tab reorder (File Structure note), desktop unix-socket streaming (spec non-goal), `/proc` port attribution (spec v2).
- **Type consistency:** `BrowserSummary/BrowserStateMessage/BrowserClientMessage` names match across T1/T3/T6/T7/T8/T9; `BrowserSink` (T3) ↔ `/ws-browser` handler (T6); `formatDesignFeedback` (T10) consumed only in T10; frame header 37 bytes in both T6 (writer) and T7 (parser).
- **Placeholder scan:** the only "copy verbatim" references point to exact existing line ranges of `ws-session-channel.ts` (reconnect plumbing), which the executor has in-repo — acceptable per DRY; no TBDs remain.
```
