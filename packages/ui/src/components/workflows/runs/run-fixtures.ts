/**
 * Fixtures for the run view's render checks and screenshots — a review
 * workflow mid-run: a git trigger, a shell build, an agent that hopped
 * accounts on a usage limit, an IF, a failed HTTP call on its false branch.
 * Not imported by the app.
 */

import type { WorkflowBlockRun, WorkflowNode, WorkflowRun, WorkflowRunSummary } from "@orquester/api";

import type { WorkflowRunEntry } from "../../../lib/workflows/store";
import type { WorkflowRunsApi } from "./shared";

export const FIXTURE_NOW = Date.parse("2026-09-28T14:30:00.000Z");
const iso = (minutesAgo: number, seconds = 0): string =>
  new Date(FIXTURE_NOW - minutesAgo * 60_000 + seconds * 1000).toISOString();

function node(
  id: string,
  name: string,
  type: WorkflowNode["type"],
  y: number,
  extra: Record<string, unknown> = {}
): WorkflowNode {
  return { id, name, type, position: { x: 0, y }, config: {}, ...extra } as unknown as WorkflowNode;
}

const edge = (source: string, target: string, sourceHandle = "success") => ({
  id: `${source}-${sourceHandle}-${target}`,
  source,
  sourceHandle,
  target
});

export const FIXTURE_DEFINITION = {
  id: "wf-review",
  name: "Release-tag reviewer",
  enabled: true,
  revision: 7,
  project: { kind: "existing" as const, projectPath: "/w/acme/app" },
  settings: {
    overlap: "skip" as const,
    maxConcurrent: 2,
    timezone: "Europe/Madrid",
    runTimeoutMinutes: 240,
    notify: { onFailure: true, onSuccess: false },
    keepFailedTempDays: 3
  },
  nodes: [
    node("tag", "OnTag", "trigger.git", 0),
    node("build", "Build", "shell", 100, { retry: { maxTries: 3, delaySeconds: 10 } }),
    node("review", "Review", "agent", 200),
    node("ok", "Approved", "if", 300),
    node("comment", "Comment", "http", 400),
    node("alert", "Alert", "http", 500),
    node("done", "Summary", "code", 600)
  ],
  edges: [
    edge("tag", "build"),
    edge("build", "review"),
    edge("review", "ok"),
    edge("ok", "comment", "true"),
    edge("ok", "alert", "false"),
    edge("comment", "done"),
    edge("alert", "done")
  ],
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-20T00:00:00.000Z"
} as unknown as WorkflowRun["definition"];

const REVIEW_TEXT =
  "Reviewed v2.14.0 (38 files).\n\n- The migration in `db/0042_orders.sql` drops a column still read by `orders/report.ts`.\n- `useCheckout` retries without backoff.\n\nVerdict: changes requested.";

