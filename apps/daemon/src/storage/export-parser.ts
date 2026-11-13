import type { ScanNode } from "./tree.ts";

/**
 * Streaming reader for gdu's ncdu-format JSON export:
 *
 *   [1, 2, {"progname":"gdu","progver":"v5.39.0",…},
 *    [{"name":"<abs root>","asize":…,"dsize":…,"read_error":true?}, child, …]]
 *
 * where a file child is an object (`name`, `asize`, `dsize`, and `ino` +
 * `hlnkc` for a multiply-linked inode) and a subdirectory child is an array
 * `[{dirinfo}, child, …]`. The export of a large disk is well over V8's
 * maximum string length, so it is tokenized chunk by chunk and pruned as each
 * directory closes: memory stays bounded by the kept tree, the open path and
 * the hard-link inode set, never by the export.
 *
 * Sizes are recomputed from the children: disk usage from `dsize`, apparent
 * from `asize`, every multiply-linked inode counted once (the first link in
 * export order, as gdu does). A directory's own blocks are what gdu's total
 * for it exceeds the sum of its children by.
 */

export interface ParsedScan {
  root: ScanNode;
  /** gdu's `progver`, e.g. "v5.39.0"; null when the export carried none. */
  scannerVersion: string | null;
  /** Directories marked `read_error` (contents missing from the totals). */
  unreadableDirs: number;
}

export interface PruneOptions {
  /**
   * Entries (files, or directories in total) smaller than this are folded into
   * their directory's `smaller` aggregate instead of being kept.
   */
  minKeepBytes: number;
  /**
   * Small unreadable directories are kept anyway (so the map can flag them), up
   * to this many per scan. Default 2000.
   */
  maxUnreadableKept?: number;
  /** Stop with this signal's reason between chunks. */
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

interface JsonHandler {
  startArray(): void;
  endArray(): void;
  startObject(): void;
  endObject(): void;
  key(key: string): void;
  string(value: string): void;
  number(value: number): void;
  literal(value: boolean | null): void;
}

const enum State {
  Value,
  AfterValue,
  Key,
  Colon,
  String,
  Escape,
  Unicode,
  Number,
  Literal,
  Done
}

const LITERALS: Record<number, { text: string; value: boolean | null }> = {
  0x74: { text: "true", value: true },
  0x66: { text: "false", value: false },
  0x6e: { text: "null", value: null }
};

function isWhitespace(c: number): boolean {
  return c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09;
}

function hexValue(c: number): number {
  if (c >= 0x30 && c <= 0x39) return c - 0x30;
  if (c >= 0x61 && c <= 0x66) return c - 0x57;
  if (c >= 0x41 && c <= 0x46) return c - 0x37;
  return -1;
}

const SIMPLE_ESCAPES: Record<number, string> = {
  0x22: '"',
  0x5c: "\\",
  0x2f: "/",
  0x62: "\b",
  0x66: "\f",
  0x6e: "\n",
  0x72: "\r",
  0x74: "\t"
};

/** A push tokenizer for any RFC 8259 JSON text; containers are reported, never built. */
class JsonTokenizer {
  private state = State.Value;
  /** After `[` / `{`: the closer is allowed in place of a value / key. */
  private allowClose = false;
  /** Open containers, true = object. */
  private readonly containers: boolean[] = [];
  private stringIsKey = false;
  private readonly rawParts: Buffer[] = [];
  private decoded = "";
  private unicodeValue = 0;
  private unicodeDigits = 0;
  private numberText = "";
  private numberValue = 0;
  private numberNegative = false;
  private numberDigits = 0;
  private numberSimple = true;
  private literal: { text: string; value: boolean | null } | null = null;
  private literalIndex = 0;
  private offset = 0;

  constructor(private readonly handler: JsonHandler) {}

  private fail(what: string, at: number): never {
    throw new Error(`Malformed scan export at byte ${this.offset + at}: ${what}.`);
  }

  private valueDone(): void {
    this.state = this.containers.length === 0 ? State.Done : State.AfterValue;
  }

  private flushRaw(): void {
    if (this.rawParts.length === 0) return;
    this.decoded += (this.rawParts.length === 1 ? this.rawParts[0]! : Buffer.concat(this.rawParts)).toString("utf8");
    this.rawParts.length = 0;
  }

  private emitString(value: string): void {
    if (this.stringIsKey) {
      this.handler.key(value);
      this.state = State.Colon;
    } else {
      this.handler.string(value);
      this.valueDone();
    }
  }

