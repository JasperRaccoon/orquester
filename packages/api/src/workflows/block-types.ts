// Automated workflows — the block catalogue: titles, descriptions, output shapes, default configs,
// default names and the expression guide (spec §4). Served to the editor palette and to the MCP's
// `list_workflow_block_types`.

import {
  WORKFLOW_NODE_CATEGORY,
  type WorkflowNodeCategory,
  type WorkflowNodeConfig,
  type WorkflowNodeType
} from "./types.ts";

export interface WorkflowBlockCatalogEntry {
  type: WorkflowNodeType;
  title: string;
  description: string;
  category: WorkflowNodeCategory;
  /** What `nodes.<Name>.output` holds, in words. */
  output: string;
  /** A complete, valid `config` showing the block's typical use. */
  example: unknown;
}

/**
 * A sub-workflow block needs a workflow id, and a fresh block has none yet: this placeholder keeps
 * the config valid; `validateWorkflow` reports it (`subworkflow_unset`) until one is picked.
 */
export const UNSET_SUBWORKFLOW_ID = "unset";

const CODE_EXAMPLE = `// input: the previous block's output; nodes.<Name>.output: any upstream block's output.
// secrets.<NAME>: workflow secrets. stop(reason): end the run as "stopped". log(...): to the block log.
export default async function ({ input, nodes, trigger, secrets, log, stop }) {
  const response = await fetch("https://api.example.com/items", {
    headers: { Authorization: \`Bearer \${secrets.API_TOKEN}\` }
  });
  const items = await response.json();
  if (items.length === 0) stop("Nothing new");
  log(\`\${items.length} new items\`);
  return { items };
}
`;

const DEFAULT_CODE = `export default async function ({ input, nodes, trigger, secrets, log, stop }) {
  // Return any JSON value: it becomes this block's output.
  return { ok: true };
}
`;

