/**
 * Agent Profiles — the REST surface, every path in `sessionProfileRoutes` (`@orquester/api`).
 * Registered on BOTH transports by `createServer`: the unix socket, and the HTTP app whose
 * bearer hook gates every `/api/*` path. Nothing here is socket-only.
 *
 * Every request is parsed by hand into its exact wire shape before the service sees it: a
 * malformed one is 400 `INVALID_REQUEST` naming the field. Every refusal is
 * `{error: {code, message}}`; an unexpected error is logged and answered 500
 * `SESSION_PROFILE_ERROR` with a generic message. No message quotes a secret value, and a body
 * Fastify cannot parse is refused without quoting it.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  SESSION_PROFILE_AGENTS,
  SESSION_PROFILE_ITEM_KINDS,
  isSessionProfileAgentId,
  sessionProfileRoutes,
  type CreateSessionProfileRequest,
  type HookDraft,
  type MarkdownDocumentDraft,
  type McpServerDraft,
  type McpTransport,
  type SecretEntryDraft,
  type SessionProfileAgentScope,
  type SessionProfileErrorBody,
  type SessionProfileItemDraft,
  type SessionProfilePluginDraft,
  type SessionProfileSettingsDraft,
  type UpdateSessionProfileRequest
} from "@orquester/api";
import { AgentProfileError } from "../agent-profile/errors.ts";
import { SessionProfileError, sessionProfileErrors } from "./errors.ts";
import type { SessionProfileService } from "./service.ts";

export interface SessionProfileRouteDeps {
  service: Pick<
    SessionProfileService,
    | "list"
    | "get"
    | "create"
    | "update"
    | "remove"
    | "duplicate"
    | "readItem"
    | "createItem"
    | "updateItem"
    | "setItemEnabled"
    | "deleteItem"
    | "readInstructions"
    | "writeInstructions"
    | "prepareStatus"
  >;
}

/** A JSON body carrying a skill, a command or the instructions: room for large markdown. */
const BODY_LIMIT = 4 * 1024 * 1024;
const TEXT_MAX = BODY_LIMIT;
const NAME_MAX = 256;
const ID_MAX = 128;
const URL_MAX = 4096;
const LIST_MAX = 500;
const MCP_TRANSPORT_VALUES: readonly McpTransport[] = ["stdio", "http", "sse"];

// Fastify route patterns, derived from the shared builders so they cannot drift.
const P = {
  list: sessionProfileRoutes.list,
  profile: pattern(sessionProfileRoutes.profile("PID")),
  duplicate: pattern(sessionProfileRoutes.duplicate("PID")),
  items: pattern(sessionProfileRoutes.items("PID")),
  item: pattern(sessionProfileRoutes.item("PID", "IID")),
  itemEnabled: pattern(sessionProfileRoutes.itemEnabled("PID", "IID")),
  instructions: pattern(sessionProfileRoutes.instructions("PID")),
  prepareStatus: pattern(sessionProfileRoutes.prepareStatus("PID"))
};

function pattern(path: string): string {
  return path.replace("/PID", "/:profileId").replace("/IID", "/:itemId");
}

type ProfileParams = { profileId: string };
type ItemParams = { profileId: string; itemId: string };

