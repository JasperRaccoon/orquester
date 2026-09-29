/**
 * The workflow editor's per-device layout: the inspector's width, whether the
 * block palette is open and whether the minimap shows. One localStorage key,
 * read field by field with fallbacks (AGENTS.md: an older bundle's payload
 * must never reach typed code).
 */

export const INSPECTOR_MIN_WIDTH = 320;
export const INSPECTOR_MAX_WIDTH = 640;
export const INSPECTOR_DEFAULT_WIDTH = 380;
/** Below this window width the palette starts folded into its icon rail. */
export const PALETTE_OPEN_MIN_WIDTH = 1600;

export interface WorkflowEditorLayout {
  inspectorWidth: number;
  paletteOpen: boolean;
  minimap: boolean;
}

export const DEFAULT_EDITOR_LAYOUT: WorkflowEditorLayout = {
  inspectorWidth: INSPECTOR_DEFAULT_WIDTH,
  paletteOpen: true,
  minimap: true
};

const STORAGE_KEY = "orquester.workflowEditor.layout.v1";

export function clampInspectorWidth(width: number): number {
  if (!Number.isFinite(width)) return INSPECTOR_DEFAULT_WIDTH;
  return Math.min(INSPECTOR_MAX_WIDTH, Math.max(INSPECTOR_MIN_WIDTH, Math.round(width)));
}

/** A stored payload, field by field; anything unreadable falls back to the default. */
function parseEditorLayout(raw: unknown): WorkflowEditorLayout {
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return { ...DEFAULT_EDITOR_LAYOUT };
    }
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return { ...DEFAULT_EDITOR_LAYOUT };
  const record = value as Record<string, unknown>;
  return {
    inspectorWidth:
      typeof record.inspectorWidth === "number"
        ? clampInspectorWidth(record.inspectorWidth)
        : DEFAULT_EDITOR_LAYOUT.inspectorWidth,
    paletteOpen: typeof record.paletteOpen === "boolean" ? record.paletteOpen : DEFAULT_EDITOR_LAYOUT.paletteOpen,
    minimap: typeof record.minimap === "boolean" ? record.minimap : DEFAULT_EDITOR_LAYOUT.minimap
  };
}

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** The layout for this device: stored choices, else the defaults (the palette folded on a narrow window). */
export function loadEditorLayout(): WorkflowEditorLayout {
  const wide = typeof window === "undefined" || window.innerWidth >= PALETTE_OPEN_MIN_WIDTH;
  const fallback = { ...DEFAULT_EDITOR_LAYOUT, paletteOpen: wide };
  const store = storage();
  if (store === null) return fallback;
  try {
    const raw = store.getItem(STORAGE_KEY);
    return raw === null ? fallback : parseEditorLayout(raw);
  } catch {
    return fallback;
  }
}

export function saveEditorLayout(layout: WorkflowEditorLayout): void {
  const store = storage();
  if (store === null) return;
  try {
    store.setItem(
      STORAGE_KEY,
      JSON.stringify({ ...layout, inspectorWidth: clampInspectorWidth(layout.inspectorWidth) })
    );
  } catch {
    // Full or blocked storage: the layout is a convenience.
  }
}
