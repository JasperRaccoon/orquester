/**
 * Agent chat — the composer's `/` and `$` menus (spec §4.6.5(a), §4.6.7, §4.6.8).
 *
 * Ported from T3 Code (MIT): `apps/web/src/composer-logic.ts`
 * (`detectComposerTrigger`, `parseStandaloneComposerSlashCommand`,
 * `replaceTextRange`), `apps/web/src/components/chat/composerSlashCommandSearch.ts`,
 * `packages/shared/src/searchRanking.ts` and
 * `packages/client-runtime/src/providerSkills.ts`.
 *
 * The three dispatch paths of §4.6.5 are classified here, and only here:
 * - **(a) client** — `/model`, `/effort`, `/plan`, `/default`: a host UI
 *   affordance. Selecting it erases the typed text and performs the action; it
 *   is never inserted into the draft.
 * - **(b) host-native** — `/compact`: the daemon turns it into an API call.
 *   The predicate is exact and deliberately narrow (§4.6.5).
 * - **(c) forwarded** — everything else, as typed. The host does not validate
 *   the name against the catalog, does not rewrite it and does not block it.
 *
 * No React import.
 */

import type { ProviderSnapshot, Skill, SlashCommand } from "@orquester/api/agent-chat";

// ---------------------------------------------------------------------------
// Triggers (§4.6.7)
// ---------------------------------------------------------------------------

export type ComposerTriggerKind = "path" | "slash-command" | "skill";

export interface ComposerTrigger {
  kind: ComposerTriggerKind;
  query: string;
  rangeStart: number;
  rangeEnd: number;
}

function clampCursor(text: string, cursor: number): number {
  if (!Number.isFinite(cursor)) {
    return text.length;
  }
  return Math.max(0, Math.min(text.length, Math.floor(cursor)));
}

function isWhitespace(char: string): boolean {
  return char === " " || char === "\n" || char === "\t" || char === "\r";
}

function tokenStartForCursor(text: string, cursor: number): number {
  let index = cursor - 1;
  while (index >= 0 && !isWhitespace(text[index] ?? "")) {
    index -= 1;
  }
  return index + 1;
}

/**
 * `/` opens the command menu when it is the first non-empty character of the
 * **current line**, matching `/^\/(\S*)$/` up to the caret; `$` opens the skill
 * menu on the current token; `@` keeps the existing file search.
 *
 * *T3: `composer-logic.ts:218-262`; differs: T3's `#` pull-request trigger has
 * no analogue here and is dropped.*
 */
export function detectComposerTrigger(text: string, cursorInput: number): ComposerTrigger | null {
  const cursor = clampCursor(text, cursorInput);
  const lineStart = text.lastIndexOf("\n", Math.max(0, cursor - 1)) + 1;
  const linePrefix = text.slice(lineStart, cursor);

  if (linePrefix.startsWith("/")) {
    const match = /^\/(\S*)$/.exec(linePrefix);
    if (match) {
      return {
        kind: "slash-command",
        query: match[1] ?? "",
        rangeStart: lineStart,
        rangeEnd: cursor
      };
    }
  }

  const tokenStart = tokenStartForCursor(text, cursor);
  const token = text.slice(tokenStart, cursor);
  // Any currency symbol, as T3 has it: `$` on a US layout, `£`/`€`/`¥` elsewhere.
  const skillPrefix = /^\p{Sc}/u.exec(token);
  if (skillPrefix) {
    return {
      kind: "skill",
      query: token.slice(skillPrefix[0].length),
      rangeStart: tokenStart,
      rangeEnd: cursor
    };
  }
  if (!token.startsWith("@")) {
    return null;
  }
  return { kind: "path", query: token.slice(1), rangeStart: tokenStart, rangeEnd: cursor };
}

/** *T3: `composer-logic.ts:291-303`.* */
export function replaceTextRange(
  text: string,
  rangeStart: number,
  rangeEnd: number,
  replacement: string
): { text: string; cursor: number } {
  const safeStart = Math.max(0, Math.min(text.length, rangeStart));
  const safeEnd = Math.max(safeStart, Math.min(text.length, rangeEnd));
  return {
    text: `${text.slice(0, safeStart)}${replacement}${text.slice(safeEnd)}`,
    cursor: safeStart + replacement.length
  };
}

