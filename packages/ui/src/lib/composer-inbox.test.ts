import test from "node:test";
import assert from "node:assert/strict";

import {
  clearComposerInbox,
  composerTextForDelivery,
  deliverToComposerDraft,
  mergeComposerDeliveries,
  subscribeComposerInbox,
  takeComposerDeliveries,
  type ComposerDelivery
} from "./composer-inbox.ts";

const delivery = (text: string): ComposerDelivery => ({ text, attachments: [] });

test("a delivery made before the composer mounts is waiting for it", () => {
  clearComposerInbox("s1");
  deliverToComposerDraft("s1", delivery("one"));
  deliverToComposerDraft("s1", delivery("two"));
  assert.deepEqual(
    takeComposerDeliveries("s1").map((d) => d.text),
    ["one", "two"]
  );
  // Taking drains it: a second mount must not replay the same payload.
  assert.deepEqual(takeComposerDeliveries("s1"), []);
});

test("a mounted composer receives deliveries directly and nothing queues", () => {
  clearComposerInbox("s2");
  const seen: string[] = [];
  const stop = subscribeComposerInbox("s2", (d) => seen.push(d.text));
  deliverToComposerDraft("s2", delivery("live"));
  assert.deepEqual(seen, ["live"]);
  assert.deepEqual(takeComposerDeliveries("s2"), []);
  stop();
});

test("after unsubscribing, deliveries queue again", () => {
  clearComposerInbox("s3");
  const stop = subscribeComposerInbox("s3", () => {});
  stop();
  deliverToComposerDraft("s3", delivery("later"));
  assert.deepEqual(
    takeComposerDeliveries("s3").map((d) => d.text),
    ["later"]
  );
});

test("deliveries are per session and never cross", () => {
  clearComposerInbox("s4");
  clearComposerInbox("s5");
  deliverToComposerDraft("s4", delivery("four"));
  assert.deepEqual(takeComposerDeliveries("s5"), []);
  assert.equal(takeComposerDeliveries("s4").length, 1);
});

test("clearing a closed tab drops what was queued for it", () => {
  clearComposerInbox("s6");
  deliverToComposerDraft("s6", delivery("gone"));
  clearComposerInbox("s6");
  assert.deepEqual(takeComposerDeliveries("s6"), []);
});

test("a delivery becomes draft text plus one attachment path per line", () => {
  assert.equal(
    composerTextForDelivery({
      text: "Fix this button",
      attachments: [
        { type: "image", id: "/up/a.png", name: "a.png", mimeType: "image/png", sizeBytes: 1 },
        { type: "file", id: "/up/b.txt", name: "b.txt", sizeBytes: 2 },
        // The host's reply names the absolute path (§7.4); an id-only ref is
        // all an older reply carried, and it still contributes its id.
        { type: "file", id: "t1-uuid-xlsx", name: "x.xlsx", sizeBytes: 3, path: "/appdir/x.xlsx" }
      ]
    }),
    "Fix this button\n\n/up/a.png\n/up/b.txt\n/appdir/x.xlsx"
  );
});

test("either half alone stands on its own, and an empty delivery is empty text", () => {
  assert.equal(composerTextForDelivery({ text: "just words", attachments: [] }), "just words");
  assert.equal(
    composerTextForDelivery({
      text: "",
      attachments: [{ type: "file", id: "/up/a", name: "a", sizeBytes: 1 }]
    }),
    "/up/a"
  );
  assert.equal(composerTextForDelivery({ text: "", attachments: [] }), "");
});

test("merging keeps order and concatenates attachments", () => {
  assert.equal(mergeComposerDeliveries([]), null);
  const one = delivery("only");
  assert.equal(mergeComposerDeliveries([one]), one);
  const merged = mergeComposerDeliveries([
    { text: "a", attachments: [{ type: "file", id: "a", name: "a", sizeBytes: 1 }] },
    { text: "", attachments: [{ type: "file", id: "b", name: "b", sizeBytes: 2 }] },
    { text: "c", attachments: [] }
  ]);
  assert.equal(merged?.text, "a\n\nc");
  assert.deepEqual(
    merged?.attachments.map((a) => a.id),
    ["a", "b"]
  );
});
