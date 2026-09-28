// Automated workflows — the on-disk schemas (docs/superpowers/specs/2026-09-28-automated-workflows-design.md).
//
//   <appdir>/daemon/workflows.json          definitions (entry-wise tolerant, §3.1)
//   <appdir>/daemon/workflow-state.json     runtime state: schedule cursors, git cursors, cooldowns
//   <appdir>/daemon/workflow-secrets.json   0600 secret values (names only ever leave the daemon)
//   <appdir>/daemon/workflow-runs/<runId>/  run.json, events.ndjson, nodes/<nodeId>/<attempt>/…
//
// This module imports only zod: the path helpers live in index.ts, which re-exports this file.
//
// **Any change to an existing field's TYPE or MEANING must bump the file `version`** — the
// saved-prompts rule: an older build passes a new field through, but would serve and rewrite a
// changed one wrongly. Configs check SHAPE; editor limits (§5.9) are enforced on write by
// `validateWorkflow` (@orquester/api), never on read.

import { z } from "zod";

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export const workflowKeyValueSchema = z.object({ name: z.string(), value: z.string() });
export type WorkflowKeyValue = z.infer<typeof workflowKeyValueSchema>;

export const workflowPositionSchema = z.object({ x: z.number().finite(), y: z.number().finite() });

export const WORKFLOW_NODE_TYPES = [
  "trigger.manual",
  "trigger.schedule",
  "trigger.git",
  "agent",
  "code",
  "shell",
  "http",
  "if",
  "switch",
  "merge",
  "stop",
  "wait",
  "workflow",
  "note"
] as const;
export type WorkflowNodeType = (typeof WORKFLOW_NODE_TYPES)[number];

// ---------------------------------------------------------------------------
// Trigger configs (§4, §6)
// ---------------------------------------------------------------------------

export const schedulePresetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("minutes"), every: z.number().int().min(1).max(59) }),
  z.object({
    kind: z.literal("hours"),
    every: z.number().int().min(1).max(23),
    atMinute: z.number().int().min(0).max(59).default(0)
  }),
  z.object({ kind: z.literal("daily"), time: z.string().regex(HHMM) }),
  z.object({
    kind: z.literal("weekly"),
    /** 0 = Sunday … 6 = Saturday (cron's numbering). */
    days: z.array(z.number().int().min(0).max(6)).min(1),
    time: z.string().regex(HHMM)
  }),
  z.object({ kind: z.literal("monthly"), day: z.number().int().min(1).max(31), time: z.string().regex(HHMM) }),
  z.object({ kind: z.literal("cron") })
]);
export type SchedulePreset = z.infer<typeof schedulePresetSchema>;

export const triggerManualConfigSchema = z.object({
  /** A JSON example shown in "Run now" (free text; not validated as JSON on read). */
  inputExample: z.string().optional()
});

export const triggerScheduleConfigSchema = z.object({
  preset: schedulePresetSchema,
  /** The authority (5 fields; 6 with seconds only for preset kind "cron"). */
  cron: z.string().min(1)
});

export const gitRepoRefSchema = z.discriminatedUnion("kind", [
  /** The workflow project's `origin` (a temp workflow's clone URL) and its workspace's git account. */
  z.object({ kind: z.literal("project") }),
  /** Any URL; no account = a public repository. */
  z.object({ kind: z.literal("url"), url: z.string().min(1), accountId: z.string().min(1).optional() })
]);
export type GitRepoRef = z.infer<typeof gitRepoRefSchema>;

export const GIT_PR_ACTIONS = ["opened", "updated", "merged", "closed"] as const;
export type GitPullRequestAction = (typeof GIT_PR_ACTIONS)[number];

