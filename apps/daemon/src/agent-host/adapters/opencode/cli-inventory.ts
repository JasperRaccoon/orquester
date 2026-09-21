/**
 * Agent host — the OpenCode **CLI fallback inventory** (spec §4.5 OpenCode,
 * "Catalogue fallbacks").
 *
 * Ported from T3 Code (MIT): `apps/server/src/provider/opencodeRuntime.ts`
 * (`loadInventoryFromCli`, `parseModelsCliOutput`, `parseAgentListCliOutput`,
 * `parseSkillsCliOutput`).
 *
 * The HTTP path needs a project directory, because that is what a server is
 * started for. The host's background snapshot loop has none
 * (`orchestration/provider-snapshots.ts` refreshes machine-level), so without
 * this the OpenCode card shows **no models and unknown auth** until a thread
 * opens. This is the machine-level answer: three CLI probes, no server, no
 * port, no session.
 *
 * **Sequential, not concurrent** — and this is the whole reason the spec says
 * so: every OpenCode CLI command opens the same shared SQLite database, and
 * running them together fails with `database is locked`. A non-zero exit gets
 * one retry after a second, for the same reason.
 *
 * Only `models` is authoritative: agents and skills enrich a snapshot and may
 * each degrade to `[]`. The live path still prefers the SDK `GET /skill`,
 * because the Bun-compiled binary truncates non-TTY stdout at one 64 KB pipe
 * buffer for some commands.
 */

import type { AdapterLogger } from "../../adapter.ts";
import { AGENT_HOST_DEADLINES, withDeadline } from "../../support/deadline.ts";
import { spawnProviderChild } from "../../support/spawn.ts";
import type {
  OpenCodeAgentRow,
  OpenCodeModelRow,
  OpenCodeProviderRow,
  OpenCodeSkillRow,
  ProviderListResponse
} from "./routes.ts";
import type { OpenCodeInventory } from "./snapshot.ts";
import { delay } from "./util.ts";

/** `models --verbose` moves the whole catalogue; this host answered ~4.3 MB. */
const MODELS_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
/** `debug skill` inlines every skill body. T3 uses the same 8 MiB ceiling. */
const SKILLS_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const AGENTS_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
/** One CLI probe. Longer than an HTTP call: it is a cold Bun start. */
const CLI_PROBE_TIMEOUT_MS = 30_000;
/** The SQLite-lock retry pause. */
const CLI_RETRY_DELAY_MS = 1_000;

export interface CliCommandResult {
  stdout: string;
  code: number;
  /** Set when the command never produced an exit status we could read. */
  failure?: string;
}

export interface RunOpenCodeCliInput {
  bin: string;
  args: readonly string[];
  cwd: string;
  env: Record<string, string>;
  maxOutputBytes: number;
  signal?: AbortSignal;
}

