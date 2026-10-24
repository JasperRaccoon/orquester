/**
 * Every tool name an agent or a client is told about exists for its audience (unified MCP design
 * 2026-10-15 §10, §11; plan Task 14): the external server's instructions and every external
 * description, field text and note name only external tools; the in-chat instruction block and
 * every chat description name only chat tools; the strings the daemon's tools, transport and
 * conversation services answer with (errors, hints, notices, cards) name only catalog tools; and
 * `docs/orquester-mcp.md` lists exactly `catalogFor("external")` and, outside its migration table,
 * names no removed tool.
 *
 * A "tool name" is any catalog name, or any name of the 2.x / pre-catalog surfaces that this release
 * removed (below): a stale reference to one of those is what the scan exists to catch.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import type { z } from "zod";

import { audienceDescription, audienceShape } from "../executor.ts";
import { SERVER_INSTRUCTIONS, SERVER_VERSION } from "../server.ts";
import { composeOrquesterInstructions, KNOWLEDGE_WORKER_INSTRUCTIONS } from "../../session-tools/instructions.ts";
import type { AnyOrquesterTool, Audience } from "./contract.ts";
import { catalogFor } from "./index.ts";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const REPO = resolve(SRC, "../../..");

/**
 * Every tool name the 72-tool external surface and the 16-tool in-chat surface had that 3.0.0 no longer serves
 * (`stop_task` lives on as a `control_session` action, so it is no tool name to look for).
 */
const REMOVED = [
  "interrupt_session", "stop_session", "close_session", "revert_session", "compact_session", "get_session_lineage",
  "resolve_merge_back", "implement_plan", "answer_question", "dismiss_question", "resolve_approval", "get_cost", "list_files",
  "create_todo", "update_todo", "delete_todo", "toggle_todo_item", "validate_workflow", "list_workflow_runs", "get_workflow_run",
  "list_agent_profiles", "get_agent_profile_item", "create_agent_profile_item", "update_agent_profile_item",
  "set_agent_profile_item_enabled", "delete_agent_profile_item", "copy_agent_profile_item", "trust_agent_profile_hook",
  "get_agent_instructions", "write_agent_instructions", "import_agent_profile_items", "list_marketplace_plugins",
  "desktops_list", "desktop_host_status", "desktop_open", "desktop_launch_app", "desktop_windows", "desktop_window_action",
  "desktop_app_log", "desktop_stop_app", "desktop_close",
  "thread_list", "thread_read", "thread_create", "agent_catalog", "thread_send", "thread_wait", "thread_interrupt",
  "thread_fork", "thread_merge_back", "delegate_task", "task_status", "task_wait", "task_cancel"
];
const CATALOG_NAMES = new Set(catalogFor("chat").map((tool) => tool.name));
const KNOWN = new Set([...CATALOG_NAMES, ...REMOVED]);
const TOKEN = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g;

/** The known tool names `text` mentions that `allowed` does not hold. */
function strays(text: string, allowed: ReadonlySet<string>): string[] {
  return [...new Set([...text.matchAll(TOKEN)].map((match) => match[0]).filter((name) => KNOWN.has(name) && !allowed.has(name)))];
}

/** Every `.describe()` text of a shape, depth-first. */
function describeTexts(schema: z.ZodTypeAny | undefined, out: string[] = []): string[] {
  if (!schema) return out;
  const def = (schema as unknown as { _def: Record<string, unknown> })._def;
  if (typeof def.description === "string") out.push(def.description);
  for (const key of ["innerType", "type", "schema", "valueType", "left", "right"]) {
    const inner = def[key];
    if (inner && typeof inner === "object" && "_def" in (inner as object)) describeTexts(inner as z.ZodTypeAny, out);
  }
  const shape = typeof def.shape === "function" ? (def.shape as () => z.ZodRawShape)() : undefined;
  for (const child of Object.values(shape ?? {})) describeTexts(child, out);
  for (const option of (def.options as z.ZodTypeAny[] | undefined) ?? []) describeTexts(option, out);
  return out;
}

/** What one audience reads of a tool: its description (with that audience's note) and its field texts. */
const toolTexts = (tool: AnyOrquesterTool, audience: Audience): string[] => [
  audienceDescription(tool, audience),
  ...Object.values(audienceShape(tool, audience)).flatMap((field) => describeTexts(field))
];

test("the external server: version 3.0.0, instructions ≤ 2 KB, and every tool its instructions and tools name is an external tool", () => {
  assert.equal(SERVER_VERSION, "3.0.0");
  assert.ok(Buffer.byteLength(SERVER_INSTRUCTIONS, "utf8") <= 2_048, `${Buffer.byteLength(SERVER_INSTRUCTIONS, "utf8")} bytes`);
  const external = new Set(catalogFor("external").map((tool) => tool.name));
  assert.deepEqual(strays(SERVER_INSTRUCTIONS, external), [], "SERVER_INSTRUCTIONS");
  for (const tool of catalogFor("external")) {
    for (const text of toolTexts(tool, "external")) assert.deepEqual(strays(text, external), [], `${tool.name}: ${text.slice(0, 80)}`);
  }
});

