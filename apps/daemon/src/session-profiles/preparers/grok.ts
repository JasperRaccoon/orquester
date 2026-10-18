/**
 * Agent Profiles — Grok's preparer (spec §6). OWNED BY THE GROK PREPARER TASK: replace `null`
 * with an implementation of {@link SessionProfilePreparer} for `"grok"` and extend
 * `../manifest/grok.ts` with what it writes. Until then preparation for Grok fails with
 * "not supported yet" — a profile chat never launches unprepared.
 */

import type { SessionProfilePreparer } from "../preparer.ts";

export const grokPreparer: SessionProfilePreparer<"grok"> | null = null;
