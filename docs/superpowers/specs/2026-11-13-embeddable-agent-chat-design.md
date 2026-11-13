# Embeddable agent chat: Orquester's chat GUI as a web component other apps load

Status: approved by the owner (2026-11-13), including older history and full tool output in v1; builder check done. Approach chosen by the owner: **A** (a web component fed with frames that the host app's backend relays). The product word is "embed"; in code, `embed` / `agent-chat embed`.

## 1. Intent

QORVI (the qorvi.es console: React 19 + Vite, Bun/Hono backend) will stop holding its own AI keys and run all of its AI through Orquester. Each QORVI member connects **their own** Orquester (domain + `orq_…` token) from their account. QORVI's backend opens chats there (`POST /api/sessions`, workspace `qorvi_api`, its own Agent Profile, `runtimeMode: "full-access"`, `unattended: true`), sends turns (`POST /api/sessions/:id/turn`) and reads `GET /api/sessions/:id/events`. Those chats power **One** (the console's assistant) and the **Auditor** (code and server reviews). The Auditor's agents publish reports with `show_image` and `html_render`.

The owner wants QORVI to show those chats with **Orquester's own chat GUI**, not a copy. When Orquester updates on GitHub and a member's server redeploys, QORVI should pick up the new GUI with no code copied and no QORVI release. The component ships looking like Orquester; QORVI restyles it later to match its dashboard through a documented set of CSS variables.

## 2. Goals, non-goals, anti-goals

**Goals (v1)**

- Every Orquester serves a self-contained, versioned bundle at public `/embed/*` URLs. It defines a custom element that renders one agent-chat thread the way Orquester's GUI does.
- The element renders from `AgentChatStreamFrame`s it is handed, either live (pushed as they arrive) or replayed from storage for a closed chat.
- Images (`show_image`, image attachments) and HTML visuals (`html_render`) render through loaders the host app supplies. QORVI's backend proxies them.
- Older history ("load older") and full tool output ("show full output") also work through host loaders, so a long Auditor chat can be read whole.
- Questions and approvals are answerable. The element emits a command event, and the host's backend forwards it to the daemon.
- The look is themable from outside through `--orq-*` CSS variables, plus `mode` and `scheme` attributes.
- Orquester's own app renders exactly as it does today.

**Non-goals (v1)**

- A composer. QORVI keeps its own text field and sends turns itself.
- Any transport inside the element: no fetch to Orquester, no token, no WebSocket.
- Rewind, fork, "continue in…", quote-to-composer, the turn diff modal, saving images or revealing them in files, opening tabs (subagent threads, desktops, devices, files, knowledge entries), the subagent drill-in, and MCP App frames.
- Attachments in question answers, and answering a question by typing into the host's own text field (§5.4 `orquester-pending`).
- Secret requests (`request_secret`) and MCP tool approvals. Both live only in daemon REST state, never in frames, so the embed cannot see them (§5.6).
- An npm package. QORVI loads the bundle at runtime from the viewer's Orquester.
- `::part` styling hooks and themable radii or spacing. These are not in the contract yet.

**Anti-goals (a failure even if it works)**

- An Orquester token, or any credential, reaching the browser.
- Agent HTML gaining access to the embedding page's origin (QORVI's cookies, storage or DOM).
- Orquester's Tailwind leaking into QORVI's page, or QORVI's CSS breaking the chat.
- Any visible change to Orquester's own chat GUI caused by the refactor.
- The embed silently dragging the whole app (`store/app`, the API client, the thread store) into its bundle.

## 3. Constraints found in the code

