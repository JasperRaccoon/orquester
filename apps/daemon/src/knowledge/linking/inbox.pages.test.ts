/**
 * Worker tasks in parts, end to end: a real `InboxBroker` (with the run's real neighbour-context
 * provider) behind the worker tools as an in-chat call reaches them (`executeToolCall`). Claude Code
 * hides a tool result above about 49.5 KB from the model (a file path and a 2 KB preview), so no
 * result may exceed `KNOWLEDGE_WORKER_RESULT_MAX`: a larger task is read part by part from the task
 * the chat holds, with no new lease, and answered once.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  KNOWLEDGE_WORKER_PART_MAX,
  KNOWLEDGE_WORKER_RESULT_MAX,
  knowledgeRoutes,
  knowledgeWorkerTextSize,
  type KnowledgeConceptRef,
  type KnowledgeEntryMeta
} from "@orquester/api";
import type { ThreadCaller } from "../../mcp/catalog/contract.ts";
import type { DaemonMethod, DaemonRequestOptions, DaemonResponse } from "../../mcp/daemon-api.ts";
import { executeToolCall } from "../../mcp/executor.ts";
import { FakeDaemonApi } from "../../mcp/testing.ts";
import { FakeClock } from "../../workflows/agent/testing/fake-clock.ts";
import { around, axis, FakeVectorIndex } from "../search/fake-vector-index.ts";
import { CONTEXT_CONCEPTS_MAX, CONTEXT_HEADING, linkContextProvider } from "./context.ts";
import { InboxBroker } from "./inbox.ts";

const roots: string[] = [];
after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

/** The worker routes as `KnowledgeLinkingService.workerNext` / `workerSubmit` answer them, over one broker. */
class BrokerDaemonApi extends FakeDaemonApi {
  constructor(private readonly broker: InboxBroker) {
    super();
  }

  override async request(method: DaemonMethod, path: string, opts?: DaemonRequestOptions): Promise<DaemonResponse> {
    const body = (opts?.body ?? {}) as { sessionId: string; taskId?: string; answer?: string };
    if (method === "POST" && path === knowledgeRoutes.workerNext) {
      this.calls.push({ method, path, body });
      if (body.taskId === undefined) return { status: 200, body: await this.broker.next(body.sessionId) };
      const held = this.broker.held(body.sessionId, body.taskId);
      return "error" in held ? { status: 400, body: { code: "KNOWLEDGE_INVALID", message: held.error } } : { status: 200, body: held };
    }
    if (method === "POST" && path === knowledgeRoutes.workerSubmit) {
      this.calls.push({ method, path, body });
      return { status: 200, body: await this.broker.submit(body.sessionId, body.taskId!, body.answer!) };
    }
    return super.request(method, path, opts);
  }
}

const chat = (threadId: string): ThreadCaller => ({
  kind: "thread", threadId, title: "Knowledge indexer", projectPath: "/w", workspace: "w", cwd: "/w", agentId: "claude", callId: "c1",
  runtimeMode: "approval-required", planning: false, workflowOwned: false, exchange: null
});
const textOf = (r: CallToolResult): string => r.content.map((part) => (part.type === "text" ? part.text : "")).join("");

/** myKG's Pass 2 prompt: the document comes last (`context.ts` finds the entry by it). */
const pass2Prompt = (document: string) => `SCHEMA\n======\n- Tactic\n- Tool\n\nNODES ALREADY EXTRACTED\n========================\n(none)\n\nDOCUMENT\n========\n${document}`;
/** A document of about `bytes`, in paragraphs (every line unique). */
const documentOf = (tag: string, bytes: number) => {
  const lines: string[] = [`Author: Om Patel`, "", `# ${tag}`];
  for (let i = 0, size = 0; size < bytes; i += 1) {
    const line = `Paragraph ${i} of ${tag}: warm the account up for ${i % 72} hours, then post — “café” rules ≤ 3 a day.`;
    lines.push(line, "");
    size += Buffer.byteLength(line, "utf8") + 2;
  }
  return lines.join("\n").trim();
};
/** Name-normalization input: one name per line (`normalize_names batch i/n`). */
const nameList = (bytes: number) => {
  const lines: string[] = ["TYPE: Tactic", "NAMES:"];
  for (let i = 0, size = 0; size < bytes; i += 1) {
    const line = `- "Warm-up routine ${i} for a fresh TikTok account (48 h, “no likes”)"`;
    lines.push(line);
    size += Buffer.byteLength(line, "utf8") + 1;
  }
  return lines.join("\n");
};
const PASS2_SYSTEM = `You extract a knowledge graph from one document.\n${"Rules: name each concept for what the document claims. ".repeat(60)}`;
const NORMALIZE_SYSTEM = `You merge names that mean the same thing.\n${"Group only exact synonyms; keep numbers distinct. ".repeat(50)}`;

