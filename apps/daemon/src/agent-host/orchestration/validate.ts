/**
 * Agent host — command-body validation (spec §4.1 "Input bounds", §6.2).
 *
 * The §4.1 rules are enforced **here**, in orchestration, so no adapter can
 * forget them: the bounds are stated once in `@orquester/api/agent-chat` and
 * checked once on the way in. Everything in this module is pure.
 */

import {
  MAX_TURN_ATTACHMENTS,
  MAX_TURN_FILE_BYTES,
  MAX_TURN_IMAGE_BYTES,
  MAX_TURN_INPUT_CHARS,
  RUNTIME_MODES,
  SUPPORTED_ATTACHMENT_IMAGE_MIME_TYPES,
  type AgentChatCommandName,
  type ApprovalDecision,
  type AttachmentRef,
  type ComposerContextRecord,
  type InteractionMode,
  type ModelSelection,
  type RuntimeMode
} from "@orquester/api/agent-chat";

import { invalidCommand } from "./errors.ts";

const APPROVAL_DECISIONS: ReadonlySet<string> = new Set<ApprovalDecision>([
  "accept",
  "acceptForSession",
  "acceptAlways",
  "decline",
  "cancel"
]);

const IMAGE_MIME_TYPES: ReadonlySet<string> = new Set<string>(
  SUPPORTED_ATTACHMENT_IMAGE_MIME_TYPES
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function requireBody(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    return {} as Record<string, unknown>;
  }
  return value;
}

/** Every §6.2 command carries the client-minted idempotency key. */
export function requireCommandId(body: Record<string, unknown>): string {
  const commandId = body.commandId;
  if (typeof commandId !== "string" || commandId.trim().length === 0) {
    throw invalidCommand("commandId is required.");
  }
  if (commandId.length > 200) {
    throw invalidCommand("commandId is too long.");
  }
  return commandId;
}

export function parseRuntimeMode(value: unknown, field = "runtimeMode"): RuntimeMode {
  if (typeof value !== "string" || !(RUNTIME_MODES as readonly string[]).includes(value)) {
    throw invalidCommand(`${field} must be one of ${RUNTIME_MODES.join(", ")}.`);
  }
  return value as RuntimeMode;
}

export function parseInteractionMode(value: unknown): InteractionMode {
  if (value === undefined) {
    return "default";
  }
  if (value !== "default" && value !== "plan") {
    throw invalidCommand("interactionMode must be 'default' or 'plan'.");
  }
  return value;
}

export function parseApprovalDecision(value: unknown): ApprovalDecision {
  if (typeof value !== "string" || !APPROVAL_DECISIONS.has(value)) {
    throw invalidCommand(
      "decision must be one of accept, acceptForSession, acceptAlways, decline, cancel."
    );
  }
  return value as ApprovalDecision;
}

export function parseModelSelection(value: unknown, field = "modelSelection"): ModelSelection {
  if (!isRecord(value)) {
    throw invalidCommand(`${field} must be an object.`);
  }
  const model = value.model;
  if (typeof model !== "string" || model.trim().length === 0) {
    throw invalidCommand(`${field}.model is required.`);
  }
  const selection: ModelSelection = { model };
  if (typeof value.instanceId === "string") {
    selection.instanceId = value.instanceId;
  }
  if (value.options !== undefined) {
    if (!Array.isArray(value.options)) {
      throw invalidCommand(`${field}.options must be an array.`);
    }
    selection.options = value.options.map((option) => {
      if (!isRecord(option) || typeof option.id !== "string") {
        throw invalidCommand(`${field}.options[].id is required.`);
      }
      const optionValue = option.value;
      if (typeof optionValue !== "string" && typeof optionValue !== "boolean") {
        throw invalidCommand(`${field}.options[].value must be a string or a boolean.`);
      }
      return { id: option.id, value: optionValue };
    });
  }
  return selection;
}

/**
 * One flat string, trimmed, ≤ {@link MAX_TURN_INPUT_CHARS} (§4.1).
 *
 * The text is **never rewritten** beyond trimming: §4.6.9 — Claude's only
 * user-side command invocation is a text block whose first character is `/`,
 * so no prefix, indent or wrapper may ever be added to a turn.
 */
export function parseTurnInput(value: unknown, { allowEmpty = false } = {}): string {
  if (value === undefined && allowEmpty) {
    return "";
  }
  if (typeof value !== "string") {
    throw invalidCommand("input must be a string.");
  }
  const trimmed = value.trim();
  if (trimmed.length > MAX_TURN_INPUT_CHARS) {
    throw invalidCommand(`input exceeds ${MAX_TURN_INPUT_CHARS} characters.`);
  }
  return trimmed;
}

