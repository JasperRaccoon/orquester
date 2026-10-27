/** Messages waiting for a renderer page, oldest first; retain the latest 20. */
export class RendererOutbox<T> {
  private readonly queue: T[] = [];

  push(message: T): void {
    this.queue.push(message);
    if (this.queue.length > 20) this.queue.splice(0, this.queue.length - 20);
  }

  /** Take every waiting message. */
  drain(): T[] {
    return this.queue.splice(0);
  }
}
