/**
 * A send that did not go out comes back to the thread it was sent FROM
 * (§7.4) — whichever thread, if any, the composer that sent it shows by the
 * time it settles.
 *
 * The component is untestable here (no DOM), so the two things it contributes
 * at settle time are handed in: `liveThread`, the thread its live draft holds
 * (`null` once a project switch unmounted it), and `restoreLive`, its own
 * live restore. Everything else is the real thing: the composer bridge's
 * registry, the thread store's draft write and the persisted drafts in
 * (stubbed) `localStorage`.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { AttachmentRef, ComposerContextRecord } from "@orquester/api/agent-chat";

import { registerComposerHandle } from "./composer-bridge";
import { restoreFailedSendDraft } from "./composer-failed-send";
import type { StagedAttachment } from "./ComposerAttachments";
import type { FailedSendRestore } from "./composer-submission";

const DRAFTS_KEY = "orquester:agent-chat-drafts";

const SHOT: AttachmentRef = {
  type: "image",
  id: "att-shot",
  name: "shot.png",
  mimeType: "image/png",
  sizeBytes: 12
};
const REPORT: AttachmentRef = {
  type: "file",
  id: "att-report",
  name: "report.pdf",
  mimeType: "application/pdf",
  sizeBytes: 12
};
/** An image pasted into A's draft while the send was in flight. */
const PASTED: AttachmentRef = {
  type: "image",
  id: "att-pasted",
  name: "pasted.png",
  mimeType: "image/png",
  sizeBytes: 12
};
const CONTEXT: ComposerContextRecord = { kind: "file", label: "src/index.ts", ref: "/w/p/src/index.ts" };

/** A chip as the sending composer staged it: keyed per pick, uploaded, ready. */
function chip(ref: AttachmentRef, mimeType: string): StagedAttachment {
  return {
    key: `picked:${ref.id}`,
    name: ref.name,
    sizeBytes: 12,
    mimeType,
    status: "ready",
    progress: 1,
    ref
  };
}

/** A's message — an image and a file — whose send failed. */
const FAILED: FailedSendRestore<StagedAttachment> = {
  outcome: { kind: "failed", text: "compare [Image #1] with the report", notice: "Could not send the message." },
  sent: [chip(SHOT, "image/png"), chip(REPORT, "application/pdf")]
};

/** What A's draft held when the send settled, and B's. */
const A_BEFORE = { text: "typed since, see [Image #1]", attachments: [PASTED], context: [CONTEXT] };
const B_BEFORE = { text: "b's own", attachments: [], context: [] };

/** A's draft once the send is back in it: ahead of what it held, `[Image #N]` following its image. */
const A_RESTORED = {
  text: "compare [Image #1] with the report\n\ntyped since, see [Image #2]",
  attachments: [SHOT, REPORT, PASTED],
  context: [CONTEXT]
};

