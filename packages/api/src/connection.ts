/**
 * What a client needs to tell "the daemon is unreachable" apart from "this is
 * not an Orquester daemon", "this app and the daemon speak different
 * protocols" and "the daemon is restarting" (the connection diagnosis).
 */

/** `HealthResponse.service`: marks an answer as an Orquester daemon's. */
export const ORQUESTER_SERVICE = "orquester";

/**
 * The client↔daemon wire generation. Bump it only for a change an older
 * client or daemon cannot work with; the UI then tells the user which side to
 * update. Absent on daemons that predate it, which count as compatible.
 */
export const ORQUESTER_PROTOCOL_VERSION = 1;

/** Event-bus channel and type the daemon publishes just before it stops serving. */
export const DAEMON_EVENTS_CHANNEL = "daemon";
export const DAEMON_STOPPING_EVENT = "daemon.stopping";

export interface DaemonStoppingPayload {
  /** `shutdown`: the whole daemon stops (restart, deploy). `http-restart`: only the remote HTTP listener restarts (Remote access settings changed). */
  reason: "shutdown" | "http-restart";
}
