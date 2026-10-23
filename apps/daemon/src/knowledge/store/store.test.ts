import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { KNOWLEDGE_ENTRY_MAX_BYTES, KNOWLEDGE_SAVE_MAX_ENTRIES } from "@orquester/api";
import { knowledgeCollectionsPath, knowledgeEntriesDir, knowledgeMykgInputDir } from "@orquester/config";
import type { KnowledgeEntryChange } from "../ports.ts";
import { parseEntryFile } from "./entry-file.ts";
import { KnowledgeError } from "./errors.ts";
import { knowledgeContentHash, normalizeKnowledgeUrl } from "./normalize.ts";
import { KnowledgeStore } from "./store.ts";

async function setup(t: TestContext) {
  const appdir = await mkdtemp(join(tmpdir(), "kg-store-"));
  t.after(() => rm(appdir, { recursive: true, force: true }));
  let clock = Date.parse("2026-10-23T10:00:00.000Z");
  const now = () => new Date((clock += 1000));
  const warnings: string[] = [];
  const logger = { warn: (m: string) => warnings.push(m), error: (m: string) => warnings.push(m) };
  const open = async () => {
    const store = await KnowledgeStore.open({ appdir, now, logger });
    const changes: KnowledgeEntryChange[] = [];
    store.onChange((c) => changes.push(c));
    return { store, changes };
  };
  return { appdir, open, warnings };
}

async function rejects(promise: Promise<unknown>, code: string, pattern?: RegExp): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof KnowledgeError, String(error));
    assert.equal(error.code, code);
    if (pattern) assert.match(error.message, pattern);
    return true;
  });
}

const POST = "Alternatives pages convert well.\n\nWrite one per competitor: [competitor] vs [you], honest tables.";

test("save writes the entry, the frontmatter round-trips, and the mirror carries the header", async (t) => {
  const { appdir, open } = await setup(t);
  const { store, changes } = await open();
  const outcome = await store.save({
    entries: [
      {
        body: POST,
        title: "Alternatives pages",
        kind: "thread",
        author: "Om Patel",
        handle: "@om_patel5",
        postedAt: "2026-10-11",
        url: "https://twitter.com/om_patel5/status/123?s=20",
        collections: ["SEO"]
      }
    ],
    newCollections: [{ name: "SEO", description: "Search engines" }],
    sessionId: "sess-1"
  });
  assert.equal(outcome.createdCollections.length, 1);
  const seo = outcome.createdCollections[0]!;
  assert.match(seo.id, /^kc_[a-z2-7]{10}$/);
  assert.equal(seo.color, "chart-1");
  const [result] = outcome.results;
  assert.equal(result!.status, "saved");
  assert.match(result!.entryId, /^ke_[a-z2-7]{12}$/);
  assert.deepEqual(result!.collections, [seo.id]);
  assert.equal(result!.citation, `[Alternatives pages · @om_patel5](orquester-knowledge:entry/${result!.entryId})`);
  assert.deepEqual(changes, [{ kind: "added", entryIds: [result!.entryId] }]);

  const meta = store.getMeta(result!.entryId)!;
  assert.equal(meta.handle, "om_patel5");
  assert.equal(meta.linkState, "pending");
  assert.deepEqual(meta.savedFrom, { by: "agent", sessionId: "sess-1" });
  assert.equal(meta.contentHash, knowledgeContentHash(POST));
  const entry = await store.getEntry(result!.entryId);
  assert.equal(entry!.body, POST);

  const file = await readFile(join(knowledgeEntriesDir(appdir), `${result!.entryId}.md`), "utf8");
  assert.ok(file.startsWith("---\n"));
  assert.equal(parseEntryFile(file, result!.entryId).body, POST);

  const mirror = await readFile(join(knowledgeMykgInputDir(appdir), `${result!.entryId}.md`), "utf8");
  assert.equal(mirror, `Author: Om Patel (@om_patel5) · thread · 2026-10-11\n\n# Alternatives pages\n\n${POST}\n`);
  assert.ok(!mirror.includes(seo.id) && !mirror.includes("SEO"));

  // Reopen: the same entries and collections load from disk.
  const again = await open();
  assert.deepEqual(again.store.getMeta(result!.entryId), meta);
  assert.deepEqual(again.store.listCollections(), store.listCollections());
});

