// Automated workflows — the authoring facts: what each block receives, produces and refuses, how
// expressions and rules read data, and short recipes. ONE source for the MCP's guides
// (`list_workflow_block_types`) and the editor's inspector help.
//
// Every sentence describes what the engine does today; guide.test.ts and the daemon's guide tests
// hold it to the code (argument names, roots, filters, operators, limits; every recipe validates).
// Texts are plain sentences in which `backticks` mark code, names and values.

import { RULE_OPERATORS, type RuleOperator, type WorkflowNodeType } from "@orquester/config";

import { PROMPT_VARIABLES } from "../saved-prompts.ts";
import { EXPRESSION_FILTERS, type ExpressionFilterName, type ExpressionRoot } from "./expressions.ts";
import { WORKFLOW_LIMITS, type WorkflowPatchNodeInput } from "./types.ts";

/** One fact: an optional term (an argument, an operator, a field) and what it means. */
export interface WorkflowGuideItem {
  term?: string;
  text: string;
}

/** A titled group of facts (e.g. a Code block's "Arguments", "Result", "Limits"). */
export interface WorkflowGuideSection {
  title: string;
  items: readonly WorkflowGuideItem[];
}

const MIB = 1024 * 1024;
const mib = (bytes: number): string => `${Math.floor(bytes / MIB)} MiB`;
const hours = (minutes: number): string => (minutes % 60 === 0 ? `${minutes / 60} h` : `${minutes} min`);

// ---------------------------------------------------------------------------
// Code blocks
// ---------------------------------------------------------------------------

/** The keys of the object a Code block's default export is called with, in order (sandbox/code-host.mjs). */
export const WORKFLOW_CODE_ARGUMENT_NAMES = ["input", "nodes", "trigger", "run", "project", "secrets", "log", "stop", "require"] as const;
export type WorkflowCodeArgumentName = (typeof WORKFLOW_CODE_ARGUMENT_NAMES)[number];

/** What each argument holds (iterate `WORKFLOW_CODE_ARGUMENT_NAMES` for the order). */
export const WORKFLOW_CODE_ARGUMENTS: Record<WorkflowCodeArgumentName, string> = {
  input: "The output of the block wired into this one; with several live inputs `{ [blockName]: output }`. In a workflow with no trigger, a block nothing is wired into reads the run's input (`trigger.input`: the Run now value, or a parent workflow's). Else `undefined` when none.",
  nodes: "Every block that has finished in this run, by name: `nodes.Fetch.output`, `.status`, `.error` (`{ kind, message }`).",
  trigger: "What started the run, as `{{ trigger }}` reads it: the Run now / parent workflow value is `trigger.input`.",
  run: "`{ id, startedAt, workflowId, workflowName, attempt }`; `attempt` is this block's try, from 1.",
  project: "`{ path, name, workspace, branch }` of the project the block runs in (`branch` absent when unknown).",
  secrets: "The workflow's secrets by name: `secrets.API_TOKEN`.",
  log: "`log(...values)` writes one line to this block's log, like `console.log`.",
  stop: "`stop(reason?)` ends the whole run at once as `stopped` (not failed).",
  require: "`require(\"pkg\")` loads a package installed in the project (resolved from its `package.json`)."
};

/** How a Code module starts: its default export with every argument destructured. */
export const WORKFLOW_CODE_SIGNATURE = `export default async function ({ ${WORKFLOW_CODE_ARGUMENT_NAMES.join(", ")} })`;

/** The whole environment a Code or Shell process starts with (sandbox/env.ts) — never the daemon's own. */
export const WORKFLOW_SANDBOX_ENV_NAMES = [
  "PATH",
  "HOME",
  "USER",
  "LANG",
  "TERM",
  "TMPDIR",
  "ORQUESTER_WORKFLOW_ID",
  "ORQUESTER_WORKFLOW_RUN_ID",
  "ORQUESTER_AGENT_LAUNCH"
] as const;

const SANDBOX_ENV_TEXT = WORKFLOW_SANDBOX_ENV_NAMES.map((name) => (name === "TERM" ? "`TERM=dumb`" : `\`${name}\``)).join(", ");

