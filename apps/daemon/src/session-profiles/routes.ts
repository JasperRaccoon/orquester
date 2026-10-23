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
 *
 * The two uploads (`…/imports/upload?name=` — a `.zip` or `.md` to scan — and `import?name=` — a
 * profile export) take the file as a raw `application/octet-stream` body (never base64 in JSON)
 * in their own encapsulated scope, exactly like Agent config's upload: every refusal decidable
 * before the body is read is answered with `Connection: close` before a byte is read; the body
 * streams to a temp file under `importsDir`, capped at `MAX_UPLOAD_BYTES`, deleted as soon as the
 * service returns. `…/export` answers the `.zip` bytes as an attachment.
 */

import { mkdir } from "node:fs/promises";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  MAX_UPLOAD_BYTES,
  SESSION_PROFILE_AGENTS,
  SESSION_PROFILE_ITEM_KINDS,
  SESSION_PROFILE_KNOWLEDGE_COLLECTION_ID_PATTERN,
  SESSION_PROFILE_KNOWLEDGE_COLLECTIONS_MAX,
  isSessionProfileAgentId,
  sessionProfileRoutes,
  sessionProfileScopeProblem,
  type AddSessionProfilePluginRequest,
  type CopySessionProfileItemsRequest,
  type CreateSessionProfileRequest,
  type ImportSessionProfileFromGlobalRequest,
  type SessionProfileAgentId,
  type SessionProfileImportConflictPolicy,
  type SessionProfileInstructionsMode,
  type TakeSessionProfileImportRequest,
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
import { AgentProfileError, profileErrors } from "../agent-profile/errors.ts";
import {
  acceptRawBody,
  declaredLengthExceedsCap,
  discardUpload,
  isUploadTooLarge,
  receiveUpload,
  uploadTempPath
} from "../upload-stream.ts";
import { SessionProfileError, sessionProfileErrors } from "./errors.ts";
import type { SessionProfileService } from "./service.ts";
import type { WorkflowReferenceIndex } from "../workflows/reference-index.ts";

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
    | "globalSource"
    | "importFromGlobal"
    | "scanGit"
    | "scanUpload"
    | "assertCanScanUpload"
    | "takeScan"
    | "copyFrom"
    | "addPlugin"
    | "exportProfile"
    | "importProfile"
    | "assertCanImportProfile"
  >;
  /** Where an upload is streamed before the service reads it (`agentProfileImportsDir(appdir)`). */
  importsDir: string;
  /**
   * The workflow store's reference index, read per delete: a delete's `expectWorkflowUses` (the
   * delete guard, spec §5.5) is checked against its `profileUses` in the delete's own step. Absent
   * or null: no index — a delete that names the precondition is refused (never read as "no uses").
   */
  workflowReferences?: () => Pick<WorkflowReferenceIndex, "profileUses"> | null | undefined;
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
  prepareStatus: pattern(sessionProfileRoutes.prepareStatus("PID")),
  importGlobal: pattern(sessionProfileRoutes.importGlobal("PID")),
  importGit: pattern(sessionProfileRoutes.importGit("PID")),
  importUpload: pattern(sessionProfileRoutes.importUpload("PID")),
  importScan: pattern(sessionProfileRoutes.importScan("PID", "IMPORT")),
  copyFrom: pattern(sessionProfileRoutes.copyFrom("PID")),
  plugins: pattern(sessionProfileRoutes.plugins("PID")),
  exportProfile: pattern(sessionProfileRoutes.exportProfile("PID")),
  importProfile: sessionProfileRoutes.importProfile
};

/**
 * The delete guard's precondition (spec §5.5; the saved-prompt `expectWorkflowUses` pattern):
 * `?expectWorkflowUses=a,b` (empty: none) — the workflows the caller showed as using the profile.
 * Re-read from the reference index when the delete runs; unknown uses, or no index, refuse.
 */
