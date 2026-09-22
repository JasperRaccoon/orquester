/**
 * Agent host — an incremental, bounded tail of a file a provider child writes
 * (spec §4.5 Claude, "background shells").
 *
 * The Claude CLI does not stream a `run_in_background` Bash's output on the
 * SDK channel at all: it writes it to a file under its own tmp tree and tells
 * the model to `Read` that path. Nothing else in this host reads a provider's
 * scratch file, so the rules live here rather than in the session:
 *
 * - **only the appended bytes** are read, so a growing file is not re-sent;
 * - decoding goes through `string_decoder`, so a multibyte character split
 *   across two reads is emitted once, whole, rather than as two U+FFFD;
 * - two caps — {@link TAIL_MAX_READ_BYTES} per read and
 *   {@link TAIL_MAX_TOTAL_BYTES} per shell — so a `yes > /dev/null`-shaped
 *   command cannot push an unbounded stream into the event log. At the cap the
 *   tail returns ONE notice naming the file (the user can still read it from a
 *   terminal tab) and then nothing;
 * - a read failure is terminal and is reported as text, never thrown: this
 *   runs from a timer inside the host, where an unhandled rejection would take
 *   down every other thread's session.
 */

import { promises as fs } from "node:fs";
import * as nodePath from "node:path";
import { StringDecoder } from "node:string_decoder";

/** At most this many bytes leave the file per read. */
export const TAIL_MAX_READ_BYTES = 64 * 1024;
/** At most this many bytes are tailed per shell, ever. */
export const TAIL_MAX_TOTAL_BYTES = 1024 * 1024;

export interface FileTailRead {
  /** The newly appended text, or a notice. Empty when nothing was appended. */
  text: string;
  /** True once the tail is finished — the cap was hit, or the file is unreadable. */
  done: boolean;
}

export interface FileTailOptions {
  path: string;
  maxReadBytes?: number;
  maxTotalBytes?: number;
}

export class FileTail {
  readonly path: string;

  private readonly maxReadBytes: number;
  private readonly maxTotalBytes: number;
  private decoder = new StringDecoder("utf8");
  private offset = 0;
  private consumed = 0;
  private done = false;

  constructor(options: FileTailOptions) {
    this.path = options.path;
    this.maxReadBytes = options.maxReadBytes ?? TAIL_MAX_READ_BYTES;
    this.maxTotalBytes = options.maxTotalBytes ?? TAIL_MAX_TOTAL_BYTES;
  }

  get finished(): boolean {
    return this.done;
  }

  /** Bytes taken out of the file so far — a drain loop's "did that do anything?". */
  get bytesRead(): number {
    return this.consumed;
  }

  /** One bounded read. Never throws; a failure comes back as `{done: true}`. */
  async read(): Promise<FileTailRead> {
    if (this.done) {
      return { text: "", done: true };
    }
    let handle: fs.FileHandle | undefined;
    try {
      handle = await fs.open(this.path, "r");
      const stat = await handle.stat();
      if (stat.size < this.offset) {
        // The file was truncated or replaced under us. Reading from the old
        // offset would return nothing forever, so start over.
        this.offset = 0;
        this.decoder = new StringDecoder("utf8");
      }
      const budget = this.maxTotalBytes - this.consumed;
      const available = stat.size - this.offset;
      if (available <= 0) {
        return { text: "", done: false };
      }
      const length = Math.min(available, this.maxReadBytes, budget);
      const buffer = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(buffer, 0, length, this.offset);
      this.offset += bytesRead;
      this.consumed += bytesRead;
      let text = this.decoder.write(buffer.subarray(0, bytesRead));
      if (this.consumed >= this.maxTotalBytes) {
        this.done = true;
        text += `${text.endsWith("\n") || text.length === 0 ? "" : "\n"}${this.capNotice()}`;
      }
      return { text, done: this.done };
    } catch (error) {
      this.done = true;
      return { text: this.errorNotice(error), done: true };
    } finally {
      await handle?.close().catch(() => {
        // The read already produced its answer; a failing close is noise.
      });
    }
  }

  private capNotice(): string {
    const mib = Math.round(this.maxTotalBytes / (1024 * 1024));
    return `[orquester] this shell has written more than ${mib} MiB; the live tail stops here — the full output is at ${this.path}`;
  }

  private errorNotice(error: unknown): string {
    const code =
      typeof error === "object" && error !== null && typeof (error as { code?: unknown }).code === "string"
        ? (error as { code: string }).code
        : "unknown";
    return `[orquester] cannot read the shell's output file (${code}): ${this.path}`;
  }
}

/**
 * Resolve a leading `~/` against the HOME the provider child was launched
 * with. The CLI abbreviates the path it reports whenever its TMPDIR sits under
 * its HOME (fixtures README observation 4), and that HOME is the managed
 * account home, not the daemon user's — so this is resolved against the
 * session's own env, never against `process.env.HOME` blindly.
 *
 * `~user` is another account's home and is NOT ours to guess; it is returned
 * unchanged, which makes the read fail honestly rather than read a wrong file.
 */
export function resolveTildePath(input: string, home: string): string {
  if (home.length === 0 || !input.startsWith("~")) {
    return input;
  }
  if (input === "~") {
    return home;
  }
  if (input.startsWith("~/")) {
    return nodePath.join(home, input.slice(2));
  }
  return input;
}
