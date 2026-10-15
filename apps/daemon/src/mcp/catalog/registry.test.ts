/**
 * The catalog's invariants (unified MCP design 2026-10-15 §3, §9.5, §14.2.1): names, audiences,
 * tiers, toolsets and their agreement with `TOOLSETS`; Admin tools carry a family and a preview;
 * the import graph reachable from `catalog/index.ts` stays inside an allow-list of pure modules
 * (the agent host loads it statically); only the executor runs a tool; and the byte budgets,
 * measured on `tools/list` exactly as an MCP client receives it — for every tool, no exemption.
 *
 * Counts (spec §1.4, §9.1): 41 external tools, 45 chat tools (41 shared + 4 chat-only), 22 on by
 * default (core 17 + reads 5) for every agent.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ADMIN_FAMILIES, chatToolNames, isToolsetId, TOOLSETS, toolsetById, toolsetOfTool } from "@orquester/api";

import { externalMcpToolNames } from "../server.ts";
import { audienceDescription, audienceSchema, audienceShape } from "../executor.ts";
import type { AnyOrquesterTool, Audience } from "./contract.ts";
import { buildCatalog, CATALOG, catalogFor, TOOL_NAME_PATTERN, toolByName } from "./index.ts";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** The chat-only tools (spec §4 rows 42–45). */
const CHAT_ONLY = ["html_preview", "html_render", "request_secret", "request_toolset"];

test("names, audiences, toolsets, tiers: well-formed and unique; Admin-capable tools carry a family and a preview", () => {
  const names = new Set<string>();
  for (const tool of CATALOG) {
    assert.match(tool.name, TOOL_NAME_PATTERN, tool.name);
    assert.ok(!names.has(tool.name), `duplicate ${tool.name}`);
    names.add(tool.name);
    assert.ok(tool.audiences.length > 0 && tool.audiences.every((a) => a === "external" || a === "chat"), tool.name);
    assert.ok(isToolsetId(tool.toolset), `${tool.name}: toolset ${tool.toolset}`);
    assert.ok(typeof tool.tier === "function" || ["read", "act", "admin"].includes(tool.tier), tool.name);
    assert.ok(["json", "text", "image"].includes(tool.resultKind), tool.name);
    assert.equal(typeof tool.scope, "function", tool.name);
    const canBeAdmin = typeof tool.tier === "function" || tool.tier === "admin";
    if (canBeAdmin) {
      assert.ok(tool.adminFamily !== undefined, `${tool.name}: Admin without adminFamily`);
      if (typeof tool.adminFamily === "string") assert.ok((ADMIN_FAMILIES as readonly string[]).includes(tool.adminFamily), tool.name);
      assert.equal(typeof tool.approval, "function", `${tool.name}: Admin without approval()`);
    }
    for (const key of [...(tool.chatOnlyInput ?? []), ...(tool.externalOnlyInput ?? [])]) {
      assert.ok(Object.prototype.hasOwnProperty.call(tool.input, key), `${tool.name}: stripped key ${String(key)} is not an input`);
    }
  }
  assert.throws(() => buildCatalog([[CATALOG[0]!], [CATALOG[0]!]]), /duplicate/);
  assert.throws(() => buildCatalog([[{ ...CATALOG[0]!, name: "Bad-Name" }]]), /bad tool name/);
});

test("lookups: catalogFor and toolByName agree; an audience never sees another's tool", () => {
  for (const audience of ["external", "chat"] as Audience[]) {
    for (const tool of catalogFor(audience)) assert.equal(toolByName(tool.name, audience), tool);
  }
  for (const tool of catalogFor("chat").filter((t) => !t.audiences.includes("external"))) assert.equal(toolByName(tool.name, "external"), undefined);
  assert.equal(toolByName("no_such_tool"), undefined);
});

