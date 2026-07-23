// claudemix-tri-model.js
//
// The canonical `claudemix` mixed-model workflow (spec §8, "Fable plans, Kimi
// designs, Sol executes, tri-model review"). Runnable via the Workflow tool from
// inside a *claudemix* session, where the main loop is Fable (claude-*) and the
// `gpt-*` / `kimi-k3` subagents route through the local CLIProxyAPI instance.
//
// Four phases:
//   Plan    — one agent() on the default model (Fable) → structured plan.
//   Design  — agent(designPrompt, {model:"kimi-k3"})   → frontend/design artifact.
//   Execute — agent(execPrompt,  {model:"gpt-5.6-sol"}) → implementation.
//   Review  — a quorum panel of three reviewers on three model families
//             (claude-*, gpt-5.6-sol, kimi-k3); each vote is wrapped so a provider
//             error resolves to a null (abstaining) vote. Pass = >= quorum approvals
//             (default 2-of-3, configurable). Failures are surfaced, never retried —
//             the harness does not retry subagent provider errors, so the script owns
//             degradation (spec §8.5).
//
// Returns: { task, plan, design, execution, review: { votes, approved, failures } }
//
// The task description is supplied via `args` (a plain string, or an object with a
// `task` field plus optional overrides), so the script is reusable.

// --- Model routing knobs (deployed catalog names, verified in the routing spike) ---
export const MODELS = {
  // The main-loop / planner model. Left undefined so agent() uses the session's
  // default (Fable) — claudemix pins the main loop to claude-* by construction.
  plan: undefined,
  design: "kimi-k3",
  execute: "gpt-5.6-sol",
  // One reviewer per provider family — the whole point of the tri-model panel.
  review: ["claude-fable-5", "gpt-5.6-sol", "kimi-k3"],
};

// `meta` MUST be a pure literal (no runtime references) so the Workflow tool can
// introspect the phase list without executing the script.
export const meta = {
  name: "claudemix-tri-model",
  title: "claudemix — Fable → Kimi → Sol → tri-model review",
  description:
    "Mixed-model workflow: Fable plans, Kimi K3 designs, Sol executes, then a " +
    "three-model quorum panel reviews. Degrades gracefully on a single reviewer " +
    "provider failure (default quorum 2-of-3).",
  phases: [
    { id: "plan", title: "Plan", model: "fable (session default)" },
    { id: "design", title: "Design", model: "kimi-k3" },
    { id: "execute", title: "Execute", model: "gpt-5.6-sol" },
    { id: "review", title: "Review", model: "claude · gpt · kimi (quorum)" },
  ],
  defaults: { quorum: 2 },
};

// --- Plan artifact schema (agent() returns structured JSON matching this) ---
const PLAN_SCHEMA = {
  type: "object",
  required: ["summary", "steps"],
  properties: {
    summary: { type: "string" },
    steps: {
      type: "array",
      items: {
        type: "object",
        required: ["title", "detail"],
        properties: {
          title: { type: "string" },
          detail: { type: "string" },
          files: { type: "array", items: { type: "string" } },
        },
      },
    },
    risks: { type: "array", items: { type: "string" } },
  },
};

// A single reviewer's verdict shape.
const REVIEW_SCHEMA = {
  type: "object",
  required: ["approve", "rationale"],
  properties: {
    approve: { type: "boolean" },
    rationale: { type: "string" },
    blocking: { type: "array", items: { type: "string" } },
  },
};

// Normalize `args` into a config object.
function resolveConfig(args) {
  const raw = args ?? {};
  const cfg = typeof raw === "string" ? { task: raw } : { ...raw };
  const task = (cfg.task ?? "").toString().trim();
  const reviewModels = Array.isArray(cfg.reviewModels)
    ? cfg.reviewModels
    : MODELS.review;
  // Quorum defaults to 2-of-3; clamp to [1, reviewers].
  const requested = Number.isFinite(cfg.quorum)
    ? cfg.quorum
    : meta.defaults.quorum;
  const quorum = Math.max(1, Math.min(reviewModels.length, requested));
  return {
    task,
    planModel: cfg.planModel ?? MODELS.plan,
    designModel: cfg.designModel ?? MODELS.design,
    executeModel: cfg.executeModel ?? MODELS.execute,
    reviewModels,
    quorum,
  };
}

// Wrap an agent() call so a provider error never throws out of a phase: it resolves
// to a tagged failure. Used for the review panel (and any fan-out) so one provider's
// outage degrades to an abstaining vote instead of aborting the whole workflow.
async function safeAgent(agent, prompt, opts, label) {
  try {
    const value = await agent(prompt, opts);
    return { ok: true, label, model: opts?.model ?? null, value };
  } catch (err) {
    return {
      ok: false,
      label,
      model: opts?.model ?? null,
      error: err && err.message ? err.message : String(err),
    };
  }
}

