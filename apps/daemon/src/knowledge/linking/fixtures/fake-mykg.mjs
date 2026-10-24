// A stand-in for `mykg extract-graph` (myKG 0.4.10) for the linking tests. It speaks the same
// filesystem protocol as myKG's agent provider (`llm/agent_adapter.py`) and the same CLI surface
// (`cli.py`): session creation and the `Session: <name>` line, `--session` / `--update` /
// `--append-with-grow-schema`, the input mirror, `pipeline_state.json` (top-level status always
// "running"), `pass2_progress.json`, task files written temp + rename and answered through
// `<id>.answer.json` + `<id>.done` (an answered task is reused, never asked again), one Pass 2 task
// per input file (`batch_per_file`), and `output/nodes.jsonl` / `output/edges.jsonl`.
//
// Ingest follows myKG's own bookkeeping (verified against the installed 0.4.10, `step_ingest.py`,
// `orchestrator.py`, `step_pass2.py`): `intermediate/file_manifest.json` is the corpus. A full run
// writes it once (a resumed full run skips ingest). An `--update` compares the mirror with it,
// REWRITES it right away (new hashes in, deleted entries out), then deletes the graph outputs and,
// in Pass 2, evicts the changed and deleted entries' shards before extracting the changed ones; a
// file the manifest lists but `raw_extractions.json` does not is extracted too. An update that finds
// nothing to do touches nothing and exits 0. So an update that dies after its ingest leaves a
// manifest that already "has" its edits: the next `--update` sees no change, and the evicted
// entries are lost (and with no change, no graph is written either).
//
// Behaviour is steered by `./fake-mykg.json` in the cwd (the myKG dir); every invocation is
// appended to `./fake-mykg.log` (argv and env) so tests can check what the runner passed.
//
// The answer polling below is the CHILD's (it emulates myKG's own 1 s poll); the tests never sleep.

import { createHash } from "node:crypto";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const control = existsSync("fake-mykg.json") ? JSON.parse(readFileSync("fake-mykg.json", "utf8")) : {};
appendFileSync("fake-mykg.log", `${JSON.stringify({ argv, env: process.env })}\n`);

if (!existsSync("mykg_config.yaml")) {
  process.stderr.write("FileNotFoundError: mykg_config.yaml not found.\n");
  process.exit(1);
}
if (argv[0] !== "extract-graph" || !argv[1]) {
  process.stderr.write("Usage: mykg extract-graph INPUT_DIR\n");
  process.exit(2);
}
const inputDir = argv[1];
const flag = (name) => argv.includes(name);
const option = (name) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};
const update = flag("--update");
const grow = flag("--append-with-grow-schema");
const append = update || grow;
let session = option("--session");
const sessionsRoot = "mykg_sessions";

if (session) {
  if (!existsSync(join(sessionsRoot, session))) {
    process.stderr.write(`Error: Session '${session}' not found at ${join(sessionsRoot, session)}. Omit --session to start a new run.\n`);
    process.exit(1);
  }
} else {
  session = control.sessionName ?? new Date().toISOString().slice(0, 19).replace(/:/g, "-");
  while (existsSync(join(sessionsRoot, session))) session = `${session}-1`;
  for (const sub of ["output", "intermediate", "input"]) mkdirSync(join(sessionsRoot, session, sub), { recursive: true });
  process.stdout.write(`Session: ${session}\n`);
}

const root = join(sessionsRoot, session);
const intermediate = join(root, "intermediate");
const output = join(root, "output");
const mirror = join(root, "input");
const inbox = join(intermediate, "agent_inbox");
const outbox = join(intermediate, "agent_outbox");
mkdirSync(inbox, { recursive: true });
mkdirSync(outbox, { recursive: true });

if (append && !existsSync(join(intermediate, "schema.json"))) {
  process.stderr.write(`RuntimeError: No existing pipeline found in ${intermediate}. Run without --append first.\n`);
  process.exit(1);
}

const STEPS = ["preprocess", "ingest", "pass1", "schema_validate", "human_review", "schema_flatten", "pass2", "normalize_names", "assemble", "orphan_score", "orphan_connect", "validate_graph"];
const statePath = join(intermediate, "pipeline_state.json");
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { steps: {}, errors: {} };
for (const step of STEPS) state.steps[step] ??= { status: "pending" };
const saveState = () => writeFileSync(statePath, JSON.stringify({ status: "running", started_at: "x", last_updated: new Date().toISOString(), steps: state.steps, errors: state.errors }, null, 2));
const mark = (step, status) => {
  state.steps[step] = { status };
  saveState();
};

// Input mirror: copy every .md; prune deleted ones on --update (--sync).
const files = readdirSync(inputDir).filter((name) => name.endsWith(".md")).sort();
for (const name of files) copyFileSync(join(inputDir, name), join(mirror, name));
if (update) for (const name of readdirSync(mirror)) if (!files.includes(name)) rmSync(join(mirror, name));

const sha = (text) => createHash("sha256").update(text).digest("hex");
const taskId = (system, user, ctx) => sha(`${system}\n--user--\n${user}\n--ctx--\n${ctx}`);

