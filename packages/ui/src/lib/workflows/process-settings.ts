/**
 * The pure side of the Code, Shell and HTTP block forms
 * (inspector/ProcessSettings.tsx): their section summaries, the effective
 * timeouts (mirroring the daemon's `blockTimeoutMs`), the HTTP success-status
 * list, a JSON body's shape check, and the environment variables that carry
 * a Shell script's {{ … }} values (the script itself is never rewritten).
 */

import {
  EXPRESSION_ROOTS,
  parseTemplate,
  singleExpression,
  WORKFLOW_LIMITS,
  type CodeBlockConfig,
  type HttpBlockConfig,
  type ShellBlockConfig,
  type TemplateExpression,
  type WorkflowNode
} from "@orquester/api";

import { nodeSummary } from "./catalog-ui";
import { formatMinutes, formatSeconds } from "./durations";

const plural = (count: number, one: string, many = `${one}s`): string => `${count} ${count === 1 ? one : many}`;

// ---------------------------------------------------------------------------
// Limits and timeouts
// ---------------------------------------------------------------------------

/** 4096 → "4 GB", 1536 → "1.5 GB", 256 → "256 MB", 3000 → "3000 MB" (not a round number of GB). */
export function formatMemoryMb(mb: number): string {
  const gb = mb / 1024;
  if (mb >= 1024 && Math.abs(gb * 100 - Math.round(gb * 100)) < 1e-9) return `${Math.round(gb * 100) / 100} GB`;
  return `${mb} MB`;
}

/** Where a block's effective timeout comes from: its own setting, the block-wide timeout, or the default. */
export type TimeoutSource = "config" | "node" | "default";

/**
 * A code or shell block's effective timeout in minutes, as the daemon applies
 * it (run-context `blockTimeoutMs`): `config.timeoutMinutes`, else the
 * block-wide `timeoutMinutes`, else 30 min — capped at 24 h.
 */
export function processTimeout(configMinutes: number | undefined, nodeMinutes: number | undefined): { minutes: number; source: TimeoutSource } {
  const { default: fallback, max } = WORKFLOW_LIMITS.processTimeoutMinutes;
  if (configMinutes !== undefined) return { minutes: Math.min(configMinutes, max), source: "config" };
  if (typeof nodeMinutes === "number" && nodeMinutes > 0) return { minutes: Math.min(nodeMinutes, max), source: "node" };
  return { minutes: fallback, source: "default" };
}

/**
 * An HTTP block's effective timeout in seconds (run-context `blockTimeoutMs`):
 * `config.timeoutSeconds`, else the block-wide `timeoutMinutes`, else 5 min —
 * capped at 1 h.
 */
export function httpTimeout(configSeconds: number | undefined, nodeMinutes: number | undefined): { seconds: number; source: TimeoutSource } {
  const { default: fallback, max } = WORKFLOW_LIMITS.httpTimeoutSeconds;
  if (configSeconds !== undefined) return { seconds: Math.min(configSeconds, max), source: "config" };
  if (typeof nodeMinutes === "number" && nodeMinutes > 0) return { seconds: Math.min(nodeMinutes * 60, max), source: "node" };
  return { seconds: fallback, source: "default" };
}

const FROM_NODE = "from Run behaviour";

/** "Default limits (4 GB, 30 min)", "8 GB · 10 min", "8 GB · 30 min (default)". */
export function codeLimitsSummary(config: Pick<CodeBlockConfig, "memoryMb" | "timeoutMinutes">, nodeMinutes?: number): string {
  const memory = config.memoryMb;
  const timeout = processTimeout(config.timeoutMinutes, nodeMinutes);
  if (memory === undefined && timeout.source === "default") {
    return `Default limits (${formatMemoryMb(WORKFLOW_LIMITS.codeMemoryMb.default)}, ${formatMinutes(timeout.minutes)})`;
  }
  const memoryText = memory === undefined ? `${formatMemoryMb(WORKFLOW_LIMITS.codeMemoryMb.default)} (default)` : formatMemoryMb(memory);
  return `${memoryText} · ${timeoutText(formatMinutes(timeout.minutes), timeout.source)}`;
}