test("mirror header omits missing parts cleanly", async (t) => {
  const { appdir, open } = await setup(t);
  const { store } = await open();
  await store.createCollection({ name: "Notes" });
  const { results } = await store.save({ entries: [{ body: "Just a note.", collections: ["notes"] }] });
  const mirror = await readFile(join(knowledgeMykgInputDir(appdir), `${results[0]!.entryId}.md`), "utf8");
  assert.equal(mirror, "note\n\n# Just a note.\n\nJust a note.\n");
  const { results: r2 } = await store.save({ entries: [{ body: "Another one entirely.", handle: "abc", collections: ["Notes"] }] });
  const m2 = await readFile(join(knowledgeMykgInputDir(appdir), `${r2[0]!.entryId}.md`), "utf8");
  assert.ok(m2.startsWith("Author: @abc · note\n\n"));
});

test("unknown collections are refused with the valid names, and nothing is written", async (t) => {
  const { appdir, open } = await setup(t);
  const { store, changes } = await open();
  await store.createCollection({ name: "SEO" });
  await store.createCollection({ name: "Ads" });
  await rejects(
    store.save({
      entries: [
        { body: "first fine item", collections: ["SEO"] },
        { body: "second item", collections: ["Marketing"] }
      ],
      newCollections: [{ name: "SaaS", description: "Running SaaS" }]
    }),
    "KNOWLEDGE_UNKNOWN_COLLECTION",
    /"SEO", "Ads", "SaaS"/
  );
  assert.equal(store.listMeta().length, 0);
  assert.equal(store.listCollections().length, 2);
  assert.deepEqual(await readdir(knowledgeEntriesDir(appdir)), []);
  assert.deepEqual(changes, []);
});

test("limits use the contract's codes", async (t) => {
  const { open } = await setup(t);
  const { store } = await open();
  await store.createCollection({ name: "SEO" });
  await rejects(store.save({ entries: [] }), "KNOWLEDGE_INVALID");
  await rejects(
    store.save({ entries: Array.from({ length: KNOWLEDGE_SAVE_MAX_ENTRIES + 1 }, (_, i) => ({ body: `b${i}`, collections: ["SEO"] })) }),
    "KNOWLEDGE_TOO_LARGE"
  );
  await rejects(store.save({ entries: [{ body: "x".repeat(KNOWLEDGE_ENTRY_MAX_BYTES + 1), collections: ["SEO"] }] }), "KNOWLEDGE_TOO_LARGE");
  await rejects(store.save({ entries: [{ body: "   ", collections: ["SEO"] }] }), "KNOWLEDGE_INVALID");
  await rejects(store.save({ entries: [{ body: "ok", collections: [] }] }), "KNOWLEDGE_INVALID");
  await rejects(store.save({ entries: [{ body: "ok", title: "t".repeat(201), collections: ["SEO"] }] }), "KNOWLEDGE_INVALID");
  await rejects(store.save({ entries: [{ body: "ok", url: "ftp://x", collections: ["SEO"] }] }), "KNOWLEDGE_INVALID");
  await rejects(store.save({ entries: [{ body: "ok", postedAt: "last week", collections: ["SEO"] }] }), "KNOWLEDGE_INVALID");
  await rejects(
    store.save({ entries: [{ body: "ok", collections: ["New"] }], newCollections: [{ name: "New", description: "" }] }),
    "KNOWLEDGE_INVALID"
  );
  await rejects(store.createCollection({ name: "seo" }), "KNOWLEDGE_COLLECTION_EXISTS");
  await rejects(store.createCollection({ name: "x".repeat(61) }), "KNOWLEDGE_INVALID");
  await rejects(store.updateCollection("kc_aaaaaaaaaa", { name: "y" }), "KNOWLEDGE_NOT_FOUND");
});