const CODE_GUIDE: readonly WorkflowGuideSection[] = [
  {
    title: "Arguments",
    items: WORKFLOW_CODE_ARGUMENT_NAMES.map((name) => ({ term: name, text: WORKFLOW_CODE_ARGUMENTS[name] }))
  },
  {
    title: "Runtime",
    items: [
      {
        text: "Each try runs in a fresh Node process (the daemon's own Node) in the project directory. It is not a security sandbox: it has the daemon user's file and network access."
      },
      {
        text: "The source is an ES module: top-level `await` and `import … from \"node:fs\"` work, but a bare `import` does not find the project's packages — use the `require` argument. There is no global `require` or `__dirname`."
      },
      { text: "Node's globals are there: `fetch`, `Buffer`, `URL`, `setTimeout`, `structuredClone`, `process`." },
      { text: `\`process.env\` holds only ${SANDBOX_ENV_TEXT} — no secrets: read them from \`secrets\`.` },
      { text: "The process exits as soon as the function settles: await all work before returning (an open timer or socket is cut off, not waited for)." }
    ]
  },
  {
    title: "Result",
    items: [
      {
        term: "return",
        text: "The resolved value is the block's output, through JSON: `undefined` becomes `null`, a `Date` its ISO text, `NaN` `null`. A BigInt, a cycle, a function or a symbol fails the block."
      },
      {
        term: "throw",
        text: "A throw or a rejected promise fails the block (`exception`, with message and stack): the run takes its `error` connection, else the run fails."
      },
      {
        term: "stop(reason)",
        text: "Not a failure: the run ends with status `stopped` and `reason` as its message; other running blocks are cancelled."
      }
    ]
  },
  {
    title: "Limits",
    items: [
      {
        term: "memoryMb",
        text: `The JavaScript heap limit: ${WORKFLOW_LIMITS.codeMemoryMb.default} MB by default, ${WORKFLOW_LIMITS.codeMemoryMb.min}–${WORKFLOW_LIMITS.codeMemoryMb.max} MB.`
      },
      {
        term: "timeoutMinutes",
        text: `${WORKFLOW_LIMITS.processTimeoutMinutes.default} min by default (the block's own \`timeoutMinutes\` when the config has none), at most ${hours(WORKFLOW_LIMITS.processTimeoutMinutes.max)}; then SIGTERM, SIGKILL 5 s later, and the block fails with \`timeout\`.`
      },
      {
        term: "size",
        text: `The output is at most ${mib(WORKFLOW_LIMITS.maxOutputBytes)} of JSON; stdout and stderr keep ${mib(WORKFLOW_LIMITS.maxLogBytes)} each; the source at most ${WORKFLOW_LIMITS.maxCodeSourceBytes / 1024} KiB.`
      }
    ]
  }
];

// ---------------------------------------------------------------------------
// Rules (If / Switch)
// ---------------------------------------------------------------------------

/** What each rule operator tests (rules.ts). */
export const WORKFLOW_RULE_OPERATOR_GUIDE: Record<RuleOperator, string> = {
  equals: "The same text (case matters); numbers compare as numbers (`1` equals `1.0`); a boolean equals the word `true` / `false`.",
  notEquals: "Not `equals`.",
  contains: "The text contains `right` (case matters); a list contains an item that `equals` it.",
  notContains: "Not `contains`.",
  startsWith: "The text starts with `right` (case matters).",
  endsWith: "The text ends with `right` (case matters).",
  matches: "A regular-expression search: `^v\\d+`, or `/pattern/i` for flags.",
  gt: "Greater than — both sides must be numbers or numeric text.",
  gte: "Greater than or equal — both sides numeric.",
  lt: "Less than — both sides numeric.",
  lte: "Less than or equal — both sides numeric.",
  isEmpty: "Missing, `null`, blank text, an empty list or an empty object (no `right`).",
  isNotEmpty: "Not `isEmpty` (no `right`).",
  exists: "The path reads any value, even `null` or `\"\"` (no `right`).",
  isTrue: "`true`, or the text `true` in any case (no `right`).",
  isFalse: "`false`, or the text `false` in any case (no `right`)."
};

/** How rules read their sides and fail. */
export const WORKFLOW_RULE_GUIDE: readonly WorkflowGuideItem[] = [
  {
    term: "left",
    text: "A template. Exactly one `{{ … }}` keeps the raw value (a number stays a number, a list a list); anything else is text."
  },
  { term: "right", text: "Always rendered to text." },
  {
    text: "A rule never throws: one that cannot be decided (a number check on text, a refused pattern) is false and the block records a warning."
  },
  {
    term: "matches",
    text: "Patterns that can run forever — nested quantifiers like `(a+)+`, overlapping repeated alternations, backreferences — are refused; a pattern is at most 1000 characters and only the first 100 KB of the value is searched."
  }
];

const RULE_SECTIONS: readonly WorkflowGuideSection[] = [
  { title: "Rules", items: WORKFLOW_RULE_GUIDE },
  { title: "Operators", items: RULE_OPERATORS.map((op) => ({ term: op, text: WORKFLOW_RULE_OPERATOR_GUIDE[op] })) }
];

// ---------------------------------------------------------------------------
// Failures and retries (every block)
// ---------------------------------------------------------------------------

