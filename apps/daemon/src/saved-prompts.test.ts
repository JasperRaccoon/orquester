import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  type EventMessage,
  type SavedPrompt
} from "@orquester/api";
import { Broadcaster } from "./broadcaster.ts";
import {
  SavedPromptError,
  SavedPromptsService,
  publishSavedPromptEvents
} from "./saved-prompts.ts";

type Logger = { warn: (...args: unknown[]) => void; error: (...args: unknown[]) => void };
const quiet: Logger = { warn: () => {}, error: () => {} };

interface Scratch {
  root: string;
  workspacesDir: string;
  file: string;
  /** A fresh service over the same file — a daemon restart. Not loaded. */
  service: (options?: { logger?: Logger }) => SavedPromptsService;
  /** `mkdir -p <workspaces>/<ws>/<name>`; answers the path as the client spells it. */
  project: (ws: string, name: string) => Promise<string>;
  cleanup: () => Promise<void>;
}

async function scratch(): Promise<Scratch> {
  const root = await mkdtemp(join(tmpdir(), "orquester-saved-prompts-"));
  const workspacesDir = join(root, "workspaces");
  await mkdir(workspacesDir, { recursive: true });
  const file = join(root, "daemon", "saved-prompts.json");
  return {
    root,
    workspacesDir,
    file,
    service: (options = {}) =>
      new SavedPromptsService({
        file,
        workspacesDir: () => workspacesDir,
        fsRoot: () => workspacesDir,
        logger: options.logger ?? quiet
      }),
    project: async (ws, name) => {
      const path = join(workspacesDir, ws, name);
      await mkdir(path, { recursive: true });
      return path;
    },
    cleanup: () => rm(root, { recursive: true, force: true })
  };
}

/** Write `saved-prompts.json` by hand (a file some earlier run left). */
async function writeLibrary(s: Scratch, content: unknown): Promise<void> {
  await mkdir(dirname(s.file), { recursive: true });
  await writeFile(s.file, typeof content === "string" ? content : JSON.stringify(content), "utf8");
}

/** A loaded service over an EMPTY library — past its first run, so nothing is seeded. */
async function emptyService(
  s: Scratch,
  options?: { logger?: Logger }
): Promise<SavedPromptsService> {
  await writeLibrary(s, { version: 1, prompts: [] });
  const service = s.service(options);
  await service.load();
  return service;
}

async function onDisk(s: Scratch): Promise<{ version: number; prompts: Array<Record<string, unknown>> }> {
  return JSON.parse(await readFile(s.file, "utf8"));
}

function clock(t: TestContext, startIso = "2026-09-27T10:00:00.000Z") {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(startIso) });
  return {
    advance: (ms = 60_000) => {
      t.mock.timers.tick(ms);
    },
    iso: () => new Date().toISOString()
  };
}

type Recorded = { type: "upserted"; prompt: SavedPrompt } | { type: "deleted"; id: string; projectPath: string | null };

function recordEvents(service: SavedPromptsService): Recorded[] {
  const events: Recorded[] = [];
  service.lifecycle.on("upserted", (prompt: SavedPrompt) => events.push({ type: "upserted", prompt }));
  service.lifecycle.on("deleted", (payload: { id: string; projectPath: string | null }) =>
    events.push({ type: "deleted", ...payload })
  );
  return events;
}

async function refuses(
  promise: Promise<unknown>,
  status: number,
  code: string
): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof SavedPromptError, `expected a SavedPromptError, got ${String(error)}`);
    assert.equal(error.status, status, error.message);
    assert.equal(error.code, code, error.message);
    return true;
  });
}

/** A valid on-disk record, as a build of this feature writes it. */
function storedRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "p-1",
    title: "Stored",
    description: "",
    body: "Do the thing",
    tags: [],
    projectPath: null,
    pinned: false,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    lastUsedAt: null,
    useCount: 0,
    ...overrides
  };
}

