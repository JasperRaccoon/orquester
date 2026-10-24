import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { promisify } from "node:util";
import { parse } from "yaml";
import { MAX_TASK_TOKENS } from "./inbox.ts";
import { MYKG_NORMALIZE_MAX_NAMES, MYKG_PROFILE, buildMykgConfig, mykgMaxWorkers, renderMykgConfig, writeMykgConfig } from "./mykg-config.ts";

const roots: string[] = [];
after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

/**
 * Every key myKG 0.4.10's `config.py` reads with `_get` (no default: a missing one raises at import)
 * plus `RAW[...]` reads and the agent adapter's `llm` keys — taken from the pinned source.
 */
const REQUIRED_PIPELINE_KEYS: Record<string, string[]> = {
  assembly: ["confidence_agg", "confidence_fallback", "confidence_scalar_omitted", "edge_dedup_separator", "edge_id_hex_length", "edge_id_prefix"],
  chunking: ["overlap_tokens", "tiktoken_encoding", "window_tokens"],
  export: ["comment_width", "data_namespace", "data_prefix_label", "networkx_enabled", "rdf_namespace", "rdfs_namespace", "schema_namespace", "schema_prefix_label", "skos_namespace"],
  feedback: ["max_file_chars"],
  ingest: ["max_workers"],
  logging: ["backup_count", "max_bytes"],
  merge_graphs: ["reextraction_strategy"],
  normalize_names: ["enabled", "max_names_per_type"],
  orphan_pass: [
    "blank_recovery_enabled",
    "confidence_base",
    "confidence_weight",
    "connected_sample_size",
    "enabled",
    "excerpt_context",
    "excerpt_max_total",
    "excerpt_window",
    "max_workers",
    "min_cooccurrence",
    "schema_max_restarts",
    "top_k_per_orphan"
  ],
  output: ["json_indent"],
  pass1: ["batch_token_target", "max_workers"],
  pass2: ["max_workers", "stateful_chunks"],
  paths: ["intermediate_dir", "output_dir", "sessions_dir"]
};

type Doc = Record<string, any>;

function profileOf(doc: Doc): Doc {
  assert.equal(doc.profile, MYKG_PROFILE);
  assert.deepEqual(Object.keys(doc.profiles), [MYKG_PROFILE], "one self-contained profile");
  return doc.profiles[MYKG_PROFILE];
}

