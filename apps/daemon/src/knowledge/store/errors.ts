import type { KnowledgeErrorCode } from "@orquester/api";

const STATUS: Record<KnowledgeErrorCode, number> = {
  KNOWLEDGE_DISABLED: 409,
  KNOWLEDGE_NOT_INSTALLED: 409,
  KNOWLEDGE_NOT_FOUND: 404,
  KNOWLEDGE_INVALID: 400,
  KNOWLEDGE_COLLECTION_EXISTS: 409,
  KNOWLEDGE_UNKNOWN_COLLECTION: 400,
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

export interface KnowledgeLogger {
  warn(message: string): void;
  error(message: string): void;
}
