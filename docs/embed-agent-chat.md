# Embeddable agent chat

Every Orquester serves its agent-chat GUI as a self-contained web component that another web app can load at runtime: `<orquester-agent-chat>`. It renders one chat thread the way Orquester does — messages, reasoning, tool calls, diffs, plans, images, agent-published HTML pages, math, mermaid, highlighted code — from the frames the host app hands it. The host page needs no Orquester credentials: its own backend talks to Orquester and relays.

This document is the contract. Design and rationale: [`docs/superpowers/specs/2026-11-13-embeddable-agent-chat-design.md`](superpowers/specs/2026-11-13-embeddable-agent-chat-design.md).

## At a glance

| | |
|---|---|
| Manifest | `GET https://<orquester>/embed/manifest.json` (public, `no-cache`) |
| Bundle | `GET https://<orquester>/embed/<manifest.entry>` — an ES module (public, `immutable`) |
| Element | `orquester-agent-chat` (or any name passed to `define()`) |
| Contract version | `1` (`manifest.contract`) |
| Input | `AgentChatStreamFrame`s from `GET /api/sessions/:id/events` |
| Output | DOM events: `orquester-command`, `orquester-pending`, `orquester-resync`, `orquester-stale` |
| Data beyond frames | five host-supplied loaders (`attachment`, `visualUrl`, `history`, `item`, `itemOutput`) |
| Styling | `mode` / `scheme` attributes and the `--orq-*` CSS variables below |
| Licences | `GET https://<orquester>/embed/LICENSES.txt` |

Every `/embed/*` response carries `Access-Control-Allow-Origin: *` and `Cross-Origin-Resource-Policy: cross-origin`, needs no authentication, and holds no data. A missing file is a JSON 404. Hashed files are `Cache-Control: public, max-age=31536000, immutable`; `manifest.json`, `LICENSES.txt` and `variables.json` are `no-cache`. The bundle is served only by an Orquester that serves its web client (the HTTP transport with the built `apps/web/dist`).

## Versioning

`manifest.json`:

```json
{
  "contract": 1,
  "build": "941bffa9",
  "entry": "agent-chat.B7F-bmgt.js",
  "element": "orquester-agent-chat",
  "licenses": "LICENSES.txt"
}
```

- `contract` is bumped only on a breaking change to this document: the element's attributes, properties, methods or events, the loader signatures, the `--orq-*` names, or the frames it accepts. Additive changes keep it. A host should check it before loading and fall back (for example to plain text) when it does not know the number.
- `build` is the Orquester commit the bundle was built from.
- `entry` is the content-hashed entry module, relative to `/embed/`.

Each Orquester serves the bundle that matches its own frames, so a host loads the bundle from the same Orquester whose chat it shows. Different viewers of one host app may load different builds from different Orquesters.

## Loading

The entry module has no side effects. It exports `define(tagName?)` and `contract`.

```js
async function loadOrquesterChat(origin) {
  const base = `${origin}/embed/`;
  const manifest = await (await fetch(base + "manifest.json")).json();
  if (manifest.contract !== 1) throw new Error(`unsupported embed contract ${manifest.contract}`);
  const embed = await import(/* @vite-ignore */ base + manifest.entry);
  embed.define(); // registers <orquester-agent-chat>; returns its constructor
  return manifest;
}
```

- `define(tagName = "orquester-agent-chat"): CustomElementConstructor` registers the element, or returns the constructor this bundle already registered under that name. If one page may load two builds (for example after the viewer switches Orquester without a reload), give each its own name: ``embed.define(`orquester-agent-chat-${manifest.build}`)``. Each bundle carries its own React 18, so builds do not interfere with each other or with the page's React.
- The bundle adds exactly one thing to the page outside its own shadow roots: a `<style data-orquester-embed-fonts="<build>">` in `document.head` with KaTeX's `@font-face` rules (fonts cannot be declared inside a shadow root).
- If the host page sends a Content-Security-Policy, it must allow the Orquester origin in `script-src` and `font-src`, `blob:` in `img-src` (images are shown through object URLs), and in `frame-src` both `blob:` (HTML snippets in messages and question-option previews load as `blob:` frames) and the URLs `visualUrl` returns.