function workflowUsesPrecondition(
  profileId: string,
  value: unknown,
  references: SessionProfileRouteDeps["workflowReferences"]
): (() => void) | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > LIST_MAX * (ID_MAX + 1)) {
    throw sessionProfileErrors.invalid("expectWorkflowUses must be a comma-separated list of workflow ids.");
  }
  const wanted = usesKey(value.split(",").filter((id) => id !== ""));
  return () => {
    const index = references?.();
    if (!index) throw sessionProfileErrors.workflowUsesChanged("Orquester cannot check which workflows use this profile (no workflow index); nothing was deleted.");
    const now = index.profileUses(profileId);
    if (now.unknownReason) {
      throw sessionProfileErrors.workflowUsesChanged(`Orquester cannot tell which workflows use this profile (${now.unknownReason}); nothing was deleted.`);
    }
    if (usesKey(now.workflows.map((use) => use.workflowId)) !== wanted) {
      const names = now.workflows.map((use) => `"${use.name}"`).join(", ");
      throw sessionProfileErrors.workflowUsesChanged(
        `The workflows that use this profile changed${names ? ` (now: ${names})` : " (now: none)"}; nothing was deleted. Review them and delete again.`
      );
    }
  };
}

function usesKey(ids: readonly string[]): string {
  return [...new Set(ids)].sort().join(",");
}

function pattern(path: string): string {
  return path.replace("/PID", "/:profileId").replace("/IID", "/:itemId").replace("/imports/IMPORT", "/imports/:importId");
}

const CONFLICT_POLICIES: readonly SessionProfileImportConflictPolicy[] = ["fail", "replace", "keep-both", "skip"];

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
      run(request, reply, () => {
        const profileId = profileParam(request.params);
        const revision = revisionField(request.query?.revision, "revision query parameter");
        const precondition = workflowUsesPrecondition(profileId, request.query?.expectWorkflowUses, deps.workflowReferences);
        return service.remove(profileId, revision, precondition ? { precondition } : {});
      })
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

    // --- Filling a profile (spec §4.5) ------------------------------------------------------

    scope.get<{ Params: ProfileParams; Querystring: Record<string, unknown> }>(P.importGlobal, async (request, reply) =>
      run(request, reply, () => service.globalSource(profileParam(request.params), agentField(request.query?.agent, "agent query parameter")))
    );

    scope.post<{ Params: ProfileParams; Body: unknown }>(P.importGlobal, async (request, reply) =>
      run(request, reply, () => service.importFromGlobal(profileParam(request.params), parseGlobalImport(request.body)))
    );

    scope.post<{ Params: ProfileParams; Body: unknown }>(P.importGit, async (request, reply) =>
      run(request, reply, () => {
        const body = objectBody(request.body);
        return service.scanGit(profileParam(request.params), stringField(body.url, "url", { max: URL_MAX }));
      })
    );

    scope.post<{ Params: ProfileParams & { importId: string }; Body: unknown }>(P.importScan, async (request, reply) =>
      run(request, reply, () =>
        service.takeScan(
          profileParam(request.params),
          stringField(request.params.importId, "import id", { max: ID_MAX }),
          parseTakeScan(request.body)
        )
      )
    );

    scope.post<{ Params: ProfileParams; Body: unknown }>(P.copyFrom, async (request, reply) =>
      run(request, reply, () => service.copyFrom(profileParam(request.params), parseCopyFrom(request.body)))
    );

    scope.post<{ Params: ProfileParams; Body: unknown }>(P.plugins, async (request, reply) =>
      run(request, reply, () => service.addPlugin(profileParam(request.params), parseAddPlugin(request.body)))
    );

    scope.get<{ Params: ProfileParams }>(P.exportProfile, async (request, reply) => {
      try {
        const { fileName, data } = await service.exportProfile(profileParam(request.params));
        return reply
          .code(200)
          .header("content-type", "application/zip")
          .header("content-disposition", `attachment; filename="${fileName}"`)
          .header("cache-control", "no-store")
          .send(data);
      } catch (error) {
        return sendError(request, reply, error);
      }
    });

    // The uploads, in their own scope: only they accept a raw octet-stream body.
    scope.register(async (upload) => {
      acceptRawBody(upload);

      upload.post<{ Params: ProfileParams; Querystring: Record<string, unknown> }>(P.importUpload, async (request, reply) => {
        let profileId: string;
        let name: string;
        try {
          profileId = profileParam(request.params);
          name = uploadName(request.query?.name);
          assertOctetStream(request.headers["content-type"]);
          await service.assertCanScanUpload(profileId);
          if (declaredLengthExceedsCap(request.headers)) throw tooLarge();
        } catch (error) {
          return refuseUnread(request, reply, error);
        }
        return receiveThen(request, reply, deps.importsDir, (path) => service.scanUpload(profileId, name, path), 200);
      });

      upload.post<{ Querystring: Record<string, unknown> }>(P.importProfile, async (request, reply) => {
        let name: string;
        try {
          name = uploadName(request.query?.name);
          assertOctetStream(request.headers["content-type"]);
          service.assertCanImportProfile();
          if (declaredLengthExceedsCap(request.headers)) throw tooLarge();
        } catch (error) {
          return refuseUnread(request, reply, error);
        }
        return receiveThen(request, reply, deps.importsDir, (path) => service.importProfile(name, path), 201);
      });
    });
  });
}

