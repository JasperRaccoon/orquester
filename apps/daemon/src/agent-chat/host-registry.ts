/**
 * Host updates (spec 2026-11-01 P2.2): the daemon's record of every agent host generation and its
 * role, `<appdir>/daemon/agent-hosts.json` (`agentHostRegistryPath`), and the foreign-threads file
 * a host boots with (`agentHostForeignThreadsPath`, P2.3 R15).
 *
 * The registry is how a restarted daemon finds the hosts it left running (P2.4 R29), so it is
 * written before every step a crash could leave half-done (I5) — atomically (tmp + rename), 0600.
 * It is tolerant like every other persisted store here: an entry this daemon cannot parse is kept
 * out of the live set but written back unchanged, and unknown fields of an entry it understands,
 * or of the file, survive its rewrite.
 */

import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  agentHostRegistryEntrySchema,
  agentHostRegistrySchema,
  type AgentHostRegistryEntry
} from "@orquester/config";

export interface HostRegistryFile {
  /** The entries this daemon understands, one per generation (the first of duplicates wins). */
  entries: AgentHostRegistryEntry[];
  /** Entries it could not parse (or duplicates): never live, always written back as they were. */
  unparsed: unknown[];
  /** Top-level fields besides `hosts`, written back as they were. */
  extra: Record<string, unknown>;
}

/** The registry file could not be read or is not a registry. Distinct from "missing". */
export class HostRegistryUnreadableError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "HostRegistryUnreadableError";
  }
}

/**
 * The registry at `path`, or null when there is none — the single-host layout, generation 0 the
 * primary. Throws {@link HostRegistryUnreadableError} for a file that exists but cannot be used.
 */
export async function readHostRegistry(path: string): Promise<HostRegistryFile | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") return null;
    throw new HostRegistryUnreadableError(`cannot read ${path}`, error);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    throw new HostRegistryUnreadableError(`${path} is not JSON`, error);
  }
  const file = agentHostRegistrySchema.safeParse(json);
  if (!file.success) throw new HostRegistryUnreadableError(`${path} is not an agent host registry`);
  const { hosts, ...extra } = file.data as { hosts: unknown[] } & Record<string, unknown>;
  const entries: AgentHostRegistryEntry[] = [];
  const unparsed: unknown[] = [];
  const seen = new Set<number>();
  for (const record of hosts) {
    const entry = agentHostRegistryEntrySchema.safeParse(record);
    if (!entry.success || seen.has(entry.data.generation)) {
      unparsed.push(record);
      continue;
    }
    seen.add(entry.data.generation);
    entries.push(entry.data);
  }
  return { entries, unparsed, extra };
}

/** Write the registry atomically (tmp + rename), 0600; entries first, by generation. */
export async function writeHostRegistry(path: string, registry: HostRegistryFile): Promise<void> {
  const hosts = [...[...registry.entries].sort((a, b) => a.generation - b.generation), ...registry.unparsed];
  await writeAtomic(path, `${JSON.stringify({ ...registry.extra, hosts }, null, 2)}\n`);
}

/**
 * P2.3 R15: the `{ "threadIds": string[] }` file a host boots with, naming every thread another
 * live host owns (I3). Atomic and 0600, like the token beside it.
 */
export async function writeForeignThreads(path: string, threadIds: Iterable<string>): Promise<void> {
  await writeAtomic(path, `${JSON.stringify({ threadIds: [...new Set(threadIds)].sort() })}\n`);
}

/**
 * The highest generation any registry record names, parsed or not — a generation a newer daemon
 * recorded is never handed out again. -1 when none does.
 */
export function highestRecordedGeneration(registry: HostRegistryFile): number {
  let highest = -1;
  for (const entry of registry.entries) highest = Math.max(highest, entry.generation);
  for (const record of registry.unparsed) {
    const generation = (record as { generation?: unknown } | null)?.generation;
    if (typeof generation === "number" && Number.isSafeInteger(generation) && generation >= 0) {
      highest = Math.max(highest, generation);
    }
  }
  return highest;
}

let tmpCounter = 0;

async function writeAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  tmpCounter += 1;
  const tmp = `${path}.${process.pid}.${tmpCounter}.tmp`;
  await writeFile(tmp, content, { encoding: "utf8", mode: 0o600 });
  await chmod(tmp, 0o600).catch(() => undefined);
  await rename(tmp, path);
}
