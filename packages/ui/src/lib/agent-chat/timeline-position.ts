/**
 * Agent chat — the per-thread scroll/disclosure LRU (spec §7.2).
 *
 * Ported from T3 Code (MIT):
 * `apps/web/src/components/chat/timelineScrollAnchoring.ts:110-141` — the
 * remembered record and its delete-then-set LRU, evicting past 100 entries.
 *
 * The remembered record is `{rowId, offsetWithinRow, scrollOffset, atEnd,
 * disclosures, interactionMode}`, where `disclosures` is the full set of what
 * was open — expanded turns, expanded activity groups, expanded subagent rows,
 * expanded reasoning blocks, and the scroll offset inside each expanded tool
 * output — so returning to a tab restores the reading position *and* the shape
 * of the page under it.
 *
 * Persisted per device, through field-wise validation with a fallback: an old
 * bundle's payload outlives a deploy, and raw `JSON.parse` output must never
 * reach typed code (AGENTS.md).
 *
 * No React import.
 */

import { DEFAULT_INTERACTION_MODE, type InteractionMode } from "@orquester/api/agent-chat";

import {
  TIMELINE_POSITION_LRU_LIMIT,
  type DisclosureState,
  type RememberedTimelinePosition
} from "./contracts";

const STORAGE_KEY = "orquester:agent-chat-timeline-positions";

export const EMPTY_DISCLOSURE_STATE: DisclosureState = {
  expandedTurnIds: [],
  expandedGroupIds: [],
  expandedAgentIds: [],
  expandedReasoningIds: [],
  toolOutputOffsets: {}
};

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const asStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];

const asFiniteNumber = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

export function parseDisclosureState(value: unknown): DisclosureState {
  if (typeof value !== "object" || value === null) {
    return EMPTY_DISCLOSURE_STATE;
  }
  const record = value as Record<string, unknown>;
  const offsets: Record<string, number> = {};
  if (typeof record.toolOutputOffsets === "object" && record.toolOutputOffsets !== null) {
    for (const [key, offset] of Object.entries(record.toolOutputOffsets as Record<string, unknown>)) {
      if (typeof offset === "number" && Number.isFinite(offset)) {
        offsets[key] = offset;
      }
    }
  }
  return {
    expandedTurnIds: asStringArray(record.expandedTurnIds),
    expandedGroupIds: asStringArray(record.expandedGroupIds),
    expandedAgentIds: asStringArray(record.expandedAgentIds),
    expandedReasoningIds: asStringArray(record.expandedReasoningIds),
    toolOutputOffsets: offsets
  };
}

export function parseRememberedPosition(value: unknown): RememberedTimelinePosition | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const interactionMode = record.interactionMode;
  return {
    rowId: typeof record.rowId === "string" ? record.rowId : null,
    offsetWithinRow: asFiniteNumber(record.offsetWithinRow, 0),
    scrollOffset: asFiniteNumber(record.scrollOffset, 0),
    atEnd: record.atEnd !== false,
    disclosures: parseDisclosureState(record.disclosures),
    interactionMode:
      interactionMode === "plan" || interactionMode === "default"
        ? (interactionMode as InteractionMode)
        : DEFAULT_INTERACTION_MODE
  };
}

/** One malformed blob degrades to "nothing remembered", never a crash on load. */
export function parseTimelinePositions(
  raw: string | null
): Map<string, RememberedTimelinePosition> {
  const result = new Map<string, RememberedTimelinePosition>();
  if (!raw) {
    return result;
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return result;
  }
  if (!Array.isArray(decoded)) {
    return result;
  }
  // Serialized oldest-first, so replaying it rebuilds the LRU order exactly.
  for (const entry of decoded) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string") {
      continue;
    }
    const position = parseRememberedPosition(entry[1]);
    if (position) {
      result.set(entry[0], position);
    }
  }
  while (result.size > TIMELINE_POSITION_LRU_LIMIT) {
    const oldest = result.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    result.delete(oldest);
  }
  return result;
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

/**
 * A bounded, insertion-ordered LRU. `Map` preserves insertion order, so
 * **delete-then-set** is what moves an entry to the end.
 *
 * *T3: `timelineScrollAnchoring.ts:127-141`.*
 */
export class TimelinePositionStore {
  private readonly entries: Map<string, RememberedTimelinePosition>;
  private readonly persist: (serialized: string) => void;

