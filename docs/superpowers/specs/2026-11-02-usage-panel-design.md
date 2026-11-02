# Usage panel: historical tokens, API-equivalent cost and limits

Status: approved for implementation (2026-11-02).
Reference: the t3code Usage page (`t3code_codebase/apps/web/src/components/usage/*`, `apps/server/src/usage/*`), studied for parity.

## 1. Goals

Orquester users run agents on subscriptions, so nobody sees what their agents would cost at API prices or how consumption trends over time. Today Orquester shows only a small top-bar popover: today's and the last 7 days' estimated cost, in UTC days, for Claude and Codex only, priced by an outdated table.

This feature adds a full **Usage** view that shows token consumption and an "API-equivalent" cost history:

- **G1 History:** token consumption and estimated cost over the past 24 hours or 7, 30 or 90 days, in the viewer's time zone.
- **G2 Breakdowns:** totals split by agent (Claude Code, Codex, Grok Build, OpenCode), by model, by day or hour, and by Orquester project. Each split shows distinct session counts and shares.
- **G3 Detail:** token types (uncached input, cache read, cache write, output, reasoning), cache savings, cost by type, cost by speed tier (fast / priority), cache hit rate and cost per 1M tokens. A per-model drill-down dialog shows a trend chart.
- **G4 Honest estimates:** every cost is labelled an API-equivalent estimate. Models without a known price show as "Unpriced", never as $0, and their share is disclosed. Provider-reported costs (Grok, OpenCode) are used when present.
- **G5 Prices the user controls:** a model price editor (overrides per model, and "map to" aliases). It applies to all past and future usage on the connected daemon, including the top-bar popover and MCP `get_usage`.
- **G6 Durable history:** the Claude CLI deletes transcripts after 30 days. Orquester keeps its own hourly usage ledger, so the 90-day view keeps working.
- **G7 Limits:** a Limits tab in the same view shows the subscription quota windows, each with a pace marker.
- **G8 Better popover:** the top-bar popover's Cost tab moves to the new data. It uses local-time days, includes Grok and OpenCode, applies the user's prices, and links to the full view.

### Non-goals