/** Run one `opencode …`, bounded in time and in bytes. Never throws. */
export async function runOpenCodeCli(input: RunOpenCodeCliInput): Promise<CliCommandResult> {
  let child;
  try {
    child = spawnProviderChild({
      command: input.bin,
      args: input.args,
      env: input.env,
      cwd: input.cwd
    });
  } catch (error) {
    return { stdout: "", code: -1, failure: describe(error) };
  }

  let stdout = "";
  let bytes = 0;
  let truncated = false;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    if (truncated) {
      return;
    }
    bytes += Buffer.byteLength(chunk);
    if (bytes > input.maxOutputBytes) {
      truncated = true;
      return;
    }
    stdout += chunk;
  });
  // stderr is drained but not retained: a probe's diagnostics are not a
  // thread's business, and leaving the pipe unread can block the child.
  child.stderr.resume();

  try {
    const reason = await withDeadline(child.exited, {
      label: `opencode ${input.args.join(" ")}`,
      timeoutMs: CLI_PROBE_TIMEOUT_MS,
      onTimeout: () => void child.kill().catch(() => undefined),
      ...(input.signal !== undefined ? { signal: input.signal } : {})
    });
    if (reason.kind !== "exit") {
      return { stdout, code: -1, failure: describeExitReason(reason) };
    }
    return { stdout, code: reason.code };
  } catch (error) {
    await child.kill().catch(() => undefined);
    return { stdout, code: -1, failure: describe(error) };
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function describeExitReason(reason: { kind: string }): string {
  return reason.kind === "signal" ? "killed by a signal" : "failed to spawn";
}

// ---------------------------------------------------------------------------
// Parsers — verified against the real 1.18.5 output on this host
// ---------------------------------------------------------------------------

/** A bare `provider/model` header line. */
const SLUG_LINE_RE = /^(\S+\/\S+)\s*$/;
/** `build (primary)` — name, then the mode in parentheses. */
const AGENT_HEADER_RE = /^(.+?)\s+\((\S+)\)\s*$/;

/**
 * Agents OpenCode always hides, which `agent list` does not flag. Kept in
 * sync with the OpenCode repo's own agent definitions.
 */
const KNOWN_HIDDEN_AGENTS: ReadonlySet<string> = new Set(["compaction", "summary", "title"]);

/**
 * Is this a `provider/model` header rather than a line of the JSON body?
 *
 * Three facts about the real 1.18.5 output make this exact, and T3's single
 * `startsWith("{")` guard does not cover the second:
 *
 * 1. a header is **never indented** — every body line of the pretty-printed
 *    JSON is, except its opening `{` and closing `}`;
 * 2. a header never starts with a JSON punctuation character — which is what
 *    stops a compact value line such as `"vendor/model-x",` (no interior
 *    whitespace, contains a `/`) from matching and flushing the model away
 *    half-read;
 * 3. a header has no interior whitespace, which `SLUG_LINE_RE` already checks.
 *
 * Keeping it line-local rather than brace-tracked is deliberate: an
 * unterminated body then costs one model, not every model after it.
 */
function isSlugLine(line: string): boolean {
  if (line.length === 0 || /^\s/.test(line)) {
    return false;
  }
  const first = line[0];
  if (first === "{" || first === "}" || first === '"' || first === "[" || first === "]") {
    return false;
  }
  return SLUG_LINE_RE.test(line);
}

/**
 * `opencode models --verbose` prints a `provider/model` slug line followed by
 * that model's pretty-printed JSON body.
 *
 * The `{`-guard is load-bearing, and T3 learned it the hard way: a body line
 * with no interior whitespace and a `/` in one of its values — an OpenRouter
 * model whose `id` is `vendor/model` — also matches `SLUG_LINE_RE`, which
 * would flush an empty body and silently drop the model.
 */
export function parseModelsCliOutput(stdout: string): ProviderListResponse {
  const providers = new Map<string, OpenCodeProviderRow>();
  let currentSlug: string | null = null;
  let body: string[] = [];

  const flush = (): void => {
    if (currentSlug !== null && body.length > 0) {
      const text = body.join("\n").trim();
      if (text.length > 0) {
        try {
          const model = JSON.parse(text) as OpenCodeModelRow;
          const separator = currentSlug.indexOf("/");
          if (separator > 0) {
            const providerID = currentSlug.slice(0, separator);
            const modelID = currentSlug.slice(separator + 1);
            let provider = providers.get(providerID);
            if (provider === undefined) {
              provider = { id: providerID, name: providerID, models: {} };
              providers.set(providerID, provider);
            }
            provider.models[modelID] = { ...model, id: model.id ?? modelID };
          }
        } catch {
          // An unparseable body drops that one model, never the catalogue.
        }
      }
    }
    currentSlug = null;
    body = [];
  };

  for (const line of stdout.split("\n")) {
    if (isSlugLine(line)) {
      flush();
      currentSlug = line.trim();
      continue;
    }
    if (currentSlug !== null) {
      body.push(line);
    }
  }
  flush();

  // A provider only appears in this output when it is usable, so the CLI's
  // catalogue IS the connected list — which is what §4.5 infers login from.
  return { all: [...providers.values()], connected: [...providers.keys()] };
}

/** `opencode agent list` — a `name (mode)` header, then its permission JSON. */
export function parseAgentListCliOutput(stdout: string): OpenCodeAgentRow[] {
  const agents: OpenCodeAgentRow[] = [];
  let header: { name: string; mode: string } | null = null;
  let body: string[] = [];

  const flush = (): void => {
    if (header !== null) {
      agents.push({
        name: header.name,
        mode: header.mode as OpenCodeAgentRow["mode"],
        hidden: KNOWN_HIDDEN_AGENTS.has(header.name)
      });
    }
    header = null;
    body = [];
  };

  for (const line of stdout.split("\n")) {
    const match = line.trimStart().startsWith("{") ? null : AGENT_HEADER_RE.exec(line);
    if (match !== null && match[1] !== undefined && match[2] !== undefined) {
      flush();
      header = { name: match[1].trim(), mode: match[2] };
    } else if (header !== null) {
      body.push(line);
    }
  }
  flush();
  return agents;
}

/**
 * Scan a possibly-truncated JSON array for its **complete** top-level objects.
 *
 * `opencode debug skill` inlines every skill's whole body, and the
 * Bun-compiled binary truncates its stdout when it is a pipe rather than a
 * TTY: measured on this host at 218 171 bytes through a pipe against 265 625
 * to a file, for the identical command. A plain `JSON.parse` of that loses
 * **all** 24 skills. This recovers the ones that arrived whole.
 */
function salvageJsonObjects(text: string): unknown[] {
  const out: unknown[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = inString;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (char === "{") {
      if (depth === 0) {
        start = index;
      }
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        try {
          out.push(JSON.parse(text.slice(start, index + 1)));
        } catch {
          // A malformed object costs that object, never the scan.
        }
        start = -1;
      } else if (depth < 0) {
        // Unbalanced: give up rather than guess.
        return out;
      }
    }
  }
  return out;
}