// --- First run / seeding --------------------------------------------------------

test("first-run starter prompts are usable global records persisted before mutation", async (t) => {
  const s = await scratch();
  t.after(s.cleanup);
  const service = s.service();
  await service.load();

  const prompts = await service.list(null);
  assert.ok(prompts.length > 0, "a new library includes starter prompts");
  assert.equal(new Set(prompts.map((prompt) => prompt.id)).size, prompts.length);
  for (const prompt of prompts) {
    assert.ok(prompt.title.trim() && prompt.body.trim(), "starters can be selected and inserted");
    assert.equal(prompt.projectPath, null);
    assert.equal(prompt.lastUsedAt, null);
    assert.equal(prompt.useCount, 0);
  }
  const written = await onDisk(s);
  assert.equal(written.version, 1);
  assert.deepEqual(written.prompts, prompts);
  assert.equal((await stat(s.file)).mode & 0o777, 0o600);
});

test("the starters are seeded once: after deleting them, restarts never bring them back", async (t) => {
  const s = await scratch();
  t.after(s.cleanup);
  const first = s.service();
  await first.load();
  for (const prompt of await first.list(null)) {
    await first.delete(prompt.id);
  }

  for (let boot = 0; boot < 2; boot++) {
    const restarted = s.service();
    await restarted.load();
    assert.deepEqual(await restarted.list(null), [], `boot ${boot + 2} must not re-seed`);
  }
  assert.deepEqual(await onDisk(s), { version: 1, prompts: [] });
});

// --- A file this build cannot use ------------------------------------------------

test("a corrupt file is moved aside byte for byte, and the library starts empty — not seeded", async (t) => {
  const s = await scratch();
  t.after(s.cleanup);
  await writeLibrary(s, "{ not json");
  clock(t, "2026-09-27T10:11:12.345Z");
  const service = s.service();
  await service.load();

  assert.deepEqual(await service.list(null), [], "nothing is seeded over a library that may hold the user's prompts");
  const aside = join(dirname(s.file), "saved-prompts.json.corrupt-2026-09-27T10-11-12-345Z");
  assert.equal(await readFile(aside, "utf8"), "{ not json", "the corrupt file is recoverable, untouched");
  // The empty library is written in its place — the file is the "seeded" marker,
  // so a restart must not seed the starters either.
  assert.deepEqual(await onDisk(s), { version: 1, prompts: [] });
  const restarted = s.service();
  await restarted.load();
  assert.deepEqual(await restarted.list(null), []);
});

test("an unknown version, or a file that is not a library at all, is treated as corrupt", async (t) => {
  for (const content of [
    { version: 2, prompts: [storedRecord()] },
    { version: 1, prompts: "all of them" },
    [storedRecord()],
    "null"
  ]) {
    const s = await scratch();
    t.after(s.cleanup);
    const raw = typeof content === "string" ? content : JSON.stringify(content);
    await writeLibrary(s, raw);
    const service = s.service();
    await service.load();
    assert.deepEqual(await service.list(null), [], `${raw}: starts empty, unseeded`);
    const names = await readdir(dirname(s.file));
    const aside = names.filter((name) => name.startsWith("saved-prompts.json.corrupt-"));
    assert.equal(aside.length, 1, `${raw}: moved aside`);
    assert.equal(await readFile(join(dirname(s.file), aside[0]), "utf8"), raw);
  }
});

test("a corrupt file that cannot be moved aside makes the library read-only", { skip: process.getuid?.() === 0 }, async (t) => {
  const s = await scratch();
  t.after(async () => {
    await chmod(dirname(s.file), 0o700).catch(() => undefined);
    await s.cleanup();
  });
  await writeLibrary(s, "{ not json");
  // A read-only directory: the file can be read but not renamed or replaced.
  await chmod(dirname(s.file), 0o500);
  const service = s.service();
  await service.load();

  // Even with the directory writable again, this run saves nothing — and says
  // so: a mutation is refused before it touches memory, never "saved" in memory only.
  await chmod(dirname(s.file), 0o700);
  const events = recordEvents(service);
  await refuses(
    service.create({ title: "T", body: "x", projectPath: null }),
    503,
    "SAVED_PROMPTS_UNAVAILABLE"
  );
  assert.deepEqual(await service.list(null), [], "nothing reached memory");
  assert.deepEqual(events, []);
  assert.equal(await readFile(s.file, "utf8"), "{ not json", "the original is untouched");
});

