/**
 * The GPT Image plugin's daemon service (design
 * `docs/superpowers/specs/2026-11-10-gpt-image-plugin-design.md` §5–§8, §10–§11): its settings,
 * whether `generate_image` is advertised, and one generation from account choice to project file.
 *
 * - **Settings** live in the plugin's `settings` in plugins.json (`storedGptImageSettings` reads them
 *   field by field; `updatePluginSettings` merges a change, keeping unknown keys).
 * - **Availability** (`toolsAvailable`): the plugin is on and at least one Codex account is eligible
 *   (`accounts.ts`). Recomputed when plugins or accounts change; listeners hear a flip.
 * - **One call:** the candidates (`auto`: every eligible account, failing over once on an exhausted
 *   limit or a plan refusal; a pinned account alone), at most {@link PER_ACCOUNT_CONCURRENCY} calls
 *   in flight per account (the rest wait in order), the whole call bounded by
 *   {@link GENERATE_TIMEOUT_MS}. A 401 renews the login once through `refreshNow`; a 401 with a
 *   fresh token flags the account `needsReauth`.
 *
 * Storing the image as a thread attachment is the tool's (`storeChatImage`); this service writes
 * the project copy only.
 */

import type { EventEmitter } from "node:events";

import {
  GPT_IMAGE_DEFAULT_PROJECT_FOLDER,
  GPT_IMAGE_DEFAULT_SETTINGS,
  GPT_IMAGE_PLUGIN_ID,
  type GptImageSaveTo,
  type GptImageSettings,
  type GptImageSettingsResponse
} from "@orquester/api";
import type { ChatImageMimeType } from "@orquester/api/agent-chat";
import { isSafeGptImageFolder, storedGptImageSettings } from "@orquester/config";

import { sniffImage } from "../mcp/chat-images.ts";
import type { PluginsService } from "../plugins/plugins-service.ts";
import {
  accountBlock,
  accountInfo,
  activeAccountId,
  candidateAccounts,
  codexAccountViews,
  credentialsFor,
  type CodexAccountView,
  type GptImageAccountsPort
} from "./accounts.ts";
import {
  DISABLED_MESSAGE,
  FREE_PLAN_MESSAGE,
  GptImageError,
  isGptImageError,
  needsSignInMessage,
  quotaMessage
} from "./errors.ts";
import { plannedSave, promptSlug, saveIntoProject } from "./storage.ts";
import type { GptImageToolInput, GptImageToolPort, GptImageToolResult } from "./tool-port.ts";
import { postImageRequest, UpstreamError, type UpstreamDeps, type UpstreamFailure, type UpstreamImage } from "./upstream.ts";

/** The whole call (queue wait, renewals, retries) is aborted after this. */
export const GENERATE_TIMEOUT_MS = 5 * 60_000;
/** Calls in flight per account; the rest wait in order. */
export const PER_ACCOUNT_CONCURRENCY = 2;
/** At most this many reference images (the edits endpoint's cap). */
export const MAX_REFERENCE_IMAGES = 5;
/** A prompt longer than this is refused before anything is sent. */
export const MAX_PROMPT_CHARS = 32_000;

const EXTENSIONS: Readonly<Record<ChatImageMimeType, string>> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif"
};

export class GptImageSettingsError extends Error {
  readonly status = 400;
  constructor(
    readonly code: "GPT_IMAGE_INVALID" | "GPT_IMAGE_UNKNOWN_ACCOUNT",
    message: string
  ) {
    super(message);
    this.name = "GptImageSettingsError";
  }
}

export interface GptImageServiceDeps {
  plugins: Pick<PluginsService, "isEnabled" | "pluginSettings" | "updatePluginSettings"> & { events: Pick<EventEmitter, "on" | "off"> };
  accounts: GptImageAccountsPort & { events?: Pick<EventEmitter, "on" | "off"> };
  /** The workspaces sandbox root (read per call: `PUT /api/config/daemon` moves it). */
  fsRoot(): string;
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  logger?: Pick<Console, "warn" | "error">;
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** A FIFO gate of `limit` slots; a waiter leaves the queue when its signal aborts. */
class Gate {
  private active = 0;
  private readonly waiting: { start: () => void; signal: AbortSignal; onAbort: () => void }[] = [];
  constructor(private readonly limit: number) {}