- Fetching prices from the internet (t3code downloads LiteLLM). The daemon keeps a built-in table, refreshed from a LiteLLM snapshot taken 2026-11-02, plus the user's overrides. A daemon should not call out to GitHub for a display estimate.
- Persisting per-file parse state across daemon restarts. The cold-start rescan is existing behaviour. The ledger makes history available instantly at boot, while the first scan runs and the view says "Updating…".
- Several daemons merged into one view (t3code's "environments"). The view shows the connected daemon. Switching connection switches the data.
- Splitting usage by account. Managed account homes share one transcript store, so per-account attribution is impossible from transcripts.
- Long-context (>200k) price tiers. Transcripts don't say which tier applied.
- A command-palette action. The palette has no action rows today.

## 2. Terms

- **Record:** usage of one provider request, or one aggregated slice of requests (see `UsageRecord` §4.2).
- **Ledger:** the daemon's persisted hourly usage buckets (`<appdir>/daemon/usage-history.json`).
- **Period:** one column of the history: a local calendar day (7d/30d/90d), or one UTC hour (24h).
- **Processed tokens:** uncached input + cache read + cache write + output. Reasoning is part of output and is never added on top.
- **API-equivalent cost:** tokens × per-1M-token rates. Subscription usage is not billed per token.

## 3. Data sources

| Agent | Source | Scope | Cost |
|---|---|---|---|
| `claude` | Claude Code transcripts `~/.claude/projects/**/*.jsonl` (and managed homes, deduped by realpath), existing scanner | all use on the host | estimated from tokens |
| `codex` | Codex rollouts `~/.codex/sessions/**/*.jsonl`, existing scanner | all use on the host | estimated from tokens |
| `grok` | Orquester chat logs `daemon/agent/threads/*/events.ndjson`, existing `ChatThreadUsageScanner` | Orquester chats only | provider-reported, else estimated |
| `opencode` | Orquester chat logs, same scanner (newly enabled) | Orquester chats only | provider-reported, else estimated |

### 3.1 Claude transcript fields (per assistant line with `message.usage`)

- Existing fields and rules stay: dedup by `message.id:requestId` across files (first file by sorted path wins), and zero-usage lines skipped. Tokens are `input_tokens` (uncached), `cache_read_input_tokens`, `cache_creation_input_tokens` and its `cache_creation.ephemeral_1h_input_tokens` subset, and `output_tokens`.
- **New:**
  - `ts` = `Date.parse(timestamp)`, falling back to the file mtime.
  - `session` = top-level `sessionId`.
  - `cwd` = top-level `cwd`.
  - `speed` = `"fast"` when `usage.speed === "fast"`, else `"standard"`.
  - `reasoning` = 0 (Anthropic folds thinking into output).
- **New, advisor iterations:** each `usage.iterations[i]` with `type === "advisor_message"` and a non-synthetic `model` becomes an extra row under that model with its own tokens. Its dedup id is `${dedupId}:advisor:${i}`. The top-level usage stays the executor's only.
- `<synthetic>` model lines are skipped even when non-zero.

### 3.2 Codex rollout fields

- Existing rules stay: the model comes from the preceding `turn_context`/`session_meta`, and an event counts only when the cumulative total grows.
- **New:**
  - `ts` comes from the event timestamp.
  - `session` = the first `session_meta.payload.id ?? payload.session_id`.
  - `cwd` = `session_meta.payload.cwd`, overridden by the latest `turn_context.payload.cwd`.
  - `cacheWrite` = `last_token_usage.cache_write_input_tokens`.
  - `input` = `input_tokens − cached_input_tokens − cache_write_input_tokens`, clamped at 0.
  - `reasoning` = `reasoning_output_tokens`.
  - `speed` comes from `thread_settings.service_tier` on the latest record that carries it (`thread_settings_applied` or `turn_context`): `"priority"`/`"fast"` → `"fast"`, `"ultrafast"` → `"ultrafast"`, otherwise `"standard"`.
- **New, fork-copy suppression:** a rollout whose first `session_meta` has `forked_from_id`, or `source.subagent.thread_spawn.parent_thread_id`, replays its parent's history right after the meta. Suppression starts at the meta's timestamp. While consecutive `token_count` events arrive less than 1000 ms apart, they only set the cumulative baseline and are not billed. The first event that comes ≥1000 ms after the previous one ends suppression and is billed.
- Parser state (model, session, cwd, speed, cumulative gate, suppression state) carries across incremental chunks, as `CodexParseState` does today.

### 3.3 Chat-log records (Grok, OpenCode)

- Per thread:
  - `adapter`, `projectPath` (→ `cwd`) and the thread id (→ `session`) come from `thread.created`.
  - The model comes from the latest `modelSelection.model` (existing rule).
  - Each `thread.session-set` with `payload.turn` contributes one request at `occurredAt`.
- Tokens follow `TurnTokenUsage`, where input *includes* cache reads and writes:
  - `uncached = max(0, inputTokens − cachedInputTokens − cacheCreationTokens)`
  - `cacheRead = cachedInputTokens`, `cacheWrite = cacheCreationTokens`
  - `output = outputTokens`, `reasoning = reasoningTokens`
  - `reported = totalCostUsd`, when finite. It counts as a "reported request".
- The scanner keeps hourly per-thread sums. The existing daily `snapshot(agent)` output (route `/api/usage/chat-threads`) stays byte-compatible, and `agent=opencode` is now accepted too.
- Claude chats are never read here: Claude's `totalCostUsd` is cumulative per process.

## 4. Daemon design

### 4.1 Pricing (`apps/daemon/src/usage-pricing.ts`)

- **Built-in table:** USD per 1M tokens with `input`, `output`, `cacheRead?`, `cacheWrite5m?`, `cacheWrite1h?` and optional `fast` / `ultrafast` rate sets.
  - Existing entries keep their values; tests pin them.
  - Missing models are added from the LiteLLM snapshot: Claude 4.5–5.5 families, the GPT-6 / 5.x families, o3, o4-mini, Gemini, and Grok (§9).
  - Claude Opus 5/5.5/4.8 fast = 2× every rate.
- **Lookup** (`resolvePricingKey`), in order:
  1. Trim the id and drop a trailing `[…]` tag.
  2. Exact match.
  3. The longest key that the id starts with followed by `-` (existing rule: it absorbs date suffixes and `-preview`).
  4. For a qualified id like `anthropic/claude-sonnet-4-5`, repeat steps 2–3 on the segment after the last `/`.

  Ambiguous slugs (`opus`, `sonnet`, `haiku`, `fable`, `default`, `<synthetic>`) are unpriced.
- **User config:** `{ overrides: Record<model, UsageModelRates>, aliases: Record<model, model> }`.
  - **Aliases** are applied first: the record's model becomes the alias target, so it is attributed and priced as the target. Chains are followed; a chain that enters a cycle is ignored entirely.
  - **Override match:** exact trimmed model id first, then the id with `[…]` and a trailing `-YYYYMMDD` removed.
  - **Omitted override cache rates** inherit the built-in rate of the same model when one exists, else the override's `input` rate. An omitted `cacheWrite1h` falls back to `cacheWrite5m`.
  - **Overrides have no speed tiers**: fast requests on an overridden model are priced at the override.
- **Precedence:** user override > provider-reported cost > built-in table > unpriced.
- **Cost per slice:**
  - Categories:
    - `input = uncached × in`
    - `cacheRead = cacheRead × cr`
    - `cacheWrite = (cacheWrite − w1h) × w5m + w1h × w1h_rate`
    - `output = output × out`
  - Rate fallbacks: missing `cr` → 0 for models with no cache pricing (existing behaviour); missing `w5m` → `in`; missing `w1h_rate` → `w5m`.
  - Speed tier rates come from `fast` / `ultrafast` when the entry has them, else standard.
  - `cacheSavings = cacheRead × (in − cr)` at the slice's tier.
- **Module API:**
  - `estimateCostParts` keeps its signature for existing callers, but applies the active user config.
  - `setUsagePricingConfig(config)` sets the config and bumps `usagePricingRevision()`. Scanners re-aggregate when the revision changes, so a price change reprices history without rereading files.
  - `priceSlice(model, speed, tokens)` → `{ costUsd, parts, cacheSavingsUsd, rateSource: "override"|"builtin" } | null`.
  - `pricingTable()` → the built-in table for the price editor.
- **Persistence:** `<appdir>/daemon/usage-pricing.json`, mode 0600, with path helper `usagePricingFile` in `packages/config` and zod schema `usagePricingFileSchema`.
  - Reading is tolerant: an invalid entry is not used, and a corrupt file is moved aside and the defaults are used.
  - Invalid entries and unknown fields (top-level or inside an entry) are written back as read. An edit replaces only the entries of the models it sets or removes.
  - Writes are atomic (temp file + rename).
  - The store loads at boot and calls `setUsagePricingConfig`.

### 4.2 Records (`apps/daemon/src/usage-records.ts`, types only)

```ts
export type UsageSpeed = "standard" | "fast" | "ultrafast";
export interface UsageRecord {
  source: "transcripts" | "orquester-chats";
  agent: string;            // registry id
  model: string;            // raw id as reported
  hour: number;             // Math.floor(ts / 3_600_000), UTC
  cwd: string | null;
  session: string | null;
  speed: UsageSpeed;
  input: number;            // uncached input
  cacheRead: number;
  cacheWrite: number;       // total, 1h included
  cacheWrite1h: number;
  output: number;           // reasoning included
  reasoning: number;
  requests: number;
  reportedCostUsd: number;  // sum over reported requests
  reportedRequests: number;
}
export interface UsageRecordSource {
  /** Hour-aggregated records after de-duplication; null until the first full scan finished. */
  historyRecords(): UsageRecord[] | null;
}
```

- `UsageTokensScanner.historyRecords()` aggregates `dedupedRows()` by (agent, model, hour, cwd, session, speed).
- `ChatThreadUsageScanner.historyRecords()` returns its hourly per-thread sums. It scans first if no scan has run yet; `historyRecords()` itself stays synchronous, and the caller awaits `scan()` before calling it.
- Rows keep interned `cwd` and `session` strings (one per file or thread), so memory does not grow per row.

### 4.3 Ledger (`apps/daemon/src/usage-history.ts`)

**Bucket key:** `source|agent|model|speed|hour|cwd`.

- The key holds only what a record says of itself. Nothing derived from settings goes in it: the same usage must always land in the same bucket, or the high-water merge keeps both copies.
- A bucket stores the token sums, `requests`, `reportedCostUsd`, `reportedRequests`, and the set of session ids. Session ids and cwds are interned in tables inside the file.
- `project` is derived at query time: `"<workspace>/<project>"` when the bucket's `cwd` (as given, or after realpath of the workspaces root) lies at least two segments under `workspacesDir`. Otherwise it is `""`.

**Merge** (high-water rule):

1. Group the live records into buckets.
2. For each live bucket, the stored bucket is replaced by the live one unless the stored one has more `requests`. Session sets are unioned either way.
3. Stored buckets with no live counterpart are kept. This is the point of the ledger: transcripts deleted by the CLI keep their history.

**Retention:** buckets older than 120 days are dropped.

**Persistence:**

- `<appdir>/daemon/usage-history.json`, mode 0600, `{ version: 1, recordedSince, sessions: string[], cwds: string[], buckets: [...] }`, in compact arrays.
- Writes happen only when something changed, coalesced to at most one per 60 s, atomically. Pending changes are flushed on daemon stop.
- Reading is tolerant: an unknown or newer `version` starts empty but keeps the old file as `.v<n>.bak`; a corrupt file is moved aside.
- A row this version can't read (a newer writer's source or speed), trailing columns and unknown top-level fields are written back unchanged. The parser and serializer are `parseUsageHistoryFile` / `serializeUsageHistoryFile` in `packages/config`.
- `recordedSince` is the first time this daemon wrote the ledger.