test("a file that cannot be READ is left where it is, and the library is read-only", async (t) => {
  const s = await scratch();
  t.after(s.cleanup);
  // A directory where the file should be: every read fails (EISDIR), for root too.
  await mkdir(s.file, { recursive: true });
  await writeFile(join(s.file, "keep.txt"), "the user's", "utf8");
  const service = s.service();
  await service.load();

  const events = recordEvents(service);
  assert.deepEqual(await service.list(null), [], "reads still answer: an empty library, not seeded");
  for (const mutation of [
    () => service.create({ title: "T", body: "x", projectPath: null }),
    () => service.update("any", { title: "x" }),
    () => service.markUsed("any"),
    () => service.delete("any")
  ]) {
    await refuses(mutation(), 503, "SAVED_PROMPTS_UNAVAILABLE");
  }
  // A cascade has nothing to remove, and must not fail the delete it follows.
  await service.deleteForProject(join(s.workspacesDir, "acme", "site"));
  await service.deleteForWorkspace(join(s.workspacesDir, "acme"));
  assert.deepEqual(events, []);

  assert.deepEqual(await readdir(dirname(s.file)), ["saved-prompts.json"], "not moved aside");
  assert.equal(await readFile(join(s.file, "keep.txt"), "utf8"), "the user's", "not written over");
});

test("an unreadable (permission-denied) library is never moved or replaced", { skip: process.getuid?.() === 0 }, async (t) => {
  const s = await scratch();
  t.after(async () => {
    await chmod(s.file, 0o600).catch(() => undefined);
    await s.cleanup();
  });
  const library = JSON.stringify({ version: 1, prompts: [storedRecord()] });
  await writeLibrary(s, library);
  await chmod(s.file, 0o000);
  const service = s.service();
  await service.load();

  await refuses(
    service.create({ title: "T", body: "x", projectPath: null }),
    503,
    "SAVED_PROMPTS_UNAVAILABLE"
  );
  await chmod(s.file, 0o600);
  assert.equal(await readFile(s.file, "utf8"), library, "a possibly-valid library stays exactly as it was");
  assert.deepEqual(await readdir(dirname(s.file)), ["saved-prompts.json"], "and where it was");
});

