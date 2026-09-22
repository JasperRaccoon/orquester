import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AttachmentRef } from "@orquester/api/agent-chat";

import {
  composerDraftToPersist,
  createDraftPersistScheduler,
  loadComposerDraft,
  persistableAttachmentRefs,
  persistedDraftsEqual
} from "./composer-draft";
import type { StagedAttachment } from "./ComposerAttachments";
import type { ComposerDraft } from "../../../lib/agent-chat/composer.logic";

const ref = (id: string): AttachmentRef => ({
  type: "file",
  id,
  name: `${id}.txt`,
  sizeBytes: 12
});

const imageRef = (id: string): AttachmentRef => ({
  type: "image",
  id,
  name: `${id}.png`,
  mimeType: "image/png",
  sizeBytes: 12
});

const staged = (id: string, overrides: Partial<StagedAttachment> = {}): StagedAttachment => ({
  key: `ref:${id}`,
  name: `${id}.txt`,
  sizeBytes: 12,
  mimeType: "text/plain",
  status: "ready",
  progress: 1,
  ref: ref(id),
  ...overrides
});

describe("what of a live composer belongs in the persisted draft", () => {
  it("keeps only the attachments whose bytes are already on the daemon", () => {
    const refs = persistableAttachmentRefs([
      staged("done"),
      // An upload in flight holds a `File` the persisted draft cannot carry.
      { ...staged("inflight"), status: "uploading", progress: 0.4, ref: undefined },
      { ...staged("broken"), status: "failed", ref: undefined },
      // Defensive: a "ready" entry without a ref is not addressable either.
      { ...staged("refless"), ref: undefined }
    ]);
    assert.deepEqual(
      refs.map((entry) => entry.id),
      ["done"]
    );
  });

  it("builds the persisted shape from text, uploaded refs and the carried context", () => {
    const draft = composerDraftToPersist({
      text: "half a thought",
      attachments: [staged("a1"), { ...staged("a2"), status: "uploading", ref: undefined }],
      context: [{ kind: "file", label: "src/index.ts" }]
    });
    assert.deepEqual(draft, {
      text: "half a thought",
      attachments: [ref("a1")],
      context: [{ kind: "file", label: "src/index.ts" }]
    });
  });

  it("compares two persisted drafts by value, so an unchanged draft is never written", () => {
    const a: ComposerDraft = { text: "x", attachments: [ref("a1")], context: [] };
    assert.equal(persistedDraftsEqual(a, { text: "x", attachments: [ref("a1")], context: [] }), true);
    assert.equal(persistedDraftsEqual(a, { text: "y", attachments: [ref("a1")], context: [] }), false);
    assert.equal(persistedDraftsEqual(a, { text: "x", attachments: [], context: [] }), false);
    assert.equal(persistedDraftsEqual(a, { text: "x", attachments: [ref("a2")], context: [] }), false);
    assert.equal(
      persistedDraftsEqual(a, { text: "x", attachments: [ref("a1")], context: [{ kind: "file", label: "f" }] }),
      false
    );
  });
});

describe("loading a persisted draft back into the composer", () => {
  it("re-stages every uploaded attachment as a ready chip and keeps the text verbatim", () => {
    const loaded = loadComposerDraft({
      text: "look at [Image #1]",
      attachments: [imageRef("i1")],
      context: [{ kind: "file", label: "src/a.ts" }]
    });
    // Verbatim: the placeholder is already in the text, so staging must not
    // insert a second one — that is why the load does not go through
    // `stageAttachment`.
    assert.equal(loaded.text, "look at [Image #1]");
    assert.deepEqual(loaded.context, [{ kind: "file", label: "src/a.ts" }]);
    assert.equal(loaded.attachments.length, 1);
    const chip = loaded.attachments[0]!;
    assert.equal(chip.key, "ref:i1");
    assert.equal(chip.status, "ready");
    assert.equal(chip.progress, 1);
    assert.equal(chip.mimeType, "image/png");
    assert.equal(chip.ref?.id, "i1");
  });

  it("applies the same budget and de-duplication a live staging does", () => {
    const many = Array.from({ length: 10 }, (_, index) => ref(`a${index}`));
    const loaded = loadComposerDraft({
      text: "",
      attachments: [...many, ref("a0")],
      context: []
    });
    assert.equal(loaded.attachments.length, 8, "eight per message, the same bound as a live drop");
    assert.deepEqual(
      loaded.attachments.map((entry) => entry.ref?.id),
      ["a0", "a1", "a2", "a3", "a4", "a5", "a6", "a7"]
    );
  });
});

describe("when the persisted draft is written", () => {
  function scheduler(): {
    writes: ComposerDraft[];
    api: ReturnType<typeof createDraftPersistScheduler>;
    run: () => void;
    timers: number;
  } {
    const writes: ComposerDraft[] = [];
    let pending: (() => void) | null = null;
    let timers = 0;
    const api = createDraftPersistScheduler((draft) => writes.push(draft), {
      delayMs: 300,
      setTimer: (fn) => {
        timers += 1;
        pending = fn;
        return timers;
      },
      clearTimer: () => {
        pending = null;
      }
    });
    return {
      writes,
      api,
      run: () => {
        const fn = pending;
        pending = null;
        fn?.();
      },
      get timers() {
        return timers;
      }
    };
  }

  const draft = (text: string): ComposerDraft => ({ text, attachments: [], context: [] });

  it("does not write on the keystroke, and writes the newest draft once when the window closes", () => {
    const s = scheduler();
    s.api.schedule(draft("h"));
    s.api.schedule(draft("he"));
    s.api.schedule(draft("hey"));
    assert.deepEqual(s.writes, [], "typing does not hit storage on every key");
    assert.equal(s.timers, 1, "a throttle, not a resetting debounce: the window never slides away");
    s.run();
    assert.deepEqual(s.writes, [draft("hey")]);
  });

  it("flushes synchronously, so an unmount or a reload keeps the tail", () => {
    const s = scheduler();
    s.api.schedule(draft("typed"));
    s.api.flush();
    assert.deepEqual(s.writes, [draft("typed")]);
    // The pending write is consumed, not duplicated when the timer fires late.
    s.run();
    s.api.flush();
    assert.deepEqual(s.writes, [draft("typed")]);
  });

  it("writes a clear immediately and drops anything the debounce still held", () => {
    const s = scheduler();
    s.api.schedule(draft("about to be sent"));
    s.api.write(draft(""));
    assert.deepEqual(s.writes, [draft("")], "a sent message must not be resurrected by a late write");
    s.run();
    assert.deepEqual(s.writes, [draft("")]);
  });

  it("cancels without writing", () => {
    const s = scheduler();
    s.api.schedule(draft("never mind"));
    s.api.cancel();
    s.run();
    s.api.flush();
    assert.deepEqual(s.writes, []);
  });
});
