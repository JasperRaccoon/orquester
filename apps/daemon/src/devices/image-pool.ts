/**
 * Device images off the event loop: the fleet view's thumbnails and the agent's screenshots are
 * decoded, scaled and re-encoded (`screenshot-image.ts`, ~300 ms for a 720×1280 frame) in a small
 * pool of worker threads (`image-worker.ts`).
 *
 * - **Bounded.** At most {@link IMAGE_WORKERS} workers, started on demand and stopped after
 *   {@link IMAGE_WORKER_IDLE_MS} idle; at most {@link IMAGE_QUEUE_CAP} jobs wait, beyond that a job
 *   is refused ({@link ImagePoolBusyError}).
 * - **Coalescing.** A keyed job (a thumbnail: the lease id) replaces a queued job of the same key
 *   that has not started: the stale frame is never encoded, and its callers get the newer result.
 * - **Agent first.** Screenshots (unkeyed: each one is an agent's answer) queue ahead of thumbnails.
 * - **Deadline.** A job running longer than {@link IMAGE_JOB_TIMEOUT_MS} ends its worker (the next
 *   job starts a fresh one) and fails; so does a worker that crashes.
 *
 * The worker inherits the daemon's `execArgv` (`--import tsx`), so its `.ts` entry loads with no
 * build step.
 */

import { Worker } from "node:worker_threads";

import type { FittedScreenshot } from "./screenshot-image.ts";

const IMAGE_WORKERS = 2;
const IMAGE_QUEUE_CAP = 32;
const IMAGE_JOB_TIMEOUT_MS = 30_000;
const IMAGE_WORKER_IDLE_MS = 60_000;

export type ImageJob = { kind: "thumbnail"; image: Uint8Array; width: number } | { kind: "fit"; png: Uint8Array; maxBase64Chars: number };

export type ImageResult =
  | { kind: "thumbnail"; data: Uint8Array }
  | { kind: "fit"; mimeType: FittedScreenshot["mimeType"]; data: Uint8Array; width: number; height: number };

/** Main thread → worker. */
export interface ImageWorkerRequest {
  id: number;
  job: ImageJob;
}

/** Worker → main thread. */
export type ImageWorkerReply = { id: number; ok: true; result: ImageResult } | { id: number; ok: false; error: string };

/** The queue is full: try again shortly. */
export class ImagePoolBusyError extends Error {
  constructor() {
    super("The device image workers are busy.");
    this.name = "ImagePoolBusyError";
  }
}

interface Waiter {
  resolve(result: ImageResult): void;
  reject(error: Error): void;
}

interface Job {
  job: ImageJob;
  key: string | null;
  waiters: Waiter[];
}

interface Slot {
  worker: Worker;
  job: (Job & { id: number }) | null;
  timer: ReturnType<typeof setTimeout> | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

export interface ImageWorkerPoolOptions {
  size?: number;
  queueCap?: number;
  jobTimeoutMs?: number;
  idleMs?: number;
  /** The worker entry (tests: a stand-in). */
  entry?: URL;
}

export class ImageWorkerPool {
  private readonly size: number;
  private readonly queueCap: number;
  private readonly jobTimeoutMs: number;
  private readonly idleMs: number;
  private readonly entry: URL;
  private readonly slots = new Set<Slot>();
  private readonly queue: Job[] = [];
  private nextId = 1;
  private closed = false;

  constructor(options: ImageWorkerPoolOptions = {}) {
    this.size = Math.max(1, options.size ?? IMAGE_WORKERS);
    this.queueCap = Math.max(1, options.queueCap ?? IMAGE_QUEUE_CAP);
    this.jobTimeoutMs = options.jobTimeoutMs ?? IMAGE_JOB_TIMEOUT_MS;
    this.idleMs = options.idleMs ?? IMAGE_WORKER_IDLE_MS;
    this.entry = options.entry ?? new URL("./image-worker.ts", import.meta.url);
  }

  /** A PNG (a JPEG passes through) as a JPEG at most `width` px wide; `key` (the lease) coalesces queued frames. */
  async thumbnail(key: string, image: Buffer, width: number): Promise<Buffer> {
    if (image[0] === 0xff && image[1] === 0xd8) return image;
    const result = await this.run({ kind: "thumbnail", image, width }, key);
    if (result.kind !== "thumbnail") throw new Error("The image worker answered another job.");
    return toBuffer(result.data);
  }

  /** `fitScreenshot` in a worker: the PNG when it fits, else a JPEG scaled until it does. */
  async fit(png: Buffer, maxBase64Chars: number): Promise<FittedScreenshot> {
    const result = await this.run({ kind: "fit", png, maxBase64Chars }, null);
    if (result.kind !== "fit") throw new Error("The image worker answered another job.");
    return { mimeType: result.mimeType, data: toBuffer(result.data), width: result.width, height: result.height };
  }