// ---------------------------------------------------------------------------
// §4.6.5(a) client commands
// ---------------------------------------------------------------------------

/** The four client-only rows of §4.6.5(a). Nothing else ever leaves the browser. */
export type ClientSlashCommand = "model" | "effort" | "plan" | "default";

export const CLIENT_SLASH_COMMANDS: readonly ClientSlashCommand[] = [
  "model",
  "effort",
  "plan",
  "default"
];

/**
 * `/plan` and `/default` are additionally recognised **on submit**, when the
 * whole trimmed draft is that command and nothing else is attached. `/model`
 * and `/effort` are not: typed out and sent they are ordinary text, which keeps
 * the submit path free of guesswork (§4.6.5(a)).
 *
 * *T3: `composer-logic.ts:280-289`.*
 */
export function parseStandaloneClientSlashCommand(text: string): "plan" | "default" | null {
  const match = /^\/(plan|default)\s*$/i.exec(text.trim());
  if (!match) {
    return null;
  }
  return match[1]?.toLowerCase() === "plan" ? "plan" : "default";
}

/**
 * The §4.6.5(b) host-native predicate — **exact and deliberately narrow**:
 * role `user`, no attachments, and the trimmed lowercased text is exactly
 * `/compact`.
 *
 * *T3: `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts:95-98`.*
 */
export function isHostNativeCompactSubmission(input: {
  text: string;
  attachmentCount: number;
}): boolean {
  return input.attachmentCount === 0 && input.text.trim().toLowerCase() === "/compact";
}

/** `/effort <id>` applies directly; a bare `/effort` opens the picker (§4.6.5(a)). */
export function parseEffortArgument(text: string): string | null {
  const match = /^\/effort\s+(\S+)\s*$/i.exec(text.trim());
  return match?.[1] ?? null;
}

// ---------------------------------------------------------------------------
// Menu items
// ---------------------------------------------------------------------------

export type ComposerCommandItem =
  | { type: "client"; command: ClientSlashCommand; label: string; description: string }
  | { type: "host"; command: "compact"; label: string; description: string }
  | { type: "provider"; command: SlashCommand }
  | { type: "skill"; skill: Skill };

/** Row text: the description, else the argument hint, else a generic line (§4.6.7). */
export function commandItemDescription(item: ComposerCommandItem): string {
  switch (item.type) {
    case "client":
    case "host":
      return item.description;
    case "provider":
      return item.command.description ?? item.command.input?.hint ?? "Run provider command";
    case "skill":
      return item.skill.shortDescription ?? item.skill.description ?? "Run skill";
  }
}

export function commandItemName(item: ComposerCommandItem): string {
  switch (item.type) {
    case "client":
      return item.command;
    case "host":
      return item.command;
    case "provider":
      return item.command.name;
    case "skill":
      return item.skill.name;
  }
}

// ---------------------------------------------------------------------------
// Skills (§4.6.8)
// ---------------------------------------------------------------------------

/**
 * `userInvocable: false` hides a skill from `/` (the provider reserves it for
 * the agent); a disabled skill is never offered. `userInvocationOnly` does
 * **not** hide it — it is the reason to show it.
 *
 * *T3: `providerSkills.ts:44-56`.*
 */
export function isSkillUserInvocable(skill: Pick<Skill, "enabled" | "userInvocable">): boolean {
  return skill.enabled && skill.userInvocable !== false;
}

