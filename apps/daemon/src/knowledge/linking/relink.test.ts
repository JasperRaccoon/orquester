import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { KnowledgeEntryMeta } from "@orquester/api";
import { emptyKnowledgeRelinkState } from "@orquester/config";
import { FakeVectorIndex, around, axis } from "../search/fake-vector-index.ts";
import { COMMITTED_MANIFEST_FILE, MYKG_MANIFEST_FILE, mykgSessionPaths } from "./mykg-files.ts";
import {
  LINK_CONTEXT_VERSION,
  LINK_GAPS_MAX,
  pickRelinkBatch,
  prepareRelinkBatch,
  queueLinkGaps,
  RELINK_BATCH_MAX,
  relinkBacklog,
  relinkStatus,
  resetRelinkWave,
  settleRelink,
  type RelinkStore
} from "./relink.ts";
import { EntryDocumentLocator } from "./context.ts";
import { mykgTaskId } from "./testing.ts";

const roots: string[] = [];
after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

const ID = (n: number) => `ke_${String(n).padStart(12, "0")}`;

function store(entries: { id: string; linkState?: KnowledgeEntryMeta["linkState"]; context?: number | null; savedAt?: string; hash?: string }[]): RelinkStore & {
  metas: Map<string, KnowledgeEntryMeta>;
  contexts: Map<string, number>;
} {
  const metas = new Map<string, KnowledgeEntryMeta>();
  const contexts = new Map<string, number>();
  for (const [i, e] of entries.entries()) {
    metas.set(e.id, {
      id: e.id,
      title: e.id,
      kind: "note",
      author: null,
      handle: null,
      url: null,
      postedAt: null,
      savedAt: e.savedAt ?? `2026-10-${String(10 + i).padStart(2, "0")}T00:00:00.000Z`,
      updatedAt: "t",
      savedFrom: { by: "user" },
      collections: [],
      contentHash: e.hash ?? `hash-${e.id}`,
      linkState: e.linkState ?? "linked"
    });
    if (e.context !== undefined && e.context !== null) contexts.set(e.id, e.context);
  }
  return {
    metas,
    contexts,
    listMeta: () => [...metas.values()],
    getMeta: (id) => metas.get(id) ?? null,
    linkContext: (id) => contexts.get(id) ?? null
  };
}

describe("the re-link backlog", () => {
  it("takes the batch in flux, then gap-queued, then outdated entries by save date; never pending, unlinked or current ones", () => {
    const s = store([
      { id: ID(1), savedAt: "2026-10-03T00:00:00.000Z" },
      { id: ID(2), savedAt: "2026-10-01T00:00:00.000Z" },
      { id: ID(3), context: LINK_CONTEXT_VERSION },
      { id: ID(4), context: 0 },
      { id: ID(5), linkState: "pending" },
      { id: ID(6), linkState: "failed" },
      { id: ID(7), context: LINK_CONTEXT_VERSION },
      { id: ID(8) }
    ]);
    const relink = { ...emptyKnowledgeRelinkState(), prepared: [ID(8), "ke_gone0000000"], gapQueue: [ID(7), ID(6)] };
    assert.deepEqual(relinkBacklog(relink, s, new Set([ID(1)]), true), [ID(8), ID(7), ID(2), ID(4)]);
    assert.deepEqual(relinkBacklog(relink, s, new Set(), false), [ID(8)], "without context only the batch in flux stays");
  });

  it("a run takes at most 25, the batch in flux first; a save's run carries only the batch in flux", () => {
    const relink = { ...emptyKnowledgeRelinkState(), prepared: [ID(99)] };
    const backlog = [ID(99), ...Array.from({ length: 40 }, (_, i) => ID(i + 1))];
    const batch = pickRelinkBatch(relink, backlog, false);
    assert.equal(batch.length, RELINK_BATCH_MAX);
    assert.equal(batch[0], ID(99));
    assert.deepEqual(pickRelinkBatch(relink, backlog, true), [ID(99)]);
  });

  it("status counts what is left and what this wave did; null when nothing is left, and the next wave starts at zero", () => {
    const relink = emptyKnowledgeRelinkState();
    assert.equal(relinkStatus(relink, 0), null);
    assert.deepEqual(relinkStatus(relink, 30), { pending: 30, done: 0, total: 30 });
    relink.prepared = [ID(1), ID(2), ID(3)];
    relink.gapQueue = [ID(2), ID(9)];
    relink.gapPairs = { [`${ID(2)} ${ID(9)}`]: "h h", [`${ID(2)} ${ID(77)}`]: "h h" };
    settleRelink(relink, [ID(1), ID(2)], [ID(1), ID(2), ID(3)], (id) => id !== ID(77));
    assert.deepEqual(relink.prepared, [ID(3)], "a run's verdict takes them out of flux");
    assert.deepEqual(relink.gapQueue, [ID(9)]);
    assert.deepEqual(Object.keys(relink.gapPairs), [`${ID(2)} ${ID(9)}`], "pairs of deleted entries go");
    assert.equal(relink.done, 2);
    assert.deepEqual(relinkStatus(relink, 5), { pending: 5, done: 2, total: 7 });
    resetRelinkWave(relink, 5);
    assert.equal(relink.done, 2);
    resetRelinkWave(relink, 0);
    assert.equal(relink.done, 0);
  });
});

