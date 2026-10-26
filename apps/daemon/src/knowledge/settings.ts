/**
 * The Knowledge Graph plugin's settings ({@link KnowledgeSettings}: the
 * indexing account policy, model and concurrency), stored on the plugin's
 * plugins.json record as `settings` through `PluginsService` (its file queue,
 * its broadcast), and {@link KnowledgeSettingsPort} over it.
 *
 * Reads are tolerant (a field of the wrong type or out of range reads as its
 * default, the policy field by field; other keys in the object, including
 * another build's, are kept on write); writes are validated: concurrency within
 * KNOWLEDGE_CONCURRENCY_MIN..MAX, `accountPolicy` by the workflow policy schema
 * with no listed account another agent's (an id no account has is kept, as a
 * workflow keeps it, and the selector skips it), `model` null or a non-empty
 * string.
 *
 * Older builds read only `accountId`. A policy is therefore stored with the
 * `accountId` that approximates it for them ({@link knowledgeLegacyAccountId}:
 * a fixed order's first account, else null = automatic), and a legacy
 * `accountId` update (an older client) drops the stored policy so the record
 * means what that client chose.
 *
 * A reader tells that an older build changed the account by the stored pair no
 * longer matching. After a downgrade, an older build that rewrites `accountId`
 * twice and back to the first value (A→B→A) makes the pair match again, so the
 * earlier policy comes back; this cannot be detected, since older builds keep
 * the keys they do not know.
 */
import type { EventEmitter } from "node:events";
import {
  KNOWLEDGE_CONCURRENCY_MAX,
  KNOWLEDGE_CONCURRENCY_MIN,
  KNOWLEDGE_DEFAULT_SETTINGS,
  KNOWLEDGE_GRAPH_PLUGIN_ID,
  SYSTEM_ACCOUNT_ID,
  knowledgeLegacyAccountId,
  knowledgeLegacyAccountPolicy,
  type KnowledgeErrorCode,
  type KnowledgeSettings
} from "@orquester/api";
import { accountPolicySchema, createDefaultPluginsConfig, pluginStateOf, storedKnowledgeSettings, type AccountPolicy } from "@orquester/config";
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

/** What the settings need from `AgentAccountsService`: the managed accounts, in their order. */
export interface KnowledgeSettingsAccounts {
  list(): { accounts: readonly { id: string; agent: string }[] };
}

export interface KnowledgeSettingsServiceOptions {
  plugins: KnowledgeSettingsPlugins;
  accounts: KnowledgeSettingsAccounts;
  logger?: Pick<Console, "warn">;
}

/**
 * The stored `settings` value, read field by field over the defaults. `claudeAccountIds` (the
 * host's Claude accounts, in their order) is what a legacy `accountId` means as a policy.
 *
 * The policy is the stored `accountPolicy`, unless the record carries none, or its `accountId` is
 * no longer the one this build writes beside the policy ({@link knowledgeLegacyAccountId}): then a
 * build that predates policies (whose only account setting is `accountId`) chose the account after
 * the policy was saved, and that later choice wins. Either way the legacy `accountId` maps exactly
 * to what that build runs ({@link knowledgeLegacyAccountPolicy}).
 */
