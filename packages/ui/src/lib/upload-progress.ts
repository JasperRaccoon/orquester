/**
 * Byte-level progress for a batch of uploads, shared by every surface that
 * sends files (terminal drop/paste, the mobile attach button, the file browser,
 * the browser tab's design-pick sheet) so they all render the same bar.
 *
 * Progress comes from the transport: on the web the HTTP client uploads a
 * binary body through XMLHttpRequest — `fetch` has no upload progress — and
 * reports (sent, total) per request; the desktop bridge has no byte feedback,
 * so there the bar advances at file boundaries only. Both feed this tracker.
 */

export interface UploadProgress {
  /** Overall batch completion, 0..1 — the bar's width. */
  fraction: number;
  /** Bytes sent across the whole batch so far. */
  sent: number;
  /** Total bytes in the batch. */
  total: number;
  /** 1-based index of the file currently in flight. */
  fileIndex: number;
  fileCount: number;
  /** Basename of the file in flight, for the label. */
  fileName: string;
}

/**
 * Turns per-request (sent, total) callbacks into batch-level progress. Call
 * {@link begin} before each file's request, hand {@link onBytes} to the request,
 * and {@link finish} once it resolved (so a transport without byte feedback still
 * moves the bar per file).
 */
export class BatchProgress {
  private done = 0;
  private current = 0;
  private index = 0;
  private name = "";

  constructor(
    private readonly sizes: number[],
    private readonly emit: (progress: UploadProgress) => void
  ) {}

  get total(): number {
    return this.sizes.reduce((sum, size) => sum + size, 0);
  }

  begin(fileIndex: number, fileName: string): void {
    this.index = fileIndex;
    this.name = fileName;
    this.current = 0;
    this.publish();
  }

  /** Bound per file: a transport's `onUploadProgress` sink. */
  readonly onBytes = (sent: number): void => {
    this.current = Math.min(sent, this.sizes[this.index] ?? sent);
    this.publish();
  };

  finish(): void {
    this.done += this.sizes[this.index] ?? 0;
    this.current = 0;
  }

  private publish(): void {
    const total = this.total;
    const sent = Math.min(total, this.done + this.current);
    this.emit({
      fraction: total > 0 ? sent / total : 0,
      sent,
      total,
      fileIndex: this.index + 1,
      fileCount: this.sizes.length,
      fileName: this.name
    });
  }
}