/** Streams the body to a temp file, hands it to `handle`, and deletes it — BEFORE answering, whatever happens. */
async function receiveThen<T>(
  request: FastifyRequest,
  reply: FastifyReply,
  dir: string,
  handle: (path: string) => Promise<T>,
  status: number
): Promise<FastifyReply> {
  let tmp: string | undefined;
  let result: T;
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    tmp = uploadTempPath(dir);
    try {
      await receiveUpload(request.raw, tmp, 0o600);
    } catch (error) {
      // receiveUpload already removed the partial file; the body may be partly unread.
      tmp = undefined;
      return refuseUnread(request, reply, isUploadTooLarge(error) ? tooLarge() : error);
    }
    result = await handle(tmp);
  } catch (error) {
    if (tmp) await discardUpload(tmp);
    return sendError(request, reply, error);
  }
  await discardUpload(tmp);
  return reply.code(status).send(result);
}

function tooLarge(): SessionProfileError {
  return new SessionProfileError(413, "UPLOAD_TOO_LARGE", `The file is larger than ${Math.floor(MAX_UPLOAD_BYTES / 1024 / 1024)} MB.`);
}

function refuseUnread(request: FastifyRequest, reply: FastifyReply, error: unknown): FastifyReply {
  reply.header("connection", "close");
  return sendError(request, reply, error);
}

function assertOctetStream(contentType: string | undefined): void {
  if ((contentType ?? "").split(";")[0]!.trim().toLowerCase() !== "application/octet-stream") {
    throw new SessionProfileError(415, "INVALID_REQUEST", "Send the file as an application/octet-stream body.");
  }
}

function uploadName(value: unknown): string {
  const name = stringField(value, "name query parameter", { max: NAME_MAX });
  if (/[\\/]/.test(name) || name === "." || name === "..") throw invalid("name must be a file name, not a path.");
  return name;
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
  if (raw.knowledgeCollections !== undefined) {
    const ids = raw.knowledgeCollections;
    if (!Array.isArray(ids) || ids.length > SESSION_PROFILE_KNOWLEDGE_COLLECTIONS_MAX) {
      throw invalid(`${field}.knowledgeCollections must be an array of at most ${SESSION_PROFILE_KNOWLEDGE_COLLECTIONS_MAX} collection ids.`);
    }
    for (const [index, id] of ids.entries()) {
      if (typeof id !== "string" || !SESSION_PROFILE_KNOWLEDGE_COLLECTION_ID_PATTERN.test(id)) throw invalid(`${field}.knowledgeCollections[${index}] is not a collection id.`);
    }
    settings.knowledgeCollections = ids as string[];
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

function agentField(value: unknown, field: string): SessionProfileAgentId {
  if (!isSessionProfileAgentId(value)) throw invalid(`${field} must be one of ${SESSION_PROFILE_AGENTS.join(", ")}.`);
  return value;
}

function conflictField(value: unknown, field: string): SessionProfileImportConflictPolicy | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !(CONFLICT_POLICIES as readonly string[]).includes(value)) {
    throw invalid(`${field} must be one of ${CONFLICT_POLICIES.join(", ")}.`);
  }
  return value as SessionProfileImportConflictPolicy;
}

function instructionsField(value: unknown, field: string): SessionProfileInstructionsMode | undefined {
  if (value === undefined) return undefined;
  if (value !== "replace" && value !== "append") throw invalid(`${field} must be "replace" or "append".`);
  return value;
}