export function dedupeSkillsByName(skills: readonly Skill[]): Skill[] {
  const seen = new Set<string>();
  return skills.filter((skill) => {
    const key = skill.name.trim().toLowerCase();
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

/** **Skills in the `/` menu are a user setting**, default on; `$` always lists them. */
export function skillsForSlashMenu(
  skills: readonly Skill[],
  showSkillsInSlashMenu: boolean
): Skill[] {
  return showSkillsInSlashMenu ? dedupeSkillsByName(skills.filter(isSkillUserInvocable)) : [];
}

export function skillsForSkillMenu(skills: readonly Skill[]): Skill[] {
  return dedupeSkillsByName(skills.filter(isSkillUserInvocable));
}

/**
 * **A skill the provider also advertises as a command is listed once, as the
 * skill.**
 *
 * *T3: `providerSkills.ts:67-73`.*
 */
export function providerCommandsForSlashMenu(
  slashCommands: readonly SlashCommand[],
  visibleSkills: readonly Skill[]
): SlashCommand[] {
  const skillNames = new Set(visibleSkills.map((skill) => skill.name.trim().toLowerCase()));
  return slashCommands.filter((command) => !skillNames.has(command.name.trim().toLowerCase()));
}

/** Per-cwd overlay of the machine-level catalog (§4.6.4). *T3: `providerSkills.ts:109-127`.* */
export function providerCatalogForCwd(
  provider: Pick<ProviderSnapshot, "skills" | "slashCommands" | "workspaceSnapshots">,
  cwd: string | null | undefined
): { skills: Skill[]; slashCommands: SlashCommand[] } {
  const snapshot = cwd
    ? provider.workspaceSnapshots?.find((entry) => entry.cwd === cwd)
    : undefined;
  return {
    skills: snapshot?.skills ?? provider.skills,
    slashCommands: snapshot?.slashCommands ?? provider.slashCommands
  };
}

// ---------------------------------------------------------------------------
// Building the list (§4.6.7 gating)
// ---------------------------------------------------------------------------

export interface CommandMenuInput {
  provider: Pick<
    ProviderSnapshot,
    "skills" | "slashCommands" | "workspaceSnapshots" | "capabilities"
  > | null;
  cwd?: string | null;
  /** True when the trigger starts at offset 0 of the whole draft (§4.6.7). */
  isAtPromptStart: boolean;
  showSkillsInSlashMenu: boolean;
  /** `/effort` appears only when the selected model has a reasoning descriptor. */
  modelHasEffortDescriptor: boolean;
  /** `/compact` needs something to compact and an otherwise-empty draft. */
  threadHasContent: boolean;
  draftIsEmptyApartFromTrigger: boolean;
  hasAttachments: boolean;
  hasContextChips: boolean;
}

const CLIENT_ITEM_TEXT: Record<ClientSlashCommand, { label: string; description: string }> = {
  model: { label: "/model", description: "Pick the model for this thread" },
  effort: { label: "/effort", description: "Set the reasoning effort" },
  plan: { label: "/plan", description: "Switch to plan mode" },
  default: { label: "/default", description: "Leave plan mode" }
};

/**
 * Everything the `/` menu may offer, before ranking.
 *
 * Gating, in order (§4.6.7):
 * - **Position.** When the trigger does not start at offset 0, **provider
 *   commands are removed**; host commands and skills stay. A provider expands a
 *   command only when it opens the whole message, so offering one mid-message
 *   would hand the user a guaranteed no-op.
 * - **Per provider.** `/plan` and `/default` only where `showPlanModeToggle`;
 *   `/effort` only with a reasoning descriptor; `/compact` only with something
 *   to compact and an otherwise-empty draft, because the host-native path
 *   discards text, attachments and chips.
 */
export function buildCommandMenuItems(input: CommandMenuInput): ComposerCommandItem[] {
  const items: ComposerCommandItem[] = [];

  items.push({ type: "client", command: "model", ...CLIENT_ITEM_TEXT.model });
  if (input.modelHasEffortDescriptor) {
    items.push({ type: "client", command: "effort", ...CLIENT_ITEM_TEXT.effort });
  }
  if (input.provider?.capabilities.showPlanModeToggle) {
    items.push({ type: "client", command: "plan", ...CLIENT_ITEM_TEXT.plan });
    items.push({ type: "client", command: "default", ...CLIENT_ITEM_TEXT.default });
  }
  if (
    input.threadHasContent &&
    input.draftIsEmptyApartFromTrigger &&
    !input.hasAttachments &&
    !input.hasContextChips
  ) {
    items.push({
      type: "host",
      command: "compact",
      label: "/compact",
      description: "Compact the conversation"
    });
  }

  const catalog = input.provider
    ? providerCatalogForCwd(input.provider, input.cwd)
    : { skills: [], slashCommands: [] };
  const visibleSkills = skillsForSlashMenu(catalog.skills, input.showSkillsInSlashMenu);
  if (input.isAtPromptStart) {
    for (const command of providerCommandsForSlashMenu(catalog.slashCommands, visibleSkills)) {
      items.push({ type: "provider", command });
    }
  }
  for (const skill of visibleSkills) {
    items.push({ type: "skill", skill });
  }
  return items;
}

/** The `$` menu: skills only, from the same per-cwd catalog. */
export function buildSkillMenuItems(
  provider: Pick<ProviderSnapshot, "skills" | "slashCommands" | "workspaceSnapshots"> | null,
  cwd?: string | null
): ComposerCommandItem[] {
  if (!provider) {
    return [];
  }
  return skillsForSkillMenu(providerCatalogForCwd(provider, cwd).skills).map((skill) => ({
    type: "skill" as const,
    skill
  }));
}

// ---------------------------------------------------------------------------
// Ranking (§4.6.7)
// ---------------------------------------------------------------------------

function lengthPenalty(value: string, query: string): number {
  return Math.min(64, Math.max(0, value.length - query.length));
}

function findBoundaryMatchIndex(
  value: string,
  query: string,
  markers: readonly string[]
): number | null {
  let best: number | null = null;
  for (const marker of markers) {
    const index = value.indexOf(`${marker}${query}`);
    if (index === -1) {
      continue;
    }
    const matchIndex = index + marker.length;
    if (best === null || matchIndex < best) {
      best = matchIndex;
    }
  }
  return best;
}

/** *T3: `searchRanking.ts:22-49`.* */
export function scoreSubsequenceMatch(value: string, query: string): number | null {
  if (!query) {
    return 0;
  }
  let queryIndex = 0;
  let firstMatchIndex = -1;
  let previousMatchIndex = -1;
  let gapPenalty = 0;
  for (let valueIndex = 0; valueIndex < value.length; valueIndex += 1) {
    if (value[valueIndex] !== query[queryIndex]) {
      continue;
    }
    if (firstMatchIndex === -1) {
      firstMatchIndex = valueIndex;
    }
    if (previousMatchIndex !== -1) {
      gapPenalty += valueIndex - previousMatchIndex - 1;
    }
    previousMatchIndex = valueIndex;
    queryIndex += 1;
    if (queryIndex === query.length) {
      const spanPenalty = valueIndex - firstMatchIndex + 1 - query.length;
      return firstMatchIndex * 2 + gapPenalty * 3 + spanPenalty + Math.min(64, value.length - query.length);
    }
  }
  return null;
}

/** Tiered match scoring; **inputs must already be trimmed and lowercased**. */
export function scoreQueryMatch(input: {
  value: string;
  query: string;
  exactBase: number;
  prefixBase?: number;
  boundaryBase?: number;
  includesBase?: number;
  fuzzyBase?: number;
  boundaryMarkers?: readonly string[];
}): number | null {
  const { value, query } = input;
  if (!value || !query) {
    return null;
  }
  if (value === query) {
    return input.exactBase;
  }
  if (input.prefixBase !== undefined && value.startsWith(query)) {
    return input.prefixBase + lengthPenalty(value, query);
  }
  if (input.boundaryBase !== undefined) {
    const boundaryIndex = findBoundaryMatchIndex(
      value,
      query,
      input.boundaryMarkers ?? [" ", "-", "_", "/"]
    );
    if (boundaryIndex !== null) {
      return input.boundaryBase + boundaryIndex * 2 + lengthPenalty(value, query);
    }
  }
  if (input.includesBase !== undefined) {
    const includesIndex = value.indexOf(query);
    if (includesIndex !== -1) {
      return input.includesBase + includesIndex * 2 + lengthPenalty(value, query);
    }
  }
  if (input.fuzzyBase !== undefined) {
    const fuzzy = scoreSubsequenceMatch(value, query);
    if (fuzzy !== null) {
      return input.fuzzyBase + fuzzy;
    }
  }
  return null;
}

function itemScore(item: ComposerCommandItem, query: string): number | null {
  const scores = [
    scoreQueryMatch({
      value: commandItemName(item).toLowerCase(),
      query,
      exactBase: 0,
      prefixBase: 2,
      boundaryBase: 4,
      includesBase: 6,
      fuzzyBase: 100,
      boundaryMarkers: ["-", "_", "/"]
    }),
    // A name match beats a description match: the description tier starts at 20.
    scoreQueryMatch({
      value: commandItemDescription(item).toLowerCase(),
      query,
      exactBase: 20,
      prefixBase: 22,
      boundaryBase: 24,
      includesBase: 26
    })
  ].filter((score): score is number => score !== null);
  return scores.length === 0 ? null : Math.min(...scores);
}

/**
 * Ties break **host commands → provider commands → skills** (§4.6.7). The
 * client-only rows of §4.6.5(a) are host commands for this purpose: they are
 * the app's own affordances and rank first.
 *
 * *T3: `composerSlashCommandSearch.ts:31-113` — the same `0\0` / `1\0` / `2\0`
 * tie-breaker.*
 */
function tieBreaker(item: ComposerCommandItem): string {
  switch (item.type) {
    case "client":
      return `0\u0000${item.command}`;
    case "host":
      return `0\u0000${item.command}`;
    case "provider":
      return `1\u0000${item.command.name}`;
    case "skill":
      return `2\u0000${item.skill.name}`;
  }
}

export function searchCommandMenuItems(
  items: readonly ComposerCommandItem[],
  query: string
): ComposerCommandItem[] {
  const normalized = query.trim().replace(/^[/$]+/, "").toLowerCase();
  if (!normalized) {
    return [...items];
  }
  const ranked: Array<{ item: ComposerCommandItem; score: number; tie: string }> = [];
  for (const item of items) {
    const score = itemScore(item, normalized);
    if (score === null) {
      continue;
    }
    ranked.push({ item, score, tie: tieBreaker(item) });
  }
  ranked.sort((left, right) =>
    left.score === right.score ? left.tie.localeCompare(right.tie) : left.score - right.score
  );
  return ranked.map((entry) => entry.item);
}

// ---------------------------------------------------------------------------
// Insertion (§4.6.7)
// ---------------------------------------------------------------------------

export type CommandSelectionResult =
  | { action: "insert"; text: string; cursor: number }
  | { action: "client"; command: ClientSlashCommand; text: string; cursor: number }
  | { action: "host"; command: "compact"; text: string; cursor: number };

/**
 * What picking a row does:
 * - a **provider command** inserts `` `/name ` `` with a trailing space and the
 *   caret after it;
 * - a **skill** inserts `` `$name ` ``;
 * - a **host/client command inserts nothing** — it erases the trigger and acts.
 *
 * *T3: `apps/web/src/components/chat/ChatComposer.tsx:3597-3643`.*
 */
export function applyCommandSelection(
  text: string,
  trigger: ComposerTrigger,
  item: ComposerCommandItem
): CommandSelectionResult {
  switch (item.type) {
    case "provider": {
      const replaced = replaceTextRange(
        text,
        trigger.rangeStart,
        trigger.rangeEnd,
        `/${item.command.name} `
      );
      return { action: "insert", ...replaced };
    }
    case "skill": {
      const replaced = replaceTextRange(
        text,
        trigger.rangeStart,
        trigger.rangeEnd,
        `$${item.skill.name} `
      );
      return { action: "insert", ...replaced };
    }
    case "client": {
      const erased = replaceTextRange(text, trigger.rangeStart, trigger.rangeEnd, "");
      return { action: "client", command: item.command, ...erased };
    }
    case "host": {
      const erased = replaceTextRange(text, trigger.rangeStart, trigger.rangeEnd, "");
      return { action: "host", command: item.command, ...erased };
    }
  }
}

/**
 * Re-chip a stored message's `$skill` mentions at render time. **Nothing about
 * a command is persisted** (§4.6.7): the text is the record, and the same
 * tokeniser the composer uses reconstructs the chips.
 */
export function skillMentionsInText(text: string, knownSkillNames: readonly string[]): string[] {
  const known = new Set(knownSkillNames.map((name) => name.toLowerCase()));
  const found: string[] = [];
  for (const match of text.matchAll(/(?:^|\s)\p{Sc}([\w.-]+)/gu)) {
    const name = match[1];
    if (name && known.has(name.toLowerCase()) && !found.includes(name)) {
      found.push(name);
    }
  }
  return found;
}

/**
 * **Grok's `/always-approve` is refused** with a validation error pointing at
 * the permission chip, because a provider-side permission change would
 * desynchronise the host's runtime mode (§4.6.5).
 *
 * The daemon enforces this; the composer checks it first so the user gets the
 * pointer instead of a 400.
 */
export function blockedProviderCommandMessage(
  adapterId: string | undefined,
  text: string
): string | null {
  if (adapterId !== "grok") {
    return null;
  }
  return /^\/always-approve(\s|$)/i.test(text.trim())
    ? "Change the permission mode with the composer's mode chip — a provider-side change would desynchronise this thread."
    : null;
}
