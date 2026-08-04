# Router Providers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generalize the model proxy's single hardcoded OpenRouter block into data-driven, user-defined **router providers** (OpenRouter + TokenRouter presets, custom allowed), per spec `docs/superpowers/specs/2026-08-04-router-providers-design.md`.

**Architecture:** New `routerProviders[]` in cliproxy `state.json` + `routerKeys` map in `secrets.json`; `renderConfigYaml` loops providers into CLIProxyAPI `openai-compatibility` entries; a model/alias→provider index replaces the `isOpenRouterModel` regex; provider CRUD + key + catalog routes; Settings UI grows a "Routers" section. Legacy `openRouterKey` migrates into an `openrouter` provider with at-rest mirroring for rollback.

**Tech Stack:** TypeScript 5.8 ESM, zod (packages/config only), Fastify routes in `apps/daemon/src/index.ts`, node:test via tsx, React/zustand UI.

## Global Constraints

- **⛔ Never start/restart the daemon in this checkout** (AGENTS.md) — verify with `pnpm check` + tests; live-drive only in a separate checkout when Task 13 says so.
- Commit to the **current branch** (`main`) as-is; no new branches.
- Test runner: `pnpm --filter @orquester/daemon test` (all) or, from `apps/daemon/`, `node --import tsx --test src/<file>.test.ts` (one file). Typecheck gate: `pnpm check` from the repo root.
- zod is allowed **only** in `packages/config`. No new dependencies anywhere.
- Model names must match `MODEL_NAME_RE` (`/^[A-Za-z0-9._/-]{1,128}$/`); provider ids must match `ROUTER_PROVIDER_ID_RE` (`/^[a-z0-9][a-z0-9-]{0,31}$/`, reserved: `codex`, `claude`).
- Every string emitted into `config.yaml` goes through `JSON.stringify` (YAML-injection guard). CLIProxyAPI's `models` key is **provider-level**, never nested under an api-key entry (nesting 502s).
- Secrets (keys) never cross the wire; keys are stored via the hardened symlink-refusing atomic writer in `cliproxy-secrets.ts`.
- Cliproxy mutations are HTTP-transport-only (403 over the unix socket via `refusedOnSocket`) and restart-gated: refuse with 409 `{ok:false, affectedSessions}` while `liveDependentSessionCount() > 0` unless `force`.
- Legacy fields `secrets.openRouterKey` and `state.openRouterKeyVerifiedAt` stay **mirrored at rest** this release (rollback safety, precedent commit 914ec27). New code never *reads* them after migration — it only writes the mirror.

---

### Task 1: Config — schemas, presets, resolution helpers

**Files:**
- Modify: `packages/config/src/index.ts` (cliproxy section, around lines 742–930)
- Test: `apps/daemon/src/router-providers.test.ts` (new)

**Interfaces:**
- Consumes: existing `MODEL_NAME_RE`, `cliProxyStateSchema`, `cliProxySecretsSchema`, `CURATED_PROXY_MODELS`, `compactEnvForModel`.
- Produces (used by every later task):
  - `ROUTER_PROVIDER_ID_RE: RegExp`, `RESERVED_ROUTER_PROVIDER_IDS: readonly ["codex","claude"]`
  - `routerModelSchema` / `type RouterModel = { name: string; alias?: string; contextWindow?: number; compactWindow?: number; compactPct?: number }`
  - `routerProviderSchema` / `type RouterProvider = { id: string; label: string; baseUrl: string; preset: "openrouter"|"tokenrouter"|null; models: RouterModel[]; keyVerifiedAt: string|null; createdAt: string }`
  - `ROUTER_PRESETS: readonly { preset: "openrouter"|"tokenrouter"; label: string; baseUrl: string; models: RouterModel[] }[]`
  - `validateRouterProviders(providers: RouterProvider[]): string | null`
  - `resolveRouterModel(providers: readonly RouterProvider[], model: string): { providerId: string; provider: RouterProvider; model: RouterModel } | null`
  - `routerModelDisplayId(m: RouterModel): string` (= `alias ?? name`)
  - `compactEnvForModel(model, overrides?, routerProviders?)` — new optional 3rd param
  - `migrateLegacyOpenRouter(state, secrets, nowIso): { state; secrets; changed: boolean }`
  - `cliProxyState.routerProviders: RouterProvider[]` (default `[]`); `cliProxySecrets.routerKeys: Record<string,string>` (default `{}`), `openRouterKey` now `.default(null)`

- [ ] **Step 1: Write the failing test**

Create `apps/daemon/src/router-providers.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ROUTER_PRESETS,
  type RouterProvider,
  compactEnvForModel,
  createDefaultCliProxyState,
  migrateLegacyOpenRouter,
  parseCliProxySecrets,
  parseCliProxyState,
  resolveRouterModel,
  routerProviderSchema,
  validateRouterProviders
} from "@orquester/config";

const NOW = "2026-08-04T00:00:00.000Z";

const tokenrouter: RouterProvider = {
  id: "tokenrouter",
  label: "TokenRouter",
  baseUrl: "https://api.tokenrouter.com/v1",
  preset: "tokenrouter",
  models: [{ name: "moonshotai/kimi-k3-free", contextWindow: 1_048_576, compactWindow: 450_000 }],
  keyVerifiedAt: null,
  createdAt: NOW
};
const openrouter: RouterProvider = {
  id: "openrouter",
  label: "OpenRouter",
  baseUrl: "https://openrouter.ai/api/v1",
  preset: "openrouter",
  models: [{ name: "moonshotai/kimi-k3", alias: "kimi-k3", contextWindow: 1_048_576, compactWindow: 450_000 }],
  keyVerifiedAt: null,
  createdAt: NOW
};

test("routerProviderSchema rejects bad ids, bad urls, bad model names", () => {
  assert.equal(routerProviderSchema.safeParse({ ...tokenrouter, id: "Bad_Id" }).success, false);
  assert.equal(routerProviderSchema.safeParse({ ...tokenrouter, baseUrl: "ftp://x" }).success, false);
  assert.equal(
    routerProviderSchema.safeParse({ ...tokenrouter, models: [{ name: "sp ace" }] }).success,
    false
  );
  assert.equal(routerProviderSchema.safeParse(tokenrouter).success, true);
});

test("validateRouterProviders rejects reserved/duplicate ids and cross-provider model collisions", () => {
  assert.match(validateRouterProviders([{ ...tokenrouter, id: "codex" }]) ?? "", /reserved/);
  assert.match(validateRouterProviders([tokenrouter, { ...openrouter, id: "tokenrouter" }]) ?? "", /duplicate provider id/);
  const clash = { ...openrouter, models: [{ name: "moonshotai/kimi-k3-free" }] };
  assert.match(validateRouterProviders([tokenrouter, clash]) ?? "", /moonshotai\/kimi-k3-free/);
  assert.equal(validateRouterProviders([tokenrouter, openrouter]), null);
});

test("resolveRouterModel matches name, alias, and acc-prefixed forms", () => {
  const providers = [tokenrouter, openrouter];
  assert.equal(resolveRouterModel(providers, "kimi-k3")?.providerId, "openrouter");
  assert.equal(resolveRouterModel(providers, "moonshotai/kimi-k3-free")?.providerId, "tokenrouter");
  assert.equal(resolveRouterModel(providers, "accdeadbeef/kimi-k3")?.providerId, "openrouter");
  assert.equal(resolveRouterModel(providers, "gpt-5.6-sol"), null);
});

test("compactEnvForModel resolves router models by name or alias, overrides win", () => {
  const byAlias = compactEnvForModel("kimi-k3", undefined, [openrouter]);
  assert.deepEqual(byAlias, { maxContextTokens: 1_048_576, autoCompactWindow: 450_000 });
  const byName = compactEnvForModel("moonshotai/kimi-k3", undefined, [openrouter]);
  assert.deepEqual(byName, byAlias);
  const overridden = compactEnvForModel("kimi-k3", { "kimi-k3": { compactWindow: 100_000 } }, [openrouter]);
  assert.equal(overridden?.autoCompactWindow, 100_000);
});

test("state/secrets schemas default the new fields; old files still parse", () => {
  const state = parseCliProxyState({ enabled: true });
  assert.deepEqual(state.routerProviders, []);
  const secrets = parseCliProxySecrets({ apiKey: "a", managementSecret: "m", openRouterKey: "sk-or-x" });
  assert.notEqual(secrets, "corrupt");
  if (secrets !== "corrupt") assert.deepEqual(secrets.routerKeys, {});
});

test("migrateLegacyOpenRouter seeds the openrouter provider and mirrors the key", () => {
  const state = { ...createDefaultCliProxyState(), openRouterKeyVerifiedAt: "2026-07-01T00:00:00.000Z" };
  const secrets = { apiKey: "a", managementSecret: "m", openRouterKey: "sk-or-x", routerKeys: {} };
  const out = migrateLegacyOpenRouter(state, secrets, NOW);
  assert.equal(out.changed, true);
  assert.equal(out.secrets.routerKeys["openrouter"], "sk-or-x");
  assert.equal(out.secrets.openRouterKey, "sk-or-x"); // mirror kept
  const p = out.state.routerProviders.find((x) => x.id === "openrouter");
  assert.equal(p?.models[0]?.alias, "kimi-k3");
  assert.equal(p?.keyVerifiedAt, "2026-07-01T00:00:00.000Z");
  // idempotent
  assert.equal(migrateLegacyOpenRouter(out.state, out.secrets, NOW).changed, false);
});

test("ROUTER_PRESETS ship openrouter and tokenrouter with prefilled models", () => {
  const ids = ROUTER_PRESETS.map((p) => p.preset);
  assert.deepEqual([...ids].sort(), ["openrouter", "tokenrouter"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

From `apps/daemon/`: `node --import tsx --test src/router-providers.test.ts`
Expected: FAIL — `routerProviderSchema` etc. are not exported from `@orquester/config`.

- [ ] **Step 3: Implement in `packages/config/src/index.ts`**

Insert after `MODEL_NAME_RE` (line ~745):

```ts
/** Router-provider ids are lowercase slugs; `codex`/`claude` are the OAuth pair. */
export const ROUTER_PROVIDER_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const RESERVED_ROUTER_PROVIDER_IDS = ["codex", "claude"] as const;

