import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { FakeClock, flushAsync } from "../../workflows/agent/testing/fake-clock.ts";
import { clearAnsweredTasks, clearUnansweredTasks, InboxBroker, nodeInboxFiles, parseWorkerAnswer, type InboxBrokerOptions, type InboxFiles } from "./inbox.ts";

const roots: string[] = [];
after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

function taskId(system: string, user: string, ctx: string): string {
  return createHash("sha256").update(`${system}\n--user--\n${user}\n--ctx--\n${ctx}`).digest("hex");
}

interface Harness {
  dir: string;
  inbox: string;
  outbox: string;
  clock: FakeClock;
  broker: InboxBroker;
  ops: string[];
  /** Writes a task the way myKG does (temp + rename). */
  addTask(system: string, user: string, step?: string, createdAt?: string): Promise<string>;
}

async function harness(
  options: {
    budget?: { tasks: number; tokens: number };
    nextWaitMs?: number;
    contextFor?: InboxBrokerOptions["contextFor"];
    validate?: InboxBrokerOptions["validate"];
  } = {}
): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "orq-inbox-"));
  roots.push(dir);
  const inbox = join(dir, "agent_inbox");
  const outbox = join(dir, "agent_outbox");
  const ops: string[] = [];
  const files: InboxFiles = {
    ...nodeInboxFiles,
    writeFile: async (path, text) => {
      ops.push(`write ${path.slice(outbox.length + 1).replace(/\.[0-9a-f-]{36}\.tmp$/, ".tmp")}`);
      await nodeInboxFiles.writeFile(path, text);
    },
    rename: async (from, to) => {
      ops.push(`rename ${to.slice(outbox.length + 1)}`);
      await nodeInboxFiles.rename(from, to);
    }
  };
  const clock = new FakeClock("2026-10-23T10:00:00.000Z");
  const broker = new InboxBroker({ clock, files, watch: null, ...options });
  await broker.attach(dir);
  let n = 0;
  return {
    dir,
    inbox,
    outbox,
    clock,
    broker,
    ops,
    async addTask(system, user, step = "pass2", createdAt) {
      const ctx = `${step} ${n}`;
      const id = taskId(system, user, ctx);
      const envelope = {
        task_id: id,
        step,
        context_label: ctx,
        system,
        user,
        max_tokens: 32000,
        timeout_seconds: 172800,
        created_at: createdAt ?? `2026-10-23T10:00:${String(n).padStart(2, "0")}.000Z`
      };
      n += 1;
      await writeFile(join(inbox, `${id}.task.json.tmp`), JSON.stringify(envelope));
      await rename(join(inbox, `${id}.task.json.tmp`), join(inbox, `${id}.task.json`));
      return id;
    }
  };
}

/** Resolves once `count` chats are parked in `next` (the broker announces every wait). */
function untilWaiting(broker: InboxBroker, count: number): Promise<void> {
  return new Promise((resolve) => {
    const check = (): void => {
      if (broker.counts().waiting < count) return;
      broker.events.off("change", check);
      resolve();
    };
    broker.events.on("change", check);
    check();
  });
}

/** Ends the run once `promise` is parked waiting for the next task (a submit's answer long-polls). */
async function finishing<T>(h: Harness, promise: Promise<T>): Promise<T> {
  await flushAsync();
  h.broker.finish("run-finished");
  return promise;
}

describe("parseWorkerAnswer", () => {
  it("accepts JSON, trimmed, with or without a ```json fence", () => {
    assert.deepEqual(parseWorkerAnswer('  {"nodes":[],"edges":[]}\n'), { ok: true, text: '{"nodes":[],"edges":[]}' });
    assert.deepEqual(parseWorkerAnswer('```json\n{"a":1}\n```'), { ok: true, text: '{"a":1}' });
    assert.deepEqual(parseWorkerAnswer("```\n[1, 2]\n```"), { ok: true, text: "[1, 2]" });
  });

  it("refuses prose, half JSON and bare values with the parse error", () => {
    const prose = parseWorkerAnswer("Here is the JSON: {\"a\": 1}");
    assert.equal(prose.ok, false);
    if (!prose.ok) assert.match(prose.error, /not valid JSON/);
    assert.equal(parseWorkerAnswer('{"a": ').ok, false);
    assert.equal(parseWorkerAnswer('"just a string"').ok, false);
    assert.equal(parseWorkerAnswer("   ").ok, false);
  });
});