test("dedup: same URL, same normalized text, near-identical text; new collections are unioned in", async (t) => {
  const { open } = await setup(t);
  const { store, changes } = await open();
  const seo = await store.createCollection({ name: "SEO" });
  const ads = await store.createCollection({ name: "Ads" });
  const saas = await store.createCollection({ name: "SaaS" });
  const long = Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ");
  const first = await store.save({
    entries: [
      { body: POST, url: "https://www.x.com/om/status/42/?utm_source=a", collections: ["SEO"] },
      { body: long, collections: [seo.id] }
    ]
  });
  const [a, b] = first.results.map((r) => r.entryId);
  changes.length = 0;

  const second = await store.save({
    entries: [
      { body: "Entirely different text", url: "http://twitter.com/someone/status/42?s=20&t=abc", collections: ["Ads"] },
      { body: `  ${POST.replace(/\n\n/, "\n   \n")}  `, collections: ["SEO"] },
      { body: long.replace("word59", "word59 extra"), collections: ["SaaS"] }
    ]
  });
  assert.deepEqual(
    second.results.map((r) => [r.status, r.entryId]),
    [
      ["duplicate", a],
      ["duplicate", a],
      ["duplicate", b]
    ]
  );
  assert.deepEqual(store.getMeta(a!)!.collections, [seo.id, ads.id]);
  assert.deepEqual(store.getMeta(b!)!.collections, [seo.id, saas.id]);
  assert.deepEqual(second.results[0]!.collections, [seo.id, ads.id]);
  assert.deepEqual(changes, [{ kind: "relabelled", entryIds: [a, b] }]);
  assert.equal(store.listMeta().length, 2);

  // Inside one request: the later copy is a duplicate of the earlier new entry.
  changes.length = 0;
  const third = await store.save({
    entries: [
      { body: "A fresh idea about pricing pages", collections: ["SaaS"] },
      { body: "A fresh idea about pricing pages", collections: ["Ads"] }
    ]
  });
  assert.equal(third.results[0]!.status, "saved");
  assert.equal(third.results[1]!.status, "duplicate");
  assert.equal(third.results[1]!.entryId, third.results[0]!.entryId);
  assert.deepEqual(store.getMeta(third.results[0]!.entryId)!.collections, [saas.id, ads.id]);
  assert.deepEqual(changes, [{ kind: "added", entryIds: [third.results[0]!.entryId] }]);

  // Not near-identical: a substantially different text is a new entry.
  const fourth = await store.save({ entries: [{ body: `${long} ${long.split(" ").reverse().join(" ")}`, collections: ["SEO"] }] });
  assert.equal(fourth.results[0]!.status, "saved");
});

test("url normalization", () => {
  assert.equal(normalizeKnowledgeUrl("https://twitter.com/a/status/1?s=20"), "https://x.com/i/status/1");
  assert.equal(normalizeKnowledgeUrl("http://www.Example.com/Path/?utm_medium=x&b=2&a=1#frag"), "https://example.com/Path?a=1&b=2");
  assert.equal(normalizeKnowledgeUrl("https://example.com/"), "https://example.com");
  assert.equal(normalizeKnowledgeUrl("mailto:x@y"), null);
});

test("edits: text edits are `edited` and rewrite the mirror; collection-only edits are `relabelled` and leave it alone", async (t) => {
  const { appdir, open } = await setup(t);
  const { store, changes } = await open();
  const seo = await store.createCollection({ name: "SEO" });
  const ads = await store.createCollection({ name: "Ads" });
  const { results } = await store.save({ entries: [{ body: POST, title: "Alt pages", collections: ["SEO"] }] });
  const id = results[0]!.entryId;
  await store.setLinkState([id], "linked");
  const mirrorPath = join(knowledgeMykgInputDir(appdir), `${id}.md`);
  const mirrorBefore = await readFile(mirrorPath, "utf8");
  changes.length = 0;

  await store.updateEntry(id, { collections: [seo.id, ads.id] });
  assert.deepEqual(changes, [{ kind: "relabelled", entryIds: [id] }]);
  assert.equal(await readFile(mirrorPath, "utf8"), mirrorBefore);
  assert.equal(store.getMeta(id)!.linkState, "linked");

  await store.updateEntry(id, { url: "https://example.com/a" });
  assert.equal(changes.at(-1)!.kind, "relabelled");

  // No-op edit: no event.
  await store.updateEntry(id, { title: "Alt pages" });
  assert.equal(changes.length, 2);

  await store.updateEntry(id, { body: `${POST}\n\nAnd one more line.` });
  assert.deepEqual(changes.at(-1), { kind: "edited", entryIds: [id] });
  assert.equal(store.getMeta(id)!.linkState, "pending");
  assert.notEqual(store.getMeta(id)!.contentHash, results[0] && knowledgeContentHash(POST));
  assert.ok((await readFile(mirrorPath, "utf8")).includes("And one more line."));

  await store.updateEntry(id, { author: "Om" });
  assert.equal(changes.at(-1)!.kind, "edited");
  assert.ok((await readFile(mirrorPath, "utf8")).startsWith("Author: Om · note"));

  await rejects(store.updateEntry(id, { collections: ["kc_zzzzzzzzzz"] }), "KNOWLEDGE_UNKNOWN_COLLECTION");
  await rejects(store.updateEntry("ke_aaaaaaaaaaaa", { title: "x" }), "KNOWLEDGE_NOT_FOUND");
});