/** "Default timeout (30 min)", "Times out after 10 min", "Times out after 45 min (from Run behaviour)". */
export function shellLimitsSummary(config: Pick<ShellBlockConfig, "timeoutMinutes">, nodeMinutes?: number): string {
  const timeout = processTimeout(config.timeoutMinutes, nodeMinutes);
  if (timeout.source === "default") return `Default timeout (${formatMinutes(timeout.minutes)})`;
  return `Times out after ${timeoutText(formatMinutes(timeout.minutes), timeout.source)}`;
}

function timeoutText(duration: string, source: TimeoutSource): string {
  if (source === "default") return `${duration} (default)`;
  if (source === "node") return `${duration} (${FROM_NODE})`;
  return duration;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

/** Methods that never send a body (the daemon drops one: nodes/http.ts). */
export function methodSendsBody(method: HttpBlockConfig["method"]): boolean {
  return method !== "GET" && method !== "HEAD";
}

/** "POST hooks.slack.com/… · 2 headers · 1 query parameter" — the canvas line plus the row counts. */
export function httpRequestSummary(node: Extract<WorkflowNode, { type: "http" }>): string {
  const parts = [nodeSummary(node)];
  if (node.config.query.length > 0) parts.push(plural(node.config.query.length, "query parameter"));
  if (node.config.headers.length > 0) parts.push(plural(node.config.headers.length, "header"));
  return parts.join(" · ");
}

/** "No body", "JSON", "Text (text/csv)", "Form · 2 fields", "Not sent with GET". */
export function httpBodySummary(config: Pick<HttpBlockConfig, "method" | "body">): string {
  if (!methodSendsBody(config.method)) return config.body ? `Ignored: ${config.method} sends no body` : `Not sent with ${config.method}`;
  const body = config.body;
  if (!body) return "No body";
  if (body.kind === "json") return "JSON";
  if (body.kind === "text") return `Text (${body.contentType?.trim() || "text/plain"})`;
  return `Form · ${plural(body.fields.length, "field")}`;
}

export type HttpBodyKind = "none" | "json" | "text" | "form";

/**
 * An HTTP config with its body switched to `kind`. The kind it already has
 * returns the config untouched (re-picking "Form" must not empty its fields,
 * nor "Text" drop its content type); JSON and text carry the written value
 * across, and a new JSON body starts as an empty object.
 */
export function httpConfigWithBodyKind(current: HttpBlockConfig, kind: HttpBodyKind): HttpBlockConfig {
  if ((current.body?.kind ?? "none") === kind) return current;
  const { body: _body, ...rest } = current;
  if (kind === "none") return rest as HttpBlockConfig;
  if (kind === "form") return { ...rest, body: { kind: "form", fields: [] } } as HttpBlockConfig;
  const value = current.body && "value" in current.body ? current.body.value : "";
  return { ...rest, body: kind === "json" ? { kind: "json", value: value || "{\n  \n}" } : { kind: "text", value } } as HttpBlockConfig;
}

/**
 * The success statuses after picking "Any 2xx" or "Only these statuses": the
 * mode already chosen keeps them as they are; "list" brings back `lastList`
 * (the latest explicit list), else 200.
 */
export function successStatusesForMode(
  current: HttpBlockConfig["successStatuses"],
  mode: "2xx" | "list",
  lastList: readonly number[]
): HttpBlockConfig["successStatuses"] {
  if (mode === (current === "2xx" ? "2xx" : "list")) return current;
  return mode === "2xx" ? "2xx" : lastList.length > 0 ? [...lastList] : [200];
}

/** "Any 2xx · follows redirects · 5 min timeout (default)". */
export function httpResponseSummary(
  config: Pick<HttpBlockConfig, "successStatuses" | "followRedirects" | "timeoutSeconds">,
  nodeMinutes?: number
): string {
  const statuses = config.successStatuses === "2xx" ? "Any 2xx" : `Only ${statusListText(config.successStatuses)}`;
  const redirects = config.followRedirects ? "follows redirects" : "doesn't follow redirects";
  const timeout = httpTimeout(config.timeoutSeconds, nodeMinutes);
  return `${statuses} · ${redirects} · ${timeoutText(formatSeconds(timeout.seconds), timeout.source)} timeout`;
}

/** "200, 201, 404". */
export function statusListText(statuses: readonly number[]): string {
  return statuses.join(", ");
}

/**
 * A typed status list: the valid codes (100–599, first mention kept, in order)
 * and the pieces that are not codes. Commas, semicolons and spaces separate.
 */
export function parseStatusList(text: string): { statuses: number[]; invalid: string[] } {
  const statuses: number[] = [];
  const invalid: string[] = [];
  for (const token of text.split(/[\s,;]+/)) {
    if (token.length === 0) continue;
    const code = /^\d{3}$/.test(token) ? Number(token) : Number.NaN;
    if (code >= 100 && code <= 599) {
      if (!statuses.includes(code)) statuses.push(code);
    } else invalid.push(token);
  }
  return { statuses, invalid };
}

/** Why a typed status list can't be used as is, or null. */
export function statusListProblem(text: string): string | null {
  const { statuses, invalid } = parseStatusList(text);
  if (invalid.length > 0) {
    const shown = invalid.map((token) => `“${token}”`).join(", ");
    return `${shown} ${invalid.length === 1 ? "isn't a status code" : "aren't status codes"} (100–599)`;
  }
  if (statuses.length === 0) return "List at least one status code, e.g. 200";
  return null;
}

/**
 * Whether a JSON body will be valid JSON once its `{{ … }}` are filled in, or
 * why not — a best guess made by standing a value in for each expression (a
 * number outside quotes, a letter inside). Exactly one `{{ … }}` is always
 * fine: its value is encoded as JSON (nodes/http.ts). null = looks fine or
 * can't tell (a broken expression is validation's to report).
 */
export function jsonBodyProblem(text: string): string | null {
  if (text.trim().length === 0) return "Empty — a JSON body needs a value, e.g. {}";
  if (singleExpression(text) !== null) return null;
  const parsed = parseTemplate(text);
  if (parsed.errors.length > 0) return null;
  let probe = "";
  let inString = false;
  let escaped = false;
  for (const segment of parsed.segments) {
    if (segment.kind === "expr") {
      probe += inString ? "x" : "0";
      continue;
    }
    for (const char of segment.text) {
      probe += char;
      if (escaped) escaped = false;
      else if (inString && char === "\\") escaped = true;
      else if (char === '"') inString = !inString;
    }
  }
  try {
    JSON.parse(probe);
    return null;
  } catch (error) {
    return `Not valid JSON: ${jsonErrorText(error)}`;
  }
}

/** V8's JSON.parse message without the position (it points into the stand-in text) or a quoted snippet. */
function jsonErrorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const withoutPosition = message.replace(/\s+in JSON at position[\s\S]*$/, "");
  const withoutSnippet = / is not valid JSON$/.test(withoutPosition) ? withoutPosition.split(",")[0]! : withoutPosition;
  const text = withoutSnippet.trim() || "check the commas, quotes and brackets";
  return text.endsWith(".") ? text : `${text}.`;
}