test("the in-chat server: the instruction block (every variant) and every chat tool's texts name only chat tools", () => {
  const chat = new Set(catalogFor("chat").map((tool) => tool.name));
  for (const workflowOwned of [false, true]) {
    for (const knowledgeCollections of [[], ["SEO", "Ads"]]) {
      const block = composeOrquesterInstructions({ workflowOwned, knowledgeCollections });
      assert.deepEqual(strays(block, chat), [], "instruction block");
    }
  }
  assert.deepEqual(strays(KNOWLEDGE_WORKER_INSTRUCTIONS, chat), [], "the knowledge worker block");
  for (const tool of catalogFor("chat")) {
    for (const text of toolTexts(tool, "chat")) assert.deepEqual(strays(text, chat), [], `${tool.name}: ${text.slice(0, 80)}`);
  }
});

/** Non-test TypeScript files under `dir`. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name !== "node_modules" && name !== "_generated") out.push(...sourceFiles(path));
    } else if (name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".d.ts")) {
      out.push(path);
    }
  }
  return out;
}

/** The text of every string literal and template part of a module — what it can answer with, never its comments. */
function stringsOf(file: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      out.push(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

/**
 * Where an old name is the subject itself, not a reference to a tool: the alias table and the frozen
 * legacy definitions (their whole point), and the alias the conversation family recognises by name
 * (`legacyAlias === "thread_send"`).
 */
const ALLOWED_IN_FILE: Readonly<Record<string, readonly string[]>> = {
  "mcp/tools/messages.ts": ["thread_send"]
};
const SKIPPED_FILES = new Set(["session-tools/legacy-aliases.ts", "agent-host/session-tools/legacy-definitions.ts"]);

test("every string the tools, the transport and the conversation services answer with names only catalog tools", () => {
  const roots = ["mcp", "session-tools", "agent-chat", "agent-tools", "agent-host/session-tools"].map((dir) => join(SRC, dir));
  const apiRoot = join(REPO, "packages/api/src");
  // The scan sees a stale name in a message (the WAIT_CYCLE hint once named thread_read) and nothing else.
  assert.deepEqual(strays("Answer it, or read it with thread_read; list_sessions lists them; run_command is a block.", CATALOG_NAMES), ["thread_read"]);
  const problems: string[] = [];
  for (const file of [...roots.flatMap(sourceFiles), ...sourceFiles(apiRoot)]) {
    const rel = file.startsWith(SRC) ? relative(SRC, file) : relative(REPO, file);
    if (SKIPPED_FILES.has(rel)) continue;
    const allowed = new Set([...CATALOG_NAMES, ...(ALLOWED_IN_FILE[rel] ?? [])]);
    for (const text of stringsOf(file)) for (const name of strays(text, allowed)) problems.push(`${rel}: ${name} in ${JSON.stringify(text.slice(0, 120))}`);
  }
  assert.deepEqual(problems, []);
});

// ---------------------------------------------------------------------------
// docs/orquester-mcp.md
// ---------------------------------------------------------------------------

const DOC = readFileSync(join(REPO, "docs/orquester-mcp.md"), "utf8");

/** The doc's tool table rows: name, toolset, tier cell. */
function docToolRows(): { name: string; toolset: string; tier: string }[] {
  const begin = DOC.indexOf("<!-- external-tools:begin -->");
  const end = DOC.indexOf("<!-- external-tools:end -->");
  assert.ok(begin >= 0 && end > begin, "the doc marks its tool table");
  return DOC.slice(begin, end)
    .split("\n")
    .filter((line) => /^\| `[a-z_]+` \|/.test(line))
    .map((line) => {
      const cells = line.split("|").map((cell) => cell.trim());
      return { name: cells[1]!.replace(/`/g, ""), toolset: cells[2]!, tier: cells[3]! };
    });
}

test("docs/orquester-mcp.md: its tool table is catalogFor(\"external\") — names in order, toolsets and chat tiers", () => {
  const rows = docToolRows();
  const tools = catalogFor("external");
  assert.deepEqual(rows.map((row) => row.name), tools.map((tool) => tool.name));
  for (const [index, tool] of tools.entries()) {
    const row = rows[index]!;
    assert.equal(row.toolset, tool.toolset, `${tool.name}: toolset`);
    if (typeof tool.tier === "string") assert.ok(row.tier.toLowerCase().startsWith(tool.tier), `${tool.name}: tier ${row.tier}`);
    else assert.match(row.tier, /Admin/, `${tool.name}: a per-call tier names when it is Admin`);
  }
  assert.match(DOC, new RegExp(`\\*\\*${tools.length} tools\\*\\*`), "the overview counts them");
  assert.match(DOC, /`orquester` 3\.0\.0/, "the endpoint table names the server version");
});

test("docs/orquester-mcp.md: outside its migration table it names no removed tool", () => {
  const begin = DOC.indexOf("### Migrating from the 72-tool surface");
  const end = DOC.indexOf("### The 42 tools");
  assert.ok(begin >= 0 && end > begin);
  const rest = DOC.slice(0, begin) + DOC.slice(end);
  assert.deepEqual(strays(rest, CATALOG_NAMES), []);
});