**Triggers:**

- The scanner gets an `onScanned` callback after every `doRecompute`. The ledger merges a source's first scan at once, and later scans at most every 5 minutes. A query, the prices answer and the flush at shutdown merge a deferred scan first.
- A history request ingests the chat-log scanner's records and runs the merge before answering.
- `refresh=1` awaits `usageTokens.recompute()` and a chat-log scan first.

**Query** (`query({ range, timeZone, now })`):

- Only stored buckets are used: after a merge they include everything live.
- **`24h`:** 24 UTC hour periods, the current hour and the 23 before it. `since`/`until` are the hour bounds.
- **`Nd`** (1 ≤ N ≤ 90):
  - Days are calendar days in `timeZone`. `until` is today; `since` is today − (N−1), computed with UTC date arithmetic so it is DST-safe.
  - An hour belongs to the local day of its start instant. Zones with half-hour offsets get hour-level approximation.
  - An invalid `timeZone` falls back to `UTC`, and the response says `UTC`.
- Results are grouped into `UsageHistoryBucket`s per (period, agent, model after aliasing, speed) and priced per bucket:
  - **Override** for the model: estimate everything from tokens.
  - **Else, reported requests > 0:** `costUsd = reported`, `costSource = "reported"`, and `unpricedTokens` = processed × (requests − reportedRequests) / requests.
  - **Else, a built-in rate exists:** `costSource = "estimated"`.
  - **Else:** `costUsd = null`, `costSource = "unpriced"`, `unpricedTokens` = processed.
