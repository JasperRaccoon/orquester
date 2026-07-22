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

export function createLocalStorageAppConfigAdapter(key = "orquester.app"): AppConfigAdapter {
  return {
    async load() {
      try {
        const raw = localStorage.getItem(key);
        return raw ? (JSON.parse(raw) as Partial<AppConfig>) : {};
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