- The render chain is pure: `foldThread` / `applyDomainEvent` (`packages/api/src/agent-chat/fold.ts`) → `deriveTimelineEntriesFromItems` (`entries.logic.ts`) → `deriveTimelineRowsWithState` (`rows.logic.ts`) → `ChatTimeline`, configured through `TimelineRowContext` (which has `readOnly`).
- Frames are more than events. The stream sends `snapshot`, `event`, `synchronized`, `history-import` and `agent-rows` frames. The client reducer `packages/ui/src/lib/agent-chat/reducer.logic.ts` (`createReducerState`, `applyFrame`, `needsResync`) already turns them into the thread slice the timeline reads, without React or zustand. The embed reuses it.
- The fold keeps a retained window: 500 activities, 2,000 messages (`ACTIVITY_RETENTION_LIMIT`, `MESSAGE_RETENTION_LIMIT` in `fold.ts`). A stream opened without `window` sends that whole window, not the whole thread. Older turns come from `GET …/history?before=&turns=`. Replaying every stored frame goes through the same fold, so it evicts the same rows. Storing frames does not get around the window.
- Frames are slimmed (`packages/api/src/agent-chat/slim.ts`): long strings are capped, and a tool's text output becomes one summary line. The full output comes from `GET …/items/:itemId/output` (optionally `?offset=&maxBytes=`).
- The stream also carries `{ kind: "error" }` lines and `:hb` heartbeats, which are not frames. `applyFrame` has no default branch, so an unknown kind would corrupt the state.
- Secret requests and MCP tool approvals are daemon REST state (`secretRequests`, `toolApprovals` routes), never frames.
- Question and approval cards are mounted by `AgentChatView` through `ChatBannerDock`, not by `ChatTimeline`. In the app, typing in the composer while a question is open answers it (`question-composer-bridge`).
- Deploys rebuild `apps/web/dist` in place (`deploy/lib/remote-update.sh`). A page that loaded bundle N can find its lazy chunks gone after a redeploy.
- The theme colours handed to agent HTML pages are read from `document.documentElement` (`lib/theme.ts`). In the embed that is the host's page.
- These modules reach the full app from the render path and must be cut:
  - `ChatTimeline` → `peekThreadStore`
  - `ChatMarkdown` and `use-visual-theme` → `useAppStore` (mode and scheme)
  - `ActivityRows` → `useAppStore`, `sessionProfilesStore`
  - `ImageRow` → `toolApprovalsStore`
  - `chat-image.ts`, `VisualFrame`, `TurnDiffModal`, `ChatImageActions`, `SaveImageDialog` → `useApi()`
  - `DesktopRowLink`, `DeviceRowLink`, `KnowledgeCitation` → `useAppStore`
  - `QuoteSelectionToolbar`, `image-actions.ts`, `MessageRows` (`ComposerPopover`, `RewindControl`) and `row-chrome.ts` → `composer/`
  - `QuestionCard` → `composer/tab-visibility`, `question-composer-bridge`, and `attention/GlobalShortcutListener` (which uses `useApi` and `useAppStore`)
  - `DeviceRowLink` → `lib/devices/hooks.ts` (`useAppStore`); `KnowledgeCitation` → `lib/knowledge/store` and `useOptionalApi`
  - `ChatImageLightbox`, `MermaidBlock` and `VisualViewer` import the `components/ui` barrel, whose `session-status-dot.tsx` and `password-verify` reach `store/app`
- `@orquester/ui` is source-only (`./src/index.ts`, `noEmit`) with React 18 as a peer. QORVI runs React 19, so the bundle carries its own React 18.
- KaTeX, mermaid (`pele/lazy`) and the language catalog load through `import()`. The bundle is therefore an ES module with lazy chunks, and a cross-origin module script needs CORS headers.
- The daemon already serves `apps/web/dist` through `fastifyStatic` (`apps/daemon/src/index.ts`, `serveWeb`) with no auth outside `/api`, `/events` and `/mcp`. A miss falls back to `index.html`.
- `frame-ancestors 'self'` for agent visuals is set by `deploy/Caddyfile`, not by the daemon. The visual iframe is `sandbox="allow-scripts allow-forms"` without `allow-same-origin`, and the page is served with the sandbox CSP. It is an opaque origin wherever it is served from.
- The colour schemes are data: `[data-mode]` and `[data-scheme]` blocks of RGB triples (`--n-50…950`, `--sem-*`, `--diff-*`) in `packages/ui/src/styles/globals.css`, consumed by `tailwind-preset.ts` as `rgb(var(--x) / <alpha>)`.
- In Chromium, `@font-face` rules inside a shadow root do not register. KaTeX's fonts have to be declared at document level.
- Every QORVI viewer may point at a different Orquester, of a different version. Frames and bundle always come from the same Orquester, so a bundle never has to read another version's live frames. Stored frames, however, are replayed by whatever bundle the viewer's Orquester serves later.

## 4. Approaches (decided)

- **A. Web component with relayed frames (chosen).** QORVI's backend relays the NDJSON frames and proxies images and HTML. The token never leaves the server, theming is a CSS-variable contract, and the element lives in QORVI's DOM (height, scroll, selection). The cost: QORVI keeps the relay and the proxies, and Orquester has to isolate its Tailwind and portals inside a Shadow DOM.
- **B. Iframe with a signed read-only link.** Orquester would mint a short-lived view URL and the iframe would read the stream itself. No relay and no CSS clash, but it adds a new credential type to Orquester (anyone holding the URL sees the chat until it expires), theming goes through `postMessage`, and height needs coordination. Rejected because it widens Orquester's auth surface.
- **C. npm package.** Rejected: QORVI would need a release for every Orquester update and could not match each member's version.

