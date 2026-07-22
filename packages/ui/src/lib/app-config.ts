import { usagePrefsSchema, type AppConfig, type UsagePrefs } from "@orquester/config";

/**
 * Persistence for the app's own config. It is per-client, so each runtime
 * supplies its own store: web uses localStorage; desktop omits this and the
 * store falls back to the daemon (app.json under the appdir).
 */
export interface AppConfigAdapter {
  load(): Promise<Partial<AppConfig>>;
  save(config: AppConfig): Promise<void>;
}

/**
 * Run adapter-loaded usage prefs through the schema before they reach the
 * store. Adapter payloads (web = raw localStorage JSON) bypass zod, so a blob
 * persisted by an older bundle can miss fields the UI now dereferences —
 * a pre-`agents`-record shape crashed the web client on load. The schema's
 * transform also folds the legacy top-level `claude`/`codex` booleans into
 * `agents`, preserving the user's choices.
 */
export function normalizeUsagePrefs(value: unknown, fallback: UsagePrefs): UsagePrefs {
  if (value == null) return fallback;
  const parsed = usagePrefsSchema.safeParse(value);
  return parsed.success ? parsed.data : fallback;
}

/**
 * Field-wise validation of a stored app-config blob (repo rule: raw JSON.parse
 * output never reaches typed code without validation + fallback — payloads
 * written by old bundles outlive deploys). Valid fields pass through, absent
 * fields stay absent (so per-host defaults still win in the store's merge),
 * wrong-typed fields are dropped, and `usage` goes through its zod schema
 * (which also migrates the legacy pre-record shape).
 */
export function sanitizeStoredAppConfig(raw: unknown): Partial<AppConfig> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return {};
  }
  const rec = raw as Record<string, unknown>;
  const out: Partial<AppConfig> = {};
  if (typeof rec.activeConnectionId === "string" && rec.activeConnectionId.length > 0) {
    out.activeConnectionId = rec.activeConnectionId;
  }
  if (typeof rec.useTitlebar === "boolean") out.useTitlebar = rec.useTitlebar;
  if (typeof rec.runInBackground === "boolean") out.runInBackground = rec.runInBackground;
  if (typeof rec.confirmCloseSession === "boolean") out.confirmCloseSession = rec.confirmCloseSession;
  if (rec.usage !== undefined) {
    const usage = usagePrefsSchema.safeParse(rec.usage);
    if (usage.success) out.usage = usage.data;
  }
  return out;
}

export function createLocalStorageAppConfigAdapter(key = "orquester.app"): AppConfigAdapter {
  return {
    async load() {
      try {
        const raw = localStorage.getItem(key);
        return raw ? sanitizeStoredAppConfig(JSON.parse(raw)) : {};
      } catch {
        return {};
      }
    },
    async save(config) {
      try {
        localStorage.setItem(key, JSON.stringify(config));
      } catch {
        /* storage unavailable */
      }
    }
  };
}
