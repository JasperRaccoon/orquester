// Automation screenshots kept per desktop (spec 2026-11-10 §2.4): the last DESKTOP_SCREENSHOTS_KEPT
// of each under `desktopScreenshotsDir` (0700) as `<screenshotId>.<png|jpg>` with its facts in
// `<screenshotId>.json` (0600 both), so a chat row's thumbnail loads (`GET desktopRoutes.screenshot`)
// and an action naming the screenshot maps its coordinates through the scale and origin it was taken
// with. A VM desktop's are kept here too: its captures come back over the box link. Everything goes
// when the desktop closes. Ids are generated here and checked on every read: a request can never
// name a path.

import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DESKTOP_SCREENSHOTS_KEPT, type DesktopScreenshotInfo, type DesktopSize } from "@orquester/api";
import { desktopRuntimeDir, desktopScreenshotsDir } from "@orquester/config";

type ImageType = DesktopScreenshotInfo["mimeType"];

/** What an action needs to know about a screenshot it names. */
export interface DesktopScreenshotMeta {
  mimeType: ImageType;
  /** The image's size. */
  width: number;
  height: number;
  /** Display pixels per image pixel. */
  scale: number;
  /** The image's top-left in display pixels. */
  origin: { x: number; y: number };
  /** The display size when it was taken. */
  display: DesktopSize;
}

const DESKTOP_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SHOT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const EXTENSIONS: Record<ImageType, string> = { "image/png": "png", "image/jpeg": "jpg" };

export class DesktopScreenshotStore {
  /** Per desktop, the kept screenshots' facts, oldest first (this process's; a restart reads the directory). */
  private readonly kept = new Map<string, Map<string, DesktopScreenshotMeta>>();
  /** Per desktop, the ids on disk once listed (oldest first), so the cap also covers an earlier run's. */
  private readonly onDisk = new Map<string, string[]>();
  private writes: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly baseDir: string,
    private readonly logger: Pick<Console, "warn"> = console
  ) {}

  /**
   * Keep one screenshot; resolves its id once written. Its facts are kept in memory at once, so an
   * action can name it even when the disk write failed (the thumbnail then does not load).
   */
  async save(desktopId: string, image: { mimeType: ImageType; data: Buffer }, meta: Omit<DesktopScreenshotMeta, "mimeType">): Promise<string> {
    if (!DESKTOP_ID.test(desktopId)) throw new Error("Not a desktop id.");
    const id = randomUUID().replace(/-/g, "").slice(0, 20);
    const facts: DesktopScreenshotMeta = { mimeType: image.mimeType, ...meta };
    const kept = this.kept.get(desktopId) ?? new Map<string, DesktopScreenshotMeta>();
    kept.set(id, facts);
    while (kept.size > DESKTOP_SCREENSHOTS_KEPT) kept.delete(kept.keys().next().value!);
    this.kept.set(desktopId, kept);
    const run = async (): Promise<void> => {
      const dir = desktopScreenshotsDir(this.baseDir, desktopId);
      try {
        await mkdir(dir, { recursive: true, mode: 0o700 });
        await writeFile(join(dir, `${id}.${EXTENSIONS[image.mimeType]}`), image.data, { mode: 0o600 });
        await writeFile(join(dir, `${id}.json`), JSON.stringify(facts), { mode: 0o600 });
      } catch (error) {
        this.logger.warn("[desktops] could not keep a screenshot", error instanceof Error ? error.message : String(error));
        return;
      }
      const ids = this.onDisk.get(desktopId) ?? (await listIds(dir));
      if (!ids.includes(id)) ids.push(id);
      while (ids.length > DESKTOP_SCREENSHOTS_KEPT) {
        const old = ids.shift()!;
        kept.delete(old);
        await Promise.all(
          [...Object.values(EXTENSIONS), "json"].map((ext) => rm(join(dir, `${old}.${ext}`), { force: true }))
        );
      }
      this.onDisk.set(desktopId, ids);
    };
    const result = this.writes.then(run, run);
    this.writes = result;
    await result;
    return id;
  }

  /** A kept screenshot's facts, or null. */
  async meta(desktopId: string, screenshotId: string): Promise<DesktopScreenshotMeta | null> {
    if (!DESKTOP_ID.test(desktopId) || !SHOT_ID.test(screenshotId)) return null;
    const known = this.kept.get(desktopId)?.get(screenshotId);
    if (known) return known;
    const text = await readFile(join(desktopScreenshotsDir(this.baseDir, desktopId), `${screenshotId}.json`), "utf8").catch(() => null);
    return text === null ? null : parseMeta(text);
  }

  /** A kept screenshot's bytes and type, or null. */
  async read(desktopId: string, screenshotId: string): Promise<{ mimeType: ImageType; data: Buffer } | null> {
    if (!DESKTOP_ID.test(desktopId) || !SHOT_ID.test(screenshotId)) return null;
    const dir = desktopScreenshotsDir(this.baseDir, desktopId);
    for (const [mimeType, ext] of Object.entries(EXTENSIONS) as [ImageType, string][]) {
      try {
        return { mimeType, data: await readFile(join(dir, `${screenshotId}.${ext}`)) };
      } catch {
        // try the other type
      }
    }
    return null;
  }

  /** The desktop closed: its screenshots go (after any write still running). */
  async remove(desktopId: string): Promise<void> {
    this.kept.delete(desktopId);
    this.onDisk.delete(desktopId);
    if (!DESKTOP_ID.test(desktopId)) return;
    const run = async (): Promise<void> => {
      await rm(desktopScreenshotsDir(this.baseDir, desktopId), { recursive: true, force: true }).catch(() => undefined);
      // A VM desktop's dir here held only them (this machine's own dir went with the desktop).
      await rmdir(desktopRuntimeDir(this.baseDir, desktopId)).catch(() => undefined);
    };
    const result = this.writes.then(run, run);
    this.writes = result;
    await result;
  }
}

/** The ids on disk, oldest first. */
async function listIds(dir: string): Promise<string[]> {
  const names = await readdir(dir).catch(() => [] as string[]);
  const shots = await Promise.all(
    names
      .filter((name) => /^[A-Za-z0-9_-]{1,64}\.(png|jpg)$/.test(name))
      .map(async (name) => ({ id: name.replace(/\.(png|jpg)$/, ""), at: (await stat(join(dir, name)).catch(() => null))?.mtimeMs ?? 0 }))
  );
  return shots.sort((a, b) => a.at - b.at).map((shot) => shot.id);
}

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** A facts file as written by {@link DesktopScreenshotStore.save}, or null (another version's, or damaged). */
function parseMeta(text: string): DesktopScreenshotMeta | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object") return null;
  const { mimeType, width, height, scale, origin, display } = value as Record<string, unknown>;
  const point = origin as Record<string, unknown> | null;
  const size = display as Record<string, unknown> | null;
  if (mimeType !== "image/png" && mimeType !== "image/jpeg") return null;
  if (!finite(width) || !finite(height) || !finite(scale) || scale <= 0) return null;
  if (!point || typeof point !== "object" || !finite(point.x) || !finite(point.y)) return null;
  if (!size || typeof size !== "object" || !finite(size.width) || !finite(size.height)) return null;
  return { mimeType, width, height, scale, origin: { x: point.x, y: point.y }, display: { width: size.width, height: size.height } };
}