describe("InboxBroker", () => {
  it("sends a step's instructions once per chat, then points at the task they came with", async () => {
    const h = await harness();
    const a = await h.addTask("SYSTEM-PASS2", "entry A");
    const b = await h.addTask("SYSTEM-PASS2", "entry B");
    const first = await h.broker.next("w1");
    assert.equal(first.kind, "task");
    if (first.kind !== "task") return;
    assert.equal(first.task.taskId, a);
    assert.equal(first.task.instructions, "SYSTEM-PASS2");
    assert.equal(first.task.sameInstructionsAs, null);
    assert.equal(first.task.input, "entry A");
    const second = await h.broker.submit("w1", a, '{"nodes":[],"edges":[]}');
    assert.equal(second.accepted, true);
    if (!second.accepted || second.next.kind !== "task") return assert.fail("expected the next task in the submit answer");
    assert.equal(second.next.task.taskId, b);
    assert.equal(second.next.task.instructions, null);
    assert.equal(second.next.task.sameInstructionsAs, a);
    // Another chat gets the instructions in full the first time it sees them.
    const c = await h.addTask("SYSTEM-PASS2", "entry C");
    const other = await h.broker.next("w2");
    assert.equal(other.kind === "task" && other.task.taskId, c);
    assert.equal(other.kind === "task" && other.task.instructions, "SYSTEM-PASS2");
    // Different instructions are sent in full.
    const d = await h.addTask("SYSTEM-NORMALIZE", "names", "normalize_names");
    const submitted = await h.broker.submit("w1", b, "{}");
    const next = submitted.accepted ? submitted.next : null;
    assert.equal(next?.kind === "task" && next.task.taskId, d);
    assert.equal(next?.kind === "task" && next.task.instructions, "SYSTEM-NORMALIZE");
  });

  it("refuses an answer that does not parse and keeps the task with the chat to redo it", async () => {
    const h = await harness();
    const a = await h.addTask("S", "A");
    await h.broker.next("w1");
    const refused = await h.broker.submit("w1", a, "I could not find any concepts.");
    assert.equal(refused.accepted, false);
    if (!refused.accepted) assert.match(refused.error, /not valid JSON.*submit it again/s);
    assert.deepEqual(await readdir(h.outbox), [], "nothing reached myKG");
    const again = await h.broker.next("w1");
    assert.equal(again.kind === "task" && again.task.taskId, a, "the same task comes back");
    const ok = await finishing(h, h.broker.submit("w1", a, '```json\n{"nodes":[]}\n```'));
    assert.deepEqual(ok, { accepted: true, next: { kind: "done", reason: "run-finished" } });
    assert.deepEqual(JSON.parse(await readFile(join(h.outbox, `${a}.answer.json`), "utf8")), { task_id: a, answer: '{"nodes":[]}' });
  });

  it("writes the answer (temp + rename) strictly before the .done marker", async () => {
    const h = await harness();
    const a = await h.addTask("S", "A");
    await h.broker.next("w1");
    await finishing(h, h.broker.submit("w1", a, '{"x":1}'));
    assert.deepEqual(h.ops, [`write ${a}.answer.json.tmp`, `rename ${a}.answer.json`, `write ${a}.done.tmp`, `rename ${a}.done`]);
    assert.equal(await readFile(join(h.outbox, `${a}.done`), "utf8"), "");
  });

  it("leases a task to one chat and hands a released chat's task to the next asker", async () => {
    const h = await harness();
    const a = await h.addTask("S", "A");
    const b = await h.addTask("S", "B");
    const one = await h.broker.next("w1");
    const two = await h.broker.next("w2");
    assert.equal(one.kind === "task" && one.task.taskId, a);
    assert.equal(two.kind === "task" && two.task.taskId, b);
    // Asking again re-serves the lease rather than taking another task.
    const repeat = await h.broker.next("w1");
    assert.equal(repeat.kind === "task" && repeat.task.taskId, a);
    h.broker.release("w1");
    const taken = await h.broker.next("w3");
    assert.equal(taken.kind === "task" && taken.task.taskId, a, "the dead chat's task goes to the next one");
    assert.deepEqual(await h.broker.next("w1"), { kind: "done", reason: "session-budget" }, "a released chat gets no more work");
  });

  it("an answer already given (by another chat) is accepted without a second write", async () => {
    const h = await harness();
    const a = await h.addTask("S", "A");
    await h.broker.next("w1");
    h.broker.release("w1");
    await h.broker.next("w2");
    await finishing(h, h.broker.submit("w2", a, "{}"));
    const late = await h.broker.submit("w1", a, '{"late":true}');
    assert.equal(late.accepted, true);
    assert.deepEqual(JSON.parse(await readFile(join(h.outbox, `${a}.answer.json`), "utf8")).answer, "{}");
  });

  it("skips tasks myKG already has answers for (a resumed run)", async () => {
    const h = await harness();
    const a = await h.addTask("S", "A");
    const b = await h.addTask("S", "B");
    await mkdir(h.outbox, { recursive: true });
    await writeFile(join(h.outbox, `${a}.answer.json`), JSON.stringify({ task_id: a, answer: "{}" }));
    await writeFile(join(h.outbox, `${a}.done`), "");
    const fresh = new InboxBroker({ clock: h.clock, watch: null });
    await fresh.attach(h.dir);
    const next = await fresh.next("w1");
    assert.equal(next.kind === "task" && next.task.taskId, b);
  });

  it("answers a name-normalization task from an earlier answer to the very same prompt, whatever its batch label", async () => {
    const h = await harness();
    const system = "NORMALIZE-SYSTEM";
    const names = JSON.stringify({ Person: ["Alice", "Alice Smith"] });
    const first = await h.addTask(system, names, "normalize_names");
    const taken = await h.broker.next("w1");
    assert.equal(taken.kind === "task" && taken.task.taskId, first);
    await finishing(h, h.broker.submit("w1", first, '{"Person":{"Alice":"Alice Smith"}}'));

    // The next run: the same names, but the batch moved (`normalize_names batch 2/3`): no chat is asked.
    const run2 = new InboxBroker({ clock: h.clock, watch: null });
    await run2.attach(h.dir);
    const moved = await h.addTask(system, names, "normalize_names");
    const other = await h.addTask(system, JSON.stringify({ Tool: ["Notion", "notion.so"] }), "normalize_names");
    const pass2 = await h.addTask(system, names, "pass2");
    await run2.rescan();
    assert.deepEqual(JSON.parse(await readFile(join(h.outbox, `${moved}.answer.json`), "utf8")), { task_id: moved, answer: '{"Person":{"Alice":"Alice Smith"}}' });
    assert.equal((await readdir(h.outbox)).includes(`${moved}.done`), true);
    assert.equal(run2.counts().pending, 2, "a changed name list, and any other step, still go to a chat");
    const next = await run2.next("w2");
    assert.ok(next.kind === "task" && [other, pass2].includes(next.task.taskId));
    assert.equal(run2.counts().answered, 0, "a reused answer is no chat's work");
  });

  it("retires a chat at its task budget", async () => {
    const h = await harness({ budget: { tasks: 2, tokens: 1_000_000 } });
    const ids = [await h.addTask("S", "A"), await h.addTask("S", "B"), await h.addTask("S", "C")];
    await h.broker.next("w1");
    await h.broker.submit("w1", ids[0]!, "{}");
    const last = await h.broker.submit("w1", ids[1]!, "{}");
    assert.deepEqual(last, { accepted: true, next: { kind: "done", reason: "session-budget" } });
    assert.equal(h.broker.tasksOf("w1"), 2);
    const fresh = await h.broker.next("w2");
    assert.equal(fresh.kind === "task" && fresh.task.taskId, ids[2]);
  });

  it("retires a chat whose context estimate passed the token budget", async () => {
    const h = await harness({ budget: { tasks: 100, tokens: 100 } });
    const a = await h.addTask("S".repeat(200), "A");
    await h.addTask("S".repeat(200), "B");
    await h.broker.next("w1");
    const answer = await h.broker.submit("w1", a, JSON.stringify({ text: "x".repeat(300) }));
    assert.deepEqual(answer, { accepted: true, next: { kind: "done", reason: "session-budget" } });
  });

  it("holds a call until a task appears, and says done when the run ends", async () => {
    const h = await harness();
    const waiting = h.broker.next("w1");
    await untilWaiting(h.broker, 1);
    assert.equal(h.broker.counts().waiting, 1);
    const id = await h.addTask("S", "late");
    await h.broker.rescan();
    const got = await waiting;
    assert.equal(got.kind === "task" && got.task.taskId, id);
    const parked = h.broker.next("w2");
    await flushAsync();
    h.broker.finish("run-finished");
    assert.deepEqual(await parked, { kind: "done", reason: "run-finished" });
    assert.deepEqual(await h.broker.next("w3"), { kind: "done", reason: "run-finished" });
  });

  it("wakes a waiting chat from the inbox watcher (fs.watch), no rescan asked", { timeout: 20_000 }, async () => {
    const h = await harness();
    const watched = new InboxBroker({ clock: h.clock });
    await watched.attach(h.dir);
    const waiting = watched.next("w1");
    await flushAsync();
    const id = await h.addTask("S", "seen by the watcher");
    const got = await waiting;
    assert.equal(got.kind === "task" && got.task.taskId, id);
    watched.dispose();
  });

  it("a broker disposed while it is still attaching (the run ended at once) opens no watcher", async () => {
    const h = await harness();
    let open = 0;
    const broker = new InboxBroker({
      clock: h.clock,
      watch: () => {
        open += 1;
        return { close: () => void (open -= 1) };
      }
    });
    const attaching = broker.attach(join(h.dir, "late"));
    broker.dispose();
    await attaching;
    assert.equal(open, 0, "no fs watcher outlives the run");
  });

  it("retires a chat that waited the whole long-poll with nothing to do", async () => {
    const h = await harness({ nextWaitMs: 60_000 });
    const waiting = h.broker.next("w1");
    await h.clock.advance(60_000);
    assert.deepEqual(await waiting, { kind: "done", reason: "session-budget" });
    assert.equal(h.broker.counts().waiting, 0);
  });

  it("answers run-cancelled once cancelled, and refuses an unknown task", async () => {
    const h = await harness();
    assert.equal((await h.broker.submit("w1", "nope", "{}")).accepted, false);
    h.broker.finish("run-cancelled");
    assert.deepEqual(await h.broker.next("w1"), { kind: "done", reason: "run-cancelled" });
  });

  it("counts demand as the pending tasks no waiting chat will take", async () => {
    const h = await harness();
    await h.addTask("S", "A");
    await h.addTask("S", "B");
    await h.broker.rescan();
    assert.equal(h.broker.demand(), 2);
    await h.broker.next("w1");
    assert.equal(h.broker.demand(), 1);
    assert.equal(h.broker.engaged("w1"), true);
    assert.equal(h.broker.engaged("w9"), false);
  });
});