export function registerSessionProfileRoutes(app: FastifyInstance, deps: SessionProfileRouteDeps): void {
  const { service } = deps;

  app.register(async (scope) => {
    scope.setErrorHandler((error, request, reply) => sendError(request, reply, error));

    scope.get(P.list, async (request, reply) => run(request, reply, () => service.list()));

    scope.post<{ Body: unknown }>(P.list, async (request, reply) =>
      run(request, reply, () => service.create(parseCreateProfile(request.body)), 201)
    );

    scope.get<{ Params: ProfileParams }>(P.profile, async (request, reply) =>
      run(request, reply, () => service.get(profileParam(request.params)))
    );

    scope.put<{ Params: ProfileParams; Body: unknown }>(P.profile, async (request, reply) =>
      run(request, reply, () => service.update(profileParam(request.params), parseUpdateProfile(request.body)))
    );

    scope.delete<{ Params: ProfileParams; Querystring: Record<string, unknown> }>(P.profile, async (request, reply) =>
      run(request, reply, () =>
        service.remove(profileParam(request.params), revisionField(request.query?.revision, "revision query parameter"))
      )
    );

    scope.post<{ Params: ProfileParams; Body: unknown }>(P.duplicate, async (request, reply) =>
      run(
        request,
        reply,
        () => {
          const body = request.body === undefined || request.body === null ? {} : objectBody(request.body);
          return service.duplicate(profileParam(request.params), optionalString(body.name, "name", { max: NAME_MAX }));
        },
        201
      )
    );

    scope.post<{ Params: ProfileParams; Body: unknown }>(P.items, { bodyLimit: BODY_LIMIT }, async (request, reply) =>
      run(
        request,
        reply,
        () => {
          const profileId = profileParam(request.params);
          const body = objectBody(request.body);
          const revision = revisionField(body.revision, "revision");
          const draft = parseDraft(body.draft, "draft");
          if (draft.kind === "plugin") {
            throw sessionProfileErrors.kindNotSupported("Plugins are added from an agent's marketplace, not created by hand.");
          }
          return service.createItem(profileId, revision, draft);
        },
        201
      )
    );

    scope.get<{ Params: ItemParams }>(P.item, async (request, reply) =>
      run(request, reply, () => service.readItem(profileParam(request.params), itemParam(request.params)))
    );

    scope.put<{ Params: ItemParams; Body: unknown }>(P.item, { bodyLimit: BODY_LIMIT }, async (request, reply) =>
      run(request, reply, () => {
        const body = objectBody(request.body);
        return service.updateItem(
          profileParam(request.params),
          itemParam(request.params),
          revisionField(body.revision, "revision"),
          parseDraft(body.draft, "draft")
        );
      })
    );

    scope.delete<{ Params: ItemParams; Querystring: Record<string, unknown> }>(P.item, async (request, reply) =>
      run(request, reply, () =>
        service.deleteItem(
          profileParam(request.params),
          itemParam(request.params),
          revisionField(request.query?.revision, "revision query parameter")
        )
      )
    );

    scope.post<{ Params: ItemParams; Body: unknown }>(P.itemEnabled, async (request, reply) =>
      run(request, reply, () => {
        const body = objectBody(request.body);
        const revision = revisionField(body.revision, "revision");
        if (typeof body.enabled !== "boolean") throw invalid("enabled must be true or false.");
        return service.setItemEnabled(profileParam(request.params), itemParam(request.params), revision, body.enabled);
      })
    );

    scope.get<{ Params: ProfileParams }>(P.instructions, async (request, reply) =>
      run(request, reply, () => service.readInstructions(profileParam(request.params)))
    );

    scope.put<{ Params: ProfileParams; Body: unknown }>(P.instructions, { bodyLimit: BODY_LIMIT }, async (request, reply) =>
      run(request, reply, () => {
        const body = objectBody(request.body);
        const revision = revisionField(body.revision, "revision");
        const text = stringField(body.text, "text", { allowEmpty: true, max: TEXT_MAX, multiline: true });
        return service.writeInstructions(profileParam(request.params), revision, text);
      })
    );

    scope.get<{ Params: ProfileParams }>(P.prepareStatus, async (request, reply) =>
      run(request, reply, () => service.prepareStatus(profileParam(request.params)))
    );
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
    return reply.code(status).send(await handler());
  } catch (error) {
    return sendError(request, reply, error);
  }
}

function errorBody(code: string, message: string): SessionProfileErrorBody {
  return { error: { code: code as SessionProfileErrorBody["error"]["code"], message } };
}

/** Any error → `{error: {code, message}}`; an unexpected one's text goes to the log only. */
function sendError(request: FastifyRequest, reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof SessionProfileError || error instanceof AgentProfileError) {
    return reply.code(error.status).send(errorBody(error.code, error.message));
  }
  const frameworkCode = (error as { code?: unknown } | null)?.code;
  const statusCode = (error as { statusCode?: unknown } | null)?.statusCode;
  if (frameworkCode === "FST_ERR_CTP_BODY_TOO_LARGE" || statusCode === 413) {
    return reply.code(413).send(errorBody("INVALID_REQUEST", `The request body is larger than ${BODY_LIMIT / 1024 / 1024} MiB.`));
  }
  if (frameworkCode === "FST_ERR_CTP_INVALID_MEDIA_TYPE" || statusCode === 415) {
    return reply.code(415).send(errorBody("INVALID_REQUEST", "Send the request body as application/json."));
  }
  if (typeof statusCode === "number" && statusCode >= 400 && statusCode < 500) {
    // A body Fastify could not parse. Its message can quote the body — never echo it.
    return reply.code(400).send(errorBody("INVALID_REQUEST", "The request body is not valid JSON."));
  }
  request.log.error({ err: error }, "session profile route failed");
  return reply.code(500).send(errorBody("SESSION_PROFILE_ERROR", "The Agent Profiles request failed; see the daemon log."));
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const invalid = sessionProfileErrors.invalid;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function objectBody(body: unknown): Record<string, unknown> {
  if (!isRecord(body)) throw invalid("The request body must be a JSON object.");
  return body;
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
  if (!options.multiline && hasControlChars(value)) throw invalid(`${field} must not contain control characters.`);
  return value;
}

function optionalString(
  value: unknown,
  field: string,
  options: { allowEmpty?: boolean; max?: number; multiline?: boolean } = {}
): string | undefined {
  return value === undefined ? undefined : stringField(value, field, options);
}

function profileParam(params: { profileId: string }): string {
  return stringField(params.profileId, "profile id", { max: ID_MAX });
}

function itemParam(params: { itemId: string }): string {
  return stringField(params.itemId, "item id", { max: ID_MAX });
}

function revisionField(value: unknown, field: string): string {
  if (value === undefined || value === null) throw invalid(`${field} is required.`);
  return stringField(value, field, { max: ID_MAX });
}

function stringList(value: unknown, field: string, options: { allowEmptyList?: boolean; multiline?: boolean } = {}): string[] {
  if (!Array.isArray(value)) throw invalid(`${field} must be an array of strings.`);
  if (!options.allowEmptyList && value.length === 0) throw invalid(`${field} must not be empty.`);
  if (value.length > LIST_MAX) throw invalid(`${field} has more than ${LIST_MAX} entries.`);
  return value.map((entry, index) =>
    stringField(entry, `${field}[${index}]`, { allowEmpty: true, max: URL_MAX, multiline: options.multiline })
  );
}

function parseSettings(raw: unknown, field: string): SessionProfileSettingsDraft {
  if (!isRecord(raw)) throw invalid(`${field} must be an object.`);
  const settings: SessionProfileSettingsDraft = {};
  if (raw.hideBuiltinSkills !== undefined) {
    if (!isRecord(raw.hideBuiltinSkills)) throw invalid(`${field}.hideBuiltinSkills must be an object of agent → true/false.`);
    const hide: Partial<Record<(typeof SESSION_PROFILE_AGENTS)[number], boolean>> = {};
    for (const [agent, value] of Object.entries(raw.hideBuiltinSkills)) {
      if (!isSessionProfileAgentId(agent)) throw invalid(`${field}.hideBuiltinSkills: agents are ${SESSION_PROFILE_AGENTS.join(", ")}.`);
      if (typeof value !== "boolean") throw invalid(`${field}.hideBuiltinSkills.${agent} must be true or false.`);
      hide[agent] = value;
    }
    settings.hideBuiltinSkills = hide;
  }
  if (raw.claudeWorkflowTool !== undefined) {
    if (typeof raw.claudeWorkflowTool !== "boolean") throw invalid(`${field}.claudeWorkflowTool must be true or false.`);
    settings.claudeWorkflowTool = raw.claudeWorkflowTool;
  }
  return settings;
}

function parseCreateProfile(raw: unknown): CreateSessionProfileRequest {
  const body = objectBody(raw);
  const request: CreateSessionProfileRequest = { name: stringField(body.name, "name", { max: NAME_MAX }) };
  const icon = optionalString(body.icon, "icon", { allowEmpty: true, max: NAME_MAX });
  if (icon !== undefined) request.icon = icon;
  const description = optionalString(body.description, "description", { allowEmpty: true, max: TEXT_MAX, multiline: true });
  if (description !== undefined) request.description = description;
  if (body.settings !== undefined) request.settings = parseSettings(body.settings, "settings");
  return request;
}

function parseUpdateProfile(raw: unknown): UpdateSessionProfileRequest {
  const body = objectBody(raw);
  const request: UpdateSessionProfileRequest = { revision: revisionField(body.revision, "revision") };
  const name = optionalString(body.name, "name", { max: NAME_MAX });
  if (name !== undefined) request.name = name;
  if (body.icon === null) request.icon = null;
  else {
    const icon = optionalString(body.icon, "icon", { allowEmpty: true, max: NAME_MAX });
    if (icon !== undefined) request.icon = icon;
  }
  const description = optionalString(body.description, "description", { allowEmpty: true, max: TEXT_MAX, multiline: true });
  if (description !== undefined) request.description = description;
  if (body.settings !== undefined) request.settings = parseSettings(body.settings, "settings");
  return request;
}

function parseScope(raw: unknown, field: string): SessionProfileAgentScope {
  if (raw === "all") return "all";
  if (!Array.isArray(raw) || raw.length === 0 || !raw.every(isSessionProfileAgentId)) {
    throw invalid(`${field} must be "all" or a non-empty list of ${SESSION_PROFILE_AGENTS.join(", ")}.`);
  }
  return [...raw];
}

/** A {@link SessionProfileItemDraft} with only its known fields, each checked. */
function parseDraft(raw: unknown, field: string): SessionProfileItemDraft {
  if (!isRecord(raw)) throw invalid(`${field} must be an object.`);
  const common: { agents?: SessionProfileAgentScope; enabled?: boolean } = {};
  if (raw.agents !== undefined) common.agents = parseScope(raw.agents, `${field}.agents`);
  if (raw.enabled !== undefined) {
    if (typeof raw.enabled !== "boolean") throw invalid(`${field}.enabled must be true or false.`);
    common.enabled = raw.enabled;
  }
  switch (raw.kind) {
    case "skill":
    case "command":
      return { ...common, kind: raw.kind, document: parseDocument(raw.document, `${field}.document`) };
    case "mcp":
      return { ...common, kind: "mcp", mcp: parseMcp(raw.mcp, `${field}.mcp`) };
    case "hook": {
      const name = optionalString(raw.name, `${field}.name`, { allowEmpty: true, max: NAME_MAX });
      return { ...common, kind: "hook", ...(name !== undefined ? { name } : {}), hook: parseHook(raw.hook, `${field}.hook`) };
    }
    case "plugin":
      return { ...common, kind: "plugin", plugin: parsePlugin(raw.plugin, `${field}.plugin`) };
    default:
      throw invalid(`${field}.kind must be one of ${SESSION_PROFILE_ITEM_KINDS.join(", ")}.`);
  }
}

function parseDocument(raw: unknown, field: string): MarkdownDocumentDraft {
  if (!isRecord(raw)) throw invalid(`${field} must be an object.`);
  const frontmatter = raw.frontmatter === undefined ? {} : raw.frontmatter;
  if (!isRecord(frontmatter)) throw invalid(`${field}.frontmatter must be an object.`);
  return {
    name: stringField(raw.name, `${field}.name`),
    frontmatter: { ...frontmatter },
    body: stringField(raw.body, `${field}.body`, { allowEmpty: true, max: TEXT_MAX, multiline: true })
  };
}

function parseMcp(raw: unknown, field: string): McpServerDraft {
  if (!isRecord(raw)) throw invalid(`${field} must be an object.`);
  const name = stringField(raw.name, `${field}.name`);
  if (typeof raw.transport !== "string" || !(MCP_TRANSPORT_VALUES as readonly string[]).includes(raw.transport)) {
    throw invalid(`${field}.transport must be one of ${MCP_TRANSPORT_VALUES.join(", ")}.`);
  }
  const draft: McpServerDraft = { name, transport: raw.transport as McpTransport };
  const command = optionalString(raw.command, `${field}.command`, { max: URL_MAX });
  if (command !== undefined) draft.command = command;
  if (raw.args !== undefined) draft.args = stringList(raw.args, `${field}.args`, { allowEmptyList: true, multiline: true });
  const cwd = optionalString(raw.cwd, `${field}.cwd`, { max: URL_MAX });
  if (cwd !== undefined) draft.cwd = cwd;
  if (raw.env !== undefined) draft.env = parseSecretEntries(raw.env, `${field}.env`);
  const url = optionalString(raw.url, `${field}.url`, { max: URL_MAX });
  if (url !== undefined) draft.url = url;
  if (raw.headers !== undefined) draft.headers = parseSecretEntries(raw.headers, `${field}.headers`);
  if (raw.advanced !== undefined) {
    if (!isRecord(raw.advanced)) throw invalid(`${field}.advanced must be an object.`);
    draft.advanced = { ...raw.advanced };
  }
  return draft;
}

/** `{key, value}` (set or replace) or `{key, keep: true}`; an absent key is removed. Messages name the key, NEVER the value. */
function parseSecretEntries(raw: unknown, field: string): SecretEntryDraft[] {
  if (!Array.isArray(raw)) throw invalid(`${field} must be an array of {key, value} or {key, keep: true}.`);
  if (raw.length > LIST_MAX) throw invalid(`${field} has more than ${LIST_MAX} entries.`);
  return raw.map((entry, index): SecretEntryDraft => {
    const at = `${field}[${index}]`;
    if (!isRecord(entry)) throw invalid(`${at} must be {key, value} or {key, keep: true}.`);
    const key = stringField(entry.key, `${at}.key`);
    if (entry.value !== undefined && entry.keep !== undefined) throw invalid(`${at} must carry either value or keep, not both.`);
    if (entry.value !== undefined) {
      if (typeof entry.value !== "string") throw invalid(`${at}.value must be a string.`);
      if (entry.value.length > URL_MAX * 4) throw invalid(`${at}.value is too long.`);
      return { key, value: entry.value };
    }
    if (entry.keep !== true) throw invalid(`${at} must carry a value or keep: true.`);
    return { key, keep: true };
  });
}

function parseHook(raw: unknown, field: string): HookDraft {
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

function parsePlugin(raw: unknown, field: string): SessionProfilePluginDraft {
  if (!isRecord(raw)) throw invalid(`${field} must be an object.`);
  const draft: SessionProfilePluginDraft = { name: stringField(raw.name, `${field}.name`) };
  const marketplace = optionalString(raw.marketplace, `${field}.marketplace`);
  if (marketplace !== undefined) draft.marketplace = marketplace;
  const version = optionalString(raw.version, `${field}.version`);
  if (version !== undefined) draft.version = version;
  const description = optionalString(raw.description, `${field}.description`, { max: TEXT_MAX, multiline: true });
  if (description !== undefined) draft.description = description;
  return draft;
}