export const gitTriggerEventSchema = z.discriminatedUnion("kind", [
  /** Globs over branch names; [] = the repository's default branch. */
  z.object({ kind: z.literal("push"), branches: z.array(z.string()).default([]) }),
  z.object({ kind: z.literal("tag"), pattern: z.string().optional() }),
  /** GitHub only (Bitbucket has no releases — the editor offers "tag"). */
  z.object({ kind: z.literal("release"), includePrereleases: z.boolean().default(false) }),
  z.object({
    kind: z.literal("pull_request"),
    actions: z.array(z.enum(GIT_PR_ACTIONS)).min(1),
    baseBranches: z.array(z.string()).optional()
  })
]);
export type GitTriggerEvent = z.infer<typeof gitTriggerEventSchema>;

export const triggerGitConfigSchema = z.object({ repo: gitRepoRefSchema, event: gitTriggerEventSchema });

// ---------------------------------------------------------------------------
// Agent block (§5.1, §5.2)
// ---------------------------------------------------------------------------

export const agentModelOptionSchema = z.object({
  id: z.string().min(1),
  value: z.union([z.string(), z.boolean()])
});

export const accountPolicySchema = z.object({
  strategy: z.enum(["least-used", "soonest-reset", "fixed"]).default("least-used"),
  /** fixed: try in this order; other strategies: an allow-list. Omitted = every account of the family. */
  accounts: z.array(z.string().min(1)).optional(),
  /** The daemon user's own login ("system") as a candidate. */
  includeSystem: z.boolean().default(false),
  /** The 5h window. */
  maxSessionPct: z.number().min(0).max(100).optional(),
  maxWeeklyPct: z.number().min(0).max(100).optional(),
  /** Provider-labelled windows, e.g. Claude's "Fable" weekly cap. */
  scoped: z
    .array(
      z.object({
        label: z.string().min(1),
        maxPct: z.number().min(0).max(100),
        onlyForModels: z.array(z.string()).optional()
      })
    )
    .optional(),
  soonestResetWindow: z.enum(["weekly", "session"]).default("weekly"),
  leastUsedMetric: z.enum(["max", "weekly", "session"]).default("max"),
  unknownUsage: z.enum(["last", "exclude"]).default("last")
});
export type AccountPolicy = z.infer<typeof accountPolicySchema>;

export const agentChainEntrySchema = z.object({
  /** Registry refId: claude | claudex | claudemix | codex | grok | opencode. */
  agent: z.string().min(1),
  model: z.string().min(1),
  options: z.array(agentModelOptionSchema).optional(),
  /** Ignored for agents with no accounts (opencode). */
  accounts: accountPolicySchema.default({})
});
export type AgentChainEntry = z.infer<typeof agentChainEntrySchema>;

export const agentPromptSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), text: z.string() }),
  z.object({ kind: z.literal("saved"), promptId: z.string().min(1), append: z.string().optional() })
]);
export type AgentPrompt = z.infer<typeof agentPromptSchema>;

export const agentSessionModeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("new"), title: z.string().optional() }),
  /** A follow-up turn into the session an upstream agent block (by NAME) created in this run. */
  z.object({ kind: z.literal("continue"), fromNode: z.string().min(1) })
]);

export const agentConfigSchema = z.object({
  prompt: agentPromptSchema,
  session: agentSessionModeSchema.default({ kind: "new" }),
  chain: z.array(agentChainEntrySchema).min(1),
  autonomyNote: z.boolean().default(true),
  whenOnlyWatchLoopsRemain: z.enum(["finish", "wait"]).default("finish"),
  whenAllBurnt: z
    .discriminatedUnion("kind", [
      z.object({ kind: z.literal("fail") }),
      z.object({ kind: z.literal("wait-for-reset"), maxWaitHours: z.number().positive().max(168) })
    ])
    .default({ kind: "fail" }),
  maxMinutes: z.number().int().positive().default(240)
});
export type AgentBlockConfig = z.infer<typeof agentConfigSchema>;

// ---------------------------------------------------------------------------
// Code / shell / http (§4, §5.6)
// ---------------------------------------------------------------------------

