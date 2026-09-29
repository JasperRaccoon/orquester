// Automated workflows — starter templates (spec §7.1's empty state): the owner's own examples.
// `buildTemplate` answers a `CreateWorkflowRequest` the rail POSTs as is; every template is created
// DISABLED, so nothing runs before the user has read it.
//
// The chains name models by slug, and validation matches slugs exactly against the host's live
// catalogue. A static slug can go stale (Claude's catalogue lists `opus[1m]`, not `opus`), so the
// Claude blocks name `default` — the slug Claude's catalogue always lists, probed or not — and a
// client with the live catalogue re-resolves each entry when it instantiates a template.

import type { CreateWorkflowRequest } from "./types.ts";

export type WorkflowTemplateId = "nightly-agent" | "jira-fixer" | "release-reviewer";

export interface WorkflowTemplateInfo {
  id: WorkflowTemplateId;
  title: string;
  description: string;
}

export const WORKFLOW_TEMPLATES: readonly WorkflowTemplateInfo[] = [
  {
    id: "nightly-agent",
    title: "Nightly agent task",
    description: "Every night at 02:00, an agent tidies the project: failing tests, small fixes, clear commits."
  },
  {
    id: "jira-fixer",
    title: "Jira ticket fixer",
    description:
      "Every 15 minutes, read new Jira tickets; when there are any, Claude fixes them and the tickets move to Done."
  },
  {
    id: "release-reviewer",
    title: "Release-tag reviewer",
    description: "When a v* tag is pushed, Codex reviews everything since the previous release."
  }
];

export interface BuildTemplateOptions {
  /** The project the workflow targets (`<workspacesDir>/<ws>/<project>`). */
  projectPath: string;
  /** IANA zone for schedules — the creating browser's. */
  timezone: string;
}

const NIGHTLY_PROMPT = `Nightly maintenance for {project} ({date}).

Work on the current branch ({branch}):
- run the test suite and fix failing tests;
- fix small, clearly safe issues you come across (typos, dead code, outdated comments);
- keep every change small, and commit each one with a clear message. Do not push.

Finish with a short summary of what you changed and anything you left for a human.`;

const JIRA_FETCH_SOURCE = `// Finds new Jira tickets. Edit JQL to choose which tickets this workflow fixes.
// Secrets: JIRA_BASE_URL (https://your-site.atlassian.net), JIRA_EMAIL, JIRA_TOKEN (an API token).
const JQL = 'project = PROJ AND status = "To Do" AND labels = orquester-fix ORDER BY created ASC';
const MAX_TICKETS = 5;

export default async function ({ secrets, log, stop }) {
  const base = secrets.JIRA_BASE_URL.replace(/\\/+$/, "");
  const response = await fetch(\`\${base}/rest/api/3/search/jql\`, {
    method: "POST",
    headers: jiraHeaders(secrets),
    body: JSON.stringify({
      jql: JQL,
      maxResults: MAX_TICKETS,
      fields: ["summary", "description", "issuetype", "priority"]
    })
  });
  if (!response.ok) throw new Error(\`Jira search failed: \${response.status} \${await response.text()}\`);
  const data = await response.json();
  const tickets = (data.issues ?? []).map((issue) => ({
    key: issue.key,
    url: \`\${base}/browse/\${issue.key}\`,
    summary: issue.fields?.summary ?? "",
    type: issue.fields?.issuetype?.name ?? "",
    priority: issue.fields?.priority?.name ?? "",
    description: documentText(issue.fields?.description).trim()
  }));
  if (tickets.length === 0) return stop("No new Jira tickets");
  log(\`\${tickets.length} ticket(s): \${tickets.map((ticket) => ticket.key).join(", ")}\`);
  return { tickets };
}

function jiraHeaders(secrets) {
  const auth = Buffer.from(\`\${secrets.JIRA_EMAIL}:\${secrets.JIRA_TOKEN}\`).toString("base64");
  return { Authorization: \`Basic \${auth}\`, Accept: "application/json", "Content-Type": "application/json" };
}

// Jira Cloud returns descriptions in Atlassian Document Format: flatten it to text.
function documentText(node) {
  if (!node) return "";
  if (typeof node === "string") return node;
  if (node.type === "text") return node.text ?? "";
  const inner = (node.content ?? []).map(documentText).join("");
  return ["paragraph", "heading", "listItem", "codeBlock"].includes(node.type) ? \`\${inner}\\n\` : inner;
}
`;

const JIRA_FIX_PROMPT = `You are fixing Jira tickets in the {project} repository, on branch {branch}.

The tickets, as JSON:
{{ nodes.FetchTickets.output.tickets | json }}

For each ticket: understand the problem, fix it in this repository, and add or update tests where it
makes sense. Run the project's tests and linters before you finish. Commit each fix separately with
the ticket key at the start of the message (e.g. "PROJ-123: …"). Do not push.

When you are done, reply with ONLY this JSON object and no other text:
{"fixed": ["PROJ-1"], "skipped": [{"key": "PROJ-2", "reason": "why it was not fixed"}]}`;

