/**
 * Render checks for the trigger inspector forms (`TriggerSettings.tsx`):
 * every schedule mode, the git trigger's repository / event / polling, and
 * the manual trigger's example input.
 *
 * `lib/workflows/trigger-text.test.ts` owns the words; this checks the MARKUP:
 * that each mode shows its plain labels, that every field validation can point
 * at has an anchor and shows its message inline (problems here come from the
 * real `validateWorkflow`, so the field paths are the ones it emits), and that
 * no option went missing.
 *
 * Static markup only — no DOM, no effects (the daemon's cron confirmation and
 * help popovers never run), like every other `*.check.ts`.
 */

import assert from "node:assert/strict";
import { createElement as h, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { validateWorkflow, type Workflow, type WorkflowNode, type WorkflowProblem, type WorkflowSummary } from "@orquester/api";

import { OrquesterProvider, type OrquesterProviderProps } from "../../../context/orquester-context";
import { workflowsStore } from "../../../lib/workflows/store";
import { node as makeNode, workflow as makeWorkflow } from "../../../lib/workflows/testing";
import { InspectorContext, type InspectorContextValue } from "./inspector-context";
import { GitSettings, ManualSettings, ScheduleSettings } from "./TriggerSettings";

const api = { previewWorkflowSchedule: () => new Promise(() => undefined) };

/** Render `form` for `node` inside `wf` (built with `wf` defaults), with the problems the real validator finds. */
function render(form: React.FC, node: WorkflowNode, options: { wf?: Partial<Workflow>; problems?: WorkflowProblem[] } = {}): string {
  const base = makeWorkflow([]);
  const workflow = { ...base, ...options.wf, nodes: [node] } as Workflow;
  const problems = options.problems ?? validateWorkflow(workflow).problems.filter((problem) => problem.nodeId === node.id);
  const context = {
    editor: {} as InspectorContextValue["editor"],
    workflow,
    node,
    readOnly: false,
    projectPath: "",
    secretNames: [],
    scope: {} as InspectorContextValue["scope"],
    promptScope: {} as InspectorContextValue["promptScope"],
    problems,
    openSecrets: () => undefined,
    reveal: null
  } satisfies InspectorContextValue;
  const provider = { runtime: "web", api, useTitlebar: false } as unknown as OrquesterProviderProps;
  const tree = h(OrquesterProvider, { ...provider, children: h(InspectorContext.Provider, { value: context }, h(form)) as ReactElement });
  return renderToStaticMarkup(tree);
}

const schedule = (config: Record<string, unknown>): WorkflowNode => makeNode("s1", "trigger.schedule", config, { name: "Nightly" });
const git = (config: Record<string, unknown>): WorkflowNode => makeNode("g1", "trigger.git", config, { name: "OnPush" });
const manual = (config: Record<string, unknown>): WorkflowNode => makeNode("m1", "trigger.manual", config, { name: "Start" });

const has = (html: string, text: string, why?: string): void => assert.ok(html.includes(text), why ?? `markup has ${JSON.stringify(text)}`);
const lacks = (html: string, text: string, why?: string): void => assert.ok(!html.includes(text), why ?? `markup lacks ${JSON.stringify(text)}`);
/** The radio (or pressed button) labelled `label` is on. */
const checked = (html: string, label: string): void =>
  assert.match(html, new RegExp(`aria-(?:checked|pressed)="true"[^>]*>(?:<[^>]+>)*${label.replace(/[()*]/g, "\\$&")}<`), `${label} is selected`);

// --- Schedule --------------------------------------------------------------

{
  // Weekly (the default "Certain weekdays"): plain frequency labels, chips, quick picks, zone row.
  const html = render(ScheduleSettings, schedule({ preset: { kind: "weekly", days: [1, 2, 3, 4, 5], time: "09:00" }, cron: "0 9 * * 1,2,3,4,5" }), {
    wf: { settings: { ...makeWorkflow([]).settings, timezone: "Europe/Madrid" } }
  });
  for (const label of ["Every few minutes", "Hourly", "Daily", "Certain weekdays", "Monthly", "Custom (cron)"]) has(html, `>${label}<`);
  lacks(html, ">Days<button", "the old 'Days' label is gone");
  checked(html, "Certain weekdays");
  has(html, 'aria-label="How often it runs"');
  has(html, 'aria-label="Days of the week"');
  for (const day of ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]) has(html, `>${day}<`);
  checked(html, "Weekdays");
  has(html, ">Weekends<");
  has(html, ">Every day<");
  has(html, 'data-wf-field="config.preset"');
  has(html, 'data-wf-field="config.preset.days"');
  has(html, 'data-wf-field="config.preset.time"');
  has(html, 'data-wf-field="config.cron"', "the cron's problems have an anchor in preset modes too");
  has(html, 'type="time"');
  has(html, 'value="09:00"');
  has(html, "Weekdays at 09:00", "the headline is the preset in words");
  has(html, "At 09:00, only on Monday, Tuesday, Wednesday, Thursday, and Friday", "with the cron's reading under it");
  has(html, "0 9 * * 1,2,3,4,5", "the raw cron is a secondary chip");
  has(html, "Times are in <span");
  has(html, "Europe/Madrid");
  has(html, "change it in Workflow settings");
  has(html, "Next runs");
  has(html, "The workflow is disabled: it runs on this schedule only once you enable it.");
  lacks(html, "Checked by the daemon");
}

