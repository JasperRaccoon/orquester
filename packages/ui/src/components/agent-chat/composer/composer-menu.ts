// Ported from T3 Code (MIT): apps/web/src/components/chat/composerSlashCommandSearch.ts,
// packages/shared/src/searchRanking.ts, packages/client-runtime/src/providerSkills.ts
/**
 * The `/` and `$` menus: what is offered, in what order, and what each row
 * inserts (spec §4.6.7, §4.6.8).
 *
 * Everything here is pure — the component feeds it a snapshot and a trigger and
 * renders the rows it gets back. Three rules carry the design:
 *
 *  - **Position gating.** Away from offset 0, provider commands are removed;
 *    host commands and skills stay. A provider expands a command only when it
 *    opens the whole message.
 *  - **Ranking.** Name match beats description match; ties break host commands
 *    → provider commands → skills, through a `0\0` / `1\0` / `2\0` tie-breaker
 *    rather than a second sort pass.
 *  - **A skill the provider also advertises as a command is listed once, as
 *    the skill** — the skill row knows its path, scope and invocability; the
 *    command row knows only a name.
 */

import type { Skill, SlashCommand } from "@orquester/api/agent-chat";

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

/**
 * §4.6.5(a) — the rows that never leave the browser. Selecting one erases the
 * typed text and performs the action; it is never inserted into the draft.
 *
 * `/compact` is deliberately NOT here: §4.6.3 synthesises it into every
 * adapter's catalog, so it arrives as an ordinary provider command and is
 * gated by {@link compactCommandAvailable}.
 */
export type HostComposerCommand = "model" | "effort" | "plan" | "default";

export type ComposerMenuItem =
  | {
      id: string;
      type: "path";
      label: string;
      description: string;
      path: string;
      pathKind: "file" | "dir";
    }
  | { id: string; type: "host-command"; label: string; description: string; command: HostComposerCommand }
  | { id: string; type: "provider-command"; label: string; description: string; command: SlashCommand }
  | { id: string; type: "skill"; label: string; description: string; skill: Skill };

/** The three item types the `/` menu ranks together. */
export type SlashMenuItem = Extract<
  ComposerMenuItem,
  { type: "host-command" | "provider-command" | "skill" }
>;

// ---------------------------------------------------------------------------
// Skills (§4.6.8)
// ---------------------------------------------------------------------------

/**
 * Whether a composer pick can start this skill.
 *
 * A disabled skill will not run, and one the provider reserves for the agent
 * (`userInvocable: false`) rejects a user invocation. Everything else is fair
 * game — including `userInvocationOnly` skills, which are the *reason* to show
 * a menu: the agent cannot start them, so `/` is the only way to run them.
 *
 * *T3: `providerSkills.ts:44-56`.*
 */
export function isProviderSkillUserInvocable(skill: Skill): boolean {
  return skill.enabled && skill.userInvocable !== false;
}