  /** Workers running, jobs running and jobs waiting (tests, diagnostics). */
  stats(): { workers: number; running: number; queued: number } {
    return { workers: this.slots.size, running: [...this.slots].filter((slot) => slot.job !== null).length, queued: this.queue.length };
  }

  /** End every worker; queued and running jobs fail. A later job starts the pool again. */
  async close(): Promise<void> {
    this.closed = true;
    for (const job of this.queue.splice(0)) for (const waiter of job.waiters) waiter.reject(new Error("The device image workers stopped."));
    await Promise.all([...this.slots].map((slot) => this.retire(slot, new Error("The device image workers stopped."))));
    this.closed = false;
  }

  private run(job: ImageJob, key: string | null): Promise<ImageResult> {
    return new Promise<ImageResult>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject };
      if (key !== null) {
        const stale = this.queue.find((entry) => entry.key === key);
        if (stale) {
          // The queued frame is stale: the newer one is encoded instead, for both callers.
          stale.job = job;
          stale.waiters.push(waiter);
          return;
        }
      }
      if (this.queue.length >= this.queueCap) {
        reject(new ImagePoolBusyError());
        return;
      }
      const entry: Job = { job, key, waiters: [waiter] };
      if (key === null) {
        // Agent screenshots go ahead of thumbnails (after earlier screenshots).
        const at = this.queue.findIndex((queued) => queued.key !== null);
        if (at === -1) this.queue.push(entry);
        else this.queue.splice(at, 0, entry);
      } else {
        this.queue.push(entry);
      }
      this.pump();
    });
  }

  private pump(): void {
    while (this.queue.length > 0) {
      const slot = [...this.slots].find((entry) => entry.job === null) ?? (this.slots.size < this.size ? this.spawn() : null);
      if (!slot) return;
      this.dispatch(slot, this.queue.shift()!);
    }
  }

  private spawn(): Slot {
    const worker = new Worker(this.entry);
    const slot: Slot = { worker, job: null, timer: null, idleTimer: null };
    worker.unref();
    worker.on("message", (reply: ImageWorkerReply) => this.answered(slot, reply));
    worker.on("error", (error) => void this.retire(slot, new Error(`The device image worker failed: ${error.message}`)));
    worker.on("exit", (code) => void this.retire(slot, new Error(`The device image worker stopped (exit ${code}).`)));
    this.slots.add(slot);
    return slot;
  }

  private dispatch(slot: Slot, job: Job): void {
    if (slot.idleTimer) clearTimeout(slot.idleTimer);
    slot.idleTimer = null;
    const id = this.nextId++;
    slot.job = { ...job, id };
    // A job in flight keeps the process alive until it answers (an idle worker never does).
    slot.worker.ref();
    slot.timer = setTimeout(() => void this.retire(slot, new Error(`The device image took longer than ${Math.round(this.jobTimeoutMs / 1000)} s to encode.`)), this.jobTimeoutMs);
    slot.timer.unref?.();
    slot.worker.postMessage({ id, job: job.job } satisfies ImageWorkerRequest);
  }

  private answered(slot: Slot, reply: ImageWorkerReply): void {
    const job = slot.job;
    if (!job || reply.id !== job.id) return;
    if (slot.timer) clearTimeout(slot.timer);
    slot.timer = null;
    slot.job = null;
    slot.worker.unref();
    for (const waiter of job.waiters) {
      if (reply.ok) waiter.resolve(reply.result);
      else waiter.reject(new Error(reply.error));
    }
    if (this.queue.length > 0) {
      this.pump();
      return;
    }
    slot.idleTimer = setTimeout(() => void this.retire(slot, null), this.idleMs);
    slot.idleTimer.unref?.();
  }

  /** Take a worker out (crashed, timed out, idle or closing): its job fails with `error`; queued jobs move on. */
  private async retire(slot: Slot, error: Error | null): Promise<void> {
    if (!this.slots.delete(slot)) return;
    if (slot.timer) clearTimeout(slot.timer);
    if (slot.idleTimer) clearTimeout(slot.idleTimer);
    const job = slot.job;
    slot.job = null;
    if (job) for (const waiter of job.waiters) waiter.reject(error ?? new Error("The device image worker stopped."));
    await slot.worker.terminate().catch(() => undefined);
    if (!this.closed) this.pump();
  }
}

function toBuffer(data: Uint8Array): Buffer {
  return Buffer.isBuffer(data) ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

/** The daemon's one image pool (thumbnails and agent screenshots share its workers). */
export const deviceImages = new ImageWorkerPool();