  private finishNumber(at: number): void {
    let value: number;
    if (this.numberSimple) {
      if (this.numberDigits === 0) this.fail("a number without digits", at);
      value = this.numberNegative ? -this.numberValue : this.numberValue;
    } else {
      value = Number(this.numberText);
      if (!Number.isFinite(value)) this.fail(`bad number ${JSON.stringify(this.numberText.slice(0, 40))}`, at);
    }
    this.handler.number(value);
    this.valueDone();
  }

  write(buf: Buffer): void {
    const length = buf.length;
    let i = 0;
    while (i < length) {
      switch (this.state) {
        case State.String: {
          const start = i;
          let c = 0;
          while (i < length) {
            c = buf[i]!;
            if (c === 0x22 || c === 0x5c) break;
            i++;
          }
          if (i === length) {
            // The run continues in the next chunk; copy it (the stream may reuse its pool).
            if (i > start) this.rawParts.push(Buffer.from(buf.subarray(start, i)));
            break;
          }
          if (c === 0x22) {
            let value: string;
            if (this.rawParts.length === 0 && this.decoded === "") {
              value = buf.toString("utf8", start, i);
            } else {
              if (i > start) this.rawParts.push(buf.subarray(start, i));
              this.flushRaw();
              value = this.decoded;
              this.decoded = "";
            }
            i++;
            this.emitString(value);
          } else {
            if (i > start) this.rawParts.push(buf.subarray(start, i));
            this.flushRaw();
            i++;
            this.state = State.Escape;
          }
          break;
        }
        case State.Escape: {
          const c = buf[i]!;
          if (c === 0x75) {
            this.state = State.Unicode;
            this.unicodeValue = 0;
            this.unicodeDigits = 0;
          } else {
            const text = SIMPLE_ESCAPES[c];
            if (text === undefined) this.fail("an invalid string escape", i);
            this.decoded += text;
            this.state = State.String;
          }
          i++;
          break;
        }
        case State.Unicode: {
          const digit = hexValue(buf[i]!);
          if (digit < 0) this.fail("an invalid \\u escape", i);
          this.unicodeValue = this.unicodeValue * 16 + digit;
          i++;
          if (++this.unicodeDigits === 4) {
            // A surrogate pair arrives as two escapes; their UTF-16 halves join in the string.
            this.decoded += String.fromCharCode(this.unicodeValue);
            this.state = State.String;
          }
          break;
        }
        case State.Number: {
          const c = buf[i]!;
          if (c >= 0x30 && c <= 0x39) {
            if (this.numberSimple) {
              this.numberValue = this.numberValue * 10 + (c - 0x30);
              this.numberDigits++;
            } else {
              this.numberText += String.fromCharCode(c);
            }
            i++;
          } else if (c === 0x2e || c === 0x65 || c === 0x45 || c === 0x2b || c === 0x2d) {
            if (this.numberSimple) {
              // Integers are read digit by digit; a fraction or exponent is left to Number().
              this.numberSimple = false;
              this.numberText = `${this.numberNegative ? "-" : ""}${this.numberDigits > 0 ? this.numberValue : ""}`;
            }
            this.numberText += String.fromCharCode(c);
            i++;
          } else {
            this.finishNumber(i);
            // the delimiter is read again in the new state
          }
          break;
        }
        case State.Literal: {
          const literal = this.literal!;
          if (buf[i] !== literal.text.charCodeAt(this.literalIndex)) this.fail(`expected ${literal.text}`, i);
          i++;
          if (++this.literalIndex === literal.text.length) {
            this.handler.literal(literal.value);
            this.valueDone();
          }
          break;
        }
        default:
          i = this.structural(buf, i);
      }
    }
    this.offset += length;
  }

  /** Whitespace and structure between tokens; returns the next index. */
  private structural(buf: Buffer, i: number): number {
    const c = buf[i]!;
    if (isWhitespace(c)) return i + 1;
    if (this.state === State.Value) return this.valueStart(c, i);
    if (this.state === State.AfterValue) {
      const inObject = this.containers.at(-1)!;
      if (c === 0x2c) {
        this.state = inObject ? State.Key : State.Value;
        this.allowClose = false;
        return i + 1;
      }
      if (c === (inObject ? 0x7d : 0x5d)) return this.close(inObject, i);
      this.fail("expected , or a closing bracket", i);
    }
    if (this.state === State.Key) {
      if (c === 0x22) {
        this.stringIsKey = true;
        this.state = State.String;
        return i + 1;
      }
      if (c === 0x7d && this.allowClose) return this.close(true, i);
      this.fail("expected a key", i);
    }
    if (this.state === State.Colon) {
      if (c !== 0x3a) this.fail("expected :", i);
      this.state = State.Value;
      this.allowClose = false;
      return i + 1;
    }
    this.fail("data after the end", i);
  }