// The workflow entrypoint. The Workflow tool injects a context that provides
// `agent(prompt, opts)`; we also accept `agent`/`args` as globals for runtimes that
// inject them into scope rather than passing a context object.
export async function run(ctx = {}) {
  const agent =
    ctx.agent ?? (typeof globalThis.agent === "function" ? globalThis.agent : null);
  const args = ctx.args ?? globalThis.args;
  if (typeof agent !== "function") {
    throw new Error(
      "claudemix-tri-model: no agent() available — run this inside a claudemix session via the Workflow tool.",
    );
  }

  const cfg = resolveConfig(args);
  if (!cfg.task) {
    throw new Error(
      "claudemix-tri-model: a task description is required (pass it as the workflow args).",
    );
  }

  // --- Phase 1: Plan (Fable / session default) ---
  const plan = await agent(
    [
      "You are the planner. Produce a concise, structured implementation plan for the task below.",
      "Break it into ordered steps; note affected files and risks. Do not write code yet.",
      "",
      `TASK:\n${cfg.task}`,
    ].join("\n"),
    { model: cfg.planModel, schema: PLAN_SCHEMA },
  );

  const planText =
    typeof plan === "string" ? plan : JSON.stringify(plan, null, 2);

  // --- Phase 2: Design (Kimi K3) ---
  const design = await agent(
    [
      "You are the design/frontend specialist. Given the task and the plan, produce the",
      "design and frontend approach: component/layout structure, states, and the key",
      "styling decisions. Concrete and buildable.",
      "",
      `TASK:\n${cfg.task}`,
      "",
      `PLAN:\n${planText}`,
    ].join("\n"),
    { model: cfg.designModel },
  );

  // --- Phase 3: Execute (Sol / gpt-5.6-sol) ---
  const execution = await agent(
    [
      "You are the executor. Implement the task against the plan and the design.",
      "Follow the plan's steps and the design's structure. Return the concrete changes",
      "(diffs or full files) and a short note of anything you deviated on.",
      "",
      `TASK:\n${cfg.task}`,
      "",
      `PLAN:\n${planText}`,
      "",
      `DESIGN:\n${typeof design === "string" ? design : JSON.stringify(design, null, 2)}`,
    ].join("\n"),
    { model: cfg.executeModel },
  );

  const executionText =
    typeof execution === "string"
      ? execution
      : JSON.stringify(execution, null, 2);

  // --- Phase 4: Review — tri-model quorum panel ---
  // Each reviewer runs on a distinct provider family. Calls are wrapped so a provider
  // error becomes an abstaining (null) vote rather than aborting the workflow. The
  // harness does not retry provider errors, so we do not retry here (spec §8.5).
  const reviewPrompt = [
    "You are a code reviewer. Judge whether the execution correctly and safely",
    "implements the task per the plan and design. Approve only if it is correct,",
    "complete, and safe; otherwise reject and list blocking issues.",
    "",
    `TASK:\n${cfg.task}`,
    "",
    `PLAN:\n${planText}`,
    "",
    `EXECUTION:\n${executionText}`,
  ].join("\n");

  const results = await Promise.all(
    cfg.reviewModels.map((model, i) =>
      safeAgent(
        agent,
        reviewPrompt,
        { model, schema: REVIEW_SCHEMA },
        `reviewer-${i + 1}`,
      ),
    ),
  );

  const votes = results.map((r) => {
    if (!r.ok) {
      return { label: r.label, model: r.model, vote: null, error: r.error };
    }
    const v = r.value;
    const approve =
      typeof v === "object" && v !== null ? Boolean(v.approve) : Boolean(v);
    const rationale =
      typeof v === "object" && v !== null ? v.rationale : undefined;
    const blocking =
      typeof v === "object" && v !== null && Array.isArray(v.blocking)
        ? v.blocking
        : [];
    return { label: r.label, model: r.model, vote: approve, rationale, blocking };
  });

  const approvals = votes.filter((v) => v.vote === true).length;
  const failures = votes
    .filter((v) => v.vote === null)
    .map((v) => ({ label: v.label, model: v.model, error: v.error }));

  const review = {
    quorum: cfg.quorum,
    reviewers: cfg.reviewModels.length,
    approvals,
    approved: approvals >= cfg.quorum,
    votes,
    failures,
  };

  return { task: cfg.task, plan, design, execution, review };
}

export default run;