describe("InboxBroker — what a worker is shown (phase 2 neighbour context)", () => {
  it("adds the context after myKG's prompt for the tasks it is given for; the task file, its id and the answer's path stay myKG's", async () => {
    const asked: string[] = [];
    const block = "KNOWN CONCEPTS FROM SIMILAR ENTRIES\n===================================\n- Tactic: Alternatives pages";
    const h = await harness({
      contextFor: async (envelope) => {
        asked.push(envelope.step);
        return envelope.step === "pass2" ? block : null;
      }
    });
    const user = "SCHEMA\n======\n...\n\nDOCUMENT\n========\nAlternatives pages convert well.";
    const pass2 = await h.addTask("PASS2", user, "pass2");
    const pass1 = await h.addTask("PASS1", "corpus", "pass1");
    assert.equal(pass2, taskId("PASS2", user, "pass2 0"), "myKG's task id (prompt + label)");
    const taskFile = await readFile(join(h.inbox, `${pass2}.task.json`), "utf8");

    const first = await h.broker.next("w1");
    assert.ok(first.kind === "task" && first.task.taskId === pass2);
    assert.equal(first.task.input, `${user}\n\n${block}`, "the block comes after the document");
    const held = await h.broker.next("w1");
    assert.ok(held.kind === "task" && held.task.input === first.task.input, "a held task shows the same view");
    const second = await h.broker.submit("w1", pass2, '{"nodes":[],"edges":[]}');
    assert.ok(second.accepted && second.next.kind === "task" && second.next.task.taskId === pass1);
    assert.equal(second.next.task.input, "corpus", "no block for another step");
    assert.deepEqual(asked, ["pass2", "pass1"], "the context is built once per task");

    assert.equal(await readFile(join(h.inbox, `${pass2}.task.json`), "utf8"), taskFile, "the task file is untouched");
    const answer = JSON.parse(await readFile(join(h.outbox, `${pass2}.answer.json`), "utf8")) as { task_id: string };
    assert.equal(answer.task_id, pass2, "answered under myKG's id: its cache key is unchanged");
    await readFile(join(h.outbox, `${pass2}.done`), "utf8");
    await finishing(h, h.broker.submit("w1", pass1, "{}"));
  });

  it("a context that fails costs only the context", async () => {
    const h = await harness({
      contextFor: async () => {
        throw new Error("index gone");
      }
    });
    const id = await h.addTask("S", "u");
    const reply = await h.broker.next("w1");
    assert.ok(reply.kind === "task" && reply.task.taskId === id && reply.task.input === "u");
  });

  it("a step's own check refuses JSON that does not fit it, like an answer that does not parse", async () => {
    const h = await harness({
      validate: (step, value) => (step === "pair-check" && !(value !== null && typeof value === "object" && "verdict" in value) ? '"verdict" is missing.' : null)
    });
    const id = await h.addTask("S", "u", "pair-check");
    await h.broker.next("w1");
    const refused = await h.broker.submit("w1", id, '{"x":1}');
    assert.equal(refused.accepted, false);
    assert.match(!refused.accepted ? refused.error : "", /"verdict" is missing\./);
    assert.deepEqual(await readdir(h.outbox), [], "nothing written for a refused answer");
    const answered: { step: string; answer: string }[] = [];
    h.broker.events.on("answered", (event) => answered.push({ step: event.step, answer: event.answer }));
    const ok = await finishing(h, h.broker.submit("w1", id, '{"verdict":"consistent","note":"same"}'));
    assert.equal(ok.accepted, true);
    assert.deepEqual(answered, [{ step: "pair-check", answer: '{"verdict":"consistent","note":"same"}' }], "the answer travels with the event");
  });
});