## 5. Design

### 5.1 Where the code lives

- **`packages/ui`**: the leak removal (§5.6). The render path reads everything app-specific from one injected host context, and the app supplies it from its stores.
- **`apps/web/src/embed/`**: the custom element, its React root, the reducer wiring and the shadow-DOM style loading. Embed-specific delivery code belongs to the web client app, which already owns emitted web assets.
- **`apps/web/vite.embed.config.ts`**: a second Vite build. Entry `src/embed/index.ts`, ES format, React bundled, output `dist/embed/`, `emptyOutDir: false`. It runs after the SPA build from `apps/web`'s `build` script, so the existing `pnpm build` and deploy paths emit it with no new root script.
- **`apps/daemon`**: headers for `/embed/*` and a JSON 404 for embed misses (§5.2). No new route: `fastifyStatic` already serves the files.

### 5.2 Serving and versioning

Files under `https://<orquester>/embed/`:

- `manifest.json`: not hashed, `Cache-Control: no-cache`.
- `agent-chat.<hash>.js`: the entry module.
- `chunks/<name>.<hash>.js`: lazy chunks (KaTeX, mermaid, languages).
- `fonts/…`: KaTeX fonts.
- `LICENSES.txt`.

Hashed files are served with `Cache-Control: public, max-age=31536000, immutable`.

The daemon adds two headers to every `/embed/*` response: `Access-Control-Allow-Origin: *` and `Cross-Origin-Resource-Policy: cross-origin`. The files hold no data, so they stay public and open to any origin. That is what lets many QORVI viewers load from many Orquesters. The not-found handler treats `/embed` as reserved, so a stale hash gets a JSON 404 instead of `index.html`. Caddy needs no change: its `@app` headers on a JS file are harmless, and it passes the CORS headers through.

`manifest.json`:

```json
{
  "contract": 1,
  "build": "17a7d7a3",
  "entry": "agent-chat.3f9a2c1d.js",
  "element": "orquester-agent-chat",
  "licenses": "LICENSES.txt"
}
```

- `contract` is an integer, bumped only on a breaking change to the element's API, its events, the `--orq-*` names or the frame format it accepts. Additive changes keep it.
- `build` is the short git commit (`__ORQUESTER_BUILD__`, the same id the app reports).
- QORVI can read the manifest from its backend or its page before loading anything.

### 5.3 Loading

The entry module has no side effects. It exports `define(tagName = "orquester-agent-chat"): CustomElementConstructor`, which registers the element under that name (or returns the existing constructor when the name is already registered by this same bundle), and `contract: 1`.

```js
const base = "https://orq.example.com/embed/";
const manifest = await (await fetch(base + "manifest.json")).json();
if (manifest.contract !== 1) { /* fall back: plain text */ }
const embed = await import(/* @vite-ignore */ base + manifest.entry);
embed.define();                              // <orquester-agent-chat>
// or, if a page might load two versions: embed.define(`orquester-agent-chat-${manifest.build}`)
```

Each bundle carries its own React, so two versions on one page do not interfere as long as they use different tag names.

### 5.4 The element

`<orquester-agent-chat>` is a block element with an open shadow root. The host gives it a height; the thread scrolls inside it and follows the bottom while a turn runs, as the GUI does today.

**Attributes**

- `mode`: `dark` (default) or `light`.
- `scheme`: `mono` (default), `warm`, `slate`, `rose`, `matcha`, `dune` or `amethyst`. These are Orquester's schemes.
- `workspace-root`: optional. A project path, so changed-file paths render workspace-relative.

**Properties and methods**

- `pushFrames(frames: AgentChatStreamFrame | AgentChatStreamFrame[]): void` applies frames in order through the existing `applyFrame`. Feed it the parsed JSON lines of `GET /api/sessions/:id/events`. Drop the `:hb` heartbeats yourself. Anything whose `kind` is not a frame kind the bundle knows (including `{ kind: "error" }` lines) is ignored with a console warning and never changes the thread, so a newer frame kind cannot break an older bundle.
- `reset(): void` empties the thread. Use it before replaying another chat into the same element.
- `loaders: { attachment, visualUrl, history, item, itemOutput }` is a property, settable at any time (§5.5).
- `respondFailed(commandId: string, message?: string): void` re-enables a question or approval card after the host could not deliver its command.
- `sessionId: string | null` is read-only: the thread the frames describe, taken from the snapshot or events.

