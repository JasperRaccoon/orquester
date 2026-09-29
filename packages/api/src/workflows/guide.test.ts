import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { Script, runInNewContext } from "node:vm";

import { RULE_OPERATORS, WORKFLOW_NODE_TYPES, type RuleOperator, type WorkflowRule } from "@orquester/config";

import { toWorkflowAgentCatalog } from "./agent-catalog.ts";
import { defaultNodeConfig, WORKFLOW_BLOCK_CATALOG } from "./block-types.ts";
import { EXPRESSION_FILTERS, EXPRESSION_ROOTS, parseTemplate, renderTemplate, type ExpressionContext, type TemplateExpression } from "./expressions.ts";
import {
  renderWorkflowGuideSections,
  renderWorkflowRecipe,
  WORKFLOW_BLOCK_GUIDES,
  WORKFLOW_CODE_ARGUMENT_NAMES,
  WORKFLOW_CODE_ARGUMENTS,
  WORKFLOW_CODE_SIGNATURE,
  WORKFLOW_EXPRESSION_FILTER_GUIDE,
  WORKFLOW_EXPRESSION_GUIDE,
  WORKFLOW_EXPRESSION_ROOT_GUIDE,
  WORKFLOW_EXPRESSION_RULES,
  WORKFLOW_FAILURE_GUIDE,
  WORKFLOW_RECIPES,
  WORKFLOW_RULE_GUIDE,
  WORKFLOW_RULE_OPERATOR_GUIDE,
  WORKFLOW_SECRETS_GUIDE,
  type WorkflowGuideItem
} from "./guide.ts";
import { createWorkflowFromRequest } from "./patch.ts";
import { evaluateRuleAsync, type RuleMatcher } from "./rules.ts";
import { sequentialIds } from "./testing.ts";
import type { WorkflowBlockErrorKind } from "./types.ts";
import { validateWorkflow } from "./validate.ts";

const items = (list: readonly WorkflowGuideItem[]): string[] => list.flatMap((item) => [item.term ?? "", item.text]);

/** Every sentence the guide module publishes, recipes included (their notes and every template field). */
function allGuideTexts(): string[] {
  const texts: string[] = [WORKFLOW_EXPRESSION_GUIDE, WORKFLOW_CODE_SIGNATURE];
  for (const type of WORKFLOW_NODE_TYPES) texts.push(renderWorkflowGuideSections(WORKFLOW_BLOCK_GUIDES[type]));
  texts.push(...items(WORKFLOW_FAILURE_GUIDE), ...items(WORKFLOW_RULE_GUIDE), ...items(WORKFLOW_SECRETS_GUIDE), ...items(WORKFLOW_EXPRESSION_RULES));
  texts.push(...Object.values(WORKFLOW_RULE_OPERATOR_GUIDE), ...Object.values(WORKFLOW_CODE_ARGUMENTS));
  for (const recipe of WORKFLOW_RECIPES) texts.push(renderWorkflowRecipe(recipe), ...recipe.notes, JSON.stringify(recipe.nodes));
  return texts;
}

/** Syntax written about rather than used: the grammar (`{{ path | filter }}`) and a prompt variable's escape (`{{name}}`). */
const SYNTAX_PLACEHOLDERS = new Set(["path | filter", "name"]);

/** The `{{ … }}` written in a text, placeholders (`…`, `<Name>`, the syntax above) and escaped `\{{` left out. */
function writtenExpressions(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(/(\\?)\{\{([^{}]*)\}\}/g)) {
    if (match[1] === "\\") continue;
    const body = match[2]!;
    if (body.includes("…") || body.includes("<") || body.trim().length === 0 || SYNTAX_PLACEHOLDERS.has(body.trim())) continue;
    // A JSON-encoded template (inside a recipe's JSON) carries escaped quotes.
    found.push(`{{${body.replace(/\\"/g, "\"")}}}`);
  }
  return found;
}

const liveCatalog = toWorkflowAgentCatalog([
  { id: "claude", enabled: true, status: "ready", models: ["default", "opus[1m]", "sonnet"].map((slug) => ({ slug })) }
]);

/** Every `secrets.NAME` a recipe reads, in templates and code alike. */
function secretNamesIn(value: unknown): string[] {
  return [...new Set([...JSON.stringify(value).matchAll(/secrets\.([A-Z][A-Z0-9_]*)/g)].map((match) => match[1]!))];
}

/** Every code source the guide publishes: the catalogue example, a fresh block's default, each recipe's. */
function publishedCodeSources(): { label: string; source: string }[] {
  const sources = [
    { label: "catalog example", source: (WORKFLOW_BLOCK_CATALOG.code.example as { source: string }).source },
    { label: "default config", source: defaultNodeConfig("code").source }
  ];
  for (const recipe of WORKFLOW_RECIPES) {
    for (const node of recipe.nodes) {
      if (node.type === "code") sources.push({ label: `${recipe.id}/${node.name}`, source: (node.config as { source: string }).source });
    }
  }
  return sources;
}