describe("mykg_config.yaml", () => {
  it("carries every key myKG reads without a default", () => {
    const profile = profileOf(buildMykgConfig({ concurrency: 4 }));
    for (const [section, keys] of Object.entries(REQUIRED_PIPELINE_KEYS)) {
      for (const key of keys) assert.ok(key in profile.pipeline[section], `pipeline.${section}.${key}`);
    }
    assert.equal(profile.llm_retry.max_retries, 0);
    for (const key of ["retry_429_max", "retry_429_base_delay", "timeout", "max_output_tokens", "model"]) assert.ok(key in profile.llm, `llm.${key}`);
    assert.equal(profile.provider, "agent");
    assert.deepEqual(profile.agent, { inbox_dir: "agent_inbox", outbox_dir: "agent_outbox", poll_interval_seconds: 1 });
    assert.equal(profile.pipeline.merge_graphs.reextraction_strategy, "surgical", "one of none | surgical | full (validated at import)");
  });

  it("turns preprocessing, fetching, the orphan pass, the report and every switchable export off", () => {
    const { pipeline, mcp } = profileOf(buildMykgConfig({ concurrency: 2 }));
    assert.equal(pipeline.preprocess.enabled, false);
    assert.deepEqual(pipeline.preprocess.extensions, [], "only .md is copied into a session");
    assert.equal(pipeline.fetch.enabled, false);
    assert.equal(pipeline.orphan_pass.enabled, false);
    assert.equal(pipeline.report.enabled, false);
    assert.equal(pipeline.export.networkx_enabled, false, "also the CDN-loading knowledge_graph.html");
    assert.equal(pipeline.export.obsidian_enabled, false);
    assert.equal(pipeline.export.neo4j_csv_enabled, false);
    assert.equal(pipeline.export.html_max_nodes, 0);
    assert.equal(pipeline.error_gate.enabled, false);
    assert.equal(pipeline.logging.llm_log, false);
    assert.equal(pipeline.logging.capture_prompts, false);
    assert.equal(mcp.enabled, false);
  });

  it("extracts one entry per call and keeps the inbox stocked for the worker chats", () => {
    const { pipeline } = profileOf(buildMykgConfig({ concurrency: 4 }));
    assert.equal(pipeline.pass2.prep_mode, "batch_chunks");
    assert.equal(pipeline.pass2.batch_per_file, true);
    // A task's input stays far under a tool result's limit: whole chunks ≤ 8k, batches ≤ 12k tokens.
    assert.equal(pipeline.chunking.window_tokens, 8000);
    assert.ok(pipeline.chunking.window_tokens <= pipeline.pass2.batch_token_target);
    assert.equal(pipeline.pass1.batch_token_target, 12000);
    assert.equal(pipeline.pass2.batch_token_target, 12000);
    // Name normalization: one concept type per call (its cache key then moves only with that
    // type's names), and a type's name list capped so its task fits a tool result.
    assert.equal(pipeline.normalize_names.enabled, true, "never off: every run rebuilds names from raw extractions");
    assert.equal(pipeline.normalize_names.batch_token_target, 1);
    assert.equal(pipeline.normalize_names.max_names_per_type, MYKG_NORMALIZE_MAX_NAMES);
    assert.ok(MYKG_NORMALIZE_MAX_NAMES * 24 / 4 < MAX_TASK_TOKENS, "a capped type of ~20-character names stays under a task's size");
    assert.equal(pipeline.pass1.max_schema_proposals, 12);
    assert.equal(pipeline.pass1.max_workers, 12);
    assert.equal(pipeline.pass2.max_workers, 12);
    for (let concurrency = 1; concurrency <= 8; concurrency += 1) {
      assert.ok(mykgMaxWorkers(concurrency) >= concurrency * 3 || mykgMaxWorkers(concurrency) === 24, `≥ concurrency×2 waiting at ${concurrency}`);
      assert.ok(mykgMaxWorkers(concurrency) - concurrency >= concurrency * 2);
    }
    assert.equal(mykgMaxWorkers(1), 4);
    assert.equal(mykgMaxWorkers(8), 24);
  });

  it("is YAML that reads back to the same document, strings quoted", () => {
    const text = renderMykgConfig({ concurrency: 3, model: "sonnet" });
    assert.match(text, /^# Written by Orquester/);
    assert.deepEqual(parse(text), buildMykgConfig({ concurrency: 3, model: "sonnet" }));
    assert.match(text, /edge_dedup_separator: "\|"/);
    assert.match(text, /model: "sonnet"/);
  });

  it("is written atomically, private, in the myKG dir", async () => {
    const root = await mkdtemp(join(tmpdir(), "orq-mykg-config-"));
    roots.push(root);
    const path = await writeMykgConfig(join(root, "mykg"), { concurrency: 4 });
    assert.equal(path, join(root, "mykg", "mykg_config.yaml"));
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.deepEqual(parse(await readFile(path, "utf8")), buildMykgConfig({ concurrency: 4 }));
  });

  it("reads back identically through PyYAML when the host has it (myKG's own loader)", async (t) => {
    const python = await promisify(execFile)("python3", ["-I", "-c", "import yaml"]).then(() => true, () => false);
    if (!python) {
      t.skip("python3 with PyYAML is not available here");
      return;
    }
    const text = renderMykgConfig({ concurrency: 4, model: "sonnet" });
    const child = promisify(execFile)("python3", ["-I", "-c", "import sys, json, yaml; print(json.dumps(yaml.safe_load(sys.stdin.read())))"]);
    child.child.stdin?.end(text);
    const { stdout } = await child;
    const fromPython = JSON.parse(stdout);
    assert.deepEqual(fromPython, JSON.parse(JSON.stringify(buildMykgConfig({ concurrency: 4, model: "sonnet" }))));
  });
});
