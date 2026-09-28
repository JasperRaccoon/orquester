/**
 * Agent profile — the REST surface (spec §8), every path in
 * `agentProfileRoutes`. Registered on BOTH transports (the unix socket and the
 * HTTP app, whose global bearer hook gates `/api/*`).
 *
 * Every request is parsed by hand into the exact wire shape before the
 * service sees it: a malformed one is 400 `INVALID_REQUEST` naming the field.
 * Every refusal is `{error: {code, message}}`: an `AgentProfileError` answers
 * its own status and code; anything else is logged and answered 500
 * `AGENT_PROFILE_ERROR` with a generic message. No message ever quotes a
 * secret value (an MCP env/header value, a git URL that may carry a token),
 * and a body Fastify cannot parse is refused without quoting it.
 *
 * `POST …/imports/upload?name=` takes the file as a raw
 * `application/octet-stream` body (never base64 in JSON), in its own
 * encapsulated scope like the other uploads (`upload-stream.ts`): every
 * refusal that can be decided before the body is read is answered with
 * `Connection: close` before a byte is read; the body streams to a temp file
 * under `agentProfileImportsDir(appdir)`, capped at `MAX_UPLOAD_BYTES`. The
 * temp file is the ROUTE's: it is deleted as soon as `scanUpload` returns or
 * throws — the import seam copies or extracts what it keeps during the scan.
 */

import { mkdir } from "node:fs/promises";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  AGENT_PROFILE_AGENTS,
  MAX_UPLOAD_BYTES,
  PROFILE_ITEM_KINDS,
  agentProfileRoutes,
  isAgentProfileAgentId,
  type AgentProfileAgentId,
  type AgentProfileErrorBody,
  type HookDraft,
  type MarketplaceDraft,
  type MarketplaceSource,
  type MarkdownDocumentDraft,
  type McpServerDraft,
  type McpTransport,
  type PluginInstallDraft,
  type ProfileConflictPolicy,
  type ProfileItemDraft,
  type SecretEntryDraft
} from "@orquester/api";
import {
  acceptRawBody,
  declaredLengthExceedsCap,
  discardUpload,
  isUploadTooLarge,
  receiveUpload,
  uploadTempPath
} from "../upload-stream.ts";
import { AgentProfileError, isAgentProfileError, profileErrors } from "./errors.ts";
import type { AgentProfileService } from "./service.ts";

export interface AgentProfileRouteDeps {
  service: Pick<
    AgentProfileService,
    | "overview"
    | "snapshot"
    | "readItem"
    | "create"
    | "createFromImport"
    | "update"
    | "setEnabled"
    | "remove"
    | "trust"
    | "copy"
    | "readInstructions"
    | "writeInstructions"
    | "migrateLegacyInstructions"
    | "scanGit"
    | "scanUpload"
    | "assertCanScanUpload"
    | "listMarketplacePlugins"
  >;
  /** `agentProfileImportsDir(appdir)`: where an upload is streamed before its scan. */
  importsDir: string;
}

/** A JSON body carrying a skill, a command or an instruction file: room for large markdown. */
export const AGENT_PROFILE_BODY_LIMIT = 4 * 1024 * 1024;

const TEXT_MAX = AGENT_PROFILE_BODY_LIMIT;
const NAME_MAX = 256;
const ID_MAX = 1024;
const URL_MAX = 4096;
const LIST_MAX = 500;
const CONFLICT_POLICIES: readonly ProfileConflictPolicy[] = ["fail", "replace", "keep-both"];
const MCP_TRANSPORT_VALUES: readonly McpTransport[] = ["stdio", "http", "sse"];

// Fastify route patterns, derived from the shared builders so they cannot drift.
const P = {
  overview: agentProfileRoutes.overview,
  snapshot: pattern(agentProfileRoutes.snapshot("claude")),
  items: pattern(agentProfileRoutes.items("claude")),
  item: pattern(agentProfileRoutes.item("claude", "ID")),
  itemEnabled: pattern(agentProfileRoutes.itemEnabled("claude", "ID")),
  itemTrust: pattern(agentProfileRoutes.itemTrust("claude", "ID")),
  itemCopy: pattern(agentProfileRoutes.itemCopy("claude", "ID")),
  instructions: pattern(agentProfileRoutes.instructions("claude")),
  instructionsMigrateLegacy: pattern(agentProfileRoutes.instructionsMigrateLegacy("claude")),
  importGit: pattern(agentProfileRoutes.importGit("claude")),
  importUpload: pattern(agentProfileRoutes.importUpload("claude")),
  marketplacePlugins: pattern(agentProfileRoutes.marketplacePlugins("claude", "NAME"))
};

