// The "Model prices" editor's form model: rows drafted from the daemon's saved overrides and
// "map to" aliases, the keystroke filter and parser for rate cells, per-row validation, and the
// minimal `PUT /api/usage/prices` patch (spec §4.1, §4.4, §6.2 "Price editor").

import type { UsageBuiltinPrice, UsageModelRates, UsagePriceModelInfo, UsagePricesPatch, UsagePricesResponse } from "@orquester/api";

export const RATE_FIELDS = ["input", "output", "cacheRead", "cacheWrite5m", "cacheWrite1h"] as const;
export type RateField = (typeof RATE_FIELDS)[number];
export type RateTexts = Record<RateField, string>;

/** The daemon rejects longer ids (§4.4). */
const MAX_MODEL_ID = 200;

/** One row of the editor: a saved override or mapping, or one the user is adding. */
export interface PriceRow {
  /** Stable React key: the model id for a saved row, a counter for a new one. */
  key: string;
  model: string;
  /** False for a row drafted from the saved config (its model id is fixed). */
  isNew: boolean;
  /** The "Map to" target; blank when the model is priced by its own rates. */
  mapTo: string;
  rates: RateTexts;
  /** A saved row marked "Reset to automatic": its override and mapping are removed on save. */
  reset: boolean;
}

type SavedPrices = Pick<UsagePricesResponse, "overrides" | "aliases">;

/** A keystroke's resulting text is allowed: digits with at most one `.` or `,` decimal separator. */
export function isRateEdit(text: string): boolean {
  return /^\d*(?:[.,]\d*)?$/.test(text);
}

/** A rate cell's value: blank, a finite non-negative number (`,` read as `.`), or invalid. */
function parseRate(text: string): number | "blank" | "invalid" {
  const trimmed = text.trim().replace(",", ".");
  if (trimmed === "") return "blank";
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(trimmed)) return "invalid";
  const value = Number(trimmed);
  return Number.isFinite(value) && value >= 0 ? value : "invalid";
}

/** A saved rate as cell text, never in exponent form (so it passes {@link isRateEdit}). */
function formatRate(value: number | undefined): string {
  if (value === undefined) return "";
  return value.toLocaleString("en-US", { useGrouping: false, maximumFractionDigits: 20 });
}

function emptyRates(): RateTexts {
  return { input: "", output: "", cacheRead: "", cacheWrite5m: "", cacheWrite1h: "" };
}

function ratesText(rates: UsageModelRates | undefined): RateTexts {
  const out = emptyRates();
  if (!rates) return out;
  for (const field of RATE_FIELDS) out[field] = formatRate(rates[field]);
  return out;
}

/** The saved overrides and mappings as rows, one per model, by model id. */
export function draftFromPrices(saved: SavedPrices): PriceRow[] {
  const models = [...new Set([...Object.keys(saved.overrides), ...Object.keys(saved.aliases)])].sort((a, b) =>
    a.localeCompare(b)
  );
  return models.map((model) => ({
    key: `saved:${model}`,
    model,
    isNew: false,
    mapTo: saved.aliases[model] ?? "",
    rates: ratesText(saved.overrides[model]),
    reset: false
  }));
}

let newRowSeq = 0;

export function newPriceRow(model = ""): PriceRow {
  newRowSeq += 1;
  return { key: `new:${newRowSeq}`, model, isNew: true, mapTo: "", rates: emptyRates(), reset: false };
}

/**
 * What may follow `<key>-` for an id to still be that key: dash-separated version and date
 * tokens only — all-digit tokens (so `20260115` and `2025-09-29`) and release tags. Anything
 * else names another model (`gpt-5-mini`, `o3-pro`, `gemini-2.5-flash-lite`), which the
 * daemon does not price as its prefix.
 */
const VERSION_SUFFIX = /^(?:\d+|preview|latest|exp|experimental|beta|reasoning|non-reasoning)(?:-(?:\d+|preview|latest|exp|experimental|beta|reasoning|non-reasoning))*$/;

/**
 * The built-in rates the daemon would price `model` at, resolved as it does: drop a trailing
 * `[…]` tag and lowercase, then the exact key, else the longest key the id starts with followed
 * by `-` and only version/date tokens ({@link VERSION_SUFFIX}); a provider-qualified id
 * (`anthropic/…`) retries on its last segment.
 */
export function builtinRatesFor(model: string, builtin: readonly UsageBuiltinPrice[]): UsageModelRates | null {
  const byKey = new Map(builtin.map((entry) => [entry.model.toLowerCase(), entry.rates]));
  const lookup = (id: string): UsageModelRates | null => {
    if (!id) return null;
    const exact = byKey.get(id);
    if (exact) return exact;
    let best: string | null = null;
    for (const key of byKey.keys()) {
      if (!id.startsWith(`${key}-`) || !VERSION_SUFFIX.test(id.slice(key.length + 1))) continue;
      if (best === null || key.length > best.length) best = key;
    }
    return best === null ? null : (byKey.get(best) ?? null);
  };
  const id = model.trim().replace(/\[[^\]]*\]$/, "").toLowerCase();
  const slash = id.lastIndexOf("/");
  return lookup(id) ?? (slash >= 0 ? lookup(id.slice(slash + 1)) : null);
}

/**
 * What a blank rate cell means: the built-in rate when the model has one; otherwise an override's
 * cache reads and 5m writes fall back to its input rate and 1h writes to its 5m rate, and its
 * input and output have no automatic price.
 */