export const WORKFLOW_BLOCK_CATALOG: Record<WorkflowNodeType, WorkflowBlockCatalogEntry> = {
  "trigger.manual": {
    type: "trigger.manual",
    title: "Manual trigger",
    description: "Starts the workflow from “Run now” (the editor, the rail or the MCP), with optional JSON input.",
    category: WORKFLOW_NODE_CATEGORY["trigger.manual"],
    output: "{ kind: \"manual\", input } — `input` is the JSON given to Run now (null when none).",
    example: { inputExample: '{ "ticket": "PROJ-123" }' }
  },
  "trigger.schedule": {
    type: "trigger.schedule",
    title: "Schedule",
    description:
      "Starts the workflow on a schedule — every N minutes or hours, daily, on chosen weekdays, monthly, or a cron — in the workflow's time zone.",
    category: WORKFLOW_NODE_CATEGORY["trigger.schedule"],
    output: "{ kind: \"schedule\", firedAt, scheduledFor } (ISO times).",
    example: { preset: { kind: "weekly", days: [1, 5], time: "16:00" }, cron: "0 16 * * 1,5" }
  },
  "trigger.git": {
    type: "trigger.git",
    title: "Git event",
    description:
      "Starts the workflow on a push to a branch, a new tag, a release (GitHub) or a pull request opened, updated, merged or closed. Polled, never a webhook.",
    category: WORKFLOW_NODE_CATEGORY["trigger.git"],
    output:
      "{ kind: \"git\", event, repo: { url, name }, ref, sha, previousSha?, branch?, tag?, release?: { id, name, tag, body, url, prerelease }, pr?: { number, title, body, url, author, head, base, action, headSha } }. PR titles/bodies and release notes are untrusted text.",
    example: { repo: { kind: "project" }, event: { kind: "tag", pattern: "v*" } }
  },
  agent: {
    type: "agent",
    title: "Agent",
    description:
      "Runs a coding agent (Claude, Codex, Grok, OpenCode…) in the project with a prompt, fully autonomous. Picks the account by usage and fails over across accounts and agents on usage limits.",
    category: WORKFLOW_NODE_CATEGORY.agent,
    output:
      "{ text, sessionId, agent, model, accountId, durationMs, hops } — `text` is the agent's final message (ask for JSON in the prompt to get structured data).",
    example: {
      prompt: { kind: "text", text: "Fix the failing tests in {project} on {branch}. Reply with a one-line summary." },
      session: { kind: "new", title: "Nightly test fix" },
      chain: [
        { agent: "claude", model: "opus", accounts: { strategy: "least-used", maxWeeklyPct: 85 } },
        { agent: "codex", model: "gpt-5.5", accounts: { strategy: "soonest-reset" } }
      ],
      autonomyNote: true,
      whenOnlyWatchLoopsRemain: "finish",
      whenAllBurnt: { kind: "fail" },
      maxMinutes: 240
    }
  },
  code: {
    type: "code",
    title: "Code",
    description:
      "Runs JavaScript (an ES module's default export) in a sandboxed Node process. `fetch` is global; `require` resolves the project's packages.",
    category: WORKFLOW_NODE_CATEGORY.code,
    output: "The function's return value (JSON). A throw fails the block; stop(reason) ends the run as stopped.",
    example: { source: CODE_EXAMPLE, timeoutMinutes: 10 }
  },
  shell: {
    type: "shell",
    title: "Shell",
    description:
      "Runs a bash or sh script in the project directory. Values reach the script only through environment variables — never {{ … }} in the script itself.",
    category: WORKFLOW_NODE_CATEGORY.code,
    output: "{ stdout, stderr, exitCode } (the tail of each stream). Exit code 0 = success.",
    example: {
      script: 'git tag --list "$PATTERN" | tail -n 5',
      shell: "bash",
      env: [{ name: "PATTERN", value: "{{ trigger.tag | default(\"v*\") }}" }]
    }
  },
  http: {
    type: "http",
    title: "HTTP request",
    description: "Calls a URL. Headers, query, body and URL accept {{ … }}, secrets included.",
    category: WORKFLOW_NODE_CATEGORY.http,
    output: "{ status, headers, body } — `body` is parsed when the response is JSON.",
    example: {
      method: "POST",
      url: "https://hooks.slack.com/services/{{ secrets.SLACK_PATH }}",
      headers: [{ name: "Content-Type", value: "application/json" }],
      query: [],
      body: { kind: "json", value: '{ "text": {{ nodes.Review.output.text | json }} }' },
      successStatuses: "2xx",
      followRedirects: true
    }
  },
  if: {
    type: "if",
    title: "If",
    description: "Branches on conditions: the `true` output when they hold, else `false`.",
    category: WORKFLOW_NODE_CATEGORY.if,
    output: "Its input, passed through.",
    example: { combine: "all", rules: [{ left: "{{ nodes.Fetch.output.items | length }}", op: "gt", right: "0" }] }
  },
  switch: {
    type: "switch",
    title: "Switch",
    description: "Routes to the first case whose conditions hold (`case:0`, `case:1`, …), else to `default`.",
    category: WORKFLOW_NODE_CATEGORY.switch,
    output: "Its input, passed through.",
    example: {
      cases: [
        { label: "Bug", combine: "any", rules: [{ left: "{{ input.type }}", op: "equals", right: "bug" }] },
        { label: "Feature", combine: "any", rules: [{ left: "{{ input.type }}", op: "equals", right: "feature" }] }
      ],
      fallback: true
    }
  },
  merge: {
    type: "merge",
    title: "Merge",
    description:
      "Joins branches: waits for every live input (`all`) or goes on with the first to arrive (`first`).",
    category: WORKFLOW_NODE_CATEGORY.merge,
    output: "{ [blockName]: output } for every branch that arrived.",
    example: { mode: "all" }
  },
  stop: {
    type: "stop",
    title: "Stop",
    description: "Ends the run — as a success or as a failure — with an optional message and final value.",
    category: WORKFLOW_NODE_CATEGORY.stop,
    output: "Ends the run; its value becomes the run's final output.",
    example: { as: "failure", message: "The ticket fixer failed", value: "{{ input }}" }
  },
  wait: {
    type: "wait",
    title: "Wait",
    description: "Pauses the branch for a duration or until a time of day (at most 7 days).",
    category: WORKFLOW_NODE_CATEGORY.wait,
    output: "Its input, passed through.",
    example: { kind: "until", time: "09:00" }
  },
  workflow: {
    type: "workflow",
    title: "Run workflow",
    description: "Runs another workflow and waits for it to finish.",
    category: WORKFLOW_NODE_CATEGORY.workflow,
    output: "The child run's final output (its last succeeded block's output, or its Stop value).",
    example: { workflowId: "00000000-0000-4000-8000-000000000000", input: "{{ input }}" }
  },
  note: {
    type: "note",
    title: "Sticky note",
    description: "A note on the canvas. Never runs, never connects.",
    category: WORKFLOW_NODE_CATEGORY.note,
    output: "None.",
    example: { text: "Runs every night; see the Jira board for context.", color: "yellow" }
  }
};