describe("worker tasks in parts, through the worker tools and the broker", () => {
  it("a 75 KB name-normalization task and a 50 KB Pass 2 task never make a result over the budget; the parts come from the held task without a lease; the context only goes where it fits and only those entries count as linked with it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orq-inbox-pages-"));
    roots.push(dir);
    const mirrors = join(dir, "mirrors");
    const inbox = join(dir, "agent_inbox");
    await mkdir(mirrors, { recursive: true });

    // Entries: three targets (no concepts yet) and five neighbours with 12 concepts each.
    const docs = { ke_small: documentOf("small", 2_000), ke_mid: "", ke_big: documentOf("big", 50_000) };
    const midBase = KNOWLEDGE_WORKER_PART_MAX - 1_400 - knowledgeWorkerTextSize(`Instructions:\n${PASS2_SYSTEM}\n\nInput:\n${pass2Prompt("")}`);
    docs.ke_mid = documentOf("mid", midBase - 200);
    while (knowledgeWorkerTextSize(docs.ke_mid) > midBase) docs.ke_mid = docs.ke_mid.slice(0, docs.ke_mid.lastIndexOf("\n\n"));
    const index = new FakeVectorIndex();
    const concepts: Record<string, KnowledgeConceptRef[]> = {};
    for (const id of Object.keys(docs)) index.set(id, axis(16, 0));
    for (let i = 1; i <= 5; i += 1) {
      index.set(`ke_n${i}`, around(16, 0, i, 0.95));
      concepts[`ke_n${i}`] = Array.from({ length: 12 }, (_, j) => ({ id: `tactic-n${i}-${j}`, type: "Tactic", name: `Neighbour ${i} tactic ${j}` }));
    }
    const metas: Pick<KnowledgeEntryMeta, "id">[] = [];
    for (const [id, text] of Object.entries(docs)) {
      await writeFile(join(mirrors, `${id}.md`), `${text}\n`);
      metas.push({ id });
    }
    const shown: string[] = [];
    const contextFor = linkContextProvider(
      { mykgInputDir: mirrors, listMeta: () => metas as KnowledgeEntryMeta[] },
      { vectors: () => index, conceptsOf: (id) => concepts[id] ?? [], contradicting: () => [] },
      (entryId) => shown.push(entryId)
    );
    const broker = new InboxBroker({ clock: new FakeClock("2026-10-28T10:00:00.000Z"), watch: null, budget: { tasks: 12, tokens: 1_000_000 }, contextFor });
    await broker.attach(dir);

    let n = 0;
    const addTask = async (step: string, system: string, user: string): Promise<string> => {
      const label = `${step} ${n}`;
      const id = createHash("sha256").update(`${system}\n--user--\n${user}\n--ctx--\n${label}`).digest("hex");
      const envelope = { task_id: id, step, context_label: label, system, user, max_tokens: 32000, timeout_seconds: 172800, created_at: `2026-10-28T10:00:${String(n).padStart(2, "0")}.000Z` };
      n += 1;
      await writeFile(join(inbox, `${id}.task.json.tmp`), JSON.stringify(envelope));
      await rename(join(inbox, `${id}.task.json.tmp`), join(inbox, `${id}.task.json`));
      return id;
    };
    const tasks = {
      normalize: { id: await addTask("normalize_names", NORMALIZE_SYSTEM, nameList(75_000)), user: nameList(75_000) },
      big: { id: await addTask("pass2", PASS2_SYSTEM, pass2Prompt(docs.ke_big)), user: pass2Prompt(docs.ke_big) },
      mid: { id: await addTask("pass2", PASS2_SYSTEM, pass2Prompt(docs.ke_mid)), user: pass2Prompt(docs.ke_mid) },
      small: { id: await addTask("pass2", PASS2_SYSTEM, pass2Prompt(docs.ke_small)), user: pass2Prompt(docs.ke_small) },
      pair: { id: await addTask("pair-check", "Say whether two claims contradict.", `A: ${documentOf("pair a", 30_000)}\n\nB: ${documentOf("pair b", 30_000)}`) }
    };
    await broker.rescan();

    const api = new BrokerDaemonApi(broker);
    const call = async (threadId: string, name: string, args: Record<string, unknown>): Promise<CallToolResult> => {
      const result = await executeToolCall({ approvals: null }, { name, arguments: args }, { caller: chat(threadId), api, signal: new AbortController().signal });
      assert.ok(knowledgeWorkerTextSize(textOf(result)) <= KNOWLEDGE_WORKER_RESULT_MAX, `${name} ${JSON.stringify(args).slice(0, 80)}: ${knowledgeWorkerTextSize(textOf(result))}`);
      return result;
    };

    // The worker: read a task (every part of it), answer it once, until told to stop.
    const seen = new Map<string, { parts: number; body: string }>();
    let out = textOf(await call("w1", "knowledge_worker_next_task", {}));
    for (;;) {
      const head = /^(?:Accepted\.\n)?Task (\S+) · step (\S+)/.exec(out);
      if (!head) break;
      const taskId = head[1]!;
      const paged = /\nThis task is in (\d+) parts\. Part 1 of \1:\n\n/.exec(out);
      const parts = paged ? Number(paged[1]) : 1;
      const texts = [out];
      const before = broker.counts();
      for (let part = 2; part <= parts; part += 1) {
        const r = await call("w1", "knowledge_worker_next_task", { taskId, part });
        assert.equal(r.isError, undefined, textOf(r).slice(0, 300));
        texts.push(textOf(r));
        // Another chat can read none of it, and takes nothing.
        const other = await call("w2", "knowledge_worker_next_task", { taskId, part });
        assert.equal((other.structuredContent as { code: string }).code, "KNOWLEDGE_INVALID");
        assert.match(textOf(other), /You do not hold task/);
      }
      assert.deepEqual(broker.counts(), before, "reading the parts leases, releases and counts nothing");
      seen.set(taskId, { parts, body: parts === 1 ? bodyOfWhole(out) : bodyOfParts(texts, parts) });
      if (taskId === tasks.pair.id) {
        // The last task: its answer's long-poll ends with the run.
        const submitted = call("w1", "knowledge_worker_submit", { taskId, answer: "{}" });
        await until(broker, () => broker.counts().waiting === 1);
        broker.finish("run-finished");
        out = textOf(await submitted);
        break;
      }
      out = textOf(await call("w1", "knowledge_worker_submit", { taskId, answer: "{}" }));
      assert.ok(out.startsWith("Accepted.\n"), out.slice(0, 200));
    }
    assert.equal(out, "Accepted.\nNo task (run-finished). End your turn now.");
    assert.deepEqual([...seen.keys()], [tasks.normalize.id, tasks.big.id, tasks.mid.id, tasks.small.id, tasks.pair.id], "every task once, in order");
    assert.equal(broker.counts().answered, 5);
    assert.equal(broker.tasksOf("w1"), 5);
    assert.equal(broker.knows("w2"), false, "the refused reads registered no chat");

    // Large tasks came in parts and were rebuilt exactly; the others came whole.
    assert.ok(seen.get(tasks.normalize.id)!.parts >= 2);
    assert.equal(seen.get(tasks.normalize.id)!.body, `Instructions:\n${NORMALIZE_SYSTEM}\n\nInput:\n${tasks.normalize.user}`);
    assert.ok(seen.get(tasks.big.id)!.parts >= 2);
    assert.equal(seen.get(tasks.big.id)!.body, `Instructions:\n${PASS2_SYSTEM}\n\nInput:\n${tasks.big.user}`, "no context for a task already in parts");
    assert.ok(seen.get(tasks.pair.id)!.parts >= 2, "a round task gets the same parts");
    assert.equal(seen.get(tasks.mid.id)!.parts, 1, "the context never puts a task in parts");
    assert.equal(seen.get(tasks.small.id)!.parts, 1);
    const listed = (taskId: string) => {
      const body = seen.get(taskId)!.body;
      return body.includes(CONTEXT_HEADING) ? body.slice(body.indexOf(CONTEXT_HEADING)).split("\n").filter((line) => line.startsWith("- ")).length : 0;
    };
    const midInput = seen.get(tasks.mid.id)!.body;
    assert.ok(midInput.includes(`${tasks.mid.user}\n\n${CONTEXT_HEADING}`), "the mid task keeps a context");
    assert.ok(listed(tasks.mid.id) > 0 && listed(tasks.mid.id) < CONTEXT_CONCEPTS_MAX, `shortened: ${listed(tasks.mid.id)} concepts`);
    assert.equal(listed(tasks.small.id), CONTEXT_CONCEPTS_MAX);
    assert.deepEqual(shown.sort(), ["ke_mid", "ke_small"], "only the entries whose task showed a block are linked with context");
    broker.dispose();
  });
});