**Events**

All events are `CustomEvent`s with `bubbles: true, composed: true`.

- `orquester-command`. The user answered, dismissed or decided on a pending request. `detail` is `{ sessionId, command: "answer" | "dismiss" | "approval", body }`, where `body` is exactly `AnswerCommandBody`, `DismissCommandBody` or `ApprovalCommandBody` from `packages/api/src/agent-chat/wire.ts`, including a `commandId` minted by the element. The host POSTs `body` unchanged to `/api/sessions/:sessionId/<command>`. The card stays in its responding state until the frames show the request settled, or until `respondFailed(commandId)` is called. Retrying with the same `commandId` is safe: the daemon's receipts make commands idempotent.
- `orquester-pending`. Fired whenever the set of open questions or approvals changes. `detail: { sessionId, pending: Array<{ requestId, kind: "question" | "approval" }> }`. A host with its own text field should hold it, or route the user to the card, while `pending` is non-empty: v1 has no "answer by typing" bridge.
- `orquester-stale`. A lazy chunk failed to load, which typically means the Orquester redeployed under the page. The affected block degrades: math and mermaid show their source, code shows unhighlighted. The host may re-read the manifest and reload the element. `detail: { build }`.
- `orquester-resync`. A `synchronized` frame named a different host instance (`needsResync`), so the host should reopen the stream **without** `after`. The fresh `snapshot` frame replaces the thread. `detail: { sessionId }`.

**Input format, and what QORVI's backend should do**

- Open `GET /api/sessions/:id/events` with **neither** `window` nor `agentRows`. The snapshot is then whole and needs no paging or agent-row loading, which v1 does not do.
- Relay each NDJSON line to the page as-is (SSE or WebSocket) and `pushFrames` it.
- On reconnect, use `?after=<last seq>`.
- History of a closed chat: store one snapshot frame when the chat settles, built from `GET /api/sessions/:id/thread` as `{ kind: "snapshot", thread }`, and replay it with `reset()` + `pushFrames(snapshot)`. Storing every frame gives the same result at a much larger size, because replay folds through the same retained window (§3). Turns older than that window, and full tool outputs, come from the daemon on demand through `history`, `item` and `itemOutput`, so they need the chat to still exist on that Orquester. A newer bundle can replay older frames: the fold reads events written by older versions, as the daemon does with its own logs.

### 5.5 Loaders: images, HTML visuals, older history, full output

The element never talks to Orquester. Everything beyond the frames comes through five async loaders the host sets on `el.loaders`. Each loader's result is the daemon's own response for that route, so QORVI's proxies forward it unchanged after checking that the viewer owns the session.

| Loader | Called for | Returns | Daemon route the host proxies |
|---|---|---|---|
| `attachment({ sessionId, attachmentId, mimeType? }, signal)` | every image the thread shows: `show_image`, image attachments in messages and tool results | `Promise<Blob>` | `GET /api/sessions/:id/attachments/:attachmentId` |
| `visualUrl({ sessionId, attachmentId })` | `html_render` pages | `Promise<string>`: a URL the iframe loads | `POST /api/sessions/:id/visuals/:attachmentId/url`, then `GET` of the returned signed `path` |
| `history({ sessionId, before?, turns?, windowCut? }, signal)` | the "load older" row at the top of a thread whose window was cut | `Promise<ThreadHistoryResponse>` | `GET /api/sessions/:id/history?before=&turns=` |
| `item({ sessionId, itemId }, signal)` | "show full output", with `itemOutput`: a cut tool result, compaction summary or agent prompt | `Promise<ThreadItemResponse>` | `GET /api/sessions/:id/items/:itemId` |
| `itemOutput({ sessionId, itemId, offset?, maxBytes? }, signal)` | "show full output", with `item`: a command's streamed output | `Promise<ThreadItemOutputResponse \| ThreadItemOutputWindowResponse \| null>` (`null` for the route's 404) | `GET /api/sessions/:id/items/:itemId/output` |

Notes:

- `attachment` replaces what the app does today through the API client's bearer-authenticated binary channel (`chat-image.ts` `fetchAttachment`). The element turns the `Blob` into an object URL, as it does now.
- `visualUrl`: the element loads the URL in the same iframe as today, `sandbox="allow-scripts allow-forms"`, never `allow-same-origin`. QORVI's proxy serves the page from its own origin with Orquester's response headers. It must keep `Content-Security-Policy: sandbox …` and should add a `frame-ancestors` for its own origin. The page stays an opaque origin with no access to QORVI's session. No Orquester-side `frame-ancestors` change is needed. A per-Orquester allow-list of framing origins is left for later, in case a host would rather frame Orquester's signed URL directly.
- HTML snippets inside messages (the existing blob-URL `VisualSnippet`) need no loader.
- A missing loader hides its affordance (no "load older", no "show full output"). "Show full output" needs both `item` and `itemOutput`: which of the two reads a row needs is known only once the first answers (the app's `readFullOutput`). A loader that rejects shows the same "unavailable" state the GUI shows when a read fails.
- Workspace-file images in markdown (`readFileBytes` today) are not loaded in v1; they render as their alt text or link.

### 5.6 Cutting the render path loose (`packages/ui`)

One React context, provided by whoever mounts the timeline, carries everything app-specific the render path needs:

- the resolved mode and scheme;
- the five loaders of §5.5 (the app fills them from its API client);
- the theme colours handed to agent HTML pages, read from the embed's own wrapper rather than `document.documentElement`;
- the portal container for popovers, the lightbox and menus. The embed passes a node inside its shadow root; the app passes `document.body`;
- optional callbacks or data for the app-only affordances: open a tab or thread, read profiles and accounts for activity labels, the tool-approval wait state, quote to composer, image save and reveal, the turn diff, and reading a full plan from the thread store.

In the app, `AgentChatView` fills the context from `useAppStore`, `useApi`, the stores and the composer bridge, so behaviour is unchanged. In the embed, the optional affordances are absent and their controls are not rendered.

The concrete edits:

- Replace each import listed in §3 on the render path (`timeline/`, `timeline/rows/`, `timeline/markdown/`, `images/`, `visual/`, `banners/QuestionCard.tsx`, `banners/ApprovalCard.tsx`) with a read from that context.
- Pure helpers currently under `composer/` that rows use (`splitLeadingQuotes`, `skillMentionsInText`) move next to their users or into `lib/agent-chat`, so importing them pulls no composer code.
- `ChatTimeline` reads the full plan and remembers scroll through the context instead of `peekThreadStore`. The store-less path (`readPlanWithoutStore`) already exists.

`DesktopRowLink`, `DeviceRowLink`, `KnowledgeCitation` and thread links fall back to inert text when no opener is provided. `McpAppRow` falls back to the plain tool-call row. The embed mounts `QuestionCard` and `ApprovalCard` itself, beside the timeline, without the composer bridge or attachments. Secret requests and MCP tool approvals are daemon REST state, not frames, so the embed cannot show them. QORVI's unattended chats should not need either; a host that does can poll `GET …/secret-requests` itself.

Two guards keep the leaks from coming back:

- **Build guard.** The embed's Vite config fails the build when a module that ends up in the emitted bundle (Rollup's rendered module list, after tree-shaking) is `src/store/app`, `src/context/orquester-context`, `src/lib/agent-chat/store` or anything under `src/components/agent-chat/composer/`. It checks the output rather than the resolution, because barrels such as `components/ui` import `store/app` through modules that tree-shaking drops.
- **Render test.** A `*.dom.test.ts` in `packages/ui` renders `ChatTimeline` from a frame fixture with no app providers or stores.

### 5.7 Styles inside the Shadow DOM

The embed build compiles its own Tailwind CSS: the shared preset, with `content` limited to the embed and the chat components. It imports the CSS as a string and adopts it into the shadow root (`adoptedStyleSheets`, with a `<style>` fallback). The inner root is a wrapper element carrying `data-mode` and `data-scheme`, so the existing `[data-mode]` and `[data-scheme]` selectors apply unchanged. A PostCSS step in the embed build only does two things:

- rewrites `:root`, `html` and `body` selectors to `:host` or the wrapper;
- rewrites every `--n-*`, `--sem-*` and `--diff-*` declaration in the theme blocks to `--x: var(--orq-x, <Orquester's value>)`.