- Distinct session counts are computed over the whole range: total, by agent, by `agent:model`, and by project.
- Project buckets are aggregated over the range per (project, agent, model).

### 4.4 Routes

- **`GET /api/usage/history?range=24h|<N>d&tz=<IANA>[&refresh=1]`** → `UsageHistoryResponse`.
  - A bad range returns 400 `INVALID_REQUEST`.
  - Remote use requires auth, like every `/api/*` route.
- **`GET /api/usage/prices`** → `UsagePricesResponse`.
- **`PUT /api/usage/prices`**, body `UsagePricesPatch` → `UsagePricesResponse`.
  - A `null` value deletes an entry.
  - It returns 400 when any rate is negative or not finite, when `input` or `output` is missing on a new override, when a model id is empty after trimming or longer than 200 characters, when an alias maps to itself, or when the resulting alias graph has a cycle.
  - On success it persists, calls `setUsagePricingConfig`, and the next history or tokens answer is repriced.
- `GET /api/usage/chat-threads?agent=grok|opencode` (allow-list extended).
- `/api/usage/tokens` is unchanged in shape. Its costs now follow the user's prices.

### 4.5 MCP

`get_usage` (`cost`) keeps its shape. It picks up user prices through `estimateCostParts`, and also merges OpenCode chat rows, as it does for Grok.

## 5. Contracts (`packages/api/src/index.ts`)

```ts
export type UsageSpeed = "standard" | "fast" | "ultrafast";
export interface UsageModelRates { input: number; output: number; cacheRead?: number; cacheWrite5m?: number; cacheWrite1h?: number } // USD / 1M
export interface UsageTokenTotals { input: number; cacheRead: number; cacheWrite: number; cacheWrite1h: number; output: number; reasoning: number }
export interface UsageCostParts { input: number; cacheRead: number; cacheWrite: number; output: number }
export type UsageCostSource = "estimated" | "reported" | "unpriced";
export interface UsageHistoryBucket {
  period: number; agent: string; model: string; speed: UsageSpeed;
  tokens: UsageTokenTotals; requests: number;
  costUsd: number | null; cost: UsageCostParts | null; costSource: UsageCostSource;
  cacheSavingsUsd: number; unpricedTokens: number;
}
export interface UsageHistoryProjectBucket {
  project: string; agent: string; model: string;    // project "" = outside the workspaces
  tokens: UsageTokenTotals; requests: number; costUsd: number | null; unpricedTokens: number;
}
export interface UsageHistorySessions { total: number; byAgent: Record<string, number>; byModel: Record<string, number>; byProject: Record<string, number> }
export interface UsageHistorySource { agent: string; scope: "transcripts" | "orquester-chats"; oldestAt: string | null }
export interface UsageHistoryResponse {
  range: string; resolution: "hour" | "day"; timeZone: string;
  since: string; until: string; periods: string[];
  buckets: UsageHistoryBucket[]; projectBuckets: UsageHistoryProjectBucket[];
  sessions: UsageHistorySessions; sources: UsageHistorySource[];
  recordedSince: string | null; scanning: boolean; asOf: string;
  costSource: "api_equivalent";
}
export interface UsagePriceModelInfo { agent: string; model: string; status: "override" | "alias" | "builtin" | "reported" | "unpriced"; pricingKey: string | null; aliasOf: string | null }
export interface UsagePricesResponse {
  currency: "USD"; unit: "per_million_tokens";
  builtin: { model: string; rates: UsageModelRates; fast?: UsageModelRates; ultrafast?: UsageModelRates }[];
  overrides: Record<string, UsageModelRates>; aliases: Record<string, string>;
  seenModels: UsagePriceModelInfo[];   // every model in the ledger's last 90 days, by processed tokens desc
}
export interface UsagePricesPatch { overrides?: Record<string, UsageModelRates | null>; aliases?: Record<string, string | null> }
```