test("deleting a collection relabels its entries; deleting an entry removes its mirror", async (t) => {
  const { appdir, open } = await setup(t);
  const { store, changes } = await open();
  const seo = await store.createCollection({ name: "SEO" });
  await store.createCollection({ name: "Ads" });
  const { results } = await store.save({
    entries: [
      { body: "one about seo", collections: ["SEO", "Ads"] },
      { body: "two about ads", collections: ["Ads"] }
    ]
  });
  changes.length = 0;
  await store.deleteCollection(seo.id);
  assert.deepEqual(changes, [{ kind: "relabelled", entryIds: [results[0]!.entryId] }]);
  assert.equal(store.listCollections().length, 1);
  assert.equal(store.getMeta(results[0]!.entryId)!.collections.length, 1);
  const collectionsFile = JSON.parse(await readFile(knowledgeCollectionsPath(appdir), "utf8")) as { collections: unknown[] };
  assert.equal(collectionsFile.collections.length, 1);

  const id = results[1]!.entryId;
  await store.deleteEntry(id);
  assert.deepEqual(changes.at(-1), { kind: "deleted", entryIds: [id] });
  assert.equal(store.getMeta(id), null);
  assert.ok(!(await readdir(knowledgeMykgInputDir(appdir))).includes(`${id}.md`));
  assert.ok(!(await readdir(knowledgeEntriesDir(appdir))).includes(`${id}.md`));
});

test("startup: malformed entries are skipped and kept; unknown fields survive; the mirror is reconciled", async (t) => {
  const { appdir, open, warnings } = await setup(t);
  const first = await open();
  await first.store.createCollection({ name: "SEO" });
  const { results } = await first.store.save({
    entries: [
      { body: "keep me", collections: ["SEO"] },
      { body: "stale mirror", collections: ["SEO"] }
    ]
  });
  const [keep, stale] = results.map((r) => r.entryId) as [string, string];
  const entries = knowledgeEntriesDir(appdir);
  const mirror = knowledgeMykgInputDir(appdir);

  // A newer build's field, a malformed file, a stale and a missing mirror, an orphan, a temp file.
  const keepPath = join(entries, `${keep}.md`);
  await writeFile(keepPath, (await readFile(keepPath, "utf8")).replace("---\n", "---\nfutureField:\n  nested: 1\n"));
  const brokenId = "ke_brokenbroken";
  const brokenText = "---\nid: [unclosed\n---\nbody";
  await writeFile(join(entries, `${brokenId}.md`), brokenText);
  await writeFile(join(mirror, `${brokenId}.md`), "old mirror of the broken one");
  await writeFile(join(mirror, `${stale}.md`), "stale");
  await rm(join(mirror, `${keep}.md`));
  await writeFile(join(mirror, "ke_orphanorphan.md"), "orphan");
  await writeFile(join(mirror, "notes.md"), "stray");
  await writeFile(join(entries, `.${keep}.md.abc.tmp`), "partial");

  const { store } = await open();
  assert.deepEqual(store.listMeta().map((m) => m.id).sort(), [keep, stale].sort());
  assert.ok(warnings.some((w) => w.includes(brokenId)));
  assert.equal(await readFile(join(entries, `${brokenId}.md`), "utf8"), brokenText);
  assert.deepEqual((await readdir(mirror)).sort(), [`${brokenId}.md`, `${keep}.md`, `${stale}.md`].sort());
  assert.equal(await readFile(join(mirror, `${stale}.md`), "utf8"), "note\n\n# stale mirror\n\nstale mirror\n");
  assert.ok(!(await readdir(entries)).some((n) => n.endsWith(".tmp")));

  // A rewrite (relabel) keeps the unknown field.
  const ads = await store.createCollection({ name: "Ads" });
  await store.updateEntry(keep, { collections: [ads.id] });
  const rewritten = await readFile(keepPath, "utf8");
  assert.match(rewritten, /futureField:\n {2}nested: 1/);
});

