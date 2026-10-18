/**
 * Agent Profiles — the Grok section of a prepared directory's `manifest.json`
 * (`../manifest.ts`): what Grok's adapter in the agent host needs to launch a profile chat from
 * the prepared directory. OWNED BY THE GROK PREPARER TASK: extend the schema (and bump nothing
 * else) as that preparer learns what it writes. Must stay statically importable from the agent
 * host: zod only, no dynamic `import()`, no daemon services.
 *
 * Placeholder: an object; unknown keys are kept so a newer preparer's section still reads.
 */

import { z } from "zod";

export const grokPreparedSectionSchema = z.object({}).passthrough();
export type GrokPreparedSection = z.infer<typeof grokPreparedSectionSchema>;
