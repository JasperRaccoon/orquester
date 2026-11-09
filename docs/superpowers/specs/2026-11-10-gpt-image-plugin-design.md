# Images in chats: show any image, and generate with GPT Image on a ChatGPT plan

Status: design for owner review (2026-11-10); builder check done. "GPT Image" is the product word; the code can say `images` / `image-gen`.

## 1. Intent

The owner wants to tell any chat "generate with gpt image a picture of a dog", or paste an icon and say "turn this into a liquid glass style with gpt image", and get the picture back in the chat within seconds. Generation should run on the ChatGPT plan behind a Codex account already connected in Settings → Accounts, so a $20 Plus account works and no API key or per-image charge is involved.

Several community tools do this today (research notes, 2026-11-10):

- **`codex exec` wrappers**: oakplank/gpt-image-bridge, and the note.com article by mauekusa. They take 4–6 minutes per image because a reasoning agent sits in front of the tool, they have no structured options, and they depend on the agent obeying a prompt.
- **Direct callers**: Connected-Mate/gptimage, the-jey/codex-sub-imagen and egoist/gpt-image. They are fast, but they refresh Codex's rotating token with no coordination, so Codex itself can end up signed out.

Orquester is better placed than either kind. It already holds each Codex account's `auth.json`, already calls `chatgpt.com/backend-api` with those tokens (usage polling, `apps/daemon/src/usage-sources.ts`), and already refreshes Codex tokens through one de-duplicated refresher that coordinates with live Codex chats (`apps/daemon/src/agent-accounts.ts` `refreshNow`, `apps/daemon/src/agent-account-refresh.ts`).

It ships as a **built-in plugin** in Settings → Plugins, beside Excalidraw, Secret files, Ephemeral AI VMs and Device simulators.

The owner also wants agents to be able to **show the user any image** right in the chat: a screenshot they took, an image in the project, one the user pasted, one they generated. That part does not depend on the plugin. Every chat gets it (§9.3), and the generated-image display is built on it.

## 2. Goals, non-goals, anti-goals

### Goals

1. Every agent chat (Claude, Codex, Grok, OpenCode) gets one Orquester tool, `generate_image`, while the plugin is on and a usable Codex account exists. It can generate from a prompt, and it can edit or restyle using up to 5 reference images: project files, or images the user pasted into this chat.
2. A typical image comes back in seconds to a couple of minutes, not 4–6 minutes. There is no second agent in the loop.
3. Every generated image is kept with the chat and **shown in the chat itself, large and always visible**, not hidden in a collapsed tool row. It is also written into the project when the agent passes a path or when the plugin is set to save to the project (§7).
4. The agent receives the image itself, so it can look at it and iterate.
5. Agents can show the user any image file they can point at, inline in the chat, in every chat, plugin on or off. This covers a browser or simulator screenshot in a temp folder, a project file, a pasted or generated image, and an image on the chat's VM (§9.2, §9.3).
6. People get small direct touches on a generated image: enlarge, copy, save to project, reveal in files, use as reference for the next message (§9).
7. Errors say what happened and what to do: quota used up and when it resets, a Free plan, a safety block, a login that needs renewing.
8. Images Codex chats already make with Codex's own built-in tool show up in the chat too. Today the adapter drops them.

### Non-goals (this version)

- API-key billing or any fallback that costs money. The plugin is subscription-only. The settings should not make a later API-key option hard to add, but none of it is built now.
- A standalone "Image studio" tab or prompt box that works without an agent.
- Masks, inpainting regions, SVG/GIF output, more than one image per call, model choice.
- Writing generated images into a VM's project from a box chat. Box chats get chat-only generated images (§7.4). Showing an image that is on the VM is in scope (§9.3).
- Grok, Claude or other providers' image models.

### Anti-goals (a failure even if it works)

- Signing a Codex chat or the Codex CLI out. That means a second refresher, a refresh token spent outside `AgentAccounts`, or `auth.json` written by anything but `AgentAccounts`.
- An access token, refresh token or account ID in a log, tool result, API response, chat event or persisted record.
- An image written outside the caller's project, or a reference image read from outside the workspaces sandbox or this chat's own attachments.
- `show_image` turned into a general file reader: it reads only image files (checked by content, not extension), only from the places §9.3 lists, and never shows another chat's attachments.
- Overwriting an existing project file.
- Silently spending money. Nothing in this feature can incur a charge.
- An agent writing a Python or curl script against the OpenAI API because it didn't know the tool exists. The instruction line in §10 exists to prevent this.

