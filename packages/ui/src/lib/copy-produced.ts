/**
 * Copy text that may still be on its way, from inside the click that asked
 * for it.
 *
 * WebKit grants clipboard access only to a write that *starts* within the
 * user's gesture. A `writeText` made after an `await` is refused, so copying
 * text that has to be read first did nothing in Safari: a plan the wire cut
 * at 16 KiB (§5.6) is read back whole before it is copied. The fix is the
 * write the Async Clipboard API was built for. `write()` starts at once with
 * a `ClipboardItem` whose data is a promise, and the browser waits for that
 * promise inside the write it has already allowed.
 *
 * Pure, with everything injected (`CopyButton` passes `navigator.clipboard`
 * and the global `ClipboardItem`), so every branch is testable in Node.
 */

/** The part of `navigator.clipboard` a copy uses; `write` is not in every engine. */
export interface CopyClipboard<Item> {
  writeText(text: string): Promise<void>;
  write?(items: Item[]): Promise<void>;
}

/** `ClipboardItem`'s constructor, as far as a text copy needs it. */
export type CopyClipboardItemConstructor<Item> = new (items: Record<string, Promise<Blob>>) => Item;

/**
 * Write `produced` to the clipboard, starting within this call.
 *
 * - A string goes through `writeText` at once, as it always did.
 * - A promise goes through `write()` at once, when the engine has both
 *   `ClipboardItem` and `write()`. A read that rejects fails that `write()`,
 *   so nothing is copied, and never the cut text.
 * - Otherwise the promise is awaited and then written with `writeText`. That
 *   is the best an engine without `write()` offers; Chromium and Firefox
 *   accept it.
 *
 * Rejects when nothing was copied, which the caller treats as a denied
 * clipboard.
 */
export function copyProduced<Item>(
  produced: string | Promise<string>,
  clipboard: CopyClipboard<Item> | undefined,
  ClipboardItemCtor?: CopyClipboardItemConstructor<Item>
): Promise<void> {
  if (clipboard === undefined) {
    // An insecure origin (the daemon over plain http) has no async clipboard.
    // Nothing is copied. A pending read is still observed, so if it fails,
    // that failure is not left unhandled.
    return Promise.resolve(produced).then(() => {
      throw new Error("The clipboard is not available here.");
    });
  }
  if (typeof produced === "string") {
    return clipboard.writeText(produced);
  }
  if (ClipboardItemCtor !== undefined && typeof clipboard.write === "function") {
    const blob = produced.then((text) => new Blob([text], { type: "text/plain" }));
    // An engine can refuse the write without ever reading the item (Chromium
    // on an unfocused document). A read that then fails would reject `blob`
    // with nobody listening. Observed apart, so the promise the item carries
    // still rejects for an engine that does read it.
    void blob.catch(() => undefined);
    return clipboard.write([new ClipboardItemCtor({ "text/plain": blob })]);
  }
  return produced.then((text) => clipboard.writeText(text));
}
