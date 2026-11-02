// API-equivalent prices for usage estimates: the built-in table plus the user's overrides and
// "map to" aliases (`daemon/usage-pricing.json`). Subscription users don't pay per token, so every
// figure priced here is labelled an estimate. Spec: docs/superpowers/specs/2026-11-02-usage-panel-design.md §4.1.
//
// Prices apply at aggregation time, never at scan time: a changed price reprices all history
// without rereading a transcript. `usagePricingRevision()` tells the scanners when to.

import type { UsageBuiltinPrice, UsageCostParts, UsageModelRates, UsageSpeed } from "@orquester/api";

interface BuiltinEntry extends UsageModelRates {
  fast?: UsageModelRates;
  ultrafast?: UsageModelRates;
}

/** Every rate times `k` (Anthropic's fast mode bills 2x across the board). */
function scaled(rates: UsageModelRates, k: number): UsageModelRates {
  const out: UsageModelRates = { input: rates.input * k, output: rates.output * k };
  if (rates.cacheRead !== undefined) out.cacheRead = rates.cacheRead * k;
  if (rates.cacheWrite5m !== undefined) out.cacheWrite5m = rates.cacheWrite5m * k;
  if (rates.cacheWrite1h !== undefined) out.cacheWrite1h = rates.cacheWrite1h * k;
  return out;
}

const OPUS_5_5: UsageModelRates = { input: 4, output: 20, cacheRead: 0.2, cacheWrite5m: 5, cacheWrite1h: 8 };
const OPUS_5: UsageModelRates = { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 };
const GPT_5: UsageModelRates = { input: 1.25, output: 10, cacheRead: 0.125 };
const GPT_5_2: UsageModelRates = { input: 1.75, output: 14, cacheRead: 0.175 };
const GROK_4_20: UsageModelRates = { input: 1.25, output: 2.5, cacheRead: 0.2 };