/** A fresh block's config — valid against its schema. */
export function defaultNodeConfig<T extends WorkflowNodeType>(type: T): WorkflowNodeConfig<T> {
  const configs: { [K in WorkflowNodeType]: WorkflowNodeConfig<K> } = {
    "trigger.manual": {},
    "trigger.schedule": { preset: { kind: "daily", time: "09:00" }, cron: "0 9 * * *" },
    "trigger.git": { repo: { kind: "project" }, event: { kind: "push", branches: [] } },
    agent: {
      prompt: { kind: "text", text: "" },
      session: { kind: "new" },
      chain: [
        {
          agent: "claude",
          model: "opus",
          accounts: {
            strategy: "least-used",
            includeSystem: false,
            soonestResetWindow: "weekly",
            leastUsedMetric: "max",
            unknownUsage: "last"
          }
        }
      ],
      autonomyNote: true,
      whenOnlyWatchLoopsRemain: "finish",
      whenAllBurnt: { kind: "fail" },
      maxMinutes: 240
    },
    code: { source: DEFAULT_CODE },
    shell: { script: 'echo "Hello from $PWD"\n', shell: "bash", env: [] },
    http: {
      method: "GET",
      url: "",
      headers: [],
      query: [],
      successStatuses: "2xx",
      followRedirects: true
    },
    if: { combine: "all", rules: [{ left: "{{ input }}", op: "isNotEmpty" }] },
    switch: {
      cases: [{ label: "Case 1", combine: "all", rules: [{ left: "{{ input }}", op: "equals", right: "" }] }],
      fallback: true
    },
    merge: { mode: "all" },
    stop: { as: "success" },
    wait: { kind: "duration", minutes: 5 },
    workflow: { workflowId: UNSET_SUBWORKFLOW_ID },
    note: { text: "", color: "yellow" }
  };
  // A fresh copy every call: callers mutate what they get.
  return structuredClone(configs[type]) as WorkflowNodeConfig<T>;
}

const DEFAULT_NAME_BASE: Record<WorkflowNodeType, string> = {
  "trigger.manual": "Manual",
  "trigger.schedule": "Schedule",
  "trigger.git": "GitEvent",
  agent: "Agent",
  code: "Code",
  shell: "Shell",
  http: "HTTP",
  if: "If",
  switch: "Switch",
  merge: "Merge",
  stop: "Stop",
  wait: "Wait",
  workflow: "Workflow",
  note: "Note"
};

/** "Agent", then "Agent2", "Agent3", … — the first not in `existingNames`. */
export function defaultNodeName(type: WorkflowNodeType, existingNames: Iterable<string>): string {
  const taken = new Set(existingNames);
  const base = DEFAULT_NAME_BASE[type];
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** The `{{ … }}` / `{variable}` guide, markdown (the editor's help and the MCP's block-types answer). */
export const WORKFLOW_EXPRESSION_GUIDE = `# Expressions

Any text field can read the run's data with \`{{ path | filter }}\`.

## Paths

A path starts at a root and walks \`.name\`, \`[0]\` (a list item) or \`["key with spaces"]\`:

| Root | What it holds |
|---|---|
| \`nodes.<Name>.output\` | a block's output (blocks are named by their unique name, e.g. \`nodes.FetchTickets.output.tickets\`) |
| \`nodes.<Name>.status\` | \`succeeded\`, \`failed\`, \`skipped\`, … |
| \`nodes.<Name>.error\` | \`{ kind, message }\` of a failed block |
| \`input\` | the output of the block feeding this one (with several live inputs, \`{ [name]: output }\`) |
| \`trigger\` | what started the run (schedule time, git event, manual input as \`trigger.input\`) |
| \`run\` | \`{ id, startedAt, workflowId, workflowName, attempt }\` |
| \`project\` | \`{ path, name, workspace, branch }\` |
| \`secrets.<NAME>\` | a workflow secret (redacted everywhere it is stored) |

A value that is not text is inserted as pretty JSON. A path that reads nothing inserts nothing and
the block records a warning. Only a field that is exactly one \`{{ … }}\` (a rule's left side, a
Stop value, a sub-workflow input) keeps the raw value — a number stays a number.

## Filters

| Filter | Result |
|---|---|
| \`json\` | pretty JSON (text is quoted — use it to embed a value in a JSON body) |
| \`compact\` | one-line JSON |
| \`default("x")\` | \`x\` when the value is missing, null or empty |
| \`trim\` | text without surrounding whitespace |
| \`lines(n)\` | the first n lines |
| \`first\` / \`last\` | the first / last item of a list (or character of a text) |
| \`length\` | the number of items, characters or keys |
| \`upper\` / \`lower\` | upper / lower case |

Filters chain left to right: \`{{ nodes.Review.output.text | lines(5) | trim }}\`.
Write \`\\{{\` for a literal \`{{\`.

## Prompt variables

Agent prompts also take the saved-prompt variables, in single braces, rendered when the block runs:
\`{project}\`, \`{workspace}\`, \`{projectPath}\`, \`{branch}\`, \`{changedFiles}\`, \`{diff}\`, \`{date}\`,
\`{time}\` (in the workflow's time zone), \`{agent}\`, \`{model}\`. \`{{ … }}\` renders first, and text
it inserts is never read as a variable. \`{{name}}\` with a variable's name is the literal \`{name}\`.

## Shell blocks

A shell script never contains \`{{ … }}\`: map values to environment variables in the block's
\`env\` list (\`TICKETS = {{ nodes.Fetch.output.tickets | compact }}\`) and read \`"$TICKETS"\` in the
script. Text from a git event (branch names, PR titles) is attacker-controlled — it must never
become script text.

## Secrets

\`{{ secrets.NAME }}\` works in HTTP fields, shell env values and code (\`secrets.NAME\`). In an agent
prompt it is allowed but the value lands in the agent's transcript. Values are replaced by
\`«secret:NAME»\` in every stored output, log and event.
`;
