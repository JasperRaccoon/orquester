/**
 * Render smoke checks for the run view's components.
 *
 * `lib/workflows/run-view.test.ts` owns the rules; this exists because "the
 * agent block shows its hops and Open session", "a skipped run is muted with
 * its reason", "a failed run offers Retry from failed block" and "every phone
 * target is 40 px" are claims about MARKUP — a prop mistake typechecks
 * perfectly while rendering nothing.
 *
 * Static markup only — no DOM, no effects — like every other `*.check.ts`.
 */

import assert from "node:assert/strict";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { BlockRunDetails } from "./BlockRunDetails";
import { LogViewerView } from "./LogViewer";
import { RunHeader } from "./RunHeader";
import { RunsList } from "./RunsList";
import { RunTimeline } from "./RunTimeline";
import { WorkflowAttentionRows } from "./WorkflowAttention";
import { WorkflowRunToastCard } from "./WorkflowRunToast";
import { FIXTURE_API, FIXTURE_LOG_LINES, FIXTURE_NOW, FIXTURE_RUNS, fixtureEntry } from "./run-fixtures";
import type { RunActionsState } from "./use-run-actions";

const render = (element: ReactElement): string => renderToStaticMarkup(element);
const NOOP = (): void => {};
const ACTIONS: RunActionsState = {
  busy: null,
  error: null,
  dismissError: NOOP,
  cancel: NOOP,
  retry: NOOP,
  retryFromFailed: NOOP,
  deleteTempProject: NOOP
};
const text = (html: string): string => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

// --- RunsList ---------------------------------------------------------------

{
  const html = render(
    createElement(RunsList, {
      runs: FIXTURE_RUNS,
      selectedRunId: FIXTURE_RUNS[0]!.id,
      onSelect: NOOP,
      filter: "all",
      onFilterChange: NOOP,
      now: FIXTURE_NOW,
      hasMore: true,
      onLoadMore: NOOP
    })
  );
  const words = text(html);
  assert.match(words, /New tag v2\.14\.0 · acme\/app/, "a run row names its trigger");
  assert.match(words, /Skipped — the previous run was still going/, "a skipped run says why");
  assert.match(html, /opacity-60/, "a skipped run is muted");
  assert.match(html, /aria-label="Test run"/, "a test run carries the flask");
  assert.match(html, /aria-current="true"/, "the selected run is marked");
  assert.match(words, /Load more/, "more runs can be loaded");
  assert.match(words, /Failed 1/, "the failed chip counts its runs");
  assert.doesNotMatch(words, /Cancelled 0/, "an empty filter chip stays out of the way");

  const sheet = render(
    createElement(RunsList, {
      runs: FIXTURE_RUNS,
      selectedRunId: null,
      onSelect: NOOP,
      filter: "all",
      onFilterChange: NOOP,
      now: FIXTURE_NOW,
      variant: "sheet"
    })
  );
  assert.match(sheet, /min-h-12/, "a phone's run rows are ≥ 40 px");
  assert.match(sheet, /h-10 px-3\.5/, "a phone's filter chips are ≥ 40 px");

  const empty = text(
    render(
      createElement(RunsList, {
        runs: [],
        selectedRunId: null,
        onSelect: NOOP,
        filter: "all",
        onFilterChange: NOOP,
        now: FIXTURE_NOW
      })
    )
  );
  assert.match(empty, /No runs yet/);
  const filtered = text(
    render(
      createElement(RunsList, {
        runs: FIXTURE_RUNS.slice(0, 1),
        selectedRunId: null,
        onSelect: NOOP,
        filter: "failed",
        onFilterChange: NOOP,
        now: FIXTURE_NOW
      })
    )
  );
  assert.match(filtered, /No runs match this filter/);
}

// --- RunHeader --------------------------------------------------------------