export function ratePlaceholder(field: RateField, builtin: UsageModelRates | null): string {
  const shown = (rate: number) =>
    rate.toLocaleString("en-US", { useGrouping: false, minimumFractionDigits: 2, maximumFractionDigits: 20 });
  const rate = builtin?.[field];
  if (rate !== undefined) return shown(rate);
  if (field === "cacheWrite1h") return builtin?.cacheWrite5m !== undefined ? shown(builtin.cacheWrite5m) : "= 5m";
  if (field === "cacheRead" || field === "cacheWrite5m") return "= input";
  return "Automatic";
}

/** Seen models with no price, not already in the editor: the "No price: …" suggestions. */
export function unpricedSuggestions(
  seen: readonly UsagePriceModelInfo[],
  rows: readonly PriceRow[],
  limit = 5
): UsagePriceModelInfo[] {
  const taken = new Set(rows.map((row) => row.model.trim()));
  const out: UsagePriceModelInfo[] = [];
  for (const info of seen) {
    if (info.status !== "unpriced" || taken.has(info.model)) continue;
    taken.add(info.model);
    out.push(info);
    if (out.length >= limit) break;
  }
  return out;
}

export interface RowError {
  message: string;
  /** The error is a required field left blank: shown only once the user tried to save. */
  missing: boolean;
}

export interface PriceDraftResult {
  /** Per row key; a row with no entry is valid. */
  errors: Record<string, RowError>;
  /** Only the models whose saved value changes; empty when nothing changed. */
  patch: UsagePricesPatch;
  changed: boolean;
}

/** What one row asks the daemon to hold for its model (undefined: nothing). */
interface RowTarget {
  model: string;
  alias: string | undefined;
  override: UsageModelRates | undefined;
}

function sameRates(a: UsageModelRates | undefined, b: UsageModelRates | undefined): boolean {
  if (!a || !b) return a === b;
  return RATE_FIELDS.every((field) => a[field] === b[field]);
}

function hasCycleThrough(start: string, aliases: Record<string, string>): boolean {
  const seen = new Set<string>([start]);
  let current = aliases[start];
  while (current !== undefined) {
    if (current === start) return true;
    if (seen.has(current)) return false;
    seen.add(current);
    current = aliases[current];
  }
  return false;
}

/**
 * Validate the rows against the saved prices and build the minimal patch: a row whose values equal
 * the saved ones sends nothing, a reset row sends `null` for what it held. A mapped row sends its
 * mapping and leaves any saved override alone (its rates are not shown and do not apply). The
 * cycle check runs on the alias graph the daemon would hold after the patch.
 */
export function priceDraftResult(rows: readonly PriceRow[], saved: SavedPrices): PriceDraftResult {
  const errors: Record<string, RowError> = {};
  const fail = (row: PriceRow, message: string, missing = false) => {
    if (!errors[row.key]) errors[row.key] = { message, missing };
  };
  const owners = new Map<string, string>();
  const targets: { row: PriceRow; target: RowTarget }[] = [];

  // Saved rows own their model ids, so a new row naming one is the duplicate wherever it sits.
  for (const row of [...rows.filter((r) => !r.isNew), ...rows.filter((r) => r.isNew)]) {
    const model = row.model.trim();
    if (model === "") {
      fail(row, "Enter a model ID.", true);
      continue;
    }
    if (model.length > MAX_MODEL_ID) {
      fail(row, `Use a model ID of at most ${MAX_MODEL_ID} characters.`);
      continue;
    }
    if (owners.has(model)) {
      // A saved row, else the earlier new row, keeps the model; this one is the duplicate.
      fail(row, "This model already has a row.");
      continue;
    }
    owners.set(model, row.key);
    if (row.reset) {
      targets.push({ row, target: { model, alias: undefined, override: undefined } });
      continue;
    }
    const mapTo = row.mapTo.trim();
    if (mapTo !== "") {
      if (mapTo === model) fail(row, "Map to a different model.");
      targets.push({ row, target: { model, alias: mapTo, override: saved.overrides[model] } });
      continue;
    }
    const parsed: Partial<Record<RateField, number | "blank" | "invalid">> = {};
    for (const field of RATE_FIELDS) parsed[field] = parseRate(row.rates[field]);
    if (RATE_FIELDS.some((field) => parsed[field] === "invalid")) {
      fail(row, "Use non-negative numbers for prices.");
      continue;
    }
    if (parsed.input === "blank" || parsed.output === "blank") {
      fail(row, "Enter Input and Output prices, or map it to another model.", true);
      continue;
    }
    const override: UsageModelRates = { input: parsed.input as number, output: parsed.output as number };
    for (const field of ["cacheRead", "cacheWrite5m", "cacheWrite1h"] as const) {
      const value = parsed[field];
      if (typeof value === "number") override[field] = value;
    }
    targets.push({ row, target: { model, alias: undefined, override } });
  }

  const overrides: Record<string, UsageModelRates | null> = {};
  const aliases: Record<string, string | null> = {};
  const finalAliases: Record<string, string> = { ...saved.aliases };
  for (const { target } of targets) {
    const savedOverride = saved.overrides[target.model];
    if (!sameRates(savedOverride, target.override)) overrides[target.model] = target.override ?? null;
    const savedAlias = saved.aliases[target.model];
    if (savedAlias !== target.alias) aliases[target.model] = target.alias ?? null;
    if (target.alias === undefined) delete finalAliases[target.model];
    else finalAliases[target.model] = target.alias;
  }
  for (const { row, target } of targets) {
    if (target.alias !== undefined && target.alias !== target.model && hasCycleThrough(target.model, finalAliases)) {
      fail(row, "Mappings can't form a cycle.");
    }
  }

  const patch: UsagePricesPatch = {};
  if (Object.keys(overrides).length > 0) patch.overrides = overrides;
  if (Object.keys(aliases).length > 0) patch.aliases = aliases;
  return { errors, patch, changed: patch.overrides !== undefined || patch.aliases !== undefined };
}
