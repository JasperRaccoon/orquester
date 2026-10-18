/**
 * Agent Profiles — Codex's preparer (spec §6). OWNED BY THE CODEX PREPARER TASK: replace `null`
 * with an implementation of {@link SessionProfilePreparer} for `"codex"` and extend
 * `../manifest/codex.ts` with what it writes. Until then preparation for Codex fails with
 * "not supported yet" — a profile chat never launches unprepared.
 */

import type { SessionProfilePreparer } from "../preparer.ts";

export const codexPreparer: SessionProfilePreparer<"codex"> | null = null;
