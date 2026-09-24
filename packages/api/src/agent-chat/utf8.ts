/**
 * UTF-8, byte-wise: the rule both sides of a byte-window read must share.
 * The agent host cuts `GET …/items/:itemId/output` windows with it
 * (`utf8Window`, `apps/daemon/src/agent-host/store/tool-output.ts`) and the
 * MCP's `read_tool_output` trims every window and windows every whole text
 * with it (`windowEnd`): a page is byte-identical whichever side cut it only
 * while both read a lead byte the same way — so there is one definition.
 *
 * No Node APIs: `@orquester/api` is shared with the browser.
 */

/** How many bytes the UTF-8 character a lead byte starts takes (1 for ASCII, or for a byte no character starts with). */
export function utf8SequenceLength(lead: number): number {
  return lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
}