  private valueStart(c: number, i: number): number {
    if (c === 0x22) {
      this.stringIsKey = false;
      this.state = State.String;
      return i + 1;
    }
    if (c === 0x5b || c === 0x7b) {
      const object = c === 0x7b;
      this.containers.push(object);
      if (object) this.handler.startObject();
      else this.handler.startArray();
      this.state = object ? State.Key : State.Value;
      this.allowClose = true;
      return i + 1;
    }
    if (c === 0x5d && this.allowClose && this.containers.at(-1) === false) return this.close(false, i);
    if (c === 0x2d || (c >= 0x30 && c <= 0x39)) {
      this.state = State.Number;
      this.numberSimple = true;
      this.numberValue = 0;
      this.numberDigits = 0;
      this.numberNegative = c === 0x2d;
      return c === 0x2d ? i + 1 : i;
    }
    const literal = LITERALS[c];
    if (literal) {
      this.literal = literal;
      this.literalIndex = 0;
      this.state = State.Literal;
      return i;
    }
    this.fail("expected a value", i);
  }

  private close(object: boolean, i: number): number {
    this.containers.pop();
    if (object) this.handler.endObject();
    else this.handler.endArray();
    this.valueDone();
    return i + 1;
  }

  end(): void {
    if (this.state === State.Number) this.finishNumber(0);
    if (this.state !== State.Done) throw new Error("The scan export ended early (truncated).");
  }
}

// ---------------------------------------------------------------------------
// gdu export → pruned tree
// ---------------------------------------------------------------------------

interface DirFrame {
  name: string;
  /** gdu's own totals for the directory (used to recover the directory's own blocks). */
  gduUsage: number;
  gduApparent: number;
  unreadable: boolean;
  hasInfo: boolean;
  size: number;
  apparent: number;
  items: number;
  kept: ScanNode[];
  smallerSize: number;
  smallerApparent: number;
  smallerItems: number;
}

const enum Frame {
  Top,
  Meta,
  Dir,
  Entry
}

class GduExportBuilder implements JsonHandler {
  private readonly frames: Frame[] = [];
  private readonly dirs: DirFrame[] = [];
  /** Depth inside a value nobody needs (nested containers in an entry or the header). */
  private skipDepth = 0;
  private topIndex = 0;
  private currentKey = "";
  private entryIsInfo = false;
  private entryName: string | null = null;
  private entryAsize = 0;
  private entryDsize = 0;
  private entryIno = -1;
  private entryHardLinked = false;
  private entryReadError = false;
  private readonly linkedInodes = new Set<number>();
  private unreadableKept = 0;
  private readonly maxUnreadableKept: number;
  root: ScanNode | null = null;
  scannerVersion: string | null = null;
  unreadableDirs = 0;

  constructor(private readonly options: PruneOptions) {
    this.maxUnreadableKept = options.maxUnreadableKept ?? 2000;
  }

  private bad(what: string): never {
    throw new Error(`Unexpected scan export structure: ${what}.`);
  }

  startArray(): void {
    if (this.skipDepth > 0) {
      this.skipDepth++;
      return;
    }
    const parent = this.frames.at(-1);
    if (parent === undefined) {
      this.frames.push(Frame.Top);
    } else if (parent === Frame.Top) {
      if (this.topIndex++ === 3) this.pushDir();
      else this.skipDepth = 1;
    } else if (parent === Frame.Dir) {
      if (!this.dirs.at(-1)!.hasInfo) this.bad("a directory without its info object");
      this.pushDir();
    } else {
      this.skipDepth = 1;
    }
  }

  private pushDir(): void {
    if (this.root) this.bad("more than one root");
    this.frames.push(Frame.Dir);
    this.dirs.push({
      name: "",
      gduUsage: 0,
      gduApparent: 0,
      unreadable: false,
      hasInfo: false,
      size: 0,
      apparent: 0,
      items: 1,
      kept: [],
      smallerSize: 0,
      smallerApparent: 0,
      smallerItems: 0
    });
  }

  startObject(): void {
    if (this.skipDepth > 0) {
      this.skipDepth++;
      return;
    }
    const parent = this.frames.at(-1);
    if (parent === Frame.Top) {
      if (this.topIndex++ === 2) this.frames.push(Frame.Meta);
      else this.skipDepth = 1;
    } else if (parent === Frame.Dir) {
      this.frames.push(Frame.Entry);
      this.entryIsInfo = !this.dirs.at(-1)!.hasInfo;
      this.entryName = null;
      this.entryAsize = 0;
      this.entryDsize = 0;
      this.entryIno = -1;
      this.entryHardLinked = false;
      this.entryReadError = false;
    } else if (parent === undefined) {
      this.bad("the export is not an array");
    } else {
      this.skipDepth = 1;
    }
  }