  async run<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve, reject) => {
        if (signal.aborted) return reject(signal.reason);
        const entry = {
          signal,
          start: () => {
            signal.removeEventListener("abort", entry.onAbort);
            resolve();
          },
          onAbort: () => {
            const index = this.waiting.indexOf(entry);
            if (index !== -1) this.waiting.splice(index, 1);
            reject(signal.reason);
          }
        };
        signal.addEventListener("abort", entry.onAbort, { once: true });
        this.waiting.push(entry);
      });
    } else {
      this.active += 1;
    }
    try {
      return await work();
    } finally {
      const next = this.waiting.shift();
      // The slot passes straight to the next waiter (so `active` never dips under a busy gate).
      if (next) next.start();
      else this.active -= 1;
    }
  }
}

export class GptImageService implements GptImageToolPort {
  /** Account id → the plan its token names (read at start, on account changes, on each use). */
  private readonly plans = new Map<string, string | null>();
  /** Accounts the endpoint answered with a plan refusal: blocked as Free until the next account change. */
  private readonly refusedPlans = new Set<string>();
  private readonly gates = new Map<string, Gate>();
  private readonly listeners = new Set<() => void>();
  private available = false;
  private readonly unsubscribe: (() => void)[] = [];
  private readonly upstream: UpstreamDeps;

  constructor(private readonly deps: GptImageServiceDeps) {
    this.upstream = {
      fetch: deps.fetch ?? fetch,
      sleep: deps.sleep ?? abortableSleep,
      now: deps.now ?? Date.now,
      ...(deps.logger ? { logger: deps.logger } : {})
    };
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  // -------------------------------------------------------------------------
  // Lifecycle and availability
  // -------------------------------------------------------------------------

  /** Follow the plugin and the accounts from now on (after `plugins.start()`); resolves once the plans were read. */
  async start(): Promise<void> {
    const onPlugins = () => this.recompute();
    const onAccounts = () => {
      this.refusedPlans.clear();
      void this.refreshPlans();
    };
    this.deps.plugins.events.on("changed", onPlugins);
    this.unsubscribe.push(() => this.deps.plugins.events.off("changed", onPlugins));
    if (this.deps.accounts.events) {
      const events = this.deps.accounts.events;
      events.on("changed", onAccounts);
      this.unsubscribe.push(() => events.off("changed", onAccounts));
    }
    await this.refreshPlans();
  }

  stop(): void {
    for (const off of this.unsubscribe.splice(0)) off();
    this.listeners.clear();
  }

  /** Whether `generate_image` is advertised now: the plugin is on and an account can make images. */
  toolsAvailable(): boolean {
    return this.available;
  }

  /** The availability may have flipped. Returns the unsubscribe. */
  onToolsChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private enabled(): boolean {
    return this.deps.plugins.isEnabled(GPT_IMAGE_PLUGIN_ID);
  }

  private views(): CodexAccountView[] {
    return codexAccountViews(this.deps.accounts.list().accounts, this.plans).map((view) =>
      this.refusedPlans.has(view.id) ? { ...view, plan: "free" } : view
    );
  }

  private recompute(): void {
    const next = this.enabled() && this.views().some((view) => accountBlock(view) === undefined);
    if (next === this.available) return;
    this.available = next;
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch (error) {
        this.deps.logger?.warn?.("gpt-image: a tools-change listener failed", error instanceof Error ? error.message : String(error));
      }
    }
  }

