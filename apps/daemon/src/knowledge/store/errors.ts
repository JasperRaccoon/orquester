import type { KnowledgeErrorCode } from "@orquester/api";

const STATUS: Record<KnowledgeErrorCode, number> = {
  KNOWLEDGE_DISABLED: 409,
  KNOWLEDGE_NOT_INSTALLED: 409,
  KNOWLEDGE_NOT_FOUND: 404,
  KNOWLEDGE_INVALID: 400,
  KNOWLEDGE_COLLECTION_EXISTS: 409,
  KNOWLEDGE_UNKNOWN_COLLECTION: 400,
  KNOWLEDGE_UNKNOWN_ACCOUNT: 400,
  KNOWLEDGE_TOO_LARGE: 413,
  KNOWLEDGE_NOT_A_WORKER: 403,
  KNOWLEDGE_BUSY: 409,
  KNOWLEDGE_ERROR: 500
};

/** A refusal the knowledge routes answer as `{ code, message }` with {@link status}. */
export class KnowledgeError extends Error {
  readonly code: KnowledgeErrorCode;
  readonly status: number;

  constructor(code: KnowledgeErrorCode, message: string, status: number = STATUS[code]) {
    super(message);
    this.name = "KnowledgeError";
    this.code = code;
    this.status = status;
  }
}

export function isKnowledgeError(error: unknown): error is KnowledgeError {
  return error instanceof KnowledgeError;
}

/**
 * A Fastify-level refusal (a body over the route's limit, a body that is not JSON, a media type
 * with no parser) as the contract's {@link KnowledgeError}; null for anything else. Fastify's own
 * message can quote the body, so it is never passed on.
 */
export function knowledgeFrameworkError(error: unknown): KnowledgeError | null {
  const code = (error as { code?: unknown } | null)?.code;
  const statusCode = (error as { statusCode?: unknown } | null)?.statusCode;
  if (code === "FST_ERR_CTP_BODY_TOO_LARGE" || statusCode === 413) {
    return new KnowledgeError("KNOWLEDGE_TOO_LARGE", "The request body is too large.");
  }
  if (code === "FST_ERR_CTP_INVALID_MEDIA_TYPE" || statusCode === 415) {
    return new KnowledgeError("KNOWLEDGE_INVALID", "Send the request body as application/json.");
  }
  if (typeof statusCode === "number" && statusCode >= 400 && statusCode < 500) {
    return new KnowledgeError("KNOWLEDGE_INVALID", "The request body is not valid JSON.");
  }
  return null;
}

export interface KnowledgeLogger {
  warn(message: string): void;
  error(message: string): void;
}
