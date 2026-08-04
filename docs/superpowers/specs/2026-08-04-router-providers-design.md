# Router Providers for the Model Proxy — Design

**Date:** 2026-08-04
**Status:** Approved (brainstorm 2026-08-03/04)
**Scope:** Generalize the model proxy's OpenAI-compatible provider support from one hardcoded
OpenRouter block into user-defined **router providers**, with OpenRouter and TokenRouter shipped
as presets. Model-proxy only: consumers remain the `claudex`/`claudemix` launchers through
CLIProxyAPI. Other agents (codex, opencode, deepseek, gemini) are out of scope.

## Background / current state

OpenRouter support today is not a registry entry — it lives inside the managed CLIProxyAPI
("Model proxy") subsystem:

- `renderConfigYaml` (`apps/daemon/src/cliproxy-files.ts:75-89`) emits exactly one
  `openai-compatibility` provider with a literal base URL (`https://openrouter.ai/api/v1`) and a
  literal single model (`moonshotai/kimi-k3` aliased `kimi-k3`). CLIProxyAPI itself accepts N
  providers in that list; the one-provider ceiling is our rendering.
- The key is a single `openRouterKey: string | null` field in the cliproxy secrets file
  (`apps/daemon/src/cliproxy-secrets.ts`), settable via `POST /api/cliproxy/openrouter/key`
  (verify-before-store against OpenRouter's `GET /key`). There is no way to remove a key.
- Provider routing is a model-name regex: `isOpenRouterModel` = `/^(kimi|moonshotai\/)/i`
  (`packages/config/src/index.ts:755`). A second OpenAI-compatible provider added naively would
  misroute (get an `acc<hex>/` account prefix).
- `CliProxyProviderId = "codex" | "claude" | "openrouter"` is a closed union
  (`packages/api/src/index.ts:814`); `OPENROUTER_ALIAS_MODELS` and `CURATED_PROXY_MODELS`
  (`packages/config/src/index.ts:766,787`) are hardcoded lists.

### TokenRouter facts (verified 2026-08-03 by unauthenticated endpoint probing)

- Real product: **tokenrouter.com** (API `api.tokenrouter.com`), a hosted deployment of the
  open-source `new-api` gateway. ⚠️ `tokenrouter.me` is an unrelated lookalike (likely
  credential harvesting); `tokenrouter.io` is a different product.
- OpenAI-compatible endpoint: `https://api.tokenrouter.com/v1`, bearer `sk-…` auth,
  `vendor/model` slugs (e.g. `moonshotai/kimi-k3-free`).
- It also exposes a native Anthropic `/v1/messages` (base URL without `/v1`), but
  `count_tokens` 404s and its tool-use/streaming behavior is unproven — we deliberately keep
  routing through CLIProxyAPI's OpenAI-compatibility path so this never matters.
- `GET /v1/models` requires auth (unlike OpenRouter's public catalog) — fine, we hold the key.

## Decisions (from brainstorm)

1. **Scope:** model proxy only.
2. **Extensibility:** data-driven core **plus** user-defined providers in the UI; OpenRouter and
   TokenRouter ship as presets that only prefill the form.
3. **Model entry:** fetch the provider's catalog and let the user pick; manual entry as fallback.
4. **Timing:** design → spec → plan → implementation; no throwaway hardcoded unblock.
5. **Approach:** router providers as a first-class cliproxy sub-resource beside the OAuth pair
   (`codex`/`claude`), which stay exactly as they are. Rejected: unifying OAuth + router
   providers into one polymorphic model (high risk, no user gain); bypassing the proxy via each
   router's Anthropic endpoint (loses proxy features, inherits router quirks).

## 1. Data model, persistence, migration

New zod schemas in `packages/config/src/index.ts` beside the existing cliproxy schemas:

```ts
routerModel = {
  name: string,            // MODEL_NAME_RE, e.g. "moonshotai/kimi-k3-free"
  alias?: string,          // MODEL_NAME_RE; short picker name; unique across ALL providers
  contextWindow?: number,
  compactWindow?: number,
}
routerProvider = {
  id: string,              // slug /^[a-z0-9][a-z0-9-]{0,31}$/; unique; reserved: "codex","claude"
  label: string,
  baseUrl: string,         // must parse as http(s) URL
  preset: "openrouter" | "tokenrouter" | null,  // provenance only; behavior comes from fields
  models: routerModel[],
  keyVerifiedAt: string | null,
  createdAt: string,
}
```

- `cliProxyState.routerProviders: routerProvider[]` (default `[]`).
- `cliProxySecrets.routerKeys: Record<providerId, string>` (default `{}`); parse still fails
  closed to `"corrupt"`.
- `ROUTER_PRESETS` constant: OpenRouter (`https://openrouter.ai/api/v1`, key check via its
  dedicated `GET /key`) and TokenRouter (`https://api.tokenrouter.com/v1`, key check via authed
  `GET /models`). Presets prefill the create form; after creation every provider is plain data.

**Migration (one-time, at load):** if secrets hold a legacy `openRouterKey`, seed an
`openrouter` router provider with today's exact wiring (`moonshotai/kimi-k3` alias `kimi-k3`,
contextWindow 1_048_576, compactWindow 450_000, `keyVerifiedAt` copied from the legacy
`openRouterKeyVerifiedAt` state field) and move the key to `routerKeys.openrouter`. Legacy
fields (`openRouterKey`, `openRouterKeyVerifiedAt`) are **mirrored at rest** for one release for
rollback safety (precedent: `githubLogin`/`githubKeyId` mirroring in accounts.json, commit
914ec27); new code never reads them after migration.

**Replaced by data:** `OPENROUTER_ALIAS_MODELS`, `isOpenRouterModel`, the literal
`openai-compatibility` YAML block, and the `kimi-k3` entry of `CURATED_PROXY_MODELS` (the three
GPT models stay curated — they belong to the OAuth providers).

## 2. Daemon behavior and API

**YAML projection** (`cliproxy-files.ts`): `renderConfigYaml` loops `routerProviders`, emitting
one `openai-compatibility` entry per provider that has **both** a key in `routerKeys` and ≥ 1
model; keyless or model-less providers are skipped. Models stay provider-level (nesting them
under an api-key entry 502s — documented gotcha). All strings are emitted via `JSON.stringify`
so a hostile label/baseUrl can't inject YAML.

**Routing:** a derived index `routerModelIndex(state)` maps every model `name` and `alias` →
provider id; it replaces the regex everywhere:

- `cliproxyContributor` (`apps/daemon/src/index.ts:826`): router models are emitted bare (never
  `acc<hex>/`-prefixed); non-router models keep the account-prefix logic.
- `compactEnvForModel` becomes provider-aware: full name ↔ alias normalize to the same
  context/compact settings from the provider's model entry; existing `modelOverrides` still win.
- `probe()` unions all router aliases into the live catalog (generalizing the current
  `OPENROUTER_ALIAS_MODELS` union — CLIProxyAPI routes aliases but never lists them).
- The launch-time seeded-account requirement skip (`index.ts:2956`) keys off the index.
- Name/alias collisions across providers are rejected at write time (400).

**Key verification** (`verifyRouterKey`): OpenRouter-preset providers keep the precise
`GET /key` check; all others use `GET {baseUrl}/models` with `Authorization: Bearer`. 401/403 ⇒
rejected; network error / 5 s timeout ⇒ stored-but-unverified (`keyVerifiedAt: null`), matching
today's fallback semantics.

**Routes** — HTTP-transport-only like all cliproxy mutations (403 over the unix socket);
config-touching mutations are restart-gated with the existing 409
`{ok:false, affectedSessions}` + `force` flow:

| Route | Behavior |
|---|---|
| `PUT /api/cliproxy/providers/:id` | Create/update `{label, baseUrl, models}`. Validates slug, URL, model names, alias uniqueness. Restart-gated. |
| `DELETE /api/cliproxy/providers/:id` | Removes provider **and** its key. Restart-gated. |
| `POST /api/cliproxy/providers/:id/key` | `{key, force}` — verify-before-store. Restart-gated. |
| `DELETE /api/cliproxy/providers/:id/key` | Clears the key (fixes today's can't-remove gap). Restart-gated. |
| `GET /api/cliproxy/providers/:id/catalog` | Daemon fetches the provider's `/v1/models` with the stored key → `{models:[{id}]}`. 409 if no key; 502 + reason on upstream failure. Read-only, not restart-gated. |

`POST /api/cliproxy/openrouter/key` is **deleted**, not aliased — the web SPA is served by the
daemon and the desktop bundles its daemon, so client/server skew is a non-issue.

**Wire contract** (`packages/api`): `CliProxyProviderId` shrinks to `"codex" | "claude"`;
`CliProxyStatus` gains:

```ts
routerProviders: Array<{
  id: string; label: string; preset: "openrouter" | "tokenrouter" | null;
  baseUrl: string; models: RouterModel[];
  keyState: "none" | "set" | "verified"; keyVerifiedAt: string | null;
}>
```

Keys never cross the wire.

## 3. UI, Claude-side exposure

**Settings → Model proxy:** the Providers section splits into **Accounts** (codex/claude rows,
unchanged) and **Routers**: one row per provider (label, base URL, key state, enabled-model
count) with actions *set/replace key*, *remove key*, *edit models*, *delete*. "Add router" opens
a preset picker (OpenRouter / TokenRouter / Custom) → form with label + base URL (prefilled for
presets). "Edit models" fetches `…/catalog` into a searchable checklist (catalogs run 116–500+
entries); each checked model exposes optional alias + context/compact-window fields; a manual
"add model" input covers catalog failures. All mutations ride the existing `withRestartConfirm`.

**Model picker / launch:** `NewTabMenu` model chips = `CURATED_PROXY_MODELS` ∪ enabled router
models (∩ live catalog, as today). Picking a router model dims the account chip with "routes
through {label} (keyless)" — driven by the index. The `claudex.env` Fable slot stays `kimi-k3`
**iff** some router provider exposes that alias (data-driven lookup preserving today's behavior);
the managed `kimi.md` agent and claudemix managed memory keep the same availability gate. No new
slot-assignment feature — per-tab model chips are the surface for everything else.

## 4. Error handling

- Invalid slug / baseUrl / model name / duplicate alias → 400 with a field-level message.
- Catalog fetch failure → UI falls back to manual model entry.
- Corrupt secrets keep failing closed (proxy refuses to start, as today).
- Deleting a provider (or its key) whose model is pinned as `defaultModel`, `backgroundModel`,
  or the Fable alias resets those to defaults within the same mutation.

## 5. Verification

No test runner in this repo; "done" means:

1. `pnpm check` clean.
2. Ad-hoc test files in the existing pattern (`registry-env.test.ts`) for the pure parts:
   secrets/state migration, `routerModelIndex`, `renderConfigYaml` multi-provider output,
   `compactEnvForModel` alias normalization.
3. Drive a real daemon **in a separate checkout** (never the live one — AGENTS.md rule):
   enable the proxy, add TokenRouter via the UI, paste a key, pick `moonshotai/kimi-k3-free`
   from the fetched catalog, launch a claudex tab, confirm the session answers and that
   `config.yaml` + `claudex.env` projections are correct; verify OpenRouter key migration by
   upgrading a state dir that has a legacy `openRouterKey`.

## Out of scope / future

- Non-Claude agents using router providers (per-launcher env for codex/opencode).
- Direct Anthropic-endpoint launchers that bypass CLIProxyAPI.
- Configurable picker slot assignment (Opus/Sonnet/Fable remapping UI).
- AGENTS.md still lacks any cliproxy section; the implementation plan should include a docs
  update covering the subsystem plus this feature.