  /** Re-read every Codex account's plan from its token (never its refresh token), then recompute. */
  async refreshPlans(): Promise<void> {
    const codex = this.deps.accounts.list().accounts.filter((account) => account.agent === "codex");
    for (const id of [...this.plans.keys()]) if (!codex.some((account) => account.id === id)) this.plans.delete(id);
    for (const account of codex) {
      const login = await this.deps.accounts.codexLogin(account.id).catch(() => null);
      this.plans.set(account.id, login?.plan ?? null);
    }
    this.recompute();
  }

  // -------------------------------------------------------------------------
  // Settings
  // -------------------------------------------------------------------------

  settings(): GptImageSettings {
    const stored = storedGptImageSettings({ settings: this.deps.plugins.pluginSettings(GPT_IMAGE_PLUGIN_ID) });
    const saveTo: GptImageSaveTo =
      stored.saveTo?.kind === "project" ? { kind: "project", folder: stored.saveTo.folder ?? GPT_IMAGE_DEFAULT_PROJECT_FOLDER } : { ...GPT_IMAGE_DEFAULT_SETTINGS.saveTo };
    return { account: stored.account ?? GPT_IMAGE_DEFAULT_SETTINGS.account, saveTo };
  }

  settingsResponse(): GptImageSettingsResponse {
    const settings = this.settings();
    const views = this.views();
    return { settings, accounts: views.map(accountInfo), activeAccountId: activeAccountId(views, settings.account) };
  }

  /**
   * `PUT`: a partial {@link GptImageSettings}. `account` must be `"auto"` or an existing Codex
   * account's id; a project `saveTo` needs a safe relative folder (`isSafeGptImageFolder`).
   */
  async updateSettings(body: unknown): Promise<GptImageSettingsResponse> {
    if (typeof body !== "object" || body === null || Array.isArray(body)) throw new GptImageSettingsError("GPT_IMAGE_INVALID", "Send a JSON object.");
    const record = body as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    if (record.account !== undefined) {
      if (typeof record.account !== "string" || record.account === "") throw new GptImageSettingsError("GPT_IMAGE_INVALID", 'account must be "auto" or a Codex account id.');
      if (record.account !== "auto" && !this.deps.accounts.list().accounts.some((account) => account.agent === "codex" && account.id === record.account)) {
        throw new GptImageSettingsError("GPT_IMAGE_UNKNOWN_ACCOUNT", "No Codex account has that id.");
      }
      patch.account = record.account;
    }
    if (record.saveTo !== undefined) {
      const saveTo = record.saveTo as Record<string, unknown> | null;
      if (typeof saveTo !== "object" || saveTo === null || Array.isArray(saveTo)) throw new GptImageSettingsError("GPT_IMAGE_INVALID", 'saveTo must be {kind: "chat"} or {kind: "project", folder}.');
      if (saveTo.kind === "chat") patch.saveTo = { kind: "chat" };
      else if (saveTo.kind === "project") {
        const folder = saveTo.folder === undefined ? GPT_IMAGE_DEFAULT_PROJECT_FOLDER : typeof saveTo.folder === "string" ? saveTo.folder.trim() : saveTo.folder;
        if (!isSafeGptImageFolder(folder)) {
          throw new GptImageSettingsError("GPT_IMAGE_INVALID", "The folder must be a path inside the project, like assets/generated (no leading /, no ..).");
        }
        patch.saveTo = { kind: "project", folder: folder.replace(/\/+$/, "") };
      } else throw new GptImageSettingsError("GPT_IMAGE_INVALID", 'saveTo.kind must be "chat" or "project".');
    }
    if (Object.keys(patch).length > 0) await this.deps.plugins.updatePluginSettings(GPT_IMAGE_PLUGIN_ID, patch);
    return this.settingsResponse();
  }

  // -------------------------------------------------------------------------
  // generate_image
  // -------------------------------------------------------------------------

  private gate(accountId: string): Gate {
    let gate = this.gates.get(accountId);
    if (!gate) {
      gate = new Gate(PER_ACCOUNT_CONCURRENCY);
      this.gates.set(accountId, gate);
    }
    return gate;
  }