export const codeConfigSchema = z.object({
  source: z.string(),
  timeoutMinutes: z.number().positive().optional(),
  memoryMb: z.number().int().positive().optional()
});
export type CodeBlockConfig = z.infer<typeof codeConfigSchema>;

export const shellConfigSchema = z.object({
  /** `{{…}}` is refused here by validation: values reach the script only through `env`. */
  script: z.string(),
  shell: z.enum(["bash", "sh"]).default("bash"),
  env: z.array(workflowKeyValueSchema).default([]),
  timeoutMinutes: z.number().positive().optional()
});
export type ShellBlockConfig = z.infer<typeof shellConfigSchema>;

export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"] as const;

export const httpBodySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("json"), value: z.string() }),
  z.object({ kind: z.literal("text"), value: z.string(), contentType: z.string().optional() }),
  z.object({ kind: z.literal("form"), fields: z.array(workflowKeyValueSchema) })
]);

export const httpConfigSchema = z.object({
  method: z.enum(HTTP_METHODS).default("GET"),
  url: z.string(),
  headers: z.array(workflowKeyValueSchema).default([]),
  query: z.array(workflowKeyValueSchema).default([]),
  body: httpBodySchema.optional(),
  timeoutSeconds: z.number().positive().optional(),
  /** "2xx" or an explicit list of accepted statuses. */
  successStatuses: z.union([z.literal("2xx"), z.array(z.number().int().min(100).max(599))]).default("2xx"),
  followRedirects: z.boolean().default(true)
});
export type HttpBlockConfig = z.infer<typeof httpConfigSchema>;

// ---------------------------------------------------------------------------
// Flow (§4)
// ---------------------------------------------------------------------------

export const RULE_OPERATORS = [
  "equals",
  "notEquals",
  "contains",
  "notContains",
  "startsWith",
  "endsWith",
  "matches",
  "gt",
  "gte",
  "lt",
  "lte",
  "isEmpty",
  "isNotEmpty",
  "exists",
  "isTrue",
  "isFalse"
] as const;
export type RuleOperator = (typeof RULE_OPERATORS)[number];

export const workflowRuleSchema = z.object({
  /** A template: usually one `{{ path }}`. */
  left: z.string(),
  op: z.enum(RULE_OPERATORS),
  right: z.string().optional()
});
export type WorkflowRule = z.infer<typeof workflowRuleSchema>;

export const ifConfigSchema = z.object({
  combine: z.enum(["all", "any"]).default("all"),
  rules: z.array(workflowRuleSchema).min(1)
});

export const switchConfigSchema = z.object({
  cases: z
    .array(
      z.object({
        label: z.string(),
        combine: z.enum(["all", "any"]).default("all"),
        rules: z.array(workflowRuleSchema).min(1)
      })
    )
    .min(1),
  /** Adds the "default" output for no match. */
  fallback: z.boolean().default(true)
});

export const mergeConfigSchema = z.object({ mode: z.enum(["all", "first"]).default("all") });

export const stopConfigSchema = z.object({
  as: z.enum(["success", "failure"]).default("success"),
  message: z.string().optional(),
  /** A template; its rendered value becomes the run's final output. */
  value: z.string().optional()
});

export const waitConfigSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("duration"), minutes: z.number().positive() }),
  z.object({ kind: z.literal("until"), time: z.string().regex(HHMM), timezone: z.string().optional() })
]);

export const subWorkflowConfigSchema = z.object({
  workflowId: z.string().min(1),
  /** A template whose rendered value is the child's `trigger.input`. */
  input: z.string().optional()
});

export const NOTE_COLORS = ["yellow", "blue", "green", "pink", "purple", "neutral"] as const;
export const noteConfigSchema = z.object({ text: z.string().default(""), color: z.enum(NOTE_COLORS).default("yellow") });