## 3. Decisions the owner made

- **Route:** call Codex's image endpoint directly from the daemon, the same endpoint the Codex CLI itself uses. Do not wrap `codex exec`. The owner accepts that this endpoint is undocumented and outside OpenAI's sanctioned "Sign in with ChatGPT" program, which currently excludes image generation.
- **Storage:** images are kept with the chat and also written into the project when the agent passes a path or when the plugin is set to save to the project. Never overwrite; add `-v2`, `-v3`.
- **Billing:** subscription only.
- **Human surface:** agent-only, plus the small touches in §9.
- **Packaging:** a built-in plugin under Settings → Plugins.
- **Showing images:** agents can show any image, not only generated ones, for example a screenshot they took (owner, 2026-11-10).

## 4. Upstream contract

The source of truth is the current `openai/codex` source, read at HEAD `e1cc967` (2026-11-09):

- `codex-rs/codex-api/src/endpoint/images.rs`: the endpoints
- `codex-rs/ext/image-generation/src/tool.rs` (around lines 515–590): the request
- `codex-rs/ext/image-generation/src/artifact.rs`: the output
- `codex-rs/model-provider-info/src/lib.rs`: the base URL and `version` header
- `codex-rs/http-client/src/openai_headers.rs`, `codex-rs/codex-api/src/requests/headers.rs`: headers

What was observed there:

- **Endpoints:** `POST https://chatgpt.com/backend-api/codex/images/generations` with no reference images, and `POST …/codex/images/edits` with one to five reference images.
- **Body:** `{"prompt": "...", "model": "gpt-image-2", "background": "transparent" | "opaque", "quality": "auto", "size": "auto"}`. Edits add `"images": [{"image_url": "data:image/png;base64,..."}]`, at most 5.
- **Headers:** `Authorization: Bearer <access_token>`, `chatgpt-account-id: <account_id>`, `originator`, `version`, `session-id`, `x-codex-image-turn-id`. `OpenAI-Beta: responses=experimental` and `session_id` with an underscore are legacy and no longer sent.
- **Availability:** Codex refuses image generation on `PlanType::Free` (`codex-rs/core/src/tools/spec_plan.rs` `image_generation_available`). OpenAI's pricing page says Free has no image generation and Plus/Pro/Business/Enterprise do. It does not say whether Go does.
- **Quota:** images count toward the account's general Codex limits (5-hour and weekly windows) at roughly 3–5× the rate of a message.

The older route, `/backend-api/codex/responses` with a hosted `tools: [{type: "image_generation"}]`, is used by gptimage and codex-sub-imagen. It is not used here, because Codex itself moved off it.

### 4.1 Spike first (blocking)

Before building the tool, confirm the contract with one real Codex account. This uses a handful of images of that account's quota.

1. The minimum headers the endpoint accepts. Send the same `originator`/`version` values Codex sends for this endpoint.
2. The response shape: where the base64 lives, whether `revised_prompt` comes back, and the content type of the result.
3. Whether `size` other than `auto` (1024x1024, 1536x1024, 1024x1536, a custom WxH) and `quality` other than `auto` are honored or rejected.
4. Whether `background: "transparent"` returns a real alpha channel.
5. The error bodies for: an exhausted quota, including how the reset time is expressed; a Free plan; a moderation block; an expired or invalid token; a malformed request.

Commit redacted captures as fixtures, with provenance, following the provider fixture README conventions.

**Spike rules:** it uses the one Codex account the owner named for it (in chat, 2026-11-10; not recorded here). It runs outside the live daemon. It reads the chosen account's `auth.json` read-only and never refreshes it. It aborts if the access token has under 30 minutes left; the owner then refreshes it from the Accounts screen and the spike tries again.