// ---------------------------------------------------------------------------
// Shell: passing {{ … }} values as environment variables
// ---------------------------------------------------------------------------

export const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Environment names a suggested variable must not take: the shell, the loader, the sandbox or a
 * common tool gives each a meaning of its own (a value there could change what runs, not just what
 * the script reads). Together with `RESERVED_ENV_PREFIXES`.
 */
const RESERVED_ENV_NAMES: ReadonlySet<string> = new Set([
  // The shell and the process.
  "PATH",
  "HOME",
  "SHELL",
  "USER",
  "LOGNAME",
  "PWD",
  "OLDPWD",
  "IFS",
  "PS0",
  "PS1",
  "PS2",
  "PS3",
  "PS4",
  "ENV",
  "BASH",
  "CDPATH",
  "MAIL",
  "MAILPATH",
  "MAILCHECK",
  "OPTARG",
  "OPTIND",
  "OPTERR",
  "LANG",
  "LANGUAGE",
  "TERM",
  "TERMINFO",
  "TERMCAP",
  "TZ",
  "TZDIR",
  "TMPDIR",
  "TMP",
  "TEMP",
  "TMOUT",
  "HOSTNAME",
  "HOSTTYPE",
  "MACHTYPE",
  "OSTYPE",
  "SHLVL",
  "RANDOM",
  "SRANDOM",
  "SECONDS",
  "LINENO",
  "UID",
  "EUID",
  "PPID",
  "GROUPS",
  "FUNCNAME",
  "PIPESTATUS",
  "SHELLOPTS",
  "BASHOPTS",
  "BASHPID",
  "GLOBIGNORE",
  "EXECIGNORE",
  "FIGNORE",
  "FCEDIT",
  "TIMEFORMAT",
  "POSIXLY_CORRECT",
  "PROMPT_COMMAND",
  "PROMPT_DIRTRIM",
  "COLUMNS",
  "LINES",
  "EPOCHSECONDS",
  "EPOCHREALTIME",
  "REPLY",
  "DIRSTACK",
  "COPROC",
  "INPUTRC",
  "HOSTFILE",
  "HOSTALIASES",
  "LOCALDOMAIN",
  "RES_OPTIONS",
  "NLSPATH",
  "GCONV_PATH",
  "GLIBC_TUNABLES",
  "ZDOTDIR",
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "DBUS_SESSION_BUS_ADDRESS",
  // Programs other tools start: an editor, a pager, a password prompt.
  "EDITOR",
  "VISUAL",
  "PAGER",
  "MANPAGER",
  "MANPATH",
  "BROWSER",
  "LESS",
  "LESSOPEN",
  "LESSCLOSE",
  "LESSKEY",
  "KUBECONFIG",
  "GNUPGHOME",
  "NETRC",
  "WGETRC",
  "CURL_HOME",
  "CLASSPATH",
  "GOFLAGS",
  "GOPATH",
  "GOROOT",
  "GOBIN",
  "GOENV",
  "GOPROXY",
  "GOPRIVATE",
  "GONOSUMDB",
  "GONOSUMCHECK",
  "GOINSECURE",
  "GOTOOLCHAIN",
  "GOCACHE",
  "GOMODCACHE",
  "GOOS",
  "GOARCH",
  "CC",
  "CXX",
  "CPP",
  "CFLAGS",
  "CXXFLAGS",
  "CPPFLAGS",
  "LDFLAGS",
  "MAKE",
  "MAKEFLAGS",
  "MFLAGS",
  "MAKEFILES",
  "RUSTFLAGS",
  "RUSTC",
  "RUSTC_WRAPPER",
  "RUSTDOCFLAGS",
  "PHPRC",
  "TCLLIBPATH",
  "MAVEN_OPTS",
  "GRADLE_OPTS",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "FTP_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "MYSQL_PWD",
  "MYSQL_HOST",
  "SUDO_ASKPASS"
]);