{
  const running = fixtureEntry("running");
  const html = text(
    render(
      createElement(RunHeader, { run: running.summary, blocks: running.blocks, now: FIXTURE_NOW, actions: ACTIONS })
    )
  );
  assert.match(html, /Running/);
  assert.match(html, /Cancel run/, "a live run can be cancelled");
  assert.doesNotMatch(html, /Retry run/, "a live run is not retried");
  assert.match(html, /Step 3\/7 · Review/);
  assert.match(html, /#3f1c9a2e/);

  const failed = fixtureEntry("failed");
  const done = text(
    render(
      createElement(RunHeader, {
        run: failed.summary,
        blocks: failed.blocks,
        now: FIXTURE_NOW,
        actions: { ...ACTIONS, error: "The daemon refused" },
        onOpenInCanvas: NOOP
      })
    )
  );
  assert.match(done, /Retry from failed block/);
  assert.match(done, /Retry run/);
  assert.match(done, /Open in canvas/);
  assert.match(done, /Delete temp project now/);
  assert.match(done, /Temporary project · kept until/);
  assert.match(done, /Alert failed: 503/, "the run's error shows");
  assert.match(done, /The daemon refused/, "an action's failure shows");
  assert.doesNotMatch(done, /Cancel run/);
}

// --- BlockRunDetails ----------------------------------------------------------

{
  const running = fixtureEntry("running");
  const agent = render(
    createElement(BlockRunDetails, { api: FIXTURE_API, entry: running, nodeId: "review", now: FIXTURE_NOW })
  );
  const words = text(agent);
  assert.match(words, /Working · 20m/, "a working agent says for how long");
  assert.match(words, /Reading src\/orders\/report\.ts/, "and what it is doing");
  assert.match(words, /Open session/);
  assert.match(words, /claude\/therealeduard465 · claude-opus-4-5 — soonest weekly reset/, "the account decision");
  assert.match(words, /2 skipped/);
  assert.match(words, /Hops · 1/);
  assert.match(
    words,
    /claude\/therealeduard465 → usage limit \(resets [^)]+\) → claude\/jasperclaude → working/,
    "the hops in one line"
  );
  assert.match(words, /switched account/);
  assert.match(agent, /role="tab"/);

  const failed = fixtureEntry("failed");
  const alert = text(
    render(createElement(BlockRunDetails, { api: FIXTURE_API, entry: failed, nodeId: "alert", now: FIXTURE_NOW }))
  );
  assert.match(alert, /HTTP error status/, "a failed block opens on its error");
  assert.match(alert, /503 Service Unavailable/);
  assert.match(alert, /Finished on failure/);

  const skipped = text(
    render(createElement(BlockRunDetails, { api: FIXTURE_API, entry: failed, nodeId: "comment", now: FIXTURE_NOW }))
  );
  assert.match(skipped, /Did not run · Approved went to false/);

  const output = text(
    render(createElement(BlockRunDetails, { api: FIXTURE_API, entry: failed, nodeId: "review", now: FIXTURE_NOW }))
  );
  assert.match(output, /Select a row to copy its value or path/, "the output is a JSON tree");
  assert.match(output, /text/);

  const truncated = fixtureEntry("failed");
  truncated.blocks = { ...truncated.blocks, review: { ...truncated.blocks.review!, outputTruncated: true } };
  const preview = text(
    render(createElement(BlockRunDetails, { api: FIXTURE_API, entry: truncated, nodeId: "review", now: FIXTURE_NOW }))
  );
  assert.match(preview, /Load full output/, "a preview offers the whole output");

  const build = render(
    createElement(BlockRunDetails, {
      api: FIXTURE_API,
      entry: failed,
      nodeId: "build",
      now: FIXTURE_NOW,
      initialTab: "input",
      variant: "sheet"
    })
  );
  assert.match(text(build), /Attempt 2 of 3/);
  assert.match(text(build), /From OnTag/, "the input names its upstream");
  assert.match(build, /h-10/, "a phone's tabs are ≥ 40 px");
}

// --- RunTimeline --------------------------------------------------------------