export function knowledgeSettingsFrom(stored: unknown, claudeAccountIds: readonly string[]): KnowledgeSettings {
  const fields = storedKnowledgeSettings(pluginStateOf({ ...createDefaultPluginsConfig(), plugins: { k: { settings: stored } } }, "k"));
  const concurrency =
    fields.concurrency !== undefined && fields.concurrency >= KNOWLEDGE_CONCURRENCY_MIN && fields.concurrency <= KNOWLEDGE_CONCURRENCY_MAX
      ? fields.concurrency
      : KNOWLEDGE_DEFAULT_SETTINGS.concurrency;
  const stale = fields.accountPolicy !== undefined && fields.accountId !== undefined && fields.accountId !== knowledgeLegacyAccountId(fields.accountPolicy);
  const accountPolicy =
    fields.accountPolicy !== undefined && !stale ? fields.accountPolicy : knowledgeLegacyAccountPolicy(fields.accountId ?? null, claudeAccountIds);
  return {
    accountPolicy,
    accountId: knowledgeLegacyAccountId(accountPolicy),
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
    return knowledgeSettingsFrom(this.options.plugins.pluginSettings(KNOWLEDGE_GRAPH_PLUGIN_ID), this.claudeAccountIds());
  }

  private claudeAccountIds(): string[] {
    return this.options.accounts
      .list()
      .accounts.filter((account) => account.agent === "claude")
      .map((account) => account.id);
  }

  /** Called when the plugin is turned on or off, or its settings change. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Validate and store a partial update; fields absent from `body` keep their
   * value, and keys this build does not know are ignored. Resolves the settings
   * as stored. Throws {@link KnowledgeSettingsError} (400): `KNOWLEDGE_INVALID`,
   * or `KNOWLEDGE_UNKNOWN_ACCOUNT` for a policy account of another agent, or a
   * legacy `accountId` that is no Claude account.
   */
  async update(body: unknown): Promise<KnowledgeSettings> {
    const patch = this.validate(body);
    if (Object.keys(patch).length > 0) {
      await this.options.plugins.updatePluginSettings(KNOWLEDGE_GRAPH_PLUGIN_ID, patch);
      this.publishIfChanged();
    }
    return this.get();
  }

  /** The stored-settings patch (a key set to undefined is removed from the record). */
  private validate(body: unknown): Record<string, unknown> {
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      throw invalid("Send a JSON object with accountPolicy, model and/or concurrency.");
    }
    const input = body as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    if ("accountPolicy" in input && input.accountPolicy !== undefined) {
      const policy = this.validatePolicy(input.accountPolicy);
      patch.accountPolicy = policy;
      // What a build that predates policies runs instead (see the module comment).
      patch.accountId = knowledgeLegacyAccountId(policy);
    } else if ("accountId" in input && input.accountId !== undefined) {
      // An older client's single account: stored alone, so the record means what it chose.
      const { accountId } = input;
      if (accountId !== null && (typeof accountId !== "string" || accountId.trim() === "")) {
        throw invalid("`accountId` must be null (automatic) or a Claude account id.");
      }
      if (typeof accountId === "string") this.checkAccount(accountId);
      patch.accountId = accountId;
      patch.accountPolicy = undefined;
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

  /**
   * The workflow Agent block's policy schema (its defaults filled, unknown keys kept), each listed
   * account once. As in a workflow, an id no account has is accepted (the selector skips it at run
   * time); only another agent's account is refused.
   */
  private validatePolicy(value: unknown): AccountPolicy {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw invalid("`accountPolicy` must be an account policy object.");
    }
    const parsed = accountPolicySchema.safeParse(value);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const where = issue && issue.path.length > 0 ? `.${issue.path.join(".")}` : "";
      throw invalid(`\`accountPolicy${where}\`: ${issue?.message ?? "is not an account policy"}.`);
    }
    const policy = parsed.data;
    if (policy.accounts === undefined) return policy;
    const accounts = [...new Set(policy.accounts)];
    for (const id of accounts) if (id !== SYSTEM_ACCOUNT_ID) this.checkAccount(id, { allowUnknown: true });
    return { ...policy, accounts };
  }

  /**
   * Throws `KNOWLEDGE_UNKNOWN_ACCOUNT` when `id` is another agent's account, or no account's unless
   * `allowUnknown`.
   */
  private checkAccount(id: string, { allowUnknown = false } = {}): void {
    const account = this.options.accounts.list().accounts.find((candidate) => candidate.id === id);
    const shown = JSON.stringify(id.slice(0, 100));
    if (!account) {
      if (allowUnknown) return;
      throw unknownAccount(`There is no agent account ${shown}.`);
    }
    if (account.agent !== "claude") throw unknownAccount(`The account ${shown} is a ${account.agent} account; indexing runs on Claude accounts.`);
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

function unknownAccount(message: string): KnowledgeSettingsError {
  return new KnowledgeSettingsError(400, "KNOWLEDGE_UNKNOWN_ACCOUNT", message);
}