/** Name prefixes the same goes for: whole families of settings a shell, loader or tool reads. */
const RESERVED_ENV_PREFIXES: readonly string[] = [
  "BASH_",
  "LC_",
  "LD_",
  "DYLD_",
  "MALLOC_",
  "HIST",
  "READLINE_",
  "COMP_",
  "ZSH",
  "XDG_",
  "SUDO_",
  "SSH_",
  "GPG_",
  "GIT_",
  "GH_",
  "GITHUB_",
  "DOCKER_",
  "COMPOSE_",
  "BUILDKIT_",
  "CONTAINERS_",
  "KUBE",
  "HELM_",
  "NPM_",
  "NPM_CONFIG_",
  "YARN_",
  "PNPM_",
  "COREPACK_",
  "NODE_",
  "DENO_",
  "BUN_",
  "PIP_",
  "UV_",
  "PYTHON",
  "VIRTUAL_ENV",
  "CONDA_",
  "PERL",
  "RUBY",
  "GEM_",
  "BUNDLE_",
  "LUA_",
  "PHP_",
  "JAVA",
  "JDK_",
  "DOTNET_",
  "CARGO_",
  "RUSTUP_",
  "CGO_",
  "PG",
  "OPENSSL_",
  "SSL_",
  "CURL_",
  "REQUESTS_",
  "AWS_",
  "AZURE_",
  "GOOGLE_",
  "CLOUDSDK_",
  "TF_",
  "VAULT_",
  "ANSIBLE_",
  "SYSTEMD_",
  "ORQUESTER_"
];

