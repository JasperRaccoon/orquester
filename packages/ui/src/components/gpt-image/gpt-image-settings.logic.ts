/**
 * Pure decisions behind Settings → Plugins → GPT Image (spec §5, §8): the account choices, the
 * edited form and the partial update it saves, the folder check (UX only: the daemon enforces
 * containment), and whose quota the pane shows. No React import.
 */

import {
  GPT_IMAGE_DEFAULT_PROJECT_FOLDER,
  type GptImageAccountBlock,
  type GptImageSaveTo,
  type GptImageSettings,
  type GptImageSettingsResponse,
  type UpdateGptImageSettingsRequest
} from "@orquester/api";

export const GPT_IMAGE_AUTO_ACCOUNT = "auto";

/** The daemon's error text for a failed request (`ApiError.serverMessage`), else the error's own, else `fallback`. */
export function gptImageErrorText(err: unknown, fallback: string): string {
  const server = (err as { serverMessage?: unknown } | null)?.serverMessage;
  if (typeof server === "string" && server) return server;
  return err instanceof Error && err.message ? err.message : fallback;
}

/** One choice of the Account control. */
export interface GptImageAccountOption {
  /** `"auto"` or the account id, as the settings store it. */
  value: string;
  label: string;
  /** The email when the label is not already it. */
  email: string | null;
  /** The plan as people say it ("Plus"), when known. */
  plan: string | null;
  /** Why it can't make images now, or null. */
  blocked: GptImageAccountBlock | null;
  /** `generate_image` would use it now. */
  active: boolean;
  /** The stored choice names an account that is no longer connected. */
  missing: boolean;
}

const PLAN_LABELS: Record<string, string> = {
  free: "Free",
  go: "Go",
  plus: "Plus",
  pro: "Pro",
  team: "Team",
  business: "Business",
  enterprise: "Enterprise",
  edu: "Edu"
};

/** `plus` → "Plus"; an unknown plan keeps its words, capitalised. */
export function gptImagePlanLabel(plan: string | null): string | null {
  const key = plan?.trim().toLowerCase();
  if (!key) return null;
  return (
    PLAN_LABELS[key] ??
    key
      .split(/[\s_-]+/)
      .filter(Boolean)
      .map((word) => word[0]!.toUpperCase() + word.slice(1))
      .join(" ")
  );
}

/**
 * "Auto" first, then every connected Codex account in the daemon's (Settings) order. A stored
 * account that is no longer connected is kept as a choice, so the control shows what is saved.
 */
export function gptImageAccountOptions(response: GptImageSettingsResponse): GptImageAccountOption[] {
  const options: GptImageAccountOption[] = [
    {
      value: GPT_IMAGE_AUTO_ACCOUNT,
      label: "Auto (first account that can make images)",
      email: null,
      plan: null,
      blocked: null,
      active: false,
      missing: false
    }
  ];
  for (const account of response.accounts) {
    options.push({
      value: account.id,
      label: account.label,
      email: account.email && account.email !== account.label ? account.email : null,
      plan: gptImagePlanLabel(account.plan),
      blocked: account.blocked ?? null,
      active: account.id === response.activeAccountId,
      missing: false
    });
  }
  const chosen = response.settings.account;
  if (chosen !== GPT_IMAGE_AUTO_ACCOUNT && !response.accounts.some((account) => account.id === chosen)) {
    options.push({ value: chosen, label: "Removed account", email: null, plan: null, blocked: null, active: false, missing: true });
  }
  return options;
}

/** The pane's form: the save folder is kept while "This chat only" is chosen, so switching back keeps it. */
export interface GptImageSettingsForm {
  account: string;
  saveKind: GptImageSaveTo["kind"];
  folder: string;
}

export function gptImageSettingsForm(settings: GptImageSettings): GptImageSettingsForm {
  return {
    account: settings.account,
    saveKind: settings.saveTo.kind,
    folder: settings.saveTo.kind === "project" ? settings.saveTo.folder : GPT_IMAGE_DEFAULT_PROJECT_FOLDER
  };
}

/** The folder as it is saved: trimmed, `./` and trailing slashes dropped, `\` as `/`. */
export function normalizeGptImageFolder(folder: string): string {
  let out = folder.trim().replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  while (out.startsWith("./")) out = out.slice(2);
  return out.replace(/\/+$/, "");
}

/** Why `folder` can't be the project folder, or null. Only a hint: the daemon checks the real path. */
export function gptImageFolderProblem(folder: string): string | null {
  const normalized = normalizeGptImageFolder(folder);
  if (normalized === "" || normalized === ".") return "Enter a folder inside the project, like assets/generated.";
  if (/\p{Cc}/u.test(normalized)) return "The folder name has characters a path can't hold.";
  if (normalized.startsWith("/") || normalized.startsWith("~") || /^[A-Za-z]:/.test(normalized)) {
    return "Use a path relative to the project, like assets/generated.";
  }
  if (normalized.split("/").includes("..")) return "The folder must stay inside the project.";
  return null;
}

/** What Save sends: only the fields that changed, or why it can't. */
export function gptImageSettingsPatch(
  saved: GptImageSettings,
  form: GptImageSettingsForm
): { patch: UpdateGptImageSettingsRequest } | { error: string } {
  const patch: UpdateGptImageSettingsRequest = {};
  if (form.account !== saved.account) patch.account = form.account;
  if (form.saveKind === "chat") {
    if (saved.saveTo.kind !== "chat") patch.saveTo = { kind: "chat" };
  } else {
    const problem = gptImageFolderProblem(form.folder);
    if (problem) return { error: problem };
    const folder = normalizeGptImageFolder(form.folder);
    if (saved.saveTo.kind !== "project" || saved.saveTo.folder !== folder) patch.saveTo = { kind: "project", folder };
  }
  return { patch };
}

/**
 * The account whose Codex usage the Quota block shows: the one `generate_image` would use now,
 * else the one chosen (it may be blocked, and its usage still says why), else none.
 */
export function gptImageQuotaAccountId(response: GptImageSettingsResponse): string | null {
  if (response.activeAccountId) return response.activeAccountId;
  const chosen = response.settings.account;
  return chosen !== GPT_IMAGE_AUTO_ACCOUNT && response.accounts.some((account) => account.id === chosen) ? chosen : null;
}