/** The module's default export as a callable, in a fresh VM context (the sandbox's ESM, minus the `export`). */
function loadDefaultExport(source: string): (arg: Record<string, unknown>) => Promise<unknown> {
  const context: Record<string, unknown> = {};
  runInNewContext(source.replace(/\bexport\s+default\s+/, "globalThis.main = "), context);
  return context.main as (arg: Record<string, unknown>) => Promise<unknown>;
}

describe("workflow guide: the tables cover exactly what the engine has", () => {
  it("one operator entry per rule operator, in the schema's order", () => {
    assert.deepEqual(Object.keys(WORKFLOW_RULE_OPERATOR_GUIDE), [...RULE_OPERATORS]);
  });

  it("one filter entry per filter, each usage a filter that parses", () => {
    assert.deepEqual(Object.keys(WORKFLOW_EXPRESSION_FILTER_GUIDE), [...EXPRESSION_FILTERS]);
    for (const name of EXPRESSION_FILTERS) {
      const parsed = parseTemplate(`{{ input | ${WORKFLOW_EXPRESSION_FILTER_GUIDE[name].usage} }}`);
      assert.deepEqual(parsed.errors, [], name);
      assert.equal((parsed.segments[0] as TemplateExpression).filters[0]!.name, name);
    }
  });

  it("every expression root has a row, and every row's path parses to its root", () => {
    assert.deepEqual([...new Set(WORKFLOW_EXPRESSION_ROOT_GUIDE.map((row) => row.root))].sort(), [...EXPRESSION_ROOTS].sort());
    for (const row of WORKFLOW_EXPRESSION_ROOT_GUIDE) {
      const parsed = parseTemplate(`{{ ${row.path.replace("<Name>", "Fetch").replace("<NAME>", "API_TOKEN")} }}`);
      assert.deepEqual(parsed.errors, [], row.path);
      assert.equal((parsed.segments[0] as TemplateExpression).root, row.root);
    }
  });

  it("one guide per block type, and every type but the note has one", () => {
    assert.deepEqual(Object.keys(WORKFLOW_BLOCK_GUIDES).sort(), [...WORKFLOW_NODE_TYPES].sort());
    for (const type of WORKFLOW_NODE_TYPES) {
      if (type !== "note") assert.ok(WORKFLOW_BLOCK_GUIDES[type].length > 0, type);
    }
  });

  it("the Code arguments are described once each, and the signature destructures them all", () => {
    assert.deepEqual(Object.keys(WORKFLOW_CODE_ARGUMENTS), [...WORKFLOW_CODE_ARGUMENT_NAMES]);
    assert.equal(WORKFLOW_CODE_SIGNATURE, `export default async function ({ ${WORKFLOW_CODE_ARGUMENT_NAMES.join(", ")} })`);
    assert.ok(defaultNodeConfig("code").source.startsWith(WORKFLOW_CODE_SIGNATURE));
  });
});

describe("workflow guide: every name it writes is real", () => {
  it("every {{ … }} it writes parses: real roots, real filters, valid syntax", () => {
    let count = 0;
    for (const text of allGuideTexts()) {
      for (const expression of writtenExpressions(text)) {
        count += 1;
        assert.deepEqual(parseTemplate(expression).errors, [], expression);
      }
    }
    assert.ok(count > 40, `only ${count} expressions found — the scan is broken`);
  });

  it("every snake_case code it names is a block error kind or a validation problem code", () => {
    const errorKinds: Record<WorkflowBlockErrorKind, true> = {
      all_burnt: true, agent_error: true, timeout: true, cancelled: true, interrupted: true, exit_code: true, exception: true,
      http_status: true, network: true, expression: true, validation: true, project_missing: true, child_run_failed: true,
      stopped: true, limit_exceeded: true, internal: true
    };
    const validateSource = readFileSync(new URL("./validate.ts", import.meta.url), "utf8");
    const problemCodes = new Set([...validateSource.matchAll(/code: "([a-z_]+)"/g)].map((match) => match[1]!));
    const named = new Set(allGuideTexts().flatMap((text) => [...text.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)].map((match) => match[1]!)));
    assert.ok(named.size >= 8, "the scan found the codes");
    for (const code of named) assert.ok(code in errorKinds || problemCodes.has(code), `unknown code \`${code}\``);
    assert.ok(problemCodes.has("cycle"), "the loop recipe names the `cycle` problem");
  });
});

