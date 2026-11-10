// "GPT Image" (docs/superpowers/specs/2026-11-10-gpt-image-plugin-design.md): agents generate and
// edit images with GPT Image on a ChatGPT plan behind a connected Codex account. The plugin id is
// declared here with its contracts, like `devices.ts`.

export const GPT_IMAGE_PLUGIN_ID = "gpt-image";

/** Where a generated image goes besides the chat (spec §7.2). */
export type GptImageSaveTo = { kind: "chat" } | { kind: "project"; folder: string };

/** The plugin's stored settings (spec §8), kept in its `settings` in plugins.json. */
export interface GptImageSettings {
  /** `"auto"`, or one Codex account's id (spec §5). */
  account: string;
  saveTo: GptImageSaveTo;
}

export const GPT_IMAGE_DEFAULT_PROJECT_FOLDER = "assets/generated";

export const GPT_IMAGE_DEFAULT_SETTINGS: GptImageSettings = {
  account: "auto",
  saveTo: { kind: "chat" }
};

/** Why a Codex account cannot make images now (spec §5). */
export type GptImageAccountBlock = "needs-reauth" | "free-plan";

/** One connected Codex account as the plugin's pane lists it. Never carries a token. */
export interface GptImageAccountInfo {
  id: string;
  label: string;
  email: string | null;
  /** The ChatGPT plan the account's token names (`plus`, `pro`, `team`, …), when known. */
  plan: string | null;
  /** Absent: the account can make images. */
  blocked?: GptImageAccountBlock;
}

/** `GET gptImageRoutes.settings`: the settings and what the pane needs to show them. */
export interface GptImageSettingsResponse {
  settings: GptImageSettings;
  accounts: GptImageAccountInfo[];
  /** The account `generate_image` would use now, or null when none can make images. */
  activeAccountId: string | null;
}

/** `PUT gptImageRoutes.settings`: a partial update; the answer is the new {@link GptImageSettingsResponse}. */
export interface UpdateGptImageSettingsRequest {
  account?: string;
  saveTo?: GptImageSaveTo;
}

export const gptImageRoutes = {
  settings: "/api/gpt-image/settings"
} as const;