{
  const failed = fixtureEntry("failed");
  const html = render(
    createElement(RunTimeline, { entry: failed, now: FIXTURE_NOW, selectedNodeId: "alert", onSelectBlock: NOOP })
  );
  const words = text(html);
  for (const name of ["OnTag", "Build", "Review", "Approved", "Comment", "Alert", "Summary"]) {
    assert.match(words, new RegExp(name), `the timeline lists ${name}`);
  }
  assert.match(words, /on true/, "a branch is labelled with its handle");
  assert.match(words, /on false/);
  assert.match(words, /continues at Summary/, "a join is referenced from its branches");
  assert.match(words, /1 hop/, "an agent's hops are chipped");
  assert.match(words, /HTTP error status: POST hooks\.slack\.com/);
  assert.match(html, /aria-current="step"/);
  assert.match(words, /Not reached/);

  const sheet = render(
    createElement(RunTimeline, {
      entry: failed,
      now: FIXTURE_NOW,
      selectedNodeId: null,
      onSelectBlock: NOOP,
      variant: "sheet"
    })
  );
  assert.match(sheet, /min-h-14/, "a phone's steps are ≥ 40 px");

  const loading = render(
    createElement(RunTimeline, {
      entry: { ...failed, detail: null },
      now: FIXTURE_NOW,
      selectedNodeId: null,
      onSelectBlock: NOOP
    })
  );
  assert.match(loading, /aria-busy="true"/, "a run not loaded yet shows a skeleton");
}

// --- LogViewerView ------------------------------------------------------------

{
  const html = render(
    createElement(LogViewerView, {
      lines: FIXTURE_LOG_LINES,
      stream: "stdout",
      onStreamChange: NOOP,
      sizes: { stdoutBytes: 48_213, stderrBytes: 1_904 },
      following: true,
      loading: false,
      error: null,
      dropped: 1204,
      onDownload: NOOP
    })
  );
  const words = text(html);
  assert.match(words, /Live/);
  assert.match(words, /1,204 earlier lines are not shown here\. Download the full log to read them\./);
  assert.match(words, /Download full log/);
  assert.match(words, /stdout 47 KB/);
  assert.match(html, /role="log"/);
  const quiet = text(
    render(
      createElement(LogViewerView, {
        lines: [],
        stream: "stderr",
        onStreamChange: NOOP,
        following: false,
        loading: false,
        error: null,
        dropped: 0
      })
    )
  );
  assert.match(quiet, /Nothing was written to stderr\./);
}

// --- Notifications ------------------------------------------------------------

{
  const toast = text(
    render(
      createElement(WorkflowRunToastCard, {
        notice: {
          runId: "r",
          workflowId: "w",
          workflowName: "Nightly",
          tone: "danger",
          title: "Workflow failed: Nightly",
          message: "Review failed",
          test: false,
          at: "2026-09-28T14:00:00.000Z"
        },
        more: 2,
        onOpen: NOOP,
        onDismiss: NOOP
      })
    )
  );
  assert.match(toast, /Workflow failed: Nightly/);
  assert.match(toast, /\+2/);
  assert.match(toast, /Open run/);

  const rows = render(
    createElement(WorkflowAttentionRows, {
      entries: [
        {
          runId: "r",
          workflowId: "w",
          workflowName: "Nightly",
          detail: "Review failed",
          at: "2026-09-28T14:20:00.000Z"
        }
      ],
      now: FIXTURE_NOW,
      onOpen: NOOP,
      onDismiss: NOOP,
      touch: true
    })
  );
  assert.match(text(rows), /Workflow failed/);
  assert.match(text(rows), /10m ago/);
  assert.match(rows, /aria-label="Dismiss Nightly"/);
  assert.match(rows, /h-10 w-10/, "a phone's dismiss target is ≥ 40 px");
  assert.equal(
    render(createElement(WorkflowAttentionRows, { entries: [], now: FIXTURE_NOW, onOpen: NOOP, onDismiss: NOOP })),
    "",
    "no failed runs, no group"
  );
}

console.log("runs-render.check: ok");