function parseAttachment(value: unknown, field: string): AttachmentRef {
  if (!isRecord(value)) {
    throw invalidCommand(`${field} must be an object.`);
  }
  const { id, name } = value;
  if (typeof id !== "string" || id.trim().length === 0) {
    throw invalidCommand(`${field}.id is required.`);
  }
  if (typeof name !== "string" || name.length === 0) {
    throw invalidCommand(`${field}.name is required.`);
  }
  // The mime is lowercased before it is judged, and the whole set is refused if
  // any member fails (§6.3).
  const mimeType = typeof value.mimeType === "string" ? value.mimeType.toLowerCase() : undefined;
  const sizeBytes = typeof value.sizeBytes === "number" ? value.sizeBytes : undefined;
  if (sizeBytes !== undefined && (!Number.isFinite(sizeBytes) || sizeBytes < 0)) {
    throw invalidCommand(`${field}.sizeBytes must be a non-negative number.`);
  }
  const type = value.type;

  if (type === "image") {
    if (mimeType === undefined || !mimeType.startsWith("image/")) {
      throw invalidCommand(`${field}.mimeType must be an image type.`);
    }
    if (!IMAGE_MIME_TYPES.has(mimeType)) {
      throw invalidCommand(
        `${field}.mimeType must be one of ${SUPPORTED_ATTACHMENT_IMAGE_MIME_TYPES.join(", ")}.`
      );
    }
    if (sizeBytes === undefined) {
      throw invalidCommand(`${field}.sizeBytes is required for an image.`);
    }
    if (sizeBytes > MAX_TURN_IMAGE_BYTES) {
      throw invalidCommand(`${field} exceeds the ${MAX_TURN_IMAGE_BYTES}-byte image limit.`);
    }
    return { type: "image", id, name, mimeType, sizeBytes };
  }

  if (type === "file") {
    if (sizeBytes === undefined) {
      throw invalidCommand(`${field}.sizeBytes is required for a file.`);
    }
    if (sizeBytes > MAX_TURN_FILE_BYTES) {
      throw invalidCommand(`${field} exceeds the ${MAX_TURN_FILE_BYTES}-byte file limit.`);
    }
    return {
      type: "file",
      id,
      name,
      ...(mimeType !== undefined ? { mimeType } : {}),
      sizeBytes
    };
  }

  // The third arm is a deliberate forward-compat catch-all so a newer producer
  // cannot break an older decoder (§4.1). It is still bounded by the file cap.
  if (sizeBytes !== undefined && sizeBytes > MAX_TURN_FILE_BYTES) {
    throw invalidCommand(`${field} exceeds the ${MAX_TURN_FILE_BYTES}-byte file limit.`);
  }
  return {
    type: "unknown",
    id,
    name,
    ...(mimeType !== undefined ? { mimeType } : {}),
    ...(sizeBytes !== undefined ? { sizeBytes } : {})
  };
}

export function parseAttachments(value: unknown, field = "attachments"): AttachmentRef[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw invalidCommand(`${field} must be an array.`);
  }
  if (value.length > MAX_TURN_ATTACHMENTS) {
    throw invalidCommand(`${field} exceeds ${MAX_TURN_ATTACHMENTS} entries.`);
  }
  return value.map((entry, index) => parseAttachment(entry, `${field}[${index}]`));
}

export function parseComposerContext(value: unknown): ComposerContextRecord[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw invalidCommand("context must be an array.");
  }
  if (value.length > 64) {
    throw invalidCommand("context exceeds 64 entries.");
  }
  return value.map((entry, index) => {
    if (!isRecord(entry) || typeof entry.kind !== "string" || typeof entry.label !== "string") {
      throw invalidCommand(`context[${index}] must carry a kind and a label.`);
    }
    return {
      kind: entry.kind,
      label: entry.label,
      ...(typeof entry.ref === "string" ? { ref: entry.ref } : {})
    };
  });
}

export function parseRequestId(body: Record<string, unknown>): string {
  const requestId = body.requestId;
  if (typeof requestId !== "string" || requestId.length === 0) {
    throw invalidCommand("requestId is required.");
  }
  return requestId;
}

export function parseAnswers(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw invalidCommand("answers must be an object.");
  }
  return value;
}

export function parseAttachmentsByQuestionId(
  value: unknown
): Record<string, AttachmentRef[]> | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw invalidCommand("attachmentsByQuestionId must be an object.");
  }
  const parsed: Record<string, AttachmentRef[]> = {};
  for (const [questionId, list] of Object.entries(value)) {
    parsed[questionId] = parseAttachments(list, `attachmentsByQuestionId[${questionId}]`);
  }
  return parsed;
}

/** `targetTurnCount` is a non-negative integer; anything else is 400 (§6.2). */
export function parseTargetTurnCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw invalidCommand("targetTurnCount must be a non-negative integer.");
  }
  return value;
}

export function parseOptionalTurnId(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string" || value.length === 0) {
    throw invalidCommand("turnId must be a non-empty string.");
  }
  return value;
}

/** Every §6.2 command name, used by the router to reject an unknown path. */
export const COMMAND_NAMES: ReadonlySet<AgentChatCommandName> = new Set<AgentChatCommandName>([
  "turn",
  "interrupt",
  "approval",
  "answer",
  "dismiss",
  "revert",
  "compact",
  "mode",
  "background",
  "session/stop"
]);