- Periods are `YYYY-MM-DD` for days and ISO hour starts for hours.
- `byModel` keys are `${agent}:${model}`.
- The UI client (`packages/ui/src/lib/api-client.ts`) gets `getUsageHistory(range, tz, force?)`, `getUsagePrices()` and `updateUsagePrices(patch)`. The reference client (`packages/api`) gets `usageHistory`.

## 6. UI design

### 6.1 Placement

Usage becomes a **server-level view**, the same pattern as Knowledge and the Devices fleet:

- **Store:** `usageViewOpen` plus `usageViewTab` in `store/app.ts`, with `openUsageView(tab?)` / `closeUsageView()`. The flag is mutually exclusive with the other server views; update every place that lists them (`serverViewOpen`, `leaveServerViews`, `withoutDaemonTabs`, `showKnowledge`, `openDevicesFleet`, `openTab`).
- **Mount:** lazily in `MainView`, as `UsageMain` with `useBackClose`.
- **Top bar:** a `UsageHeader` (Gauge icon, "Usage", close X) in the top bar's server-header slot.
- **Entry points:**
  - **Desktop ActivityBar:** a Usage button with a `ChartNoAxesColumn` icon, `aria-pressed` while the view is open; clicking toggles the view.
  - **Phone drawer:** a "Usage" row.
  - **Top-bar popover:** an "Open usage" link in the header that opens the view on the Cost tab, or on Limits when the popover is on Windows.
  - **Settings → Usage:** a "View usage history" action, and a "Model prices…" button that opens the price editor.
- The view is always available (not gated on the chip toggle); the popover still follows `usage.enabled`.

### 6.2 Layout

Content is `max-w-5xl`, centred, `px-5 sm:px-6 py-6`, sections `gap-6`. The page background is the main view's; cards follow the house style (`rounded-xl border-neutral-800 bg-neutral-900/40`).

**Toolbar row** (wraps on narrow widths):

- Left: the window label ("Oct 4 – Nov 2", or "Nov 1, 3 PM – Nov 2, 3 PM" for 24h) and an **agent filter** dropdown: All agents / one per agent, multi-select, persisted.
- Right: the period `SegmentedControl` (24h · 7d · 30d · 90d), hidden on Limits but keeping its slot so the tabs don't shift; the metric `SegmentedControl` (Cost · Tokens · Limits); and a refresh `IconButton` that spins while refreshing.
- A `⋯` menu holds "Model prices…".

**Cost and Tokens tabs:**

1. **Hero** (`lg:grid-cols-[18rem_1fr]`):
   - **Left column:**
     - The big total (`text-4xl font-semibold tabular-nums`): `$12,345.67` (Cost) or `89.8B` (Tokens).
     - A subline: "2,075 sessions · API estimate". When an unpriced share exists, an info marker's title reads "Excludes 3.2% of tokens with no known price".
     - Per-agent rows in fixed order (codex, claude, grok, opencode), listing only agents with activity: colour dot, agent icon, label and session count on the left; the value on the right. A second line shows "15.0% of cost · 13.5B tokens" on Cost, or "15.0% of tokens · $1,234.56" on Tokens. Unpriced-only agents show "Unpriced".
   - **Right column:** "Daily cost by agent" (or "processed tokens", or "Hourly…" for 24h) above the chart.
