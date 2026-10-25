import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { MYKG_PROMPTS_ROOT, applyOverlay, overlayApplied, overlayDigest, overlayFiles } from "./overlay.ts";
import { MYKG_LINE } from "./pins.ts";
import { MYKG_0_4_PROMPT_FILES, tempRoot } from "./testing.ts";

// The shipped myKG prompt overlay: package paths, the trailing headers myKG
// appends blocks after, and the all-or-nothing copy rules.

const read = (file: string) => readFile(join(MYKG_PROMPTS_ROOT, MYKG_LINE, file), "utf8");

test("the 0.4 overlay replaces the domain-specific prompts, all of them files myKG 0.4 ships", async () => {
  const files = await overlayFiles(MYKG_LINE);
  assert.deepEqual(files, [
    "normalize/system.txt",
    "pass1/system.txt",
    "pass2/system.txt",
    "schema_merge/harmonize_system.txt",
    "schema_merge/merge_harmonize_system.txt",
    "schema_merge/merge_quality_system.txt",
    "schema_merge/quality_system.txt"
  ]);
  for (const file of files) assert.ok(MYKG_0_4_PROMPT_FILES.includes(file), file);
  // feedback/user_template.txt is the one prompt myKG `.format()`s: never overlaid.
  assert.ok(!files.some((file) => file.startsWith("feedback/")));
});

test("the overlay retains the headers myKG appends its input blocks after", async () => {
  assert.equal((await read("pass1/system.txt")).trimEnd().split("\n").at(-1), "## SOURCE TEXT");
  assert.equal((await read("schema_merge/quality_system.txt")).trimEnd().split("\n").at(-1), "## SCHEMA:");
  assert.equal((await read("schema_merge/merge_quality_system.txt")).trimEnd().split("\n").at(-1), "## SCHEMA:");
});

test("apply refuses a package without a target file and copies nothing; then copies every file", async (t) => {
  const root = await tempRoot("orq-kg-overlay-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const prompts = join(root, "prompts");
  const files = await overlayFiles(MYKG_LINE);
  for (const file of files.filter((name) => name !== "pass2/system.txt")) {
    await mkdir(dirname(join(prompts, file)), { recursive: true });
    await writeFile(join(prompts, file), "UPSTREAM\n");
  }
  await assert.rejects(applyOverlay(MYKG_LINE, prompts), /no prompts\/pass2\/system\.txt/);
  assert.equal(await readFile(join(prompts, "pass1/system.txt"), "utf8"), "UPSTREAM\n", "nothing was copied");
  assert.equal(await overlayApplied(MYKG_LINE, prompts), false);

  await mkdir(join(prompts, "pass2"), { recursive: true });
  await writeFile(join(prompts, "pass2/system.txt"), "UPSTREAM\n");
  assert.deepEqual(await applyOverlay(MYKG_LINE, prompts), files);
  assert.equal(await overlayApplied(MYKG_LINE, prompts), true);
  await assert.rejects(applyOverlay("9.9", prompts));
});

test("the digest covers paths and bytes", async (t) => {
  const root = await tempRoot("orq-kg-overlay-digest-");
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "1.0", "a"), { recursive: true });
  await writeFile(join(root, "1.0", "a", "x.txt"), "one");
  const first = await overlayDigest("1.0", root);
  assert.match(first, /^[0-9a-f]{64}$/);
  await writeFile(join(root, "1.0", "a", "x.txt"), "two");
  const second = await overlayDigest("1.0", root);
  assert.notEqual(second, first);
  await rm(join(root, "1.0", "a", "x.txt"));
  await writeFile(join(root, "1.0", "a", "y.txt"), "two");
  assert.notEqual(await overlayDigest("1.0", root), second);
});