describe("clearAnsweredTasks", () => {
  it("removes the matching answered tasks (.done first, then answer and task), and nothing else", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orq-inbox-clear-"));
    roots.push(dir);
    const inbox = join(dir, "agent_inbox");
    const outbox = join(dir, "agent_outbox");
    await mkdir(inbox, { recursive: true });
    await mkdir(outbox, { recursive: true });
    const mine = taskId("S", "DOCUMENT mine", "pass2 chunk 1");
    const other = taskId("S", "DOCUMENT other", "pass2 chunk 2");
    for (const [id, user] of [[mine, "DOCUMENT mine"], [other, "DOCUMENT other"]] as const) {
      await writeFile(join(inbox, `${id}.task.json`), JSON.stringify({ task_id: id, step: "pass2", system: "S", user }));
      await writeFile(join(outbox, `${id}.answer.json`), JSON.stringify({ task_id: id, answer: "{}" }));
      await writeFile(join(outbox, `${id}.done`), "");
    }
    await writeFile(join(inbox, "not-a-task.json"), "x");
    const removed = await clearAnsweredTasks(dir, (envelope) => envelope.user.endsWith("mine"));
    assert.deepEqual(removed, [mine]);
    assert.deepEqual((await readdir(inbox)).sort(), [`${other}.task.json`, "not-a-task.json"].sort());
    assert.deepEqual((await readdir(outbox)).sort(), [`${other}.answer.json`, `${other}.done`].sort());
    assert.deepEqual(await clearAnsweredTasks(join(dir, "missing"), () => true), []);
  });
});

