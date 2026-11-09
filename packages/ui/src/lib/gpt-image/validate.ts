/**
 * GPT Image — wire validation for the `gptImageRoutes.settings` answer (GET and PUT) before it
 * reaches the plugin pane's state.
 *
 * The rule (as in `lib/knowledge/validate.ts`): an account this client cannot name (no id) is left
 * out on its own; a bad field is repaired to its default; a broken envelope (not an object, no
 * settings object, the account list not an array) makes the whole answer `null`. Unknown fields
 * are ignored, never a reason to refuse. No React, no store.
 */

import {
  GPT_IMAGE_DEFAULT_PROJECT_FOLDER,
  GPT_IMAGE_DEFAULT_SETTINGS,
  type GptImageAccountBlock,
  type GptImageAccountInfo,
  type GptImageSaveTo,
  type GptImageSettings,
  type GptImageSettingsResponse
} from "@orquester/api";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value : null);

const BLOCKS: ReadonlySet<string> = new Set<GptImageAccountBlock>(["needs-reauth", "free-plan"]);

function readSaveTo(value: unknown): GptImageSaveTo {
  if (!isRecord(value)) return GPT_IMAGE_DEFAULT_SETTINGS.saveTo;
  if (value.kind === "project") return { kind: "project", folder: text(value.folder) ?? GPT_IMAGE_DEFAULT_PROJECT_FOLDER };
  return { kind: "chat" };
}

function readSettings(value: Record<string, unknown>): GptImageSettings {
  return { account: text(value.account) ?? GPT_IMAGE_DEFAULT_SETTINGS.account, saveTo: readSaveTo(value.saveTo) };
}

function readAccount(value: unknown): GptImageAccountInfo | null {
  if (!isRecord(value)) return null;
  const id = text(value.id);
  if (id === null) return null;
  const email = text(value.email);
  const account: GptImageAccountInfo = { id, label: text(value.label) ?? email ?? id, email, plan: text(value.plan) };
  // A reason this client does not know is not shown as one it does.
  if (typeof value.blocked === "string" && BLOCKS.has(value.blocked)) account.blocked = value.blocked as GptImageAccountBlock;
  return account;
}

/** The settings answer, or null when it is not one. */
export function parseGptImageSettingsResponse(value: unknown): GptImageSettingsResponse | null {
  if (!isRecord(value) || !isRecord(value.settings) || !Array.isArray(value.accounts)) return null;
  const accounts: GptImageAccountInfo[] = [];
  const seen = new Set<string>();
  for (const entry of value.accounts) {
    const account = readAccount(entry);
    if (account === null || seen.has(account.id)) continue;
    seen.add(account.id);
    accounts.push(account);
  }
  return { settings: readSettings(value.settings), accounts, activeAccountId: text(value.activeAccountId) };
}