/** A one-part task's instructions and input (between the header line and the reply line). */
function bodyOfWhole(out: string): string {
  const text = out.replace(/^Accepted\.\n/, "");
  return text.slice(text.indexOf("\n") + 1, text.lastIndexOf("\n\nReply with knowledge_worker_submit"));
}

/** The parts of a task joined back: a line break between parts, none after a part that stops mid-line. */
function bodyOfParts(texts: readonly string[], parts: number): string {
  let body = "";
  texts.forEach((raw, i) => {
    const text = raw.replace(/^Accepted\.\n/, "");
    const marker = `Part ${i + 1} of ${parts}:\n\n`;
    const part = text.slice(text.indexOf(marker) + marker.length, text.lastIndexOf(`\n\nEnd of part ${i + 1} of ${parts}`));
    const midLine = i > 0 && texts[i - 1]!.includes(`(it stops mid-line: part ${i + 1} continues that line)`);
    body += (i === 0 || midLine ? "" : "\n") + part;
  });
  return body;
}

/** Resolves once `predicate` holds, re-checked on every broker change (never a sleep). */
function until(broker: InboxBroker, predicate: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    const check = (): void => {
      if (!predicate()) return;
      broker.events.off("change", check);
      resolve();
    };
    broker.events.on("change", check);
    check();
  });
}