// ---------------------------------------------------------------------------
// Nodes, edges, workflow (§3.1)
// ---------------------------------------------------------------------------

const nodeBase = {
  id: z.string().min(1),
  name: z.string().min(1),
  position: workflowPositionSchema,
  disabled: z.boolean().optional(),
  notes: z.string().optional(),
  retry: z
    .object({ maxTries: z.number().int().min(1).max(10), delaySeconds: z.number().min(0).max(3600) })
    .optional(),
  timeoutMinutes: z.number().positive().optional(),
  projectOverride: z.string().min(1).optional()
};

function nodeOf<T extends WorkflowNodeType, C extends z.ZodTypeAny>(type: T, config: C) {
  return z.object({ ...nodeBase, type: z.literal(type), config }).passthrough();
}

export const workflowNodeSchema = z.discriminatedUnion("type", [
  nodeOf("trigger.manual", triggerManualConfigSchema),
  nodeOf("trigger.schedule", triggerScheduleConfigSchema),
  nodeOf("trigger.git", triggerGitConfigSchema),
  nodeOf("agent", agentConfigSchema),
  nodeOf("code", codeConfigSchema),
  nodeOf("shell", shellConfigSchema),
  nodeOf("http", httpConfigSchema),
  nodeOf("if", ifConfigSchema),
  nodeOf("switch", switchConfigSchema),
  nodeOf("merge", mergeConfigSchema),
  nodeOf("stop", stopConfigSchema),
  nodeOf("wait", waitConfigSchema),
  nodeOf("workflow", subWorkflowConfigSchema),
  nodeOf("note", noteConfigSchema)
]);
export type WorkflowNode = z.infer<typeof workflowNodeSchema>;
export type WorkflowNodeOf<T extends WorkflowNodeType> = Extract<WorkflowNode, { type: T }>;
export type WorkflowNodeConfig<T extends WorkflowNodeType> = WorkflowNodeOf<T>["config"];

/** Handle ids: success | error | true | false | case:<n> | default. */
export const WORKFLOW_HANDLE_PATTERN = /^(success|error|true|false|default|case:(0|[1-9]\d{0,2}))$/;

export const workflowEdgeSchema = z
  .object({
    id: z.string().min(1),
    source: z.string().min(1),
    sourceHandle: z.string().regex(WORKFLOW_HANDLE_PATTERN),
    target: z.string().min(1)
  })
  .passthrough();
export type WorkflowEdge = z.infer<typeof workflowEdgeSchema>;

export const workflowProjectSchema = z.discriminatedUnion("kind", [
  /** `<workspacesDir>/<ws>/<project>` */
  z.object({ kind: z.literal("existing"), projectPath: z.string().min(1) }),
  z.object({
    kind: z.literal("temp"),
    /** The workspace NAME; its git account clones. */
    workspace: z.string().min(1),
    source: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("empty") }),
      z.object({ kind: z.literal("clone"), url: z.string().min(1), ref: z.string().min(1).optional() })
    ])
  })
]);
export type WorkflowProject = z.infer<typeof workflowProjectSchema>;

export const workflowSettingsSchema = z
  .object({
    overlap: z.enum(["skip", "queue", "parallel"]).default("skip"),
    maxConcurrent: z.number().int().min(1).max(8).default(2),
    timezone: z.string().min(1).default("UTC"),
    runTimeoutMinutes: z.number().positive().optional(),
    notify: z
      .object({ onFailure: z.boolean().default(true), onSuccess: z.boolean().default(false) })
      .default({}),
    keepFailedTempDays: z.number().int().min(0).max(30).default(3)
  })
  .passthrough();
export type WorkflowSettings = z.infer<typeof workflowSettingsSchema>;

