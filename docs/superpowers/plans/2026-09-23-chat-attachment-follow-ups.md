# Chat attachment follow-ups — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the five non-blocking follow-ups the attachment-paths change left behind: one attachment list on a message-mode answer, no `Attached files:` block in a replayed native history, no focus theft from bridge inserts, an own-key lookup in `detectFileKind`, and one shared RegExp escaper.

**Architecture:** Five independent, file-disjoint tasks on top of the staged (uncommitted) tree of `docs/superpowers/plans/2026-09-22-chat-attachment-paths-and-chips.md`. No new subsystem; each task mirrors a pattern that already exists in its file.

**Tech Stack:** TypeScript 5.8 ESM, React 18, `node --test` via tsx (ui: `cd packages/ui && node --import tsx --import ./test/svg-loader.mjs --test <file>`; daemon: `cd apps/daemon && node --import tsx --test <file>`).

**Spec:** `docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md` §4.3 (question attachments, lines 858–863), §6.2 (the `/answer` Built note, lines ~2491–2493), §4.5 (the per-adapter `*Built:*` notes on `Attached files:`), §7.4 (the composer Built block). The previous plan's design section is the design these follow-ups complete.

## Global Constraints

- `appendAttachmentPathLines(text, attachments, namedIn = text)` in `apps/daemon/src/agent-host/adapters/attachment-lines.ts` is the ONE spelling of the `Attached files:` block; its output shape (`Attached files:\n- <name>: <path>` lines, joined to the text by `\n\n`) is what Task 2's inverse must recognise.
- §4.6.9: the host never prefixes, indents or wraps the user's text.
- No lazy dynamic `import()` under `apps/daemon/src/agent-host/`.
- Theming is data; no component branches on scheme or mode.
- Tests are `node --test` files under `src/`, next to the code, no sleeps.
- Never launch the daemon from this checkout.
- **Do not commit and do not create a branch** (AGENTS.md). Stage every file you create or change with `git add <path>` when done, never `git add -A`; the owner commits.
- Subagents: never `model: "sonnet"` or `"haiku"` (host CLAUDE.md).

## Review Focus

1. A message-mode answer whose attachment cannot be resolved: the persisted text still names the file (falls back to the id) and nothing throws in the decision (Task 1 test).
2. A user who genuinely typed a line starting `Attached files:` in the middle of a message: the replay strip must remove only a TRAILING block in the helper's exact shape (Task 2 test).
3. A bridge insert while the textarea is focused: the caret still lands after the inserted text and focus is kept (Task 3, traced by review).
4. `detectFileKind("x.constructor")` and `("x.__proto__")` resolve to the text fallback, never to a prototype member (Task 4 test).
5. Every metacharacter the three old escapers handled is still escaped by the shared one, and `new RegExp(escapeRegExp(s)).test(s)` holds for a string containing all of them (Task 5 test).

---

### Task 1: One attachment list on a message-mode answer (orchestrator)

**Files:**
- Modify: `apps/daemon/src/agent-host/orchestration/orchestrator.ts:1501-1535` (`answerMessageText`) and the `case "answer"` message-mode branch (~1931-1935)
- Modify: `apps/daemon/src/agent-host/orchestration/orchestrator.test.ts` (new test beside "folds attachments into the answer text before the adapter sees it")
- Modify: `docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md` (§6.2 Built sentence ~2491–2493; and one clause in the §7.4 Built paragraph for Task 3 — see Step 6)

**Interfaces:**
- Consumes: `store.resolveAttachment(threadId, id)` (already used by `answerEffect`), `appendAttachmentPathLines` from `../adapters/attachment-lines.ts` (test only).
- Produces: `answerMessageText(questions, answers, attachmentsByQuestionId, pathById)` where `pathById: Record<string, string>` maps an attachment id to the text to print in parentheses (its absolute path, or the id when unresolvable).

Why: the persisted text of a message-mode answer writes `Attached file: <name> (<id>)`, and every adapter then appends its own `Attached files:` block because the id lines do not contain the path. Writing the path makes the adapters' dedupe (`namedIn.includes(path)`) skip them, so the agent sees one list and the user bubble names the file the way a turn does.

- [ ] **Step 1: Write the failing test**