async function complete(step, system, user, ctx) {
  const id = taskId(system, user, ctx);
  const done = join(outbox, `${id}.done`);
  const answerPath = join(outbox, `${id}.answer.json`);
  if (!(existsSync(done) && existsSync(answerPath))) {
    const task = { task_id: id, step, context_label: ctx, system, user, max_tokens: 32000, timeout_seconds: 172800, created_at: new Date().toISOString() };
    const path = join(inbox, `${id}.task.json`);
    writeFileSync(`${path}.tmp`, JSON.stringify(task, null, 2));
    renameSync(`${path}.tmp`, path);
    while (!existsSync(done)) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const envelope = JSON.parse(readFileSync(answerPath, "utf8"));
  if (envelope.task_id !== id) throw new Error(`answer for the wrong task: ${envelope.task_id}`);
  return JSON.parse(envelope.answer);
}

async function main() {
  const shardDir = join(intermediate, "raw_extractions_shards");
  mkdirSync(shardDir, { recursive: true });
  const manifestPath = join(intermediate, "file_manifest.json");
  const extractedPath = join(intermediate, "raw_extractions.json");
  const readJson = (path, fallback) => (existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : fallback);
  const hashes = Object.fromEntries(files.map((name) => [name, sha(readFileSync(join(mirror, name), "utf8"))]));
  mark("preprocess", "done");

  let todo;
  let evict = [];
  if (append) {
    const manifest = readJson(manifestPath, {});
    const extracted = new Set(readJson(extractedPath, []));
    const changed = new Set(files.filter((name) => manifest[name] !== hashes[name]));
    const deleted = Object.keys(manifest).filter((name) => !files.includes(name));
    for (const name of Object.keys(manifest)) if (!extracted.has(name) && name in hashes) changed.add(name);
    writeFileSync(manifestPath, JSON.stringify(hashes));
    mark("ingest", "done");
    if (changed.size === 0 && deleted.length === 0) {
      for (const step of STEPS) if (state.steps[step].status !== "done") mark(step, "done");
      return;
    }
    for (const out of ["nodes.jsonl", "edges.jsonl"]) rmSync(join(output, out), { force: true });
    for (const step of STEPS.slice(STEPS.indexOf("pass2"))) state.steps[step] = { status: "pending" };
    saveState();
    todo = [...changed].sort();
    evict = [...changed, ...deleted];
  } else {
    if (!existsSync(manifestPath)) writeFileSync(manifestPath, JSON.stringify(hashes));
    mark("ingest", "done");
    todo = Object.keys(readJson(manifestPath, {})).filter((name) => !existsSync(join(shardDir, `${name}.json`))).sort();
  }

  if (!append && !existsSync(join(intermediate, "schema.json"))) {
    mark("pass1", "running");
    const schema = await complete("pass1", control.pass1System ?? "PASS1-SYSTEM", `CORPUS ${files.join(",")}`, "pass1 batch 0/1");
    writeFileSync(join(intermediate, "schema.json"), JSON.stringify(schema));
    mark("pass1", "done");
  } else if (grow) {
    mark("pass1", "running");
    await complete("pass1", "PASS1-GROW-SYSTEM", `GROW ${files.join(",")}`, "pass1 locked");
    mark("pass1", "done");
  }

  mark("pass2", "running");
  for (const name of evict) rmSync(join(shardDir, `${name}.json`), { force: true });
  if (control.failAfterEvict) {
    process.stderr.write(`RuntimeError: ${control.failAfterEvict}\n`);
    process.exit(1);
  }
  const progress = { total_batches: todo.length, completed: 0, failed: 0, batches: {} };
  writeFileSync(join(intermediate, "pass2_progress.json"), JSON.stringify(progress));
  const failedChunks = [];
  await Promise.all(
    todo.map(async (name, index) => {
      const body = readFileSync(join(mirror, name), "utf8");
      const result = await complete("pass2", control.pass2System ?? "PASS2-SYSTEM", `FILE ${name}\n${body}`, `pass2 batch ${index + 1}`);
      if ((control.failFiles ?? []).includes(name)) failedChunks.push({ filename: name, chunk_idx: 0, reason: "blank_response" });
      writeFileSync(join(shardDir, `${name}.json`), JSON.stringify({ sha: sha(body), result }));
      progress.completed += 1;
      writeFileSync(join(intermediate, "pass2_progress.json.tmp"), JSON.stringify(progress));
      renameSync(join(intermediate, "pass2_progress.json.tmp"), join(intermediate, "pass2_progress.json"));
    })
  );
  writeFileSync(join(intermediate, "failed_chunks.json"), JSON.stringify(failedChunks));
  writeFileSync(extractedPath, JSON.stringify(readdirSync(shardDir).map((name) => name.replace(/\.json$/, ""))));
  mark("pass2", "done");

  if (control.fail) {
    state.steps.normalize_names = { status: "failed" };
    state.errors.normalize_names = { error: control.fail, attempts: 2, llm_correction_applied: false, resolved: false };
    saveState();
    process.stderr.write(`Traceback (most recent call last):\n  File "pipeline.py", line 1\nmykg.orchestrator.PipelineHaltError: Pipeline halted at step 'normalize_names': ${control.fail}\n`);
    process.exit(1);
  }
  mark("normalize_names", "done");
  mark("assemble", "done");

  const nodes = [];
  const edges = [];
  for (const name of readdirSync(shardDir).sort()) {
    const shard = JSON.parse(readFileSync(join(shardDir, name), "utf8"));
    for (const node of shard.result.nodes ?? []) nodes.push(node);
    for (const edge of shard.result.edges ?? []) edges.push(edge);
  }
  writeFileSync(join(output, "nodes.jsonl"), nodes.map((n) => JSON.stringify(n)).join("\n") + (nodes.length ? "\n" : ""));
  writeFileSync(join(output, "edges.jsonl"), edges.map((e) => JSON.stringify(e)).join("\n") + (edges.length ? "\n" : ""));
  mark("validate_graph", "done");
}

process.on("SIGTERM", () => {
  process.stderr.write("KeyboardInterrupt\n");
  process.exit(143);
});

main().then(
  () => process.exit(0),
  (error) => {
    process.stderr.write(`${error?.stack ?? error}\n`);
    process.exit(1);
  }
);
