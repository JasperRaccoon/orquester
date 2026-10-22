/**
 * Settings → Server → Remote access → "Tailscale HTTPS": expose the daemon's
 * HTTP transport to the tailnet at `https://<machine>.<tailnet>.ts.net` with
 * `tailscale serve`. Both routes sit behind the remote transport's auth.
 */

export const tailscaleServeRoutes = {
  /** GET: {@link TailscaleServeStatus}. PUT {@link SetTailscaleServeRequest}: the new status, or a {@link TailscaleServeErrorBody}. */
  serve: "/api/remote-access/tailscale-serve"
} as const;

export type TailscaleServeProblemCode =
  /** No `tailscale` CLI on the daemon's PATH. */
  | "not-installed"
  /** The CLI runs, but `tailscaled` does not. */
  | "daemon-not-running"
  /** This machine is not signed in to a tailnet. */
  | "not-logged-in"
  /** Signed in, waiting for an admin to approve the machine. */
  | "needs-approval"
  /** Signed in, but Tailscale is turned off (`tailscale down`). */
  | "stopped"
  /** The tailnet gives this machine no MagicDNS name. */
  | "no-magicdns"
  /** HTTPS certificates are off in the tailnet's admin console. */
  | "https-disabled"
  /** The daemon's user may not change Tailscale's serve config. */
  | "permission-denied"
  /** External HTTP access is off, so there is nothing to serve. */
  | "http-disabled"
  /** Port 443 of this machine's Tailscale HTTPS already serves something else. */
  | "port-in-use"
  /** The CLI did not answer in time. */
  | "timeout"
  | "failed";

export interface TailscaleServeProblem {
  code: TailscaleServeProblemCode;
  /** What is wrong and how to fix it. Never CLI output. */
  message: string;
}

export interface TailscaleServeStatus {
  /** The CLI was found and `tailscaled` answered. */
  available: boolean;
  /** This machine's MagicDNS name (`machine.tailnet.ts.net`), when known. */
  dnsName: string | null;
  /** Whether the tailnet issues HTTPS certificates; null when the CLI does not say. */
  httpsEnabled: boolean | null;
  /** The saved choice (daemon.json). */
  enabled: boolean;
  /** Tailscale serves HTTPS on 443 to this daemon right now. */
  active: boolean;
  /** `https://<dnsName>/`, the address to open on tailnet devices; null without a name. */
  url: string | null;
  /** What 443 serves instead, when it serves something other than this daemon. */
  otherTarget: string | null;
  /** Why it is not (or cannot be) on; null when nothing is wrong. */
  problem: TailscaleServeProblem | null;
}

export interface SetTailscaleServeRequest {
  enabled: boolean;
}

/** A refused PUT: `code` names the problem, `message` how to fix it. */
export interface TailscaleServeErrorBody {
  code: TailscaleServeProblemCode | "INVALID_REQUEST";
  message: string;
}