describe("link gaps", () => {
  it("queues both entries of each new pair once per pair of content hashes; an edit queues the pair again", async () => {
    const index = new FakeVectorIndex();
    index.set(ID(1), axis(8, 0));
    index.set(ID(2), around(8, 0, 1, 0.95)); // close to 1, shares nothing: a gap
    index.set(ID(3), around(8, 0, 2, 0.9)); // close to 1 and 2, shares with 1
    index.set(ID(4), axis(8, 5));
    const concepts: Record<string, string[]> = { [ID(1)]: ["c-x"], [ID(2)]: ["c-y"], [ID(3)]: ["c-x", "c-y"], [ID(4)]: ["c-z"] };
    const hashes: Record<string, string> = { [ID(1)]: "h1", [ID(2)]: "h2", [ID(3)]: "h3", [ID(4)]: "h4" };
    const relink = emptyKnowledgeRelinkState();
    const options = { ids: [ID(1), ID(2), ID(3), ID(4)], index, conceptsOf: (id: string) => concepts[id] ?? [], hashOf: (id: string) => hashes[id] ?? null, minimum: 0.85 };
    assert.deepEqual(await queueLinkGaps(relink, options), [ID(1), ID(2)]);
    assert.deepEqual(relink.gapPairs, { [`${ID(1)} ${ID(2)}`]: "h1 h2" });
    // A re-link took them out of the queue; the gap is still there: not queued again.
    relink.gapQueue = [];
    assert.deepEqual(await queueLinkGaps(relink, options), []);
    assert.deepEqual(relink.gapQueue, []);
    // Entry 2 is edited: the pair is worth another try.
    hashes[ID(2)] = "h2b";
    assert.deepEqual(await queueLinkGaps(relink, options), [ID(1), ID(2)]);
    assert.equal(relink.gapPairs[`${ID(1)} ${ID(2)}`], "h1 h2b");
  });

  it(`keeps growing past the first ${LINK_GAPS_MAX} pairs: recorded pairs never take up the limit`, async () => {
    // Pairs of entries close to each other only (one axis per pair), none sharing a concept:
    // LINK_GAPS_MAX + 30 gaps, closer the lower the pair number.
    const pairs = LINK_GAPS_MAX + 30;
    const index = new FakeVectorIndex();
    const dims = pairs + 1;
    const hashes: Record<string, string> = {};
    const ids: string[] = [];
    for (let p = 0; p < pairs; p += 1) {
      const [x, y] = [ID(2 * p + 1), ID(2 * p + 2)];
      index.set(x, axis(dims, p));
      index.set(y, around(dims, p, pairs, 0.99 - p * 0.0005));
      hashes[x] = `h${x}`;
      hashes[y] = `h${y}`;
      ids.push(x, y);
    }
    const relink = emptyKnowledgeRelinkState();
    const options = { ids, index, conceptsOf: (id: string) => [`c-${id}`], hashOf: (id: string) => hashes[id] ?? null, minimum: 0.85 };
    assert.equal((await queueLinkGaps(relink, options)).length, 2 * LINK_GAPS_MAX);
    // Re-linked meanwhile (the queue emptied), the gaps still there: the next scan queues the rest.
    relink.gapQueue = [];
    const next = await queueLinkGaps(relink, options);
    assert.equal(next.length, 2 * 30);
    assert.equal(Object.keys(relink.gapPairs).length, pairs);
    relink.gapQueue = [];
    assert.deepEqual(await queueLinkGaps(relink, options), []);
  });
});