test("the tolerant read sets aside only the malformed prompts, and keeps what a newer build added", async (t) => {
  const s = await scratch();
  t.after(s.cleanup);
  const long = "x".repeat(120 * 4);
  await writeLibrary(s, {
    version: 1,
    prompts: [
      storedRecord({ id: "good", color: "teal" }),
      storedRecord({ id: "" }),
      storedRecord({ id: "bad-title", title: 42 }),
      storedRecord({ id: "bad-stamp", createdAt: "yesterday" }),
      "garbage",
      null,
      storedRecord({ id: "good", title: "A duplicate id keeps the first record" }),
      // Written before the optional fields existed: they default.
      { id: "minimal", title: "Minimal", body: "b", createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z" },
      // Shape is checked, never the editor's limits: another build's longer title survives.
      storedRecord({ id: "long", title: long })
    ]
  });
  const service = s.service();
  await service.load();

  const prompts = await service.list(null);
  assert.deepEqual(prompts.map((p) => p.id), ["good", "minimal", "long"]);
  assert.equal(prompts[0].title, "Stored", "the first record for a duplicated id wins");
  assert.deepEqual(
    { ...prompts[1] },
    {
      id: "minimal",
      title: "Minimal",
      description: "",
      body: "b",
      tags: [],
      projectPath: null,
      pinned: false,
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
      lastUsedAt: null,
      useCount: 0
    }
  );
  assert.equal(prompts[2].title, long);
  assert.deepEqual(
    (await readdir(dirname(s.file))).filter((name) => name.includes("corrupt")),
    [],
    "a partly bad file is not corrupt"
  );

  // A field this build does not know survives the next rewrite (a rollback must not erase it).
  await service.update("good", { pinned: true });
  const rewritten = (await onDisk(s)).prompts.find((p) => p.id === "good");
  assert.equal(rewritten?.color, "teal");
  assert.equal(rewritten?.pinned, true);
});

test("entries this build cannot read, and unknown top-level keys, survive every write untouched", async (t) => {
  const s = await scratch();
  t.after(s.cleanup);
  const site = await s.project("acme", "site");
  // A record in a newer shape (object tags), in a project a cascade will delete…
  const newer = storedRecord({ id: "newer", projectPath: site, tags: [{ name: "Review", color: "teal" }] });
  // …and a second record under an id the library already has (a hand edit).
  const duplicate = storedRecord({ id: "kept", title: "A second record under a used id" });
  const order = ["newer", "kept"];
  const layout = { collapsed: { pinned: false }, width: 320 };
  await writeLibrary(s, { version: 1, order, prompts: [storedRecord({ id: "kept" }), newer, duplicate], layout });
  const service = s.service();
  await service.load();
  assert.deepEqual((await service.list(site)).map((p) => p.id), ["kept"], "neither is listed");

  const untouched = async (step: string) => {
    const file = JSON.parse(await readFile(s.file, "utf8")) as {
      prompts: unknown[];
      order?: unknown;
      layout?: unknown;
    };
    assert.equal(JSON.stringify(file.order), JSON.stringify(order), `${step}: the unknown key "order"`);
    assert.equal(JSON.stringify(file.layout), JSON.stringify(layout), `${step}: the unknown key "layout"`);
    assert.deepEqual(
      file.prompts.slice(-2).map((entry) => JSON.stringify(entry)),
      [JSON.stringify(newer), JSON.stringify(duplicate)],
      `${step}: the unreadable entries, verbatim, after the library`
    );
  };

  const created = await service.create({ title: "New", body: "b", projectPath: null });
  await untouched("create");
  await service.update("kept", { pinned: true });
  await untouched("update");
  await service.markUsed(created.id);
  await untouched("markUsed");
  await service.delete(created.id);
  await untouched("delete");
  // The cascade cannot read the newer record, so it cannot know it is the project's: it stays.
  await service.deleteForProject(site);
  await untouched("cascade");
  assert.deepEqual(
    (await onDisk(s)).prompts.map((entry) => entry.id),
    ["kept", "newer", "kept"],
    "the library first, then what this build cannot read"
  );

  // And the next build that CAN read the newer shape still finds everything.
  const restarted = s.service();
  await restarted.load();
  await untouched("restart");
});

// --- Create / validation --------------------------------------------------------

test("create answers the whole record, writes it, and announces it", async (t) => {
  const s = await scratch();
  t.after(s.cleanup);
  const time = clock(t);
  const service = await emptyService(s);
  const events = recordEvents(service);

  const created = await service.create({
    title: "  Explain  ",
    body: "  Explain {project}\n\n",
    projectPath: null
  });
  assert.deepEqual(
    { ...created, id: "<id>" },
    {
      id: "<id>",
      title: "Explain",
      description: "",
      body: "  Explain {project}\n\n",
      tags: [],
      projectPath: null,
      pinned: false,
      createdAt: time.iso(),
      updatedAt: time.iso(),
      lastUsedAt: null,
      useCount: 0
    },
    "title trimmed; body kept exactly as written; defaults filled"
  );
  assert.deepEqual(events, [{ type: "upserted", prompt: created }]);
  assert.deepEqual((await onDisk(s)).prompts, [{ ...created }]);

  // An omitted projectPath is a global prompt too.
  const implicit = await service.create({ title: "No scope", body: "b" } as never);
  assert.equal(implicit.projectPath, null);
});

test("field limits are enforced with 400 INVALID_REQUEST", async (t) => {
  const s = await scratch();
  t.after(s.cleanup);
  const service = await emptyService(s);
  const base = { title: "T", body: "B", projectPath: null };
  const create = (overrides: Record<string, unknown>) => service.create({ ...base, ...overrides } as never);

  await refuses(service.create(null as never), 400, "INVALID_REQUEST");
  await refuses(service.create([] as never), 400, "INVALID_REQUEST");

  await refuses(create({ title: undefined }), 400, "INVALID_REQUEST");
  await refuses(create({ title: "   " }), 400, "INVALID_REQUEST");
  await refuses(
    create({ title: "t".repeat(120 + 1) }),
    400,
    "INVALID_REQUEST"
  );
  // The limit applies after trimming.
  assert.equal(
    (await create({ title: ` ${"t".repeat(120)} ` })).title.length,
    120
  );

  await refuses(create({ body: 7 }), 400, "INVALID_REQUEST");
  await refuses(create({ body: " \n\t " }), 400, "INVALID_REQUEST");
  await refuses(
    create({ body: "b".repeat(32_000 + 1) }),
    400,
    "INVALID_REQUEST"
  );
  assert.equal((await create({ body: "b".repeat(32_000) })).body.length, 32_000);

  await refuses(create({ description: null }), 400, "INVALID_REQUEST");
  await refuses(
    create({ description: "d".repeat(300 + 1) }),
    400,
    "INVALID_REQUEST"
  );
  assert.equal(
    (await create({ description: `  ${"d".repeat(300)}\n` })).description.length,
    300
  );

  await refuses(create({ pinned: "true" }), 400, "INVALID_REQUEST");
  assert.equal((await create({ pinned: true })).pinned, true);

  await refuses(create({ projectPath: 5 }), 400, "INVALID_PROJECT_PATH");
});

test("tags are trimmed, blanks dropped, deduplicated case-insensitively (first spelling), then limited", async (t) => {
  const s = await scratch();
  t.after(s.cleanup);
  const service = await emptyService(s);
  const withTags = (tags: unknown) => service.create({ title: "T", body: "B", projectPath: null, tags } as never);

  assert.deepEqual(
    (await withTags(["  Review ", "review", "", "   ", "Plan", "PLAN", "x"])).tags,
    ["Review", "Plan", "x"]
  );
  assert.deepEqual((await withTags([])).tags, []);

  const longest = "t".repeat(24);
  assert.deepEqual((await withTags([` ${longest} `])).tags, [longest]);
  await refuses(
    withTags([`${longest}t`]),
    400,
    "INVALID_REQUEST"
  );

  const six = Array.from({ length: 6 }, (_, i) => `tag${i}`);
  assert.deepEqual((await withTags(six)).tags, six);
  await refuses(withTags([...six, "one-more"]), 400, "INVALID_REQUEST");
  // Duplicates collapse BEFORE the count: seven spellings of six tags are fine.
  assert.deepEqual((await withTags([...six, "TAG0"])).tags, six);

  await refuses(withTags("Review"), 400, "INVALID_REQUEST");
  await refuses(withTags(["ok", 3]), 400, "INVALID_REQUEST");
});

test("a create past the library limit is a 409 SAVED_PROMPTS_FULL", async (t) => {
  const s = await scratch();
  t.after(s.cleanup);
  await writeLibrary(s, {
    version: 1,
    prompts: [
      ...Array.from({ length: 1_000 - 1 }, (_, i) => storedRecord({ id: `p-${i}` })),
      // What this build cannot read takes no slot: it is not in the library.
      "garbage",
      storedRecord({ id: "newer", tags: [{ name: "Review" }] })
    ]
  });
  const service = s.service();
  await service.load();
  const events = recordEvents(service);

  await service.create({ title: "The last slot", body: "b", projectPath: null });
  await refuses(
    service.create({ title: "One too many", body: "b", projectPath: null }),
    409,
    "SAVED_PROMPTS_FULL"
  );
  assert.equal(events.length, 1, "a refused create announces nothing");
  assert.equal((await onDisk(s)).prompts.length, 1_000 + 2, "the unreadable two are still in the file");

  await service.delete("p-0");
  await service.create({ title: "Room again", body: "b", projectPath: null });
});

// --- Update / used / delete -------------------------------------------------------

test("update changes only what the patch names, stamps updatedAt, and announces it", async (t) => {
  const s = await scratch();
  t.after(s.cleanup);
  const time = clock(t);
  const service = await emptyService(s);
  const project = await s.project("acme", "site");
  const original = await service.create({ title: "T", body: "B", tags: ["a"], projectPath: null });
  const events = recordEvents(service);

  time.advance();
  const updated = await service.update(original.id, { title: " Renamed ", tags: ["b", "B"], projectPath: project });
  assert.equal(updated.title, "Renamed");
  assert.deepEqual(updated.tags, ["b"]);
  assert.equal(updated.body, "B", "untouched");
  assert.equal(updated.projectPath, project, "moved into the project");
  assert.equal(updated.createdAt, original.createdAt);
  assert.equal(updated.updatedAt, time.iso());
  assert.deepEqual(events, [{ type: "upserted", prompt: updated }]);
  assert.equal(original.title, "T", "records are replaced, never mutated in place");

  // Back to global.
  time.advance();
  assert.equal((await service.update(original.id, { projectPath: null })).projectPath, null);

  // A patch that changes nothing is not an edit: same record, no stamp, no write, no event.
  const previousStamp = service.get(original.id)?.updatedAt;
  events.length = 0;
  time.advance();
  const unchanged = await service.update(original.id, { title: "Renamed", tags: ["b"], pinned: false });
  assert.equal(unchanged.updatedAt, previousStamp);
  assert.deepEqual(events, []);

  await refuses(service.update(original.id, { title: "" }), 400, "INVALID_REQUEST");
  await refuses(service.update(original.id, { projectPath: "/etc" }), 400, "INVALID_PROJECT_PATH");
  await refuses(service.update("nope", { title: "x" }), 404, "SAVED_PROMPT_NOT_FOUND");
  // An unknown id is a 404 even when the patch is also bad.
  await refuses(service.update("nope", { title: "" }), 404, "SAVED_PROMPT_NOT_FOUND");

  const reloaded = s.service();
  await reloaded.load();
  assert.equal(reloaded.get(original.id)?.title, "Renamed", "persisted");
});

test("marking a prompt used stamps lastUsedAt and counts, without touching updatedAt", async (t) => {
  const s = await scratch();
  t.after(s.cleanup);
  const time = clock(t);
  const service = await emptyService(s);
  const created = await service.create({ title: "T", body: "B", projectPath: null });
  const events = recordEvents(service);

  time.advance();
  const once = await service.markUsed(created.id);
  time.advance();
  const twice = await service.markUsed(created.id);
  assert.equal(once.useCount, 1);
  assert.equal(twice.useCount, 2);
  assert.equal(twice.lastUsedAt, time.iso());
  assert.equal(twice.updatedAt, created.updatedAt, "using a prompt is not editing it");
  assert.deepEqual(
    events.map((e) => e.type),
    ["upserted", "upserted"]
  );
  await refuses(service.markUsed("nope"), 404, "SAVED_PROMPT_NOT_FOUND");

  const reloaded = s.service();
  await reloaded.load();
  assert.equal(reloaded.get(created.id)?.useCount, 2, "persisted");
});

test("delete removes the prompt, writes, and announces its id and scope", async (t) => {
  const s = await scratch();
  t.after(s.cleanup);
  const service = await emptyService(s);
  const project = await s.project("acme", "site");
  const kept = await service.create({ title: "Kept", body: "B", projectPath: null });
  const gone = await service.create({ title: "Gone", body: "B", projectPath: project });
  const events = recordEvents(service);

  await service.delete(gone.id);
  assert.deepEqual(events, [{ type: "deleted", id: gone.id, projectPath: project }]);
  assert.deepEqual((await service.list(project)).map((p) => p.id), [kept.id]);
  assert.deepEqual((await onDisk(s)).prompts.map((p) => p.id), [kept.id]);
  await refuses(service.delete(gone.id), 404, "SAVED_PROMPT_NOT_FOUND");
});

test("overlapping mutations are all on disk, in their final state", async (t) => {
  const s = await scratch();
  t.after(s.cleanup);
  const service = await emptyService(s);
  const created = await Promise.all(
    Array.from({ length: 25 }, (_, i) => service.create({ title: `P${i}`, body: "B", projectPath: null }))
  );
  await Promise.all(created.slice(0, 10).map((p) => service.markUsed(p.id)));
  await Promise.all(created.slice(20).map((p) => service.delete(p.id)));

  const reloaded = s.service();
  await reloaded.load();
  const byId = new Map((await reloaded.list(null)).map((p) => [p.id, p]));
  assert.equal(byId.size, 20);
  for (const [i, prompt] of created.entries()) {
    if (i >= 20) {
      assert.equal(byId.has(prompt.id), false, `P${i} was deleted`);
    } else {
      assert.equal(byId.get(prompt.id)?.useCount, i < 10 ? 1 : 0, `P${i}`);
    }
  }
});

// --- Project scope ---------------------------------------------------------------

test("a project path must be <workspaces>/<workspace>/<project>, inside the sandbox, an existing directory", async (t) => {
  const s = await scratch();
  t.after(s.cleanup);
  const service = await emptyService(s);
  const site = await s.project("acme", "site");
  const outside = join(s.root, "outside", "proj");
  await mkdir(outside, { recursive: true });
  await writeFile(join(s.workspacesDir, "acme", "notes.md"), "not a project", "utf8");
  await symlink(outside, join(s.workspacesDir, "acme", "escape"));
  await symlink(site, join(s.workspacesDir, "acme", "alias"));

  // Accepted, and stored spelled the way the client spells the project (never the realpath).
  assert.equal(await service.resolveProjectPath(site), site);
  assert.equal(await service.resolveProjectPath(`${site}/`), site, "no trailing slash");
  assert.equal(await service.resolveProjectPath(join(s.workspacesDir, "acme", "x", "..", "site")), site);
  const alias = join(s.workspacesDir, "acme", "alias");
  assert.equal(await service.resolveProjectPath(alias), alias, "a symlink inside the sandbox keeps its own path");

  const rejected: unknown[] = [
    "acme/site",
    "",
    42,
    s.workspacesDir,
    join(s.workspacesDir, "acme"),
    join(site, "src"),
    outside,
    join(s.workspacesDir, "acme", "..", "..", "outside", "proj"),
    join(s.workspacesDir, "acme", ".git"),
    join(s.workspacesDir, "acme", "escape"),
    join(s.workspacesDir, "acme", "ghost"),
    join(s.workspacesDir, "acme", "notes.md"),
  ];
  for (const value of rejected) {
    await refuses(service.resolveProjectPath(value), 400, "INVALID_PROJECT_PATH");
    await refuses(
      service.create({ title: "T", body: "B", projectPath: value as string }),
      400,
      "INVALID_PROJECT_PATH"
    );
  }
  assert.deepEqual(await service.list(null), [], "no refused create stored anything");
});

test("list answers the global prompts plus the named project's own, and validates the project", async (t) => {
  const s = await scratch();
  t.after(s.cleanup);
  const service = await emptyService(s);
  const site = await s.project("acme", "site");
  const docs = await s.project("acme", "docs");
  const global = await service.create({ title: "Global", body: "B", projectPath: null });
  const mine = await service.create({ title: "Site", body: "B", projectPath: `${site}/` });
  await service.create({ title: "Docs", body: "B", projectPath: docs });

  assert.equal(mine.projectPath, site);
  assert.deepEqual((await service.list(null)).map((p) => p.id), [global.id]);
  assert.deepEqual(
    (await service.list(site)).map((p) => p.id),
    [global.id, mine.id]
  );
  await refuses(service.list(join(s.root, "outside")), 400, "INVALID_PROJECT_PATH");

  // A project that is gone is no longer a valid scope.
  await rm(site, { recursive: true, force: true });
  await refuses(service.list(site), 400, "INVALID_PROJECT_PATH");
});

test("deleting a project or a workspace takes its prompts along, announcing each one", async (t) => {
  const s = await scratch();
  t.after(s.cleanup);
  const service = await emptyService(s);
  const site = await s.project("acme", "site");
  const docs = await s.project("acme", "docs");
  const other = await s.project("other", "site");
  // A workspace whose name merely starts with "acme" is a different workspace.
  const lookalike = await s.project("acme2", "site");
  const global = await service.create({ title: "Global", body: "B", projectPath: null });
  const siteA = await service.create({ title: "Site A", body: "B", projectPath: site });
  const siteB = await service.create({ title: "Site B", body: "B", projectPath: site });
  const docsA = await service.create({ title: "Docs", body: "B", projectPath: docs });
  const otherA = await service.create({ title: "Other", body: "B", projectPath: other });
  const lookalikeA = await service.create({ title: "Lookalike", body: "B", projectPath: lookalike });
  const events = recordEvents(service);

  await service.deleteForProject(site);
  assert.deepEqual(events, [
    { type: "deleted", id: siteA.id, projectPath: site },
    { type: "deleted", id: siteB.id, projectPath: site }
  ]);
  assert.deepEqual(
    (await onDisk(s)).prompts.map((p) => p.id),
    [global.id, docsA.id, otherA.id, lookalikeA.id]
  );

  events.length = 0;
  await service.deleteForWorkspace(join(s.workspacesDir, "acme"));
  assert.deepEqual(events, [{ type: "deleted", id: docsA.id, projectPath: docs }]);

  events.length = 0;
  await service.deleteForProject(site);
  await service.deleteForWorkspace(join(s.workspacesDir, "nothing-here"));
  assert.deepEqual(events, [], "a cascade with nothing to remove announces nothing");

  const reloaded = s.service();
  await reloaded.load();
  assert.deepEqual(
    [...(await reloaded.list(null)), ...(await reloaded.list(other)), ...(await reloaded.list(lookalike))]
      .map((p) => p.id)
      .filter((id, i, all) => all.indexOf(id) === i),
    [global.id, otherA.id, lookalikeA.id]
  );
});

// --- The bus ------------------------------------------------------------------------

test("upserts and deletions reach the /events bus on the saved-prompts channel", async (t) => {
  const s = await scratch();
  t.after(s.cleanup);
  const service = await emptyService(s);
  const broadcaster = new Broadcaster();
  const seen: EventMessage[] = [];
  broadcaster.add({ send: (data) => seen.push(JSON.parse(data) as EventMessage) });
  publishSavedPromptEvents(service, broadcaster);

  const created = await service.create({ title: "T", body: "B", projectPath: null });
  await service.delete(created.id);

  assert.deepEqual(
    seen.map((event) => ({ channel: event.channel, type: event.type, payload: event.payload })),
    [
      { channel: "saved-prompts", type: "savedPrompt.upserted", payload: created },
      { channel: "saved-prompts", type: "savedPrompt.deleted", payload: { id: created.id, projectPath: null } }
    ]
  );
});