2. **Chart:** custom SVG, `viewBox 0 0 960 260`, `preserveAspectRatio="none"`, `non-scaling-stroke`.
   - One overlaid series per agent, not stacked, each anchored at 0.
   - Monotone-cubic curve (no overshoot) with a 12%-opacity area fill and a 2px line. Series are drawn largest window total first.
   - Y scale: "nice" ticks over the maximum single-series value, with horizontal gridlines only.
   - Three x labels: first, middle and last period.
   - Hover snaps to the nearest period and shows a vertical rule plus a tooltip card: the period label, one row per agent (icon, label, value) and a Total row. The tooltip flips and clamps inside the plot; its position is written through CSS variables, so there is no React re-render per mousemove.
   - `role="img"` with an aria-label.
3. **Totals:** grid of 2 columns, 3 at `md`, 6 at `lg`. Each cell has a label, a value and a muted detail line:
   - Processed tokens — "X per active day/hour"
   - Cached input — "N% of input"
   - Uncached input — "X cache writes"
   - Output — "incl. X reasoning"
   - Cache savings ($) — "vs full input rates"
   - Unpriced — "% of tokens, excluded from cost"; shown only when > 0, otherwise the cell is omitted
4. **Share bars** (`lg:grid-cols-2`):
   - "Tokens by type": Input, Cache read, Cache write, Output.
   - On Cost only, "Cost by type": Input, Cache read, Cache write, Output, plus "Other" for reported/unsplit cost ≥ $0.005.
   - "Cost by speed" (Standard / Fast / Ultrafast) appears only when non-standard cost exists. Its aside shows the premium over standard rates.
   - Bars are `h-2` with 2px gaps and rounded ends. Each segment has a native title tooltip ("Cache read · 80.1B · 89.2%"), and a legend sits under the bar.
   - Type colours are a monochrome ink ramp (`color-mix(in oklab, rgb(var(--n-50)) p%, transparent)` style), so hue stays reserved for agents.
5. **Breakdown** card, with a header segmented toggle **Model | Day (Hour) | Project**:
   - **Model:**
     - Columns: #, Model (agent icon + id), Cost, Share (hidden < sm), Tokens.
     - Sort: cost desc on Cost, tokens desc on Tokens.
     - A share underline under the name is scaled to the top row (`max(0.5rem, v/peak)`) in the agent colour.
     - Unpriced cost cells read "Unpriced" (muted).
     - The whole row is clickable and opens the model dialog.
   - **Day / Hour:** a horizontally scrollable region. Columns: Period, one cost column per active agent, Total, Tokens. Newest first.
   - **Project:**
     - Columns: Project (`project` with a muted `workspace/`), Sessions, Cost, Share, Tokens.
     - The "" project reads "Outside workspaces".
     - Grok and OpenCode rows count only Orquester chats (no extra note per row; the footnote covers it).
   - Empty: "No activity in this window."
6. **Footnotes** (muted, `text-xs`):
   - "API-equivalent estimate at list prices, including prompt-cache reads and writes. Subscription usage isn't billed per token."
   - "Grok Build and OpenCode count only Orquester chats."
   - When `recordedSince` is later than the window start: "Claude Code keeps transcripts for 30 days; Orquester has recorded usage since {date}."

**Model dialog** (`Modal`, `max-w-3xl`):

- Header: agent icon and model id; below it "Codex · 12.3% of cost".
- Stats in 2 columns, 4 from `sm`:
  - Cost (or "Unpriced")
  - Tokens
  - Per 1M tokens = cost / (processed − unpriced) × 1e6, hidden when null
  - Cache hit = cacheRead / (uncached + cacheRead + cacheWrite)
- The trend chart for this model alone. It follows the tab's metric, but shows tokens when the model's cost is unknown.
- "Cost by type", "Tokens by type" and "Cost by speed" bars.
- Footer when there are unpriced tokens: "4.2M tokens have no known price" with a "Set price" button. The button closes the dialog and opens the price editor with a new row for this model.

**Price editor** ("Model prices" `Modal`, `max-w-4xl`):

- Description: "Prices apply to all past and future usage on this daemon, including the top-bar estimate and agents' get_usage."
- Unit label: "USD / million tokens".
- Table: Model ID | Map to | Input | Output | Cache read | Cache write 5m | Cache write 1h | action.
  - **Header "+"** adds a row and focuses the Model ID input, which has a datalist of seen models.
  - **Existing rows** show the model as text.
  - **Placeholders** show the built-in rate ("4.00") when one exists, else "Automatic". Cache placeholders for unknown models read "= input".
  - **"Map to"** (datalist of known models) replaces the rate cells with "Counted as {target}".
  - **Row action:** remove for a new row, or "Reset to automatic" for a saved row (strike-through with Undo).
  - **Seen-models list:** the unpriced seen models are suggested at the top ("No price: gpt-6-astra · 11.3B tokens — Set").
