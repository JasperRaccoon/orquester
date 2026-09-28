/**
 * Attachment ids and paths (§5.1). Cases ported from T3 Code (MIT):
 * `apps/server/src/attachmentStore.ts` + `attachmentPaths.ts`.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  attachmentFileExtension,
  attachmentFileNameCandidates,
  createAttachmentId,
  parseAttachmentFileExtension,
  parseAttachmentIdFromRelativePath,
  parseThreadSegmentFromAttachmentId,
  toSafeThreadAttachmentSegment
} from "./attachments.ts";

const UUID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

test("a thread segment is sanitised to [a-z0-9_-] and bounded", () => {
  assert.equal(toSafeThreadAttachmentSegment("Thread/One"), "thread-one");
  assert.equal(toSafeThreadAttachmentSegment("  ..//  "), null);
  assert.equal(toSafeThreadAttachmentSegment("x".repeat(200))?.length, 80);
});

test("the reserved pending segment can never be claimed by a thread", () => {
  assert.equal(toSafeThreadAttachmentSegment("pending"), "_pending");
});

test("an id names its owning thread and round-trips", () => {
  const id = createAttachmentId("Thread One", UUID, "png");
  assert.equal(id, `thread-one-${UUID}-png`);
  assert.equal(parseThreadSegmentFromAttachmentId(id!), "thread-one");
  assert.equal(parseAttachmentFileExtension(id!), "png");
});

test("an unusable extension collapses to bin rather than riding along", () => {
  assert.equal(createAttachmentId("t1", UUID, "this-is-not-an-extension"), `t1-${UUID}-bin`);
  assert.equal(createAttachmentId("t1", UUID), `t1-${UUID}`);
});

test("a traversal-shaped id never parses", () => {
  for (const bad of ["../../etc/passwd", "t1/../t2", "t1.png", "", "..", "\0"]) {
    assert.equal(parseThreadSegmentFromAttachmentId(bad), null, bad);
  }
});

test(".part is reserved, so a stored archive.part becomes .bin", () => {
  assert.equal(attachmentFileExtension("archive.part"), ".bin");
  assert.equal(attachmentFileExtension("shot.PNG"), ".png");
  assert.equal(attachmentFileExtension("no-extension"), ".bin");
  assert.equal(attachmentFileExtension("weird.reallylongextension"), ".bin");
});

test("the file name candidates follow the id's own extension when it has one", () => {
  assert.deepEqual(attachmentFileNameCandidates(`t1-${UUID}-png`), [`t1-${UUID}-png.png`]);
  const legacy = attachmentFileNameCandidates(`t1-${UUID}`);
  assert.ok(legacy.length > 1, "an id with no extension suffix probes the known ones");
  assert.ok(legacy.every((name) => name.startsWith(`t1-${UUID}.`)));
  assert.deepEqual(attachmentFileNameCandidates("../escape"), []);
});

test("an id is recovered from a stored file name", () => {
  assert.equal(parseAttachmentIdFromRelativePath(`t1-${UUID}-png.png`), `t1-${UUID}-png`);
  assert.equal(parseAttachmentIdFromRelativePath("noextension"), null);
  assert.equal(parseAttachmentIdFromRelativePath("dir/file.png"), null);
});
