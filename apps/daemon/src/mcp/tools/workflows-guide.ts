// The authoring guide `list_workflow_block_types` returns beside the block catalogue and the expression guide:
// the rules an agent needs to build a workflow that validates and runs, and one worked example end to end.
// Tool descriptions are capped at 400 characters (server.test.ts), so the teaching lives here.

/** The worked example's create_workflow arguments (a Jira fixer): also exercised by the tests, so it stays valid. */
export const JIRA_FIXER_EXAMPLE = {
  name: "Jira fixer",
  description: "Every 15 minutes: new Jira tickets → Claude fixes them → the tickets move to Done.",
  project: { kind: "existing", project: "acme/api" },
  nodes: [
    { type: "trigger.schedule", name: "Every15Min", config: { preset: { kind: "minutes", every: 15 }, cron: "*/15 * * * *" } },
    {
      type: "code",
      name: "FetchTickets",
      config: {
        source:
          "export default async function ({ secrets, log }) {\n  const res = await fetch(`${secrets.JIRA_BASE_URL}/rest/api/3/search/jql`, { method: \"POST\", headers: { Authorization: `Basic ${secrets.JIRA_AUTH}`, \"Content-Type\": \"application/json\" }, body: JSON.stringify({ jql: \"labels = orquester-fix AND status = \\\"To Do\\\"\", fields: [\"summary\", \"description\"] }) });\n  if (!res.ok) throw new Error(`Jira: HTTP ${res.status}`);\n  const tickets = ((await res.json()).issues ?? []).map((i) => ({ key: i.key, summary: i.fields.summary }));\n  log(`${tickets.length} ticket(s)`);\n  return { tickets };\n}\n"
      }
    },
    {
      type: "if",
      name: "HasTickets",
      config: { combine: "all", rules: [{ left: "{{ nodes.FetchTickets.output.tickets | length }}", op: "gt", right: "0" }] }
    },
    { type: "stop", name: "NothingToDo", config: { as: "success", message: "No new tickets" } },
    {
      type: "agent",
      name: "FixTickets",
      config: {
        prompt: {
          kind: "text",
          text: "Fix these Jira tickets in {project} on {branch}, one commit per ticket (\"KEY: …\"). Do not push.\n{{ nodes.FetchTickets.output.tickets | json }}\nReply with ONLY this JSON: {\"fixed\": [\"KEY-1\"]}"
        },
        chain: [{ agent: "claude", model: "opus" }]
      }
    },
    {
      type: "code",
      name: "MarkDone",
      config: {
        source:
          "export default async function ({ nodes, secrets }) {\n  const { fixed } = JSON.parse(/\\{[\\s\\S]*\\}/.exec(nodes.FixTickets.output.text)[0]);\n  for (const key of fixed) {\n    await fetch(`${secrets.JIRA_BASE_URL}/rest/api/3/issue/${key}/transitions`, { method: \"POST\", headers: { Authorization: `Basic ${secrets.JIRA_AUTH}`, \"Content-Type\": \"application/json\" }, body: JSON.stringify({ transition: { id: secrets.JIRA_DONE_ID } }) });\n  }\n  return { moved: fixed };\n}\n"
      }
    }
  ],
  edges: [
    { source: "Every15Min", target: "FetchTickets" },
    { source: "FetchTickets", target: "HasTickets" },
    { source: "HasTickets", sourceHandle: "true", target: "FixTickets" },
    { source: "HasTickets", sourceHandle: "false", target: "NothingToDo" },
    { source: "FixTickets", target: "MarkDone" }
  ]
};

/** The follow-up edit of the worked example: update_workflow ops (revision from the create's answer). */
export const JIRA_FIXER_EDIT_OPS = [
  {
    op: "add_node",
    node: {
      type: "http",
      name: "NotifySlack",
      config: {
        method: "POST",
        url: "https://hooks.slack.com/services/{{ secrets.SLACK_PATH }}",
        body: { kind: "json", value: "{ \"text\": {{ nodes.MarkDone.output.moved | compact | json }} }" }
      }
    }
  },
  { op: "connect", source: "MarkDone", target: "NotifySlack" },
  { op: "add_node", node: { type: "stop", name: "Failed", config: { as: "failure", message: "The Jira fixer failed" } } },
  { op: "connect", source: "FixTickets", sourceHandle: "error", target: "Failed" },
  { op: "rename_node", node: "NothingToDo", to: "NoTickets" },
  { op: "update_node", node: "Every15Min", set: { config: { preset: { kind: "hours", every: 1, atMinute: 0 }, cron: "0 * * * *" } } }
];