  async generate(input: GptImageToolInput, signal: AbortSignal): Promise<GptImageToolResult> {
    if (!this.enabled()) throw new GptImageError("GPT_IMAGE_DISABLED", DISABLED_MESSAGE);
    const prompt = input.prompt.trim();
    if (prompt === "") throw new GptImageError("INVALID_ARGUMENT", "prompt: say what to make or change.");
    if (prompt.length > MAX_PROMPT_CHARS) throw new GptImageError("INVALID_ARGUMENT", `prompt: at most ${MAX_PROMPT_CHARS} characters.`);
    if (input.images.length > MAX_REFERENCE_IMAGES) throw new GptImageError("INVALID_ARGUMENT", `images: at most ${MAX_REFERENCE_IMAGES}.`);
    const settings = this.settings();
    // A save_as outside the project is refused before anything is sent.
    const save = plannedSave({ ...(input.saveAs !== undefined ? { saveAs: input.saveAs } : {}), setting: settings.saveTo, projectPath: input.projectPath, inBox: input.inBox });
    const { candidates, pinned } = candidateAccounts(this.views(), settings.account);
    const tries = candidates.slice(0, pinned ? 1 : 2);

    const timeout = AbortSignal.timeout(GENERATE_TIMEOUT_MS);
    const callSignal = AbortSignal.any([signal, timeout]);
    let made: { image: UpstreamImage; account: CodexAccountView } | null = null;
    try {
      for (let index = 0; index < tries.length && made === null; index += 1) {
        const account = tries[index]!;
        try {
          const image = await this.gate(account.id).run(callSignal, () => this.callWith(account, { prompt, images: input.images, transparent: input.transparent }, callSignal));
          made = { image, account };
        } catch (error) {
          const failover = !pinned && index + 1 < tries.length && error instanceof UpstreamError && (error.failure.kind === "quota" || error.failure.kind === "free-plan");
          if (!failover) throw error;
          if (error.failure.kind === "free-plan") this.refusedPlans.add(account.id);
          this.deps.logger?.warn?.(`gpt-image: ${account.label} answered ${error.failure.kind}; trying the next account`);
        }
      }
    } catch (error) {
      // A login flagged on the way (needs signing in) may leave no account that can make images.
      this.recompute();
      if (signal.aborted) throw new GptImageError("CANCELLED", "The call was cancelled.");
      if (timeout.aborted) throw new GptImageError("GPT_IMAGE_TIMEOUT", "The image took longer than 5 minutes. Try again, perhaps with a simpler prompt.");
      throw this.refusal(error, tries.at(-1)!);
    }
    if (made === null) throw new GptImageError("GPT_IMAGE_UNEXPECTED", "Unexpected response from ChatGPT.");

    const sniffed = sniffImage(made.image.bytes);
    if (!sniffed) {
      this.deps.logger?.warn?.(`gpt-image: the image endpoint sent ${made.image.bytes.length} bytes that are no PNG, JPEG, WebP or GIF`);
      throw new GptImageError("GPT_IMAGE_UNEXPECTED", "Unexpected response from ChatGPT.");
    }
    const result: GptImageToolResult = {
      bytes: made.image.bytes,
      mimeType: sniffed.mimeType,
      name: `${promptSlug(prompt)}${EXTENSIONS[sniffed.mimeType]}`,
      ...(sniffed.width !== undefined && sniffed.height !== undefined ? { width: sniffed.width, height: sniffed.height } : {}),
      transparent: made.image.background !== undefined ? made.image.background === "transparent" : input.transparent,
      ...(made.image.revisedPrompt ? { revisedPrompt: made.image.revisedPrompt } : {}),
      account: made.account.label
    };
    if (save.kind === "chat") return save.reason ? { ...result, note: save.reason } : result;
    try {
      const written = await saveIntoProject({
        fsRoot: this.deps.fsRoot(),
        projectPath: save.projectPath,
        target: save.target,
        prompt,
        bytes: made.image.bytes,
        ext: EXTENSIONS[sniffed.mimeType]
      });
      return { ...result, path: written.path, relativePath: written.relativePath };
    } catch (error) {
      if (isGptImageError(error)) return { ...result, note: `Not written into the project: ${error.message.replace(/^save_as: /, "")}` };
      this.deps.logger?.error?.("gpt-image: the project copy could not be written", error instanceof Error ? error.message : String(error));
      return { ...result, note: "Not written into the project: the file could not be written. The image is kept with the chat." };
    }
  }

