/**
 * Agent Profiles — Claude's preparer (spec §6). OWNED BY THE CLAUDE PREPARER TASK: replace `null`
 * with an implementation of {@link SessionProfilePreparer} for `"claude"` and extend
 * `../manifest/claude.ts` with what it writes. Until then preparation for Claude fails with
 * "not supported yet" — a profile chat never launches unprepared.
 */

import type { SessionProfilePreparer } from "../preparer.ts";

export const claudePreparer: SessionProfilePreparer<"claude"> | null = null;