{
  // Every N minutes with a stored uneven value: marked in the select, and the validator's warning inline.
  const html = render(ScheduleSettings, schedule({ preset: { kind: "minutes", every: 45 }, cron: "*/45 * * * *" }));
  checked(html, "Every few minutes");
  has(html, "45 (uneven)");
  has(html, 'aria-label="Minutes between runs"');
  has(html, "cannot run evenly", "the uneven-interval warning (config.preset) shows by the field");
  has(html, "text-warn");
  lacks(html, "(UTC)", "no zone in a minutes schedule's summary");
}

{
  // Hourly: the interval, the minute, and when it starts.
  const html = render(ScheduleSettings, schedule({ preset: { kind: "hours", every: 3, atMinute: 30 }, cron: "30 */3 * * *" }));
  checked(html, "Hourly");
  has(html, 'aria-label="Hours between runs"');
  has(html, 'aria-label="Minutes past the hour"');
  has(html, "Counted from midnight: 00:30, 03:30, 06:30, …");
}

{
  // A preset whose cron was changed elsewhere: headline from the cron, warning + both ways out, in preset mode.
  const html = render(ScheduleSettings, schedule({ preset: { kind: "daily", time: "09:00" }, cron: "0 10 * * *" }));
  checked(html, "Daily");
  has(html, "The cron doesn&#x27;t match these settings");
  has(html, ">Use these settings<");
  has(html, ">Keep the cron<");
  has(html, "At 10:00", "the headline is what runs: the cron");
}

{
  // Monthly on the 31st: which months it skips, and the last-day alternative.
  const html = render(ScheduleSettings, schedule({ preset: { kind: "monthly", day: 31, time: "08:00" }, cron: "0 8 31 * *" }));
  checked(html, "Monthly");
  has(html, 'data-wf-field="config.preset.day"');
  has(html, "February, April, June, September and November are skipped");
  has(html, ">Use the last day of every month<");
  const plain = render(ScheduleSettings, schedule({ preset: { kind: "monthly", day: 15, time: "08:00" }, cron: "0 8 15 * *" }));
  lacks(plain, "are skipped");
}

{
  // Custom cron: the field, its cheat sheet, and the validator's error inline.
  const html = render(ScheduleSettings, schedule({ preset: { kind: "cron" }, cron: "0 9 * *" }));
  checked(html, "Custom (cron)");
  has(html, ">Cron expression<");
  has(html, 'aria-label="About Cron expression"', "the cron cheat sheet");
  has(html, "A cron has 5 fields");
  has(html, "font-mono");
  const good = render(ScheduleSettings, schedule({ preset: { kind: "cron" }, cron: "*/15 * * * *" }));
  has(good, "Every 15 minutes", "a custom cron's headline is in words");
  lacks(good, "A cron has 5 fields");
}

// --- Git -------------------------------------------------------------------

{
  // This workflow's project, push: where it points, polling, branches.
  const html = render(GitSettings, git({ repo: { kind: "project" }, event: { kind: "push", branches: [] } }));
  checked(html, "This workflow&#x27;s project");
  has(html, ">Another repository<");
  has(html, "Watches the project&#x27;s origin remote");
  has(html, "Checked about once a minute, not instantly.");
  has(html, "Nothing is checked while the workflow is disabled.");
  for (const label of ["Push", "New tag", "Release", "Pull request"]) has(html, `>${label}<`);
  checked(html, "Push");
  has(html, 'data-wf-field="config.event.branches"');
  has(html, ">Branches<");
  has(html, ">optional<");
  has(html, 'aria-label="About Branches"', "glob help");
  has(html, "Empty = the default branch");
  lacks(html, "Treat its text as untrusted");
}

{
  // Another repository, release on Bitbucket: access labels, the GitHub-only warning inline, untrusted text.
  const html = render(GitSettings, git({ repo: { kind: "url", url: "https://bitbucket.org/acme/app" }, event: { kind: "release", includePrereleases: false } }));
  checked(html, "Another repository");
  has(html, ">Access<");
  has(html, "Public repository (no sign-in)");
  has(html, 'data-wf-field="config.repo.accountId"');
  has(html, 'data-wf-field="config.repo.url"');
  has(html, "releases are read from GitHub only", "release_github_only (a warning on config.event) shows");
  lacks(html, "GitHub only — on Bitbucket, use New tag.", "the hint steps aside for the warning");
  has(html, "Include pre-releases");
  has(html, "Treat its text as untrusted");
  has(html, "Release notes are written by whoever publishes the release.");
  has(html, "every 2 minutes");
}