export function fixtureBlocks(stage: "running" | "failed"): Record<string, WorkflowBlockRun> {
  const blocks: Record<string, WorkflowBlockRun> = {
    tag: {
      nodeId: "tag",
      name: "OnTag",
      type: "trigger.git",
      status: "succeeded",
      attempt: 1,
      startedAt: iso(24),
      endedAt: iso(24),
      output: {
        kind: "git",
        event: "tag",
        tag: "v2.14.0",
        sha: "9f3c2a1",
        repo: { name: "acme/app", url: "git@github.com:acme/app.git" }
      }
    },
    build: {
      nodeId: "build",
      name: "Build",
      type: "shell",
      status: "succeeded",
      attempt: 2,
      startedAt: iso(24),
      endedAt: iso(21, 48),
      output: { stdout: "✓ built in 41.2s", stderr: "", exitCode: 0 },
      logs: { stdoutBytes: 48_213, stderrBytes: 1_904 }
    },
    review: {
      nodeId: "review",
      name: "Review",
      type: "agent",
      status: "running",
      attempt: 1,
      startedAt: iso(21, 48),
      sessionId: "sess-review-2",
      activity: "Reading src/orders/report.ts",
      selection: {
        chosen: {
          agent: "claude",
          model: "claude-opus-4-5",
          accountId: "acc-e",
          accountLabel: "therealeduard465",
          chainIndex: 0
        },
        reason: "soonest weekly reset (4d 2h) under 85%",
        usageAsOf: iso(22),
        skipped: [
          { agent: "claude", accountId: "acc-w", label: "work-team", why: "threshold", detail: "weekly 91% ≥ 85%" },
          { agent: "claude", accountId: "system", why: "needsReauth", detail: "token expired" }
        ]
      },
      hops: [
        {
          agent: "claude",
          model: "claude-opus-4-5",
          accountId: "acc-e",
          accountLabel: "therealeduard465",
          sessionId: "sess-review-1",
          startedAt: iso(21, 48),
          endedAt: iso(9),
          reason: "usage_limit",
          resetsAt: new Date(FIXTURE_NOW + 8 * 60 * 60_000 + 10 * 60_000).toISOString(),
          via: "initial"
        },
        {
          agent: "claude",
          model: "claude-opus-4-5",
          accountId: "acc-j",
          accountLabel: "jasperclaude",
          sessionId: "sess-review-2",
          startedAt: iso(9),
          via: "switched"
        }
      ]
    }
  };
  if (stage === "failed") {
    blocks.review = {
      ...blocks.review!,
      status: "succeeded",
      endedAt: iso(3),
      activity: undefined,
      handle: "success",
      output: {
        text: REVIEW_TEXT,
        sessionId: "sess-review-2",
        agent: "claude",
        model: "claude-opus-4-5",
        accountId: "acc-j",
        durationMs: 1_128_000
      },
      hops: blocks.review!.hops!.map((hop, index) => (index === 1 ? { ...hop, endedAt: iso(3) } : hop))
    };
    blocks.ok = {
      nodeId: "ok",
      name: "Approved",
      type: "if",
      status: "succeeded",
      attempt: 1,
      handle: "false",
      startedAt: iso(3),
      endedAt: iso(3)
    };
    blocks.comment = { nodeId: "comment", name: "Comment", type: "http", status: "skipped", attempt: 0 };
    blocks.alert = {
      nodeId: "alert",
      name: "Alert",
      type: "http",
      status: "failed",
      attempt: 1,
      startedAt: iso(3),
      endedAt: iso(3, 2),
      handle: "error",
      error: {
        kind: "http_status",
        message: "POST hooks.slack.com/services/… answered 503 Service Unavailable",
        detail: { status: 503, body: { ok: false, error: "service_unavailable" } }
      }
    };
  }
  return blocks;
}

export function fixtureSummary(stage: "running" | "failed"): WorkflowRunSummary {
  return {
    id: "3f1c9a2e-7b44-4c1e-9d0a-5e2f8b6c1d77",
    workflowId: "wf-review",
    workflowName: "Release-tag reviewer",
    status: stage === "running" ? "running" : "failed",
    trigger: { kind: "git", nodeId: "tag", text: "New tag v2.14.0 · acme/app" },
    test: false,
    queuedAt: iso(24),
    startedAt: iso(24),
    ...(stage === "failed"
      ? { endedAt: iso(3, 2), durationMs: 21 * 60_000 + 2_000, error: "Alert failed: 503 Service Unavailable" }
      : {}),
    ...(stage === "running" ? { current: { nodeId: "review", name: "Review", index: 3, total: 7 } } : {}),
    projectPath: "/w/acme/app",
    tempProject: {
      path: "/w/tmp/acme-app-3f1c9a2e",
      deleted: false,
      deleteAfter: new Date(FIXTURE_NOW + 3 * 86_400_000).toISOString()
    }
  };
}

export function fixtureEntry(stage: "running" | "failed"): WorkflowRunEntry {
  const summary = fixtureSummary(stage);
  const blocks = fixtureBlocks(stage);
  const taken =
    stage === "failed"
      ? ["tag-success-build", "build-success-review", "review-success-ok", "ok-false-alert"]
      : ["tag-success-build", "build-success-review"];
  const dead = stage === "failed" ? ["ok-true-comment", "comment-success-done"] : [];
  return {
    summary,
    detail: {
      ...summary,
      definition: FIXTURE_DEFINITION,
      triggerPayload: {
        kind: "git",
        event: "tag",
        repo: { url: "git@github.com:acme/app.git", name: "acme/app" },
        ref: "refs/tags/v2.14.0",
        sha: "9f3c2a1",
        tag: "v2.14.0"
      },
      blocks,
      takenEdges: taken,
      deadEdges: dead
    },
    blocks,
    takenEdges: taken,
    deadEdges: dead,
    error: null
  };
}