export const workflowRecordSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    description: z.string().optional(),
    enabled: z.boolean().default(false),
    revision: z.number().int().nonnegative().default(0),
    project: workflowProjectSchema,
    settings: workflowSettingsSchema.default({}),
    nodes: z.array(workflowNodeSchema).default([]),
    edges: z.array(workflowEdgeSchema).default([]),
    /** Pinned outputs for test runs, by node id. */
    pinned: z.record(z.string(), z.unknown()).optional(),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true })
  })
  .passthrough();
export type WorkflowRecord = z.infer<typeof workflowRecordSchema>;

// ---------------------------------------------------------------------------
// workflows.json — entry-wise tolerant (the saved-prompts pattern)
// ---------------------------------------------------------------------------

export interface WorkflowsFile {
  version: 1;
  workflows: WorkflowRecord[];
  /** Entries that failed the schema, or repeated an earlier id — written back verbatim. */
  rejected: unknown[];
  /** Every top-level key but `version` and `workflows`, verbatim. */
  extra: Record<string, unknown>;
}

export function createDefaultWorkflowsFile(): WorkflowsFile {
  return { version: 1, workflows: [], rejected: [], extra: {} };
}

/**
 * A record that fails its schema is set aside in `rejected` and the rest load. The OUTER
 * shape throws — a version other than 1 included — which the daemon reads as "not mine to
 * rewrite": the file is moved aside, never overwritten.
 */
export function parseWorkflowsFile(raw: unknown): WorkflowsFile {
  const outer = z
    .object({ version: z.literal(1).default(1), workflows: z.array(z.unknown()).default([]) })
    .safeParse(raw);
  if (!outer.success) {
    const issue = outer.error.issues[0];
    const where = issue && issue.path.length > 0 ? issue.path.join(".") : "the file";
    throw new Error(`Not a version-1 workflows file (${where}: ${issue?.message ?? "invalid"})`);
  }
  const workflows: WorkflowRecord[] = [];
  const rejected: unknown[] = [];
  const ids = new Set<string>();
  for (const entry of outer.data.workflows) {
    const parsed = workflowRecordSchema.safeParse(entry);
    if (parsed.success && !ids.has(parsed.data.id)) {
      ids.add(parsed.data.id);
      workflows.push(parsed.data);
    } else {
      rejected.push(entry);
    }
  }
  const extra = Object.fromEntries(
    Object.entries(raw as Record<string, unknown>).filter(([key]) => key !== "version" && key !== "workflows")
  );
  return { version: 1, workflows, rejected, extra };
}

// ---------------------------------------------------------------------------
// workflow-state.json — runtime state that changes without an edit
// ---------------------------------------------------------------------------

/** Keyed `<workflowId>:<nodeId>`. */
export const scheduleCursorSchema = z
  .object({
    /** The cron this cursor was computed for; a changed cron recomputes from now. */
    cron: z.string(),
    timezone: z.string(),
    nextRunAt: z.string().datetime({ offset: true }).nullable(),
    lastFiredAt: z.string().datetime({ offset: true }).nullable().default(null)
  })
  .passthrough();
export type ScheduleCursor = z.infer<typeof scheduleCursorSchema>;

/** Keyed `<workflowId>:<nodeId>`; the poller owns the shape of `seen`. */
export const gitTriggerCursorSchema = z
  .object({
    /** The repo key this cursor was built for; a changed repo re-baselines. */
    repoKey: z.string(),
    /** The event config fingerprint; a changed filter re-baselines. */
    eventKey: z.string(),
    baselined: z.boolean().default(false),
    /** ref -> sha for branches/tags; `pr:<n>` -> `<state>:<headSha>`; `release:<id>` -> tag. */
    seen: z.record(z.string(), z.string()).default({}),
    /** Fired dedup keys, a ring (newest last), ≤ 1000. */
    fired: z.array(z.string()).default([]),
    lastPollAt: z.string().datetime({ offset: true }).nullable().default(null),
    lastError: z.string().nullable().default(null),
    failures: z.number().int().nonnegative().default(0)
  })
  .passthrough();
export type GitTriggerCursor = z.infer<typeof gitTriggerCursorSchema>;

