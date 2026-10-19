/**
 * Temporary boxes for agent chats (Ephemeral AI VMs spec §13): the daemon side of the box MCP
 * tools. `contract.ts` — the {@link TemporaryBoxes} seam the box service implements and the
 * operation shapes; `tools.ts` — ownership, operations, chat-close cleanup; `routes.ts` — the
 * temporary-box routes.
 */

export type * from "./contract.ts";
export { registerTemporaryBoxRoutes } from "./routes.ts";
export { TemporaryBoxTools, type BoxCallOptions, type BoxOutcome, type TemporaryBoxesConnection, type TemporaryBoxToolsDeps } from "./tools.ts";
