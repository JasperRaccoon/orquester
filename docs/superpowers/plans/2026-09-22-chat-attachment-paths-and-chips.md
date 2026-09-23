# Chat attachment paths and typed chips — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A non-image attachment in a chat tab puts its absolute host path into the prompt (as the terminal-era upload typed it into the PTY) and always reaches the agent; the composer's attachment chips get file-type icons, image thumbnails and a hover preview.

**Architecture:** The host answers the attachment's absolute path on the upload reply (`AttachmentRef.path` — a courtesy of that one reply; the host's command validation strips it, so no event carries it). The composer inserts that path at the caret when the upload completes and removes it with the chip. Independently, one shared host helper appends `Attached files:` path lines for whatever an adapter does not ingest natively, skipping paths the text already names, so the file reaches the agent even if the user edits the path out. Chips render a vendored subset of Material Icon Theme SVGs through the existing `.svg?react` pipeline.

**Tech Stack:** TypeScript 5.8 (ESM, `strict`), React 18, Tailwind, `vite-plugin-svgr` (`.svg?react`), `node --test` via tsx, `@anthropic-ai/claude-agent-sdk` streaming input, Codex app-server JSON-RPC, OpenCode HTTP, Grok ACP.

**Spec:** The design was approved in chat on 2026-09-22 (summarised under "Design" below). It amends `docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md` §4.1 (attachment bounds, lines 633–641), §4.5 (per-provider delivery: Claude 971–975, Codex 1117–1124, OpenCode 1274–1275, Grok), §6.3 (attachments, 2625–2641), §7.3 (user message row, 2921–2929) and §7.4 (composer, 3039–3046 and the Built block ending at 3089). The research it relies on: `docs/superpowers/research/2026-09-20-agent-gui/t3-1-providers.md:282-292` (T3 rewrites every attachment into an on-disk path inside the prompt text before the adapter sees the turn).

## Design (approved)