/** A target scope for skills, commands and MCP servers (any non-empty agent list, or "all"). */
function importScopeField(value: unknown, field: string): SessionProfileAgentScope | undefined {
  if (value === undefined) return undefined;
  const scope = parseScope(value, field);
  const problem = sessionProfileScopeProblem("skill", scope);
  if (problem !== null) throw invalid(`${field}: ${problem}`);
  return scope;
}

function idList(value: unknown, field: string, allowEmpty: boolean): string[] {
  return stringList(value, field, { allowEmptyList: allowEmpty }).map((entry, index) => {
    if (entry === "" || entry.length > NAME_MAX * 4) throw invalid(`${field}[${index}] is not an id.`);
    return entry;
  });
}

function parseGlobalImport(raw: unknown): ImportSessionProfileFromGlobalRequest {
  const body = objectBody(raw);
  const instructions = instructionsField(body.instructions, "instructions");
  const request: ImportSessionProfileFromGlobalRequest = {
    revision: revisionField(body.revision, "revision"),
    agent: agentField(body.agent, "agent"),
    itemIds: idList(body.itemIds ?? [], "itemIds", instructions !== undefined)
  };
  const agents = importScopeField(body.agents, "agents");
  if (agents !== undefined) request.agents = agents;
  if (instructions !== undefined) request.instructions = instructions;
  const onConflict = conflictField(body.onConflict, "onConflict");
  if (onConflict !== undefined) request.onConflict = onConflict;
  return request;
}

function parseTakeScan(raw: unknown): TakeSessionProfileImportRequest {
  const body = objectBody(raw);
  const request: TakeSessionProfileImportRequest = {
    revision: revisionField(body.revision, "revision"),
    picks: stringList(body.picks, "picks", { allowEmptyList: false })
  };
  const agents = importScopeField(body.agents, "agents");
  if (agents !== undefined) request.agents = agents;
  const onConflict = conflictField(body.onConflict, "onConflict");
  if (onConflict !== undefined) request.onConflict = onConflict;
  return request;
}

function parseCopyFrom(raw: unknown): CopySessionProfileItemsRequest {
  const body = objectBody(raw);
  const instructions = instructionsField(body.instructions, "instructions");
  const request: CopySessionProfileItemsRequest = {
    revision: revisionField(body.revision, "revision"),
    fromProfileId: stringField(body.fromProfileId, "fromProfileId", { max: ID_MAX }),
    itemIds: idList(body.itemIds ?? [], "itemIds", instructions !== undefined)
  };
  if (instructions !== undefined) request.instructions = instructions;
  const onConflict = conflictField(body.onConflict, "onConflict");
  if (onConflict !== undefined) request.onConflict = onConflict;
  return request;
}

function parseAddPlugin(raw: unknown): AddSessionProfilePluginRequest {
  const body = objectBody(raw);
  if (!isRecord(body.source)) throw invalid("source must be an object.");
  const source: AddSessionProfilePluginRequest["source"] =
    body.source.type === "marketplace"
      ? {
          type: "marketplace",
          marketplace: stringField(body.source.marketplace, "source.marketplace"),
          plugin: stringField(body.source.plugin, "source.plugin")
        }
      : body.source.type === "global"
        ? { type: "global", itemId: stringField(body.source.itemId, "source.itemId", { max: NAME_MAX * 4 }) }
        : (() => {
            throw invalid('source.type must be "marketplace" or "global".');
          })();
  const request: AddSessionProfilePluginRequest = {
    revision: revisionField(body.revision, "revision"),
    agent: agentField(body.agent, "agent"),
    source
  };
  const onConflict = conflictField(body.onConflict, "onConflict");
  if (onConflict === "keep-both") throw invalid("A plugin cannot be kept twice: use fail, replace or skip.");
  if (onConflict !== undefined) request.onConflict = onConflict;
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
  // boxes: "Run in box" (absent: unchanged on update, off on create).
  if (raw.runInBox !== undefined) {
    if (typeof raw.runInBox !== "boolean") throw invalid(`${field}.runInBox must be true or false.`);
    draft.runInBox = raw.runInBox;
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