- Validation:
  - The keystroke filter allows digits plus one `.` or `,` decimal separator.
  - Parsing accepts finite values ≥ 0.
  - Input and Output are required unless Map to is set.
  - Error messages: duplicate model ("This model already has a row."), empty id ("Enter a model ID."), mapping a model to itself ("Map to a different model."), a cycle ("Mappings can't form a cycle.").
  - Edits that equal the saved value are dropped from the draft.
- Footer: "Discard changes" and a primary "Save changes" (shows "Saving…"). The server's error is shown inline. Save sends only changed models. After saving, the history and the popover data are refetched.

**Limits tab:**

- Renders the existing `UsageOverview` (per-agent cards with `UsageAccountCard`s) and the "Resets as" control.
- `Meter` gains an optional **pace tick**, shown in the Usage view only. It is a 2px foreground mark at the even-spend position `elapsed = 1 − (resetsAt − now) / duration`, where duration is 5h for session windows, 7d for weekly ones, and `windowDurationMins` for provider windows.
- A pace label shows "ahead of pace" (used − elapsed > 5 points), "on pace" or "under pace".
- Unknown duration → no tick.

### 6.3 States

- **First load with no data:** a skeleton that mirrors the layout.
- **Switching period:** the previous data stays on screen, dimmed with `opacity-40 transition-opacity delay-150`, until the new answer arrives.
- **Scanning:** when the response says `scanning` (or the data is older than 60 s), show it and immediately refetch with `refresh=1`, which awaits the scan. During that refetch, show "Updating…" (small spinner, top-right of the content).
- **Errors:** a 404 (older daemon) shows "This daemon is too old to report usage history. Update it to see this view." Other errors show "Couldn't load usage." with a Retry button, and keep the last data when there is some.
- **Refresh while visible:** a non-forced refetch every 60 s while the view is visible and the tab is Cost/Tokens (`usePollWhileActive`).

### 6.4 Keyboard

While the view is open and focus is not in an input, textarea, select, contenteditable or an open dialog:

- `c`, `t`, `l` switch tabs.
- `mod+shift+1..4` switch the range (ignored on Limits).
- `Esc` closes dialogs first (the existing Modal escape stack).
- Each control's title shows its shortcut.

### 6.5 Preferences

- Stored in localStorage key `orquester:usage-view` as `{ tab: "cost"|"tokens"|"limits", range: "24h"|"7d"|"30d"|"90d", hiddenAgents: string[], breakdown: "model"|"period"|"project" }`.
- Each field is sanitized on read, falling back to `{cost, 30d, [], model}`. Writes swallow storage errors.

### 6.6 Colours and formatting