  /** One account's call: its login (renewed when due), the request, one renewal after a 401. */
  private async callWith(account: CodexAccountView, request: { prompt: string; images: GptImageToolInput["images"]; transparent: boolean }, signal: AbortSignal): Promise<UpstreamImage> {
    let login = await credentialsFor(this.deps.accounts, account, this.now());
    this.notePlan(account.id, login.plan);
    try {
      return await postImageRequest(this.upstream, login.credentials, request, signal);
    } catch (error) {
      if (!(error instanceof UpstreamError) || error.failure.kind !== "auth") throw error;
      if (login.refreshed) return this.signedOut(account);
    }
    // The token was refused before it was due: renew it once.
    login = await credentialsFor(this.deps.accounts, account, this.now(), { force: true });
    this.notePlan(account.id, login.plan);
    try {
      return await postImageRequest(this.upstream, login.credentials, request, signal);
    } catch (error) {
      if (error instanceof UpstreamError && error.failure.kind === "auth") return this.signedOut(account);
      throw error;
    }
  }

  private async signedOut(account: CodexAccountView): Promise<never> {
    await this.deps.accounts.markNeedsReauth(account.id, true).catch(() => undefined);
    throw new GptImageError("GPT_IMAGE_NEEDS_SIGN_IN", needsSignInMessage(account.label));
  }

  private notePlan(id: string, plan: string | null): void {
    if (this.plans.get(id) === plan) return;
    this.plans.set(id, plan);
    this.recompute();
  }

  /** The §11 refusal for a failed call. */
  private refusal(error: unknown, account: CodexAccountView): GptImageError {
    if (isGptImageError(error)) return error;
    if (!(error instanceof UpstreamError)) {
      this.deps.logger?.error?.("gpt-image: a call failed", error instanceof Error ? error.message : String(error));
      return new GptImageError("GPT_IMAGE_UNAVAILABLE", "ChatGPT could not be reached. Try again in a minute.");
    }
    const failure: UpstreamFailure = error.failure;
    switch (failure.kind) {
      case "quota":
        return new GptImageError("GPT_IMAGE_QUOTA", quotaMessage(account.label, failure.resetsAt));
      case "free-plan":
        this.refusedPlans.add(account.id);
        this.recompute();
        return new GptImageError("GPT_IMAGE_FREE_PLAN", FREE_PLAN_MESSAGE);
      case "safety":
        return new GptImageError("GPT_IMAGE_REFUSED", `ChatGPT refused this image: ${failure.message}`);
      case "invalid":
        return new GptImageError("GPT_IMAGE_INVALID", `ChatGPT refused the request: ${failure.message}`);
      case "auth":
        return new GptImageError("GPT_IMAGE_NEEDS_SIGN_IN", needsSignInMessage(account.label));
      case "transient":
        return new GptImageError("GPT_IMAGE_UNAVAILABLE", `ChatGPT's image service is not answering right now${failure.status ? ` (HTTP ${failure.status})` : ""}. Try again in a minute.`);
      case "unexpected":
        this.deps.logger?.warn?.(`gpt-image: unexpected HTTP ${failure.status} from the image endpoint`);
        return new GptImageError("GPT_IMAGE_UNEXPECTED", "Unexpected response from ChatGPT.");
    }
  }
}