  key(key: string): void {
    if (this.skipDepth === 0) this.currentKey = key;
  }

  private scalar(): Frame | null {
    if (this.skipDepth > 0) return null;
    const frame = this.frames.at(-1)!;
    if (frame === Frame.Top) this.topIndex++;
    return frame;
  }

  string(value: string): void {
    const frame = this.scalar();
    if (frame === Frame.Entry) {
      if (this.currentKey === "name") this.entryName = value;
    } else if (frame === Frame.Meta) {
      if (this.currentKey === "progver") this.scannerVersion = value;
    }
  }

  number(value: number): void {
    if (this.scalar() !== Frame.Entry) return;
    switch (this.currentKey) {
      case "asize":
        this.entryAsize = value > 0 ? value : 0;
        break;
      case "dsize":
        this.entryDsize = value > 0 ? value : 0;
        break;
      case "ino":
        this.entryIno = value;
        break;
    }
  }

  literal(value: boolean | null): void {
    if (this.scalar() !== Frame.Entry) return;
    if (this.currentKey === "hlnkc") this.entryHardLinked = value === true;
    else if (this.currentKey === "read_error") this.entryReadError = value === true;
  }

  endObject(): void {
    if (this.skipDepth > 0) {
      this.skipDepth--;
      return;
    }
    const frame = this.frames.pop();
    if (frame !== Frame.Entry) return;
    const dir = this.dirs.at(-1)!;
    if (this.entryName === null) this.bad("an entry without a name");
    if (this.entryIsInfo) {
      dir.name = this.entryName;
      dir.gduUsage = this.entryDsize;
      dir.gduApparent = this.entryAsize;
      dir.unreadable = this.entryReadError;
      dir.hasInfo = true;
      return;
    }
    let size = this.entryDsize;
    let apparent = this.entryAsize;
    if (this.entryHardLinked && this.entryIno >= 0) {
      if (this.linkedInodes.has(this.entryIno)) {
        size = 0;
        apparent = 0;
      } else {
        this.linkedInodes.add(this.entryIno);
      }
    }
    dir.size += size;
    dir.apparent += apparent;
    dir.items += 1;
    if (size >= this.options.minKeepBytes) {
      dir.kept.push({ name: this.entryName, size, apparent, items: 1, dir: false });
    } else {
      dir.smallerSize += size;
      dir.smallerApparent += apparent;
      dir.smallerItems += 1;
    }
  }

  endArray(): void {
    if (this.skipDepth > 0) {
      this.skipDepth--;
      return;
    }
    const frame = this.frames.pop();
    if (frame !== Frame.Dir) return;
    const dir = this.dirs.pop()!;
    if (!dir.hasInfo) this.bad("an empty directory array");
    // gdu's figure includes the directory's own blocks; ours is its children.
    const size = Math.max(dir.size, dir.gduUsage);
    const apparent = Math.max(dir.apparent, dir.gduApparent);
    if (dir.unreadable) this.unreadableDirs++;
    const parent = this.dirs.at(-1);
    const node = (): ScanNode => {
      dir.kept.sort((a, b) => b.size - a.size);
      const built: ScanNode = { name: dir.name, size, apparent, items: dir.items, dir: true, children: dir.kept };
      if (dir.unreadable) built.unreadable = true;
      if (dir.smallerItems > 0) {
        built.smaller = { size: dir.smallerSize, apparent: dir.smallerApparent, items: dir.smallerItems };
      }
      return built;
    };
    if (!parent) {
      this.root = node();
      return;
    }
    parent.size += size;
    parent.apparent += apparent;
    parent.items += dir.items;
    const keepUnreadable = dir.unreadable && this.unreadableKept < this.maxUnreadableKept;
    if (size >= this.options.minKeepBytes || keepUnreadable) {
      if (size < this.options.minKeepBytes) this.unreadableKept++;
      parent.kept.push(node());
    } else {
      parent.smallerSize += size;
      parent.smallerApparent += apparent;
      parent.smallerItems += dir.items;
    }
  }

  result(): ParsedScan {
    if (!this.root) this.bad("no root directory");
    return { root: this.root, scannerVersion: this.scannerVersion, unreadableDirs: this.unreadableDirs };
  }
}

/** Parse and prune a gdu export read from `source` (e.g. `createReadStream(file)`). */
export async function parseGduExport(source: AsyncIterable<Buffer | string>, options: PruneOptions): Promise<ParsedScan> {
  const builder = new GduExportBuilder(options);
  const tokenizer = new JsonTokenizer(builder);
  for await (const chunk of source) {
    options.signal?.throwIfAborted();
    tokenizer.write(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  options.signal?.throwIfAborted();
  tokenizer.end();
  return builder.result();
}