export const routerModelSchema = z.object({
  name: z.string().regex(MODEL_NAME_RE),
  alias: z.string().regex(MODEL_NAME_RE).optional(),
  contextWindow: z.number().int().positive().optional(),
  compactWindow: z.number().int().positive().optional(),
  compactPct: z.number().int().min(1).max(100).optional()
});
export type RouterModel = z.infer<typeof routerModelSchema>;

export const routerProviderSchema = z.object({
  id: z.string().regex(ROUTER_PROVIDER_ID_RE),
  label: z.string().min(1).max(64),
  baseUrl: z
    .string()
    .max(512)
    .refine((u) => {
      try {
        const parsed = new URL(u);
        return parsed.protocol === "http:" || parsed.protocol === "https:";
      } catch {
        return false;
      }
    }, "baseUrl must be an http(s) URL"),
  /** Provenance of the create-form prefill only — behavior always comes from the fields. */
  preset: z.enum(["openrouter", "tokenrouter"]).nullable().default(null),
  models: z.array(routerModelSchema).default([]),
  keyVerifiedAt: z.string().nullable().default(null),
  createdAt: z.string()
});
export type RouterProvider = z.infer<typeof routerProviderSchema>;

/** Shipped presets: prefill the Settings create form; plain data afterwards. */
export const ROUTER_PRESETS: readonly {
  preset: "openrouter" | "tokenrouter";
  label: string;
  baseUrl: string;
  models: RouterModel[];
}[] = [
  {
    preset: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    models: [
      { name: "moonshotai/kimi-k3", alias: "kimi-k3", contextWindow: 1_048_576, compactWindow: 450_000 }
    ]
  },
  {
    preset: "tokenrouter",
    label: "TokenRouter",
    baseUrl: "https://api.tokenrouter.com/v1",
    models: [{ name: "moonshotai/kimi-k3-free", contextWindow: 1_048_576, compactWindow: 450_000 }]
  }
];

/** Cross-provider invariants a single-record zod parse can't see. Returns an
 *  error message, or null when the array is coherent. */
export function validateRouterProviders(providers: RouterProvider[]): string | null {
  const ids = new Set<string>();
  const modelKeys = new Set<string>();
  for (const p of providers) {
    if ((RESERVED_ROUTER_PROVIDER_IDS as readonly string[]).includes(p.id)) {
      return `provider id "${p.id}" is reserved`;
    }
    if (ids.has(p.id)) return `duplicate provider id "${p.id}"`;
    ids.add(p.id);
    for (const m of p.models) {
      for (const key of m.alias ? [m.name, m.alias] : [m.name]) {
        if (modelKeys.has(key)) return `model "${key}" is served by more than one provider`;
        modelKeys.add(key);
      }
    }
  }
  return null;
}

/** Resolve a launch model (bare or acc<hex>/-prefixed, by full name or alias) to
 *  the router provider serving it. Null = not a router model. Replaces the old
 *  isOpenRouterModel regex as the single routing source of truth. */
