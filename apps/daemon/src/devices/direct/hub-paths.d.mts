/** Types of `hub-paths.mjs` (plain JavaScript: the stream gate uploads it to the owner's machines). */

export interface HubHttpRoute {
  readonly pattern: RegExp;
  readonly methods: readonly string[];
  /** Where the device is named: the `device` query parameter, the pattern's first group, or nowhere. */
  readonly device: "query" | "path" | "none";
  /** A long-lived video response (a viewer while open). */
  readonly stream?: boolean;
  /** A POST that changes the device (the user's input). */
  readonly input?: boolean;
}

export interface HubWsRoute {
  readonly pattern: RegExp;
  /** A client message that is not input: serve-emu's `reset-video`. */
  readonly control?: "reset-video";
}

export const HUB_HTTP_ROUTES: readonly HubHttpRoute[];
export const HUB_WS_ROUTES: readonly HubWsRoute[];
export const FORWARDED_REQUEST_HEADERS: readonly string[];
export const FORWARDED_RESPONSE_HEADERS: readonly string[];
export const TOKEN_SUBPROTOCOL: RegExp;

export function matchHubHttpRoute(path: string): { route: HubHttpRoute; match: RegExpExecArray } | null;
export function matchHubWsRoute(path: string): HubWsRoute | null;
export function hubDeviceOf(match: RegExpExecArray, where: HubHttpRoute["device"], search: string): string | null;
export function isResetVideoText(text: string): boolean;
