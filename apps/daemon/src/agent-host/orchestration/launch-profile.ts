/**
 * Agent host — the refresh of a profile thread's launch before every provider-session start
 * (spec 2026-10-18 §5.6, §6.5; `daemonRoutesForHost.threadLaunchProfile`).
 *
 * The daemon answers the profile's CURRENT prepared version and the launch fields its agent's
 * contribution derives from it, so an edited profile applies at the next start (resume, crash
 * restart, a host restart's rehydrate) and a version the daemon's GC removed never fails one. The
 * orchestrator rewrites `launch.json` from the answer before it starts the session.
 *
 * {@link createDaemonLaunchProfileClient} never throws and never hangs: an unreachable daemon, a
 * 5xx, a timeout, an unreadable answer or a daemon that predates the route (its generic 404) is
 * `unavailable`, and the orchestrator then launches from the persisted profile only if its
 * manifest still validates — and appends a `runtime.warning` row saying so (an edit made since that
 * version does not apply to this start) — never Global.
 */

import { request as httpRequest } from "node:http";

import {
  agentHostAuthValue,
  daemonRoutesForHost,
  type ThreadLaunchProfileRequest,
  type ThreadLaunchProfileResponse
} from "../host-protocol.ts";
import { launchConfigFromRequest, parseHostThreadProfile } from "./launch-config.ts";

export type LaunchProfileAnswer =
  /** The launch to start with (already validated field-wise). */
  | { kind: "launch"; launch: ThreadLaunchProfileResponse }
  /** The daemon refused: the start fails with `message` (never Global). */
  | { kind: "refused"; code: string; message: string }
  /** The daemon could not be asked; `reason` is for the log. */
  | { kind: "unavailable"; reason: string };

export type FetchLaunchProfile = (threadId: string, profileId: string) => Promise<LaunchProfileAnswer>;

/** The longest a session start waits for the daemon's answer (a preparation may run first). */
export const LAUNCH_PROFILE_TIMEOUT_MS = 120_000;

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The daemon's 200 answer, field-wise; null when it is not one. */
export function parseLaunchProfileResponse(value: unknown): ThreadLaunchProfileResponse | null {
  if (!isRecord(value)) return null;
  let profile: ThreadLaunchProfileResponse["profile"];
  if (value.profile === null) {
    profile = null;
  } else {
    const parsed = parseHostThreadProfile(value.profile);
    if (parsed === undefined) return null;
    profile = parsed;
  }
  const fields = launchConfigFromRequest({
    ...(isRecord(value.launchEnv) ? { launchEnv: value.launchEnv as Record<string, string> } : {}),
    ...(Array.isArray(value.unsetEnv) ? { unsetEnv: value.unsetEnv as string[] } : {}),
    ...(typeof value.homePath === "string" ? { homePath: value.homePath } : {}),
    ...(isRecord(value.serverPool) ? { serverPool: value.serverPool as never } : {})
  });
  const fallback = isRecord(value.fallback) &&
    typeof value.fallback.previousProfileId === "string" &&
    typeof value.fallback.notice === "string" &&
    value.fallback.notice.length > 0
    ? { previousProfileId: value.fallback.previousProfileId, notice: value.fallback.notice.slice(0, 500) }
    : undefined;
  return {
    profile,
    ...(fields.launchEnv ? { launchEnv: fields.launchEnv } : {}),
    ...(fields.unsetEnv ? { unsetEnv: fields.unsetEnv } : {}),
    ...(fields.homePath ? { homePath: fields.homePath } : {}),
    ...(fields.serverPool ? { serverPool: fields.serverPool } : {}),
    ...(fallback ? { fallback } : {})
  };
}

/** `POST daemonRoutesForHost.threadLaunchProfile` with the host's bearer. Never throws. */
export function createDaemonLaunchProfileClient(options: {
  socketPath: () => string;
  token: string;
  timeoutMs?: number;
}): FetchLaunchProfile {
  return (threadId, profileId) =>
    new Promise<LaunchProfileAnswer>((resolve) => {
      const payload = JSON.stringify({ threadId, profileId } satisfies ThreadLaunchProfileRequest);
      let settled = false;
      const settle = (answer: LaunchProfileAnswer): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(answer);
      };
      const req = httpRequest(
        {
          socketPath: options.socketPath(),
          agent: false,
          path: daemonRoutesForHost.threadLaunchProfile,
          method: "POST",
          headers: {
            host: "daemon.localhost",
            authorization: agentHostAuthValue(options.token),
            "content-type": "application/json",
            "content-length": String(Buffer.byteLength(payload))
          }
        },
        (res) => {
          const chunks: Buffer[] = [];
          let received = 0;
          res.on("data", (chunk: Buffer) => {
            received += chunk.length;
            if (received > MAX_RESPONSE_BYTES) {
              res.destroy();
              settle({ kind: "unavailable", reason: "the daemon's answer was too large" });
              return;
            }
            chunks.push(chunk);
          });
          res.on("error", () => settle({ kind: "unavailable", reason: "the daemon's answer was cut off" }));
          res.on("end", () => {
            let body: unknown = null;
            try {
              body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            } catch {
              body = null;
            }
            const status = res.statusCode ?? 502;
            const code = isRecord(body) && typeof body.code === "string" ? body.code : undefined;
            const message = isRecord(body) && typeof body.message === "string" ? body.message : undefined;
            if (status === 200) {
              const launch = parseLaunchProfileResponse(body);
              settle(launch ? { kind: "launch", launch } : { kind: "unavailable", reason: "the daemon's answer did not read" });
              return;
            }
            // A refusal names its code; a 404 without one is a daemon that predates the route.
            if (status >= 400 && status < 500 && code !== undefined && message !== undefined && status !== 401) {
              settle({ kind: "refused", code, message });
              return;
            }
            settle({ kind: "unavailable", reason: `the daemon answered ${status}` });
          });
        }
      );
      const timer = setTimeout(() => {
        req.destroy();
        settle({ kind: "unavailable", reason: "the daemon did not answer in time" });
      }, options.timeoutMs ?? LAUNCH_PROFILE_TIMEOUT_MS);
      timer.unref();
      req.on("error", (error) => settle({ kind: "unavailable", reason: error.message }));
      req.end(payload);
    });
}