In `orchestrator.test.ts`, after "folds attachments into the answer text before the adapter sees it", add (reuse that test's helpers: `createTestHost`, `openQuestion`, `cmd`, `host.settle`; `openQuestion(host, id, { dismissible: true })` opens a message-mode question — see the helper at ~line 77):

```ts
  it("a message-mode answer names each attachment by PATH, so the adapters' Attached files block has nothing to add", async () => {
    const host = createTestHost();
    const threadId = await host.createThread();
    await host.orchestrator.command(threadId, "turn", { commandId: cmd(), input: "go" });
    await openQuestion(host, "q-2", { dismissible: true });
    await host.settle();
    const ref = await host.store.putAttachment({
      threadId,
      name: "q3.xlsx",
      sourcePath: "/tmp/q3.xlsx"
    });

    await host.orchestrator.command(threadId, "answer", {
      commandId: cmd(),
      requestId: "q-2",
      answers: { "Which branch?": "this one" },
      attachmentsByQuestionId: { "Which branch?": [ref] }
    });
    await host.settle();

    const sent = (host.store.logs.get(threadId) ?? []).find(
      (event) => event.type === "thread.message-sent" && event.payload.messageId === "async-answer:q-2"
    ) as Extract<DomainEvent, { type: "thread.message-sent" }> | undefined;
    assert.ok(sent);
    const path = await host.store.resolveAttachment(threadId, ref.id);
    assert.equal(sent.payload.text, `Which branch?\nthis one\nAttached file: q3.xlsx (${path})`);
    // The line already names the path, so the shared block appends nothing.
    assert.equal(
      appendAttachmentPathLines(sent.payload.text, [{ name: "q3.xlsx", path }]),
      sent.payload.text
    );
    await host.stop();
  });
```

Add the import `import { appendAttachmentPathLines } from "../adapters/attachment-lines.ts";` (match the file's import suffix style). If `openQuestion`'s question ids differ from the answers' keys in the existing test, follow the existing test's convention exactly (the key of `answers` is the question id there).

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/daemon && node --import tsx --test src/agent-host/orchestration/orchestrator.test.ts`
Expected: FAIL — the text ends in `(…-xlsx)` (the id), not the path.

- [ ] **Step 3: Resolve paths in the answer decision and print them**

In `orchestrator.ts`, change `answerMessageText`'s signature and the attachment line:

```ts
  const answerMessageText = (
    questions: readonly { id: string; question: string }[],
    answers: Record<string, unknown>,
    attachmentsByQuestionId?: Record<string, AttachmentRef[]>,
    pathById: Record<string, string> = {}
  ): string => {
    …
      for (const attachment of attachments) {
        // The absolute host path, so the adapters' `Attached files:` block
        // (§4.5) finds it already named and appends nothing; the id only when
        // the file cannot be resolved (the send then fails as any missing
        // attachment does).
        lines.push(`Attached file: ${attachment.name} (${pathById[attachment.id] ?? attachment.id})`);
      }
```

Update the doc comment's sentence "each question's attachments follow as `Attached file: <name> (<id>)` lines" to say `(<path>)`, keeping the T3 citation. In the `case "answer"` message-mode branch, before `const text = answerMessageText(...)`, resolve the paths (the decision is already `async` — `verifyAttachments` is awaited on the turn path; if the answer branch is inside a non-async function, hoist the resolution to the nearest `async` scope that runs before it, exactly as `answerEffect` does):

```ts
          const pathById: Record<string, string> = {};
          for (const attachment of Object.values(attachmentsByQuestionId ?? {}).flat()) {
            try {
              pathById[attachment.id] = await store.resolveAttachment(runtime.id, attachment.id);
            } catch {
              // Unresolvable now: the text keeps the id and the send fails
              // like any missing attachment would (§6.3).
            }
          }
          const text = answerMessageText(question.questions, answers, attachmentsByQuestionId, pathById);
```

- [ ] **Step 4: Run the test file**

Run: `cd apps/daemon && node --import tsx --test src/agent-host/orchestration/orchestrator.test.ts`
Expected: PASS, including the existing `respondToUserInput` fold test (unchanged path).

- [ ] **Step 5: Spec §6.2**

In the spec's §6.2 Built note (grep ``a question's attachments follow as `Attached file: <name> (<id>)` lines``), change `(<id>)` to `(<path>)` and append the clause: `— the absolute host path, so the adapters' \`Attached files:\` block (§4.5) finds each file already named and appends nothing; the id stands in only when the file cannot be resolved`. Keep the line width of the neighbours.

- [ ] **Step 6: Spec §7.4 (on behalf of Task 3, which must not edit the spec concurrently)**

In the §7.4 Built paragraph that begins `*Built: **attachments name themselves in the text.**`, append before its closing `*`: ` An insert that lands outside a user event — a finished upload, a returned queued message, a delivered ref — places the caret without moving focus, unless the textarea already had it.`

- [ ] **Step 7: Typecheck + stage**

Run: `pnpm --filter @orquester/daemon typecheck`. Stage: `git add apps/daemon/src/agent-host/orchestration/orchestrator.ts apps/daemon/src/agent-host/orchestration/orchestrator.test.ts docs/superpowers/specs/2026-09-21-agent-chat-gui-design.md`.

---

### Task 2: No `Attached files:` block in a replayed native history

**Files:**
- Modify: `apps/daemon/src/agent-host/adapters/attachment-lines.ts` (add `stripAttachmentPathLines`) and `attachment-lines.test.ts`
- Modify: `apps/daemon/src/agent-host/adapters/claude/project-history.ts` (~line 292, the `type === "text"` block for `message.role === "user"`) and `project-history.test.ts`
- Modify: `apps/daemon/src/agent-host/adapters/codex/history.ts` (`userMessageText`, ~189-198) and `history.test.ts`
- Modify: `apps/daemon/src/agent-host/adapters/grok/history.ts` (the `user_message` projection, ~141-145, and/or where `this.userText` is assembled ~256) and `history.test.ts`
- Modify: `apps/daemon/src/agent-host/adapters/opencode/history.ts` (the `role === "user"` → `user_message` projection ~201-217) and `history.test.ts` — only if that projection carries user TEXT; if it does not, leave OpenCode untouched and say so in the report

**Interfaces:**
- Produces: `export function stripAttachmentPathLines(text: string): string` — removes one TRAILING block in exactly the shape `appendAttachmentPathLines` writes (`Attached files:` line followed by one or more `- <name>: <path>` lines, at the end of the text, preceded by `\n\n` or standing alone) and returns the text before it; anything else is returned by identity.

Why: the block is provider input, never persisted by the host; but a provider's own native history (what a resumed thread replays through `HISTORICAL_RAW_SOURCE`) stores the text the adapter sent, so a replayed user bubble shows the block. Stripping it at projection time restores the user's own text.

- [ ] **Step 1: Write the failing helper tests**

In `attachment-lines.test.ts` add a `describe("stripping the block from a replayed native history", …)`:

```ts
  it("removes one trailing block in the helper's own shape and nothing else", () => {
    const text = "look at these";
    const sent = appendAttachmentPathLines(text, [
      { name: "q3.xlsx", path: "/a/q3.xlsx" },
      { name: "b c.txt", path: "/a/b c.txt" }
    ]);
    assert.equal(stripAttachmentPathLines(sent), text);
    assert.equal(stripAttachmentPathLines("Attached files:\n- q3.xlsx: /a/q3.xlsx"), "");
  });

  it("returns text without a trailing block by identity, including a mid-text mention", () => {
    const plain = "see /a/q3.xlsx please";
    assert.equal(stripAttachmentPathLines(plain), plain);
    const mid = "Attached files:\n- a: /x\n\nand then I wrote more";
    assert.equal(stripAttachmentPathLines(mid), mid);
    assert.equal(stripAttachmentPathLines(""), "");
  });
```

Run: `cd apps/daemon && node --import tsx --test src/agent-host/adapters/attachment-lines.test.ts` → FAIL (not exported).

- [ ] **Step 2: Write the helper**

Append to `attachment-lines.ts`:

```ts
/**
 * The inverse, for a provider's NATIVE history: the block is provider input
 * and is never persisted by the host, but the CLI's own transcript keeps the
 * text the adapter sent, so a thread resumed from it would replay the block
 * inside the user's bubble. Removes exactly one trailing block in the shape
 * `appendAttachmentPathLines` writes; anything else — including a block the
 * user typed mid-message — is returned by identity.
 */
export function stripAttachmentPathLines(text: string): string {
  const match = /(?:^|\n\n)Attached files:(?:\n- [^\n]*: [^\n]+)+$/.exec(text);
  if (match === null) {
    return text;
  }
  return text.slice(0, match.index);
}
```

Run the helper tests → PASS.

- [ ] **Step 3: Apply it in each native-history projection (TDD per adapter)**

For each adapter, first add a test in its history test file that feeds a user message whose text is `"hello\n\nAttached files:\n- q3.xlsx: /a/q3.xlsx"` through the existing projection helper used by that file's tests, and asserts the projected `user_message` `detail` (and `data.text` where the projection sets it) is `"hello"`; run it (FAIL); then apply `stripAttachmentPathLines` to the user text at the projection point:
  - Claude `project-history.ts`: in the `type === "text"` block, when `message.role === "user"`, use `const shown = stripAttachmentPathLines(text)` for `detail: elide(shown)` and `data: { text: shown }` (assistant text untouched); skip the block if `shown.trim().length === 0` exactly as an empty text is skipped today.
  - Codex `history.ts`: `userMessageText` returns `stripAttachmentPathLines(text)` (after the existing trim), null when empty.
  - Grok `history.ts`: apply to the `user_message` item text where it is emitted (`detail: stripAttachmentPathLines(item.text)`), or where `this.userText` is pushed — one place, chosen so the test above passes.
  - OpenCode `history.ts`: only if the user projection carries text.
  Import the helper from `../attachment-lines.ts` (match each file's import suffix style). Run each adapter's history test file → PASS.

- [ ] **Step 4: Typecheck + stage**

Run: `pnpm --filter @orquester/daemon typecheck`. Stage every file you changed with `git add <path>`.

---

### Task 3: Bridge inserts never steal focus

**Files:**
- Modify: `packages/ui/src/components/agent-chat/composer/ChatComposer.tsx` (`stageAttachment` ~lines 560-567, `uploadOne` ~799, the `registerComposerHandle` effect)

**Interfaces:**
- Consumes: `insertText(text, mode, options?: { focus?: boolean })` and `applyCaret(at, options?)` (already present).

Why: `uploadOne` already keeps focus only where it was; the composer bridge (`registerComposerHandle` → `insertText`/`stageAttachment`) is reached outside a user event too — a returned queued message after an interrupt (`store.ts` `appendToDraft`) and a delivered ref from the Design Mode picker — and those still call `focus()` by default (the same keyboard-pop exposure on a phone).

- [ ] **Step 1: One helper for "is the textarea focused"**

Near `applyCaret`, add:

```ts
  /** Whether the composer already owns focus — an insert that lands outside a user event may place the caret but must not take focus (§7.4). */
  const isTextareaFocused = React.useCallback(
    () => typeof document !== "undefined" && document.activeElement === textareaRef.current,
    []
  );
```

Replace the inline `const focus = document.activeElement === textareaRef.current;` in `uploadOne` with `const focus = isTextareaFocused();` (add `isTextareaFocused` to its deps).

- [ ] **Step 2: Bridge-staged refs and bridge inserts**

In `stageAttachment` (bridge-only: `stageFiles` never calls it), pass the option on both inserts: `insertText(imagePlaceholder(ordinal), "cursor", { focus: isTextareaFocused() })` and `insertText(path, "cursor", { focus: isTextareaFocused() })`; add `isTextareaFocused` to its deps. In the `registerComposerHandle` effect, register a wrapped inserter instead of `insertText` directly:

```ts
  React.useEffect(
    () =>
      registerComposerHandle(sessionId, {
        // The bridge is reached outside a user event (a returned queued
        // message, a delivered ref): place the caret, keep focus where it is.
        insertText: (text, mode) => insertText(text, mode, { focus: isTextareaFocused() }),
        stageAttachment,
        focusAtEnd,
        openControl
      }),
    [focusAtEnd, insertText, isTextareaFocused, openControl, sessionId, stageAttachment]
  );
```

Check the handle's type in `composer-bridge.ts` (`insertText: (text: string, mode?: "cursor" | "append") => void`) and keep the wrapper assignable to it. `stageFiles` (paste/drop/picker — a user event) keeps focusing; `focusAtEnd` is an explicit focus request and stays.

- [ ] **Step 3: Verify**

Run: `pnpm --filter @orquester/ui typecheck && pnpm --filter @orquester/ui test` (the `.check.ts` smokes render the composer). Trace by reading: a bridge insert with the textarea focused → caret after the text, focus kept; unfocused → caret placed, no focus. Stage: `git add packages/ui/src/components/agent-chat/composer/ChatComposer.tsx`. (The §7.4 spec sentence is written by Task 1 to avoid two agents in one file.)

---

### Task 4: `detectFileKind` uses an own-key lookup

**Files:**
- Modify: `packages/ui/src/lib/file-kind.ts:82-85`
- Create: `packages/ui/src/lib/file-kind.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { detectFileKind, extOf } from "./file-kind.ts";

describe("detectFileKind", () => {
  it("never resolves a prototype member: an extension like `constructor` is the text fallback", () => {
    assert.deepEqual(detectFileKind("notes.constructor"), { kind: "text", mime: "text/plain" });
    assert.deepEqual(detectFileKind("x.__proto__"), { kind: "text", mime: "text/plain" });
    assert.deepEqual(detectFileKind("x.toString"), { kind: "text", mime: "text/plain" });
  });

  it("classifies by lowercased extension and collapses .tar.* names", () => {
    assert.deepEqual(detectFileKind("shot.PNG"), { kind: "image", mime: "image/png" });
    assert.deepEqual(detectFileKind("bundle.tar.gz"), { kind: "archive", mime: "application/gzip" });
    assert.deepEqual(detectFileKind("README"), { kind: "text", mime: "text/plain" });
    assert.equal(extOf("a.tar.bz2"), "tar");
  });
});
```

Run: `cd packages/ui && node --import tsx --import ./test/svg-loader.mjs --test src/lib/file-kind.test.ts` → FAIL (`kind: undefined` for `constructor`).

- [ ] **Step 2: Own-key lookup**

```ts
export function detectFileKind(filename: string): FileKindInfo {
  const key = extOf(filename);
  // Own keys only: `notes.constructor` must not read `Object.prototype`
  // (the same hole `file-icon.ts` closes for the icon tables).
  const hit = Object.prototype.hasOwnProperty.call(BY_EXT, key) ? BY_EXT[key] : undefined;
  return hit ? { kind: hit[0], mime: hit[1] } : { kind: "text", mime: "text/plain" };
}
```

Run the test → PASS. `pnpm --filter @orquester/ui typecheck`. Stage both files.

---

### Task 5: One shared RegExp escaper

**Files:**
- Create: `packages/ui/src/lib/regexp.ts`, `packages/ui/src/lib/regexp.test.ts`
- Modify: `packages/ui/src/components/agent-chat/composer/composer-files.ts:14` (delete the private `escapeForRegExp`, import), `packages/ui/src/components/agent-chat/timeline/row-chrome.ts:215-218` (delete the private `escapeForRegExp`, import), `packages/ui/src/lib/html-preview.ts:13-15` (delete the private `escapeRegExp`, import)

- [ ] **Step 1: Write the failing test**

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { escapeRegExp } from "./regexp.ts";

describe("escapeRegExp", () => {
  it("escapes every metacharacter so the escaped form matches the literal", () => {
    const literal = "a.b*c+d?e^f$g{h}i(j)k|l[m]n\\o-p/q";
    assert.equal(new RegExp(`^${escapeRegExp(literal)}$`).test(literal), true);
    assert.equal(new RegExp(escapeRegExp("a.b")).test("axb"), false);
  });

  it("leaves a plain word untouched", () => {
    assert.equal(escapeRegExp("review-skill"), "review-skill");
  });
});
```

Run: `cd packages/ui && node --import tsx --import ./test/svg-loader.mjs --test src/lib/regexp.test.ts` → FAIL (module not found).

- [ ] **Step 2: Write the module and replace the three copies**

`packages/ui/src/lib/regexp.ts`:

```ts
/**
 * Escape a string for literal use inside `new RegExp(...)`. One spelling for
 * the whole package: the composer's path removal, the timeline's skill-mention
 * splitter and the HTML preview's self-link rewrite each carried their own.
 */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
```

In each of the three files, delete the private function and import `escapeRegExp` from the lib (`../../../lib/regexp` from the composer and timeline folders, `./regexp` from `lib/html-preview.ts`), renaming call sites of `escapeForRegExp` to `escapeRegExp`. Keep every doc comment that explains WHY the escaping is needed at the call site (e.g. row-chrome's "`.` and `-` are legal in a skill name").

- [ ] **Step 3: Verify**

Run the new test, `composer-files.test.ts` and `row-chrome.test.ts` (both must still pass), then `pnpm --filter @orquester/ui typecheck`. Stage the five files.

---

### Task 6: Whole-tree verification

- [ ] `pnpm check` clean; `pnpm test` all packages 0 failures (baselines before this plan: api 134, ui 864, daemon 2367); `pnpm build` clean; `git status --short` shows only staged changes.
