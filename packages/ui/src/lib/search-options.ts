/**
 * Per-project file-search options persisted client-side in localStorage. Mirrors
 * the panel-sizes.ts persistence mold: SSR-safe (`typeof localStorage ===
 * "undefined"` guards), swallows storage errors, validates + clamps on load,
 * read-merge-write per project so a commit for one project can't clobber another.
 *
 * The search query text is deliberately NEVER persisted — only the toggles, glob
 * fields, and whether the filter row is expanded, keyed by project rootPath.
 */

const SEARCH_OPTIONS_KEY = "orquester:search-options-by-project";

/** Glob fields are capped generously above the daemon's 1024-char field limit. */
const MAX_GLOB_CHARS = 2048;

export interface SearchOptions {
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
  include: string;
  exclude: string;
  filtersExpanded: boolean;
}

export const SEARCH_OPTIONS_DEFAULT: SearchOptions = {
  caseSensitive: false,
  wholeWord: false,
  regex: false,
  include: "",
  exclude: "",
  filtersExpanded: false
};

/** Coerce an arbitrary stored value into a valid SearchOptions (defaults on miss). */
function validateSearchOptions(value: unknown): SearchOptions {
  if (typeof value !== "object" || value === null) {
    return { ...SEARCH_OPTIONS_DEFAULT };
  }
  const record = value as Record<string, unknown>;
  const bool = (key: keyof SearchOptions): boolean =>
    typeof record[key] === "boolean" ? (record[key] as boolean) : false;
  const str = (key: keyof SearchOptions): string =>
    typeof record[key] === "string" ? (record[key] as string).slice(0, MAX_GLOB_CHARS) : "";
  return {
    caseSensitive: bool("caseSensitive"),
    wholeWord: bool("wholeWord"),
    regex: bool("regex"),
    include: str("include"),
    exclude: str("exclude"),
    filtersExpanded: bool("filtersExpanded")
  };
}

function loadAll(): Record<string, SearchOptions> {
  try {
    if (typeof localStorage === "undefined") {
      return {};
    }
    const raw = localStorage.getItem(SEARCH_OPTIONS_KEY);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const result: Record<string, SearchOptions> = {};
    for (const [path, value] of Object.entries(parsed)) {
      result[path] = validateSearchOptions(value);
    }
    return result;
  } catch {
    return {};
  }
}

function saveAll(map: Record<string, SearchOptions>): void {
  try {
    if (typeof localStorage === "undefined") {
      return;
    }
    localStorage.setItem(SEARCH_OPTIONS_KEY, JSON.stringify(map));
  } catch {
    /* ignore quota/availability errors — options stay in-memory only */
  }
}

/** Load one project's persisted search options, filling missing fields with defaults. */
export function loadSearchOptions(projectPath: string): SearchOptions {
  const stored = loadAll()[projectPath];
  return stored ? { ...SEARCH_OPTIONS_DEFAULT, ...stored } : { ...SEARCH_OPTIONS_DEFAULT };
}

/**
 * Read-merge-write one project's search options. Re-loads the freshest map first
 * so a commit for one project can't clobber another's entry (see persistPaneSize).
 */
export function persistSearchOptions(projectPath: string, options: SearchOptions): void {
  const map = loadAll();
  map[projectPath] = validateSearchOptions(options);
  saveAll(map);
}
