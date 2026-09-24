import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AttachmentRef } from "@orquester/api/agent-chat";

import {
  composerDraftToPersist,
  createDraftPersistScheduler,
  draftAfterReturn,
  loadComposerDraft,
  persistableAttachmentRefs,
  persistedDraftAfterReturn,
  persistedDraftAfterSend,
  persistedDraftsEqual
} from "./composer-draft";
import type { StagedAttachment } from "./ComposerAttachments";
import { attachmentCountBlockSend } from "./composer-submission";
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

  it("keeps every file a restore wrote, over the eight, de-duplicated — the send gate holds the rest", () => {
    // A failed send's files and the ones staged while it was in flight, or two
    // queued messages a Stop returned: each was a message of its own, and a
    // load that kept the first eight dropped the others without a word.
    const many = Array.from({ length: 10 }, (_, index) => ref(`a${index}`));
    const loaded = loadComposerDraft({
      text: "",
      attachments: [...many, ref("a0")],
      context: []
    });
    assert.deepEqual(
      loaded.attachments.map((entry) => entry.ref?.id),
      ["a0", "a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8", "a9"]
    );
    assert.equal(
      attachmentCountBlockSend(loaded.attachments),
      "A message can carry 8 attachments — remove 2 before sending."
    );
  });

  it("a failed send over a full persisted draft comes back whole on the next mount", () => {
    const persisted: ComposerDraft = {
      text: "typed since",
      attachments: ["m1", "m2", "m3", "m4", "m5", "m6", "m7", "m8"].map(ref),
      context: []
    };
    const sent = ["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8"].map((id) => staged(id, { key: `picked:${id}` }));
    const next = persistedDraftAfterSend({
      outcome: { kind: "failed", text: "the message", notice: "Could not send the message." },
      sent,
      persisted
    });
    assert.equal(next?.attachments.length, 16);
    const loaded = loadComposerDraft(next!);
    assert.equal(loaded.attachments.length, 16, "nothing is dropped on the way back in");
    assert.equal(
      attachmentCountBlockSend(loaded.attachments),
      "A message can carry 8 attachments — remove 8 before sending."
    );
  });
});

describe("a message coming back behind the draft (§7.4)", () => {
  const withPath = (id: string, sizeBytes = 12): AttachmentRef => ({
    type: "file",
    id,
    name: `${id}.txt`,
    mimeType: "text/plain",
    sizeBytes,
    path: `/w/p/.att/${id}.txt`
  });

  it("into a full tray: every returned file is staged, and the draft is held at the send gate", () => {
    // The composer refuses a NEW pick at eight; a file coming back it never
    // refuses for the count — it was part of a message once.
    const tray = ["t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8"].map((id) => staged(id));
    const back = ["q1", "q2", "q3", "q4", "q5", "q6", "q7", "q8"].map((id) => withPath(id));
    const next = draftAfterReturn({
      draft: { text: "mine", attachments: tray },
      message: { text: "queued", attachments: back }
    });
    assert.deepEqual(
      next.attachments.map((chip) => chip.ref?.id),
      ["t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8", "q1", "q2", "q3", "q4", "q5", "q6", "q7", "q8"]
    );
    assert.equal(next.attachments.every((chip) => chip.status === "ready"), true);
    assert.equal(next.text, "mine\n\nqueued");
    assert.deepEqual(next.unstaged, []);
    assert.equal(
      attachmentCountBlockSend(next.attachments),
      "A message can carry 8 attachments — remove 8 before sending."
    );
  });

  it("keeps naming its own images: a returned [Image #1] never names the draft's image", () => {
    const own = staged("own", { mimeType: "image/png", ref: imageRef("own") });
    const next = draftAfterReturn({
      draft: { text: "[Image #1] is mine", attachments: [own] },
      message: { text: "queued: look at [Image #1]", attachments: [imageRef("q1")] }
    });
    assert.equal(next.text, "[Image #1] is mine\n\nqueued: look at [Image #2]");
    assert.deepEqual(next.attachments.map((chip) => chip.ref?.id), ["own", "q1"]);
  });

  it("a file a bound still refuses leaves the message as its chip's X would take it, and is handed back for its path", () => {
    const vector: AttachmentRef = {
      type: "image",
      id: "vector",
      name: "diagram.svg",
      mimeType: "image/svg+xml",
      sizeBytes: 12,
      path: "/w/p/.att/diagram.svg"
    };
    const huge = withPath("huge", 60 * 1024 * 1024);
    const unnamed = withPath("unnamed", 60 * 1024 * 1024);
    const next = draftAfterReturn({
      draft: { text: "", attachments: [] },
      message: {
        text: "the diagram [Image #1] and the shot [Image #2], see /w/p/.att/huge.txt",
        attachments: [vector, imageRef("shot"), huge, unnamed]
      }
    });
    assert.equal(next.text, "the diagram and the shot [Image #1], see /w/p/.att/huge.txt");
    assert.deepEqual(next.attachments.map((chip) => chip.ref?.id), ["shot"]);
    assert.deepEqual(
      next.unstaged.map((entry) => entry.id),
      ["vector", "unnamed"],
      "a refused file whose path the text already names is written there already"
    );
  });
});

describe("a message coming back to a draft no composer shows (§7.4)", () => {
  it("merges behind the persisted draft, keeping every file and its context", () => {
    const persisted: ComposerDraft = {
      text: "[Image #1] typed since",
      attachments: [imageRef("mine"), ...["m2", "m3", "m4", "m5", "m6", "m7", "m8"].map(ref)],
      context: [{ kind: "file", label: "src/a.ts" }]
    };
    const message: ComposerDraft = {
      text: "the queued one, see [Image #1]",
      attachments: [imageRef("q1"), ...["q2", "q3", "q4", "q5", "q6", "q7", "q8"].map(ref)],
      context: [{ kind: "file", label: "src/b.ts" }]
    };
    const next = persistedDraftAfterReturn({ persisted, message });
    assert.equal(next.text, "[Image #1] typed since\n\nthe queued one, see [Image #2]");
    assert.equal(next.attachments.length, 16);
    assert.deepEqual(next.context, [
      { kind: "file", label: "src/a.ts" },
      { kind: "file", label: "src/b.ts" }
    ]);
    assert.equal(loadComposerDraft(next).attachments.length, 16, "and the next mount loads all of them");
  });

  it("writes a returned file a bound refuses into the text as its path, so no later mount drops a file", () => {
    // The same bounds and the same fallback as a mounted composer: a type or a
    // size it never stages. Kept as a ref, the next mount's load dropped it.
    const vector: AttachmentRef = {
      type: "image",
      id: "vector",
      name: "diagram.svg",
      mimeType: "image/svg+xml",
      sizeBytes: 12,
      path: "/w/p/.att/diagram.svg"
    };
    const next = persistedDraftAfterReturn({
      persisted: { text: "typed since", attachments: [ref("mine")], context: [] },
      message: { text: "the diagram [Image #1] and the notes", attachments: [vector, ref("notes")], context: [] }
    });
    assert.deepEqual(next.attachments.map((entry) => entry.id), ["mine", "notes"]);
    assert.equal(next.text, "typed since\n\nthe diagram and the notes /w/p/.att/diagram.svg");
    assert.equal(
      loadComposerDraft(next).attachments.length,
      next.attachments.length,
      "the next mount stages every ref the draft holds"
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
