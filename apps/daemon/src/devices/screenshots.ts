/**
 * Screenshots kept for chat rows (devices spec §9): the last {@link SCREENSHOTS_PER_LEASE} of each
 * lease under `deviceScreenshotsDir` as `<leaseId>/<screenshotId>.<png|jpg>`, with a `thread` file
 * naming the chat, so a `deviceRef` thumbnail still loads after its lease ended and everything of a
 * chat goes when the chat closes. Ids are generated here and checked on every read: a request can
 * never name a path.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const SCREENSHOTS_PER_LEASE = 20;

const LEASE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const SHOT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const EXTENSIONS = { "image/png": "png", "image/jpeg": "jpg" } as const;
type ImageType = keyof typeof EXTENSIONS;

export class DeviceScreenshots {
  /** Per lease, the kept ids, oldest first (this process's; a restart reads the directory). */
  private readonly kept = new Map<string, string[]>();
  private writes: Promise<unknown> = Promise.resolve();

  constructor(private readonly dir: string, private readonly logger: Pick<Console, "warn"> = console) {}

  /** Keep one screenshot; resolves its id (null when it could not be written). */
  async save(threadId: string, leaseId: string, image: { mimeType: ImageType; data: Buffer }): Promise<string | null> {
    if (!LEASE_ID.test(leaseId)) return null;
    const id = randomUUID().replace(/-/g, "").slice(0, 20);
    const run = async (): Promise<string | null> => {
      const leaseDir = join(this.dir, leaseId);
      try {
        await mkdir(leaseDir, { recursive: true, mode: 0o700 });
        await writeFile(join(leaseDir, "thread"), threadId, { mode: 0o600 });
        await writeFile(join(leaseDir, `${id}.${EXTENSIONS[image.mimeType]}`), image.data, { mode: 0o600 });
      } catch (error) {
        this.logger.warn("[devices] could not keep a screenshot", error instanceof Error ? error.message : String(error));
        return null;
      }
      const ids = this.kept.get(leaseId) ?? (await this.listIds(leaseDir));
      if (!ids.includes(id)) ids.push(id);
      while (ids.length > SCREENSHOTS_PER_LEASE) {
        const old = ids.shift()!;
        await Promise.all(Object.values(EXTENSIONS).map((ext) => rm(join(leaseDir, `${old}.${ext}`), { force: true })));
      }
      this.kept.set(leaseId, ids);
      return id;
    };
    const result = this.writes.then(run, run);
    this.writes = result;
    return result;
  }

  /** A kept screenshot's bytes and type, or null. */
  async read(leaseId: string, screenshotId: string): Promise<{ mimeType: ImageType; data: Buffer } | null> {
    if (!LEASE_ID.test(leaseId) || !SHOT_ID.test(screenshotId)) return null;
    for (const [mimeType, ext] of Object.entries(EXTENSIONS) as [ImageType, string][]) {
      try {
        return { mimeType, data: await readFile(join(this.dir, leaseId, `${screenshotId}.${ext}`)) };
      } catch {
        // try the other type
      }
    }
    return null;
  }

  /** The chat closed: every screenshot of its leases goes. */
  async forgetThread(threadId: string): Promise<void> {
    let leases: string[];
    try {
      leases = await readdir(this.dir);
    } catch {
      return;
    }
    for (const leaseId of leases) {
      if (!LEASE_ID.test(leaseId)) continue;
      const owner = await readFile(join(this.dir, leaseId, "thread"), "utf8").catch(() => null);
      if (owner !== threadId) continue;
      this.kept.delete(leaseId);
      await rm(join(this.dir, leaseId), { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** The ids on disk, oldest first. */
  private async listIds(leaseDir: string): Promise<string[]> {
    const names = await readdir(leaseDir).catch(() => [] as string[]);
    const shots = await Promise.all(
      names
        .filter((name) => /\.(png|jpg)$/.test(name))
        .map(async (name) => ({ id: name.replace(/\.(png|jpg)$/, ""), at: (await stat(join(leaseDir, name)).catch(() => null))?.mtimeMs ?? 0 }))
    );
    return shots.sort((a, b) => a.at - b.at).map((shot) => shot.id);
  }
}