export const WORKFLOW_FAILURE_GUIDE: readonly WorkflowGuideItem[] = [
  {
    term: "error connection",
    text: "A failed block takes its `error` connection; without one the run fails and the blocks still running are cancelled."
  },
  {
    term: "input after error",
    text: "The failed block's output when it has one (Shell `{ stdout, stderr, exitCode }`, HTTP `{ status, headers, body }`; a Code throw has none); `nodes.<Name>.error` is `{ kind, message }`."
  },
  {
    term: "run status",
    text: "A failure handled down an `error` connection no longer fails the run: end that branch in a Stop with `as: \"failure\"` to keep the run failed."
  },
  {
    term: "retry",
    text: "A block field (beside `config`): `retry: { maxTries, delaySeconds }`, 1–10 tries, 0–3600 s apart. The `error` connection is taken only after the last try."
  },
  {
    term: "never retried",
    text: "`all_burnt` (every agent account out of usage) and `limit_exceeded` (an output or body too large, sub-workflows nested too deep); nor a Stop block, `stop()` or a cancelled run."
  }
];

// ---------------------------------------------------------------------------
// Per block type
// ---------------------------------------------------------------------------

/** What each block type does beyond its catalogue entry (`WORKFLOW_BLOCK_CATALOG`), by section. */
export const WORKFLOW_BLOCK_GUIDES: Record<WorkflowNodeType, readonly WorkflowGuideSection[]> = {
  "trigger.manual": [
    {
      title: "Input",
      items: [
        {
          text: "Output `{ kind: \"manual\", input }`: the JSON given to Run now (`null` when none). A parent's Run workflow block starts here too, as `{ kind: \"subworkflow\", input, parentRunId, parentNodeId }` — read either as `trigger.input`."
        }
      ]
    }
  ],
  "trigger.schedule": [
    {
      title: "Schedule",
      items: [
        {
          text: "`cron` is what runs, in `settings.timezone`; `preset` is how the editor shows it (a warning when they disagree). It fires only while the workflow is enabled."
        }
      ]
    }
  ],
  "trigger.git": [
    {
      title: "Events",
      items: [
        {
          text: "Polled, never a webhook, and only while the workflow is enabled. Pull-request and release text is written by others: a prompt that includes it gets the `untrusted_prompt_input` warning."
        }
      ]
    }
  ],
  agent: [
    {
      title: "Session",
      items: [
        {
          term: "new",
          text: "Runs the prompt in a new chat session, unattended with full access, until the agent ends its turn."
        },
        {
          term: "continue",
          text: "`session: { kind: \"continue\", fromNode }` sends the prompt as a follow-up turn into the session an earlier agent block (by name) created in this run — same agent, same context. It never switches agents: for another agent, use a new session and pass the text on."
        },
        {
          term: "chain",
          text: "The fallback order of agents and models when usage limits hit; accounts are picked by the `accounts` policy. When every one is exhausted the block fails `all_burnt`, unless `whenAllBurnt` is `{ kind: \"wait-for-reset\", maxWaitHours }`."
        }
      ]
    },
    {
      title: "Output",
      items: [
        {
          term: "text",
          text: `Always a string: the agent's final message (\`""\` when it wrote none), cut at ${mib(WORKFLOW_LIMITS.maxAgentTextBytes)} (then \`textTruncated: true\`). A JSON reply is still text: parse it in a Code block.`
        },
        { term: "failure", text: "A failed agent block's output holds `{ sessionId, hops }` once a session exists." }
      ]
    },
    {
      title: "Limits",
      items: [
        {
          term: "maxMinutes",
          text: `The working time: ${WORKFLOW_LIMITS.agentMaxMinutes.default} min by default (the block's \`timeoutMinutes\` wins), at most ${hours(WORKFLOW_LIMITS.agentMaxMinutes.max)}.`
        }
      ]
    }
  ],
  code: CODE_GUIDE,
  shell: [
    {
      title: "Script",
      items: [
        {
          text: "`script` runs as `bash -c` (`sh -c` with `shell: \"sh\"`) in the project directory. Anything it leaves running in the background is ended when it exits."
        },
        {
          term: "env",
          text: "Values reach the script only through `env`: each `{ name, value }` has a template value rendered to text, read as `\"$NAME\"`. `{{ … }}` in `script` is refused (`shell_template`)."
        },
        {
          text: `The environment is ${SANDBOX_ENV_TEXT} plus the \`env\` entries (which cannot replace the three \`ORQUESTER_\` ones).`
        }
      ]
    },
    {
      title: "Result",
      items: [
        {
          text: `Output \`{ stdout, stderr, exitCode }\`: the last ~${mib(WORKFLOW_LIMITS.maxOutputBytes / 2)} of each stream, secrets redacted; the full logs (${mib(WORKFLOW_LIMITS.maxLogBytes)} each) stay in the block's log.`
        },
        {
          text: "Exit code 0 succeeds; any other fails the block (`exit_code`) with the output attached, so an `error` connection can read `{{ input.stderr }}` and `{{ input.exitCode }}`."
        }
      ]
    },
    {
      title: "Limits",
      items: [
        {
          term: "timeoutMinutes",
          text: `${WORKFLOW_LIMITS.processTimeoutMinutes.default} min by default, at most ${hours(WORKFLOW_LIMITS.processTimeoutMinutes.max)}; then SIGTERM, SIGKILL 5 s later, and the block fails with \`timeout\`.`
        }
      ]
    }
  ],
  http: [
    {
      title: "Request",
      items: [
        {
          text: "`method` is GET, POST, PUT, PATCH, DELETE or HEAD; `url` must render to an http(s) URL. The URL, `query` values, `headers` values and the body are templates (secrets allowed); a header value that renders with a line break fails the block."
        },
        {
          term: "body",
          text: "Not sent with GET or HEAD. `{ kind: \"json\", value }`: exactly one `{{ … }}` makes its value the body (text that is already JSON goes as is); otherwise the rendered text must parse as JSON, so embed values with `| json`. Also `{ kind: \"text\", value, contentType? }` and `{ kind: \"form\", fields }`. A matching Content-Type is set unless you set one."
        }
      ]
    },
    {
      title: "Response",
      items: [
        {
          text: "Output `{ status, headers, body }`: header names in lower case; `body` is parsed when the Content-Type is JSON (`application/json`, `…+json`), else text (`\"\"` for HEAD)."
        },
        {
          term: "successStatuses",
          text: "`\"2xx\"` (the default) or a list like `[200, 404]`. Another status fails the block (`http_status`) with the output attached; a connection error fails it with `network`."
        }
      ]
    },
    {
      title: "Limits",
      items: [
        {
          term: "timeoutSeconds",
          text: `${WORKFLOW_LIMITS.httpTimeoutSeconds.default} s by default, at most ${WORKFLOW_LIMITS.httpTimeoutSeconds.max} s. The response body is at most ${mib(WORKFLOW_LIMITS.maxHttpBodyBytes)} (\`limit_exceeded\`). Redirects are followed unless \`followRedirects: false\`.`
        },
        { term: "restart", text: "A GET or HEAD cut off by a daemon restart is sent again; any other method fails `interrupted`." }
      ]
    }
  ],
  if: [
    {
      title: "Branching",
      items: [
        {
          text: "`combine: \"all\"` takes `true` when every rule holds, `\"any\"` when one does; else `false`. Its output is its input, so the blocks after it read the same `input`."
        }
      ]
    },
    ...RULE_SECTIONS
  ],
  switch: [
    {
      title: "Routing",
      items: [
        {
          text: "`cases` are tried in order; the first whose rules hold takes `case:<index>` (from 0). No match: `default` while `fallback` is true (the default), else nothing after it runs. Its output is its input."
        }
      ]
    },
    ...RULE_SECTIONS
  ],
  merge: [
    {
      title: "Joining",
      items: [
        {
          term: "all",
          text: "Runs once every incoming connection has settled and at least one delivered; a branch not taken does not hold it."
        },
        {
          term: "first",
          text: "Runs on the first arrival; the other branches still run but reach nothing through it."
        },
        {
          text: "Output `{ [blockName]: output }` for every branch that arrived. Any block with several incoming connections already waits like `all`, and its `input` is that same object."
        }
      ]
    }
  ],
  stop: [
    {
      title: "Ending",
      items: [
        {
          term: "as",
          text: "`\"success\"` ends the run as `stopped`, `\"failure\"` as `failed`. Blocks still running are cancelled."
        },
        {
          term: "value",
          text: "The run's final output: exactly one `{{ … }}` keeps its raw value, other text renders to text; empty, this block's input."
        },
        { term: "message", text: "A template: the run's message, shown in its history and notification." }
      ]
    }
  ],
  wait: [
    {
      title: "Waiting",
      items: [
        {
          text: "`{ kind: \"duration\", minutes }` (at most 7 days) or `{ kind: \"until\", time: \"HH:MM\", timezone? }` — the next such time in that zone, else the workflow's. It outlives a daemon restart and holds no concurrency slot. Output: its input."
        }
      ]
    }
  ],
  workflow: [
    {
      title: "Child run",
      items: [
        {
          term: "workflowId",
          text: `Another workflow without validation errors — not itself, not one already running above it; nested at most ${WORKFLOW_LIMITS.maxSubWorkflowDepth} deep.`
        },
        {
          term: "input",
          text: "A template (exactly one `{{ … }}` keeps the raw value; empty, this block's input) that the child reads as `trigger.input` — give the child a Manual trigger."
        },
        {
          term: "output",
          text: "The child's final output: its Stop's value, else the output of its last block (in graph order) that succeeded with one. A child that ends `stopped` counts as success; failed or cancelled fails this block (`child_run_failed`)."
        },
        { text: "One block starts exactly one child run: it cannot fan out over a list. No time limit unless the block's `timeoutMinutes` is set." }
      ]
    }
  ],
  note: []
};

