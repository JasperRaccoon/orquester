/**
 * The catalog's invariants (unified MCP design 2026-10-15 §3, §9.5, §14.2.1): names, audiences,
 * tiers, toolsets and their agreement with `TOOLSETS`; Admin tools carry a family and a preview;
 * the import graph reachable from `catalog/index.ts` stays inside an allow-list of pure modules
 * (the agent host loads it statically); only the executor runs a tool; and the byte budgets,
 * measured on `tools/list` exactly as an MCP client receives it.
 *
 * Transitional (Task 2): every tool is still a legacy adapter (`./legacy.ts`), so the counts are
 * today's (72 external, 16 chat) and legacy tools are held to their measured baselines; the full
 * §9.5 budgets apply to every non-legacy tool now, and Task 14 tightens the counts (41 / 45 / 22)
 * and the external total (≤ 81 920) once every family has landed.
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
import { EXTERNAL_MCP_TOOL_NAMES } from "../tool-names.ts";
import { audienceDescription, audienceSchema, audienceShape } from "../executor.ts";
import type { AnyOrquesterTool, Audience } from "./contract.ts";
import { buildCatalog, CATALOG, catalogFor, TOOL_NAME_PATTERN, toolByName } from "./index.ts";
import { LEGACY_CHAT_META, LEGACY_EXTERNAL_META } from "./legacy.ts";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const isLegacy = (tool: AnyOrquesterTool) =>
  Object.prototype.hasOwnProperty.call(LEGACY_EXTERNAL_META, tool.name) || Object.prototype.hasOwnProperty.call(LEGACY_CHAT_META, tool.name);

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

test("TOOLSETS agree with the catalog: a chat tool TOOLSETS names sits in that toolset at that highest tier", () => {
  const specNames = new Set(chatToolNames());
  for (const tool of catalogFor("chat")) {
    if (specNames.has(tool.name)) {
      const spec = toolsetById(toolsetOfTool(tool.name)!)!;
      assert.equal(tool.toolset, spec.id, `${tool.name}: toolset`);
      const tier = spec.tools.find((entry) => entry.name === tool.name)!.tier;
      if (typeof tool.tier === "string") assert.equal(tool.tier, tier, `${tool.name}: tier`);
      else assert.equal(tier, "admin", `${tool.name}: a per-call tier is badged Admin`);
    } else {
      // Transitional: the only chat tools TOOLSETS does not name are the legacy session tools.
      assert.ok(Object.prototype.hasOwnProperty.call(LEGACY_CHAT_META, tool.name), `${tool.name} is in no toolset of TOOLSETS`);
      assert.equal(tool.toolset, "core");
    }
  }
  // Every toolset id the catalog uses exists, and every TOOLSETS tool is a catalog name or still to come.
  for (const toolset of TOOLSETS) for (const entry of toolset.tools) assert.match(entry.name, TOOL_NAME_PATTERN);
});

test("transitional counts: the external surface is tool-names.ts's list; chat is the legacy session tools plus the families landed", () => {
  assert.deepEqual([...externalMcpToolNames()].sort(), [...EXTERNAL_MCP_TOOL_NAMES].sort());
  assert.equal(catalogFor("external").length, EXTERNAL_MCP_TOOL_NAMES.length);
  // Each Wave 3 family replaces its legacy entries with TOOLSETS tools (Task 14 pins 41 / 45 / 22).
  const specNames = new Set(chatToolNames());
  for (const tool of catalogFor("chat")) assert.ok(specNames.has(tool.name) || Object.prototype.hasOwnProperty.call(LEGACY_CHAT_META, tool.name), tool.name);
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
  "mcp/addressing.ts",
  "mcp/agents.ts",
  "mcp/attachments.ts",
  "mcp/catalog/contract.ts",
  "mcp/catalog/index.ts",
  "mcp/catalog/legacy.ts",
  "mcp/errors.ts",
  "mcp/fs-tools.ts",
  "mcp/gate/turn-policy.ts",
  "mcp/history.ts",
  "mcp/reads.ts",
  "mcp/result.ts",
  "mcp/tool.ts",
  "mcp/tools/agent-profile.ts",
  "mcp/tools/catalog.ts",
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
  "mcp/tools/workflows-guide.ts",
  "mcp/tools/workflows.ts",
  "mcp/transcript.ts",
  "mcp/usage-view.ts",
  "mcp/views.ts",
  "mcp/wait.ts",
  "session-tools/contract.ts",
  "session-tools/html/index.ts",
  "session-tools/results.ts",
  "session-tools/secrets/index.ts",
  "session-tools/threads/create.ts",
  "session-tools/threads/delegation.ts",
  "session-tools/threads/shared.ts",
  "session-tools/threads/threads.ts",
  "session-tools/turn-policy.ts"
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
  "node:stream"
]);

test("import graph: everything reachable from catalog/index.ts is on the pure allow-list", () => {
  const { modules, packages } = reachable("mcp/catalog/index.ts");
  const unexpected = [...modules].filter((module) => !PURE_MODULES.has(module)).sort();
  assert.deepEqual(unexpected, [], "a module the agent host would load is not on the allow-list (no daemon services, no stores)");
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
    .filter((file) => /\b(?:tool|def|sessionTool|entry\.tool|toolDef|catalogTool)\s*\.\s*run\s*\(/.test(readFileSync(file, "utf8")))
    .map((file) => relative(SRC, file))
    .sort();
  // `legacy.ts` is the adapter: a catalog tool's own `run` calls the pre-catalog handler it wraps.
  assert.deepEqual(callers, ["mcp/catalog/legacy.ts", "mcp/executor.ts"]);
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

test("byte budgets: §9.5 for every non-legacy tool; legacy tools held to their measured baselines", async () => {
  for (const audience of ["external", "chat"] as Audience[]) {
    const tools = catalogFor(audience);
    const rows = await listTools(tools, audience);
    for (const row of rows) {
      const tool = toolByName(row.name)!;
      if (isLegacy(tool)) {
        // The 72-tool surface's largest is update_workflow (6 050 + _meta); the chat's html_render (3 669).
        assert.ok(row.bytes <= 6_200, `${row.name}: ${row.bytes} bytes`);
        continue;
      }
      assert.ok(row.bytes <= TOOL_BYTES(row.name), `${audience} ${row.name}: ${row.bytes} bytes > ${TOOL_BYTES(row.name)}`);
      assert.ok(Buffer.byteLength(row.description, "utf8") <= DESCRIPTION_BYTES(row.name), `${row.name}: description over budget`);
      for (const text of Object.values(audienceShape(tool, audience)).flatMap((field) => describeTexts(field))) {
        assert.ok(Buffer.byteLength(text, "utf8") <= 160, `${row.name}: a .describe() text is ${Buffer.byteLength(text, "utf8")} bytes`);
      }
    }
    if (audience === "external") {
      // Baseline 91 551 bytes for 72 tools (spec §2.1) plus `_meta` (≤ 70 bytes a tool); Task 14: ≤ 81 920.
      assert.ok(total(rows) <= 91_551 + 70 * rows.length, `external tools/list is ${total(rows)} bytes`);
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