export const WORKFLOW_AUTHORING_GUIDE = `# Authoring workflows through the MCP

1. A workflow is a directed acyclic graph of blocks (nodes). An edge goes from one block's output
   handle to the next block. A run starts at a trigger (trigger.manual, trigger.schedule,
   trigger.git); run_workflow starts one by hand, from any trigger, even while the workflow is
   disabled.
2. Every block has a unique name ([A-Za-z][A-Za-z0-9_]*, at most 40). Edges and patch ops name
   blocks by name (or id). A block reads an earlier block's output with
   {{ nodes.<Name>.output… }} (e.g. {{ nodes.FetchTickets.output.tickets | json }}); {{ input }}
   is the output of the block feeding it. rename_node rewrites every {{ }} reference, but NOT a
   name inside a code block's JavaScript (nodes.FixTickets.output…): fix those with update_node.
3. Output handles: triggers \`success\`; agent, code, shell, http, merge, wait and workflow
   \`success\` and \`error\`; if \`true\` / \`false\` / \`error\`; switch \`case:0\`, \`case:1\`, …,
   \`default\`, \`error\`; stop and note have none. An edge without sourceHandle is \`success\`.
   A block that fails with no \`error\` edge fails the run; with one, the run goes on down it.
   A block whose incoming edges are all dead (an if's other branch) is skipped.
4. Shell: NEVER put {{ }} in \`script\` (validation refuses it). Map values to environment
   variables in \`env\`, e.g. [{"name":"TICKETS","value":"{{ nodes.Fetch.output.tickets | compact }}"}],
   and read "$TICKETS" in the script. Exit code 0 = success; output {stdout, stderr, exitCode}.
5. Code: an ES module whose default export is
   \`async function ({ input, nodes, trigger, secrets, log, stop })\`; its return value (JSON) is
   the output; a throw fails the block; stop(reason) ends the run as stopped. \`fetch\` is global.
6. Agent: runs the prompt in a NEW chat session, full-access and unattended (no approvals, no
   questions), until the agent finishes; output {text, sessionId, agent, model, accountId,
   durationMs, hops}. \`text\` is the final message: ask for JSON in the prompt to parse it
   downstream. \`chain\` is the agent/model fallback order on usage limits (list_agents names the
   models); accounts are picked by usage. Prompts also take {project}, {branch}, {diff}, {date}….
7. Secrets: {{ secrets.NAME }} in HTTP fields and shell env values, secrets.NAME in code. A secret
   in an agent prompt lands in the agent's transcript. list_workflow_secrets names them;
   set_workflow_secret sets one (its value lands in YOUR transcript — prefer asking the user).
8. Edit with update_workflow, never by recreating: call get_workflow first for the current
   \`revision\`, then send only what changes. update_node's set.config merges ONE level deep: a
   top-level config key you send replaces that key whole (send the whole \`prompt\` object, the
   whole \`rules\` list); \`null\` removes a key. The whole batch applies or none of it.
9. New workflows are created disabled. Fix every problem of severity "error", then
   update_workflow [{"op":"set_enabled","enabled":true}] — schedule and git triggers fire only
   while enabled. run_workflow {wait:true} tests it; get_workflow_run shows each block.

## Worked example: a Jira fixer

"Every 15 minutes fetch new Jira tickets; if there are none stop; else let Claude fix them and
mark them done":

create_workflow ${JSON.stringify(JIRA_FIXER_EXAMPLE)}

Then set its secrets (JIRA_BASE_URL, JIRA_AUTH, JIRA_DONE_ID — or ask the user to) and edit it
without resending it: notify Slack, route a failed fix to a failing Stop, rename a block, run
hourly (revision = the one create_workflow or get_workflow returned):

update_workflow {"workflowId":"<id>","revision":0,"ops":${JSON.stringify(JIRA_FIXER_EDIT_OPS)}}

Finally run_workflow {"workflowId":"<id>","wait":true} and, once it works,
update_workflow ops [{"op":"set_enabled","enabled":true}].
`;