describe("workflow guide: its claims hold", () => {
  const context = (input: unknown): ExpressionContext => ({ nodes: {}, input, trigger: null, run: null, project: null, secrets: {} });

  it("a template cannot read into JSON text: it inserts nothing and records the exact warning the guide quotes", () => {
    const rendered = renderTemplate("{{ input.text.severity }}", context({ text: "{\"severity\": \"high\"}" }));
    assert.equal(rendered.text, "");
    assert.equal(rendered.warnings.length, 1);
    const warning = rendered.warnings[0]!;
    assert.ok(WORKFLOW_EXPRESSION_GUIDE.includes(warning), warning);
    assert.ok(WORKFLOW_RECIPES.find((recipe) => recipe.id === "agent-json")!.notes.some((note) => note.includes(warning)));
  });

  it("`| json` encodes and never parses: JSON text comes back quoted", () => {
    assert.equal(renderTemplate("{{ input.text | json }}", context({ text: "{\"a\":1}" })).text, "\"{\\\"a\\\":1}\"");
  });

  it("the rule operators behave as the guide says", async () => {
    const matcher: RuleMatcher = async (job) => ({ result: new RegExp(job.source, job.flags).test(job.text) });
    const holds = async (left: string, op: RuleOperator, right: string | undefined, input: unknown): Promise<{ result: boolean; warnings: string[] }> => {
      const rule: WorkflowRule = right === undefined ? { left, op } : { left, op, right };
      return evaluateRuleAsync(rule, context(input), matcher);
    };
    assert.equal((await holds("{{ input }}", "equals", "1.0", 1)).result, true, "numbers compare as numbers");
    assert.equal((await holds("{{ input }}", "equals", "Bug", "bug")).result, false, "case matters");
    assert.equal((await holds("{{ input }}", "equals", "TRUE", true)).result, true, "a boolean equals the word");
    assert.equal((await holds("{{ input }}", "contains", "b", ["a", "b"])).result, true, "a list contains an item");
    assert.equal((await holds("{{ input }}", "exists", undefined, null)).result, true, "exists holds for null");
    assert.equal((await holds("{{ input.missing }}", "exists", undefined, {})).result, false);
    assert.equal((await holds("{{ input }}", "isEmpty", undefined, "  ")).result, true, "blank text is empty");
    assert.equal((await holds("{{ input }}", "isTrue", undefined, "True")).result, true);
    const notNumber = await holds("{{ input }}", "gt", "0", "many");
    assert.equal(notNumber.result, false);
    assert.equal(notNumber.warnings.length, 1, "an undecidable rule is false with a warning");
    const refused = await holds("{{ input }}", "matches", "(a+)+", "aaa");
    assert.equal(refused.result, false);
    assert.match(refused.warnings[0]!, /refused/);
  });
});

describe("workflow recipes", () => {
  it("ids and titles are unique", () => {
    assert.equal(new Set(WORKFLOW_RECIPES.map((recipe) => recipe.id)).size, WORKFLOW_RECIPES.length);
    assert.equal(new Set(WORKFLOW_RECIPES.map((recipe) => recipe.title)).size, WORKFLOW_RECIPES.length);
  });

  it("every recipe builds and validates with no error and no warning against a live catalogue", () => {
    for (const recipe of WORKFLOW_RECIPES) {
      const workflow = createWorkflowFromRequest(
        {
          name: recipe.title,
          project: { kind: "existing", projectPath: "/w/ws/app" },
          nodes: structuredClone([...recipe.nodes]),
          edges: structuredClone([...recipe.edges])
        },
        { mintId: sequentialIds(), now: new Date("2026-09-28T10:00:00Z") }
      );
      const { problems } = validateWorkflow(workflow, {
        catalog: liveCatalog,
        secretNames: secretNamesIn(recipe.nodes),
        savedPromptIds: [],
        knownWorkflowIds: [workflow.id],
        strictScheduleIntervals: true
      });
      assert.deepEqual(problems.filter((problem) => problem.severity !== "info"), [], recipe.id);
    }
  });

  it("every published code source compiles as JavaScript and names only real arguments", () => {
    for (const { label, source } of publishedCodeSources()) {
      assert.match(source, /\bexport\s+default\s+async\s+function\s*\(\{([^}]*)\}\)/, label);
      assert.doesNotThrow(() => new Script(source.replace(/\bexport\s+default\s+/, "const main = ")), label);
      const destructured = /\bexport\s+default\s+async\s+function\s*\(\{([^}]*)\}\)/.exec(source)![1]!.split(",").map((name) => name.trim());
      for (const name of destructured) assert.ok((WORKFLOW_CODE_ARGUMENT_NAMES as readonly string[]).includes(name), `${label}: ${name}`);
    }
  });

  it("the JSON-parsing recipe turns an agent's chatty reply into an object, and throws on a reply without JSON", async () => {
    const parse = WORKFLOW_RECIPES.find((recipe) => recipe.id === "agent-json")!.nodes.find((node) => node.name === "Parse")!;
    const main = loadDefaultExport((parse.config as { source: string }).source);
    // The VM's objects come from another realm: compare their JSON.
    assert.equal(JSON.stringify(await main({ input: { text: "Sure:\n{\"severity\": \"high\", \"summary\": \"disk full\"}" } })), "{\"severity\":\"high\",\"summary\":\"disk full\"}");
    await assert.rejects(main({ input: { text: "no idea" } }), /No JSON in the reply/);
  });
});