/** `/api/agent-profile/claude/items/ID` → `/api/agent-profile/:agent/items/:id`. */
function pattern(path: string): string {
  return path
    .replace(/^\/api\/agent-profile\/claude(?=\/|$)/, "/api/agent-profile/:agent")
    .replace("/items/ID", "/items/:id")
    .replace("/marketplaces/NAME", "/marketplaces/:name");
}

type AgentParams = { agent: string };
type ItemParams = { agent: string; id: string };

export function registerAgentProfileRoutes(app: FastifyInstance, deps: AgentProfileRouteDeps): void {
  const { service } = deps;

  app.register(async (scope) => {
    // Framework refusals (a body that is not JSON, over the limit, a media type
    // with no parser) in this module's shape — never quoting the body.
    scope.setErrorHandler((error, request, reply) => sendError(request, reply, error));

    scope.get(P.overview, async (request, reply) => run(request, reply, () => service.overview()));

    scope.get<{ Params: AgentParams }>(P.snapshot, async (request, reply) =>
      run(request, reply, () => service.snapshot(agentParam(request.params)))
    );

    scope.get<{ Params: ItemParams }>(P.item, async (request, reply) =>
      run(request, reply, () => service.readItem(agentParam(request.params), idParam(request.params)))
    );

    scope.post<{ Params: AgentParams; Body: unknown }>(
      P.items,
      { bodyLimit: AGENT_PROFILE_BODY_LIMIT },
      async (request, reply) =>
        run(
          request,
          reply,
          () => {
            const agent = agentParam(request.params);
            const body = parseCreateBody(request.body);
            return "draft" in body
              ? service.create(agent, body.draft, body.onConflict)
              : service.createFromImport(agent, body.import.importId, body.import.picks, body.onConflict);
          },
          201
        )
    );

    scope.put<{ Params: ItemParams; Body: unknown }>(
      P.item,
      { bodyLimit: AGENT_PROFILE_BODY_LIMIT },
      async (request, reply) =>
        run(request, reply, () => {
          const agent = agentParam(request.params);
          const id = idParam(request.params);
          const body = objectBody(request.body);
          const revision = revisionField(body.revision, "revision");
          const draft = parseDraft(body.draft, "draft");
          return service.update(agent, id, revision, draft);
        })
    );

    scope.delete<{ Params: ItemParams; Querystring: Record<string, unknown> }>(P.item, async (request, reply) =>
      run(request, reply, () => {
        const agent = agentParam(request.params);
        const id = idParam(request.params);
        const revision = revisionField(request.query?.revision, "revision query parameter");
        return service.remove(agent, id, revision);
      })
    );

    scope.post<{ Params: ItemParams; Body: unknown }>(P.itemEnabled, async (request, reply) =>
      run(request, reply, () => {
        const agent = agentParam(request.params);
        const id = idParam(request.params);
        const body = objectBody(request.body);
        const revision = revisionField(body.revision, "revision");
        if (typeof body.enabled !== "boolean") throw invalid("enabled must be true or false.");
        return service.setEnabled(agent, id, revision, body.enabled);
      })
    );

    scope.post<{ Params: ItemParams; Body: unknown }>(P.itemTrust, async (request, reply) =>
      run(request, reply, () => {
        const agent = agentParam(request.params);
        const id = idParam(request.params);
        const body = objectBody(request.body);
        return service.trust(agent, id, revisionField(body.revision, "revision"));
      })
    );

    scope.post<{ Params: ItemParams; Body: unknown }>(P.itemCopy, async (request, reply) =>
      run(request, reply, () => {
        const agent = agentParam(request.params);
        const id = idParam(request.params);
        const body = objectBody(request.body);
        if (!isAgentProfileAgentId(body.toAgent)) {
          throw invalid(`toAgent must be one of ${AGENT_PROFILE_AGENTS.join(", ")}.`);
        }
        return service.copy(agent, id, body.toAgent, conflictPolicy(body.onConflict));
      })
    );

    scope.get<{ Params: AgentParams }>(P.instructions, async (request, reply) =>
      run(request, reply, () => service.readInstructions(agentParam(request.params)))
    );

    scope.put<{ Params: AgentParams; Body: unknown }>(
      P.instructions,
      { bodyLimit: AGENT_PROFILE_BODY_LIMIT },
      async (request, reply) =>
        run(request, reply, () => {
          const agent = agentParam(request.params);
          const body = objectBody(request.body);
          const text = stringField(body.text, "text", { allowEmpty: true, max: TEXT_MAX, multiline: true });
          // `""` is a real value here: "the file must not exist yet".
          const revision = stringField(body.revision, "revision", { allowEmpty: true, max: ID_MAX });
          return service.writeInstructions(agent, text, revision);
        })
    );

    scope.post<{ Params: AgentParams; Body: unknown }>(P.instructionsMigrateLegacy, async (request, reply) =>
      run(request, reply, () => {
        const agent = agentParam(request.params);
        const body = objectBody(request.body);
        const revision = stringField(body.revision, "revision", { allowEmpty: true, max: ID_MAX });
        return service.migrateLegacyInstructions(agent, revision);
      })
    );

    scope.post<{ Params: AgentParams; Body: unknown }>(P.importGit, async (request, reply) =>
      run(request, reply, () => {
        const agent = agentParam(request.params);
        const body = objectBody(request.body);
        // The URL may carry a token: validated for shape only and never quoted back.
        if (typeof body.url !== "string" || body.url.trim() === "") throw invalid("url is required.");
        if (body.url.length > URL_MAX) throw invalid(`url is longer than ${URL_MAX} characters.`);
        return service.scanGit(agent, body.url.trim());
      })
    );

    scope.get<{ Params: { agent: string; name: string } }>(P.marketplacePlugins, async (request, reply) =>
      run(request, reply, async () => {
        const agent = agentParam(request.params);
        const name = stringField(request.params.name, "marketplace name", { max: NAME_MAX });
        return { plugins: await service.listMarketplacePlugins(agent, name) };
      })
    );

    // The upload, in its own scope: only it accepts a raw octet-stream body.
    scope.register(async (upload) => {
      acceptRawBody(upload);
      upload.post<{ Params: AgentParams; Querystring: Record<string, unknown> }>(P.importUpload, async (request, reply) => {
        let agent: AgentProfileAgentId;
        let name: string;
        try {
          agent = agentParam(request.params);
          name = uploadName(request.query?.name);
          if (!isOctetStream(request.headers["content-type"])) {
            throw new AgentProfileError(415, "INVALID_REQUEST", "Send the file as an application/octet-stream body.");
          }
          service.assertCanScanUpload(agent);
          if (declaredLengthExceedsCap(request.headers)) throw profileErrors.uploadTooLarge(MAX_UPLOAD_BYTES);
        } catch (error) {
          return refuseUnread(request, reply, error);
        }

        let tmp: string | undefined;
        try {
          await mkdir(deps.importsDir, { recursive: true, mode: 0o700 });
          tmp = uploadTempPath(deps.importsDir);
          try {
            await receiveUpload(request.raw, tmp, 0o600);
          } catch (error) {
            // receiveUpload already removed the partial file; the body may be partly unread.
            tmp = undefined;
            return refuseUnread(
              request,
              reply,
              isUploadTooLarge(error) ? profileErrors.uploadTooLarge(MAX_UPLOAD_BYTES) : error
            );
          }
          return await service.scanUpload(agent, name, tmp);
        } catch (error) {
          return sendError(request, reply, error);
        } finally {
          if (tmp) await discardUpload(tmp);
        }
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

async function run<T>(
  request: FastifyRequest,
  reply: FastifyReply,
  handler: () => T | Promise<T>,
  status = 200
): Promise<FastifyReply> {
  try {
    const result = await handler();
    return reply.code(status).send(result);
  } catch (error) {
    return sendError(request, reply, error);
  }
}

function errorBody(code: AgentProfileErrorBody["error"]["code"], message: string): AgentProfileErrorBody {
  return { error: { code, message } };
}

/** Maps any error to `{error: {code, message}}`; the real text of an unexpected one goes to the log only. */
export function sendError(request: FastifyRequest, reply: FastifyReply, error: unknown): FastifyReply {
  if (isAgentProfileError(error)) {
    return reply.code(error.status).send(errorBody(error.code, error.message));
  }
  const frameworkCode = (error as { code?: unknown } | null)?.code;
  const statusCode = (error as { statusCode?: unknown } | null)?.statusCode;
  if (frameworkCode === "FST_ERR_CTP_BODY_TOO_LARGE" || statusCode === 413) {
    return reply
      .code(413)
      .send(errorBody("INVALID_REQUEST", `The request body is larger than ${AGENT_PROFILE_BODY_LIMIT / 1024 / 1024} MiB.`));
  }
  if (frameworkCode === "FST_ERR_CTP_INVALID_MEDIA_TYPE" || statusCode === 415) {
    return reply.code(415).send(errorBody("INVALID_REQUEST", "Send the request body as application/json."));
  }
  if (typeof statusCode === "number" && statusCode >= 400 && statusCode < 500) {
    // A body Fastify could not parse. Its message can quote the body — never echo it.
    return reply.code(400).send(errorBody("INVALID_REQUEST", "The request body is not valid JSON."));
  }
  request.log.error({ err: error }, "agent profile route failed");
  return reply
    .code(500)
    .send(errorBody("AGENT_PROFILE_ERROR", "The agent profile request failed; see the daemon log."));
}

/** A refusal while the upload body may still be unread: `Connection: close` (see `refuseUpload`). */
function refuseUnread(request: FastifyRequest, reply: FastifyReply, error: unknown): FastifyReply {
  reply.header("connection", "close");
  return sendError(request, reply, error);
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function invalid(message: string): AgentProfileError {
  return profileErrors.invalid(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function objectBody(body: unknown): Record<string, unknown> {
  if (!isRecord(body)) throw invalid("The request body must be a JSON object.");
  return body;
}

function agentParam(params: { agent: string }): AgentProfileAgentId {
  if (!isAgentProfileAgentId(params.agent)) {
    throw profileErrors.unknownAgent(params.agent.length > 40 ? `${params.agent.slice(0, 40)}…` : params.agent);
  }
  return params.agent;
}

function idParam(params: { id: string }): string {
  return stringField(params.id, "item id", { max: ID_MAX });
}

function hasControlChars(value: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u001f\u007f]/.test(value);
}

function stringField(
  value: unknown,
  field: string,
  options: { allowEmpty?: boolean; max?: number; multiline?: boolean } = {}
): string {
  if (typeof value !== "string") throw invalid(`${field} must be a string.`);
  if (!options.allowEmpty && value.trim() === "") throw invalid(`${field} is required.`);
  const max = options.max ?? NAME_MAX;
  if (value.length > max) throw invalid(`${field} is longer than ${max} characters.`);
  if (!options.multiline && hasControlChars(value)) {
    throw invalid(`${field} must not contain control characters.`);
  }
  return value;
}

function optionalString(
  value: unknown,
  field: string,
  options: { allowEmpty?: boolean; max?: number } = {}
): string | undefined {
  return value === undefined ? undefined : stringField(value, field, options);
}

/** An item revision: required and non-empty (every listed item has one). */
function revisionField(value: unknown, field: string): string {
  if (value === undefined || value === null) throw invalid(`${field} is required.`);
  return stringField(value, field, { max: ID_MAX });
}

function conflictPolicy(value: unknown): ProfileConflictPolicy {
  if (value === undefined) return "fail";
  if (typeof value === "string" && (CONFLICT_POLICIES as readonly string[]).includes(value)) {
    return value as ProfileConflictPolicy;
  }
  throw invalid(`onConflict must be one of ${CONFLICT_POLICIES.join(", ")}.`);
}

function stringList(
  value: unknown,
  field: string,
  options: { allowEmptyList?: boolean; max?: number; multiline?: boolean } = {}
): string[] {
  if (!Array.isArray(value)) throw invalid(`${field} must be an array of strings.`);
  if (!options.allowEmptyList && value.length === 0) throw invalid(`${field} must not be empty.`);
  if (value.length > LIST_MAX) throw invalid(`${field} has more than ${LIST_MAX} entries.`);
  return value.map((entry, index) =>
    stringField(entry, `${field}[${index}]`, {
      allowEmpty: options.allowEmptyList,
      max: options.max ?? URL_MAX,
      multiline: options.multiline
    })
  );
}

function uploadName(value: unknown): string {
  const name = stringField(value, "name query parameter", { max: NAME_MAX });
  if (/[\\/]/.test(name) || name === "." || name === "..") {
    throw invalid("name must be a file name, not a path.");
  }
  return name;
}

function isOctetStream(contentType: string | undefined): boolean {
  return (contentType ?? "").split(";")[0]!.trim().toLowerCase() === "application/octet-stream";
}

type CreateBody =
  | { draft: ProfileItemDraft; onConflict: ProfileConflictPolicy }
  | { import: { importId: string; picks: string[] }; onConflict: ProfileConflictPolicy };

export function parseCreateBody(raw: unknown): CreateBody {
  const body = objectBody(raw);
  const hasDraft = body.draft !== undefined;
  const hasImport = body.import !== undefined;
  if (hasDraft === hasImport) throw invalid("Send exactly one of draft or import.");
  const onConflict = conflictPolicy(body.onConflict);
  if (hasDraft) return { draft: parseDraft(body.draft, "draft"), onConflict };
  if (!isRecord(body.import)) throw invalid("import must be an object.");
  const importId = stringField(body.import.importId, "import.importId", { max: ID_MAX });
  const picks = stringList(body.import.picks, "import.picks", { max: URL_MAX });
  return { import: { importId, picks }, onConflict };
}

/** A {@link ProfileItemDraft} with only its known fields, each checked. */
export function parseDraft(raw: unknown, field: string): ProfileItemDraft {
  if (!isRecord(raw)) throw invalid(`${field} must be an object.`);
  switch (raw.kind) {
    case "mcp":
      return { kind: "mcp", mcp: parseMcpDraft(raw.mcp, `${field}.mcp`) };
    case "skill":
    case "command":
      return { kind: raw.kind, document: parseDocumentDraft(raw.document, `${field}.document`) };
    case "hook":
      return { kind: "hook", hook: parseHookDraft(raw.hook, `${field}.hook`) };
    case "plugin":
      return { kind: "plugin", plugin: parsePluginDraft(raw.plugin, `${field}.plugin`) };
    case "marketplace":
      return { kind: "marketplace", marketplace: parseMarketplaceDraft(raw.marketplace, `${field}.marketplace`) };
    default:
      throw invalid(`${field}.kind must be one of ${PROFILE_ITEM_KINDS.join(", ")}.`);
  }
}

function parseMcpDraft(raw: unknown, field: string): McpServerDraft {
  if (!isRecord(raw)) throw invalid(`${field} must be an object.`);
  const name = stringField(raw.name, `${field}.name`);
  if (typeof raw.transport !== "string" || !(MCP_TRANSPORT_VALUES as readonly string[]).includes(raw.transport)) {
    throw invalid(`${field}.transport must be one of ${MCP_TRANSPORT_VALUES.join(", ")}.`);
  }
  const transport = raw.transport as McpTransport;
  const draft: McpServerDraft = { name, transport };
  if (transport === "stdio") {
    for (const key of ["url", "headers"] as const) {
      if (raw[key] !== undefined) throw invalid(`${field}.${key} is only for http and sse servers.`);
    }
    draft.command = stringField(raw.command, `${field}.command`, { max: URL_MAX });
    if (raw.args !== undefined) draft.args = stringList(raw.args, `${field}.args`, { allowEmptyList: true, multiline: true });
    const cwd = optionalString(raw.cwd, `${field}.cwd`, { max: URL_MAX });
    if (cwd !== undefined) draft.cwd = cwd;
    if (raw.env !== undefined) draft.env = parseSecretEntries(raw.env, `${field}.env`);
  } else {
    for (const key of ["command", "args", "cwd", "env"] as const) {
      if (raw[key] !== undefined) throw invalid(`${field}.${key} is only for stdio servers.`);
    }
    draft.url = stringField(raw.url, `${field}.url`, { max: URL_MAX });
    if (raw.headers !== undefined) draft.headers = parseSecretEntries(raw.headers, `${field}.headers`);
  }
  if (raw.advanced !== undefined) {
    if (!isRecord(raw.advanced)) throw invalid(`${field}.advanced must be an object.`);
    draft.advanced = { ...raw.advanced };
  }
  return draft;
}

/**
 * `{key, value}` (set or replace) or `{key, keep: true}` (unchanged); an
 * absent key is removed (spec §8). Messages name the key and the index,
 * NEVER the value.
 */
export function parseSecretEntries(raw: unknown, field: string): SecretEntryDraft[] {
  if (!Array.isArray(raw)) throw invalid(`${field} must be an array of {key, value} or {key, keep: true}.`);
  if (raw.length > LIST_MAX) throw invalid(`${field} has more than ${LIST_MAX} entries.`);
  const seen = new Set<string>();
  return raw.map((entry, index): SecretEntryDraft => {
    const at = `${field}[${index}]`;
    if (!isRecord(entry)) throw invalid(`${at} must be {key, value} or {key, keep: true}.`);
    const key = stringField(entry.key, `${at}.key`);
    if (seen.has(key)) throw invalid(`${field} names the key "${key}" twice.`);
    seen.add(key);
    const hasValue = entry.value !== undefined;
    const keep = entry.keep;
    if (hasValue && keep !== undefined) throw invalid(`${at} must carry either value or keep, not both.`);
    if (hasValue) {
      if (typeof entry.value !== "string") throw invalid(`${at}.value must be a string.`);
      if (entry.value.length > URL_MAX * 4) throw invalid(`${at}.value is too long.`);
      return { key, value: entry.value };
    }
    if (keep !== true) throw invalid(`${at} must carry a value or keep: true.`);
    return { key, keep: true };
  });
}

function parseDocumentDraft(raw: unknown, field: string): MarkdownDocumentDraft {
  if (!isRecord(raw)) throw invalid(`${field} must be an object.`);
  const name = stringField(raw.name, `${field}.name`);
  const frontmatter = raw.frontmatter === undefined ? {} : raw.frontmatter;
  if (!isRecord(frontmatter)) throw invalid(`${field}.frontmatter must be an object.`);
  const body = stringField(raw.body, `${field}.body`, { allowEmpty: true, max: TEXT_MAX, multiline: true });
  return { name, frontmatter: { ...frontmatter }, body };
}

function parseHookDraft(raw: unknown, field: string): HookDraft {
  if (!isRecord(raw)) throw invalid(`${field} must be an object.`);
  const draft: HookDraft = {
    event: stringField(raw.event, `${field}.event`),
    command: stringField(raw.command, `${field}.command`, { max: TEXT_MAX, multiline: true })
  };
  const matcher = optionalString(raw.matcher, `${field}.matcher`, { allowEmpty: true, max: URL_MAX });
  if (matcher !== undefined) draft.matcher = matcher;
  if (raw.timeoutSec !== undefined) {
    if (typeof raw.timeoutSec !== "number" || !Number.isFinite(raw.timeoutSec) || raw.timeoutSec <= 0) {
      throw invalid(`${field}.timeoutSec must be a positive number of seconds.`);
    }
    draft.timeoutSec = raw.timeoutSec;
  }
  return draft;
}

function parsePluginDraft(raw: unknown, field: string): PluginInstallDraft {
  if (!isRecord(raw)) throw invalid(`${field} must be an object.`);
  const hasSpec = raw.spec !== undefined;
  const hasPlugin = raw.plugin !== undefined || raw.marketplace !== undefined;
  if (hasSpec === hasPlugin) throw invalid(`${field} must be {plugin, marketplace} or {spec}.`);
  if (hasSpec) return { spec: stringField(raw.spec, `${field}.spec`, { max: URL_MAX }) };
  return {
    plugin: stringField(raw.plugin, `${field}.plugin`),
    marketplace: stringField(raw.marketplace, `${field}.marketplace`)
  };
}

function parseMarketplaceDraft(raw: unknown, field: string): MarketplaceDraft {
  if (!isRecord(raw)) throw invalid(`${field} must be an object.`);
  const draft: MarketplaceDraft = { source: parseMarketplaceSource(raw.source, `${field}.source`) };
  const name = optionalString(raw.name, `${field}.name`);
  if (name !== undefined) draft.name = name;
  return draft;
}

function parseMarketplaceSource(raw: unknown, field: string): MarketplaceSource {
  if (!isRecord(raw)) throw invalid(`${field} must be an object.`);
  const ref = optionalString(raw.ref, `${field}.ref`);
  const withRef = <T extends object>(source: T): T => (ref !== undefined ? { ...source, ref } : source);
  switch (raw.type) {
    case "github": {
      const repo = stringField(raw.repo, `${field}.repo`);
      if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw invalid(`${field}.repo must be owner/repo.`);
      return withRef({ type: "github" as const, repo });
    }
    case "git":
      // May carry a token: never quoted back.
      return withRef({ type: "git" as const, url: stringField(raw.url, `${field}.url`, { max: URL_MAX }) });
    case "path":
      if (ref !== undefined) throw invalid(`${field}.ref is only for github and git sources.`);
      return { type: "path", path: stringField(raw.path, `${field}.path`, { max: URL_MAX }) };
    default:
      throw invalid(`${field}.type must be one of github, git, path.`);
  }
}