**Fallback (builder's call):** if the images endpoint refuses calls not tied to a real Codex session or turn, or needs more than §4 lists, the builder may switch to the older direct route: `POST /backend-api/codex/responses` with a forced hosted `image_generation` tool (body as in the-jey/codex-sub-imagen `buildRequestBody`, which was reported working with transparency on 2026-11-01). The tool, storage and UI stay the same. Stop and ask only if neither route works. The result of item 3 decides whether `size` and `quality` appear in the tool schema (§6): expose them only if honored.

## 5. Account and token

- **Plugin setting `account`:** `"auto"` (default; builder's call) or a specific Codex account ID.
  - `auto` picks the first Codex account, in Settings order, that is not `needsReauth` and whose plan is not Free.
  - The plan comes from the access token's `https://api.openai.com/auth` → `chatgpt_plan_type` claim, not decoded anywhere today: add it next to `parseCodexIdentity` in `agent-account-identity.ts`, or take it from the last usage poll's `plan_type`.
  - **Auto failover (builder's call):** if the chosen account answers "quota exhausted", `auto` tries the next eligible account once within the same call. A specific account never fails over.
- **Credentials:** the daemon reads the access token and account ID through `AgentAccounts`, which validates the home with `assertOwnedAccountHome`.
  - If the token is within the refresh margin, call `agentAccounts.refreshNow("codex", id, { allowHeld: true })`. That is the same path the box token broker uses, safe because Codex reloads a daemon-refreshed `auth.json` (`HOST_CLI_ADOPTS_DAEMON_REFRESH.codex`).
  - On `"held"` or `"unavailable"`, or a 401 after a fresh token, the call fails with "this account needs signing in again" and the account is flagged through the existing `needsReauth` path.
  - The image code never posts a refresh token and never writes `auth.json`.
- **Plan detection is not authoritative.** A Free or Go account that reaches the endpoint gets the upstream refusal mapped to a clear message (§11).

## 6. The agent tool

There is one tool, `generate_image`, in a new toolset (e.g. `images`) in the Orquester MCP catalog (`apps/daemon/src/mcp/catalog`), reached through an optional `DaemonApi` method like the devices tools. It is a chat tool, it needs no approval, and it is not a spend family: it cannot cost money.

**Arguments:**

| Name | Type | Notes |
|---|---|---|
| `prompt` | string, required | What to make, or what to change. |
| `images` | string[], 0–5 | Reference images. One or more switches the call to the edits endpoint. PNG, JPEG, WebP; GIF if the spike shows it is accepted. Each is capped at the existing `MAX_TURN_IMAGE_BYTES`. Each entry is one of (§6.1): a path in the workspaces sandbox, as `read_file` takes it; a path inside the calling chat's own attachments directory; an `attachmentId` returned by an earlier `generate_image` in this chat; or `recent:N`, the Nth most recent image in this chat, whether pasted by the user or generated (`recent:1` is the latest). |
| `transparent` | boolean, default false | Maps to `background`. |
| `save_as` | string, optional | A project-relative path (or a directory ending in `/`) to also write the file to. Overrides the plugin's save setting for this call. |
| `size`, `quality` | optional | Only if the spike shows they are honored (§4.1). |

### 6.1 Referring to images in the chat (builder's call, after the builder check)

Most agents never see a path for an image the user pasted:

- Claude chats get pasted images as base64 blocks only (`adapters/claude/session.ts` `buildUserMessage`).
- Codex chats get them as `localImage` items.
- With `saveTo: chat`, a generated image has no project path either.

So the headline flows ("turn this pasted icon into liquid glass", "make it bluer") need references the daemon resolves itself:

- **`recent:N`:** the daemon walks the calling thread's own events, newest first, counting images from user messages (their attachments) and from earlier image results (`imageRef`), and takes the Nth. "Make it bluer" is `recent:1`. "This icon I just pasted" is also `recent:1` when it is the latest image.
- **`attachmentId`:** an ID from an earlier result's JSON. It must belong to the calling thread.
- **Chat attachments path:** allowed for agents that do see one. The daemon resolves the thread's attachments directory from `ctx.caller.threadId`, never from an argument. Only that one thread's directory is allowed, checked after realpath; `threads/<id>/attachments` is outside `fsRoot`.

Adapter prompts are not changed to add path lines for images. The instruction line (§10) and the tool description teach `recent:N`.

**Result:**
- An MCP image content block of the generated image (`imageResult`, `apps/daemon/src/session-tools/results.ts`), so the model sees it.
- A JSON object: `{ path?, attachmentId, revisedPrompt?, width, height, transparent, account: <label> }`. `path` is present only when the file was written to the project.
- An `imageRef` reference field (§9).
- If the image is larger than a provider's inline image limit, the image block is omitted and the text says so. The repo has no image library, and this design does not add one.

**Timeout:** the builder picks it, with the upstream call aborted at no more than 5 minutes. Concurrency is also the builder's call; suggested: at most 2 in flight per account, the rest queued.

## 7. Where images go

### 7.1 Always: with the chat

Every result is stored as an attachment of the calling thread through the existing upload path (`ctx.api.uploadAttachment`). This is what the chat thumbnail and "use as reference" read.

### 7.2 Also: into the project

The plugin setting `saveTo` is either `{ kind: "chat" }` or `{ kind: "project", folder: "assets/generated" }`.

- **Default:** `chat` (builder's call). Agents pass `save_as` when the image is meant for code, which keeps experiments out of git.
- **Precedence:** `save_as` wins over the setting.
- **Filenames:** a slug of the prompt (ASCII, at most about 40 characters) plus the extension, e.g. `dog-in-snow.png`.

### 7.3 Never overwrite

If the target exists, the name becomes `name-v2.png`, `name-v3.png` and so on. The file is created exclusively (`O_EXCL`, or a temporary file plus a link that refuses an existing target) so two concurrent calls cannot claim the same name. The result reports the actual path. This also applies to an explicit `save_as: "public/icon.png"`: the agent gets `public/icon-v2.png` back and can move it if replacing was intended (builder's call; a separate `overwrite` flag is deliberately left out).

### 7.4 Containment

- The project target must resolve, after realpath, inside the caller's `projectPath`, which is inside `fsRoot`.
- A chat with no project, or a box chat whose project is on a VM, gets chat-only images. The result says why `path` is missing.

## 8. Plugin and settings

- **Catalog:** an entry in `apps/daemon/src/plugins/catalog.ts` with `updates: false` (so it is "Built in"), `provider: "Orquester"` and `scope: "global"`. Name: "GPT Image". Description along the lines of "Let your agents generate and edit images with GPT Image on a connected ChatGPT plan." Its ID goes in `packages/api/src/plugins.ts`, and it needs a glyph in `PLUGIN_GLYPH`.
- **Stored settings:** `{ account, saveTo }`, kept in the plugin's `settings` in `plugins.json` via `PluginsService.updatePluginSettings`. A tolerant reader in `packages/config` follows `storedKnowledgeSettings`: unknown fields are preserved, and bad values fall back to defaults.
- **Detail pane** (`GptImagePluginSection`, one line in `PluginsSettings.tsx` next to the others):
  - **Account:** "Auto" plus each Codex account with its label, email, plan, and a "needs sign-in" state. The builder can use the Knowledge plugin's `AccountPolicyEditor` if it fits, or a simple select.
  - **Save images to:** "This chat only" or "Project folder", with a folder field (default `assets/generated`). A note says agents can still save a single image anywhere in the project.
  - **Quota:** the selected account's current Codex 5-hour and weekly usage, taken from the existing usage data (not a new poll), with the reminder that images use it faster than messages.
  - **Empty state:** no Codex account connected. "Connect a ChatGPT account" opens Settings → Accounts' Codex login. Any ChatGPT plan except Free works, including Plus.
- **First enable:** the existing first-enable confirm states, in plain words, that this uses an unofficial ChatGPT endpoint OpenAI may change or restrict, and that images count toward the account's Codex limits.

## 9. In the chat

### 9.1 Generated images appear inline (owner requirement, 2026-11-10)

- **Inline row:** a finished `generate_image` call is shown as an **inline image row in place of its tool row**, the way an `html_render` page replaces its row with `VisualRow` (`timeline/rows/VisualRow.tsx`, `rows.logic.ts`).
  - The image is left-aligned with the reply text and always visible, not collapsed.
  - It is sized to the chat column, with a height cap of about 512px (builder's call).
  - A one-line caption gives the prompt, or the revised prompt if one came back.
- **While generating:** a placeholder row in the image's place shows a waiting state ("Generating image…"), so the user sees something is coming.
- **Failure:** the row shows the plain error from §11.
- **Click to enlarge:** the image opens full size, in a lightbox or the existing image preview.
- **Actions on hover, and in the enlarged view:**
  - **Copy image**
  - **Save to project…:** pick a folder in the project, same never-overwrite rule
  - **Reveal in files:** only when it has a project `path`
  - **Use as reference:** attaches it to the composer for the next message

### 9.2 Agents can show any image in their reply

There is no extra tool: agents use Markdown images in their reply text.

- **Project files:** already render. `![](path)` in `timeline/markdown/ChatMarkdown.tsx` (`LocalMarkdownImage`) reads files in the workspaces sandbox.
- **Chat images:** add an image source that resolves within the current chat. Use `![alt](recent:N)` and `![alt](attachment:<id>)`, the same references `generate_image` takes (§6.1), so pasted and generated images can be shown again or side by side. The builder may pick a different scheme as long as the tool description and instruction line teach the same one.
  - Resolution goes through the serving route below and is scoped to the chat being viewed. A reference to another chat's attachment shows the existing "Image unavailable" placeholder.
- **Size and enlarge:** Markdown images keep their current inline size (`max-h-64`), get the same click-to-enlarge, and get the copy and save actions where the source is a chat image.
- **Result text:** the `generate_image` JSON includes a ready-made `markdown` field (e.g. `![dog in snow](attachment:<id>)`) so agents don't have to build the reference themselves.

### 9.3 `show_image`: show any image file (owner requirement, 2026-11-10)

Markdown (§9.2) only reaches the workspaces sandbox and this chat's images. Screenshots usually land elsewhere: agent-browser, a simulator, or a CLI's temp folder. So every chat also gets one core Orquester tool, `show_image`, with the same audience and toolset as `html_render`. It is always advertised and not gated by the plugin.

**Arguments:**

| Name | Type | Notes |
|---|---|---|
| `images` | array, 1–6 (builder's call) | Each entry is `{ path }` or `{ ref }` (`recent:N` or `attachment:<id>`), with an optional `caption`. |
| `title` | string, optional | One line above the images. |

**Where paths may point (builder's call, flagged for the owner):**

- the workspaces sandbox (`fsRoot`), as `read_file` takes it;
- this chat's own attachments directory;
- **the host's temp directories:** the OS temp dir and the `TMPDIR` the daemon gives agent processes, e.g. `/var/lib/orquester/tmp/...`. Screenshots land there.

This third location is a deliberate, narrow widening of containment. It is acceptable only because:
- the file must be a regular file;
- it must be a PNG, JPEG, WebP or GIF by magic bytes;
- it must be at most `MAX_TURN_IMAGE_BYTES`;
- it is checked after realpath;
- it is copied, never linked.

Anything else gets "path is not allowed".

**Box chats:** a VM path, as the agent there sees it, is fetched from the VM through the existing box file plumbing (`box_download`'s path), under the same image-only checks. If that turns out to be more than a small addition, refuse VM paths with a clear message and note it.

**What it does:**
- Each image is copied into the chat as an attachment through the existing upload path; `uploadInlineAttachments` already validates and streams.
- The images render as the same **inline image row** as §9.1, always visible. Several images form a row or grid with their captions.
- Each image gets click to enlarge and the same actions.
- It works for every agent, because the row comes from the tool result's `imageRef` (or a list of them), not from anything provider-specific.

**What the agent gets back:** the attachment IDs, a ready-made `markdown` reference for each, and a short confirmation. No image bytes are echoed back to the model, since it already has the file.

**Relationship to `generate_image`:** the same row component and the same serving route, built once. Build `show_image` first.

### 9.4 Plumbing

- **Reference key:** a new session-tool reference key `imageRef: { attachmentId, path?, width?, height? }` in `SESSION_TOOL_REFERENCE_KEYS` (`packages/api/src/agent-chat/session-tools.ts`). It follows the `deviceRef.screenshotId` and `htmlRender` patterns. Image bytes in results are already stripped before persistence (`boundSessionToolData`), so the row loads the stored attachment instead.
- **Serving:** the UI needs a way to fetch a thread attachment's bytes for display. Today `GET …/attachments/:id` returns only a path, and `/api/fs/raw` cannot reach the threads directory. Add an authenticated route, or reuse whatever the `htmlRender` visual row uses, through the shared API client. Remote clients must work.
- **Codex's own images:** `apps/daemon/src/agent-host/adapters/codex/items.ts` maps `imageGeneration` to `unknown` and drops `result` and `savedPath`. Map it to a real item, store `result` (base64) as a thread attachment, and render it with the same inline image row and actions (§9.1). This applies whether or not the plugin is on, because those chats already make the images. A failed item (`failure: usageLimitExceeded`) shows the same quota message.

**Codex chats keep Codex's native tool (builder's call, after the builder check).** Orquester does not touch Codex's `image_generation` feature, so a Codex chat with the plugin on has both tools. Codex's native images are kept with the chat and shown with the same row; they are not auto-saved to the project, and "Save to project…" works on them. `recent:N` counts them too. The instruction line is not tailored per agent.

## 10. Agent instructions and gating

- **Gating:** the toolset is advertised only while the plugin is on **and** at least one eligible Codex account exists. It follows the devices pattern:
  - an availability flag in `session-tools/manifest.ts`, `session-tools-refresh.ts` and the `index.ts` wiring;
  - a refresh of open chats' tool lists when the plugin toggles or Codex accounts change.
- **Instruction line** (`session-tools/instructions.ts`), added only while the tool is advertised. Wording is the builder's, within the instruction block's byte cap and its test. The meaning:
  - "Images: to make or edit a picture, call generate_image (GPT Image on the user's ChatGPT plan); pass pasted or project images to edit them; it shows in the chat and save_as puts it in the project."
  - It must steer agents away from writing API scripts.
- **Showing images is always on.** The fixed part of the instruction block gains a short clause, within its byte cap, along the lines of: "To show the user an image (a screenshot, a file, a pasted or generated image), call show_image; in a reply, `![](path)` or `![](recent:N)` also works." It does not depend on the plugin.
- **Chat-row labels:** a label for `generate_image` in `packages/ui/src/lib/agent-chat/presentation.logic.ts`.

## 11. Errors

| Situation | What the agent and user see |
|---|---|
| Plugin off or no eligible account | Tool not advertised. A stale call gets "GPT Image is off" or "no ChatGPT account that can make images". |
| Quota exhausted | "This account's Codex limit is used up; it resets at <time>." With `auto`, the other accounts are tried first. |
| Free plan | "Image generation needs a paid ChatGPT plan (Plus or higher)." |
| Needs sign-in | "<label> needs signing in again in Settings → Accounts." The account is flagged `needsReauth`. |
| Safety refusal | The upstream refusal text, briefly. Not retried. |
| 429 / 5xx / network | Retried a few times with backoff, honoring `Retry-After`, then a plain failure. |
| Bad reference path | "images[i]: path is not allowed" or "not found", in the existing attachment-error style. Nothing is sent upstream. |
| Upstream shape change | "Unexpected response from ChatGPT", logged without tokens. |

## 12. Tests

Per AGENTS.md, test what a caller would notice:

- account selection (Free, needs-reauth and auto failover);
- never-overwrite naming under concurrent calls;
- containment of `images` and `save_as`, including another thread's attachments being refused;
- error mapping, from the spike's redacted fixtures;
- the token path, which must never call the refresh endpoint itself;
- the Codex adapter's `imageGeneration` mapping, through a replay fixture;
- the instruction line's presence and the byte cap.

Test `show_image` containment: sandbox, own attachments and temp dirs are allowed; other paths, non-images by magic bytes, oversized files, symlinks escaping after realpath and another chat's attachment are refused. Test resolution of Markdown `recent:N` and `attachment:<id>` (another chat's ID refused). The inline image row and lightbox are shown with before and after screenshots, not tested for markup.

## 13. Left to the builder

- Module layout under `apps/daemon/src/` for the image service.
- The toolset ID and the exact stored-settings field names.
- The retry policy.
- The timeout and concurrency numbers.
- The slug rules.
- How the inline image row and lightbox look, within the existing chat row and Settings primitives.
- Whether "Save to project…" uses a folder picker or the configured folder.

## 14. Build order

1. **Image display, no plugin:**
   - the attachment serving route and the inline image row;
   - `show_image`;
   - the Markdown `recent:N` / `attachment:<id>` images;
   - Codex's native `imageGeneration` items;
   - the always-on instruction clause.

   Useful on its own, and everything later reuses it.
2. **The spike (§4.1).**
3. **GPT Image service and tool:** account selection, token path, upstream client, storage and naming, `generate_image`, gating and the plugin instruction line.
4. **Plugin entry and Settings pane.**