  constructor(options?: {
    initial?: Map<string, RememberedTimelinePosition>;
    persist?: (serialized: string) => void;
  }) {
    this.entries = options?.initial ?? new Map();
    this.persist = options?.persist ?? writeTimelinePositions;
  }

  read(threadKey: string): RememberedTimelinePosition | undefined {
    return this.entries.get(threadKey);
  }

  remember(threadKey: string, position: RememberedTimelinePosition): void {
    this.entries.delete(threadKey);
    this.entries.set(threadKey, position);
    while (this.entries.size > TIMELINE_POSITION_LRU_LIMIT) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.entries.delete(oldest);
    }
    this.persist(JSON.stringify([...this.entries.entries()]));
  }

  forget(threadKey: string): void {
    if (this.entries.delete(threadKey)) {
      this.persist(JSON.stringify([...this.entries.entries()]));
    }
  }

  get size(): number {
    return this.entries.size;
  }

  keys(): string[] {
    return [...this.entries.keys()];
  }
}

function readTimelinePositions(): Map<string, RememberedTimelinePosition> {
  try {
    if (typeof localStorage === "undefined") {
      return new Map();
    }
    return parseTimelinePositions(localStorage.getItem(STORAGE_KEY));
  } catch {
    return new Map();
  }
}

function writeTimelinePositions(serialized: string): void {
  try {
    if (typeof localStorage === "undefined") {
      return;
    }
    localStorage.setItem(STORAGE_KEY, serialized);
  } catch {
    /* private window, blocked storage, quota — a scroll position is a convenience */
  }
}

let shared: TimelinePositionStore | null = null;

/** The process-wide store every chat tab shares. */
export function timelinePositionStore(): TimelinePositionStore {
  shared ??= new TimelinePositionStore({ initial: readTimelinePositions() });
  return shared;
}

// ---------------------------------------------------------------------------
// Disclosure helpers
// ---------------------------------------------------------------------------

type DisclosureListKey = Exclude<keyof DisclosureState, "toolOutputOffsets">;

export function toggleDisclosure(
  state: DisclosureState,
  key: DisclosureListKey,
  id: string
): DisclosureState {
  const current = state[key];
  const next = current.includes(id)
    ? current.filter((entry) => entry !== id)
    : [...current, id];
  return { ...state, [key]: next };
}

export function setToolOutputOffset(
  state: DisclosureState,
  rowId: string,
  offset: number
): DisclosureState {
  if (state.toolOutputOffsets[rowId] === offset) {
    return state;
  }
  return { ...state, toolOutputOffsets: { ...state.toolOutputOffsets, [rowId]: offset } };
}

export function disclosureSets(state: DisclosureState): {
  expandedTurnIds: ReadonlySet<string>;
  expandedGroupIds: ReadonlySet<string>;
  expandedAgentIds: ReadonlySet<string>;
  expandedReasoningIds: ReadonlySet<string>;
} {
  return {
    expandedTurnIds: new Set(state.expandedTurnIds),
    expandedGroupIds: new Set(state.expandedGroupIds),
    expandedAgentIds: new Set(state.expandedAgentIds),
    expandedReasoningIds: new Set(state.expandedReasoningIds)
  };
}

// ---------------------------------------------------------------------------
// Live-follow (§7.3)
// ---------------------------------------------------------------------------

/**
 * Follow re-arms only inside a **40 px band** at the bottom of the content,
 * measured as `contentLength - scroll - scrollLength`. A "near end" heuristic
 * that fires within half a viewport re-arms follow while the user is reading
 * history and yanks them back on the next chunk.
 *
 * *T3: `MessagesTimeline.logic.ts:149-172`.*
 */
export const TIMELINE_FOLLOW_REARM_THRESHOLD_PX = 40;

export function resolveTimelineIsAtEnd(state: {
  contentLength?: number;
  scroll?: number;
  scrollLength?: number;
  isAtEnd?: boolean;
}): boolean | undefined {
  const { contentLength, scroll, scrollLength } = state;
  if (contentLength === undefined || scroll === undefined || scrollLength === undefined) {
    return state.isAtEnd;
  }
  return contentLength - scroll - scrollLength <= TIMELINE_FOLLOW_REARM_THRESHOLD_PX;
}