/** `opencode debug skill` — one JSON array of `{name, description, location}`. */
export function parseSkillsCliOutput(stdout: string): OpenCodeSkillRow[] {
  const text = stdout.trim();
  if (text.length === 0) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Truncated mid-array — recover every object that arrived whole.
    parsed = salvageJsonObjects(text);
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  const rows: OpenCodeSkillRow[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const row = entry as { name?: unknown; description?: unknown; location?: unknown };
    if (typeof row.name !== "string") {
      continue;
    }
    rows.push({
      name: row.name,
      ...(typeof row.description === "string" ? { description: row.description } : {}),
      ...(typeof row.location === "string" ? { location: row.location } : {})
      // `content` is deliberately dropped: it inlines every skill body and is
      // megabytes of text this snapshot never renders.
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// The probe
// ---------------------------------------------------------------------------

export interface LoadInventoryFromCliInput {
  bin: string;
  /** Any directory; a machine-level probe uses one with no project config. */
  cwd: string;
  env: Record<string, string>;
  logger?: AdapterLogger;
  signal?: AbortSignal;
  /** Test seam. */
  run?: (input: RunOpenCodeCliInput) => Promise<CliCommandResult>;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * The three probes, in order, with one retry apiece on a non-zero exit.
 * Rejects only when `models` — the authoritative one — cannot be read.
 */
export async function loadInventoryFromCli(
  input: LoadInventoryFromCliInput
): Promise<OpenCodeInventory> {
  const run = input.run ?? runOpenCodeCli;
  const sleep = input.sleep ?? ((ms: number) => delay(ms, input.signal));
  const base = {
    bin: input.bin,
    cwd: input.cwd,
    env: input.env,
    ...(input.signal !== undefined ? { signal: input.signal } : {})
  };

  const runModels = (): Promise<CliCommandResult> =>
    run({ ...base, args: ["models", "--verbose"], maxOutputBytes: MODELS_MAX_OUTPUT_BYTES });
  const runAgents = (): Promise<CliCommandResult> =>
    run({ ...base, args: ["agent", "list"], maxOutputBytes: AGENTS_MAX_OUTPUT_BYTES });
  const runSkills = (): Promise<CliCommandResult> =>
    run({ ...base, args: ["debug", "skill"], maxOutputBytes: SKILLS_MAX_OUTPUT_BYTES });

  // One at a time: concurrent runs hit the same SQLite file (§4.5).
  let models = await runModels();
  let agents = await runAgents();
  let skills = await runSkills();

  const failed = (result: CliCommandResult): boolean => result.code !== 0;
  if (failed(models) || failed(agents) || failed(skills)) {
    // A `database is locked` is transient; one retry, still sequential.
    await sleep(CLI_RETRY_DELAY_MS);
    if (failed(models)) {
      models = await runModels();
    }
    if (failed(agents)) {
      agents = await runAgents();
    }
    if (failed(skills)) {
      skills = await runSkills();
    }
  }

  if (models.code !== 0) {
    throw new Error(
      `OpenCode \`models --verbose\` ${
        models.failure ?? `exited with code ${models.code}`
      }; the machine-level catalogue is unavailable.`
    );
  }

  const providers = parseModelsCliOutput(models.stdout);
  if (agents.code !== 0 || skills.code !== 0) {
    input.logger?.warn("opencode CLI inventory degraded", {
      agents: agents.code,
      skills: skills.code
    });
  }
  return {
    providers,
    agents: agents.code === 0 ? parseAgentListCliOutput(agents.stdout) : [],
    commands: [],
    skills: skills.code === 0 ? parseSkillsCliOutput(skills.stdout) : []
  };
}