// USD per 1,000,000 tokens. Update when models ship. The entries that predate the Usage view keep
// their values (tests pin them); the rest come from LiteLLM's public table (snapshot 2026-11-02).
// cacheWrite5m/1h: prompt-cache writes by TTL. A missing cacheWrite5m bills writes at the input rate.
const BUILTIN: Record<string, BuiltinEntry> = {
  "claude-fable-5": { input: 10, output: 50, cacheRead: 1, cacheWrite5m: 12.5, cacheWrite1h: 20 },
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25, cacheWrite5m: 12.5, cacheWrite1h: 20 },
  "claude-mythos-5": { input: 10, output: 50, cacheRead: 1, cacheWrite5m: 12.5, cacheWrite1h: 20 },
  "claude-mythos-5-1": { input: 10, output: 50, cacheRead: 0.25, cacheWrite5m: 12.5, cacheWrite1h: 20 },
  "claude-opus-5": { ...OPUS_5, fast: scaled(OPUS_5, 2) },
  // Derived from the CLI's own charges (claude fixtures 17, 18, 19: per-turn costUSD over the frames' token counts).
  "claude-opus-5-5": { ...OPUS_5_5, fast: scaled(OPUS_5_5, 2) },
  "claude-opus-4-8": { ...OPUS_5, fast: scaled(OPUS_5, 2) },
  "claude-opus-4-7": { ...OPUS_5 },
  "claude-opus-4-6": { ...OPUS_5 },
  "claude-opus-4-5": { ...OPUS_5 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.1, cacheWrite5m: 2.5, cacheWrite1h: 4 },
  "claude-sonnet-5": { input: 3, output: 15, cacheRead: 0.3, cacheWrite5m: 3.75, cacheWrite1h: 6 },
  "claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.3, cacheWrite5m: 3.75, cacheWrite1h: 6 },
  "claude-sonnet-4-5": { input: 3, output: 15, cacheRead: 0.3, cacheWrite5m: 3.75, cacheWrite1h: 6 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite5m: 0.125, cacheWrite1h: 0.2 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1, cacheWrite5m: 1.25, cacheWrite1h: 2 },
  "gpt-6-astra": {
    input: 10, output: 50, cacheRead: 1, cacheWrite5m: 12.5,
    fast: { input: 20, output: 100, cacheRead: 2, cacheWrite5m: 25 },
    ultrafast: { input: 60, output: 300, cacheRead: 6, cacheWrite5m: 75 }
  },
  "gpt-6-rosalind": { input: 15, output: 75, cacheRead: 1.5, cacheWrite5m: 18.75 },
  "gpt-6-sol": { input: 2, output: 10, cacheRead: 0.2, cacheWrite5m: 2.5, fast: { input: 4, output: 20, cacheRead: 0.4, cacheWrite5m: 5 } },
  "gpt-6.1-sol": {
    input: 2, output: 10, cacheRead: 0.1, cacheWrite5m: 2.5,
    fast: { input: 4, output: 20, cacheRead: 0.2, cacheWrite5m: 5 },
    ultrafast: { input: 12, output: 60, cacheRead: 0.6, cacheWrite5m: 15 }
  },
  "gpt-6.1-terra": { input: 1, output: 5, cacheRead: 0.05, cacheWrite5m: 1.25, fast: { input: 2, output: 10, cacheRead: 0.1, cacheWrite5m: 2.5 } },
  "gpt-6-luna": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite5m: 0.125, fast: { input: 0.2, output: 1, cacheRead: 0.02, cacheWrite5m: 0.25 } },
  "gpt-5.6-sol": { input: 5, output: 30, cacheRead: 0.5 },
  "gpt-5.6-terra": { input: 2.5, output: 15, cacheRead: 0.25 },
  "gpt-5.6-luna": { input: 1, output: 6, cacheRead: 0.1 },
  "gpt-5.5": { input: 5, output: 30, cacheRead: 0.5, fast: { input: 12.5, output: 75, cacheRead: 1.25 } },
  "gpt-5.4": { input: 2.5, output: 15, cacheRead: 0.25, fast: { input: 5, output: 30, cacheRead: 0.5 } },
  "gpt-5.4-mini": { input: 0.75, output: 4.5, cacheRead: 0.075 },
  "gpt-5.4-codex": { ...GPT_5 },
  "gpt-5.3-codex": { ...GPT_5_2 },
  "gpt-5.2": { ...GPT_5_2 },
  "gpt-5.2-codex": { ...GPT_5_2 },
  "gpt-5.1-codex": { ...GPT_5 },
  "gpt-5.1-codex-max": { ...GPT_5 },
  "gpt-5.1-codex-mini": { input: 0.25, output: 2, cacheRead: 0.025 },
  "gpt-5": { ...GPT_5 },
  "gpt-5-codex": { ...GPT_5 },
  "o3": { input: 2, output: 8, cacheRead: 0.5 },
  "o4-mini": { input: 1.1, output: 4.4, cacheRead: 0.275 },
  "gemini-3.1-pro-preview": { input: 2, output: 12, cacheRead: 0.2 },
  "gemini-3-flash-preview": { input: 0.5, output: 3, cacheRead: 0.05 },
  "gemini-2.5-pro": { input: 1.25, output: 10, cacheRead: 0.125 },
  "gemini-2.5-flash": { input: 0.3, output: 2.5, cacheRead: 0.03 },
  "grok-build": { input: 2, output: 6, cacheRead: 0.3 },
  "grok-4.7": { input: 2, output: 6, cacheRead: 0.5 },
  "grok-4.6": { input: 2, output: 6, cacheRead: 0.5 },
  "grok-4.5": { input: 2, output: 6, cacheRead: 0.3 },
  "grok-4.3": { ...GROK_4_20 },
  "grok-4.20": { ...GROK_4_20 }
};

/** Picker slugs that name a family, not a model: which generation ran is unknown. */
const AMBIGUOUS = new Set(["opus", "sonnet", "haiku", "fable", "default", "<synthetic>", "synthetic", "unknown"]);

function withoutContextTag(model: string): string {
  return model.replace(/\[[^\]]*\]$/, "");
}