/** Whether a variable name is one the shell, the loader, the sandbox or a common tool gives a meaning of its own. */
export function isReservedEnvName(name: string): boolean {
  const upper = name.toUpperCase();
  return RESERVED_ENV_NAMES.has(upper) || RESERVED_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix));
}

/** A readable variable name for what an expression reads: `input.prTitle` → INPUT_PR_TITLE; a reserved one gets a WF_ in front. */
function variableNameFor(expr: TemplateExpression): string {
  const words = expr.path.filter((part): part is string => typeof part === "string");
  let parts: string[];
  if (expr.root === "secrets") parts = words.slice(0, 1);
  else if (expr.root === "nodes") {
    const [name, ...rest] = words;
    parts = [name ?? "node", ...(rest[0] === "output" ? rest.slice(1) : rest).slice(-2)];
  } else parts = [expr.root, ...words.slice(-2)];
  let name = parts
    .map((part) => part.replace(/([a-z0-9])([A-Z])/g, "$1_$2"))
    .join("_")
    .toUpperCase()
    .replace(/[^A-Z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
  if (name.length === 0) name = "VALUE";
  if (/^[0-9]/.test(name)) name = `V_${name}`;
  if (name.length > 40) name = name.slice(0, 40).replace(/_$/, "");
  if (isReservedEnvName(name)) name = `WF_${name}`;
  return name;
}

/** One distinct `{{ … }}` of a script and the environment variable that carries its value. */
export interface ShellEnvVariable {
  name: string;
  /** The `{{ … }}` as first written in the script. */
  expression: string;
  /** True when the variable isn't under Environment yet: adding the variables creates its row. */
  added: boolean;
}

export interface ShellEnvPlan {
  /** The Environment rows with the new ones appended; existing rows are copied whole, unknown fields kept. */
  env: { name: string; value: string }[];
  /** One per distinct expression, in order of first use. */
  variables: ShellEnvVariable[];
  /** Whether the script also holds a broken `{{ …` that can't be moved as it is. */
  incomplete: boolean;
}

/**
 * The environment variables that would carry a shell script's `{{ … }}` values. It NEVER edits the
 * script: rewriting a script so a value can't run as code is not something a program can promise
 * (a variable is safe only where the script reads it as data), so the script is the author's to
 * change, reading each variable as `"$NAME"`.
 *
 * Each distinct expression reuses the row that already holds exactly it — its whole value, nothing
 * around it — when that row wins at run time (no later row with its name), has a usable,
 * non-reserved name, and the script only ever reads that name (`$NAME` / `${NAME}`), never sets it.
 * Otherwise a new row is planned, named after what the expression reads: a valid name that no row
 * and no word of the script uses and that no shell or tool gives a meaning. Running it again once
 * the rows exist plans nothing new.
 */
export function planShellEnvVariables(script: string, env: readonly { name: string; value: string }[]): ShellEnvPlan {
  const parsed = parseTemplate(script);
  // A broken `{{ input…` is one the validator counts; `{{.Field}}` (a Go template, say) is plain text.
  const incomplete = parsed.errors.some((error) => error.root !== undefined && (EXPRESSION_ROOTS as readonly string[]).includes(error.root));
  const exprs = parsed.segments.filter((segment): segment is TemplateExpression => segment.kind === "expr");
  const rows = env.map((row) => ({ ...row }));

  // The script's own words, outside its expressions: `VERSION=1; echo {{ … }}` must not get VERSION.
  let rest = script;
  for (let index = exprs.length - 1; index >= 0; index -= 1) rest = rest.slice(0, exprs[index]!.start) + " " + rest.slice(exprs[index]!.end);
  const scriptWords = new Set(rest.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []);
  /** Whether every mention of `name` in the script is a plain read, `$NAME` or `${NAME}`. */
  const onlyRead = (name: string): boolean => {
    if (!scriptWords.has(name)) return true;
    const mention = new RegExp(`(?<![A-Za-z0-9_])${name}(?![A-Za-z0-9_])`, "g");
    for (const match of rest.matchAll(mention)) {
      const at = match.index;
      const plain = rest[at - 1] === "$";
      const braced = rest.slice(at - 2, at) === "${" && rest[at + name.length] === "}";
      if (!plain && !braced) return false;
    }
    return true;
  };

  const byExpression = new Map<string, string>();
  rows.forEach((row, index) => {
    if (!ENV_NAME_PATTERN.test(row.name) || isReservedEnvName(row.name) || row.value !== row.value.trim()) return;
    if (rows.some((other, at) => at > index && other.name === row.name)) return;
    const single = singleExpression(row.value);
    if (single === null || byExpression.has(single.source) || !onlyRead(row.name)) return;
    byExpression.set(single.source, row.name);
  });

  const taken = new Set<string>([...rows.map((row) => row.name), ...scriptWords]);
  const variables: ShellEnvVariable[] = [];
  const seen = new Set<string>();
  for (const expr of exprs) {
    if (seen.has(expr.source)) continue;
    seen.add(expr.source);
    const known = byExpression.get(expr.source);
    if (known !== undefined) {
      variables.push({ name: known, expression: expr.raw, added: false });
      continue;
    }
    const base = variableNameFor(expr);
    let name = base;
    for (let n = 2; taken.has(name); n += 1) name = `${base}_${n}`;
    taken.add(name);
    rows.push({ name, value: expr.raw });
    variables.push({ name, expression: expr.raw, added: true });
  }
  return { env: rows, variables, incomplete };
}

/**
 * The per-row notes of a Shell block's environment: a missing or malformed
 * name fails the block when it runs (nodes/shell.ts), a repeated one is set by
 * its last row.
 */
export function envRowProblem(rows: readonly { name: string; value: string }[], index: number): { error: string | null; warning: string | null } {
  const row = rows[index];
  if (!row) return { error: null, warning: null };
  if (row.name.length === 0) return { error: null, warning: "Give it a name — the block fails on a variable without one." };
  if (!ENV_NAME_PATTERN.test(row.name)) return { error: "Letters, digits and _ only, not starting with a digit — the block fails otherwise.", warning: null };
  const later = rows.findIndex((other, at) => at > index && other.name === row.name);
  if (later !== -1) return { error: null, warning: `Set again in row ${later + 1}; the last one wins.` };
  return { error: null, warning: null };
}

/** HTTP header names the daemon accepts (nodes/http.ts refuses the block otherwise). */
export const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/** A header or query row's note: an empty name is skipped when the request is sent. */
export function requestRowProblem(
  rows: readonly { name: string; value: string }[],
  index: number,
  kind: "header" | "query"
): { error: string | null; warning: string | null } {
  const row = rows[index];
  if (!row) return { error: null, warning: null };
  if (row.name.length === 0) return { error: null, warning: row.value.length > 0 ? "No name — this row is left out of the request." : null };
  if (kind === "header" && !HEADER_NAME_PATTERN.test(row.name)) {
    return {
      error: "Not a valid header name: letters, digits and ! # $ % & ' * + - . ^ _ ` | ~ only (no spaces or colons) — the block fails otherwise.",
      warning: null
    };
  }
  return { error: null, warning: null };
}
