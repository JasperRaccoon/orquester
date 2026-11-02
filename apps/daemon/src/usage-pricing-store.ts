// The user's model prices on disk (`<appdir>/daemon/usage-pricing.json`, 0600): per-model rate
// overrides and "map to" aliases, installed into the pricing module at boot and on every edit.
// Spec: docs/superpowers/specs/2026-11-02-usage-panel-design.md §4.1 (persistence), §4.4 (PUT).
//
// Reading is tolerant: an invalid entry is left out of the prices on its own, and is written back
// untouched with unknown fields until an edit replaces it; a file that does not parse is moved
// aside (`<file>.corrupt-<ms>`) for the defaults.

import { readFile, rename } from "node:fs/promises";

import type { UsageModelRates, UsagePriceModelInfo, UsagePricesPatch, UsagePricesResponse } from "@orquester/api";
import {
  normalizeUsageModelId,
  parseUsagePricingFile,
  patchUsagePricingFile,
  serializeUsagePricingFile,
  USAGE_MODEL_ID_MAX,
  type UsagePricingFile
} from "@orquester/config";

import { writeFileAtomic } from "./agent-hooks.ts";
import { aliasesHaveCycle, pricingTable, setUsagePricingConfig, type UsagePricingConfig } from "./usage-pricing.ts";

/** A price edit the daemon refuses; `message` is shown to the user as is. */
export class UsagePricingValidationError extends Error {
  readonly code = "INVALID_REQUEST";
}

/** The prices file could not be read at boot: an edit would replace the user's prices, so none is saved. */
export class UsagePricingUnavailableError extends Error {
  readonly code = "UNAVAILABLE";
}

const RATE_FIELDS = ["input", "output", "cacheRead", "cacheWrite5m", "cacheWrite1h"] as const;

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

function modelId(raw: string): string {
  const id = normalizeUsageModelId(raw);
  if (id) return id;
  throw new UsagePricingValidationError(raw.trim() ? `Model IDs are at most ${USAGE_MODEL_ID_MAX} characters.` : "Enter a model ID.");
}

/**
 * One override of a patch. An omitted `input` or `output` keeps the model's saved one (an override
 * that is new needs both); omitted cache rates are automatic again.
 */
function overrideRates(model: string, value: unknown, saved: UsageModelRates | undefined): UsageModelRates {
  if (!isRecord(value)) throw new UsagePricingValidationError(`The price of ${model} must be an object of rates.`);
  const rates: Partial<UsageModelRates> = {};
  for (const field of RATE_FIELDS) {
    const rate = value[field];
    if (rate === undefined) continue;
    if (typeof rate !== "number" || !Number.isFinite(rate) || rate < 0) {
      throw new UsagePricingValidationError(`The ${field} price of ${model} must be a number of at least 0.`);
    }
    rates[field] = rate;
  }
  rates.input ??= saved?.input;
  rates.output ??= saved?.output;
  if (rates.input === undefined || rates.output === undefined) {
    throw new UsagePricingValidationError(`${model} needs an input and an output price.`);
  }
  return rates as UsageModelRates;
}

export class UsagePricingStore {
  private file: UsagePricingFile = parseUsagePricingFile({});
  /** The file could not be read (or a corrupt one moved aside): writing it would lose the user's prices. */
  private readOnly = false;
  private writes: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly opts: {
      path: string;
      now?: () => number;
      logger?: Pick<Console, "warn">;
    }
  ) {}

  /**
   * Read the file and install its prices. Never throws: a missing file is no prices yet; one that
   * can't be read (EACCES, EIO) is the defaults, and edits are refused until a restart reads it.
   */
  async load(): Promise<void> {
    let text: string | null = null;
    try {
      text = await readFile(this.opts.path, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        this.readOnly = true;
        this.opts.logger?.warn(`usage prices: could not read ${this.opts.path} (${code ?? String(error)}); using the built-in prices, and edits are not saved`);
      }
    }
    if (text !== null) {
      try {
        this.file = parseUsagePricingFile(JSON.parse(text));
      } catch {
        const aside = `${this.opts.path}.corrupt-${(this.opts.now ?? Date.now)()}`;
        try {
          await rename(this.opts.path, aside);
          this.opts.logger?.warn(`usage prices: ${this.opts.path} did not parse; moved aside to ${aside}`);
        } catch {
          this.readOnly = true;
          this.opts.logger?.warn(`usage prices: ${this.opts.path} did not parse and could not be moved aside; using the built-in prices, and edits are not saved`);
        }
      }
    }
    setUsagePricingConfig(this.config());
  }

  config(): UsagePricingConfig {
    return { overrides: { ...this.file.overrides }, aliases: { ...this.file.aliases } };
  }

  /**
   * Apply a patch (`null` removes an entry): validate the whole result, persist it, then install it,
   * so every later estimate is repriced. Throws {@link UsagePricingValidationError} and changes
   * nothing when the patch is invalid, {@link UsagePricingUnavailableError} when the file could not
   * be read at boot. Edits are applied one at a time.
   */
  update(patch: UsagePricesPatch): Promise<UsagePricingConfig> {
    const run = this.writes.then(() => this.apply(patch));
    this.writes = run.catch(() => undefined);
    return run;
  }

  /** The `GET/PUT /api/usage/prices` answer; `seenModels` come from the usage ledger. */
  response(seenModels: UsagePriceModelInfo[]): UsagePricesResponse {
    const { overrides, aliases } = this.config();
    return { currency: "USD", unit: "per_million_tokens", builtin: pricingTable(), overrides, aliases, seenModels };
  }

  private async apply(patch: unknown): Promise<UsagePricingConfig> {
    if (this.readOnly) {
      throw new UsagePricingUnavailableError("Prices can't be saved: the daemon could not read its prices file at start (see its log). Fix the file and restart the daemon.");
    }
    if (!isRecord(patch)) throw new UsagePricingValidationError("The body must be an object of overrides and aliases.");
    const overrides: Record<string, UsageModelRates | null> = {};
    const aliases: Record<string, string | null> = {};
    if (patch.overrides !== undefined) {
      if (!isRecord(patch.overrides)) throw new UsagePricingValidationError("overrides must be an object.");
      for (const [raw, value] of Object.entries(patch.overrides)) {
        const model = modelId(raw);
        const saved = overrides[model] === undefined ? this.file.overrides[model] : (overrides[model] ?? undefined);
        overrides[model] = value === null ? null : overrideRates(model, value, saved);
      }
    }
    if (patch.aliases !== undefined) {
      if (!isRecord(patch.aliases)) throw new UsagePricingValidationError("aliases must be an object.");
      for (const [raw, value] of Object.entries(patch.aliases)) {
        const model = modelId(raw);
        if (value === null) {
          aliases[model] = null;
          continue;
        }
        if (typeof value !== "string") throw new UsagePricingValidationError(`The mapping of ${model} must be a model ID.`);
        const target = modelId(value);
        if (target === model) throw new UsagePricingValidationError("Map to a different model.");
        aliases[model] = target;
      }
    }
    const next = patchUsagePricingFile(this.file, { overrides, aliases });
    if (aliasesHaveCycle(next.aliases)) throw new UsagePricingValidationError("Mappings can't form a cycle.");
    await writeFileAtomic(this.opts.path, `${JSON.stringify(serializeUsagePricingFile(next), null, 2)}\n`, 0o600, false);
    this.file = next;
    setUsagePricingConfig(this.config());
    return this.config();
  }
}