/**
 * What may follow a key and its `-` and still be the same model: dash-separated date and version
 * stamps (`20260115`, `2025-09-29`, `0309`) and release labels. A name part (`mini`, `nano`, `pro`,
 * `lite`, `codex-mini`) is another model with other prices, so it never matches.
 */
const VERSION_SUFFIX = /^(?:\d+|preview|latest|exp|experimental|beta|reasoning|non-reasoning)(?:-(?:\d+|preview|latest|exp|experimental|beta|reasoning|non-reasoning))*$/;

function lookupKey(model: string): string | null {
  if (!model || AMBIGUOUS.has(model)) return null;
  if (BUILTIN[model]) return model;
  let best: string | null = null;
  for (const key of Object.keys(BUILTIN)) {
    if (best && key.length <= best.length) continue;
    if (model.startsWith(key + "-") && VERSION_SUFFIX.test(model.slice(key.length + 1))) best = key;
  }
  return best;
}

/**
 * The built-in table key a raw model id resolves to, or null. Transcripts record versioned ids
 * (`claude-opus-4-8-20260115`) that never equal the bare keys: after the exact key, the longest key
 * the id starts with (followed by `-` and only version stamps, see {@link VERSION_SUFFIX}) wins,
 * which absorbs date and `-preview` suffixes but never prices `gpt-5-mini` as `gpt-5`. A trailing
 * context tag (`claude-opus-4-8[1m]`, the CLI's 1M-context variant) bills at the model's standard
 * rates (claude fixture 01). A provider-qualified id (`anthropic/claude-sonnet-4-5`) falls back to
 * its last segment.
 */
export function resolvePricingKey(raw: string): string | null {
  const model = withoutContextTag(raw.trim()).toLowerCase();
  const direct = lookupKey(model);
  if (direct) return direct;
  const slash = model.lastIndexOf("/");
  return slash >= 0 ? lookupKey(model.slice(slash + 1)) : null;
}

// --- the user's prices --------------------------------------------------------

export interface UsagePricingConfig {
  overrides: Record<string, UsageModelRates>;
  aliases: Record<string, string>;
}

let config: UsagePricingConfig = { overrides: {}, aliases: {} };
let revision = 0;

/** Install the user's prices; every later estimate uses them. */
export function setUsagePricingConfig(next: UsagePricingConfig): void {
  config = { overrides: { ...next.overrides }, aliases: { ...next.aliases } };
  revision += 1;
}

export function usagePricingConfig(): UsagePricingConfig {
  return { overrides: { ...config.overrides }, aliases: { ...config.aliases } };
}

/** Bumped on every {@link setUsagePricingConfig}: cached cost aggregates older than it are stale. */
export function usagePricingRevision(): number {
  return revision;
}

/**
 * The model a raw id is counted as after the user's "map to" aliases (chains followed). A chain
 * that runs into a cycle is ignored as a whole: the id stays itself.
 */
export function canonicalModel(model: string, aliases: Record<string, string> = config.aliases): string {
  const start = model.trim();
  let current = start;
  const seen = new Set<string>([current]);
  for (;;) {
    const next = aliases[current];
    if (next === undefined) return current;
    if (seen.has(next)) return start;
    seen.add(next);
    current = next;
  }
}

/** True when the aliases (as a graph) contain a cycle. */
export function aliasesHaveCycle(aliases: Record<string, string>): boolean {
  for (const from of Object.keys(aliases)) {
    const seen = new Set<string>([from]);
    let current = aliases[from];
    while (current !== undefined) {
      if (seen.has(current)) return true;
      seen.add(current);
      current = aliases[current];
    }
  }
  return false;
}

/** The user's override for a model: exact trimmed id, then the id without a context tag or date suffix. */
export function overrideFor(model: string): UsageModelRates | null {
  const id = model.trim();
  const exact = config.overrides[id];
  if (exact) return exact;
  const normalized = withoutContextTag(id).replace(/-\d{8}$/, "");
  return config.overrides[normalized] ?? null;
}

