/**
 * The Knowledge Graph plugin's settings ({@link KnowledgeSettings}: the
 * indexing account, model and concurrency), stored on the plugin's
 * plugins.json record as `settings` through `PluginsService` (its file queue,
 * its broadcast), and {@link KnowledgeSettingsPort} over it.
 *
 * Reads are tolerant (a field of the wrong type or out of range reads as its
 * default; other keys in the object, including another build's, are kept on
 * write); writes are validated: concurrency within
 * KNOWLEDGE_CONCURRENCY_MIN..MAX, `accountId` null or an existing Claude
 * account, `model` null or a non-empty string.
 */
import type { EventEmitter } from "node:events";
import {
  KNOWLEDGE_CONCURRENCY_MAX,
  KNOWLEDGE_CONCURRENCY_MIN,
  KNOWLEDGE_DEFAULT_SETTINGS,
  KNOWLEDGE_GRAPH_PLUGIN_ID,
  type KnowledgeErrorCode,
  type KnowledgeSettings,
  type UpdateKnowledgeSettingsRequest
} from "@orquester/api";
import { createDefaultPluginsConfig, pluginStateOf, storedKnowledgeSettings } from "@orquester/config";
import type { KnowledgeSettingsPort } from "./ports.ts";

/** Longest model id accepted (ids are short; this only bounds what is stored). */
export const KNOWLEDGE_MODEL_MAX = 200;

/** A refusal the settings routes answer: `status` with `{ code, message }`. */
export class KnowledgeSettingsError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 500,
    readonly code: KnowledgeErrorCode,
    message: string
  ) {
    super(message);
    this.name = "KnowledgeSettingsError";
  }
}

/** What the settings need from `PluginsService`. */
export interface KnowledgeSettingsPlugins {
  isEnabled(id: typeof KNOWLEDGE_GRAPH_PLUGIN_ID): boolean;
  pluginSettings(id: typeof KNOWLEDGE_GRAPH_PLUGIN_ID): unknown;
  updatePluginSettings(id: typeof KNOWLEDGE_GRAPH_PLUGIN_ID, patch: Record<string, unknown>): Promise<unknown>;
  readonly events: EventEmitter;
}

/** What the settings need from `AgentAccountsService`: an account's agent, by id. */
export interface KnowledgeSettingsAccounts {
  getRecord(id: string): { agent: string } | undefined;
}

export interface KnowledgeSettingsServiceOptions {
  plugins: KnowledgeSettingsPlugins;
  accounts: KnowledgeSettingsAccounts;
  logger?: Pick<Console, "warn">;
}

/** The stored `settings` value, read field by field over the defaults. */
export function knowledgeSettingsFrom(stored: unknown): KnowledgeSettings {
  const fields = storedKnowledgeSettings(pluginStateOf({ ...createDefaultPluginsConfig(), plugins: { k: { settings: stored } } }, "k"));
  const concurrency =
    fields.concurrency !== undefined && fields.concurrency >= KNOWLEDGE_CONCURRENCY_MIN && fields.concurrency <= KNOWLEDGE_CONCURRENCY_MAX
      ? fields.concurrency
      : KNOWLEDGE_DEFAULT_SETTINGS.concurrency;
  return {
    accountId: fields.accountId !== undefined ? fields.accountId : KNOWLEDGE_DEFAULT_SETTINGS.accountId,
    model: fields.model !== undefined ? fields.model : KNOWLEDGE_DEFAULT_SETTINGS.model,
    concurrency
  };
}

export class KnowledgeSettingsService implements KnowledgeSettingsPort {
  private readonly listeners = new Set<() => void>();
  private snapshot: string;
  private readonly onPlugins = (): void => this.publishIfChanged();

  constructor(private readonly options: KnowledgeSettingsServiceOptions) {
    this.snapshot = this.key();
    options.plugins.events.on("changed", this.onPlugins);
  }

  /** Stop following the plugins service. */
  dispose(): void {
    this.options.plugins.events.off("changed", this.onPlugins);
    this.listeners.clear();
  }

  enabled(): boolean {
    return this.options.plugins.isEnabled(KNOWLEDGE_GRAPH_PLUGIN_ID);
  }

  get(): KnowledgeSettings {
    return knowledgeSettingsFrom(this.options.plugins.pluginSettings(KNOWLEDGE_GRAPH_PLUGIN_ID));
  }

  /** Called when the plugin is turned on or off, or its settings change. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Validate and store a partial update; fields absent from `body` keep their
   * value, and keys this build does not know are ignored. Resolves the settings
   * as stored. Throws {@link KnowledgeSettingsError} `KNOWLEDGE_INVALID` (400).
   */
  async update(body: unknown): Promise<KnowledgeSettings> {
    const patch = this.validate(body);
    if (Object.keys(patch).length > 0) {
      await this.options.plugins.updatePluginSettings(KNOWLEDGE_GRAPH_PLUGIN_ID, patch as Record<string, unknown>);
      this.publishIfChanged();
    }
    return this.get();
  }

  private validate(body: unknown): UpdateKnowledgeSettingsRequest {
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      throw invalid("Send a JSON object with accountId, model and/or concurrency.");
    }
    const input = body as Record<string, unknown>;
    const patch: UpdateKnowledgeSettingsRequest = {};
    if ("accountId" in input && input.accountId !== undefined) {
      const { accountId } = input;
      if (accountId === null) {
        patch.accountId = null;
      } else if (typeof accountId !== "string" || accountId.trim() === "") {
        throw invalid("`accountId` must be null (automatic) or a Claude account id.");
      } else {
        const record = this.options.accounts.getRecord(accountId);
        if (!record) throw invalid(`There is no agent account "${accountId.slice(0, 100)}".`);
        if (record.agent !== "claude") throw invalid("The indexing account must be a Claude account.");
        patch.accountId = accountId;
      }
    }
    if ("model" in input && input.model !== undefined) {
      const { model } = input;
      if (model === null) {
        patch.model = null;
      } else if (typeof model !== "string" || model.trim() === "") {
        throw invalid("`model` must be null (the default) or a model name.");
      } else if (model.trim().length > KNOWLEDGE_MODEL_MAX) {
        throw invalid(`\`model\` is longer than ${KNOWLEDGE_MODEL_MAX} characters.`);
      } else {
        patch.model = model.trim();
      }
    }
    if ("concurrency" in input && input.concurrency !== undefined) {
      const { concurrency } = input;
      if (
        typeof concurrency !== "number" ||
        !Number.isInteger(concurrency) ||
        concurrency < KNOWLEDGE_CONCURRENCY_MIN ||
        concurrency > KNOWLEDGE_CONCURRENCY_MAX
      ) {
        throw invalid(`\`concurrency\` must be a whole number from ${KNOWLEDGE_CONCURRENCY_MIN} to ${KNOWLEDGE_CONCURRENCY_MAX}.`);
      }
      patch.concurrency = concurrency;
    }
    return patch;
  }

  private key(): string {
    return JSON.stringify([this.enabled(), this.get()]);
  }

  private publishIfChanged(): void {
    const next = this.key();
    if (next === this.snapshot) return;
    this.snapshot = next;
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch (error) {
        (this.options.logger ?? console).warn("knowledge: a settings listener failed", error);
      }
    }
  }
}

function invalid(message: string): KnowledgeSettingsError {
  return new KnowledgeSettingsError(400, "KNOWLEDGE_INVALID", message);
}