// ---------------------------------------------------------------------------
// Expressions
// ---------------------------------------------------------------------------

/** The `{{ … }}` roots, as the guide lists them (`nodes` has three rows). */
export const WORKFLOW_EXPRESSION_ROOT_GUIDE: readonly { root: ExpressionRoot; path: string; text: string }[] = [
  {
    root: "input",
    path: "input",
    text: "The output of the block wired into this one (several live inputs: `{ [blockName]: output }`). In a workflow with no trigger, a block nothing is wired into reads the run's input (`trigger.input`). If, Switch and Wait pass their input on unchanged."
  },
  {
    root: "nodes",
    path: "nodes.<Name>.output",
    text: "Any block's output by its unique name (`nodes.FetchTickets.output.tickets`), once it has finished in this run — wired to this block or not."
  },
  { root: "nodes", path: "nodes.<Name>.status", text: "`succeeded`, `failed`, `skipped` or `cancelled`." },
  { root: "nodes", path: "nodes.<Name>.error", text: "`{ kind, message }` of a failed block." },
  {
    root: "trigger",
    path: "trigger",
    text: "What started the run: `trigger.input` (Run now or a parent workflow's value), the schedule times, the git event."
  },
  { root: "run", path: "run", text: "`{ id, startedAt, workflowId, workflowName, attempt }` (`attempt`: this block's try, from 1)." },
  { root: "project", path: "project", text: "`{ path, name, workspace, branch }`." },
  { root: "secrets", path: "secrets.<NAME>", text: "One workflow secret (never the whole set), redacted wherever it is stored." },
  { root: "workflow", path: "workflow", text: "`{ id, name }` of this workflow." }
];