/** Fully resolved per-1M rates (no optional fields). */
interface Rates {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

/** Omitted cache rates: reads and writes at the input rate, 1h writes at the 5m rate. */
function complete(rates: UsageModelRates): Rates {
  const cacheWrite5m = rates.cacheWrite5m ?? rates.input;
  return {
    input: rates.input,
    output: rates.output,
    cacheRead: rates.cacheRead ?? rates.input,
    cacheWrite5m,
    cacheWrite1h: rates.cacheWrite1h ?? cacheWrite5m
  };
}

/**
 * The per-1M rates for a model (already aliased) at a speed tier, or null when it has no price.
 * An override's omitted cache rates inherit the built-in rate of the same model, else fall back
 * as {@link complete} does; overrides have no speed tiers.
 */
export function ratesFor(model: string, speed: UsageSpeed = "standard"): { rates: Rates; source: "override" | "builtin" } | null {
  const key = resolvePricingKey(model);
  const builtin = key ? BUILTIN[key] : undefined;
  const override = overrideFor(model);
  if (override) {
    return {
      rates: complete({
        ...override,
        cacheRead: override.cacheRead ?? builtin?.cacheRead,
        cacheWrite5m: override.cacheWrite5m ?? builtin?.cacheWrite5m,
        cacheWrite1h: override.cacheWrite1h ?? builtin?.cacheWrite1h
      }),
      source: "override"
    };
  }
  if (!builtin) return null;
  const tier = speed === "standard" ? builtin : (builtin[speed] ?? builtin);
  return { rates: complete(tier), source: "builtin" };
}

export interface SliceTokens {
  /** Uncached input. */
  input: number;
  cacheRead: number;
  /** Total cache writes, `cacheWrite1h` included. */
  cacheWrite: number;
  cacheWrite1h: number;
  output: number;
}

export interface PricedSlice {
  costUsd: number;
  parts: UsageCostParts;
  /** cacheRead × (input rate − cache-read rate). */
  cacheSavingsUsd: number;
  rateSource: "override" | "builtin";
}

/** Price token sums of one model (after aliasing) at one speed tier; null when it has no price. */
export function priceSlice(model: string, speed: UsageSpeed, tokens: SliceTokens): PricedSlice | null {
  const found = ratesFor(model, speed);
  if (!found) return null;
  const r = found.rates;
  const per = (n: number, rate: number) => (n / 1_000_000) * rate;
  const write1h = Math.min(tokens.cacheWrite, tokens.cacheWrite1h);
  const write5m = tokens.cacheWrite - write1h;
  const parts: UsageCostParts = {
    input: per(tokens.input, r.input),
    cacheRead: per(tokens.cacheRead, r.cacheRead),
    cacheWrite: per(write5m, r.cacheWrite5m) + per(write1h, r.cacheWrite1h),
    output: per(tokens.output, r.output)
  };
  return {
    costUsd: parts.input + parts.cacheRead + parts.cacheWrite + parts.output,
    parts,
    cacheSavingsUsd: per(tokens.cacheRead, Math.max(0, r.input - r.cacheRead)),
    rateSource: found.source
  };
}

/**
 * The popover's and MCP's cost split for a raw model id (aliases and overrides applied), standard
 * tier. `cache` lumps reads and writes. Null for a model with no price.
 */
export function estimateCostParts(
  model: string,
  tok: { input: number; output: number; cacheRead: number; cacheWrite: number; cacheWrite1h: number }
): { input: number; output: number; cache: number } | null {
  const priced = priceSlice(canonicalModel(model), "standard", tok);
  if (!priced) return null;
  return { input: priced.parts.input, output: priced.parts.output, cache: priced.parts.cacheRead + priced.parts.cacheWrite };
}

/** The built-in table, for the price editor's placeholders. */
export function pricingTable(): UsageBuiltinPrice[] {
  return Object.entries(BUILTIN)
    .map(([model, entry]) => {
      const { fast, ultrafast, ...rates } = entry;
      const row: UsageBuiltinPrice = { model, rates };
      if (fast) row.fast = fast;
      if (ultrafast) row.ultrafast = ultrafast;
      return row;
    })
    .sort((a, b) => a.model.localeCompare(b.model));
}