Lazily loaded CSS (KaTeX's stylesheet) is imported as a string and adopted into the shadow root, not injected into `document.head`. KaTeX's `@font-face` rules are the one thing written to the document: a single `<style data-orquester-embed-fonts>` tag with absolute font URLs on the Orquester origin. It is added once per bundle version.

Tailwind's sizes are in `rem`, so they follow the host page's root font size (16px gives Orquester's look).

### 5.8 The style contract (`--orq-*`)

These variables are set on the element or on any ancestor; custom properties inherit through the shadow root. Each takes an RGB triple **without** `rgb()`, e.g. `--orq-n-900: 18 18 18`, because Tailwind composes alpha onto them. When a variable is unset, Orquester's value for the current `mode` and `scheme` applies.

- **Neutrals**, the surfaces and text of the whole GUI: `--orq-n-50`, `-100`, `-200`, `-300`, `-400`, `-500`, `-600`, `-700`, `-800`, `-900`, `-950`. In dark mode 950 is the deepest surface and 50 the brightest text; light mode flips them.
- **Semantic**, status colours, using the step names in `globals.css`:
  - `--orq-sem-danger-{200,300,400,500,600,800,900,950,muted}`
  - `--orq-sem-ok-{300,400,500,900,muted,70-muted,vivid}`
  - `--orq-sem-warn-{50,300,400,500,500-muted,700,900,950,muted}`
  - `--orq-sem-info-{300,400,500,900}`
- **Diff bands**: `--orq-diff-add-bg`, `--orq-diff-add-fg`, `--orq-diff-del-bg`, `--orq-diff-del-fg`. These are full colour values (`rgb(5 46 22 / 0.4)`), as in `globals.css`.
- **Fonts**: `--orq-font-sans` and `--orq-font-mono`, full `font-family` values. These two are new and exist only in the embed's CSS. They default to the app's literal stack on `body` (`globals.css`) and to the preset's mono stack.

The colour list is generated from `globals.css` at build time and documented in `docs/embed-agent-chat.md`. The test asserts that the generated list matches the documented one. Orquester has no accent variable: its look is neutral-based, so a QORVI accent maps onto the neutrals and the semantic `info` steps.

### 5.9 Licences

- `dist/embed/LICENSES.txt` holds Orquester's `LICENSE` (MIT), `docs/THIRD_PARTY_NOTICES.md` (T3 Code, MIT, and the other ports), and the licence text of every npm package that ends up in the bundle, collected from the build's module list.
- The entry chunk starts with a `/*! Orquester agent-chat embed — MIT — see LICENSES.txt */` banner that minification keeps.
- `// Ported from T3 Code (MIT)` markers in the source stay where they are.

### 5.10 Tests and checks

- **`packages/ui`**: the store-less timeline render test (§5.6).
- **`apps/web`**: a jsdom test of the element. It covers:
  - `pushFrames` of a fixture shows the messages, and `reset()` empties the thread;
  - answering a pending question fires `orquester-command` with an `AnswerCommandBody`, and `respondFailed` re-enables the card;
  - a `show_image` row calls `attachmentUrl`;
  - an `html_render` row calls `visualUrl`;
  - a `synchronized` frame from a new host instance fires `orquester-resync`;
  - an open question fires `orquester-pending`, and an unknown frame kind leaves the thread unchanged;
  - "load older" calls `history`, and "show full output" reads through `item` and `itemOutput`.
- **`apps/daemon`**: `/embed/*` carries the CORS, CORP and cache headers, and a missing embed file is a JSON 404, not `index.html`. Through the existing HTTP routing tests.
- **Build**: the import guard (§5.6) and the generated-variables check (§5.8).
- **Manual**, in a separate worktree, with no daemon involved:
  - `pnpm build`;
  - serve `apps/web/dist` on one port;
  - load the bundle from a static test page on another port, with recorded frames that include an image and an HTML page;
  - screenshot the stock look, a light-mode render and an `--orq-*` override;
  - screenshot Orquester's own chat before and after to show nothing changed.
- `pnpm check:changed` and the relevant package tests before committing.

### 5.11 Deliverable for QORVI

`docs/embed-agent-chat.md` is the contract: manifest URL and shape, loading snippet, element name, attributes, properties, methods, events, the frame input rules from §5.4, the resolvers and what the proxies must forward, the `--orq-*` list, the `contract` versioning rule, and the licences. `README.md` links it.

## 6. Left to the builder

- The context's name and exact shape, provided the app's behaviour is unchanged and the embed path imports none of the modules in §5.6's build guard.
- How the licence list is collected. Prefer a small Rollup hook over a new dependency.
- How the PostCSS rewrite is written, and whether the theme-block detection keys on `[data-mode]` selectors or on variable prefixes.
- The fixtures for tests. Reuse the provider replay fixtures under `apps/daemon` or `packages/api` where a recorded thread already has images or visuals.