/** What each filter does; `usage` is how it is written after `|`. */
export const WORKFLOW_EXPRESSION_FILTER_GUIDE: Record<ExpressionFilterName, { usage: string; text: string }> = {
  json: { usage: "json", text: "Pretty JSON text (a text gets quoted): embeds a value in a JSON body. It encodes, never parses." },
  compact: { usage: "compact", text: "One-line JSON text." },
  default: { usage: "default(\"x\")", text: "`x` when the value is missing, `null` or empty text." },
  trim: { usage: "trim", text: "The text without surrounding whitespace." },
  lines: { usage: "lines(5)", text: "The first n lines." },
  first: { usage: "first", text: "The first item of a list (or character of a text)." },
  last: { usage: "last", text: "The last item of a list (or character of a text)." },
  length: { usage: "length", text: "The number of items, characters or keys." },
  upper: { usage: "upper", text: "Upper case." },
  lower: { usage: "lower", text: "Lower case." }
};

/** The warning a path that reads nothing leaves on the block (expressions.ts), for the example below. */
const MISSING_PATH_EXAMPLE = "{{ input.text.severity }} is empty: nothing at input.text.severity";

/** How templates are read and rendered. */
export const WORKFLOW_EXPRESSION_RULES: readonly WorkflowGuideItem[] = [
  {
    term: "fields",
    text: "Templates: agent prompts and chat titles, Shell `env` values, the HTTP URL, query, header values and body, If/Switch rule sides, Stop `value` and `message`, Run workflow `input`. A Code source and a Shell script are not."
  },
  {
    term: "paths",
    text: "Start at a root and walk `.name`, `[0]` (a list item) or `[\"key with spaces\"]`; `.length` reads a list's length (use `| length` otherwise)."
  },
  { term: "text", text: "A value that is not text is inserted as pretty JSON." },
  {
    term: "raw value",
    text: "Exactly one `{{ … }}` (spaces around allowed) keeps the raw value in a rule's left side, a Stop `value`, a Run workflow `input` and an HTTP JSON body; a number stays a number."
  },
  {
    term: "missing",
    text: `A path that reads nothing inserts nothing, and the block records a warning like \`${MISSING_PATH_EXAMPLE}\`.`
  },
  {
    term: "no parsing",
    text: "Templates never parse JSON text: an agent's `text` is a string, so `{{ input.text.severity }}` reads nothing. Parse it in a Code block (`JSON.parse`) and read the fields of its output; `| json` only encodes."
  },
  { term: "escape", text: "Write `\\{{` for a literal `{{`." }
];

export const WORKFLOW_SECRETS_GUIDE: readonly WorkflowGuideItem[] = [
  {
    term: "where",
    text: "`{{ secrets.NAME }}` works in any template field — an HTTP header value, URL or query; a Shell `env` value (the script reads `\"$NAME\"`) — and `secrets.NAME` in Code."
  },
  {
    term: "agent prompts",
    text: "In an agent prompt a secret is allowed, with a `secret_in_prompt` warning, but its value lands in the agent's transcript: do the authenticated call in HTTP, Code or Shell and hand the agent the result."
  },
  { term: "redaction", text: "Stored outputs, logs and events show `«secret:NAME»` instead of a value; so does a chat title." }
];