export const FIXTURE_RUNS: WorkflowRunSummary[] = [
  fixtureSummary("running"),
  {
    ...fixtureSummary("failed"),
    id: "b2",
    queuedAt: iso(60 * 3),
    startedAt: iso(60 * 3),
    endedAt: iso(60 * 3 - 21),
    current: undefined
  },
  {
    id: "b3",
    workflowId: "wf-review",
    workflowName: "Release-tag reviewer",
    status: "skipped",
    skipReason: "overlap",
    trigger: { kind: "git", text: "New tag v2.13.2 · acme/app" },
    test: false,
    queuedAt: iso(60 * 5)
  },
  {
    id: "b4",
    workflowId: "wf-review",
    workflowName: "Release-tag reviewer",
    status: "succeeded",
    trigger: { kind: "manual", text: "Run now" },
    test: true,
    queuedAt: iso(60 * 26),
    startedAt: iso(60 * 26),
    endedAt: iso(60 * 26 - 14),
    durationMs: 14 * 60_000 + 31_000
  },
  {
    id: "b5",
    workflowId: "wf-review",
    workflowName: "Release-tag reviewer",
    status: "stopped",
    trigger: { kind: "git", text: "New tag v2.13.1 · acme/app" },
    test: false,
    queuedAt: iso(60 * 50),
    startedAt: iso(60 * 50),
    endedAt: iso(60 * 50 - 2),
    durationMs: 2 * 60_000 + 5_000
  },
  {
    id: "b6",
    workflowId: "wf-review",
    workflowName: "Release-tag reviewer",
    status: "cancelled",
    trigger: { kind: "retry", text: "Retry" },
    test: false,
    queuedAt: iso(60 * 72),
    startedAt: iso(60 * 72),
    endedAt: iso(60 * 72 - 1),
    durationMs: 48_000
  }
];

export const FIXTURE_LOG_LINES = [
  "$ pnpm install --frozen-lockfile",
  "Lockfile is up to date, resolution step is skipped",
  "Packages: +1204",
  "Progress: resolved 1204, reused 1204, downloaded 0, added 1204, done",
  "",
  "$ pnpm build",
  "> @acme/app@2.14.0 build /w/tmp/acme-app-3f1c9a2e",
  "> vite build",
  "",
  "vite v6.0.7 building for production...",
  "transforming (1843) src/orders/report.ts",
  "✓ 1843 modules transformed.",
  "dist/index.html                   0.62 kB │ gzip:   0.38 kB",
  "dist/assets/index-Bq7xC1.css     48.11 kB │ gzip:  11.02 kB",
  "dist/assets/index-D4f9aZ.js     812.40 kB │ gzip: 241.77 kB",
  "(!) Some chunks are larger than 500 kB after minification.",
  "✓ built in 41.2s"
];

/** An API that answers nothing — the checks never call it. */
export const FIXTURE_API = {
  connection: { id: "fixture" },
  listWorkflows: async () => ({ workflows: [] }),
  getWorkflow: async () => {
    throw new Error("unused");
  },
  createWorkflow: async () => {
    throw new Error("unused");
  },
  patchWorkflow: async () => {
    throw new Error("unused");
  },
  duplicateWorkflow: async () => {
    throw new Error("unused");
  },
  deleteWorkflow: async () => undefined,
  runWorkflow: async () => ({ runId: "new-run" }),
  listWorkflowRuns: async () => ({ runs: [], before: null }),
  getWorkflowRun: async () => {
    throw new Error("unused");
  },
  listWorkflowSecrets: async () => ({ secrets: [] }),
  setWorkflowSecret: async () => undefined,
  deleteWorkflowSecret: async () => undefined,
  getWorkflowNodeOutput: async () => ({ output: null }),
  openWorkflowNodeLog: () => ({ close: () => undefined }),
  cancelWorkflowRun: async () => undefined,
  deleteWorkflowRunTempProject: async () => undefined
} as unknown as WorkflowRunsApi;