export function resolveRouterModel(
  providers: readonly RouterProvider[],
  model: string
): { providerId: string; provider: RouterProvider; model: RouterModel } | null {
  const bare = model.replace(/^acc[0-9a-fA-F]+\//, "");
  for (const provider of providers) {
    for (const m of provider.models) {
      if (m.name === bare || m.alias === bare) {
        return { providerId: provider.id, provider, model: m };
      }
    }
  }
  return null;
}

/** The id a router model is shown/keyed under (picker chips, overrides). */
export function routerModelDisplayId(m: RouterModel): string {
  return m.alias ?? m.name;
}
```

Extend `compactEnvForModel` (line ~825) with the provider-aware branch — full replacement of the non-claude tail:

```ts
export function compactEnvForModel(
  model: string,
  overrides?: CliProxyModelOverrides,
  routerProviders?: readonly RouterProvider[]
): CompactEnv | null {
  let bare = model.replace(/^acc[0-9a-fA-F]+\//, "");
  if (bare.startsWith("claude")) {
    const override = overrides?.[bare];
    const env: CompactEnv = {
      autoCompactWindow: override?.compactWindow ?? CLAUDE_ARMING_COMPACT_WINDOW
    };
    if (override?.compactPct !== undefined) env.autoCompactPct = override.compactPct;
    return env;
  }
  // A router model resolves identically by full name or alias (config.yaml maps
  // name → alias); overrides are keyed by the display id, falling back to the name.
  const routed = routerProviders ? resolveRouterModel(routerProviders, bare) : null;
  if (routed) {
    const override = overrides?.[routerModelDisplayId(routed.model)] ?? overrides?.[routed.model.name];
    const contextWindow = override?.contextWindow ?? routed.model.contextWindow;
    if (contextWindow === undefined) return null;
    const env: CompactEnv = {
      maxContextTokens: contextWindow,
      autoCompactWindow: override?.compactWindow ?? routed.model.compactWindow ?? contextWindow
    };
    const pct = override?.compactPct ?? routed.model.compactPct;
    if (pct !== undefined) env.autoCompactPct = pct;
    return env;
  }
  bare = bare.replace(/^moonshotai\//, ""); // legacy normalization until Task 12 removes curated kimi
  const curated = CURATED_PROXY_MODELS.find((m) => m.id === bare);
  const override = overrides?.[bare];
  const contextWindow = override?.contextWindow ?? curated?.contextWindow;
  if (contextWindow === undefined) return null;
  const env: CompactEnv = {
    maxContextTokens: contextWindow,
    autoCompactWindow: override?.compactWindow ?? curated?.compactWindow ?? contextWindow
  };
  const pct = override?.compactPct ?? curated?.compactPct;
  if (pct !== undefined) env.autoCompactPct = pct;
  return env;
}
```

Schema fields — in `cliProxyStateSchema` add after `seededAccounts` (line ~897):

```ts
  /** User-defined OpenAI-compatible router providers (spec 2026-08-04 §1). */
  routerProviders: z.array(routerProviderSchema).default([]),
```

In `cliProxySecretsSchema` (line ~913) replace the body with:

```ts
export const cliProxySecretsSchema = z.object({
  apiKey: z.string(),
  managementSecret: z.string(),
  /** LEGACY mirror of routerKeys["openrouter"] — kept at rest one release for
   *  rollback safety; never read after migration. */
  openRouterKey: z.string().nullable().default(null),
  /** providerId → API key for router providers. */
  routerKeys: z.record(z.string()).default({})
});
```

Migration helper, after `parseCliProxySecrets`:

```ts
/**
 * One-time legacy migration (spec §1): a pre-router `openRouterKey` becomes the
 * seeded `openrouter` provider + routerKeys entry, preserving today's exact kimi
 * wiring. The legacy fields are left in place as an at-rest mirror. Idempotent.
 */
export function migrateLegacyOpenRouter(
  state: CliProxyState,
  secrets: CliProxySecrets,
  nowIso: string
): { state: CliProxyState; secrets: CliProxySecrets; changed: boolean } {
  let changed = false;
  let nextSecrets = secrets;
  if (secrets.openRouterKey && !secrets.routerKeys["openrouter"]) {
    nextSecrets = {
      ...secrets,
      routerKeys: { ...secrets.routerKeys, openrouter: secrets.openRouterKey }
    };
    changed = true;
  }
  let nextState = state;
  if (nextSecrets.routerKeys["openrouter"] && !state.routerProviders.some((p) => p.id === "openrouter")) {
    nextState = {
      ...state,
      routerProviders: [
        ...state.routerProviders,
        {
          id: "openrouter",
          label: "OpenRouter",
          baseUrl: "https://openrouter.ai/api/v1",
          preset: "openrouter",
          models: [
            { name: "moonshotai/kimi-k3", alias: "kimi-k3", contextWindow: 1_048_576, compactWindow: 450_000 }
          ],
          keyVerifiedAt: state.openRouterKeyVerifiedAt,
          createdAt: nowIso
        }
      ]
    };
    changed = true;
  }
  return { state: nextState, secrets: nextSecrets, changed };
}
```

- [ ] **Step 4: Run test to verify it passes**

`node --import tsx --test src/router-providers.test.ts` → all pass. Then `pnpm check` from root → clean.

- [ ] **Step 5: Commit**

```bash
git add packages/config/src/index.ts apps/daemon/src/router-providers.test.ts
git commit -m "feat(config): router-provider schemas, presets, resolution, legacy migration"
```

---

### Task 2: Secrets store — routerKeys writes with legacy mirror

**Files:**
- Modify: `apps/daemon/src/cliproxy-secrets.ts`
- Test: `apps/daemon/src/cliproxy-secrets.test.ts` (extend)

**Interfaces:**
- Produces: `setRouterKey(daemonDir, providerId, key): Promise<CliProxySecrets>`, `clearRouterKey(daemonDir, providerId): Promise<CliProxySecrets>`, `writeSecrets(daemonDir, secrets): Promise<void>` (used by migration in Task 5). Existing `setOpenRouterKey` becomes a thin wrapper (deleted in Task 12).

- [ ] **Step 1: Write failing tests** (append to `cliproxy-secrets.test.ts`)

```ts
test("setRouterKey stores under routerKeys and mirrors openrouter into the legacy field", async () => {
  const dir = await makeDir();
  await loadOrInitSecrets(dir);
  const a = await setRouterKey(dir, "tokenrouter", "sk-tr-1");
  assert.equal(a.routerKeys["tokenrouter"], "sk-tr-1");
  assert.equal(a.openRouterKey, null); // non-openrouter never touches the mirror
  const b = await setRouterKey(dir, "openrouter", "sk-or-1");
  assert.equal(b.routerKeys["openrouter"], "sk-or-1");
  assert.equal(b.openRouterKey, "sk-or-1"); // mirror maintained
});

test("clearRouterKey removes the key and clears the openrouter mirror", async () => {
  const dir = await makeDir();
  await loadOrInitSecrets(dir);
  await setRouterKey(dir, "openrouter", "sk-or-1");
  const cleared = await clearRouterKey(dir, "openrouter");
  assert.equal(cleared.routerKeys["openrouter"], undefined);
  assert.equal(cleared.openRouterKey, null);
});
```

- [ ] **Step 2: Run** `node --import tsx --test src/cliproxy-secrets.test.ts` → FAIL (not exported).

- [ ] **Step 3: Implement** in `cliproxy-secrets.ts` (replace `setOpenRouterKey`'s body region):

```ts
/** Rewrite the whole secrets file with the standard hardening (corrupt store throws). */
export async function writeSecrets(daemonDir: string, secrets: CliProxySecrets): Promise<void> {
  await writeSecretFile(cliproxySecretsFile(daemonDir), JSON.stringify(secrets, null, 2), 0o600);
}

async function loadForMutation(daemonDir: string): Promise<CliProxySecrets> {
  const loaded = await loadOrInitSecrets(daemonDir);
  if (loaded.state === "corrupt") {
    throw new Error("cliproxy secrets are corrupt; refusing to overwrite");
  }
  return loaded.secrets;
}

/** Set a router provider's API key. `openrouter` also maintains the legacy
 *  at-rest mirror (`openRouterKey`) for one-release rollback safety. */
export async function setRouterKey(
  daemonDir: string,
  providerId: string,
  key: string
): Promise<CliProxySecrets> {
  const secrets = await loadForMutation(daemonDir);
  const next: CliProxySecrets = {
    ...secrets,
    routerKeys: { ...secrets.routerKeys, [providerId]: key },
    ...(providerId === "openrouter" ? { openRouterKey: key } : {})
  };
  await writeSecrets(daemonDir, next);
  return next;
}

/** Remove a router provider's API key (and the legacy mirror for `openrouter`). */
export async function clearRouterKey(daemonDir: string, providerId: string): Promise<CliProxySecrets> {
  const secrets = await loadForMutation(daemonDir);
  const routerKeys = { ...secrets.routerKeys };
  delete routerKeys[providerId];
  const next: CliProxySecrets = {
    ...secrets,
    routerKeys,
    ...(providerId === "openrouter" ? { openRouterKey: null } : {})
  };
  await writeSecrets(daemonDir, next);
  return next;
}

/** LEGACY wrapper — callers migrate to setRouterKey; deleted in cleanup (Task 12). */
export async function setOpenRouterKey(daemonDir: string, key: string): Promise<CliProxySecrets> {
  return setRouterKey(daemonDir, "openrouter", key);
}
```

- [ ] **Step 4: Run** the file's tests + `pnpm check` → pass/clean.
- [ ] **Step 5: Commit** — `git commit -m "feat(daemon): routerKeys secrets writes with legacy openrouter mirror"`

---

### Task 3: config.yaml projection + Fable slot + managed-agent gating

**Files:**
- Modify: `apps/daemon/src/cliproxy-files.ts` (`renderConfigYaml` :57-91, `writeProjections` claudex Fable block :164-170, `MANAGED_AGENTS` gating :345-439)
- Test: `apps/daemon/src/cliproxy-files.test.ts` (extend)

**Interfaces:**
- Produces: `routerKimiAvailable(state: CliProxyState, secrets: CliProxySecrets): boolean` (exported; Task 4 uses it from `cliproxy.ts` `seedHomes`). `renderConfigYaml(secrets, state)` signature unchanged.
- Renames the `openRouterGated`/`openRouterKimi` flags to `kimiGated`/`kimiAvailable` (same semantics: `undefined` = unknown → don't churn).

- [ ] **Step 1: Failing tests** (append to `cliproxy-files.test.ts`; reuse its `secrets` fixture, adding `routerKeys`):

```ts
test("renderConfigYaml emits one openai-compatibility entry per keyed provider with models", () => {
  const state = {
    ...createDefaultCliProxyState(),
    routerProviders: [
      { id: "openrouter", label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", preset: "openrouter" as const,
        models: [{ name: "moonshotai/kimi-k3", alias: "kimi-k3" }], keyVerifiedAt: null, createdAt: "t" },
      { id: "tokenrouter", label: "TokenRouter", baseUrl: "https://api.tokenrouter.com/v1", preset: "tokenrouter" as const,
        models: [{ name: "moonshotai/kimi-k3-free" }], keyVerifiedAt: null, createdAt: "t" },
      { id: "keyless", label: "NoKey", baseUrl: "https://x.example/v1", preset: null,
        models: [{ name: "m/x" }], keyVerifiedAt: null, createdAt: "t" }
    ]
  };
  const s = { ...secrets, routerKeys: { openrouter: "sk-or-1", tokenrouter: "sk-tr-1" } };
  const yaml = renderConfigYaml(s, state);
  assert.match(yaml, /name: "openrouter"/);
  assert.match(yaml, /base-url: "https:\/\/api\.tokenrouter\.com\/v1"/);
  assert.match(yaml, /alias: "kimi-k3"/);
  assert.doesNotMatch(yaml, /keyless/); // keyless provider skipped
  // models stays PROVIDER-level: exactly one indent level under the provider item
  assert.match(yaml, /    models:\n      - name: "moonshotai\/kimi-k3"/);
});

test("claudex.env Fable slot follows kimi-k3 availability across providers", async () => {
  // provider serving alias kimi-k3 + key present → Fable rows present with the provider label
  // no provider serving kimi-k3 → no Fable rows (assert on the file writeProjections wrote)
});
```

(Write the second test fully in the style of the existing `writeProjections` tests in this file — tmp dir, run `writeProjections`, read `env/claudex.env`, assert `ANTHROPIC_DEFAULT_FABLE_MODEL=kimi-k3` presence/absence and `Moonshot Kimi via OpenRouter` label text.)

- [ ] **Step 2: Run** `node --import tsx --test src/cliproxy-files.test.ts` → FAIL.

- [ ] **Step 3: Implement**

Replace the `if (secrets.openRouterKey) {...}` block in `renderConfigYaml` with:

```ts
  const keyed = state.routerProviders.filter(
    (p) => Boolean(secrets.routerKeys[p.id]) && p.models.length > 0
  );
  if (keyed.length > 0) {
    lines.push("openai-compatibility:");
    for (const p of keyed) {
      lines.push(
        `  - name: ${JSON.stringify(p.id)}`,
        `    base-url: ${JSON.stringify(p.baseUrl)}`,
        "    api-key-entries:",
        `      - api-key: ${JSON.stringify(secrets.routerKeys[p.id])}`,
        // `models` is a PROVIDER-level key (sibling of api-key-entries). Nested
        // under an entry it parses fine but registers ZERO models — the provider
        // loads and every request 502s "unknown provider for model <alias>".
        "    models:"
      );
      for (const m of p.models) {
        lines.push(`      - name: ${JSON.stringify(m.name)}`);
        if (m.alias) lines.push(`        alias: ${JSON.stringify(m.alias)}`);
      }
    }
  }
```

Add the availability helper (export, near the top):

```ts
/** True when some keyed router provider serves the `kimi-k3` pick (name or alias) —
 *  the Fable-slot / managed-kimi gate, preserving the legacy OpenRouter behavior. */
export function routerKimiAvailable(state: CliProxyState, secrets: CliProxySecrets): boolean {
  return state.routerProviders.some(
    (p) =>
      Boolean(secrets.routerKeys[p.id]) &&
      p.models.some((m) => m.name === "kimi-k3" || m.alias === "kimi-k3")
  );
}
```

In `writeProjections`, validate router models before writing (next to the existing `assertModel` calls):

```ts
  for (const p of state.routerProviders) {
    for (const m of p.models) {
      assertModel(m.name, `router ${p.id}`);
      if (m.alias) assertModel(m.alias, `router ${p.id} alias`);
    }
  }
```

and replace the Fable block (`...(secrets.openRouterKey ? ...)`) with:

```ts
    ...(routerKimiAvailable(state, secrets)
      ? ([
          ["ANTHROPIC_DEFAULT_FABLE_MODEL", "kimi-k3"],
          ["ANTHROPIC_DEFAULT_FABLE_MODEL_NAME", "Kimi K3"],
          [
            "ANTHROPIC_DEFAULT_FABLE_MODEL_DESCRIPTION",
            `Moonshot Kimi via ${
              state.routerProviders.find((p) => p.models.some((m) => m.name === "kimi-k3" || m.alias === "kimi-k3"))?.label ?? "router"
            }`
          ]
        ] as Array<[string, string]>)
      : []),
```

Rename `openRouterGated` → `kimiGated` in `MANAGED_AGENTS` and `openRouterKimi` → `kimiAvailable` in `renderManagedMemory` / `seedManagedMemory` / `seedManagedAgents` (semantics unchanged, incl. the `undefined` = don't-churn rule). Update their call sites inside this file; the `cliproxy.ts` caller updates in Task 4.

- [ ] **Step 4: Run** file tests + `pnpm check`. `pnpm check` will fail if `cliproxy.ts` passes the old param name — if so, adjust the `seedHomes` call site minimally now (`Boolean(this.secrets?.openRouterKey)` still compiles as the new boolean param).
- [ ] **Step 5: Commit** — `git commit -m "feat(daemon): multi-provider config.yaml projection and data-driven kimi gating"`

---### Task 4: Manager — migration wiring, probe union, provider statuses, coupling, verification

**Files:**
- Modify: `apps/daemon/src/cliproxy.ts`
- Modify: `packages/api/src/index.ts` (wire types :813-842)
- Test: `apps/daemon/src/cliproxy-manager.test.ts` (extend/adjust)

**Interfaces:**
- Produces (wire, used by Tasks 6/8–11):

```ts
// packages/api
export type CliProxyProviderId = "codex" | "claude";
export interface CliProxyRouterModel {
  name: string; alias?: string; contextWindow?: number; compactWindow?: number; compactPct?: number;
}
export interface CliProxyRouterProviderStatus {
  id: string; label: string; preset: "openrouter" | "tokenrouter" | null; baseUrl: string;
  models: CliProxyRouterModel[]; keyState: "none" | "set" | "verified"; keyVerifiedAt: string | null;
}
// CliProxyStatus gains: routerProviders: CliProxyRouterProviderStatus[];
```

- Adapters: `verifyOpenRouterKey?` is **replaced** by `verifyRouterKey?(provider: RouterProvider, key: string): Promise<"ok"|"rejected"|"unknown">` and a new `fetchRouterModels?(provider: RouterProvider, key: string): Promise<{ok:true; models:string[]} | {ok:false; error:string}>`.

- [ ] **Step 1: Failing tests** (extend `cliproxy-manager.test.ts`, using its existing fake-adapter harness):
  - `status().routerProviders` reports `keyState` "none"/"set"/"verified" from routerKeys + keyVerifiedAt.
  - `init()` on a store with a legacy `openRouterKey` (and `enabled:true`) migrates: `status().routerProviders` contains `openrouter`, and the persisted secrets file gained `routerKeys.openrouter` while keeping `openRouterKey`.
  - probe union: with a keyed provider whose model has alias `kimi-k3`, the stored catalog includes both `moonshotai/kimi-k3` and `kimi-k3`.
  - coupling: no codex account + one keyed router provider with models → `claudex` enabled; remove the key → disabled with reason `"no codex or router credential"`.

- [ ] **Step 2: Run** `node --import tsx --test src/cliproxy-manager.test.ts` → new tests FAIL.

- [ ] **Step 3: Implement** in `cliproxy.ts`:

1. **API types first** (`packages/api/src/index.ts`): apply the Interfaces block above — shrink `CliProxyProviderId`, add the two new interfaces, add `routerProviders` to `CliProxyStatus`.
2. Imports: add `migrateLegacyOpenRouter, resolveRouterModel, type RouterProvider` from `@orquester/config`, `routerKimiAvailable` from `./cliproxy-files.ts`, `writeSecrets` from `./cliproxy-secrets.ts`; drop the `OPENROUTER_ALIAS_MODELS` import.
3. **Migration** — private method, called from `init()` right after `this.secrets = loaded.secrets;` (line ~207) and identically in `enable()` (line ~231):

```ts
  /** Legacy openRouterKey → router-provider migration (spec §1). Idempotent;
   *  persists both files only when something changed. */
  private async migrateLegacy(): Promise<void> {
    if (!this.secrets) return;
    const out = migrateLegacyOpenRouter(this.state, this.secrets, new Date(this.adapters.now()).toISOString());
    if (!out.changed) return;
    this.state = out.state;
    this.secrets = out.secrets;
    await writeSecrets(this.daemonDir, this.secrets);
    await this.persist();
  }
```

4. **probe()** (line ~814) — replace the alias-union block:

```ts
    if (result.ok && this.secrets) {
      const models = new Set(result.models ?? []);
      for (const p of this.state.routerProviders) {
        if (!this.secrets.routerKeys[p.id]) continue;
        // CLIProxyAPI routes configured names/aliases but doesn't reliably list
        // them — union both so catalog, validateModel and preflight all see them.
        for (const m of p.models) {
          models.add(m.name);
          if (m.alias) models.add(m.alias);
        }
      }
      return { ...result, models: [...models] };
    }
    return result;
```

5. **hasProviderInfo / providerState / providerStatuses** (lines ~1116-1158): drop every `openrouter` branch — `providerState(provider: CliProxyProviderId)` keeps only the codex/claude logic; `providerStatuses()` maps over `["codex","claude"]`. Add:

```ts
  private hasProviderInfo(): boolean {
    return this.seededAccounts.size > 0 || this.keyedRouterCount() > 0;
  }

  private keyedRouterCount(): number {
    if (!this.secrets) return 0;
    return this.state.routerProviders.filter(
      (p) => Boolean(this.secrets?.routerKeys[p.id]) && p.models.length > 0
    ).length;
  }

  private routerProviderStatuses(): CliProxyRouterProviderStatus[] {
    return this.state.routerProviders.map((p) => ({
      id: p.id,
      label: p.label,
      preset: p.preset,
      baseUrl: p.baseUrl,
      models: p.models,
      // Parity note: with the proxy disabled, secrets are not loaded and keyState
      // reads "none" — same off-state behavior the legacy openrouter row had.
      keyState: this.secrets?.routerKeys[p.id] ? (p.keyVerifiedAt ? "verified" : "set") : "none",
      keyVerifiedAt: p.keyVerifiedAt
    }));
  }
```

6. **status()** (line ~164): add `routerProviders: this.routerProviderStatuses(),`.
7. **applyRegistryCoupling()** (line ~902): replace `openrouterOk` with `const routerOk = this.keyedRouterCount() > 0;`, condition `codexOk || routerOk`, reason string `"no codex or router credential"`.
8. **Adapters** (interface :71-107): delete `verifyOpenRouterKey?`, add:

```ts
  /** Verify a router provider key. openrouter-preset providers use the precise
   *  GET /key endpoint; everything else GETs `${baseUrl}/models`. "rejected" =
   *  explicit 401/403; "unknown" = network/timeout — store unverified. */
  verifyRouterKey?(provider: RouterProvider, key: string): Promise<"ok" | "rejected" | "unknown">;
  /** Fetch a provider's /models catalog with the stored key (catalog route). */
  fetchRouterModels?(
    provider: RouterProvider,
    key: string
  ): Promise<{ ok: true; models: string[] } | { ok: false; error: string }>;
```

9. **refreshOpenRouterVerification** (line ~850) → rename `refreshRouterVerification`, new body (update its call site(s) — grep `refreshOpenRouterVerification`):

```ts
  private async refreshRouterVerification(): Promise<void> {
    if (!this.secrets || !this.adapters.verifyRouterKey) return;
    for (const p of this.state.routerProviders) {
      const key = this.secrets.routerKeys[p.id];
      if (!key || p.keyVerifiedAt) continue;
      const verdict = await this.adapters.verifyRouterKey(p, key);
      if (verdict === "ok") {
        p.keyVerifiedAt = new Date(this.adapters.now()).toISOString();
        if (p.id === "openrouter") this.state.openRouterKeyVerifiedAt = p.keyVerifiedAt; // legacy mirror
      }
    }
  }
```

10. `syncSeededCredentials` (line ~1021): delete the now-type-invalid `if (account.provider === "openrouter") continue;` line. `SeededAccount.provider` (`:58`) is already effectively codex/claude.
11. `seedHomes` call sites: pass `this.secrets ? routerKimiAvailable(this.state, this.secrets) : undefined` as the `kimiAvailable` argument (grep `seedManagedAgents`/`seedHome` call sites in this file).
12. `setOpenRouterKey` manager method (line ~407): leave compiling for now by updating only its internals that broke (it is deleted in Task 5's replacement).

- [ ] **Step 4: Run** manager tests + `pnpm check`. UI references to `openrouter` as a `CliProxyProviderId` will now fail typecheck — expected; fix forward-compatibly by adjusting **only type errors** in `ModelProxySettings.tsx` minimally (cast/filter), since Task 10 rewrites it. Keep the build green.
- [ ] **Step 5: Commit** — `git commit -m "feat(daemon): data-driven router status, coupling, probe union, migration wiring"`

---

### Task 5: Manager — router mutations (upsert/delete/key/catalog)

**Files:**
- Modify: `apps/daemon/src/cliproxy.ts`
- Test: `apps/daemon/src/cliproxy-manager.test.ts` (extend)

**Interfaces:**
- Produces (route surface for Task 7):

```ts
upsertRouterProvider(
  input: { id: string; label: string; baseUrl: string; preset?: "openrouter"|"tokenrouter"|null; models: RouterModel[] },
  force: boolean
): Promise<{ ok: boolean; affectedSessions?: number; error?: string }>
deleteRouterProvider(id: string, force: boolean): Promise<{ ok: boolean; affectedSessions?: number; error?: string }>
setRouterKey(id: string, key: string, force: boolean): Promise<{ ok: boolean; affectedSessions?: number; error?: string }>
clearRouterKey(id: string, force: boolean): Promise<{ ok: boolean; affectedSessions?: number; error?: string }>
fetchRouterCatalog(id: string): Promise<{ ok: true; models: string[] } | { ok: false; code: "unknown" | "no-key" | "upstream"; error: string }>
```
- Removes the manager's `setOpenRouterKey` method.

- [ ] **Step 1: Failing tests** — extend the fake-adapter harness:
  - upsert validates (reserved id → error; duplicate cross-provider model → error) and persists; a keyed provider mutation while running with live sessions → `{ok:false, affectedSessions}`; with `force` → restarts (fake spawn called).
  - `setRouterKey` refuses on adapter `"rejected"`, stamps `keyVerifiedAt` on `"ok"`, stores-unverified on `"unknown"`; openrouter also updates the legacy state mirror.
  - `clearRouterKey` then `status()` shows `keyState:"none"` and claudex coupling drops (when no codex).
  - `deleteRouterProvider` removes provider + key; a `defaultModel` that pointed at its model resets to `"gpt-5.6-sol"`.
  - `fetchRouterCatalog` returns `no-key` without a key and proxies the adapter result with one.

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement.** Shared plumbing (private):

```ts
  /** Reset model picks that no longer resolve (spec §4): a pick is valid if
   *  curated or served by a current keyed router provider. */
  private resetDanglingModelPicks(): void {
    const valid = (m: string): boolean =>
      CURATED_PROXY_MODEL_IDS.includes(m) ||
      Boolean(this.secrets && resolveRouterModel(this.keyedProviders(), m));
    if (!valid(this.state.defaultModel)) this.state.defaultModel = "gpt-5.6-sol";
    if (!valid(this.state.backgroundModel)) this.state.backgroundModel = "gpt-5.6-luna";
  }

  private keyedProviders(): RouterProvider[] {
    if (!this.secrets) return [];
    return this.state.routerProviders.filter((p) => Boolean(this.secrets?.routerKeys[p.id]));
  }

  /** The shared tail of every router mutation: projections → reresolve →
   *  restart-if-running → coupling → broadcast → persist. Mirrors setConfig. */
  private async afterRouterMutation(needsRestart: boolean): Promise<void> {
    await this.seedHomes();
    if (this.state.enabled && this.secrets) {
      await writeProjections(this.daemonDir, this.secrets, this.state);
      await this.reresolveDependents();
      if (needsRestart) {
        this.setState("starting", []);
        await this.spawn(true);
        const probed = await this.probeUntilReady();
        if (probed.ok) this.becomeHealthy(probed.models);
        else this.fail("proxy down");
      }
    }
    this.applyRegistryCoupling();
    this.broadcaster.publish("cliproxy", "cliproxy.changed", this.status());
    await this.persist();
  }
```

The four mutations, each `return this.transition(async () => { ... })` exactly like `setConfig` (:407-449 pattern):

```ts
  upsertRouterProvider(
    input: { id: string; label: string; baseUrl: string; preset?: "openrouter" | "tokenrouter" | null; models: RouterModel[] },
    force: boolean
  ): Promise<{ ok: boolean; affectedSessions?: number; error?: string }> {
    return this.transition(async () => {
      const existing = this.state.routerProviders.find((p) => p.id === input.id);
      const candidate = routerProviderSchema.safeParse({
        ...input,
        preset: input.preset ?? existing?.preset ?? null,
        keyVerifiedAt: existing?.keyVerifiedAt ?? null,
        createdAt: existing?.createdAt ?? new Date(this.adapters.now()).toISOString()
      });
      if (!candidate.success) return { ok: false, error: "invalid provider: " + candidate.error.issues[0]?.message };
      const next = [
        ...this.state.routerProviders.filter((p) => p.id !== input.id),
        candidate.data
      ];
      const invalid = validateRouterProviders(next);
      if (invalid) return { ok: false, error: invalid };
      // Only a KEYED provider is rendered into config.yaml, so only that needs a restart.
      const keyed = Boolean(this.secrets?.routerKeys[input.id]);
      const needsRestart = this.st !== "off" && keyed;
      const live = this.adapters.liveDependentSessionCount();
      if (needsRestart && !force && live > 0) return { ok: false, affectedSessions: live };
      this.state.routerProviders = next;
      this.resetDanglingModelPicks();
      await this.afterRouterMutation(needsRestart);
      return { ok: true, affectedSessions: force && needsRestart ? live : 0 };
    });
  }
```

`deleteRouterProvider(id, force)`: unknown id → `{ok:false, error:"unknown provider"}`; `needsRestart = this.st !== "off" && keyed`; on proceed `this.secrets = await clearRouterKey(this.daemonDir, id)` (import from `./cliproxy-secrets.ts`), filter the provider out of `state.routerProviders`, `resetDanglingModelPicks()`, `afterRouterMutation(needsRestart)`.

`setRouterKey(id, key, force)`: unknown id → error. Verify-before-store via `this.adapters.verifyRouterKey?.(provider, key)` with the exact semantics of the old `setOpenRouterKey` (:417-427): `"rejected"` → `{ok:false, error: \`${provider.label} rejected this key\`}`; `"ok"` → stamp `provider.keyVerifiedAt` (+ legacy `state.openRouterKeyVerifiedAt` mirror when `id === "openrouter"`); `"unknown"`/absent adapter → `keyVerifiedAt = null`. Then `this.secrets = await setRouterKeySecrets(...)` — import `setRouterKey as setRouterKeySecrets` from `./cliproxy-secrets.ts` — and `afterRouterMutation(this.st !== "off")`.

`clearRouterKey(id, force)`: like delete but keeps the provider record; `keyVerifiedAt = null` (+ mirror null), `resetDanglingModelPicks()`.

`fetchRouterCatalog(id)` — **not** on the transition queue (read-only, like `validateModel`):

```ts
  async fetchRouterCatalog(
    id: string
  ): Promise<{ ok: true; models: string[] } | { ok: false; code: "unknown" | "no-key" | "upstream"; error: string }> {
    const provider = this.state.routerProviders.find((p) => p.id === id);
    if (!provider) return { ok: false, code: "unknown", error: "unknown provider" };
    if (!this.secrets) {
      const loaded = await loadOrInitSecrets(this.daemonDir);
      if (loaded.state !== "corrupt") this.secrets = loaded.secrets;
    }
    const key = this.secrets?.routerKeys[id];
    if (!key) return { ok: false, code: "no-key", error: "no API key stored for this provider" };
    if (!this.adapters.fetchRouterModels) return { ok: false, code: "upstream", error: "catalog fetch unavailable" };
    const res = await this.adapters.fetchRouterModels(provider, key);
    return res.ok ? res : { ok: false, code: "upstream", error: res.error };
  }
```

Delete the manager's `setOpenRouterKey` method (:407-449).

- [ ] **Step 4: Run** manager tests + `pnpm check` (route/UI callers of `setOpenRouterKey` will break — patch them minimally to keep green, Tasks 7/9 rewrite them properly; if the interim patch is awkward, do Task 7's route change in this commit instead).
- [ ] **Step 5: Commit** — `git commit -m "feat(daemon): router provider mutations and catalog fetch on the manager"`

---

### Task 6: Launch path — contributor, session-create gate, compact env

**Files:**
- Modify: `apps/daemon/src/index.ts` (`cliproxyContributor` :826-900, session-create gate :2958-2973)
- Test: `apps/daemon/src/session-launch-env.test.ts` (extend), `apps/daemon/src/session-model.test.ts` (adjust if it references kimi)

**Interfaces:**
- Consumes: `resolveRouterModel`, `compactEnvForModel(model, overrides, routerProviders)` from Task 1; `readCliProxyState` already parses `routerProviders`.
- No signature changes to `cliproxyContributor` / `buildAgentLaunchEnv`.

- [ ] **Step 1: Failing tests** — in `session-launch-env.test.ts` (it already fabricates a state file on disk for `cliproxyContributor`; extend the fixture state with a `routerProviders` array):
  - a TokenRouter model (`moonshotai/kimi-k3-free`) with a picked account → emitted **bare** (no `acc<hex>/` prefix), `accountId` not pinned, and `CLAUDE_CODE_MAX_CONTEXT_TOKENS=1048576` / `CLAUDE_CODE_AUTO_COMPACT_WINDOW=450000` from the provider model entry.
  - a non-router model with a multi-seeded account keeps the prefix (regression).

- [ ] **Step 2: Run** → FAIL (still regex-routed; compact env unresolved for the -free model).

- [ ] **Step 3: Implement** in `index.ts`:
  - Import `resolveRouterModel` from `@orquester/config` (keep `isOpenRouterModel` imported until Task 12 removes the last callers).
  - `:848-849`:

```ts
    const routesToAccount =
      Boolean(ctx.accountId) &&
      ctx.accountId !== SYSTEM_ACCOUNT_ID &&
      !resolveRouterModel(state?.routerProviders ?? [], ctx.model);
```

  - `:886`: `const compact = compactEnvForModel(compactModel, state?.modelOverrides, state?.routerProviders);`
  - Session-create gate `:2962`: the condition becomes

```ts
      !(effectiveModel && resolveRouterModel(readCliProxyState(resolved.daemonDir)?.routerProviders ?? [], effectiveModel))
```

  (hoist the `readCliProxyState` call: the block at `:2964` already reads it — read once above the `if` into `const launchState` and use it for both the router check and the `seededAccounts` check.)

- [ ] **Step 4: Run** the two test files + `pnpm check` → pass/clean.
- [ ] **Step 5: Commit** — `git commit -m "feat(daemon): route launches through the router-model index instead of the kimi regex"`

---

### Task 7: HTTP routes + reference client

**Files:**
- Modify: `apps/daemon/src/index.ts` (`CliProxyRouteManager` :997-1019, `registerCliProxyRoutes` :1046-1254, `verifyOpenRouterKey` :981-993, adapter wiring :603)
- Modify: `packages/api/src/index.ts` (client methods :1252-1260, request types)
- Test: `apps/daemon/src/cliproxy-config.test.ts` (route tests — extend in its existing fake-manager style)

**Interfaces:**
- Produces routes:
  - `PUT /api/cliproxy/providers/:id` body `{label, baseUrl, preset?, models, force?}` → `CliProxyStatus` | 400 `{error}` | 409 refusal
  - `DELETE /api/cliproxy/providers/:id?force=true` → `CliProxyStatus` | 404 | 409
  - `POST /api/cliproxy/providers/:id/key` body `{key, force?}` → `{ok:true, affectedSessions}` | 400 | 409
  - `DELETE /api/cliproxy/providers/:id/key?force=true` → `{ok:true, affectedSessions}` | 404 | 409
  - `GET /api/cliproxy/providers/:id/catalog` → `{models: string[]}` | 404 | 409 (`no-key`) | 502 `{error}`
  - **Deletes** `POST /api/cliproxy/openrouter/key`.
- Produces client methods (packages/api `HttpOrquesterApiClient`):

```ts
putCliProxyRouterProvider(id: string, cfg: CliProxyRouterProviderRequest, force?: boolean): Promise<CliProxyStatus | CliProxyMutationRefusal>
deleteCliProxyRouterProvider(id: string, force?: boolean): Promise<CliProxyStatus | CliProxyMutationRefusal>
setCliProxyRouterKey(id: string, key: string, force?: boolean): Promise<{ ok: boolean; affectedSessions?: number }>
clearCliProxyRouterKey(id: string, force?: boolean): Promise<{ ok: boolean; affectedSessions?: number }>
getCliProxyRouterCatalog(id: string): Promise<{ models: string[] }>
```

with `export interface CliProxyRouterProviderRequest { label: string; baseUrl: string; preset?: "openrouter"|"tokenrouter"|null; models: CliProxyRouterModel[] }`.

- [ ] **Step 1: Failing route tests** (fake `CliProxyRouteManager` gains the five Task-5 methods): PUT validates id charset (400 on `"Bad_Id"`), socket mode 403s every mutation, catalog `no-key` → 409, upstream failure → 502, unknown id → 404, and the old `/api/cliproxy/openrouter/key` now 404s.

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement.**

Route manager interface: replace `setOpenRouterKey` with the five Task-5 signatures. Routes (inside `registerCliProxyRoutes`, replacing the openrouter/key route):

```ts
  const ROUTER_ID_OK = (id: string): boolean => ROUTER_PROVIDER_ID_RE.test(id);

  app.put<{ Params: { id: string } }>("/api/cliproxy/providers/:id", async (request, reply) => {
    if (refusedOnSocket(reply)) return;
    const id = request.params.id;
    if (!ROUTER_ID_OK(id)) return reply.code(400).send({ error: "invalid provider id" });
    const body = (request.body ?? {}) as Partial<CliProxyRouterProviderRequest> & { force?: boolean };
    if (typeof body.label !== "string" || typeof body.baseUrl !== "string" || !Array.isArray(body.models)) {
      return reply.code(400).send({ error: "label, baseUrl and models are required" });
    }
    const res = await manager.upsertRouterProvider(
      { id, label: body.label, baseUrl: body.baseUrl, preset: body.preset ?? null, models: body.models as RouterModel[] },
      Boolean(body.force)
    );
    if (!res.ok) {
      if (res.error) return reply.code(400).send({ error: res.error });
      return reply.code(409).send({ ok: false, affectedSessions: res.affectedSessions });
    }
    return manager.status();
  });

  app.delete<{ Params: { id: string }; Querystring: { force?: string } }>(
    "/api/cliproxy/providers/:id",
    async (request, reply) => {
      if (refusedOnSocket(reply)) return;
      const res = await manager.deleteRouterProvider(request.params.id, request.query.force === "true");
      if (!res.ok) {
        if (res.error) return reply.code(404).send({ error: res.error });
        return reply.code(409).send({ ok: false, affectedSessions: res.affectedSessions });
      }
      return manager.status();
    }
  );

  app.post<{ Params: { id: string } }>("/api/cliproxy/providers/:id/key", async (request, reply) => {
    if (refusedOnSocket(reply)) return;
    const body = (request.body ?? {}) as { key?: string; force?: boolean };
    const key = typeof body.key === "string" ? body.key.trim() : "";
    if (!key) return reply.code(400).send({ error: "key is required" });
    const res = await manager.setRouterKey(request.params.id, key, Boolean(body.force));
    if (!res.ok) {
      if (res.error) return reply.code(400).send({ error: res.error });
      return reply.code(409).send({ ok: false, affectedSessions: res.affectedSessions });
    }
    return { ok: true, affectedSessions: res.affectedSessions ?? 0 };
  });

  app.delete<{ Params: { id: string }; Querystring: { force?: string } }>(
    "/api/cliproxy/providers/:id/key",
    async (request, reply) => {
      if (refusedOnSocket(reply)) return;
      const res = await manager.clearRouterKey(request.params.id, request.query.force === "true");
      if (!res.ok) {
        if (res.error) return reply.code(404).send({ error: res.error });
        return reply.code(409).send({ ok: false, affectedSessions: res.affectedSessions });
      }
      return { ok: true, affectedSessions: res.affectedSessions ?? 0 };
    }
  );

  // Read-only; allowed on both transports like the other GET routes.
  app.get<{ Params: { id: string } }>("/api/cliproxy/providers/:id/catalog", async (request, reply) => {
    const res = await manager.fetchRouterCatalog(request.params.id);
    if (!res.ok) {
      if (res.code === "unknown") return reply.code(404).send({ error: res.error });
      if (res.code === "no-key") return reply.code(409).send({ error: res.error });
      return reply.code(502).send({ error: res.error });
    }
    return { models: res.models };
  });
```

Replace the module-level `verifyOpenRouterKey` (:981) with the generic pair and rewire the adapter (:603):

```ts
/** Verify a router key: openrouter's precise GET /key when the preset says so,
 *  otherwise an authed GET {baseUrl}/models. Only explicit 401/403 rejects. */
async function verifyRouterKey(provider: RouterProvider, key: string): Promise<"ok" | "rejected" | "unknown"> {
  const url =
    provider.preset === "openrouter"
      ? "https://openrouter.ai/api/v1/key"
      : `${provider.baseUrl.replace(/\/+$/, "")}/models`;
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(5000) });
    if (res.status === 200) return "ok";
    if (res.status === 401 || res.status === 403) return "rejected";
    return "unknown";
  } catch {
    return "unknown";
  }
}

/** Fetch a router provider's OpenAI-style /models catalog with the stored key. */
async function fetchRouterModels(
  provider: RouterProvider,
  key: string
): Promise<{ ok: true; models: string[] } | { ok: false; error: string }> {
  try {
    const res = await fetch(`${provider.baseUrl.replace(/\/+$/, "")}/models`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(8000)
    });
    if (res.status !== 200) return { ok: false, error: `upstream responded ${res.status}` };
    const body = (await res.json().catch(() => null)) as { data?: Array<{ id?: unknown }> } | null;
    const models = Array.isArray(body?.data)
      ? body.data.map((m) => m.id).filter((id): id is string => typeof id === "string")
      : [];
    return { ok: true, models };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
```

Adapter wiring at :603: `verifyOpenRouterKey,` → `verifyRouterKey, fetchRouterModels,`.

Reference client (`packages/api`): replace `setCliProxyOpenRouterKey` with the five methods (same `mutateAllowingRefusal`/`get`/`delete` patterns as :1237-1260; DELETE routes pass force via query string).

- [ ] **Step 4: Run** route tests + `pnpm check`.
- [ ] **Step 5: Commit** — `git commit -m "feat(daemon,api): router provider CRUD, key and catalog routes; drop openrouter/key route"`

---

### Task 8: UI plumbing — ApiClient + store

**Files:**
- Modify: `packages/ui/src/lib/api-client.ts` (:623-676 block)
- Modify: `packages/ui/src/store/app.ts` (types :675-695, actions :1744-1826)

**Interfaces:**
- Produces store actions (consumed by Tasks 9/10): `putCliProxyRouterProvider(id, cfg, force?)`, `deleteCliProxyRouterProvider(id, force?)`, `setCliProxyRouterKey(id, key, force?)`, `clearCliProxyRouterKey(id, force?)`, `getCliProxyRouterCatalog(id)`. All mutation actions mirror the existing pattern: call the client, then `await get().loadCliProxy()`; refusals pass through for `withRestartConfirm`.
- Removes `setCliProxyOpenRouterKey` from client + store.

- [ ] **Step 1: Implement** (UI has no test harness — the gate is `pnpm check`): mirror the five client methods from Task 7 in `packages/ui/src/lib/api-client.ts` (`mutateAllowingRefusal` for PUT/POST/DELETE mutations — note this client's `send` supports bodies; DELETEs use `?force=true` query), replace the `setCliProxyOpenRouterKey` store action with the five actions in `app.ts` (each following the `setCliProxyOpenRouterKey` action's exact shape at :1805-1815), and delete the old one.
- [ ] **Step 2: Run** `pnpm check` — expect remaining errors **only** in `ModelProxySettings.tsx`/`NewTabMenu.tsx` (next tasks); if others appear, fix them here.
- [ ] **Step 3: Commit** — `git commit -m "feat(ui): router-provider api client methods and store actions"`

---

### Task 9: UI — Model proxy settings rework

**Files:**
- Modify: `packages/ui/src/components/settings/ModelProxySettings.tsx`

**Interfaces:**
- Consumes: `status.routerProviders` (Task 4 shape), store actions (Task 8), `ROUTER_PRESETS`, `routerModelDisplayId`, `CURATED_PROXY_MODELS` from `@orquester/config`.

Design (from spec §3): keep the existing header/enable, Accounts rows (codex/claude — the current `ProviderRow` minus its openrouter branches), then a **Routers** section, then Model defaults + Context windows extended with router models.

- [ ] **Step 1: Implement.**

1. `PROVIDER_LABEL` shrinks to `{codex, claude}`; delete `isOpenRouter` branches from `ProviderRow` (rows are OAuth-only now: state text via `formatVerified`, seed/unseed unchanged).
2. New `RoutersSection` rendered after the Accounts section:

```tsx
const RoutersSection: React.FC<{
  routers: CliProxyRouterProviderStatus[];
  busy: boolean;
  run: (fn: () => Promise<unknown>) => Promise<void>;
  withRestartConfirm: (attempt: (force: boolean) => Promise<CliProxyStatus | { ok: boolean; affectedSessions?: number }>) => Promise<void>;
}> = ({ routers, busy, run, withRestartConfirm }) => {
  const putProvider = useAppStore((s) => s.putCliProxyRouterProvider);
  const deleteProvider = useAppStore((s) => s.deleteCliProxyRouterProvider);
  const setKey = useAppStore((s) => s.setCliProxyRouterKey);
  const clearKey = useAppStore((s) => s.clearCliProxyRouterKey);
  const [adding, setAdding] = useState(false);
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-neutral-200">Routers</h3>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => setAdding((v) => !v)}>
          Add router
        </Button>
      </div>
      {adding && (
        <AddRouterForm
          existingIds={routers.map((r) => r.id)}
          busy={busy}
          onCancel={() => setAdding(false)}
          onCreate={(id, cfg) => {
            setAdding(false);
            void run(() => withRestartConfirm((force) => putProvider(id, cfg, force)));
          }}
        />
      )}
      <div className="divide-y divide-neutral-800 rounded-lg border border-neutral-800">
        {routers.length === 0 && !adding && (
          <p className="px-3 py-2.5 text-xs text-neutral-500">
            No routers yet. Add OpenRouter, TokenRouter, or any OpenAI-compatible gateway.
          </p>
        )}
        {routers.map((r) => (
          <RouterRow
            key={r.id}
            router={r}
            busy={busy}
            onSaveKey={(key) => run(() => withRestartConfirm((force) => setKey(r.id, key, force)))}
            onClearKey={() => run(() => withRestartConfirm((force) => clearKey(r.id, force)))}
            onSaveModels={(models) =>
              run(() =>
                withRestartConfirm((force) =>
                  putProvider(r.id, { label: r.label, baseUrl: r.baseUrl, preset: r.preset, models }, force)
                )
              )
            }
            onDelete={() => {
              if (window.confirm(`Delete router "${r.label}" and its stored key?`)) {
                void run(() => withRestartConfirm((force) => deleteProvider(r.id, force)));
              }
            }}
          />
        ))}
      </div>
    </section>
  );
};
```

3. `AddRouterForm`: preset chips (from `ROUTER_PRESETS`) + Custom; fields id (slug, prefilled from preset name), label, base URL (prefilled from preset), models prefilled from the preset's `models`; validates `ROUTER_PROVIDER_ID_RE` client-side; `onCreate(id, { label, baseUrl, preset, models })`.
4. `RouterRow`: label + baseUrl + key state (`keyState === "verified"` → `formatVerified(keyVerifiedAt)`; `"set"` → `"key set — not verified yet"`; `"none"` → `"no key"`), model count; actions: **Key** (password input identical to the old OpenRouter `keyEntry` block :467-503, placeholder `"API key"`; plus a "Remove key" button when `keyState !== "none"`), **Models** (toggles `RouterModelsEditor`), **Delete**.
5. `RouterModelsEditor`: on open calls `useAppStore((s) => s.getCliProxyRouterCatalog)(router.id)`; success → searchable checklist (checkbox per catalog id, checked = present in `router.models` by name), failure → inline error + the manual path; below the list, one row per **enabled** model with inputs alias / contextWindow / compactWindow (numbers optional) and a free-text "Add model id" input for manual entry. "Save models" → `onSaveModels(models)`.
6. Model defaults + Context windows sections: options/rows become

```ts
  const routerModelIds = (status.routerProviders ?? []).flatMap((p) =>
    p.models.map((m) => m.alias ?? m.name)
  );
  const pickerIds = [...new Set([...CURATED_PROXY_MODEL_IDS, ...routerModelIds])];
```

  `curatedOptions` filters `pickerIds` against the catalog (same logic as :59-65); the Context-windows list maps over `[...CURATED_PROXY_MODELS, ...routerModelRows]` where `routerModelRows` carries `{id: alias ?? name, contextWindow, compactWindow, compactPct}` from the provider models. `status.routerProviders ?? []` everywhere (stale-bundle defensive rule).

- [ ] **Step 2: Run** `pnpm check` → only `NewTabMenu.tsx` errors may remain.
- [ ] **Step 3: Commit** — `git commit -m "feat(ui): Routers section in Model proxy settings (presets, keys, catalog picker)"`

---

### Task 10: UI — NewTabMenu router awareness

**Files:**
- Modify: `packages/ui/src/components/topbar/NewTabMenu.tsx` (:4, :33-49, :99-119, :196)

- [ ] **Step 1: Implement.** Drop the `isOpenRouterModel` import. Inside `AgentRow` (which already subscribes to `cliproxy`):

```ts
  // Models served by a keyed router provider are keyless — the account chip has
  // no effect on them. Derived from live status, replacing the old kimi regex.
  const routerInfo = React.useMemo(() => {
    const byModel = new Map<string, string>(); // model id → provider label
    for (const p of cliproxy?.routerProviders ?? []) {
      if (p.keyState === "none") continue;
      for (const m of p.models) {
        byModel.set(m.name, p.label);
        if (m.alias) byModel.set(m.alias, p.label);
      }
    }
    return byModel;
  }, [cliproxy]);
  const routerLabel = selectedModel ? routerInfo.get(selectedModel.replace(/^acc[0-9a-fA-F]+\//, "")) : undefined;
  const accountDimmed = showModels && Boolean(routerLabel);
```

Model chips: `baseModels` becomes the curated list ∪ `[...routerInfo.keys()]` filtered against the catalog exactly as today (:103-107). Dim title (:196): `` `${selectedModel} routes through ${routerLabel} (keyless) — account is ignored` ``. `shortModelLabel` already handles arbitrary ids.

- [ ] **Step 2: Run** `pnpm check` from root → **fully clean** now.
- [ ] **Step 3: Commit** — `git commit -m "feat(ui): new-tab model chips and account dimming driven by router providers"`

---

### Task 11: Cleanup — delete the legacy kimi/OpenRouter hardcoding

**Files:**
- Modify: `packages/config/src/index.ts` — delete `isOpenRouterModel` (:755-758), `OPENROUTER_ALIAS_MODELS` (:766), the `kimi-k3` row of `CURATED_PROXY_MODELS` (:791), and the `bare.replace(/^moonshotai\//, "")` legacy line in `compactEnvForModel`.
- Modify: `apps/daemon/src/cliproxy-secrets.ts` — delete the `setOpenRouterKey` wrapper.
- Modify: any test still referencing the deleted symbols (grep).

- [ ] **Step 1:** `grep -rn "isOpenRouterModel\|OPENROUTER_ALIAS_MODELS\|setOpenRouterKey\|openrouter/key" apps packages --include='*.ts' --include='*.tsx'` — migrate every remaining reference (there should be none in src after Tasks 1–10; fix tests to use the new APIs).
- [ ] **Step 2:** Apply the deletions.
- [ ] **Step 3:** `pnpm check` + `pnpm --filter @orquester/daemon test` (full suite) → clean/green. The kimi-k3 curated deletion must not break the Fable slot: `routerKimiAvailable` (Task 3) and the migration-seeded provider carry it now.
- [ ] **Step 4: Commit** — `git commit -m "refactor: remove kimi regex, alias list and curated entry superseded by router providers"`

---

### Task 12: Docs — AGENTS.md model-proxy section + README

**Files:**
- Modify: `AGENTS.md` (add a "Model proxy (cliproxy) & router providers" bullet under *Conventions & gotchas*; mention `<appdir>/daemon/cliproxy/{state.json,secrets.json}`, the router-provider data model, the legacy mirror rule, and that `config.yaml` strings are JSON-stringified with provider-level `models`)
- Modify: `README.md` (extend the model-proxy blurbs: "OpenRouter" → "any OpenAI-compatible router (OpenRouter/TokenRouter presets + custom)")

- [ ] **Step 1:** Write both edits (concise — AGENTS.md currently has zero cliproxy coverage; add ~15 lines, not a full subsystem essay).
- [ ] **Step 2:** Commit — `git commit -m "docs: document the model proxy router-provider mechanism"`

---

### Task 13: Final verification

- [ ] **Step 1:** `pnpm check` → clean. `pnpm --filter @orquester/daemon test` → all green.
- [ ] **Step 2:** Migration smoke on disk fixtures (no daemon needed): tiny script or test that feeds a legacy `{apiKey, managementSecret, openRouterKey}` secrets file + old `state.json` through `loadOrInitSecrets` + `migrateLegacyOpenRouter` and asserts the mirrored output — already covered by Task 1/4 tests; re-run them.
- [ ] **Step 3 (live drive — separate checkout ONLY, per AGENTS.md):** clone the repo elsewhere, `pnpm install`, run `pnpm dev:daemon` **there**, then via the web UI: enable Model proxy → Routers → Add router → TokenRouter preset → paste key (from tokenrouter.com — never tokenrouter.me) → Edit models → catalog loads → enable `moonshotai/kimi-k3-free` → new claudex tab picks it → session answers. Inspect `<stage>/daemon/cliproxy/config.yaml` (two-provider YAML if OpenRouter also keyed) and `<stage>/daemon/env/claudex.env`. Verify the legacy path: place an old-format `secrets.json` with `openRouterKey`, restart the staged daemon, confirm the `openrouter` provider appears with kimi wired and the key mirrored.
- [ ] **Step 4:** Report results honestly; anything failing stays open — do not mark this plan done with a red suite.

---

## Self-Review Notes

- Spec §1 (schemas/migration/presets) → Tasks 1–2; §2 (YAML/routing/verification/routes) → Tasks 3–7; §3 (UI) → Tasks 9–10; §4 (error handling) → Tasks 5/7 (400/404/409/502 + dangling-pick resets); §5 (verification) → Task 13; docs follow-up → Task 12. Old-route deletion → Task 7.
- Type-consistency anchors: `RouterModel`/`RouterProvider` (Task 1) are reused verbatim in wire types (Task 4: `CliProxyRouterModel` mirrors `RouterModel`), manager methods (Task 5), routes/client (Task 7), store (Task 8), UI (Tasks 9–10).
- Interim-green strategy: legacy symbols (`isOpenRouterModel`, `setOpenRouterKey` wrapper, curated kimi) survive until every caller is migrated, then die together in Task 11 — each commit typechecks.