function tableCell(text: string): string {
  return text.replace(/\|/g, "\\|");
}

/** The `{{ … }}` / `{variable}` guide, markdown (the editor's help and the MCP's block-types answer). */
export const WORKFLOW_EXPRESSION_GUIDE = `# Expressions

Template fields read the run's data with \`{{ path | filter }}\`.

## Paths

| Root | What it holds |
|---|---|
${WORKFLOW_EXPRESSION_ROOT_GUIDE.map((row) => `| \`${row.path}\` | ${tableCell(row.text)} |`).join("\n")}

${WORKFLOW_EXPRESSION_RULES.map((item) => `- ${item.text}`).join("\n")}

## Filters

| Filter | Result |
|---|---|
${EXPRESSION_FILTERS.map((name) => `| \`${tableCell(WORKFLOW_EXPRESSION_FILTER_GUIDE[name].usage)}\` | ${tableCell(WORKFLOW_EXPRESSION_FILTER_GUIDE[name].text)} |`).join("\n")}

Filters chain left to right: \`{{ nodes.Review.output.text | lines(5) | trim }}\`.

## Prompt variables

Agent prompts also take the saved-prompt variables, in single braces, rendered when the block runs:
${PROMPT_VARIABLES.map((spec) => `\`{${spec.name}}\``).join(", ")} (\`{time}\` in the workflow's time zone). \`{{ … }}\`
renders first, and text it inserts is never read as a variable. \`{{name}}\` with a variable's name is the literal \`{name}\`.

## Shell blocks

A shell script never contains \`{{ … }}\`: map values to environment variables in the block's
\`env\` list (\`TICKETS = {{ nodes.Fetch.output.tickets | compact }}\`) and read \`"$TICKETS"\` in the
script. Text from a git event (branch names, PR titles) is attacker-controlled — it must never
become script text.

## Secrets

${WORKFLOW_SECRETS_GUIDE.map((item) => `- ${item.text}`).join("\n")}
`;

// ---------------------------------------------------------------------------
// Recipes
// ---------------------------------------------------------------------------

/** A short, complete pattern: create_workflow's `nodes` and `edges` (blocks by name) and why it is built so. */
export interface WorkflowRecipe {
  id: string;
  title: string;
  /** Sentences: what the pattern shows and the pitfalls it avoids. */
  notes: readonly string[];
  nodes: readonly WorkflowPatchNodeInput[];
  edges: readonly { source: string; sourceHandle?: string; target: string }[];
}

const CLAUDE = [{ agent: "claude", model: "default" }];
const SLACK_URL = "https://hooks.slack.com/services/{{ secrets.SLACK_PATH }}";

const PARSE_REPLY_SOURCE = [
  "export default async function ({ input }) {",
  "  const match = /\\{[\\s\\S]*\\}/.exec(input.text);",
  "  if (!match) throw new Error(`No JSON in the reply: ${input.text.slice(0, 200)}`);",
  "  return JSON.parse(match[0]);",
  "}",
  ""
].join("\n");

const CLOSE_EACH_SOURCE = [
  "export default async function ({ input, secrets, log }) {",
  "  const results = [];",
  "  for (const issue of input.body.issues) {",
  "    const res = await fetch(`https://api.example.com/issues/${issue.id}/close`, { method: \"POST\", headers: { Authorization: `Bearer ${secrets.API_TOKEN}` } });",
  "    results.push({ id: issue.id, ok: res.ok });",
  "  }",
  "  log(`${results.filter((r) => r.ok).length}/${results.length} closed`);",
  "  return { results, failed: results.filter((r) => !r.ok).length };",
  "}",
  ""
].join("\n");

const ANNOUNCE_SOURCE = [
  "export default async function ({ nodes, secrets }) {",
  "  const tag = nodes.LatestRelease.output.body.tag_name;",
  "  const res = await fetch(secrets.SLACK_WEBHOOK_URL, { method: \"POST\", headers: { \"Content-Type\": \"application/json\" }, body: JSON.stringify({ text: `Published ${tag}` }) });",
  "  if (!res.ok) throw new Error(`Slack: HTTP ${res.status}`);",
  "  return { announced: tag };",
  "}",
  ""
].join("\n");

export const WORKFLOW_RECIPES: readonly WorkflowRecipe[] = [
  {
    id: "chain-agents",
    title: "Chain two agents",
    notes: [
      "`{{ input.text }}` is the reply of the block wired just before; `{{ nodes.Plan.output.text }}` reads any earlier block by name, however far back.",
      "Each agent block starts a new session with its own `chain`, so a later step can use another agent or model. `session: { kind: \"continue\", fromNode: \"Plan\" }` only adds a turn to Plan's own session (same agent): use it to keep one agent's context, never to switch agents."
    ],
    nodes: [
      { type: "trigger.manual", name: "Start", config: { inputExample: "{ \"task\": \"Add a --json flag to the CLI\" }" } },
      {
        type: "agent",
        name: "Plan",
        config: { prompt: { kind: "text", text: "Write a short implementation plan for: {{ trigger.input.task }}. Change no files." }, chain: CLAUDE }
      },
      {
        type: "agent",
        name: "Implement",
        config: { prompt: { kind: "text", text: "Implement this plan in {project}. Reply with a one-line summary.\n{{ input.text }}" }, chain: CLAUDE }
      },
      {
        type: "agent",
        name: "Review",
        config: {
          prompt: { kind: "text", text: "Review the uncommitted changes against the plan.\nPlan:\n{{ nodes.Plan.output.text }}\nSummary: {{ input.text }}" },
          chain: CLAUDE
        }
      }
    ],
    edges: [
      { source: "Start", target: "Plan" },
      { source: "Plan", target: "Implement" },
      { source: "Implement", target: "Review" }
    ]
  },
  {
    id: "agent-json",
    title: "Agent replies in JSON, Code parses it, If branches on a field",
    notes: [
      `An agent's \`text\` is always a string, and templates cannot parse it: \`{{ input.text.severity }}\` inserts nothing and records the warning \`${MISSING_PATH_EXAMPLE}\`. \`| json\` only encodes a value as JSON text.`,
      "Parse it in a Code block (a reply without JSON throws, failing the block); its output is a real object: `{{ input.severity }}`, `{{ nodes.Parse.output.summary }}`.",
      "If passes its input on, so Page still reads Parse's object as `input`."
    ],
    nodes: [
      { type: "trigger.manual", name: "Start" },
      {
        type: "agent",
        name: "Triage",
        config: {
          prompt: {
            kind: "text",
            text: "Classify the newest error in logs/app.log. Reply with ONLY this JSON: {\"severity\": \"high\" or \"low\", \"summary\": \"one line\"}"
          },
          chain: CLAUDE
        }
      },
      { type: "code", name: "Parse", config: { source: PARSE_REPLY_SOURCE } },
      { type: "if", name: "Urgent", config: { combine: "all", rules: [{ left: "{{ input.severity }}", op: "equals", right: "high" }] } },
      {
        type: "http",
        name: "Page",
        config: { method: "POST", url: SLACK_URL, body: { kind: "json", value: "{ \"text\": {{ input.summary | json }} }" } }
      },
      { type: "stop", name: "Calm", config: { as: "success", message: "Low severity: {{ nodes.Parse.output.summary }}" } }
    ],
    edges: [
      { source: "Start", target: "Triage" },
      { source: "Triage", target: "Parse" },
      { source: "Parse", target: "Urgent" },
      { source: "Urgent", sourceHandle: "true", target: "Page" },
      { source: "Urgent", sourceHandle: "false", target: "Calm" }
    ]
  },
  {
    id: "switch-route",
    title: "Route by a value with Switch",
    notes: [
      "Cases are tried in order; the first that holds takes `case:<index>`; no match takes `default` (`fallback: true`).",
      "Run it with input `{ \"type\": \"bug\", \"title\": \"…\" }`: the rules read `{{ trigger.input.type }}`."
    ],
    nodes: [
      { type: "trigger.manual", name: "Start", config: { inputExample: "{ \"type\": \"bug\", \"title\": \"Crash on empty config\" }" } },
      {
        type: "switch",
        name: "Route",
        config: {
          cases: [
            { label: "Bug", combine: "all", rules: [{ left: "{{ trigger.input.type }}", op: "equals", right: "bug" }] },
            { label: "Feature", combine: "all", rules: [{ left: "{{ trigger.input.type }}", op: "equals", right: "feature" }] }
          ],
          fallback: true
        }
      },
      { type: "agent", name: "FixBug", config: { prompt: { kind: "text", text: "Fix this bug in {project}: {{ trigger.input.title }}" }, chain: CLAUDE } },
      {
        type: "agent",
        name: "PlanFeature",
        config: { prompt: { kind: "text", text: "Write a plan, no code, for: {{ trigger.input.title }}" }, chain: CLAUDE }
      },
      { type: "stop", name: "Unknown", config: { as: "failure", message: "Unknown type: {{ trigger.input.type }}" } }
    ],
    edges: [
      { source: "Start", target: "Route" },
      { source: "Route", sourceHandle: "case:0", target: "FixBug" },
      { source: "Route", sourceHandle: "case:1", target: "PlanFeature" },
      { source: "Route", sourceHandle: "default", target: "Unknown" }
    ]
  },
  {
    id: "handle-failure",
    title: "Retry, then handle the failure",
    notes: [
      "`retry` is a block field, not config: the `error` connection is taken only after the last try. `all_burnt` and `limit_exceeded` are never retried.",
      "After `error`, `input` is the failed block's output (Shell `{ stdout, stderr, exitCode }`, e.g. `{{ input.stderr | lines(20) }}`) and `{{ nodes.Deploy.error.message }}` says why.",
      "A handled failure no longer fails the run: the Stop with `as: \"failure\"` keeps it failed (and notified)."
    ],
    nodes: [
      { type: "trigger.schedule", name: "Nightly", config: { preset: { kind: "daily", time: "02:00" }, cron: "0 2 * * *" } },
      {
        type: "shell",
        name: "Deploy",
        config: { script: "./scripts/deploy.sh \"$TARGET\"", env: [{ name: "TARGET", value: "staging" }] },
        retry: { maxTries: 3, delaySeconds: 60 }
      },
      {
        type: "http",
        name: "Alert",
        config: { method: "POST", url: SLACK_URL, body: { kind: "json", value: "{ \"text\": {{ nodes.Deploy.error.message | json }} }" } }
      },
      { type: "stop", name: "Failed", config: { as: "failure", message: "Deploy failed: {{ nodes.Deploy.error.message }}" } }
    ],
    edges: [
      { source: "Nightly", target: "Deploy" },
      { source: "Deploy", sourceHandle: "error", target: "Alert" },
      { source: "Alert", target: "Failed" }
    ]
  },
  {
    id: "each-item",
    title: "Process a list of items",
    notes: [
      "There is no loop or for-each block, and connections cannot form a loop (`cycle`). Iterate inside one block: a Code block's `for … of` (as here; `Promise.all` for parallel calls), or one agent given the whole list (`{{ input.body.issues | json }}`).",
      "A Run workflow block starts exactly one child run, so it cannot fan out per item."
    ],
    nodes: [
      { type: "trigger.manual", name: "Start" },
      {
        type: "http",
        name: "ListOpen",
        config: {
          method: "GET",
          url: "https://api.example.com/issues?state=open",
          headers: [{ name: "Authorization", value: "Bearer {{ secrets.API_TOKEN }}" }]
        }
      },
      { type: "code", name: "CloseEach", config: { source: CLOSE_EACH_SOURCE } }
    ],
    edges: [
      { source: "Start", target: "ListOpen" },
      { source: "ListOpen", target: "CloseEach" }
    ]
  },
  {
    id: "secrets",
    title: "Pass secrets",
    notes: [
      "HTTP: a header value (or the URL). Shell: only through `env` — the script reads `\"$NPM_TOKEN\"`. Code: `secrets.NAME`.",
      "Never in an agent prompt: the value would land in its transcript."
    ],
    nodes: [
      { type: "trigger.manual", name: "Start" },
      {
        type: "http",
        name: "LatestRelease",
        config: {
          method: "GET",
          url: "https://api.github.com/repos/acme/api/releases/latest",
          headers: [{ name: "Authorization", value: "Bearer {{ secrets.GITHUB_TOKEN }}" }]
        }
      },
      {
        type: "shell",
        name: "Publish",
        config: {
          script: "./scripts/publish.sh \"$VERSION\"",
          env: [
            { name: "NPM_TOKEN", value: "{{ secrets.NPM_TOKEN }}" },
            { name: "VERSION", value: "{{ input.body.tag_name }}" }
          ]
        }
      },
      { type: "code", name: "Announce", config: { source: ANNOUNCE_SOURCE } }
    ],
    edges: [
      { source: "Start", target: "LatestRelease" },
      { source: "LatestRelease", target: "Publish" },
      { source: "Publish", target: "Announce" }
    ]
  }
];

// ---------------------------------------------------------------------------
// Markdown renderers (the MCP; the editor renders the structures itself)
// ---------------------------------------------------------------------------

/** Sections as markdown bullets: `- **Title**: term — text; …`. */
export function renderWorkflowGuideSections(sections: readonly WorkflowGuideSection[]): string {
  return sections
    .map((section) => {
      const items = section.items.map((item) => (item.term !== undefined ? `\`${item.term}\`: ${item.text}` : item.text));
      return `- ${section.title} — ${items.join(" ")}`;
    })
    .join("\n");
}

/** One recipe: its notes (and a client's own, e.g. the MCP's tool hints), then its nodes and edges as one line of JSON. */
export function renderWorkflowRecipe(recipe: WorkflowRecipe, extraNotes: readonly string[] = []): string {
  const notes = [...recipe.notes, ...extraNotes].join(" ");
  return `### ${recipe.title}\n\n${notes}\n\n${JSON.stringify({ nodes: recipe.nodes, edges: recipe.edges })}\n`;
}
