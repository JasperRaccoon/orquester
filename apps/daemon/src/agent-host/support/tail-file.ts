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

import { constants as fsConstants, promises as fs } from "node:fs";
import * as nodePath from "node:path";
import { StringDecoder } from "node:string_decoder";

import { NdjsonLineReader } from "./ndjson.ts";

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
}

export class FileTail {
  readonly path: string;

  private decoder = new StringDecoder("utf8");
  private offset = 0;
  private consumed = 0;
  private done = false;

  constructor(options: FileTailOptions) {
    this.path = options.path;
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
      const budget = TAIL_MAX_TOTAL_BYTES - this.consumed;
      const available = stat.size - this.offset;
      if (available <= 0) {
        return { text: "", done: false };
      }
      const length = Math.min(available, TAIL_MAX_READ_BYTES, budget);
      const buffer = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(buffer, 0, length, this.offset);
      this.offset += bytesRead;
      this.consumed += bytesRead;
      let text = this.decoder.write(buffer.subarray(0, bytesRead));
      if (this.consumed >= TAIL_MAX_TOTAL_BYTES) {
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
    const mib = Math.round(TAIL_MAX_TOTAL_BYTES / (1024 * 1024));
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

/** At most this many bytes leave a JSONL transcript per read. */
export const JSONL_TAIL_MAX_READ_BYTES = 256 * 1024;

export interface JsonlFileTailRead {
  /** The complete lines appended since the last read, parsed; a malformed line is skipped. */
  records: unknown[];
  /** True once the file is unreadable for any reason but "not written yet". */
  done: boolean;
}

/**
 * An incremental tail of a JSONL file a provider appends to — a Claude
 * workflow agent's transcript (spec §4.5). Unlike {@link FileTail} it has no
 * total cap: the reader turns records into items, not text, so the log grows
 * by what the agent did, and a transcript's bulk (the CLI's own context
 * attachments) is parsed and dropped. A partial last line waits for its
 * newline; a single line past `NDJSON_MAX_LINE_BYTES` is abandoned.
 *
 * A missing file is not an error: the CLI creates it on the agent's first
 * write, which can come after the agent is named. Never throws.
 */
export class JsonlFileTail {
  readonly path: string;

  private offset = 0;
  private reader = new NdjsonLineReader();
  private done = false;
  /** The read under way: one at a time, so two can never share an offset. */
  private inFlight: Promise<JsonlFileTailRead> | undefined;

  constructor(options: FileTailOptions) {
    this.path = options.path;
  }

  get finished(): boolean {
    return this.done;
  }

  /** Bytes taken out of the file so far. */
  get bytesRead(): number {
    return this.offset;
  }

  /**
   * One bounded read. A caller that gave up on a slow read and asks again
   * gets THAT read's answer, so its records are never lost.
   */
  read(): Promise<JsonlFileTailRead> {
    this.inFlight ??= this.readOnce().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async readOnce(): Promise<JsonlFileTailRead> {
    if (this.done) {
      return { records: [], done: true };
    }
    let handle: fs.FileHandle | undefined;
    try {
      // Never through a link: the file is the CLI's own, in its own tree.
      handle = await fs.open(this.path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      const stat = await handle.stat();
      if (stat.size < this.offset) {
        // Replaced under us: the caller skips records it already has.
        this.offset = 0;
        this.reader = new NdjsonLineReader();
      }
      const available = stat.size - this.offset;
      if (available <= 0) {
        return { records: [], done: false };
      }
      const length = Math.min(available, JSONL_TAIL_MAX_READ_BYTES);
      const buffer = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(buffer, 0, length, this.offset);
      this.offset += bytesRead;
      const records: unknown[] = [];
      for (const line of this.reader.push(buffer.subarray(0, bytesRead))) {
        if (line.trim().length === 0) {
          continue;
        }
        try {
          records.push(JSON.parse(line));
        } catch {
          // A torn or foreign line: the rest of the file is still good.
        }
      }
      return { records, done: false };
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      if (code === "ENOENT") {
        return { records: [], done: false };
      }
      this.done = true;
      return { records: [], done: true };
    } finally {
      await handle?.close().catch(() => {
        // The read already produced its answer; a failing close is noise.
      });
    }
  }
}
