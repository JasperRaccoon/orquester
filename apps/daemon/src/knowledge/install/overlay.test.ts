import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { MYKG_PROMPTS_ROOT, applyOverlay, overlayApplied, overlayDigest, overlayFiles } from "./overlay.ts";
import { MYKG_LINE } from "./pins.ts";
import { MYKG_0_4_PROMPT_FILES, tempRoot } from "./testing.ts";

// The shipped myKG prompt overlay: which files it replaces, that each keeps
// myKG's output contract verbatim (the JSON shapes and the trailing headers
// myKG's code appends its blocks after), and the copy rules.

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

test("no overlay keeps the WWII-aircraft wording", async () => {
  for (const file of await overlayFiles(MYKG_LINE)) {
    const text = await read(file);
    for (const word of ["aircraft", "Aircraft", "Horten", "Military", "AirForce", "Colonel", "Materiel", "commanding general"]) {
      assert.ok(!text.includes(word), `${file} still says "${word}"`);
    }
  }
});

test("each overlay keeps myKG's output contract verbatim", async () => {
  const contract: Record<string, string[]> = {
    "pass1/system.txt": [
      'Return a single JSON object with exactly two keys: "concepts" and "properties".',
      'Do NOT return any other keys (no "relations", no "edges", no "graph").',
      '  - "parent": name of the parent class, or null for root classes',
      '  - "domain": the subject class name (must appear in concepts[])',
      '  - "range": the object class name (must appear in concepts[])',
      '- Do NOT add a "Relationship" class. Relationships are entries in properties[], not classes.',
      '- Every concept MUST include at least a "name" attribute.'
    ],
    "pass2/system.txt": [
      'Return a single JSON object with exactly two keys: "nodes" and "edges".',
      '  - "id": kebab-case slug, e.g. "person-alice"',
      '  - "attributes": object with one key per schema attribute (including inherited).',
      '    Each value MUST be {"value": <extracted or null>, "confidence": <float>}.',
      '  - "id": sequential, e.g. "edge-001"',
      '  - "from": node ID from nodes[] above (NOT a display name)',
      '  - "to": node ID from nodes[] above (NOT a display name)',
      '"Outgoing edges" and "Incoming edges" per type',
      'If "NODES ALREADY EXTRACTED" appears in the input',
      "keyed by attribute name. It MUST NOT be a JSON array"
    ],
    "normalize/system.txt": [
      '{"<ConceptType>": {"<alias>": "<canonical>", ...}, ...}',
      "Only map to canonical names that appear in the input list for that type.",
      "- Return only JSON. No explanation. No markdown fences."
    ],
    "schema_merge/harmonize_system.txt": [
      '- Return ONLY valid JSON with keys "concepts" and "properties". No markdown. No explanation.',
      "1. MERGED SCHEMA",
      "2. RAW PROPOSALS"
    ],
    "schema_merge/merge_harmonize_system.txt": [
      '- Return ONLY valid JSON with keys "concepts" and "properties". No markdown. No explanation.',
      "2. SESSION SCHEMAS",
      "- NEVER drop an attribute that appeared on a concept in either session schema"
    ],
    "schema_merge/quality_system.txt": ['Return ONLY the corrected schema JSON with keys "concepts" and "properties".'],
    "schema_merge/merge_quality_system.txt": [
      'Return ONLY the corrected schema JSON with keys "concepts" and "properties".',
      "- NEVER drop an attribute that was present in the input schema."
    ]
  };
  for (const [file, lines] of Object.entries(contract)) {
    const text = await read(file);
    for (const line of lines) assert.ok(text.includes(line), `${file} lost: ${line}`);
  }
  // myKG appends its source text / schema block right after these headers.
  assert.equal((await read("pass1/system.txt")).trimEnd().split("\n").at(-1), "## SOURCE TEXT");
  assert.equal((await read("schema_merge/quality_system.txt")).trimEnd().split("\n").at(-1), "## SCHEMA:");
  assert.equal((await read("schema_merge/merge_quality_system.txt")).trimEnd().split("\n").at(-1), "## SCHEMA:");
  // The domain guidance the spec asks for.
  const pass2 = await read("pass2/system.txt");
  assert.match(pass2, /Author: Om Patel \(@om_patel5\) · thread · 2026-10-11/);
  assert.match(pass2, /the author is a Person node/);
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