/** Keyed `<family>:<accountId>` (accountId may be "system"). */
export const accountCooldownSchema = z
  .object({
    until: z.string().datetime({ offset: true }),
    reason: z.enum(["usage_limit", "auth"]),
    setAt: z.string().datetime({ offset: true }),
    detail: z.string().optional()
  })
  .passthrough();
export type AccountCooldown = z.infer<typeof accountCooldownSchema>;

export interface WorkflowStateFile {
  version: 1;
  schedules: Record<string, ScheduleCursor>;
  git: Record<string, GitTriggerCursor>;
  cooldowns: Record<string, AccountCooldown>;
  /** ETags for REST polling, keyed by request URL. */
  etags: Record<string, { etag: string; body: unknown }>;
}

export function createDefaultWorkflowStateFile(): WorkflowStateFile {
  return { version: 1, schedules: {}, git: {}, cooldowns: {}, etags: {} };
}

function tolerantRecord<T>(raw: unknown, schema: z.ZodType<T, z.ZodTypeDef, unknown>): Record<string, T> {
  const out: Record<string, T> = {};
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const parsed = schema.safeParse(value);
    if (parsed.success) out[key] = parsed.data;
  }
  return out;
}

/** Tolerant throughout: state is a cache of progress — a bad entry is dropped, never fatal. */
export function parseWorkflowStateFile(raw: unknown): WorkflowStateFile {
  const record = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const etagSchema = z.object({ etag: z.string(), body: z.unknown() });
  return {
    version: 1,
    schedules: tolerantRecord(record.schedules, scheduleCursorSchema),
    git: tolerantRecord(record.git, gitTriggerCursorSchema),
    cooldowns: tolerantRecord(record.cooldowns, accountCooldownSchema),
    etags: tolerantRecord(record.etags, etagSchema) as WorkflowStateFile["etags"]
  };
}

// ---------------------------------------------------------------------------
// workflow-secrets.json — 0600, values never leave the daemon (§5.7)
// ---------------------------------------------------------------------------

export const WORKFLOW_SECRET_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
export const WORKFLOW_SECRET_MAX_VALUE_BYTES = 64 * 1024;

export const workflowSecretEntrySchema = z.object({
  value: z.string(),
  updatedAt: z.string().datetime({ offset: true })
});
export type WorkflowSecretEntry = z.infer<typeof workflowSecretEntrySchema>;

export interface WorkflowSecretsFile {
  version: 1;
  global: Record<string, WorkflowSecretEntry>;
  /** workflowId -> name -> entry; a workflow's own secret shadows a global one. */
  workflows: Record<string, Record<string, WorkflowSecretEntry>>;
}

export function createDefaultWorkflowSecretsFile(): WorkflowSecretsFile {
  return { version: 1, global: {}, workflows: {} };
}

/** Throws on a foreign version (the daemon moves the file aside); tolerant per entry otherwise. */
export function parseWorkflowSecretsFile(raw: unknown): WorkflowSecretsFile {
  const outer = z
    .object({
      version: z.literal(1).default(1),
      global: z.record(z.string(), z.unknown()).default({}),
      workflows: z.record(z.string(), z.unknown()).default({})
    })
    .safeParse(raw);
  if (!outer.success) {
    throw new Error("Not a version-1 workflow secrets file");
  }
  const named = (value: unknown): Record<string, WorkflowSecretEntry> => {
    const entries = tolerantRecord(value, workflowSecretEntrySchema);
    return Object.fromEntries(Object.entries(entries).filter(([name]) => WORKFLOW_SECRET_NAME_PATTERN.test(name)));
  };
  const workflows: WorkflowSecretsFile["workflows"] = {};
  for (const [id, value] of Object.entries(outer.data.workflows)) {
    workflows[id] = named(value);
  }
  return { version: 1, global: named(outer.data.global), workflows };
}