test("TOOLSETS agree with the catalog: every chat tool sits in the toolset TOOLSETS names, at that highest tier", () => {
  for (const tool of catalogFor("chat")) {
    const id = toolsetOfTool(tool.name);
    assert.ok(id !== undefined, `${tool.name} is in no toolset of TOOLSETS`);
    const spec = toolsetById(id)!;
    assert.equal(tool.toolset, spec.id, `${tool.name}: toolset`);
    const tier = spec.tools.find((entry) => entry.name === tool.name)!.tier;
    if (typeof tool.tier === "string") assert.equal(tool.tier, tier, `${tool.name}: tier`);
    else assert.equal(tier, "admin", `${tool.name}: a per-call tier is badged Admin`);
  }
  // …and TOOLSETS names no tool the catalog lacks.
  assert.deepEqual([...chatToolNames()].sort(), catalogFor("chat").map((tool) => tool.name).sort());
});

test("counts: 41 external, 45 chat (the 41 plus 4 chat-only), 22 on by default for every agent, 17 in core", () => {
  const external = catalogFor("external").map((tool) => tool.name);
  const chat = catalogFor("chat").map((tool) => tool.name);
  assert.equal(external.length, 41);
  assert.equal(chat.length, 45);
  assert.deepEqual(externalMcpToolNames(), external);
  assert.deepEqual(chat.filter((name) => !external.includes(name)), CHAT_ONLY);
  assert.deepEqual(external.filter((name) => !chat.includes(name)), [], "every external tool is a chat tool too");
  assert.equal(CATALOG.length, 45);
  for (const agent of ["claude", "codex", "grok", "opencode"] as const) {
    const on = new Set(TOOLSETS.filter((toolset) => toolset.locked || toolset.defaults[agent]).map((toolset) => toolset.id));
    assert.equal(catalogFor("chat").filter((tool) => on.has(tool.toolset)).length, 22, agent);
  }
  assert.equal(catalogFor("chat").filter((tool) => tool.toolset === "core").length, 17);
});

// ---------------------------------------------------------------------------
// The import graph (D-1): the agent host loads the catalog statically
// ---------------------------------------------------------------------------