describe("prepareRelinkBatch", () => {
  it("drops the batch's keys from both manifests and clears only its cached Pass 2 answers, so myKG asks again", async () => {
    const root = await mkdtemp(join(tmpdir(), "orq-relink-"));
    roots.push(root);
    const paths = mykgSessionPaths(root, "s1");
    const inbox = join(paths.intermediate, "agent_inbox");
    const outbox = join(paths.intermediate, "agent_outbox");
    await mkdir(inbox, { recursive: true });
    await mkdir(outbox, { recursive: true });
    const manifest = { [`${ID(1)}.md`]: { sha256: "a" }, [`input/${ID(2)}.md`]: { sha256: "b" }, [`${ID(3)}.md`]: { sha256: "c" } };
    await writeFile(join(paths.intermediate, MYKG_MANIFEST_FILE), JSON.stringify(manifest));
    await writeFile(join(paths.root, COMMITTED_MANIFEST_FILE), JSON.stringify(manifest));
    // Entry 1 quotes entry 3 whole: entry 3's task is still entry 3's alone.
    const plain = (n: number) => `Author: A\n\n# Entry ${n}\n\nBody ${n}.\n`;
    const mirror = (n: number) => (n === 1 ? `Author: A\n\n# Entry 1\n\nBody 1, quoting entry 3:\n\n${plain(3)}` : plain(n));
    const input = join(root, "input");
    await mkdir(input, { recursive: true });
    for (const n of [1, 2, 3]) await writeFile(join(input, `${ID(n)}.md`), mirror(n));
    const locator = new EntryDocumentLocator({ mykgInputDir: input, listMeta: () => [1, 2, 3].map((n) => ({ id: ID(n) }) as KnowledgeEntryMeta) });
    await locator.load();
    const owns = (ids: string[]) => (document: string) => ids.includes(locator.locate(document) ?? "");
    const answer = async (step: string, user: string, label: string): Promise<string> => {
      const id = mykgTaskId("PASS2", user, label);
      await writeFile(join(inbox, `${id}.task.json`), JSON.stringify({ task_id: id, step, context_label: label, system: "PASS2", user }));
      await writeFile(join(outbox, `${id}.answer.json`), JSON.stringify({ task_id: id, answer: "{}" }));
      await writeFile(join(outbox, `${id}.done`), "");
      return id;
    };
    const doc = (n: number) => `SCHEMA\n\nDOCUMENT\n========\n${mirror(n).trimEnd()}`;
    const one = await answer("pass2", doc(1), "pass2 chunk 1");
    const oneRetry = await answer("pass2", `Previous attempt had errors:\n- x\n\n${doc(1)}`, "pass2 chunk 1 retry-validation");
    const two = await answer("pass2", doc(2), "pass2 chunk 2");
    const three = await answer("pass2", doc(3), "pass2 chunk 3");
    const pass1 = await answer("pass1", "CORPUS", "pass1 batch 0/1");

    // Entry 2 was prepared by an earlier attempt: its answer (given WITH context) is kept.
    const cleared = await prepareRelinkBatch(paths, [ID(1), ID(2)], owns([ID(1)]));
    assert.deepEqual(cleared.sort(), [one, oneRetry].sort());
    for (const file of [MYKG_MANIFEST_FILE, `../${COMMITTED_MANIFEST_FILE}`]) {
      const left = JSON.parse(await readFile(join(paths.intermediate, file), "utf8")) as Record<string, unknown>;
      assert.deepEqual(Object.keys(left), [`${ID(3)}.md`], `${file}: the batch is new to myKG again`);
    }
    const outs = await readdir(outbox);
    for (const id of [two, three, pass1]) assert.ok(outs.includes(`${id}.done`), "other answers stay cached (entry 3's too, though entry 1 quotes it)");
    for (const id of [one, oneRetry]) assert.ok(!outs.includes(`${id}.done`) && !outs.includes(`${id}.answer.json`));
    // Idempotent.
    assert.deepEqual(await prepareRelinkBatch(paths, [ID(1), ID(2)], owns([ID(1)])), []);
  });
});