const JIRA_DONE_SOURCE = `// Moves the tickets the agent fixed to Done.
const DONE = "done";

export default async function ({ nodes, secrets, log }) {
  const reply = parseReply(nodes.FixTickets.output.text);
  const base = secrets.JIRA_BASE_URL.replace(/\\/+$/, "");
  const headers = jiraHeaders(secrets);
  const moved = [];
  const failed = [];
  for (const key of reply.fixed ?? []) {
    const url = \`\${base}/rest/api/3/issue/\${encodeURIComponent(key)}/transitions\`;
    const list = await fetch(url, { headers });
    if (!list.ok) {
      failed.push({ key, error: \`listing transitions: HTTP \${list.status}\` });
      continue;
    }
    const { transitions = [] } = await list.json();
    const done = transitions.find(
      (transition) => transition.name?.toLowerCase() === DONE || transition.to?.name?.toLowerCase() === DONE
    );
    if (!done) {
      failed.push({ key, error: "no transition to Done" });
      continue;
    }
    const moveResponse = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ transition: { id: done.id } })
    });
    if (moveResponse.ok) moved.push(key);
    else failed.push({ key, error: \`transition: HTTP \${moveResponse.status}\` });
  }
  log(\`Moved to Done: \${moved.join(", ") || "none"}\`);
  if (failed.length > 0 && moved.length === 0) {
    throw new Error(\`No ticket could be moved to Done: \${JSON.stringify(failed)}\`);
  }
  return { moved, failed, skipped: reply.skipped ?? [] };
}

function parseReply(text) {
  const match = /\\{[\\s\\S]*\\}/.exec(text ?? "");
  if (!match) throw new Error("The agent's reply has no JSON object");
  return JSON.parse(match[0]);
}

function jiraHeaders(secrets) {
  const auth = Buffer.from(\`\${secrets.JIRA_EMAIL}:\${secrets.JIRA_TOKEN}\`).toString("base64");
  return { Authorization: \`Basic \${auth}\`, Accept: "application/json", "Content-Type": "application/json" };
}
`;

const RELEASE_PROMPT = `A new release tag, {{ trigger.tag }} ({{ trigger.sha }}), was pushed to {project}.

Review everything since the previous release tag: find it with
\`git describe --tags --abbrev=0 {{ trigger.sha }}^\`, then read the log and the diff between the two.
Look for bugs, security problems, breaking changes, missing migrations and missing tests.
Do not modify any file.

Reply with a Markdown review: a one-line verdict (ship / hold) first, then the findings ordered by
severity, each with the file and line.`;

/** The create request for a starter template. */
export function buildTemplate(id: WorkflowTemplateId, opts: BuildTemplateOptions): CreateWorkflowRequest {
  const project = { kind: "existing" as const, projectPath: opts.projectPath };
  const settings = { timezone: opts.timezone };
  switch (id) {
    case "nightly-agent":
      return {
        name: "Nightly agent task",
        description: "Every night at 02:00, an agent tidies the project.",
        enabled: false,
        project,
        settings,
        autoLayout: true,
        nodes: [
          {
            type: "trigger.schedule",
            name: "Nightly",
            config: { preset: { kind: "daily", time: "02:00" }, cron: "0 2 * * *" }
          },
          {
            type: "agent",
            name: "NightlyTask",
            config: {
              prompt: { kind: "text", text: NIGHTLY_PROMPT },
              session: { kind: "new", title: "Nightly task" },
              chain: [{ agent: "claude", model: "default", accounts: { strategy: "least-used" } }]
            }
          }
        ],
        edges: [{ source: "Nightly", target: "NightlyTask" }]
      };
    case "jira-fixer":
      return {
        name: "Jira ticket fixer",
        description: "Every 15 minutes: new Jira tickets → Claude fixes them → the tickets move to Done.",
        enabled: false,
        project,
        settings,
        autoLayout: true,
        nodes: [
          {
            type: "trigger.schedule",
            name: "Every15Min",
            config: { preset: { kind: "minutes", every: 15 }, cron: "*/15 * * * *" }
          },
          { type: "code", name: "FetchTickets", config: { source: JIRA_FETCH_SOURCE, timeoutMinutes: 5 } },
          {
            type: "agent",
            name: "FixTickets",
            config: {
              prompt: { kind: "text", text: JIRA_FIX_PROMPT },
              session: { kind: "new", title: "Jira fixes" },
              chain: [{ agent: "claude", model: "default", accounts: { strategy: "least-used" } }]
            }
          },
          { type: "code", name: "MarkDone", config: { source: JIRA_DONE_SOURCE, timeoutMinutes: 5 } },
          {
            type: "stop",
            name: "Failed",
            config: { as: "failure", message: "The Jira ticket fixer failed — open the failed block for details." }
          },
          {
            type: "note",
            name: "Setup",
            config: {
              text: "Set the secrets JIRA_BASE_URL, JIRA_EMAIL and JIRA_TOKEN, and edit the JQL at the top of FetchTickets.",
              color: "yellow"
            }
          }
        ],
        edges: [
          { source: "Every15Min", target: "FetchTickets" },
          { source: "FetchTickets", target: "FixTickets" },
          { source: "FixTickets", target: "MarkDone" },
          { source: "FetchTickets", sourceHandle: "error", target: "Failed" },
          { source: "FixTickets", sourceHandle: "error", target: "Failed" },
          { source: "MarkDone", sourceHandle: "error", target: "Failed" }
        ]
      };
    case "release-reviewer":
      return {
        name: "Release-tag reviewer",
        description: "On a new v* tag, Codex reviews everything since the previous release.",
        enabled: false,
        project,
        settings,
        autoLayout: true,
        nodes: [
          {
            type: "trigger.git",
            name: "ReleaseTag",
            config: { repo: { kind: "project" }, event: { kind: "tag", pattern: "v*" } }
          },
          {
            type: "agent",
            name: "ReviewRelease",
            config: {
              prompt: { kind: "text", text: RELEASE_PROMPT },
              session: { kind: "new", title: "Release review" },
              chain: [{ agent: "codex", model: "gpt-6-astra", accounts: { strategy: "soonest-reset" } }]
            }
          }
        ],
        edges: [{ source: "ReleaseTag", target: "ReviewRelease" }]
      };
    default: {
      const unknown: never = id;
      throw new Error(`Unknown workflow template "${String(unknown)}"`);
    }
  }
}