/** Value imports and re-exports of a module (type-only ones are erased and never loaded). */
function valueImports(file: string): string[] {
  const text = readFileSync(file, "utf8");
  const out: string[] = [];
  for (const match of text.matchAll(/^\s*(?:import|export)\s+(?!type\b)([^'";]*?\bfrom\s+)?["']([^"']+)["']/gm)) {
    const clause = (match[1] ?? "").trim();
    if (/^\{\s*(?:type\s+[\w$]+(?:\s+as\s+[\w$]+)?\s*,?\s*)+\}\s*from$/.test(clause)) continue;
    out.push(match[2]!);
  }
  return out;
}

/** The modules reachable from the catalog, and the packages they import. */
function reachable(entry: string): { modules: Set<string>; packages: Set<string> } {
  const modules = new Set<string>();
  const packages = new Set<string>();
  const stack = [resolve(SRC, entry)];
  while (stack.length > 0) {
    const file = stack.pop()!;
    const rel = relative(SRC, file);
    if (modules.has(rel)) continue;
    modules.add(rel);
    for (const spec of valueImports(file)) {
      if (spec.startsWith(".")) stack.push(resolve(dirname(file), spec));
      else packages.add(spec);
    }
  }
  return { modules, packages };
}

/**
 * Every module the catalog may reach: pure helpers that reach the daemon only through `DaemonApi`
 * (or not at all). Adding one here is a review decision: no daemon service, no store, no process.
 */
const PURE_MODULES = new Set([
  "agent-chat/activity-ladder.ts",
  // The in-process wait registry (Task 5): a map, no service.
  "agent-chat/waits.ts",
  // Task 11: the YAML frontmatter (de)serialiser the adapters write skills with (pure, `yaml` only),
  // so the card shows a skill's file exactly as it will be written.
  "agent-profile/infra/frontmatter.ts",
  "mcp/addressing.ts",
  "mcp/agents.ts",
  "mcp/attachments.ts",
  "mcp/catalog/contract.ts",
  "mcp/catalog/index.ts",
  "mcp/errors.ts",
  "mcp/fs-tools.ts",
  "mcp/gate/turn-policy.ts",
  "mcp/history.ts",
  "mcp/reads.ts",
  "mcp/result.ts",
  "mcp/tools/agent-profile.ts",
  "mcp/tools/agent-profile-preview.ts",
  "mcp/tools/catalog.ts",
  "mcp/tools/desktop-preview.ts",
  "mcp/tools/desktops.ts",
  "mcp/tools/files.ts",
  "mcp/tools/git.ts",
  "mcp/tools/lineage.ts",
  "mcp/tools/messages.ts",
  "mcp/tools/notify.ts",
  "mcp/tools/output.ts",
  "mcp/tools/requests.ts",
  "mcp/tools/saved-prompts.ts",
  "mcp/tools/search.ts",
  "mcp/tools/secrets.ts",
  "mcp/tools/sessions.ts",
  "mcp/tools/todos.ts",
  "mcp/tools/toolsets.ts",
  "mcp/tools/usage.ts",
  "mcp/tools/visuals.ts",
  "mcp/tools/watch.ts",
  "mcp/tools/workflow-preview.ts",
  "mcp/tools/workflows-guide.ts",
  "mcp/tools/workflows.ts",
  // Task 12: the todo tools' /api/todos client (DaemonApi only).
  "mcp/todo-tools.ts",
  "mcp/transcript.ts",
  "mcp/usage-view.ts",
  "mcp/views.ts",
  "mcp/wait.ts",
  // get_usage prices Codex session tokens with the Cost tab's own table (`estimateCostParts`): no side effect at load,
  // node:fs/promises + node:path + types only (unified MCP Task 9).
  "usage-tokens.ts"
]);


const PURE_PACKAGES = new Set([
  "zod",
  "@orquester/api",
  "@orquester/api/agent-chat",
  "@orquester/config",
  "@orquester/config/fs",
  "node:crypto",
  "node:fs",
  "node:fs/promises",
  "node:path",
  "node:stream",
  // Task 11: frontmatter.ts (pure YAML).
  "yaml"
]);

test("import graph: everything reachable from catalog/index.ts is on the pure allow-list", () => {
  const { modules, packages } = reachable("mcp/catalog/index.ts");
  const unexpected = [...modules].filter((module) => !PURE_MODULES.has(module)).sort();
  assert.deepEqual(unexpected, [], "a module the agent host would load is not on the allow-list (no daemon services, no stores)");
  // …and the allow-list holds nothing stale: every entry is reachable.
  assert.deepEqual([...PURE_MODULES].filter((module) => !modules.has(module)).sort(), [], "an allow-listed module is no longer reachable: drop it");
  assert.deepEqual([...packages].filter((name) => !PURE_PACKAGES.has(name)).sort(), []);
  // The daemon-only halves never reach the host.
  for (const daemonOnly of ["mcp/executor.ts", "mcp/server.ts", "mcp/daemon-api.ts", "mcp/principal.ts", "todos.ts", "index.ts"]) {
    assert.ok(!modules.has(daemonOnly), `${daemonOnly} is reachable from the catalog`);
  }
  // The walker sees through `import { type A }` only when every name is a type.
  assert.ok(valueImports(resolve(SRC, "mcp/catalog/contract.ts")).length === 0, "contract.ts imports types only");
});

// ---------------------------------------------------------------------------
// Only the executor runs tools (D-1)
// ---------------------------------------------------------------------------

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

test("only the executor runs a tool: no other module calls a tool's run", () => {
  const callers = sourceFiles(SRC)
    .filter((file) => /\b(?:tool|def|sessionTool|entry\.tool|toolDef|catalogTool|target)\s*\.\s*run\s*\(/.test(readFileSync(file, "utf8")))
    .map((file) => relative(SRC, file))
    .sort();
  // `legacy-aliases.ts` is an alias tool's own `run` (called by the executor) handing the mapped call to its target.
  assert.deepEqual(callers, ["mcp/executor.ts", "session-tools/legacy-aliases.ts"]);
});

// ---------------------------------------------------------------------------
// Byte budgets (§9.5), on tools/list as a client receives it
// ---------------------------------------------------------------------------

/** `tools/list` for `tools` as the audience is served it, through a real MCP client. */
async function listTools(tools: readonly AnyOrquesterTool[], audience: Audience): Promise<{ name: string; bytes: number; description: string; listed: unknown }[]> {
  const server = new McpServer({ name: "orquester", version: "test" });
  for (const tool of tools) {
    const shape = audienceShape(tool, audience);
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: audienceDescription(tool, audience),
        inputSchema: Object.keys(shape).length > 0 ? shape : audienceSchema(tool, audience),
        annotations: tool.annotations,
        ...(audience === "external" ? { _meta: { "orquester/tier": typeof tool.tier === "function" ? "admin" : tool.tier, "orquester/toolset": tool.toolset } } : {})
      },
      () => ({ content: [] })
    );
  }
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "budget", version: "test" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  try {
    const { tools: listed } = await client.listTools();
    return listed.map((entry) => ({ name: entry.name, bytes: Buffer.byteLength(JSON.stringify(entry), "utf8"), description: entry.description ?? "", listed: entry }));
  } finally {
    await client.close();
    await server.close();
  }
}

const total = (rows: { bytes: number }[]) => rows.reduce((sum, row) => sum + row.bytes, 0) + rows.length - 1 + 2;

/** §9.5 per-tool ceilings (exceptions by name). */
const TOOL_BYTES = (name: string) => (name === "html_render" ? 3_100 : ["create_workflow", "update_workflow", "edit_agent_profile"].includes(name) ? 6_500 : 3_000);
const DESCRIPTION_BYTES = (name: string) => (name === "html_render" || name === "html_preview" ? 2_000 : 1_000);

/** Every `.describe()` text in a shape, depth-first. */
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

test("byte budgets (§9.5): every tool, every description and field text; the external set, the default chat set and core", async () => {
  for (const audience of ["external", "chat"] as Audience[]) {
    const tools = catalogFor(audience);
    const rows = await listTools(tools, audience);
    for (const row of rows) {
      const tool = toolByName(row.name)!;
      assert.ok(row.bytes <= TOOL_BYTES(row.name), `${audience} ${row.name}: ${row.bytes} bytes > ${TOOL_BYTES(row.name)}`);
      assert.ok(Buffer.byteLength(row.description, "utf8") <= DESCRIPTION_BYTES(row.name), `${row.name}: description over budget`);
      for (const text of Object.values(audienceShape(tool, audience)).flatMap((field) => describeTexts(field))) {
        assert.ok(Buffer.byteLength(text, "utf8") <= 160, `${row.name}: a .describe() text is ${Buffer.byteLength(text, "utf8")} bytes`);
      }
    }
    if (audience === "external") {
      assert.ok(total(rows) <= 81_920, `external tools/list is ${total(rows)} bytes`);
      for (const row of rows) {
        const meta = (row.listed as { _meta?: Record<string, unknown> })._meta;
        assert.deepEqual(Object.keys(meta ?? {}).sort(), ["orquester/tier", "orquester/toolset"], row.name);
      }
    } else {
      // Spec §9.5: the default set (core + reads) ≤ 32 768, core alone ≤ 25 600 — for every agent.
      for (const agent of ["claude", "codex", "grok", "opencode"] as const) {
        const on = new Set(TOOLSETS.filter((toolset) => toolset.locked || toolset.defaults[agent]).map((toolset) => toolset.id));
        const defaults = rows.filter((row) => on.has(toolByName(row.name)!.toolset));
        assert.ok(total(defaults) <= 32_768, `${agent}: default chat tools/list is ${total(defaults)} bytes`);
      }
      const core = rows.filter((row) => toolByName(row.name)!.toolset === "core");
      assert.ok(total(core) <= 25_600, `core alone is ${total(core)} bytes`);
      for (const row of rows) assert.equal((row.listed as { _meta?: unknown })._meta, undefined, "chat entries carry no _meta");
    }
  }
});