- **Why files show nothing today.** The client only ever learns `{type, id, name, mimeType, sizeBytes}` from the upload; the appdir never crosses the wire, so the composer has nothing to insert. Worse, the Claude and Codex adapters `continue` past every non-image ref behind a comment that assumes a host-written path line that was never ported from T3; OpenCode drops anything that is not an image, `text/*` or PDF; only Grok appends an `Attached files:` list. A `.xlsx` in a Claude chat reaches nowhere.
- **Precedent to match.** A terminal-agent tab uploads to `<appdir>/daemon/uploads/<sessionId>/<8hex>-<name>` and types the absolute path into the PTY as a bracketed paste, no Enter (`packages/ui/src/lib/session-upload.ts`, `injectionForPaths`). The chat composer once appended the returned path per line (commit `a57d320`) and lost it when the chat upload started answering an `AttachmentRef` without a path (`7c3a2ae`).
- **Path in the prompt (client).** The upload reply gains `path`; when a non-image upload completes the composer inserts the path at the live caret; removing the chip removes the path; the persisted draft keeps the path (validated field-wise) so a reload can still strip it. Images keep `[Image #N]`.
- **Guarantee (host).** `appendAttachmentPathLines(text, [{name, path}])` appends `Attached files:\n- <name>: <path>` for the refs an adapter does not ingest natively, skipping any path the text already names. Claude, Codex and OpenCode adopt it; Grok's existing block goes through it and stops duplicating. Provider input only — never persisted (§4.6.9: a suffix, never a prefix or a wrap).
- **Chips.** ~40 vendored Material Icon Theme SVGs (VS Code's explorer icons, MIT, no Microsoft artwork), resolved by extension → mime → family → generic. Image chips show a 16 px thumbnail of the local `File` and a hover preview; a reloaded chip resolves its bytes lazily through `GET …/attachments/:id`. The timeline's sent-message chips use the same icons (no thumbnails there, by §7.3's Built decision).
- **Extras approved.** Fix the element picker's chat delivery (it reads `uploaded.path`, which a chat upload no longer answers); delete the dead `uploadFilesToChatDraft`/`attachmentRefFor`; correct the three stale adapter comments.
- **Known consequence.** The sent-message bubble shows the path in the text and the file as a chip (as `[Image #N]` does today). The on-disk name stays `<id>.<ext>`; the original name travels in the chip and in the `Attached files:` line.

## Global Constraints

- No new npm dependency. Icons are vendored SVGs under `packages/ui/src/icons/files/`, imported with `?react` exactly as `packages/ui/src/icons/registry-icons.tsx` does; pin `material-icon-theme@5.38.1` (MIT) and keep the upstream notice in `packages/ui/src/icons/files/LICENSE`.
- `AttachmentRef` on the wire stays references-only: `path` is a courtesy of the upload reply; `apps/daemon/src/agent-host/orchestration/validate.ts` rebuilds every ref from `{type, id, name, mimeType, sizeBytes}`, so no command body reaches an adapter with it and no event carries it.
- §4.6.9: the host never prefixes, indents or wraps the user's text. The `Attached files:` block is a **suffix** of the text (Claude with a skill dispatch: a suffix of the leading text block, so the command block stays last and untouched).
- §4.1 bounds are unchanged: ≤ 8 attachments per turn, images gif/jpeg/png/webp ≤ 10 MiB, files ≤ 50 MiB.
- No lazy dynamic `import()` anywhere under `apps/daemon/src/agent-host/` (AGENTS.md).
- Tests are `node --test` files under `src/` next to the code; nothing waits on a sleep. UI tests run with `--import ./test/svg-loader.mjs`, which resolves any `.svg?react` import to a component that renders `null`.
- Never launch the daemon or the agent host from this checkout. Verify with `pnpm check`, the package test scripts and `pnpm build`.
- **Do not commit and do not create a branch** (AGENTS.md: the current branch as-is, and only when asked). Stage every file you create or change with `git add <path>` when your task is done so the controller can snapshot the staged tree for review; the owner commits.
- Theming is data: no component branches on scheme or mode. The light-mode icon adjustment is one CSS rule keyed on `data-file-icon`.
- Subagents: never pass `model: "sonnet"` or `model: "haiku"` (host CLAUDE.md).

## Review Focus

1. **A chip removed while its upload is in flight.** The late success must not insert a path for a chip that no longer exists, and must not resurrect the chip. Expected: nothing changes. Pinned in Task 4 (`uploadOne` guard) — exercised by the composer's own logic; the reviewer reads `uploadOne` for the `draftRef` existence check.
2. **A path that appears twice** (the user pasted it again). Removal strips exactly one occurrence; the host appends nothing because the text already names it. Task 4 (`removeFilePath` test "removes exactly one occurrence") and Task 2 (`appendAttachmentPathLines` test "skips a path the text already names").
3. **An attachment-only turn** (empty text, one `.xlsx`). Claude gets a single text block holding the path lines; Codex gets one text item; OpenCode no longer throws "turns require text input"; Grok unchanged. Tasks 2 and 3 tests.
4. **A persisted draft from an older bundle** — no `path`, or `path: 123`. It loads, chips render, removal leaves the text untouched. Task 4 (`parsePersistedDrafts` test).
5. **A file with no extension or an unknown mime** (`README`, `application/octet-stream`, an empty `file.type`). The generic icon, never a throw. Task 5 (`fileIconIdFor` test) and the `Record<FileIconId, …>` typing that makes a missing SVG a compile error.

---

## Task ordering and parallelism

- Task 1 first (the shared type).
- Then two lanes in parallel, disjoint files: **daemon lane** Task 2 → Task 3; **ui lane** Task 4 and Task 5 (independent of each other, so they may run concurrently), then Task 6.
- Task 7 (docs) after both lanes; Task 8 (whole-tree verification + review) last.
- Each lane verifies with its own package: `pnpm --filter @orquester/daemon typecheck` / `pnpm --filter @orquester/daemon test`, `pnpm --filter @orquester/ui typecheck` / `pnpm --filter @orquester/ui test`, `pnpm --filter @orquester/api typecheck`.

---

### Task 1: `path` on the upload reply (api type, host store, validator pin)

**Files:**
- Modify: `packages/api/src/agent-chat/adapter-types.ts:157-166`
- Modify: `apps/daemon/src/agent-host/store/index.ts:892-905` (the two `return`s of `putAttachment`)
- Modify: `apps/daemon/src/agent-host/services.ts:137-143` (doc of `putAttachment`)
- Modify: `apps/daemon/src/agent-host/server/extra-routes.ts:16-23` (doc of `putAttachment`)
- Test: `apps/daemon/src/agent-host/store/store.test.ts:590-611`
- Test: `apps/daemon/src/agent-host/orchestration/validate.test.ts` (describe with "keeps the unknown arm…", line 75)
- Test: `apps/daemon/src/agent-host/server/http-server.test.ts:340-375`

**Interfaces:**
- Produces: `AttachmentRef` `image`/`file` arms gain `path?: string`. `ThreadStore.putAttachment()` answers the ref **with** `path` set to the absolute destination. `POST /threads/:id/attachments` (host) and therefore `POST /api/sessions/:id/upload` (daemon, verbatim pass-through) answer `{...ref, path}`.
- Consumed by: Task 4 (composer reads `ref.path`), Task 6 (no change).

- [ ] **Step 1: Write the failing store test**

In `apps/daemon/src/agent-host/store/store.test.ts`, inside `test("putAttachment copies the file, names the thread in the id and stats the size", …)`, after `const resolved = await store.resolveAttachment("t1", ref.id);` add:

```ts
  // The reply names the absolute path the composer puts in the prompt (§7.4).
  assert.equal(ref.path, resolved);
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/daemon && node --import tsx --test src/agent-host/store/store.test.ts`
Expected: FAIL — `ref.path` is `undefined` (and `pnpm --filter @orquester/daemon typecheck` reports `Property 'path' does not exist on type 'AttachmentRef'`).

- [ ] **Step 3: Add `path` to the two concrete arms of `AttachmentRef`**

Replace the `AttachmentRef` doc + type in `packages/api/src/agent-chat/adapter-types.ts:157-166` with:

```ts
/**
 * References only — never bytes and never a data URL (§6.3). Resolved by the
 * host against the thread's `attachments/` dir. The third arm is a deliberate
 * forward-compat catch-all so a newer producer cannot break an older decoder.
 *
 * `path` is the attachment's absolute path on the host, answered by the
 * **upload** so the composer can name the file in the prompt exactly as the
 * terminal-era upload typed it into the PTY (§7.4). It is a courtesy of that
 * one reply and nothing more: the host's command validation rebuilds every ref
 * from `{type, id, name, mimeType, sizeBytes}` (`validate.ts`), so no command
 * body reaches an adapter with it and no event ever carries it.
 *
 * *T3: `orchestration.ts:302-372` (`ChatAttachment`).*
 */
export type AttachmentRef =
  | { type: "image"; id: string; name: string; mimeType: string; sizeBytes: number; path?: string }
  | { type: "file"; id: string; name: string; mimeType?: string; sizeBytes: number; path?: string }
  | { type: "unknown"; id: string; name: string; mimeType?: string; sizeBytes?: number };
```

- [ ] **Step 4: Return the destination from `putAttachment`**

In `apps/daemon/src/agent-host/store/index.ts`, change the two returns at the end of `putAttachment` (the `destination` constant is already in scope):

```ts
      if (
        mimeType !== undefined &&
        (SUPPORTED_ATTACHMENT_IMAGE_MIME_TYPES as readonly string[]).includes(mimeType)
      ) {
        return {
          type: "image",
          id: attachmentId,
          name: input.name,
          mimeType,
          sizeBytes,
          path: destination
        };
      }
      return {
        type: "file",
        id: attachmentId,
        name: input.name,
        ...(mimeType !== undefined ? { mimeType } : {}),
        sizeBytes,
        // The absolute path the composer names in the prompt (§7.4). Only the
        // upload reply carries it; `validate.ts` strips it from commands.
        path: destination
      };
```

Update the `putAttachment` doc in `apps/daemon/src/agent-host/services.ts:137-143` by appending one sentence: `Answers the ref with \`path\` — the absolute destination — for the upload reply (§7.4).` Update `extra-routes.ts` `putAttachment` doc: replace `answers the {@link AttachmentRef}.` with `answers the {@link AttachmentRef} together with its absolute \`path\` (§7.4).`

- [ ] **Step 5: Run the store test to verify it passes**

Run: `cd apps/daemon && node --import tsx --test src/agent-host/store/store.test.ts`
Expected: PASS.

- [ ] **Step 6: Pin the validator strip**

In `apps/daemon/src/agent-host/orchestration/validate.test.ts`, after the `it("keeps the unknown arm as a forward-compat catch-all, still bounded", …)` test, add:

```ts
  it("strips a client-supplied path: a command's ref is a reference and nothing else (§6.3)", () => {
    const [file] = parseAttachments([
      { type: "file", id: "a", name: "q3.xlsx", sizeBytes: 10, path: "/etc/passwd" }
    ]);
    assert.deepEqual(file, { type: "file", id: "a", name: "q3.xlsx", sizeBytes: 10 });
    const [image] = parseAttachments([
      { type: "image", id: "b", name: "x.png", mimeType: "image/png", sizeBytes: 10, path: "/x" }
    ]);
    assert.deepEqual(image, { type: "image", id: "b", name: "x.png", mimeType: "image/png", sizeBytes: 10 });
  });
```

Run: `cd apps/daemon && node --import tsx --test src/agent-host/orchestration/validate.test.ts`
Expected: PASS already (the rebuild ignores unknown fields) — the test exists to keep it that way.

- [ ] **Step 7: Pin the upload reply**

In `apps/daemon/src/agent-host/server/http-server.test.ts`, test "claims an attachment from a raw octet-stream body and resolves it back": change `const ref = uploaded.body as { id: string; name: string };` to `const ref = uploaded.body as { id: string; name: string; path?: string };` and, after the existing `GET` resolve assertion (the `resolved` call that follows), add:

```ts
    assert.equal(ref.path, (resolved.body as { path: string }).path, "the upload reply names the same absolute path the resolve route does");
```

(Read the lines just after 375 to see how `resolved` is shaped — it is the `h.call("GET", agentHostExtraRoutes.attachment(threadId, ref.id))` result; use its actual field for the body.)

Run: `cd apps/daemon && node --import tsx --test src/agent-host/server/http-server.test.ts`
Expected: PASS.

- [ ] **Step 8: Typecheck both packages**

Run: `pnpm --filter @orquester/api typecheck && pnpm --filter @orquester/daemon typecheck`
Expected: clean.

---

### Task 2: `appendAttachmentPathLines` and the Claude adapter

**Files:**
- Create: `apps/daemon/src/agent-host/adapters/attachment-lines.ts`
- Create: `apps/daemon/src/agent-host/adapters/attachment-lines.test.ts`
- Modify: `apps/daemon/src/agent-host/adapters/claude/session.ts:1515-1569` (`buildUserMessage`)
- Test: `apps/daemon/src/agent-host/adapters/claude/lifecycle.test.ts` (describe "claude adapter — turns", line 536)

**Interfaces:**
- Produces: `export interface AttachmentPathLine { name: string; path: string }` and `export function appendAttachmentPathLines(text: string, attachments: readonly AttachmentPathLine[]): string`. Task 3 consumes both.

- [ ] **Step 1: Write the failing helper tests**

Create `apps/daemon/src/agent-host/adapters/attachment-lines.test.ts`:

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { appendAttachmentPathLines } from "./attachment-lines.ts";

describe("attachment path lines (§4.1, §4.5)", () => {
  it("appends an `Attached files:` block as a suffix, one `- name: path` line per attachment", () => {
    assert.equal(
      appendAttachmentPathLines("look at these", [
        { name: "q3.xlsx", path: "/a/t1-1-xlsx.xlsx" },
        { name: "notes.txt", path: "/a/t1-2-txt.txt" }
      ]),
      "look at these\n\nAttached files:\n- q3.xlsx: /a/t1-1-xlsx.xlsx\n- notes.txt: /a/t1-2-txt.txt"
    );
  });

  it("is the block alone when the text is empty, so an attachment-only turn still says something", () => {
    assert.equal(
      appendAttachmentPathLines("", [{ name: "q3.xlsx", path: "/a/x.xlsx" }]),
      "Attached files:\n- q3.xlsx: /a/x.xlsx"
    );
  });

  it("skips a path the text already names — the composer put it there (§7.4) — and returns the text by identity when nothing is left", () => {
    const text = "see /a/x.xlsx please";
    assert.equal(appendAttachmentPathLines(text, [{ name: "x.xlsx", path: "/a/x.xlsx" }]), text);
    assert.equal(
      appendAttachmentPathLines(text, [
        { name: "x.xlsx", path: "/a/x.xlsx" },
        { name: "y.csv", path: "/a/y.csv" }
      ]),
      "see /a/x.xlsx please\n\nAttached files:\n- y.csv: /a/y.csv"
    );
    assert.equal(appendAttachmentPathLines(text, []), text);
  });

  it("never prefixes or wraps: a leading slash command stays first (§4.6.9)", () => {
    const out = appendAttachmentPathLines("/review", [{ name: "a.pdf", path: "/a/a.pdf" }]);
    assert.ok(out.startsWith("/review\n\n"));
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/daemon && node --import tsx --test src/agent-host/adapters/attachment-lines.test.ts`
Expected: FAIL — cannot find module `./attachment-lines.ts`.

- [ ] **Step 3: Write the helper**

Create `apps/daemon/src/agent-host/adapters/attachment-lines.ts`:

```ts
/**
 * The path line a non-native attachment rides into the prompt (§4.1, §4.5).
 *
 * T3 rewrites every attachment into an on-disk path inside the prompt text
 * before the adapter sees the turn (`t3-1-providers.md:282-292`, "a path in
 * the prompt does not grant filesystem access"). That step was never ported:
 * the Claude and Codex adapters `continue`d past every non-image ref behind a
 * comment that assumed it, and the file vanished. This is the one spelling of
 * that step, called by each adapter for exactly the refs it does not ingest
 * natively — Claude ingests images, Codex images by path, OpenCode
 * image/`text/*`/pdf as `file` parts, Grok nothing.
 *
 * Two rules, both load-bearing:
 * - **A suffix, never a prefix or a wrap** (§4.6.9): a `/command` the user typed
 *   stays first.
 * - **A path the text already names is skipped.** The composer inserts the
 *   path at the caret when the upload completes (§7.4), so the common case
 *   appends nothing; this block is the guarantee for the text the user edited
 *   it out of, an older bundle, or a ref delivered from outside the composer.
 */

export interface AttachmentPathLine {
  /** The original file name, for the agent's benefit; the path is what it reads. */
  name: string;
  /** Absolute host path, as `AdapterContext.resolveAttachmentPath` answers it. */
  path: string;
}

export function appendAttachmentPathLines(
  text: string,
  attachments: readonly AttachmentPathLine[]
): string {
  const missing = attachments.filter((attachment) => !text.includes(attachment.path));
  if (missing.length === 0) {
    return text;
  }
  const block = `Attached files:\n${missing
    .map((attachment) => `- ${attachment.name}: ${attachment.path}`)
    .join("\n")}`;
  return text.length === 0 ? block : `${text}\n\n${block}`;
}
```

- [ ] **Step 4: Run the helper tests**

Run: `cd apps/daemon && node --import tsx --test src/agent-host/adapters/attachment-lines.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Write the failing Claude adapter tests**

In `apps/daemon/src/agent-host/adapters/claude/lifecycle.test.ts`, inside `describe("claude adapter — turns", …)` after the first `it("starts, runs a turn and settles it", …)`, add (the harness's context resolves `/attachments/<id>`, line 304):

```ts
  it("a non-image attachment reaches Claude as a path line in the final text block (§4.5)", async () => {
    const harness = await makeHarness();
    await harness.adapter.startSession(START);
    const peer = harness.peers[0]!;

    await harness.adapter.sendTurn({
      threadId: START.threadId,
      input: "summarise this",
      attachments: [{ type: "file", id: "att-2", name: "q3.xlsx", sizeBytes: 10 }],
      interactionMode: "default"
    });
    await peer.nextTurn();

    const content = peer.received[0]?.message.content as Array<{ type: string; text?: string }>;
    assert.equal(content.length, 1, "a file is not a content block of its own");
    assert.equal(content[0]?.type, "text");
    assert.equal(content[0]?.text, "summarise this\n\nAttached files:\n- q3.xlsx: /attachments/att-2");

    peer.emit(systemInit());
    peer.emit(successResult());
    await harness.waitFor("turn.completed");
  });

  it("a path the text already names is not repeated, and an attachment-only turn is the block alone", async () => {
    const harness = await makeHarness();
    await harness.adapter.startSession(START);
    const peer = harness.peers[0]!;

    await harness.adapter.sendTurn({
      threadId: START.threadId,
      input: "read /attachments/att-2 first",
      attachments: [{ type: "file", id: "att-2", name: "q3.xlsx", sizeBytes: 10 }],
      interactionMode: "default"
    });
    await peer.nextTurn();
    const first = peer.received[0]?.message.content as Array<{ type: string; text?: string }>;
    assert.equal(first[0]?.text, "read /attachments/att-2 first");
    peer.emit(systemInit());
    peer.emit(successResult());
    await harness.waitFor("turn.completed");

    await harness.adapter.sendTurn({
      threadId: START.threadId,
      input: "",
      attachments: [{ type: "file", id: "att-3", name: "notes.csv", mimeType: "text/csv", sizeBytes: 10 }],
      interactionMode: "default"
    });
    await peer.nextTurn();
    const second = peer.received[1]?.message.content as Array<{ type: string; text?: string }>;
    assert.equal(second.length, 1);
    assert.equal(second[0]?.text, "Attached files:\n- notes.csv: /attachments/att-3");
  });
```

If the harness's `peer.received` indexing differs for a second turn (read `makeHarness`/`peer.nextTurn()` at the top of the file), adapt the index — the assertion is on the second streamed user message.

- [ ] **Step 6: Run to verify they fail**

Run: `cd apps/daemon && node --import tsx --test src/agent-host/adapters/claude/lifecycle.test.ts`
Expected: the two new tests FAIL (`content.length` is 0 / the text lacks the block).

- [ ] **Step 7: Rewrite `buildUserMessage`**

In `apps/daemon/src/agent-host/adapters/claude/session.ts`, add the import near the other adapter imports:

```ts
import { appendAttachmentPathLines, type AttachmentPathLine } from "../attachment-lines.ts";
```

(Match the file's existing import style — check whether sibling imports carry the `.ts` suffix and follow it.) Then replace the body of `buildUserMessage` (lines 1522–1568) with:

```ts
  private async buildUserMessage(input: {
    text: string;
    attachments: readonly AttachmentRef[];
    skills: readonly Skill[];
  }): Promise<SDKUserMessage> {
    const content: Array<Record<string, unknown>> = [];
    const dispatch = planClaudeSkillDispatch(input.text, dispatchableSkillNames(input.skills));

    // Claude ingests images natively. Everything else reaches the agent as a
    // path line it can `Read` without an approval — the thread's attachments
    // dir is an `additionalDirectories` entry (`launch.ts`) — appended by
    // `appendAttachmentPathLines` (§4.1, §4.5), which skips a path the text
    // already names because the composer inserts it at upload time (§7.4).
    const imageBlocks: Array<Record<string, unknown>> = [];
    const pathLines: AttachmentPathLine[] = [];
    for (const attachment of input.attachments) {
      const path = await this.options.context.resolveAttachmentPath(this.threadId, attachment.id);
      if (attachment.type !== "image") {
        pathLines.push({ name: attachment.name, path });
        continue;
      }
      if (!IMAGE_MIME_TYPES.has(attachment.mimeType)) {
        throw new Error(`Unsupported Claude image attachment type '${attachment.mimeType}'.`);
      }
      const bytes = await fs.readFile(path);
      imageBlocks.push({
        type: "image",
        source: { type: "base64", media_type: attachment.mimeType, data: bytes.toString("base64") }
      });
    }

    if (dispatch) {
      // The command block must stay LAST and untouched (§4.5), so the path
      // lines ride the leading text block, created when the prose was empty.
      const leading = appendAttachmentPathLines(dispatch.leadingText ?? "", pathLines);
      if (leading.length > 0) {
        content.push({ type: "text", text: leading });
      }
      content.push(...imageBlocks);
      content.push({ type: "text", text: dispatch.commandText });
    } else {
      content.push(...imageBlocks);
      const text = appendAttachmentPathLines(input.text, pathLines);
      if (text.length > 0) {
        content.push({ type: "text", text });
      }
    }

    return {
      type: "user",
      session_id: this.resumeSessionId ?? "",
      parent_tool_use_id: null,
      message: {
        role: "user",
        content: content as unknown as SDKUserMessage["message"]["content"]
      }
    } as SDKUserMessage;
  }
```

Keep the existing doc comment above the method (lines 1515–1521) and extend it with one sentence: `A non-image attachment is a path line in the text, never a content block (Task: attachment paths, 2026-09-22).` Check that `dispatch.leadingText` is typed `string | undefined` in `skill-dispatch.ts`; if it is `string`, drop the `?? ""`.

- [ ] **Step 8: Run the Claude tests**

Run: `cd apps/daemon && node --import tsx --test src/agent-host/adapters/claude/lifecycle.test.ts`
Expected: PASS, including every pre-existing test (the "final block is text" assertion still holds).

- [ ] **Step 9: Typecheck**

Run: `pnpm --filter @orquester/daemon typecheck`
Expected: clean.

---

### Task 3: Codex, OpenCode and Grok adapters

**Files:**
- Modify: `apps/daemon/src/agent-host/adapters/codex/session.ts:441-460`
- Modify: `apps/daemon/src/agent-host/adapters/opencode/session.ts:101-103, 1351-1355, 1622-1651` (and the place `text`/`fileParts` become `parts`)
- Modify: `apps/daemon/src/agent-host/adapters/grok/session.ts:720-731`
- Test: `apps/daemon/src/agent-host/adapters/codex/session.test.ts:201-218`
- Test: `apps/daemon/src/agent-host/adapters/opencode/session.test.ts` (new test after the one at line ~548 that asserts `body.parts`)
- Test: `apps/daemon/src/agent-host/adapters/grok/lifecycle.test.ts:533`

**Interfaces:**
- Consumes: `appendAttachmentPathLines`, `AttachmentPathLine` from Task 2.

- [ ] **Step 1: Update the Codex test to the new expectation**

In `codex/session.test.ts`, test "attaches an image by PATH, never base64": rename it to `"attaches an image by PATH, never base64, and a file as a path line in the text item"` and change the `assert.deepEqual(turn!.input, …)` to:

```ts
    assert.deepEqual(turn!.input, [
      {
        type: "text",
        text: "look\n\nAttached files:\n- a.txt: /attachments/thread-1/att-2",
        text_elements: []
      },
      { type: "localImage", path: "/attachments/thread-1/att-1" }
    ]);
```

Add a second test right after it:

```ts
  it("an attachment-only turn is the path block alone, and a path already in the text is not repeated", async () => {
    const r = rig({ turns: [{ kind: "text", text: "ok" }, { kind: "text", text: "ok" }] });
    await r.session.start();
    await r.session.sendTurn({
      input: "",
      attachments: [{ type: "file", id: "att-2", name: "a.txt", sizeBytes: 10 }],
      interactionMode: "default"
    });
    await r.events.waitForType("turn.completed");
    const [first] = sentFrames(r.received(), "turn/start");
    assert.deepEqual(first!.input, [
      { type: "text", text: "Attached files:\n- a.txt: /attachments/thread-1/att-2", text_elements: [] }
    ]);
    await r.session.sendTurn({
      input: "see /attachments/thread-1/att-2",
      attachments: [{ type: "file", id: "att-2", name: "a.txt", sizeBytes: 10 }],
      interactionMode: "default"
    });
    await r.events.waitForType("turn.completed");
    const [, second] = sentFrames(r.received(), "turn/start");
    assert.deepEqual(second!.input, [
      { type: "text", text: "see /attachments/thread-1/att-2", text_elements: [] }
    ]);
    await r.stop();
  });
```

(If the `rig` helper's `turns` scripting needs two scripted turns spelled differently, read `rig` at the top of the file and follow it; the two `waitForType` calls each need a scripted completion.)

Run: `cd apps/daemon && node --import tsx --test src/agent-host/adapters/codex/session.test.ts`
Expected: both FAIL (the file ref is dropped today).

- [ ] **Step 2: Rewrite the Codex item build**

In `codex/session.ts`, import `appendAttachmentPathLines` and `AttachmentPathLine` from `../attachment-lines.ts` (match the file's import style) and replace lines 441–460 (from `const items: CodexProtocol.v2.UserInput[] = [];` through the `for` loop) with:

```ts
    // Images by PATH, never base64 (§4.5). Everything else is a path line the
    // agent reads itself — appended here, because the host forwards the text
    // verbatim (§4.6.9) and adds nothing of its own (`attachment-lines.ts`).
    const imageItems: CodexProtocol.v2.UserInput[] = [];
    const pathLines: AttachmentPathLine[] = [];
    for (const attachment of input.attachments) {
      const path = await this.options.context.resolveAttachmentPath(this.threadId, attachment.id);
      if (attachment.type === "image") {
        imageItems.push({ type: "localImage", path });
      } else {
        pathLines.push({ name: attachment.name, path });
      }
    }
    // Forwarded verbatim except for the §4.6.8 skill-mention normalisation.
    const text = appendAttachmentPathLines(
      input.input.length > 0 ? normaliseSkillMentions(input.input) : "",
      pathLines
    );
    const items: CodexProtocol.v2.UserInput[] = [];
    if (text.length > 0) {
      items.push({ type: "text", text, text_elements: [] });
    }
    items.push(...imageItems);
```

Keep whatever comment the original had about `normaliseSkillMentions` (lines 443–445) merged into the comment above.

Run the Codex test file again. Expected: PASS.

- [ ] **Step 3: Write the failing OpenCode test**

In `opencode/session.test.ts`, after the test that asserts `body.parts` deepEquals `[{ type: "text", text: "hello" }]` (around line 566), add a test in the same style (copy that test's setup — `harness`, the `sendTurn` call, `harness.fake.find("POST", "/prompt_async")` — and change only the input and the assertions):

```ts
test("an xlsx rides as a path line in the text part; a csv is still a native file part (§4.5)", async () => {
  const harness = await makeHarness(); // ← use the same construction the neighbouring prompt test uses
  await harness.session.start();
  await harness.session.sendTurn({
    input: "compare these",
    attachments: [
      { type: "file", id: "att-x", name: "q3.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", sizeBytes: 10 },
      { type: "file", id: "att-c", name: "rows.csv", mimeType: "text/csv", sizeBytes: 10 }
    ],
    interactionMode: "default"
  });
  const submit = harness.fake.find("POST", "/prompt_async");
  assert.ok(submit !== undefined);
  const body = submit.body as { parts: { type: string; text?: string; url?: string; filename?: string }[] };
  assert.deepEqual(body.parts[0], {
    type: "text",
    text: "compare these\n\nAttached files:\n- q3.xlsx: /attachments/att-x"
  });
  assert.equal(body.parts[1]?.type, "file");
  assert.equal(body.parts[1]?.filename, "rows.csv");
  assert.equal(body.parts[1]?.url, "file:///attachments/att-c");
  await harness.dispose?.();
});

test("an attachment-only turn with a non-native file no longer throws: the block is the text", async () => {
  const harness = await makeHarness();
  await harness.session.start();
  await harness.session.sendTurn({
    input: "",
    attachments: [{ type: "file", id: "att-x", name: "q3.xlsx", sizeBytes: 10 }],
    interactionMode: "default"
  });
  const submit = harness.fake.find("POST", "/prompt_async");
  const body = submit?.body as { parts: { type: string; text?: string }[] };
  assert.deepEqual(body.parts, [{ type: "text", text: "Attached files:\n- q3.xlsx: /attachments/att-x" }]);
  await harness.dispose?.();
});
```

Read the neighbouring test (lines ~530–575) first and use exactly its harness/start/settle helpers — the names above (`makeHarness`, `harness.session`, `dispose`) are placeholders for whatever that test uses; the assertions are the contract. The context in that file resolves `/attachments/<id>` (line 233).

Run: `cd apps/daemon && node --import tsx --test src/agent-host/adapters/opencode/session.test.ts`
Expected: both new tests FAIL (xlsx dropped; the second throws "OpenCode turns require text input or at least one attachment.").

- [ ] **Step 4: Rewrite `buildFileParts` and its call site**

In `opencode/session.ts`, import `appendAttachmentPathLines` and `AttachmentPathLine` from `../attachment-lines.ts`. Replace the constant comment at 101–103 with:

```ts
/** OpenCode ingests these natively; anything else rides as a path line in the text (`attachment-lines.ts`). */
const NATIVE_IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const NATIVE_FILE_PART_MAX_BYTES = 20 * 1024 * 1024;
```

Replace `buildFileParts` (1622–1651) with:

```ts
  /**
   * Split the refs into what OpenCode ingests natively — the four image mimes,
   * `text/*` and `application/pdf` under the cap, as `file` parts the server
   * reads off this host's disk — and what rides as a path line in the text
   * (§4.1, §4.5). A ref whose path cannot be resolved is skipped in both.
   */
  private async buildFileParts(
    attachments: AttachmentRef[]
  ): Promise<{ parts: OpenCodePartInput[]; pathLines: AttachmentPathLine[] }> {
    const parts: OpenCodePartInput[] = [];
    const pathLines: AttachmentPathLine[] = [];
    for (const attachment of attachments) {
      let absolute: string;
      try {
        absolute = await this.deps.ctx.resolveAttachmentPath(this.state.threadId, attachment.id);
      } catch {
        continue;
      }
      const mime = attachment.mimeType?.trim().toLowerCase() ?? "";
      const size = attachment.sizeBytes ?? 0;
      const native =
        size <= NATIVE_FILE_PART_MAX_BYTES &&
        (NATIVE_IMAGE_MIMES.has(mime) || mime.startsWith("text/") || mime === "application/pdf");
      if (!native) {
        pathLines.push({ name: attachment.name, path: absolute });
        continue;
      }
      parts.push({
        type: "file",
        mime,
        filename: attachment.name,
        url: pathToFileURL(absolute).href
      });
    }
    return { parts, pathLines };
  }
```

At the call site (1351–1355) replace with:

```ts
    const { parts: fileParts, pathLines } = await this.buildFileParts(input.attachments);
    const text = appendAttachmentPathLines(input.input.trim(), pathLines);
    if (text.length === 0 && fileParts.length === 0) {
      throw new Error("OpenCode turns require text input or at least one attachment.");
    }
```

Every later use of `text` and `fileParts` in `sendTurn` stays as it is (the text part is built from `text`; the file parts follow it). Confirm by reading the block where `parts` is assembled further down.

Run the OpenCode test file. Expected: PASS, including the pre-existing prompt tests.

- [ ] **Step 5: Grok — route the existing block through the helper and pin the dedupe**

In `grok/session.ts`, import `appendAttachmentPathLines` from `../attachment-lines.ts` and replace lines 725–731 (`const attachmentLines = …` through `: \`${input.text}\n\nAttached files:\n…\`;`) with:

```ts
      const text = appendAttachmentPathLines(input.text, input.attachments ?? []);
```

Keep the comment above it (720–724) and append: `The shared helper skips a path the text already names — the composer inserts it at upload time (§7.4).`

In `grok/lifecycle.test.ts`, after the test at line 533, add:

```ts
test("a path the text already names is not repeated in the Attached files block", async () => {
  const r = await rig();
  await start(r);
  await r.adapter.sendTurn({
    threadId: "t1",
    input: "open /attachments/a1 and tell me",
    attachments: [{ type: "file", id: "a1", name: "q3.xlsx", sizeBytes: 10 }],
    interactionMode: "default"
  });
  await r.waitFor((event) => event.type === "turn.completed", "turn.completed");
  const echoed = r.events
    .filter((event): event is Extract<RuntimeEvent, { type: "content.delta" }> => event.type === "content.delta")
    .filter((event) => event.payload.streamKind === "assistant_text")
    .map((event) => event.payload.delta)
    .join("");
  assert.doesNotMatch(echoed, /Attached files:/);
  assert.match(echoed, /open \/attachments\/a1 and tell me/);
  await r.dispose();
});
```

Check what the grok `rig()` context's `resolveAttachmentPath` returns (grep `resolveAttachmentPath` in that file) and use that spelling in `input` instead of `/attachments/a1` if it differs.

Run: `cd apps/daemon && node --import tsx --test src/agent-host/adapters/grok/lifecycle.test.ts`
Expected: PASS (the existing "attachments reach the agent as PATHS" test still passes).

- [ ] **Step 6: Full daemon suite and typecheck**

Run: `pnpm --filter @orquester/daemon typecheck && pnpm --filter @orquester/daemon test`
Expected: clean; test count ≥ 2348 + the new tests, 0 failures.

---

### Task 4: Composer — the path in the draft, its removal, persistence, and the three cleanups

**Files:**
- Create: `packages/ui/src/components/agent-chat/composer/composer-files.ts`
- Create: `packages/ui/src/components/agent-chat/composer/composer-files.test.ts`
- Modify: `packages/ui/src/lib/agent-chat/composer.logic.ts:243-256, 296-300` (`attachmentPathOf`, `normalisePersistedAttachment`)
- Modify: `packages/ui/src/lib/agent-chat/composer.logic.test.ts` (describe "persisted drafts")
- Modify: `packages/ui/src/lib/agent-chat/transport.ts:317-330` (doc) and `transport.test.ts:267-301`
- Modify: `packages/ui/src/components/agent-chat/composer/ChatComposer.tsx` (`caretRef`; `insertText` 445–461; `stageAttachment` 482–510; `uploadOne` 714–743; `removeAttachment` 804–821)
- Modify: `packages/ui/src/lib/composer-inbox.ts:98-122` and `packages/ui/src/lib/composer-inbox.test.ts:64`
- Modify: `packages/ui/src/lib/session-upload.ts` (delete `uploadFilesToChatDraft` + `attachmentRefFor`, lines 105–171, and their now-unused imports)
- Modify: `packages/ui/src/components/browser/PickComposeSheet.tsx:13-23, 72-111`

**Interfaces:**
- Consumes: `AttachmentRef.path?` (Task 1).
- Produces: `attachmentPathOf(ref: AttachmentRef | undefined): string | undefined` (lib), `removeFilePath(text, path)` and `textNamesPath(text, path)` (composer). Task 6 consumes none of these directly but edits the same `ChatComposer.tsx`; Task 6 must start after this task.

- [ ] **Step 1: Write the failing `composer-files` tests**

Create `packages/ui/src/components/agent-chat/composer/composer-files.test.ts`:

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { removeFilePath, textNamesPath } from "./composer-files.ts";

describe("file paths in the prompt", () => {
  it("removing a file drops its path and one adjacent space", () => {
    assert.equal(removeFilePath("see /t/a.xlsx now", "/t/a.xlsx"), "see now");
    assert.equal(removeFilePath("/t/a.xlsx", "/t/a.xlsx"), "");
    assert.equal(removeFilePath("look at /t/a.xlsx", "/t/a.xlsx"), "look at");
    assert.equal(removeFilePath("/t/a.xlsx then", "/t/a.xlsx"), "then");
    assert.equal(removeFilePath("nothing here", "/t/a.xlsx"), "nothing here");
  });

  it("removes exactly one occurrence, so a path the user repeated stays", () => {
    assert.equal(removeFilePath("/t/a.xlsx and /t/a.xlsx", "/t/a.xlsx"), "and /t/a.xlsx");
  });

  it("treats the path literally: metacharacters in a name never widen the match", () => {
    assert.equal(removeFilePath("x /t/a(1).xlsx y", "/t/a(1).xlsx"), "x y");
    assert.equal(removeFilePath("x /t/a.xlsx y", "/t/a-xlsx"), "x /t/a.xlsx y");
    assert.equal(removeFilePath("x /t/a.xlsx y", ""), "x /t/a.xlsx y");
  });

  it("knows whether the text already names a path", () => {
    assert.equal(textNamesPath("see /t/a.xlsx", "/t/a.xlsx"), true);
    assert.equal(textNamesPath("see /t/b.xlsx", "/t/a.xlsx"), false);
    assert.equal(textNamesPath("anything", ""), false);
  });
});
```

Run: `cd packages/ui && node --import tsx --import ./test/svg-loader.mjs --test src/components/agent-chat/composer/composer-files.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 2: Write `composer-files.ts`**

```ts
/**
 * File paths in the prompt (spec §7.4 Built note, owner request 2026-09-22).
 *
 * Before agent tabs were chat tabs, a file dropped on an agent terminal was
 * uploaded and its absolute daemon-side path typed into the PTY so the agent
 * could read it (`lib/session-upload.ts`, `injectionForPaths`). The composer
 * does the same for a non-image attachment: the path the upload answers
 * (`AttachmentRef.path`) is inserted at the caret when the upload completes —
 * it is not known before — and leaves with its chip. Images keep `[Image #N]`
 * (`composer-images.ts`). The host independently guarantees delivery with an
 * `Attached files:` block for any path the text does not name.
 */

const escapeForRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Remove ONE occurrence of `path` and the single space beside it, so
 * "see /t/a.xlsx now" reads "see now" and "/t/a.xlsx then" reads "then".
 */
export function removeFilePath(text: string, path: string): string {
  if (path.length === 0 || !text.includes(path)) return text;
  const escaped = escapeForRegExp(path);
  return text.replace(
    new RegExp(`^${escaped}\\s?|\\s?${escaped}(?=\\s|$)|${escaped}`),
    ""
  );
}

/** True when the draft already names the path (a returned queued message, a reload). */
export function textNamesPath(text: string, path: string): boolean {
  return path.length > 0 && text.includes(path);
}
```

Run the test file. Expected: PASS.

- [ ] **Step 3: `attachmentPathOf` and persisted-draft normalisation (lib)**

In `packages/ui/src/lib/agent-chat/composer.logic.ts`, add after `EMPTY_DRAFT`/`draftIsEmpty` (before `DRAFTS_KEY`):

```ts
/**
 * The absolute host path an upload answered for a ref (§7.4), or undefined —
 * the `unknown` arm never has one, an older bundle never wrote one.
 */
export function attachmentPathOf(ref: AttachmentRef | undefined): string | undefined {
  if (ref === undefined || !("path" in ref)) return undefined;
  return typeof ref.path === "string" && ref.path.length > 0 ? ref.path : undefined;
}

/**
 * A persisted ref's `path` must be a non-empty string or absent: a malformed
 * one from a stale blob must never reach `removeFilePath` (AGENTS.md: raw
 * `JSON.parse` output never reaches typed code).
 */
function normalisePersistedAttachment(ref: AttachmentRef): AttachmentRef {
  if (!("path" in ref) || attachmentPathOf(ref) !== undefined) return ref;
  const { path: _dropped, ...rest } = ref;
  return rest;
}
```

In `parsePersistedDrafts`, change `record.attachments.filter(isAttachmentRef)` to `record.attachments.filter(isAttachmentRef).map(normalisePersistedAttachment)`.

Add to `composer.logic.test.ts`, inside `describe("persisted drafts", …)`:

```ts
  it("keeps a string path on a persisted ref and drops a malformed one, so an old blob still loads", () => {
    const raw = JSON.stringify({
      s1: {
        text: "see /a/x.xlsx",
        attachments: [
          { type: "file", id: "a", name: "x.xlsx", sizeBytes: 1, path: "/a/x.xlsx" },
          { type: "file", id: "b", name: "y.csv", sizeBytes: 1, path: 123 },
          { type: "file", id: "c", name: "z.txt", sizeBytes: 1 }
        ],
        context: []
      }
    });
    const drafts = parsePersistedDrafts(raw);
    const [a, b, c] = drafts.s1!.attachments;
    assert.equal(attachmentPathOf(a), "/a/x.xlsx");
    assert.equal("path" in b!, false);
    assert.equal(attachmentPathOf(c), undefined);
  });
```

(Import `attachmentPathOf` and `parsePersistedDrafts` at the top if not already imported.)

Run: `cd packages/ui && node --import tsx --import ./test/svg-loader.mjs --test src/lib/agent-chat/composer.logic.test.ts`
Expected: PASS.

- [ ] **Step 4: Pin the transport pass-through**

In `packages/ui/src/lib/agent-chat/transport.test.ts`, inside `describe("attachments", …)`, add:

```ts
  it("keeps the host's absolute path so the composer can name the file in the prompt (§7.4)", () => {
    const fromHost = {
      type: "file" as const,
      id: "t1-uuid-xlsx",
      name: "q3.xlsx",
      sizeBytes: 5,
      path: "/appdir/daemon/agent/threads/t1/attachments/t1-uuid-xlsx.xlsx"
    };
    assert.deepEqual(attachmentRefFromUpload(fromHost, { name: "q3.xlsx" }), fromHost);
  });
```

It passes already (the ref is returned verbatim). Extend the doc comment of `attachmentRefFromUpload` in `transport.ts` with: `The host's answer now also carries the absolute \`path\` (§7.4); it rides the ref verbatim — the host strips it from every command body.`

- [ ] **Step 5: The composer — caret ref, insert on completion, remove with the chip**

In `ChatComposer.tsx`:

(a) Imports: add `import { removeFilePath, textNamesPath } from "./composer-files";` next to the `composer-images` import, and `import { attachmentPathOf } from "../../../lib/agent-chat/composer.logic";`.

(b) Next to `const draftRef = React.useRef<DraftState>(EMPTY_DRAFT);` add `const caretRef = React.useRef(0);`. Next to `draftRef.current = draft;` (line 239) add `caretRef.current = cursor;`.

(c) Replace `insertText` (lines 431–461, comment included) with:

```ts
  /**
   * Insert text into the draft.
   *
   * **Batch-safe**, exactly as `stageAttachment` below is and for the same
   * reason: `draftRef.current` is refreshed in the render body, so several
   * calls in one synchronous tick would otherwise all read the same pre-batch
   * text and the last write would win. `drainQueueToComposer` calls this once
   * per queued message in a loop, so a non-batch-safe version silently drops
   * every returned message but the last — the exact data loss §7.4 forbids.
   *
   * The caret comes from `caretRef` — synced from state on render, advanced
   * optimistically here — never from the closure: a call that lands late (a
   * file's path arrives when its upload completes) inserts at the caret the
   * user has NOW, and two inserts in one tick land in order rather than both
   * at the pre-batch caret.
   */
  const insertText = React.useCallback(
    (text: string, mode: "cursor" | "append" = "cursor") => {
      if (!text) return;
      const current = draftRef.current;
      const at =
        mode === "append" ? current.text.length : Math.min(caretRef.current, current.text.length);
      const gap =
        at > 0 && !/\s$/.test(current.text.slice(0, at)) && !/^\s/.test(text) ? " " : "";
      const applied = replaceTextRange(current.text, at, at, `${gap}${text}`);
      draftRef.current = { ...current, text: applied.text };
      caretRef.current = applied.cursor;
      setDraft((state) =>
        state.text === applied.text ? state : { ...state, text: applied.text }
      );
      applyCaret(applied.cursor);
    },
    [applyCaret]
  );
```

(d) In `stageAttachment`, replace the two lines after the `// An image gets its …` comment with:

```ts
    // An image gets its `[Image #N]` at the caret, as the CLI does on paste,
    // so the text can name it. A file gets its absolute path — unless the text
    // already names it, as a returned queued message's text does (§7.4).
    const ordinal = imageOrdinal(draftRef.current.attachments, entry.key);
    const path = attachmentPathOf(ref);
    if (ordinal !== null) {
      insertText(imagePlaceholder(ordinal), "cursor");
    } else if (path !== undefined && !textNamesPath(draftRef.current.text, path)) {
      insertText(path, "cursor");
    }
```

(e) Replace `uploadOne` with:

```ts
  const uploadOne = React.useCallback(
    async (key: string, file: File) => {
      try {
        const ref: AttachmentRef = await actions.uploadAttachment(file, {
          name: file.name,
          type: file.type
        });
        // The chip may be gone — removed while the bytes were still going up.
        // A late success must neither resurrect it nor write its path.
        if (!draftRef.current.attachments.some((entry) => entry.key === key)) return;
        const ready = (entries: StagedAttachment[]): StagedAttachment[] =>
          entries.map((entry) =>
            entry.key === key ? { ...entry, status: "ready" as const, progress: 1, ref } : entry
          );
        draftRef.current = { ...draftRef.current, attachments: ready(draftRef.current.attachments) };
        setDraft((state) => ({ ...state, attachments: ready(state.attachments) }));
        // A file's path is known only now, so this is where it reaches the
        // prompt — at the live caret, as the terminal-era upload typed it into
        // the PTY (`composer-files.ts`). Images already have `[Image #N]`.
        const path = attachmentPathOf(ref);
        if (
          !file.type.startsWith("image/") &&
          path !== undefined &&
          !textNamesPath(draftRef.current.text, path)
        ) {
          insertText(path, "cursor");
        }
      } catch (error) {
        setDraft((state) => ({
          ...state,
          attachments: state.attachments.map((entry) =>
            entry.key === key
              ? {
                  ...entry,
                  status: "failed" as const,
                  error: error instanceof Error ? error.message : "Upload failed"
                }
              : entry
          )
        }));
      }
    },
    [actions, insertText]
  );
```

(f) Replace `removeAttachment` with:

```ts
  const removeAttachment = React.useCallback((key: string) => {
    retryFilesRef.current.delete(key);
    const current = draftRef.current;
    const entry = current.attachments.find((candidate) => candidate.key === key);
    // Its `[Image #N]` — or, for a file, its path — leaves with it; the later
    // images close the gap.
    const ordinal = imageOrdinal(current.attachments, key);
    const path = attachmentPathOf(entry?.ref);
    const strip = (text: string): string =>
      ordinal !== null
        ? removeImagePlaceholder(text, ordinal)
        : path !== undefined
          ? removeFilePath(text, path)
          : text;
    draftRef.current = {
      ...current,
      text: strip(current.text),
      attachments: current.attachments.filter((candidate) => candidate.key !== key)
    };
    setDraft((state) => ({
      ...state,
      text: strip(state.text),
      attachments: state.attachments.filter((candidate) => candidate.key !== key)
    }));
  }, []);
```

(g) The mount-time doc comment ("The load deliberately does NOT go through `stageAttachment`…", lines ~250–254) and the same note in `composer-draft.ts` (`loadComposerDraft` doc): append `The same holds for a file's path: the restored text already carries it.`

- [ ] **Step 6: The inbox fallback names the path when it has one**

In `packages/ui/src/lib/composer-inbox.ts`, import `attachmentPathOf` from `./agent-chat/composer.logic` and replace the doc + first line of `composerTextForDelivery`:

```ts
/**
 * A delivery as composer text.
 *
 * Attachments the composer could not stage are appended one per line as their
 * **absolute host path** when the upload answered one (`AttachmentRef.path`,
 * §7.4 — the same contract the terminal path had, minus the bracketed-paste
 * escape a textarea has no use for), else as their id, which is all an older
 * reply carried. The adapters read the file from disk either way.
 */
export function composerTextForDelivery(delivery: ComposerDelivery): string {
  const paths = delivery.attachments
    .map((attachment) => attachmentPathOf(attachment) ?? attachment.id)
    .filter((entry) => entry.length > 0);
```

In `composer-inbox.test.ts`, extend the test "a delivery becomes draft text plus one attachment path per line" with a ref carrying `path: "/appdir/x.xlsx"` and assert that line is the path, while an id-only ref still contributes its id.

Run: `cd packages/ui && node --import tsx --import ./test/svg-loader.mjs --test src/lib/composer-inbox.test.ts`
Expected: PASS.

- [ ] **Step 7: Delete the dead chat upload helper**

In `packages/ui/src/lib/session-upload.ts`, delete `uploadFilesToChatDraft` and `attachmentRefFor` (the doc comment at 105–113 through line 171). Remove the imports that become unused (`SUPPORTED_ATTACHMENT_IMAGE_MIME_TYPES`, `AttachmentRef`, `SessionUploadResponse`, `deliverToComposerDraft`) — check each with `grep -n` in the file before deleting. Confirm nothing imports them: `grep -rn "uploadFilesToChatDraft\|attachmentRefFor\b" packages apps --include=*.ts --include=*.tsx` must print nothing.

- [ ] **Step 8: Fix the element picker's chat delivery**

In `packages/ui/src/components/browser/PickComposeSheet.tsx`:
- Replace the `imageAttachment` helper (lines 13–23) with imports: `import { attachmentRefFromUpload } from "../../lib/agent-chat/transport";` and `import { attachmentPathOf } from "../../lib/agent-chat/composer.logic";`.
- Change the cache to hold the ref: `const uploadedRef = useRef(new WeakMap<BrowserPickPayload, { targetId: string; ref: AttachmentRef; path: string | undefined }>());` and update its comment: a chat target answers the host-minted `AttachmentRef` (now with its host `path`), a terminal target answers `{path, name, size}`; `attachmentRefFromUpload` reads both.
- In the loop:

```ts
        const cached = uploadedRef.current.get(payload);
        if (cached && cached.targetId === targetId) {
          screenshotPath = cached.path;
          attachments.push(cached.ref);
        } else if (payload.screenshotBase64) {
          const blob = pending[slot].blob!;
          batch.begin(slot, name);
          const uploaded = await api.uploadSessionFile(targetId, { name, type: "image/png" }, blob, batch.onBytes);
          batch.finish();
          slot++;
          const ref = attachmentRefFromUpload(uploaded, { name, type: "image/png" });
          screenshotPath = attachmentPathOf(ref) ?? uploaded.path;
          uploadedRef.current.set(payload, { targetId, ref, path: screenshotPath });
          attachments.push(ref);
        }
```

`api.uploadSessionFile` is typed to return `SessionUploadResponse`; `attachmentRefFromUpload` accepts `SessionUploadResponse | AttachmentRef`, so no cast is needed. If `uploaded.path` is typed non-optional, `attachmentPathOf(ref) ?? uploaded.path` still typechecks.

- [ ] **Step 9: UI typecheck and tests**

Run: `pnpm --filter @orquester/ui typecheck && pnpm --filter @orquester/ui test`
Expected: clean; ≥ 847 + new tests pass, 0 failures. If a `.check.ts` render smoke constructs `AgentChatActions`, nothing changed in that interface in this task.

---

### Task 5: File-type icons — vendored SVGs, the resolver, the timeline chips, the light-mode rule

**Files:**
- Create: `packages/ui/src/icons/files/*.svg` (40 files, listed below), `packages/ui/src/icons/files/LICENSE`, `packages/ui/src/icons/files/README.md`, `packages/ui/src/icons/files/index.tsx`
- Create: `packages/ui/src/lib/file-icon.ts`, `packages/ui/src/lib/file-icon.test.ts`
- Modify: `packages/ui/src/lib/file-kind.ts:74-80` (export `extOf`)
- Modify: `packages/ui/src/components/agent-chat/timeline/rows/MessageRows.tsx:2, 29-56`
- Modify: `packages/ui/src/styles/globals.css` (append one rule)

**Interfaces:**
- Produces: `FILE_ICON_IDS`, `type FileIconId`, `fileIconIdFor({ name?, mimeType? }): FileIconId` (lib); `FILE_ICONS: Record<FileIconId, SvgIcon>` and `FileTypeIcon({ name?, mimeType?, size?, className? })` (icons). Task 6 consumes `FileTypeIcon`.

- [ ] **Step 1: Vendor the icons**

```bash
cd /var/lib/orquester/workspaces/jaspersito/orquester-3
mkdir -p packages/ui/src/icons/files
for n in table word powerpoint pdf json yaml toml xml database jupyter zip typescript react_ts javascript react python rust go java c cpp csharp ruby php swift console powershell html css sass markdown document log image svg audio video lock font file; do
  curl -sSf "https://cdn.jsdelivr.net/npm/material-icon-theme@5.38.1/icons/$n.svg" -o "packages/ui/src/icons/files/$n.svg" || echo "MISSING $n"
done
curl -sSf "https://raw.githubusercontent.com/material-extensions/vscode-material-icon-theme/main/LICENSE" -o packages/ui/src/icons/files/LICENSE
ls packages/ui/src/icons/files/*.svg | wc -l          # expect 40
grep -l '<style\|<image\|url(#\|<script\|id="' packages/ui/src/icons/files/*.svg   # expect NO output
for f in packages/ui/src/icons/files/*.svg; do head -c 4 "$f" | grep -q '<svg' || echo "NOT SVG: $f"; done
```

If a name is MISSING, look it up in `https://cdn.jsdelivr.net/npm/material-icon-theme@5.38.1/dist/material-icons.json` (`iconDefinitions` keys) and substitute the closest; if `id="` matches a file, replace that icon with a simpler one from the same set (the research found only `kotlin.svg` uses a gradient id, which is why it is not in the list).

Write `packages/ui/src/icons/files/README.md`:

```md
# File-type icons

A vendored subset of [Material Icon Theme](https://github.com/material-extensions/vscode-material-icon-theme)
(`material-icon-theme@5.38.1`, MIT — see `LICENSE`), the VS Code explorer's file icons, used by the
agent-chat attachment chips (`lib/file-icon.ts` maps an extension/mime to one of these ids).

To refresh or add an icon: `curl -sSf https://cdn.jsdelivr.net/npm/material-icon-theme@<version>/icons/<name>.svg -o <name>.svg`,
then check it has no `<style>`, `<image>`, `id=` or `url(#…)` (the files are inlined into one DOM) and add the id to
`FILE_ICON_IDS` and `FILE_ICONS`. Brand-shaped Office icons are deliberately not used (trademark guidelines forbid
decorative use); `word`/`powerpoint`/`table` are generic pictograms.
```

- [ ] **Step 2: Write the failing resolver tests**

Create `packages/ui/src/lib/file-icon.test.ts`:

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FILE_ICON_IDS, fileIconIdFor } from "./file-icon.ts";
import { FILE_ICONS } from "../icons/files/index.tsx";

describe("file-type icons", () => {
  it("resolves office, data and code files by extension, case-insensitively", () => {
    assert.equal(fileIconIdFor({ name: "Q3 Report.XLSX" }), "table");
    assert.equal(fileIconIdFor({ name: "data.csv" }), "table");
    assert.equal(fileIconIdFor({ name: "memo.docx" }), "word");
    assert.equal(fileIconIdFor({ name: "deck.pptx" }), "powerpoint");
    assert.equal(fileIconIdFor({ name: "paper.pdf" }), "pdf");
    assert.equal(fileIconIdFor({ name: "archive.tar.gz" }), "zip");
    assert.equal(fileIconIdFor({ name: "App.tsx" }), "react_ts");
    assert.equal(fileIconIdFor({ name: "notes.md" }), "markdown");
    assert.equal(fileIconIdFor({ name: "shot.PNG" }), "image");
  });

  it("falls back to the mime when the name has no usable extension", () => {
    assert.equal(fileIconIdFor({ name: "pasted", mimeType: "text/csv" }), "table");
    assert.equal(fileIconIdFor({ mimeType: "application/pdf" }), "pdf");
    assert.equal(fileIconIdFor({ mimeType: "image/png" }), "image");
    assert.equal(fileIconIdFor({ mimeType: "text/plain; charset=utf-8" }), "document");
    assert.equal(fileIconIdFor({ mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), "table");
  });

  it("is the generic file for the unknown: no extension, no mime, octet-stream", () => {
    assert.equal(fileIconIdFor({ name: "README" }), "file");
    assert.equal(fileIconIdFor({ name: "blob.xyz123", mimeType: "application/octet-stream" }), "file");
    assert.equal(fileIconIdFor({ name: "", mimeType: "" }), "file");
    assert.equal(fileIconIdFor({}), "file");
  });

  it("backs every id with an icon component", () => {
    for (const id of FILE_ICON_IDS) {
      assert.equal(typeof FILE_ICONS[id], "function", id);
    }
  });
});
```

Run: `cd packages/ui && node --import tsx --import ./test/svg-loader.mjs --test src/lib/file-icon.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Export `extOf` and write the resolver**

In `packages/ui/src/lib/file-kind.ts`, change `function extOf(` to `export function extOf(` (doc unchanged).

Create `packages/ui/src/lib/file-icon.ts`:

```ts
/**
 * File-type icons for attachment chips (spec §7.4 Built note).
 *
 * A closed set of icon ids, each backed by one vendored Material Icon Theme
 * SVG in `icons/files/` (MIT; version pinned in `icons/files/README.md`).
 * Resolution is extension first — the user's own spelling of the file — then
 * the exact mime, then the mime family, then the generic file. Extension-based
 * like `file-kind.ts`: no sniffing, synchronous, never throws.
 */

import { extOf } from "./file-kind";

export const FILE_ICON_IDS = [
  "table", "word", "powerpoint", "pdf", "json", "yaml", "toml", "xml", "database", "jupyter",
  "zip", "typescript", "react_ts", "javascript", "react", "python", "rust", "go", "java", "c",
  "cpp", "csharp", "ruby", "php", "swift", "console", "powershell", "html", "css", "sass",
  "markdown", "document", "log", "image", "svg", "audio", "video", "lock", "font", "file"
] as const;

export type FileIconId = (typeof FILE_ICON_IDS)[number];

// extension (no dot, lowercased; `extOf` collapses `.tar.*`) -> icon
const BY_EXTENSION: Record<string, FileIconId> = {
  xlsx: "table", xls: "table", xlsm: "table", ods: "table", csv: "table", tsv: "table",
  docx: "word", doc: "word", odt: "word", rtf: "word",
  pptx: "powerpoint", ppt: "powerpoint", odp: "powerpoint",
  pdf: "pdf",
  json: "json", jsonc: "json", json5: "json",
  yaml: "yaml", yml: "yaml",
  toml: "toml",
  xml: "xml", plist: "xml",
  sql: "database", db: "database", sqlite: "database", sqlite3: "database", parquet: "database",
  ipynb: "jupyter",
  zip: "zip", tar: "zip", gz: "zip", tgz: "zip", bz2: "zip", xz: "zip", "7z": "zip", rar: "zip",
  ts: "typescript", mts: "typescript", cts: "typescript", tsx: "react_ts",
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "react",
  py: "python", rs: "rust", go: "go", java: "java",
  c: "c", h: "c", cpp: "cpp", cc: "cpp", hpp: "cpp", cs: "csharp",
  rb: "ruby", php: "php", swift: "swift",
  sh: "console", bash: "console", zsh: "console", fish: "console", ps1: "powershell",
  html: "html", htm: "html", css: "css", scss: "sass", sass: "sass",
  md: "markdown", markdown: "markdown", mdx: "markdown",
  txt: "document", log: "log",
  png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image", bmp: "image",
  avif: "image", ico: "image", svg: "svg",
  mp3: "audio", wav: "audio", flac: "audio", m4a: "audio", aac: "audio", ogg: "audio",
  mp4: "video", mov: "video", webm: "video", mkv: "video", avi: "video", m4v: "video",
  lock: "lock", ttf: "font", otf: "font", woff: "font", woff2: "font"
};

// exact mime (lowercased, parameters stripped) -> icon
const BY_MIME: Record<string, FileIconId> = {
  "text/csv": "table",
  "text/tab-separated-values": "table",
  "application/vnd.ms-excel": "table",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "table",
  "application/vnd.oasis.opendocument.spreadsheet": "table",
  "application/msword": "word",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "word",
  "application/vnd.oasis.opendocument.text": "word",
  "application/rtf": "word",
  "application/vnd.ms-powerpoint": "powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "powerpoint",
  "application/vnd.oasis.opendocument.presentation": "powerpoint",
  "application/pdf": "pdf",
  "application/json": "json",
  "application/zip": "zip",
  "application/x-zip-compressed": "zip",
  "application/x-7z-compressed": "zip",
  "application/x-tar": "zip",
  "application/gzip": "zip",
  "application/vnd.rar": "zip",
  "application/x-rar-compressed": "zip",
  "text/markdown": "markdown",
  "text/html": "html",
  "text/css": "css",
  "text/javascript": "javascript",
  "application/javascript": "javascript",
  "application/xml": "xml",
  "text/xml": "xml",
  "text/yaml": "yaml",
  "application/yaml": "yaml",
  "application/x-yaml": "yaml",
  "application/x-sh": "console",
  "text/x-python": "python",
  "application/vnd.apache.parquet": "database",
  "application/x-sqlite3": "database",
  "image/svg+xml": "svg",
  "application/x-ipynb+json": "jupyter"
};

export function fileIconIdFor(input: { name?: string; mimeType?: string }): FileIconId {
  const extension = input.name ? extOf(input.name) : "";
  const byExtension = extension ? BY_EXTENSION[extension] : undefined;
  if (byExtension) return byExtension;
  const mime = (input.mimeType ?? "").trim().toLowerCase().split(";")[0]?.trim() ?? "";
  if (mime.length === 0) return "file";
  const byMime = BY_MIME[mime];
  if (byMime) return byMime;
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("text/")) return "document";
  return "file";
}
```

- [ ] **Step 4: Write the icon barrel and component**

Create `packages/ui/src/icons/files/index.tsx` (one import per id — the file is the `Record` that makes a missing SVG a typecheck error):

```tsx
import React from "react";

import { fileIconIdFor, type FileIconId } from "../../lib/file-icon";

import Audio from "./audio.svg?react";
import C from "./c.svg?react";
import Console from "./console.svg?react";
import Cpp from "./cpp.svg?react";
import Csharp from "./csharp.svg?react";
import Css from "./css.svg?react";
import Database from "./database.svg?react";
import Document from "./document.svg?react";
import File from "./file.svg?react";
import Font from "./font.svg?react";
import Go from "./go.svg?react";
import Html from "./html.svg?react";
import Image from "./image.svg?react";
import Java from "./java.svg?react";
import Javascript from "./javascript.svg?react";
import Json from "./json.svg?react";
import Jupyter from "./jupyter.svg?react";
import Lock from "./lock.svg?react";
import Log from "./log.svg?react";
import Markdown from "./markdown.svg?react";
import Pdf from "./pdf.svg?react";
import Php from "./php.svg?react";
import Powerpoint from "./powerpoint.svg?react";
import Powershell from "./powershell.svg?react";
import Python from "./python.svg?react";
import React_ from "./react.svg?react";
import ReactTs from "./react_ts.svg?react";
import Ruby from "./ruby.svg?react";
import Rust from "./rust.svg?react";
import Sass from "./sass.svg?react";
import Svg from "./svg.svg?react";
import Swift from "./swift.svg?react";
import Table from "./table.svg?react";
import Toml from "./toml.svg?react";
import Typescript from "./typescript.svg?react";
import Video from "./video.svg?react";
import Word from "./word.svg?react";
import Xml from "./xml.svg?react";
import Yaml from "./yaml.svg?react";
import Zip from "./zip.svg?react";

type SvgIcon = React.FunctionComponent<React.SVGProps<SVGSVGElement>>;

/** One vendored SVG per id; the `Record` makes a missing icon a typecheck error. */
export const FILE_ICONS: Record<FileIconId, SvgIcon> = {
  table: Table, word: Word, powerpoint: Powerpoint, pdf: Pdf, json: Json, yaml: Yaml, toml: Toml,
  xml: Xml, database: Database, jupyter: Jupyter, zip: Zip, typescript: Typescript,
  react_ts: ReactTs, javascript: Javascript, react: React_, python: Python, rust: Rust, go: Go,
  java: Java, c: C, cpp: Cpp, csharp: Csharp, ruby: Ruby, php: Php, swift: Swift,
  console: Console, powershell: Powershell, html: Html, css: Css, sass: Sass,
  markdown: Markdown, document: Document, log: Log, image: Image, svg: Svg, audio: Audio,
  video: Video, lock: Lock, font: Font, file: File
};

export interface FileTypeIconProps {
  name?: string;
  mimeType?: string;
  size?: number;
  className?: string;
}

/**
 * The file-type glyph for an attachment: a Material Icon Theme SVG picked by
 * extension, then mime (`lib/file-icon.ts`). `data-file-icon` is the hook the
 * light-mode filter in `globals.css` uses — nothing here branches on the mode.
 */
export function FileTypeIcon({ name, mimeType, size = 16, className }: FileTypeIconProps): React.ReactElement {
  const Icon = FILE_ICONS[fileIconIdFor({ name, mimeType })];
  return <Icon width={size} height={size} aria-hidden data-file-icon="" className={className} />;
}
```

If `import File from "./file.svg?react"` shadows the DOM `File` type anywhere in this file (it does not — the file uses no `File` value), keep it; otherwise alias it `FileGeneric`.

Run the resolver tests. Expected: PASS (the `.svg?react` imports resolve to the null-rendering stub under the test loader).

- [ ] **Step 5: Timeline chips use the same icons**

In `packages/ui/src/components/agent-chat/timeline/rows/MessageRows.tsx`: import `FileTypeIcon` from `"../../../../icons/files"`; in `AttachmentChips` replace the `attachment.type === "image" ? <ImageIcon …/> : <FileText …/>` ternary with `<FileTypeIcon name={attachment.name} mimeType={attachment.mimeType} size={14} className="shrink-0" />`; drop `FileText` and `Image as ImageIcon` from the lucide import **only if** `grep -n "FileText\|ImageIcon" MessageRows.tsx` shows no other use. Replace the "DELIBERATE DIFFERENCE FROM T3" comment (lines 29–37) with:

```ts
/**
 * Attachment chips.
 *
 * DELIBERATE DIFFERENCE FROM T3: T3 renders image thumbnails from a signed
 * asset URL. §6.3's read-back route exists, but the timeline does not fetch
 * it (§7.3 Built): nothing decodes a 10 MiB image into a bubble on a phone.
 * An attachment renders as a named chip with the file-type icon the composer
 * uses (`icons/files`), so a sent `.xlsx` looks like the chip the user staged.
 */
```

- [ ] **Step 6: The light-mode rule**

Append to `packages/ui/src/styles/globals.css` (at the end of the file, after the scheme blocks):

```css
/* Vendored file-type icons (packages/ui/src/icons/files) are drawn for dark
   surfaces; on light ones their pastel fills wash out, so one filter deepens
   them. Data, not component logic: no component branches on the mode. */
[data-mode="light"] [data-file-icon] {
  filter: saturate(1.15) brightness(0.82);
}
```

- [ ] **Step 7: UI typecheck and tests**

Run: `pnpm --filter @orquester/ui typecheck && pnpm --filter @orquester/ui test`
Expected: clean, 0 failures (the `.check.ts` smoke renders the timeline with the stubbed SVGs).

---

### Task 6: Composer chips — icons, thumbnails, hover preview, lazy bytes

**Files:**
- Modify: `packages/ui/src/components/agent-chat/composer/ComposerAttachments.tsx` (whole file)
- Modify: `packages/ui/src/components/agent-chat/composer/composer-images.ts` (add `revokeImagePreviews`) and `composer-images.test.ts`
- Modify: `packages/ui/src/components/agent-chat/composer/ChatComposer.tsx` (`stageFiles` 745–802, `removeAttachment`, `submit` ~960–968, the `sessionId` layout effect 256–268, an unmount effect, the `<ComposerAttachments>` mount 1242–1247)
- Modify: `packages/ui/src/lib/agent-chat/contracts.ts:447-448` (add `fetchAttachmentBytes`), `packages/ui/src/lib/agent-chat/store.ts:803-805`, `packages/ui/src/lib/agent-chat/transport.ts:302-314` (add `fetchAttachment`), plus the transport interface those implement (grep `upload(` in `contracts.ts`/`transport.ts`)
- Test: `packages/ui/src/lib/agent-chat/transport.test.ts`, any test fake that implements the transport/actions interface (typecheck tells you)

**Interfaces:**
- Consumes: `FileTypeIcon` (Task 5), `attachmentPathOf` (Task 4).
- Produces: `StagedAttachment.previewUrl?: string`; `ComposerAttachmentsProps.resolvePreview?: (attachment) => Promise<string | null>`; `AgentChatActions.fetchAttachmentBytes(attachmentId: string, signal?: AbortSignal): Promise<ArrayBuffer>`; transport `fetchAttachment(sessionId, attachmentId, signal?)`.

- [ ] **Step 1: `revokeImagePreviews` (pure helper) with a test**

In `composer-images.ts` append:

```ts
/**
 * Release the object URLs behind image chips (§7.4 thumbnail + hover preview).
 * Called when a chip is removed, when the draft is sent, on a thread swap and
 * on unmount — a URL that outlives its chip pins the whole file in memory.
 */
export function revokeImagePreviews(
  attachments: readonly { previewUrl?: string }[],
  revoke: (url: string) => void = (url) => URL.revokeObjectURL(url)
): void {
  for (const attachment of attachments) {
    if (attachment.previewUrl) revoke(attachment.previewUrl);
  }
}
```

In `composer-images.test.ts` add:

```ts
  it("revokes every preview URL a chip set holds, and only those", () => {
    const revoked: string[] = [];
    revokeImagePreviews(
      [{ previewUrl: "blob:a" }, {}, { previewUrl: "blob:b" }],
      (url) => revoked.push(url)
    );
    assert.deepEqual(revoked, ["blob:a", "blob:b"]);
  });
```

(Import `revokeImagePreviews` at the top.) Run the file's tests: PASS.

- [ ] **Step 2: The byte fetch — transport, store, contract**

In `packages/ui/src/lib/agent-chat/transport.ts`, next to `upload` add (the `Transporter`'s `requestBytes` is optional, as `api-client.ts:416-425` treats it):

```ts
    async fetchAttachment(sessionId, attachmentId, signal) {
      if (!transporter.requestBytes) {
        throw new Error("Attachment preview is not supported on this connection.");
      }
      const response = await transporter.requestBytes({
        method: "GET",
        path: agentChatRoutes.attachment(sessionId, attachmentId),
        ...(signal === undefined ? {} : { signal })
      });
      if (!response.ok) {
        throw commandErrorFrom(response.status, undefined, "Attachment fetch failed");
      }
      return response.data;
    }
```

Add to the transport interface (where `upload` is declared): 

```ts
  /** §6.3 read-back: the attachment's bytes, for a chip's thumbnail/preview. */
  fetchAttachment(sessionId: string, attachmentId: string, signal?: AbortSignal): Promise<ArrayBuffer>;
```

In `contracts.ts` after `uploadAttachment`:

```ts
  /** `GET /api/sessions/:id/attachments/:attachmentId` — bytes for an image chip's preview (§7.4). */
  fetchAttachmentBytes(attachmentId: string, signal?: AbortSignal): Promise<ArrayBuffer>;
```

In `store.ts` after `uploadAttachment`:

```ts
      fetchAttachmentBytes(attachmentId, signal) {
        return deps.transport.fetchAttachment(sessionId, attachmentId, signal);
      },
```

Run `pnpm --filter @orquester/ui typecheck`; add `fetchAttachment: async () => new ArrayBuffer(0)` / `fetchAttachmentBytes: async () => new ArrayBuffer(0)` to every test fake the typecheck flags. Add to `transport.test.ts` one test: with a `FakeTransporter` that has no `requestBytes`, `fetchAttachment` rejects with `/not supported/`; with one that answers `{ ok: true, status: 200, data: new ArrayBuffer(3) }` it resolves the bytes and requested `GET /api/sessions/s1/attachments/att-1` (follow the file's existing fake-transporter conventions).

- [ ] **Step 3: Rewrite `ComposerAttachments.tsx`**

```tsx
import React from "react";
import { createPortal } from "react-dom";
import { RotateCcw, X } from "lucide-react";
import type { AttachmentRef } from "@orquester/api/agent-chat";

import { imageOrdinal } from "./composer-images";
import { cn } from "../../../lib/cn";
import { FileTypeIcon } from "../../../icons/files";
import { ChatIconButton } from "../primitives";

/** One file staged in the draft, with the state of its own upload. */
export interface StagedAttachment {
  key: string;
  name: string;
  sizeBytes: number;
  mimeType: string;
  status: "uploading" | "ready" | "failed";
  /** 0–1 while uploading; the chip draws it as a fill, never as a number. */
  progress: number;
  ref?: AttachmentRef;
  error?: string;
  /**
   * An object URL of the local `File`, while the composer still holds it —
   * the chip's thumbnail and hover preview (§7.4). Never persisted: a reloaded
   * chip has none and resolves one lazily through `resolvePreview` on hover.
   */
  previewUrl?: string;
}

export interface ComposerAttachmentsProps {
  attachments: readonly StagedAttachment[];
  onRemove: (key: string) => void;
  onRetry: (key: string) => void;
  disabled?: boolean;
  /**
   * Resolve a preview for an image chip that has no `previewUrl` (a reloaded
   * draft, a delivered ref): an object URL this component then owns and
   * revokes, or null when the bytes cannot be fetched.
   */
  resolvePreview?: (attachment: StagedAttachment) => Promise<string | null>;
}

interface HoverAnchor {
  key: string;
  /** Viewport x of the chip's centre. */
  left: number;
  /** Distance from the viewport bottom to the chip's top edge, plus a gap. */
  bottom: number;
}

/** Half of the preview card's max width (`max-w-64` = 256px) plus its padding. */
const PREVIEW_HALF_WIDTH_PX = 136;

/**
 * The attachment chips.
 *
 * **Upload progress is a fill behind the name, not a percentage.** A number
 * that ticks changes width and makes the whole row twitch; the fill says the
 * same thing and stays still. A failed upload keeps its chip and offers a
 * retry, because the alternative — dropping the file silently — leaves the
 * user sending a message that no longer references what they attached.
 *
 * Every chip carries the file-type icon of `icons/files`; an image chip shows
 * a thumbnail instead and a hover preview above it, portaled because the
 * chip clips its overflow. The preview is hover-only: touch has no hover and
 * the chip is already the file's name.
 *
 * *T3: `docs/user/composer.md:20-24` — "Uploads begin when you add an
 * attachment. All uploads must finish before the message can send. Retry or
 * remove a failed upload."*
 */
export function ComposerAttachments({
  attachments,
  onRemove,
  onRetry,
  disabled,
  resolvePreview
}: ComposerAttachmentsProps): React.ReactElement | null {
  const [hover, setHover] = React.useState<HoverAnchor | null>(null);
  // Lazily resolved previews by chip key (null = tried and failed). Owned
  // here and revoked on unmount; `previewUrl`s are the composer's to revoke.
  const [lazyUrls, setLazyUrls] = React.useState<Record<string, string | null>>({});
  const lazyRef = React.useRef(lazyUrls);
  lazyRef.current = lazyUrls;
  const pendingRef = React.useRef(new Set<string>());

  React.useEffect(
    () => () => {
      for (const url of Object.values(lazyRef.current)) {
        if (url) URL.revokeObjectURL(url);
      }
    },
    []
  );

  const previewFor = (attachment: StagedAttachment): string | null =>
    attachment.previewUrl ?? lazyUrls[attachment.key] ?? null;

  const requestPreview = (attachment: StagedAttachment): void => {
    if (attachment.previewUrl || !resolvePreview) return;
    if (attachment.key in lazyRef.current || pendingRef.current.has(attachment.key)) return;
    pendingRef.current.add(attachment.key);
    void resolvePreview(attachment)
      .catch(() => null)
      .then((url) => {
        pendingRef.current.delete(attachment.key);
        setLazyUrls((state) => ({ ...state, [attachment.key]: url }));
      });
  };

  if (attachments.length === 0) return null;
  const hovered = hover ? attachments.find((attachment) => attachment.key === hover.key) : undefined;
  const hoveredUrl = hovered ? previewFor(hovered) : null;

  return (
    <div
      data-chat-composer-attachments="true"
      className="flex flex-wrap items-center gap-1.5 pb-2"
    >
      {attachments.map((attachment) => {
        const isImage = attachment.mimeType.startsWith("image/");
        const ordinal = isImage ? imageOrdinal(attachments, attachment.key) : null;
        const failed = attachment.status === "failed";
        const thumbnail = isImage ? previewFor(attachment) : null;
        return (
          <span
            key={attachment.key}
            title={attachment.error ?? attachment.name}
            data-attachment-chip={isImage ? "image" : "file"}
            className={cn(
              "relative inline-flex h-7 max-w-56 items-center gap-1.5 overflow-hidden rounded-md",
              "border px-2 text-[11px]",
              failed
                ? "border-danger-900/50 bg-danger-soft/40 text-danger-300"
                : "border-neutral-800 bg-neutral-900/60 text-neutral-300"
            )}
            onMouseEnter={
              isImage
                ? (event) => {
                    requestPreview(attachment);
                    const rect = event.currentTarget.getBoundingClientRect();
                    setHover({
                      key: attachment.key,
                      left: rect.left + rect.width / 2,
                      bottom: window.innerHeight - rect.top + 6
                    });
                  }
                : undefined
            }
            onMouseLeave={
              isImage
                ? () => setHover((state) => (state?.key === attachment.key ? null : state))
                : undefined
            }
          >
            {attachment.status === "uploading" ? (
              <span
                aria-hidden
                className="absolute inset-y-0 left-0 bg-neutral-800/70 transition-[width] duration-200"
                style={{ width: `${Math.round(Math.min(1, Math.max(0, attachment.progress)) * 100)}%` }}
              />
            ) : null}
            <span className="relative flex h-4 w-4 shrink-0 items-center justify-center">
              {thumbnail ? (
                <img src={thumbnail} alt="" className="h-4 w-4 rounded-[3px] object-cover" />
              ) : (
                <FileTypeIcon name={attachment.name} mimeType={attachment.mimeType} size={16} />
              )}
            </span>
            {ordinal !== null ? (
              <span className="relative shrink-0 font-mono text-[10px] text-neutral-500">#{ordinal}</span>
            ) : null}
            <span className="relative truncate">{attachment.name}</span>
            {failed ? (
              <ChatIconButton
                label={`Retry ${attachment.name}`}
                size="micro"
                disabled={disabled}
                className="relative"
                onClick={() => onRetry(attachment.key)}
              >
                <RotateCcw size={10} aria-hidden />
              </ChatIconButton>
            ) : null}
            <ChatIconButton
              label={`Remove ${attachment.name}`}
              size="micro"
              disabled={disabled}
              className="relative"
              onClick={() => onRemove(attachment.key)}
            >
              <X size={10} aria-hidden />
            </ChatIconButton>
          </span>
        );
      })}
      {hover && hoveredUrl
        ? createPortal(
            <div
              role="img"
              aria-label={`Preview of ${hovered?.name ?? "image"}`}
              style={{
                position: "fixed",
                left: Math.min(
                  Math.max(hover.left, PREVIEW_HALF_WIDTH_PX),
                  window.innerWidth - PREVIEW_HALF_WIDTH_PX
                ),
                bottom: hover.bottom,
                transform: "translateX(-50%)"
              }}
              className="pointer-events-none z-[120] rounded-lg border border-neutral-800 bg-neutral-900 p-1 shadow-lg"
            >
              <img src={hoveredUrl} alt="" className="block max-h-48 max-w-64 rounded-md object-contain" />
            </div>,
            document.body
          )
        : null}
    </div>
  );
}
```

- [ ] **Step 4: The composer owns the local preview URLs**

In `ChatComposer.tsx`:

(a) Import `revokeImagePreviews` from `./composer-images`.

(b) In `stageFiles`, where each accepted entry is built, add `previewUrl` for images:

```ts
        accepted.push({
          file,
          entry: {
            key: `${file.name}:${file.size}:${Date.now()}:${accepted.length}:${Math.random()}`,
            name: file.name,
            sizeBytes: file.size,
            mimeType: file.type,
            status: "uploading",
            progress: 0,
            // The thumbnail and hover preview, from the bytes already in hand.
            ...(file.type.startsWith("image/") ? { previewUrl: URL.createObjectURL(file) } : {})
          }
        });
```

(c) In `removeAttachment` (Task 4's version), right after `const entry = …`, add `if (entry?.previewUrl) URL.revokeObjectURL(entry.previewUrl);`.

(d) In `submit`, immediately before `setDraft(EMPTY_DRAFT);`, add `revokeImagePreviews(draft.attachments);`.

(e) In the `useLayoutEffect` keyed on `sessionId` (lines 256–268), before `const loaded = loadComposerDraft(…)`, add `revokeImagePreviews(draftRef.current.attachments);` with the comment `// The previous thread's previews die with its live draft; the persisted one never held them.`

(f) Add an unmount effect after that layout effect:

```ts
  React.useEffect(() => () => revokeImagePreviews(draftRef.current.attachments), []);
```

(g) Add the lazy resolver near `uploadOne`:

```ts
  /** A reloaded or delivered image chip has no local `File`; its preview comes from §6.3's read-back. */
  const resolvePreview = React.useCallback(
    async (attachment: StagedAttachment): Promise<string | null> => {
      if (!attachment.ref) return null;
      try {
        const bytes = await actions.fetchAttachmentBytes(attachment.ref.id);
        return URL.createObjectURL(new Blob([bytes], { type: attachment.mimeType }));
      } catch {
        return null;
      }
    },
    [actions]
  );
```

(h) Pass it: `<ComposerAttachments attachments={draft.attachments} onRemove={removeAttachment} onRetry={retryAttachment} disabled={reverting} resolvePreview={resolvePreview} />`.

`composerDraftToPersist` already narrows chips to their refs, so `previewUrl` is never persisted — verify by reading `persistableAttachmentRefs` (Task 4 touched nothing there).

- [ ] **Step 5: UI typecheck, tests, and a production build**

Run: `pnpm --filter @orquester/ui typecheck && pnpm --filter @orquester/ui test && pnpm build`
Expected: clean; the Vite build bundles the 40 SVGs through svgr with no warning about them. (`apps/web/dist` is gitignored.)

---

### Task 7: Documentation — the spec's Built notes and AGENTS.md

**Files:**
- Modify: `docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md` at §4.5 Claude (after line 975), §4.5 Codex (after 1124), §4.5 OpenCode (after the `Body: {…parts}` sentence, ~1275), §4.5 Grok (end of the Grok section's turn description), §6.3 (after the Built note ending at 2641), §7.3 (append to the Built note at 2921–2929), §7.4 (append to the Built block ending at 3089)
- Modify: `AGENTS.md` (the "Gotchas that bite" list in the agent chat section)

Match the house style: an italic paragraph opening `*Built:`, bold on the load-bearing correction, the implementing path in parentheses, closing `*`. Line numbers shift as you insert — insert bottom-up (§7.4 first) or re-grep each anchor.

- [ ] **Step 1: §7.4** — append a new paragraph to the §7.4 Built block (after the sentence ending `(\`packages/ui/src/components/agent-chat/composer/\`).*`):

```
*Built: **attachments name themselves in the text.** An image inserts `[Image #N]` at the caret when it is staged — the CLI's own placeholder for a pasted image — numbered by its position among the staged images; removing it drops the placeholder and renumbers the later ones (`packages/ui/src/components/agent-chat/composer/composer-images.ts`). A non-image file inserts its **absolute host path** when its upload completes (the path is not known before), exactly as the terminal-era upload typed it into the PTY; removing the chip removes the path, and a returned queued message re-stages its chips without re-inserting a path the text already names (`composer-files.ts`). The path rides the upload reply as `AttachmentRef.path` (§6.3) and the persisted draft keeps it so a reload can still strip it. The chips carry a **file-type icon** — a vendored subset of Material Icon Theme (`packages/ui/src/icons/files/`) — an image chip shows a thumbnail of the local file and a hover preview, resolved through `GET …/attachments/:id` when the draft was reloaded and the `File` is gone (`ComposerAttachments.tsx`).*
```

- [ ] **Step 2: §7.3** — inside the Built note that begins `*Built: three row kinds landed narrower than written. A user message's attachments render as named **chips**, not thumbnails`, after `…decodes a 10 MiB image into a bubble on a phone.` insert: `Both chip sets carry the file-type icon of §7.4 (\`icons/files\`).`

- [ ] **Step 3: §6.3** — after the Built note ending `agentChatRoutes.attachment\`).*` add:

```
*Built: the upload reply carries the attachment's **absolute host path** beside the reference — `AttachmentRef.path` — so the composer can name the file in the prompt (§7.4). It is a courtesy of that one reply: `parseAttachments` rebuilds every ref from `{type, id, name, mimeType, sizeBytes}`, so no command body reaches an adapter with it and no event carries it (`apps/daemon/src/agent-host/orchestration/validate.ts`, `agent-host/store/index.ts`).*
```

- [ ] **Step 4: §4.5 Claude** — after the `*T3: … ClaudeAdapter.ts:1660-1676*` citation (line 975) add:

```
*Built: **a non-image attachment reaches Claude as a path line, not as nothing.** T3 injects every attachment's on-disk path into the prompt text before the adapter sees the turn (`t3-1-providers.md:282-292`); that step was never ported, and the adapter's `continue` past a `file` ref dropped it silently behind a comment that assumed it. `appendAttachmentPathLines` (`agent-host/adapters/attachment-lines.ts`) appends `Attached files:\n- <name>: <path>` for the refs the adapter does not ingest natively, skipping a path the text already names (the composer inserts it, §7.4) — as a suffix of the final text block, or of the leading text block when a skill dispatch owns the last one, so the command block stays last and untouched. The path is readable without an approval because the attachments dir is an `additionalDirectories` entry (`claude/session.ts`).*
```

- [ ] **Step 5: §4.5 Codex** — after the `*T3: … CodexAdapter.ts:2518-2522 (localImage)*` citation add:

```
*Built: a `file` ref is **not dropped**: its path line is appended to the text item by the same `appendAttachmentPathLines` Claude uses (§4.5 Claude Built), and an attachment-only turn sends the block as its only text item (`codex/session.ts`). Whether Codex may read outside the workspace is its own sandbox/approval policy — a path in the prompt grants nothing.*
```

- [ ] **Step 6: §4.5 OpenCode** — after the `Body: {sessionID, messageID, …, parts}` sentence add:

```
*Built: **`parts` carries attachments two ways.** The four image mimes, any `text/*` and `application/pdf` at or under 20 MiB become `{type:"file", mime, filename, url: file://…}` parts the server reads off this host's disk; everything else (an `.xlsx`, an undeclared mime, an oversized file) rides as an `Attached files:` path line appended to the text part by `appendAttachmentPathLines`, so an attachment-only turn with such a file no longer throws "turns require text input". OpenCode's `external_directory` rule may still ask before reading it (`opencode/session.ts`).*
```

- [ ] **Step 7: §4.5 Grok** — where the Grok section describes `session/prompt` (grep `session/prompt` within lines 1370–1531), add:

```
*Built: every attachment reaches Grok as a path line — `promptCapabilities.image` is `false` on this CLI, so even an image is a path its `read_file` tool can act on — through the shared `appendAttachmentPathLines`, which skips a path the text already names (`grok/session.ts`).*
```

- [ ] **Step 8: AGENTS.md** — add this bullet to the "Gotchas that bite" list in the agent chat GUI section (after the `responseMode` bullet is fine):

```
- **A non-image attachment reaches the agent as a PATH, guarded twice.** The upload reply
  carries `AttachmentRef.path` — the absolute host path; `validate.ts` rebuilds every ref from
  `{type, id, name, mimeType, sizeBytes}`, so no command body or event carries it — and the
  composer inserts it into the prompt when the upload completes, exactly as the terminal-era
  upload typed it into the PTY (`composer-files.ts`). Independently, every adapter appends
  `Attached files:\n- <name>: <path>` for the refs it does not ingest natively
  (`agent-host/adapters/attachment-lines.ts`), skipping paths the text already names — Claude
  ingests images only, Codex images by path, OpenCode image/`text/*`/pdf as `file` parts, Grok
  nothing. Before this, Claude and Codex dropped every non-image file silently behind a comment
  that assumed a host path line never ported from T3. Claude reads the path without an approval
  (the thread's attachments dir is an `additionalDirectories` entry); Codex and OpenCode may raise
  their own approval card for a read outside the project. Chips draw a vendored Material Icon
  Theme subset (`packages/ui/src/icons/files/`, MIT, pinned in its README — never the
  Office-branded vscode-icons set, whose decorative use the trademark guidelines forbid).
```

- [ ] **Step 9: Sanity**

Run: `grep -n "attachment-lines\|composer-files\|AttachmentRef.path" docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md AGENTS.md | wc -l`
Expected: ≥ 8 hits. No code changed in this task.

---

### Task 8: Whole-tree verification and review

- [ ] **Step 1: Full typecheck**

Run: `pnpm check`
Expected: every package `Done`, exit 0.

- [ ] **Step 2: Full tests**

Run: `pnpm test`
Expected: daemon ≥ 2348 + new (≈ 2360) pass, 0 fail; ui ≥ 847 + new (≈ 862) pass, 0 fail; every `.check.ts` exits 0.

- [ ] **Step 3: Production bundle**

Run: `pnpm build`
Expected: `vite build` for `apps/web` succeeds; `grep -c "data-file-icon" apps/web/dist/assets/*.js` ≥ 1.

- [ ] **Step 4: Static checks specific to this change**

```bash
grep -rn "flattened into the prompt text by the host\|path line the host puts in the prompt" apps/daemon/src   # expect nothing: the stale comments are gone
grep -rn "uploadFilesToChatDraft\|attachmentRefFor\b\|imageAttachment(" packages apps --include=*.ts --include=*.tsx   # expect nothing
grep -rn "import(" apps/daemon/src/agent-host --include=*.ts | grep -v "\.test\.ts" | grep -v "^.*//"   # no new dynamic imports (compare with `git stash`-free baseline: the count must not grow)
git status --short   # only the files this plan names, plus the 40 SVGs, LICENSE, README, the plan itself
```

- [ ] **Step 5: Review** — a fresh reviewer reads `git diff` against the design in this plan and the Review Focus list, then the owner is told what changed and what to verify by hand (a real drop of an `.xlsx` into a Claude chat, a hover over an image chip, light mode).