## The element

```html
<orquester-agent-chat mode="dark" scheme="mono" style="display:block;height:600px"></orquester-agent-chat>
```

It is a block element with an open shadow root. Give it a height: the thread scrolls inside it and follows the bottom while a turn runs. Sizes are in `rem`, so they follow the page's root font size (16 px gives Orquester's look).

### Attributes

| Attribute | Values | Default |
|---|---|---|
| `mode` | `dark`, `light` | `dark` |
| `scheme` | `mono`, `warm`, `slate`, `rose`, `matcha`, `dune`, `amethyst` (anything else is `mono`) | `mono` |
| `workspace-root` | the chat's project path, so changed-file paths render workspace-relative | none |

### Properties and methods

| Member | |
|---|---|
| `pushFrames(frames: AgentChatStreamFrame \| AgentChatStreamFrame[]): void` | Applies frames in order. |
| `reset(): void` | Empties the thread (before replaying another chat into the same element). |
| `loaders: EmbedLoaders` | Get/set at any time; see [Loaders](#loaders). Only functions under the five known names are kept. |
| `respondFailed(commandId: string, message?: string): void` | The host could not deliver an `orquester-command`: re-enables the card and shows `message` above it. |
| `readonly sessionId: string \| null` | The thread the frames describe. |

### Events

All are `CustomEvent`s with `bubbles: true` and `composed: true`, fired on the element.

| Event | `detail` | When |
|---|---|---|
| `orquester-command` | `{ sessionId, command: "answer" \| "dismiss" \| "approval", body }` | The user answered, dismissed or decided a pending question or approval. `body` is exactly `AnswerCommandBody`, `DismissCommandBody` or `ApprovalCommandBody` (`packages/api/src/agent-chat/wire.ts`), including an element-minted `commandId`. POST `body` unchanged to `/api/sessions/:sessionId/<command>`. The card stays "responding" until the frames show the request settled, or `respondFailed(commandId)` is called. Retrying with the same `commandId` is safe: commands are idempotent by it. |
| `orquester-pending` | `{ sessionId, pending: Array<{ requestId, kind: "question" \| "approval" }> }` | Only when the set of open questions/approvals changes — not on connect, on frames that leave it as it was, or on a `reset()` of a thread with none open (an element starts with an empty set, so a thread with nothing open never fires it). The element has no "answer by typing" bridge: while `pending` is non-empty, a host with its own text field should hold it or point the user at the card. |
| `orquester-resync` | `{ sessionId }` | A `synchronized` frame named a different agent-host instance. Reopen the stream **without** `after`; its fresh `snapshot` replaces the thread. |
| `orquester-stale` | `{ build }` | A lazily loaded chunk of this bundle failed (usually: the Orquester redeployed under the page). The affected block degrades (math and diagrams show their source, code is unhighlighted). The host may re-read the manifest and remount. The bundle neither dispatches nor listens to Vite's `vite:preloadError`, so a Vite-built host page's own reload-on-chunk-failure handler never fires for the embed's chunks, and its chunk failures never fire this event. |

## Input: frames

Feed the element the parsed JSON lines of `GET /api/sessions/:id/events` (NDJSON), in order, through `pushFrames`.

- Open the stream with **neither** `window` nor `agentRows`. The first frame is then a `snapshot` of the thread's whole retained window, followed by `event` frames and `synchronized`.
- Drop the `:hb` heartbeat lines yourself (they are not JSON).
- Anything whose `kind` this bundle does not know — including `{ "kind": "error" }` lines — is ignored with a console warning and never changes the thread, so a newer frame kind cannot break an older bundle. Handle `error` lines in your relay (reconnect, or stop on `THREAD_NOT_FOUND`).
- On reconnect, use `?after=<last seq>`; on `orquester-resync`, reconnect without it.
- Relay frames verbatim; the element is built from the same Orquester as the frames and understands them. Do not reshape them.

**History of a closed chat.** Store one snapshot frame when the chat settles — `{ "kind": "snapshot", "thread": <GET /api/sessions/:id/thread> }` — and replay it with `reset()` then `pushFrames(snapshot)`. Storing every frame gives the same result at a much larger size: replay folds through the same retained window (the latest 500 activities and 2,000 messages). Turns older than that window and full tool outputs come from the daemon on demand through the `history`, `item` and `itemOutput` loaders, so they need the chat to still exist on that Orquester. A newer bundle replays frames written by an older Orquester.

## Loaders

The element never talks to Orquester. Everything beyond the frames comes through five async functions the host sets on `el.loaders`. Each returns what the daemon's route returns; proxy them through your backend (with your `orq_…` token) after checking the viewer may see that chat. Every loader is optional; a missing one hides its affordance, and one that rejects shows the GUI's usual "unavailable" state.

```ts
interface EmbedLoaders {
  attachment?(request: { sessionId: string; attachmentId: string; mimeType?: string }, signal?: AbortSignal): Promise<Blob>;
  visualUrl?(request: { sessionId: string; attachmentId: string }): Promise<string>;
  history?(request: { sessionId: string; before?: string; turns?: number; windowCut?: string }, signal?: AbortSignal): Promise<ThreadHistoryPage>;
  item?(request: { sessionId: string; itemId: string }, signal?: AbortSignal): Promise<ThreadItemResponse>;
  itemOutput?(request: { sessionId: string; itemId: string; offset?: number; maxBytes?: number }, signal?: AbortSignal): Promise<ThreadItemOutputResponse | ThreadItemOutputWindowResponse | null>;
}
```

| Loader | Used for | Daemon route to proxy |
|---|---|---|
| `attachment` | every image: `show_image`, image attachments in messages and tool results | `GET /api/sessions/:id/attachments/:attachmentId` (return the body as a `Blob`) |
| `visualUrl` | `html_render` pages | `POST /api/sessions/:id/visuals/:attachmentId/url` → `{ path, expiresAt }`, then `GET <path>` on the Orquester (signed, valid ≤ 15 min, no bearer needed) |
| `history` | "Load older turns" at the top of a thread whose window was cut | `GET /api/sessions/:id/history?before=&turns=&windowCut=` |
| `item` | "Load full output", together with `itemOutput`: a cut tool result, a cut compaction summary ("Load the full summary"), a cut agent prompt ("Show full prompt") | `GET /api/sessions/:id/items/:itemId` |
| `itemOutput` | "Load full output", together with `item`: a command's streamed output (frames carry a one-line summary). Resolve `null` where the route answers 404; the element then reads the item | `GET /api/sessions/:id/items/:itemId/output?offset=&maxBytes=` |

**"Load full output" needs both `item` and `itemOutput`.** A row's whole output is in its item or in its call's streamed output, and which one is known only once the first read answers, so with only one of the two loaders set the element offers none of the full-output controls.

**HTML pages.** `visualUrl` returns a URL the element loads in an iframe with `sandbox="allow-scripts allow-forms"` (never `allow-same-origin`), so the agent's page runs in an opaque origin wherever it is served from. The recommended proxy serves the page from the host's own origin: mint the signed URL, fetch it from the Orquester, and return its body with its response headers — keep `Content-Security-Policy: sandbox allow-scripts allow-forms allow-popups allow-downloads` and add `frame-ancestors` for your origin. (Framing the Orquester's signed URL directly does not work behind the stock `deploy/Caddyfile`, which sends `frame-ancestors 'self'` for `/api/agent-visuals/*`.)

**Images in markdown** that point at workspace files (not chat attachments) are not loaded by the embed; they render as their alt text or link.

## What the embed shows, and what it leaves out

Shown: the whole timeline (messages, reasoning, tool calls and their output summaries, plans, file changes and inline diffs, subagent rows as recorded, images, HTML pages and snippets, math, mermaid, code), the running-turn state, and the pending question/approval cards.

Left out (the full Orquester app only): the composer, rewind, fork, "continue in…", quoting into a composer, the turn-diff viewer, opening files or tabs, the subagent drill-in, MCP App frames (shown as a plain tool line), saving images to a project, attachments in question answers, secret requests (`request_secret`) and MCP tool approvals — the last two live only in the daemon's REST state, never in frames; a host that needs them can read `GET /api/sessions/:id/secret-requests` and `…/tool-approvals` itself.

## Theming

The element looks like Orquester by default. `mode` and `scheme` pick one of Orquester's palettes; the variables below override any value. Example:

```css
orquester-agent-chat {
  --orq-n-950: 11 14 20;
  --orq-n-900: 17 21 30;
  --orq-n-100: 236 239 244;
  --orq-sem-info-400: 99 102 241;
  --orq-font-sans: "Inter", system-ui, sans-serif;
}
```

## CSS variables

Set these on the element or any ancestor; custom properties inherit through the shadow root. An unset variable keeps Orquester's value for the current `mode` and `scheme`. Every build publishes the same list in `/embed/variables.json`.

- **Neutrals**, RGB triples without `rgb()` (`--orq-n-900: 18 18 18`): `--orq-n-50`, `--orq-n-100`, `--orq-n-200`, `--orq-n-300`, `--orq-n-400`, `--orq-n-500`, `--orq-n-600`, `--orq-n-700`, `--orq-n-800`, `--orq-n-900`, `--orq-n-950`
- **Danger**, RGB triples: `--orq-sem-danger-200`, `--orq-sem-danger-300`, `--orq-sem-danger-400`, `--orq-sem-danger-500`, `--orq-sem-danger-600`, `--orq-sem-danger-800`, `--orq-sem-danger-900`, `--orq-sem-danger-950`, `--orq-sem-danger-muted`
- **Warning**, RGB triples: `--orq-sem-warn-50`, `--orq-sem-warn-300`, `--orq-sem-warn-400`, `--orq-sem-warn-500`, `--orq-sem-warn-700`, `--orq-sem-warn-900`, `--orq-sem-warn-950`, `--orq-sem-warn-muted`, `--orq-sem-warn-500-muted`
- **OK**, RGB triples: `--orq-sem-ok-300`, `--orq-sem-ok-400`, `--orq-sem-ok-500`, `--orq-sem-ok-900`, `--orq-sem-ok-vivid`, `--orq-sem-ok-muted`, `--orq-sem-ok-70-muted`
- **Info**, RGB triples: `--orq-sem-info-300`, `--orq-sem-info-400`, `--orq-sem-info-500`, `--orq-sem-info-900`
- **Diff bands**, full colour values (`rgb(5 46 22 / 0.4)`): `--orq-diff-add-bg`, `--orq-diff-add-fg`, `--orq-diff-del-bg`, `--orq-diff-del-fg`
- **Fonts**, full `font-family` values: `--orq-font-sans`, `--orq-font-mono`

## Licences

The bundle is MIT-licensed Orquester code, including parts ported from T3 Code (MIT), plus third-party packages under their own licences. `GET /embed/LICENSES.txt` holds Orquester's `LICENSE`, `docs/THIRD_PARTY_NOTICES.md`, and the licence text of every npm package in the bundle; the entry module starts with a banner pointing at it. Keep that file reachable wherever you redistribute the bundle.

## Building

`pnpm --filter @orquester/web build` builds the web client and then the embed (`apps/web/vite.embed.config.ts`) into `apps/web/dist/embed/`. The embed build fails if any module of the full app (the app store, the API client context, the thread store, the composer) ends up in the bundle; `ORQUESTER_EMBED_GUARD=report` lists them instead of failing. The element's source is `apps/web/src/embed/`; the chat's render path reads app-only behaviour through `ChatHost` (`packages/ui/src/components/agent-chat/chat-host.tsx`).