describe("a send that did not go out comes back to the thread it was sent from", () => {
  let backing: Record<string, string> = {};
  const persisted = (): Record<string, unknown> => JSON.parse(backing[DRAFTS_KEY] ?? "{}");

  /** The composer's own live restore, recorded. */
  let live: FailedSendRestore<StagedAttachment>[] = [];
  const restoreLive = (restore: FailedSendRestore<StagedAttachment>): boolean => {
    live.push(restore);
    return true;
  };

  beforeEach(() => {
    backing = { [DRAFTS_KEY]: JSON.stringify({ A: A_BEFORE, B: B_BEFORE }) };
    live = [];
    (globalThis as unknown as { localStorage: unknown }).localStorage = {
      getItem: (key: string) => backing[key] ?? null,
      setItem: (key: string, value: string) => {
        backing[key] = value;
      },
      removeItem: (key: string) => {
        delete backing[key];
      }
    };
  });

  afterEach(() => {
    delete (globalThis as unknown as { localStorage?: unknown }).localStorage;
  });

  it("handed another thread while it was in flight: into its own thread's persisted draft, never the one on screen", () => {
    // The composer on screen shows B, so the bridge knows it as B's: every call it gets is recorded.
    const toB: string[] = [];
    const unregister = registerComposerHandle("B", {
      insertText: () => void toB.push("insertText"),
      stageAttachment: () => {
        toB.push("stageAttachment");
        return true;
      },
      focusAtEnd: () => void toB.push("focusAtEnd"),
      openControl: () => void toB.push("openControl"),
      sendText: () => {
        toB.push("sendText");
        return false;
      },
      restoreFailedSend: () => {
        toB.push("restoreFailedSend");
        return true;
      }
    });
    try {
      const target = restoreFailedSendDraft({ sentFrom: "A", liveThread: "B", restore: FAILED, restoreLive });

      assert.equal(target, "persisted");
      assert.deepEqual(live, [], "the live draft is B's: nothing goes into it");
      assert.deepEqual(toB, [], "nor into B's composer through the bridge");
      assert.deepEqual(persisted().A, A_RESTORED);
      assert.deepEqual(persisted().B, B_BEFORE);
    } finally {
      unregister();
    }
  });

  it("unmounted by a project switch: into its own thread's persisted draft, where the next mount loads it", () => {
    const target = restoreFailedSendDraft({ sentFrom: "A", liveThread: null, restore: FAILED, restoreLive });

    assert.equal(target, "persisted");
    assert.deepEqual(live, []);
    assert.deepEqual(persisted().A, A_RESTORED);
    assert.deepEqual(persisted().B, B_BEFORE);
  });

  it("still showing its thread: into the live draft, as always, and nothing is written behind it", () => {
    const stored = backing[DRAFTS_KEY];
    const target = restoreFailedSendDraft({ sentFrom: "A", liveThread: "A", restore: FAILED, restoreLive });

    assert.equal(target, "live");
    assert.deepEqual(live, [FAILED]);
    assert.equal(backing[DRAFTS_KEY], stored);
  });

  it("its tab open again in another composer: into that composer's live draft, never behind its back", () => {
    const handed: FailedSendRestore<StagedAttachment>[] = [];
    const unregister = registerComposerHandle("A", {
      insertText: () => {},
      stageAttachment: () => true,
      focusAtEnd: () => {},
      openControl: () => {},
      sendText: () => false,
      restoreFailedSend: (restore) => {
        handed.push(restore);
        return true;
      }
    });
    try {
      const stored = backing[DRAFTS_KEY];
      const target = restoreFailedSendDraft({ sentFrom: "A", liveThread: null, restore: FAILED, restoreLive });

      assert.equal(target, "composer");
      assert.deepEqual(handed, [FAILED]);
      assert.deepEqual(live, []);
      assert.equal(backing[DRAFTS_KEY], stored);
    } finally {
      unregister();
    }
  });

  it("a composer that no longer shows the thread refuses it, and the persisted draft takes it", () => {
    const unregister = registerComposerHandle("A", {
      insertText: () => {},
      stageAttachment: () => true,
      focusAtEnd: () => {},
      openControl: () => {},
      sendText: () => false,
      restoreFailedSend: () => false
    });
    try {
      const target = restoreFailedSendDraft({ sentFrom: "A", liveThread: "B", restore: FAILED, restoreLive });

      assert.equal(target, "persisted");
      assert.deepEqual(persisted().A, A_RESTORED);
      assert.deepEqual(persisted().B, B_BEFORE);
    } finally {
      unregister();
    }
  });

  it("a send that gives nothing back writes no draft: a refusal, a failed Implement", () => {
    const stored = backing[DRAFTS_KEY];
    const refused: FailedSendRestore<StagedAttachment> = {
      outcome: { kind: "refused", notice: "The full plan could not be loaded." },
      sent: []
    };
    const implement: FailedSendRestore<StagedAttachment> = {
      outcome: { kind: "failed", text: null, notice: "The agent host is restarting." },
      sent: []
    };
    restoreFailedSendDraft({ sentFrom: "A", liveThread: "B", restore: refused, restoreLive });
    restoreFailedSendDraft({ sentFrom: "A", liveThread: null, restore: implement, restoreLive });

    assert.equal(backing[DRAFTS_KEY], stored);
  });
});
