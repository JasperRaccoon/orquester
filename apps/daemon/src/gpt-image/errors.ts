/**
 * GPT Image refusals (design `docs/superpowers/specs/2026-11-10-gpt-image-plugin-design.md` §11):
 * each carries a code and a message written for the agent and the user. Messages never carry a
 * token, an account id or an upstream body beyond a short refusal text.
 */

export type GptImageErrorCode =
  | "GPT_IMAGE_DISABLED"
  | "GPT_IMAGE_NO_ACCOUNT"
  | "GPT_IMAGE_QUOTA"
  | "GPT_IMAGE_FREE_PLAN"
  | "GPT_IMAGE_NEEDS_SIGN_IN"
  | "GPT_IMAGE_REFUSED"
  | "GPT_IMAGE_INVALID"
  | "GPT_IMAGE_UNAVAILABLE"
  | "GPT_IMAGE_UNEXPECTED"
  | "GPT_IMAGE_TIMEOUT"
  | "INVALID_ARGUMENT"
  | "CANCELLED";

export class GptImageError extends Error {
  constructor(
    readonly code: GptImageErrorCode,
    message: string
  ) {
    super(message);
    this.name = "GptImageError";
  }
}

export function isGptImageError(error: unknown): error is GptImageError {
  return error instanceof GptImageError;
}

/** "This account's Codex limit is used up; it resets at <time>." (§11) */
export function quotaMessage(label: string, resetsAt: number | null): string {
  const when = resetsAt === null ? "" : `; it resets at ${new Date(resetsAt).toISOString().replace(/\.\d{3}Z$/, "Z")}`;
  return `The Codex limit of ${label} is used up${when}. Images count toward the account's Codex limits.`;
}

export const FREE_PLAN_MESSAGE = "Image generation needs a paid ChatGPT plan (Plus or higher).";

export function needsSignInMessage(label: string): string {
  return `${label} needs signing in again in Settings → Accounts.`;
}

export const DISABLED_MESSAGE = "GPT Image is off. Ask the owner to turn it on in Settings → Plugins.";
export const NO_ACCOUNT_MESSAGE =
  "There is no ChatGPT account that can make images. Connect a Codex account on a paid ChatGPT plan in Settings → Accounts.";