- **Agent colours:** per-mode CSS variables in `globals.css`, dark and light: `--agent-claude` (#D97757), `--agent-codex` (neutral contrast: near-white in dark, near-black in light), `--agent-grok` (a muted neutral), `--agent-opencode` (#5B9BBD), and an `--agent-other` fallback. Every hue appears in a single `agentColor(id)` helper.
- **Formatters:** shared pure module `packages/ui/src/lib/usage-history-format.ts`, which the popover reuses:
  - Tokens: K/M/B/T, 3 significant digits, trailing all-zero decimals trimmed ("89.8B", "512K", "999").
  - Money: always `$1,234.56`; `<$0.01` for tiny positive values; "—" for null.
  - Percent: 1 decimal, `<0.1%` for tiny values.
  - Counts: integers with separators.
  - Day labels "Sep 8"; hour labels "3 PM" / "15:00".
  - Model labels: the existing `labelForModel` moves here.

### 6.7 Popover upgrade (`topbar/UsageWidget.tsx`)

- The Cost tab loads `/api/usage/history?range=14d&tz=<local>`.
  - Today is the last period; "7 days" is the sum of the last 7 periods.
  - The bars are the 14 periods, per-day groups list per-model rows, and Grok and OpenCode are included.
- On a 404 it falls back to the existing `/api/usage/tokens` path.
- The disclaimer stays.
- The header gets an "Open usage" link.

## 7. Testing

Test behaviour through stable seams, following the AGENTS.md rules.

**Daemon:**

- **Pricing:**
  - Alias + override precedence.
  - Omitted cache rates.
  - Exact and normalized override match.
  - Fast tier.
  - Reported vs override.
  - Cycle ignored.
  - `estimateCostParts` reflects overrides.
- **Pricing store:** tolerant read, patch, and validation errors.
- **Scanner:**
  - Session, cwd, ts and speed parsed.
  - Advisor iterations.
  - Codex `cache_write`, reasoning and fork suppression.
  - `historyRecords` deduped.
- **Chat scanner:** `historyRecords` hourly for opencode, and the input split.
- **Ledger:**
  - A deleted transcript keeps its history.
  - Requests high-water.
  - Session union.
  - Retention.
  - Persistence round-trip and corrupt file.
  - Query day boundaries in a non-UTC zone.
  - 24h periods.
  - Range validation.
  - Distinct sessions across days.
  - Project mapping.
  - Unpriced and reported handling.
- **Routes:** history 400 on a bad range; prices PUT validation.

**UI:**

- `usage-view.logic.ts`:
  - Totals.
  - Shares.
  - Hidden agents.
  - Series zero-filled.
  - Model sort per metric.
  - Per-1M excluding unpriced.
  - Cache hit counting writes as misses.
  - Project rollup.
- Chart geometry: nice scale, and monotone tangents never overshoot.
- Formatters.
- Prefs sanitize.
- Price form parse and draft diff.
- Shortcut resolution.
- A `usage-view.dom.test.ts` for open and close through the store, the entries, and the mutual exclusion with Knowledge and Devices.

## 8. Rollout

All changes are additive: new routes, new files, and optional contract fields. An older daemon answers 404, which the UI handles. Nothing in the agent host changes.

## 9. Built-in price additions (USD / 1M)

| model | in | out | cache read | write 5m | write 1h | fast / ultrafast |
|---|---|---|---|---|---|---|
| claude-fable-5-1 | 10 | 50 | 0.25 | 12.5 | 20 | |
| claude-mythos-5 | 10 | 50 | 1 | 12.5 | 20 | |
| claude-mythos-5-1 | 10 | 50 | 0.25 | 12.5 | 20 | |
| claude-opus-4-5 / 4-6 / 4-7 | 5 | 25 | 0.5 | 6.25 | 10 | |
| claude-sonnet-5-5 | 2 | 10 | 0.1 | 2.5 | 4 | |
| claude-sonnet-4-5 / 4-6 | 3 | 15 | 0.3 | 3.75 | 6 | |
| claude-haiku-5-5 | 0.1 | 0.5 | 0.01 | 0.125 | 0.2 | |
| gpt-6-astra | 10 | 50 | 1 | 12.5 | | fast 20/100 (cr 2, w 25); ultrafast 60/300 (cr 6, w 75) |
| gpt-6-rosalind | 15 | 75 | 1.5 | 18.75 | | |
| gpt-6-sol | 2 | 10 | 0.2 | 2.5 | | fast 4/20 (cr 0.4, w 5) |
| gpt-6.1-sol | 2 | 10 | 0.1 | 2.5 | | fast 4/20 (cr 0.2, w 5); ultrafast 12/60 (cr 0.6, w 15) |
| gpt-6.1-terra | 1 | 5 | 0.05 | 1.25 | | fast 2/10 (cr 0.1, w 2.5) |
| gpt-6-luna | 0.1 | 0.5 | 0.01 | 0.125 | | fast 0.2/1 (cr 0.02, w 0.25) |
| gpt-5.5 | 5 | 30 | 0.5 | | | fast 12.5/75 (cr 1.25) |
| gpt-5.4 | 2.5 | 15 | 0.25 | | | fast 5/30 (cr 0.5) |
| gpt-5.4-mini | 0.75 | 4.5 | 0.075 | | | |
| gpt-5.3-codex, gpt-5.2, gpt-5.2-codex | 1.75 | 14 | 0.175 | | | |
| gpt-5, gpt-5-codex, gpt-5.1-codex-max | 1.25 | 10 | 0.125 | | | |
| gpt-5.1-codex-mini | 0.25 | 2 | 0.025 | | | |
| o3 | 2 | 8 | 0.5 | | | |
| o4-mini | 1.1 | 4.4 | 0.275 | | | |
| gemini-3.1-pro-preview | 2 | 12 | 0.2 | | | |
| gemini-3-flash-preview | 0.5 | 3 | 0.05 | | | |
| gemini-2.5-pro | 1.25 | 10 | 0.125 | | | |
| gemini-2.5-flash | 0.3 | 2.5 | 0.03 | | | |
| grok-build | 2 | 6 | 0.3 | | | |
| grok-4.5 / 4.6 / 4.7 | 2 | 6 | 0.3 / 0.5 / 0.5 | | | |
| grok-4.3, grok-4.20 | 1.25 | 2.5 | 0.2 | | | |

Claude Opus 5, 5.5 and 4.8 get a fast tier of 2× every rate. Existing entries (opus-5-5, opus-5, opus-4-8, fable-5, sonnet-5, haiku-4-5, gpt-5.6-*, gpt-5.1-codex, gpt-5.4-codex) keep their current values.
