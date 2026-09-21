/**
 * Claude adapter — flushing a child's stdout before it exits.
 *
 * Its own module, with no imports, so the history worker and its regression
 * test can both load it without pulling the Agent SDK in.
 *
 * stdout is a **pipe** for every child `spawnProviderChild` starts (it always
 * pipes all three stdio), and a pipe write is asynchronous on POSIX: anything
 * past the ~64 KiB pipe buffer is still queued when the process ends, and
 * `process.exit()` discards it outright. A `getSessionMessages` transcript is
 * far larger than that, so writing and exiting truncated the payload and the
 * parent's `JSON.parse` failed with "Unexpected end of JSON input".
 */

export function writeAllToStdout(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    process.stdout.write(text, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
