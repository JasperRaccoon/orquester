import { ApiError } from "./api-client";
import { useAppStore } from "../store/app";

/**
 * Run a fire-and-forget tab launch without swallowing its failure.
 *
 * `openTab` handles the one recoverable create failure itself (a refused
 * resume becomes the ResumeErrorToast) and rethrows everything else. Callers
 * are click handlers, so they can only `void` the promise — and a `void`ed
 * rejection is an unhandled rejection in the console and *nothing at all* on
 * screen: the tab simply never appears. Route those through here instead, so a
 * daemon that is down, out of PTYs or refusing the launch says so.
 */
export function launchWithNotice(promise: Promise<unknown>, what: string): void {
  void promise.catch((error: unknown) => {
    const detail =
      error instanceof ApiError
        ? (error.serverMessage ?? `The daemon answered ${error.status}.`)
        : error instanceof Error
          ? error.message
          : String(error);
    useAppStore.getState().setNotice({ title: `Could not start ${what}`, message: detail });
  });
}
