// Catalog family module `secrets` (request_secret; legacy session tool until Task 13) — owned by plan Task 13 (unified MCP, Wave 3).
// Task 2 stub: `secretsFamily` exports this family's tools as catalog tools; the owning task replaces it and
// Task 2 never edits this file again.

import { legacyChatTools } from "../catalog/legacy.ts";
import { secretsToolkit } from "../../session-tools/secrets/index.ts";
import type { AnyOrquesterTool } from "../catalog/contract.ts";

/** This family in the catalog (`../catalog/index.ts`). */
export const secretsFamily: readonly AnyOrquesterTool[] = legacyChatTools(secretsToolkit.tools);