test("a corrupt collections.json is moved aside, not overwritten", async (t) => {
  const { appdir, open, warnings } = await setup(t);
  await open();
  await writeFile(knowledgeCollectionsPath(appdir), "{not json");
  const { store } = await open();
  assert.deepEqual(store.listCollections(), []);
  assert.ok(warnings.some((w) => w.includes("moved")));
  const names = await readdir(join(appdir, "daemon", "plugins", "knowledge-graph"));
  assert.ok(names.some((n) => n.startsWith("collections.json.corrupt-")));
});

test("collection colours go round-robin and writes are serialized", async (t) => {
  const { open } = await setup(t);
  const { store } = await open();
  const made = await Promise.all(Array.from({ length: 8 }, (_, i) => store.createCollection({ name: `C${i}` })));
  assert.deepEqual(
    made.map((c) => c.color),
    ["chart-1", "chart-2", "chart-3", "chart-4", "chart-5", "chart-6", "chart-1", "chart-2"]
  );
  const saves = await Promise.all(
    Array.from({ length: 10 }, (_, i) => store.save({ entries: [{ body: `entry number ${i} with its own words`, collections: ["C0"] }] }))
  );
  assert.equal(new Set(saves.map((s) => s.results[0]!.entryId)).size, 10);
  assert.equal(store.listMeta().length, 10);
});

test("a save is all or nothing even when relabelling a duplicate fails after the new entries were written", async (t) => {
  const { appdir, open } = await setup(t);
  const { store, changes } = await open();
  await store.createCollection({ name: "SEO" });
  await store.createCollection({ name: "Ads" });
  const first = await store.save({ entries: [{ body: POST, url: "https://x.com/om/status/42", collections: ["SEO"] }] });
  const existing = first.results[0]!.entryId;
  changes.length = 0;
  // The existing entry's file can no longer be rewritten (a directory stands in for any I/O error).
  const path = join(knowledgeEntriesDir(appdir), `${existing}.md`);
  await rm(path);
  await mkdir(path);
  await assert.rejects(
    store.save({
      entries: [
        { body: "A brand new note about ad budgets.", collections: ["Ads"] },
        { body: "Different words", url: "https://twitter.com/om/status/42?s=20", collections: ["Ads"] }
      ]
    })
  );
  assert.equal(store.listMeta().length, 1, "the new entry was not kept");
  assert.deepEqual(changes, []);
  const files = (await readdir(knowledgeEntriesDir(appdir))).filter((n) => n.endsWith(".md"));
  assert.deepEqual(files, [`${existing}.md`]);
  assert.deepEqual((await readdir(knowledgeMykgInputDir(appdir))).filter((n) => n.endsWith(".md")), [`${existing}.md`]);
});

test("bodies without a single word are only duplicates when identical", async (t) => {
  const { open } = await setup(t);
  const { store } = await open();
  await store.createCollection({ name: "SEO" });
  const outcome = await store.save({
    entries: [
      { body: "🔥🔥🔥", collections: ["SEO"] },
      { body: "→ ✅ ✅", collections: ["SEO"] }
    ]
  });
  assert.deepEqual(outcome.results.map((r) => r.status), ["saved", "saved"]);
  const again = await store.save({ entries: [{ body: "👀", collections: ["SEO"] }, { body: "🔥🔥🔥", collections: ["SEO"] }] });
  assert.deepEqual(again.results.map((r) => r.status), ["saved", "duplicate"]);
  assert.equal(again.results[1]!.entryId, outcome.results[0]!.entryId);
});