describe("clearUnansweredTasks", () => {
  it("removes the task files no answer was written for, and keeps every answer (the cache) and answered task", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orq-inbox-clear-"));
    roots.push(dir);
    const inbox = join(dir, "agent_inbox");
    const outbox = join(dir, "agent_outbox");
    await mkdir(inbox, { recursive: true });
    await mkdir(outbox, { recursive: true });
    const answered = taskId("S", "answered", "pass2 0");
    const waiting = taskId("S", "waiting", "pass2 1");
    const torn = taskId("S", "torn", "pass2 2");
    for (const id of [answered, waiting, torn]) await writeFile(join(inbox, `${id}.task.json`), JSON.stringify({ task_id: id, system: "S", user: "u" }));
    await writeFile(join(outbox, `${answered}.answer.json`), JSON.stringify({ task_id: answered, answer: "{}" }));
    await writeFile(join(outbox, `${answered}.done`), "");
    // An answer written without its `.done` (a crash between the two renames): myKG never read it.
    await writeFile(join(outbox, `${torn}.answer.json`), JSON.stringify({ task_id: torn, answer: "{}" }));
    await writeFile(join(dir, "orquester-answer-reuse.ndjson"), "");

    const removed = await clearUnansweredTasks(dir);
    assert.deepEqual(removed.sort(), [waiting, torn].sort());
    assert.deepEqual(await readdir(inbox), [`${answered}.task.json`]);
    assert.deepEqual((await readdir(outbox)).sort(), [`${answered}.answer.json`, `${answered}.done`, `${torn}.answer.json`].sort());
    assert.deepEqual(await readdir(dir).then((names) => names.sort()), ["agent_inbox", "agent_outbox", "orquester-answer-reuse.ndjson"]);
  });

  it("a session without an inbox yet clears nothing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orq-inbox-clear-"));
    roots.push(dir);
    assert.deepEqual(await clearUnansweredTasks(join(dir, "missing")), []);
  });
});
