/**
 * `tailnet.json` (`tailnetStorePath`): what Orquester itself set up with `tailscale serve` on the
 * daemon host (spec docs/superpowers/specs/2026-11-22-tailnet-machines-and-agent-ssh-design.md §4.7).
 * The daemon removes or repairs only routes recorded here, so this is its proof of ownership.
 *
 * - `https`: the daemon's own HTTPS route — whether the owner wants it, the tailnet port and the
 *   proxy target it was created with (`http://127.0.0.1:<daemon port>`).
 * - `previews`: shared dev-server ports, keyed by port; each records its proxy target and the chat
 *   that shared it.
 *
 * Ports, targets and ids only: nothing here is secret. Tolerant like every store: a record this
 * version cannot read is kept as it was on rewrite, and unknown keys survive.
 */

import { z } from "zod";

export const TAILNET_STORE_VERSION = 1;

const port = z.number().int().min(1).max(65535);

export const storedTailnetHttpsSchema = z
  .object({
    /** The owner wants the daemon served on the tailnet: the 30 s check repairs it. */
    enabled: z.boolean(),
    /** The tailnet HTTPS port. */
    port,
    /** The proxy target Orquester created the route with; null when it adopted no route yet. */
    target: z.string().min(1).nullable().default(null),
    updatedAt: z.string()
  })
  .passthrough();
export type StoredTailnetHttps = z.infer<typeof storedTailnetHttpsSchema>;

export const storedTailnetPreviewSchema = z
  .object({
    /** The host port shared; the tailnet HTTPS port is the same number. */
    port,
    /** The proxy target the route was created with (`http://127.0.0.1:<port>` or `http://[::1]:<port>`). */
    target: z.string().min(1),
    /** The chat that shared it (its close removes the share); null when shared from the UI. */
    threadId: z.string().min(1).nullable().default(null),
    /** For a box project: the port in the box the agent named (forwarded to `port` on the host). */
    projectPort: port.optional(),
    createdAt: z.string()
  })
  .passthrough();
export type StoredTailnetPreview = z.infer<typeof storedTailnetPreviewSchema>;

export interface TailnetFile {
  version: typeof TAILNET_STORE_VERSION;
  https: StoredTailnetHttps | null;
  /** Keyed by `String(port)`. */
  previews: Record<string, StoredTailnetPreview>;
  /** An `https` record this version cannot read, kept as it was. */
  rejectedHttps?: unknown;
  /** Preview records this version cannot read, kept as they were. */
  rejected: Record<string, unknown>;
  /** Unknown top-level keys, kept on rewrite. */
  extra: Record<string, unknown>;
}

export function createDefaultTailnetFile(): TailnetFile {
  return { version: TAILNET_STORE_VERSION, https: null, previews: {}, rejected: {}, extra: {} };
}

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** Parse `tailnet.json`; throws only when the file is not a version-1 tailnet file at all. */
export function parseTailnetFile(raw: unknown): TailnetFile {
  if (!isRecord(raw)) throw new Error("Not a tailnet file (the file is not a JSON object)");
  if (raw.version !== undefined && raw.version !== TAILNET_STORE_VERSION) {
    throw new Error(`Not a version-${TAILNET_STORE_VERSION} tailnet file (version ${JSON.stringify(raw.version)})`);
  }
  if (raw.previews !== undefined && !isRecord(raw.previews)) throw new Error("Not a tailnet file (previews: expected an object)");
  const file = createDefaultTailnetFile();
  if (raw.https !== undefined && raw.https !== null) {
    const parsed = storedTailnetHttpsSchema.safeParse(raw.https);
    if (parsed.success) file.https = parsed.data;
    else file.rejectedHttps = raw.https;
  }
  for (const [key, entry] of Object.entries(raw.previews ?? {})) {
    const parsed = storedTailnetPreviewSchema.safeParse(entry);
    if (parsed.success && String(parsed.data.port) === key) file.previews[key] = parsed.data;
    else file.rejected[key] = entry;
  }
  file.extra = Object.fromEntries(Object.entries(raw).filter(([key]) => key !== "version" && key !== "https" && key !== "previews"));
  return file;
}

export function serializeTailnetFile(file: TailnetFile): Record<string, unknown> {
  const https = file.https ?? file.rejectedHttps ?? null;
  // A preview this version wrote replaces an unreadable one under the same port.
  return { ...file.extra, version: TAILNET_STORE_VERSION, https, previews: { ...file.rejected, ...file.previews } };
}
