// Catalog family module `visuals` (html_preview, html_render; legacy session tools until Task 13) — owned by plan Task 13 (unified MCP, Wave 3).
// Task 2 stub: `visualsFamily` exports this family's tools as catalog tools; the owning task replaces it and
// Task 2 never edits this file again.

import { legacyChatTools } from "../catalog/legacy.ts";
import { htmlToolkit } from "../../session-tools/html/index.ts";
import type { AnyOrquesterTool } from "../catalog/contract.ts";

/** This family in the catalog (`../catalog/index.ts`). */
export const visualsFamily: readonly AnyOrquesterTool[] = legacyChatTools(htmlToolkit.tools);
