/**
 * The agent profile's one error type (spec §4.5): every refusal a route can
 * answer, with its HTTP status and wire code. Routes send it as
 * `{error: {code, message}}`; anything else is a 500 `AGENT_PROFILE_ERROR`.
 */

import type { AgentProfileErrorCode } from "@orquester/api";

export class AgentProfileError extends Error {
  constructor(
    readonly status: number,
    readonly code: AgentProfileErrorCode,
    message: string
  ) {
    super(message);
    this.name = "AgentProfileError";
  }
}

export const profileErrors = {
  invalid: (message: string) => new AgentProfileError(400, "INVALID_REQUEST", message),
  invalidName: (message: string) => new AgentProfileError(400, "INVALID_NAME", message),
  invalidItem: (message: string) => new AgentProfileError(400, "INVALID_ITEM", message),
  unknownAgent: (agent: string) => new AgentProfileError(404, "UNKNOWN_AGENT", `Unknown agent "${agent}".`),
  notInstalled: (label: string) =>
    new AgentProfileError(404, "AGENT_NOT_INSTALLED", `${label} is not installed on this host.`),
  kindNotSupported: (label: string, kind: string) =>
    new AgentProfileError(400, "KIND_NOT_SUPPORTED", `${label} has no ${kind} items.`),
  notFound: (id: string) => new AgentProfileError(404, "ITEM_NOT_FOUND", `No item "${id}".`),
  exists: (name: string) => new AgentProfileError(409, "ITEM_EXISTS", `"${name}" already exists.`),
  locked: (name: string) =>
    new AgentProfileError(403, "ITEM_LOCKED", `"${name}" is managed by Orquester or the agent itself and cannot be changed here.`),
  notEditable: (name: string) => new AgentProfileError(403, "NOT_EDITABLE", `"${name}" cannot be edited here.`),
  notToggleable: (name: string) => new AgentProfileError(403, "NOT_TOGGLEABLE", `"${name}" cannot be turned on or off here.`),
  notDeletable: (name: string) => new AgentProfileError(403, "NOT_DELETABLE", `"${name}" cannot be deleted here.`),
  conflict: (message = "It changed on disk since you loaded it. The list has been refreshed.") =>
    new AgentProfileError(409, "PROFILE_CONFLICT", message),
  unreadable: (path: string, detail: string) =>
    new AgentProfileError(409, "CONFIG_UNREADABLE", `${path} could not be read (${detail}). Fix the file before changing it here.`),
  stashConflict: (path: string) =>
    new AgentProfileError(409, "STASH_CONFLICT", `Cannot turn it back on: ${path} is now taken by something else.`),
  cliFailed: (command: string, detail: string) =>
    new AgentProfileError(502, "AGENT_CLI_FAILED", `${command} failed: ${detail}`),
  verifyFailed: (path: string, detail: string) =>
    new AgentProfileError(500, "WRITE_VERIFY_FAILED", `${path} no longer parsed after the write and was restored (${detail}).`),
  importNotFound: (importId: string) =>
    new AgentProfileError(404, "IMPORT_NOT_FOUND", `Import "${importId}" expired or does not exist. Scan again.`),
  importFailed: (message: string) => new AgentProfileError(400, "IMPORT_FAILED", message),
  uploadTooLarge: (limit: number) =>
    new AgentProfileError(413, "UPLOAD_TOO_LARGE", `The upload is larger than ${limit} bytes.`)
};