{
  // A release on GitHub: the hint, no warning.
  const html = render(GitSettings, git({ repo: { kind: "url", url: "https://github.com/acme/app" }, event: { kind: "release", includePrereleases: true } }));
  has(html, "GitHub only — on Bitbucket, use New tag.");
  lacks(html, "releases are read from GitHub only");
}

{
  // Pull requests: plain action labels, pressed state, base branches, untrusted text.
  const html = render(GitSettings, git({ repo: { kind: "project" }, event: { kind: "pull_request", actions: ["opened", "updated"] } }));
  checked(html, "Pull request");
  has(html, 'aria-label="Pull request actions"');
  checked(html, "Opened");
  checked(html, "New commits");
  has(html, ">Merged<");
  has(html, ">Closed without merging<");
  assert.match(html, /aria-pressed="false"[^>]*>Merged</);
  has(html, 'data-wf-field="config.event.actions"');
  has(html, 'data-wf-field="config.event.baseBranches"');
  has(html, ">Into branches<");
  has(html, "Pull request titles and descriptions are written by whoever opens them.");
  has(html, "(3 on Bitbucket Cloud)");
}

{
  // A tag pattern is labelled; an unknown account stays visible instead of reading as "public".
  const html = render(GitSettings, git({ repo: { kind: "url", url: "git@github.com:acme/app.git", accountId: "gone" }, event: { kind: "tag", pattern: "v*" } }));
  has(html, 'aria-label="Tag pattern"');
  has(html, 'data-wf-field="config.event.pattern"');
  assert.match(html, /<option value="gone" selected="">Unknown account \(gone\)<\/option>/);
}

{
  // An empty URL says what to do (the schema's message is for machines).
  const node = { ...git({}), config: { repo: { kind: "url", url: "" }, event: { kind: "push", branches: [] } } } as WorkflowNode;
  const html = render(GitSettings, node, { problems: [] });
  has(html, "Pick a repository or paste its URL.");
}

{
  // A temporary workflow that starts empty has nothing to watch.
  const html = render(GitSettings, git({ repo: { kind: "project" }, event: { kind: "push", branches: [] } }), {
    wf: { project: { kind: "temp", workspace: "ws", source: { kind: "empty" } } }
  });
  has(html, "starts in an empty folder");
  const clone = render(GitSettings, git({ repo: { kind: "project" }, event: { kind: "push", branches: [] } }), {
    wf: { project: { kind: "temp", workspace: "ws", source: { kind: "clone", url: "https://github.com/acme/app.git" } } }
  });
  has(clone, "acme/app");
  has(clone, "the repository this workflow clones");
}

{
  // Live status: a failed check, then a successful one on an enabled workflow.
  const summary = (trigger: Record<string, unknown>) =>
    new Map([["wf-1", { id: "wf-1", triggers: [{ nodeId: "g1", type: "trigger.git", text: "", ...trigger }] } as unknown as WorkflowSummary]]);
  const before = workflowsStore.getState();
  workflowsStore.setState({ summaries: summary({ lastError: "Repository not found." }) });
  const failed = render(GitSettings, git({ repo: { kind: "project" }, event: { kind: "push", branches: [] } }), { wf: { enabled: true } });
  has(failed, "The last check failed");
  has(failed, "Repository not found.");
  workflowsStore.setState({ summaries: summary({ lastPollAt: new Date(Date.now() - 5 * 60_000).toISOString() }) });
  const polled = render(GitSettings, git({ repo: { kind: "project" }, event: { kind: "push", branches: [] } }), { wf: { enabled: true } });
  has(polled, "Last checked 5m ago.");
  workflowsStore.setState(before, true);
}

// --- Manual ----------------------------------------------------------------

{
  const html = render(ManualSettings, manual({ inputExample: '{"ticket":"PROJ-1"}' }));
  has(html, "Starts the workflow from the toolbar");
  has(html, "even while the workflow is disabled");
  has(html, ">Example input<");
  has(html, 'data-wf-field="config.inputExample"');
  has(html, "{{ trigger.input }}");
  has(html, 'aria-label="Copy {{ trigger.input }}"');
  assert.match(html, /<button type="button"(?![^>]*disabled="")[^>]*>Format JSON<\/button>/, "Format JSON is offered for unformatted JSON");
  has(html, "<textarea");
  has(html, "font-mono");
}

{
  const html = render(ManualSettings, manual({ inputExample: '{\n  "a": 1\n  "b": 2\n}' }));
  has(html, "Not valid JSON — line 3, column 3");
  assert.match(html, /<button type="button"[^>]*disabled=""[^>]*>Format JSON<\/button>/, "nothing to format while it is not JSON");
  const formatted = render(ManualSettings, manual({ inputExample: '{\n  "a": 1\n}' }));
  assert.match(formatted, /<button type="button"[^>]*disabled=""[^>]*>Format JSON<\/button>/, "already formatted");
  lacks(formatted, "Not valid JSON");
}

console.log("trigger-settings-render.check: ok");