function dedupeSkillsByName(skills: readonly Skill[]): Skill[] {
  const seen = new Set<string>();
  return skills.filter((skill) => {
    const key = skill.name.trim().toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** `$` always lists skills; `/` lists them only when the setting is on. */
export function skillsForSlashMenu(
  skills: readonly Skill[],
  showSkillsInSlashMenu: boolean
): Skill[] {
  return showSkillsInSlashMenu ? dedupeSkillsByName(skills.filter(isProviderSkillUserInvocable)) : [];
}

/** The `$` menu: every invocable skill, deduped by name. */
export function skillsForSkillMenu(skills: readonly Skill[]): Skill[] {
  return dedupeSkillsByName(skills.filter(isProviderSkillUserInvocable));
}

/**
 * Drop any command whose name collides with a visible skill (§4.6.8) **or with
 * a host command** (§4.6.5(a)).
 *
 * The host collision is not hypothetical: the Codex and OpenCode snapshots
 * synthesise an `effort` entry, and `/effort` is client-only — picking the
 * provider row would insert the literal text `/effort ` and forward it to a
 * CLI that does not implement it. `/compact` is the one host command a
 * provider catalog legitimately carries (§4.6.3 synthesises it), and it is
 * deduped the same way: one row, which takes the host-native path rather than
 * being typed into the draft.
 */
export function providerCommandsForSlashMenu(
  commands: readonly SlashCommand[],
  visibleSkills: readonly Skill[],
  hostCommandNames: readonly string[] = []
): SlashCommand[] {
  const taken = new Set([
    ...visibleSkills.map((skill) => skill.name.trim().toLowerCase()),
    ...hostCommandNames.map((name) => name.trim().toLowerCase())
  ]);
  return commands.filter((command) => !taken.has(command.name.trim().toLowerCase()));
}

// Absorbed from W11's `lib/agent-chat/slash-commands.logic.ts`, which this
// module replaces (fix-wave arbitration R2-5).
/**
 * **Grok's `/always-approve` is refused** with a pointer at the permission
 * chip, because a provider-side permission change would desynchronise the
 * host's runtime mode (§4.6.5(c)).
 *
 * The daemon enforces it too; the composer checks first so the user gets the
 * pointer instead of a turn that fails after the message is already committed.
 * Must be called on the SEND path, not only in the menu — it can be typed.
 */
/**
 * The `$skill` mentions in a piece of text, in order, deduped.
 *
 * §4.6.7: "`$skill` mentions are re-chipped from the stored text by the same
 * tokeniser the composer uses. No `isCommand` flag is persisted." This is that
 * tokeniser — the timeline re-runs it over a sent user message against the
 * current per-cwd skill list so a mention renders as a chip rather than as raw
 * `$name`, and the round trip stays one-way-derivable from the text.
 *
 * Only *known* names match: an unknown `$foo` stays literal, exactly as the
 * send path leaves it (§4.6.8). `\p{Sc}` rather than a literal `$` for the
 * same reason the composer's trigger uses it — a keyboard laid out for € or £
 * reaches skills too.
 *
 * Restored here after W11's `slash-commands.logic.ts` was deleted in the
 * fix-wave arbitration (R2-5); this module is the one slash/skill
 * implementation, so the tokeniser belongs with it.
 */
export function skillMentionsInText(
  text: string,
  knownSkillNames: readonly string[]
): string[] {
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

function titleCaseWords(value: string): string {
  const words: string[] = [];
  for (const segment of value.split(/[\s:_-]+/)) {
    if (segment.length === 0) continue;
    words.push(segment.charAt(0).toUpperCase() + segment.slice(1));
  }
  return words.join(" ");
}

export function formatSkillDisplayName(skill: Skill): string {
  const displayName = skill.displayName?.trim();
  return displayName ? displayName : titleCaseWords(skill.name);
}

export function skillDescription(skill: Skill): string {
  return (
    skill.shortDescription ?? skill.description ?? (skill.scope ? `${skill.scope} skill` : "Run provider skill")
  );
}

/**
 * The row's secondary line. **Argument hints render there when there is no
 * description** — there is no parameter form and no placeholder-stepping.
 *
 * *T3: `ChatComposer.tsx:2358` — `description ?? input.hint ?? "Run provider command"`.*
 */
export function providerCommandDescription(command: SlashCommand): string {
  return command.description ?? command.input?.hint ?? "Run provider command";
}

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

export function normalizeSearchQuery(input: string, trimLeadingPattern?: RegExp): string {
  const trimmed = input.trim();
  if (!trimmed) return "";
  return (trimLeadingPattern ? trimmed.replace(trimLeadingPattern, "") : trimmed).toLowerCase();
}

function lengthPenalty(value: string, query: string): number {
  return Math.min(64, Math.max(0, value.length - query.length));
}

function findBoundaryMatchIndex(
  value: string,
  query: string,
  boundaryMarkers: readonly string[]
): number | null {
  let best: number | null = null;
  for (const marker of boundaryMarkers) {
    const index = value.indexOf(`${marker}${query}`);
    if (index === -1) continue;
    const matchIndex = index + marker.length;
    if (best === null || matchIndex < best) best = matchIndex;
  }
  return best;
}

/** Subsequence ("fuzzy") distance: lower is better, `null` when it does not match. */
export function scoreSubsequenceMatch(value: string, query: string): number | null {
  if (!query) return 0;
  let queryIndex = 0;
  let firstMatchIndex = -1;
  let previousMatchIndex = -1;
  let gapPenalty = 0;

  for (let valueIndex = 0; valueIndex < value.length; valueIndex += 1) {
    if (value[valueIndex] !== query[queryIndex]) continue;
    if (firstMatchIndex === -1) firstMatchIndex = valueIndex;
    if (previousMatchIndex !== -1) gapPenalty += valueIndex - previousMatchIndex - 1;
    previousMatchIndex = valueIndex;
    queryIndex += 1;
    if (queryIndex === query.length) {
      const spanPenalty = valueIndex - firstMatchIndex + 1 - query.length;
      return firstMatchIndex * 2 + gapPenalty * 3 + spanPenalty + lengthPenalty(value, query);
    }
  }
  return null;
}

/**
 * Tiered match score; **lower is better** and `null` means "no match".
 * Expects pre-normalised (trimmed, lowercased) inputs.
 *
 * *T3: `searchRanking.ts:81-135`.*
 */
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
  if (!value || !query) return null;
  if (value === query) return input.exactBase;

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
    if (fuzzy !== null) return input.fuzzyBase + fuzzy;
  }
  return null;
}

/** Name match beats description match: the two bases never overlap. */
function scoreSlashMenuItem(item: SlashMenuItem, query: string): number | null {
  const primaryValue =
    item.type === "host-command"
      ? item.command.toLowerCase()
      : item.type === "provider-command"
        ? item.command.name.toLowerCase()
        : item.skill.name.toLowerCase();

  const scores = [
    scoreQueryMatch({
      value: primaryValue,
      query,
      exactBase: 0,
      prefixBase: 2,
      boundaryBase: 4,
      includesBase: 6,
      fuzzyBase: 100,
      boundaryMarkers: ["-", "_", "/"]
    }),
    scoreQueryMatch({
      value: item.description.toLowerCase(),
      query,
      exactBase: 20,
      prefixBase: 22,
      boundaryBase: 24,
      includesBase: 26
    })
  ].filter((score): score is number => score !== null);

  return scores.length === 0 ? null : Math.min(...scores);
}

function tieBreakerFor(item: SlashMenuItem): string {
  if (item.type === "host-command") return `0\u0000${item.command}`;
  if (item.type === "provider-command") return `1\u0000${item.command.name}`;
  return `2\u0000${item.skill.name}`;
}

/**
 * §4.6.7: away from offset 0 provider commands are removed; host commands
 * apply locally and skills insert a `$` mention the host dispatches from any
 * position, so both stay.
 *
 * *T3: `composerSlashCommandSearch.ts:15-29`.*
 */
export function slashMenuItemsForPromptPosition(
  items: readonly SlashMenuItem[],
  isAtPromptStart: boolean
): SlashMenuItem[] {
  if (isAtPromptStart) return [...items];
  return items.filter((item) => item.type !== "provider-command");
}

export function searchSlashMenuItems(
  items: readonly SlashMenuItem[],
  query: string
): SlashMenuItem[] {
  const normalized = normalizeSearchQuery(query, /^\/+/);
  if (!normalized) return [...items];

  const ranked: Array<{ item: SlashMenuItem; score: number; tieBreaker: string }> = [];
  for (const item of items) {
    const score = scoreSlashMenuItem(item, normalized);
    if (score === null) continue;
    ranked.push({ item, score, tieBreaker: tieBreakerFor(item) });
  }
  ranked.sort((left, right) =>
    left.score !== right.score
      ? left.score - right.score
      : left.tieBreaker.localeCompare(right.tieBreaker)
  );
  return ranked.map((entry) => entry.item);
}

export function searchSkills(skills: readonly Skill[], query: string): Skill[] {
  const normalized = normalizeSearchQuery(query);
  if (!normalized) return [...skills];
  const ranked: Array<{ skill: Skill; score: number }> = [];
  for (const skill of skills) {
    const score = scoreQueryMatch({
      value: skill.name.toLowerCase(),
      query: normalized,
      exactBase: 0,
      prefixBase: 2,
      boundaryBase: 4,
      includesBase: 6,
      fuzzyBase: 100,
      boundaryMarkers: ["-", "_", "/"]
    });
    if (score === null) continue;
    ranked.push({ skill, score });
  }
  ranked.sort((left, right) =>
    left.score !== right.score ? left.score - right.score : left.skill.name.localeCompare(right.skill.name)
  );
  return ranked.map((entry) => entry.skill);
}

// ---------------------------------------------------------------------------
// Building the menu
// ---------------------------------------------------------------------------

export interface SlashMenuInput {
  slashCommands: readonly SlashCommand[];
  skills: readonly Skill[];
  /** §4.6.7: `/plan` and `/default` only where the toggle is shown (§4.4). */
  showPlanModeToggle: boolean;
  /** `/effort` only when the selected model carries a reasoning descriptor. */
  hasEffortOption: boolean;
  /** §4.6.7 precondition list for `/compact` — see {@link compactCommandAvailable}. */
  compactAvailable: boolean;
  /** User setting, default on. `$` always lists skills regardless. */
  showSkillsInSlashMenu: boolean;
  isAtPromptStart: boolean;
  query: string;
}

const HOST_COMMAND_DESCRIPTIONS: Record<HostComposerCommand, string> = {
  model: "Switch the model for this thread",
  effort: "Change the reasoning effort for this thread",
  plan: "Switch this thread into plan mode",
  default: "Switch this thread back to normal build mode"
};

/**
 * §4.6.7's `/compact` precondition, in full: the thread has something to
 * compact, and the draft is otherwise empty — no text after the trigger, no
 * text before it, no attachments and no context chips — because the
 * host-native path discards all of that.
 *
 * *T3: `ChatComposer.tsx:2234-2244`.*
 */
export function compactCommandAvailable(input: {
  threadHasContent: boolean;
  textBeforeTrigger: string;
  textAfterTrigger: string;
  attachmentCount: number;
  contextCount: number;
}): boolean {
  return (
    input.threadHasContent &&
    input.textBeforeTrigger.trim() === "" &&
    input.textAfterTrigger.trim() === "" &&
    input.attachmentCount === 0 &&
    input.contextCount === 0
  );
}

/** The `/` menu's rows, gated and ranked. */
export function buildSlashMenuItems(input: SlashMenuInput): SlashMenuItem[] {
  const hostCommands: HostComposerCommand[] = ["model"];
  if (input.hasEffortOption) hostCommands.push("effort");
  if (input.showPlanModeToggle) hostCommands.push("plan", "default");

  const hostItems: SlashMenuItem[] = hostCommands.map((command) => ({
    id: `host:${command}`,
    type: "host-command",
    command,
    label: `/${command}`,
    description: HOST_COMMAND_DESCRIPTIONS[command]
  }));

  const visibleSkills = skillsForSlashMenu(input.skills, input.showSkillsInSlashMenu);
  const providerItems: SlashMenuItem[] = providerCommandsForSlashMenu(
    input.slashCommands,
    visibleSkills,
    // `/effort` is client-only, so a synthesised provider row for it is a
    // duplicate that would reach the CLI as literal text (R2-2). `/compact` is
    // handled below: it stays a provider row, because the host-native path
    // recognises it from the sent text.
    hostCommands
  )
    .filter((command) => command.name !== "compact" || input.compactAvailable)
    .map((command) => ({
      id: `provider:${command.name}`,
      type: "provider-command",
      command,
      label: `/${command.name}`,
      description: providerCommandDescription(command)
    }));

  const skillItems: SlashMenuItem[] = visibleSkills.map((skill) => ({
    id: `skill:${skill.name}`,
    type: "skill",
    skill,
    label: `/${skill.name}`,
    description: skillDescription(skill)
  }));

  return searchSlashMenuItems(
    slashMenuItemsForPromptPosition(
      [...hostItems, ...providerItems, ...skillItems],
      input.isAtPromptStart
    ),
    input.query
  );
}

/** The `$` menu's rows. Skills only, always, regardless of the `/` setting. */
export function buildSkillMenuItems(skills: readonly Skill[], query: string): ComposerMenuItem[] {
  return searchSkills(skillsForSkillMenu(skills), query).map((skill) => ({
    id: `skill:${skill.name}`,
    type: "skill" as const,
    skill,
    label: formatSkillDisplayName(skill),
    description: skillDescription(skill)
  }));
}

// ---------------------------------------------------------------------------
// Insertion (§4.6.7)
// ---------------------------------------------------------------------------

/**
 * What a row does when it is picked.
 *
 *  - a provider command inserts `` `/name ` `` with a trailing space,
 *  - a skill inserts `` `$name ` ``,
 *  - a path inserts the canonical path with a trailing space,
 *  - **a host command inserts nothing** — it erases the trigger and acts.
 *
 * *T3: `ChatComposer.tsx:3597-3643`.*
 */
export function menuItemReplacement(item: ComposerMenuItem): string {
  switch (item.type) {
    case "host-command":
      return "";
    case "provider-command":
      return `/${item.command.name} `;
    case "skill":
      return `$${item.skill.name} `;
    case "path":
      return `@${item.path} `;
  }
}
