/**
 * Box bootstraps (spec §5, §6, §8.2): the first thing a new box runs. Every
 * variant does the same four things:
 *
 * 1. Puts the single-use bootstrap token (and the Tailscale auth key, if any) in
 *    mode-0600 files in `orq-agent`'s data dir — never in argv, never in a log.
 * 2. Optionally joins the tailnet (`tailscale up --auth-key file:…`; containers run
 *    `tailscaled` in userspace-networking mode and point `orq-agent` at its proxy).
 * 3. Downloads `orq-agent` from `<daemonUrl>/api/boxes/agent/<platform>` with
 *    `Authorization: Bearer <bootstrap token>` and checks that it runs.
 * 4. Starts it: `orq-agent install-service` where a service manager can own it
 *    (systemd as root; Windows), otherwise `exec orq-agent run` in the foreground.
 *
 * The staged POSIX variant (`stagedPosixScript`, for size-capped startup scripts) splits
 * this after step 2: the per-box first stage then downloads the generic second stage
 * (steps 3–4, {@link bootstrapSecondStage}) from `<daemonUrl>/api/boxes/bootstrap/<variant>`
 * with the same bearer token and runs it, handing it the URL, box id, token file path
 * and proxy in its environment.
 *
 * What `orq-agent` receives ({@link ORQ_AGENT_ENV}): the daemon URL, the box id,
 * the PATH of the token file (it deletes the file after its first connect and
 * prefers its stored box credential from then on), and `ORQ_PROXY` when it must
 * dial through tailscaled's userspace proxy. It never gets the token itself in
 * its environment.
 *
 * Data dir (shared with `orq-agent`): `/var/lib/orq-agent` as root, else
 * `~/.orq-agent`; Windows `C:\orq\agent`. The executable lands in `<dir>/bin/`.
 */

import type { BootstrapInput, BoxBootstrap, BuildBootstrap } from "../contracts.ts";

/** Environment variables of the bootstrap ↔ `orq-agent` contract. */
export const ORQ_AGENT_ENV = {
  /** Origin (optionally with a base path) `orq-agent` downloads itself from and dials. */
  daemonUrl: "ORQ_DAEMON_URL",
  boxId: "ORQ_BOX_ID",
  /** Path of the mode-0600 file holding the bootstrap token; `orq-agent` deletes it after its first connect. */
  bootstrapTokenFile: "ORQ_BOOTSTRAP_TOKEN_FILE",
  /**
   * `http://127.0.0.1:1055` when the box reaches the daemon through tailscaled's userspace
   * networking (containers): `orq-agent` must open its daemon connections (binary download and
   * the connect WebSocket) through this HTTP CONNECT proxy. Nothing else in the box uses it.
   */
  proxy: "ORQ_PROXY",
  /** `1` on GitHub Actions macOS runners: authenticate with an Actions OIDC token (see `github/oidc.ts`). */
  githubOidc: "ORQ_GITHUB_OIDC",
  /** Container env only: read by the start command, written to the token file, then unset. */
  bootstrapToken: "ORQ_BOOTSTRAP_TOKEN",
  /** Container env only: read by the start command, written to a 0600 file for `tailscale up`, then unset. */
  tailscaleAuthKey: "ORQ_TAILSCALE_AUTHKEY"
} as const;

/** Where tailscaled's userspace SOCKS5 and HTTP proxies listen inside containers. */
export const TAILSCALE_USERSPACE_PROXY = "http://127.0.0.1:1055";

/** POSIX data dir when the bootstrap runs as root (cloud-init always does). */
export const POSIX_ROOT_DATA_DIR = "/var/lib/orq-agent";
export const WINDOWS_DATA_DIR = "C:\\orq\\agent";

/** How long the bootstrap keeps retrying the `orq-agent` download (daemon briefly down, DNS not up yet). */
const DOWNLOAD_DEADLINE_SECONDS = 15 * 60;
/** Pairing over SSH: the owner is waiting on the result, so a daemon the machine can't reach fails sooner. */
const UNATTENDED_DOWNLOAD_DEADLINE_SECONDS = 3 * 60;

/**
 * OOM protection (tailnet machines spec §4.9): the file name of every systemd drop-in Orquester
 * writes for it, so removal finds exactly its own ({@link byoUnpairCleanupScript}).
 */
export const OOM_DROPIN_NAME = "orquester-oom.conf";
/**
 * Strongly negative, not -1000: -1000 makes a process unkillable, so a runaway leak in one of these
 * services would leave the kernel nothing to free; at -900 it is still the last resort.
 */
export const OOM_SCORE_ADJUST = -900;
/** The drop-in itself (a `[Service]` section, valid for system and user units). */
export const OOM_DROPIN_LINES: readonly string[] = [
  "# Written by Orquester: the kernel's OOM killer must not pick this service, or the machine",
  "# drops off the network. Removed when the machine is removed from Orquester.",
  "[Service]",
  `OOMScoreAdjust=${OOM_SCORE_ADJUST}`
];
const SYSTEMD_SYSTEM_DIR = "/etc/systemd/system";
const SYSTEMD_USER_CONF_DIR = "/etc/systemd/user.conf.d";
/** `systemd-user.conf` `DefaultOOMScoreAdjust=` exists from systemd 250 on. */
const MIN_SYSTEMD_FOR_USER_OOM = 250;

/**
 * Lines the pairing script prints in unattended mode (pairing over SSH), one fact each:
 * `orq-probe: <key>=<value>`. Parsed by `machines/pairing/probe.ts`; never carries a secret.
 */
export const PAIRING_PROBE_PREFIX = "orq-probe:";

const BOX_ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;
/** Bootstrap tokens and Tailscale keys are URL-safe; anything else is refused before it reaches a script. */
const SECRET_PATTERN = /^[A-Za-z0-9._~+/=-]{16,512}$/;

/** Validate and normalise the daemon URL: https (http only for loopback), no credentials, query or fragment, no trailing slash. */
export function normalizeDaemonUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("The daemon URL is not a valid URL");
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("The daemon URL must use https");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("The daemon URL must not carry credentials, a query or a fragment");
  }
  const href = url.href.replace(/\/+$/, "");
  if (/[\s'"`\\$;&|<>()]/.test(href)) throw new Error("The daemon URL contains characters a bootstrap cannot carry");
  return href;
}

function validateInput(input: BootstrapInput): { daemonUrl: string } {
  if (!BOX_ID_PATTERN.test(input.boxId)) throw new Error("Invalid box id for a bootstrap");
  if (!SECRET_PATTERN.test(input.bootstrapToken)) throw new Error("Invalid bootstrap token format");
  if (input.tailscaleAuthKey !== null && !SECRET_PATTERN.test(input.tailscaleAuthKey)) {
    throw new Error("Invalid Tailscale auth key format");
  }
  return { daemonUrl: normalizeDaemonUrl(input.daemonUrl) };
}

/** Single-quote a value for POSIX sh. */
function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Single-quote a value for PowerShell. */
function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Where the POSIX script gets its secrets from:
 * - `literal` — embedded in the script (user data / startup scripts, readable only by root);
 * - `env` — the container's environment ({@link ORQ_AGENT_ENV.bootstrapToken}), unset before exec;
 * - `files` — already written by cloud-init `write_files` at the data dir paths.
 */
type SecretSource = { kind: "literal"; token: string; tailscaleAuthKey: string | null } | { kind: "env" } | { kind: "files" };

interface PosixOptions {
  daemonUrl: string;
  boxId: string;
  container: boolean;
  /** Whether the box joins the tailnet (the key itself comes from `secrets`). */
  tailscale: boolean;
  secrets: SecretSource;
}

function posixSecretsPrologue(secrets: SecretSource, tailscale: boolean): string {
  const lines: string[] = [];
  switch (secrets.kind) {
    case "literal":
      lines.push(`T=${shQuote(secrets.token)}`, `printf '%s' "$T" >"$TF"`, "T=");
      if (tailscale && secrets.tailscaleAuthKey !== null) {
        lines.push(`K=${shQuote(secrets.tailscaleAuthKey)}`, `printf '%s' "$K" >"$KF"`, "K=");
      }
      break;
    case "env":
      lines.push(
        `T=\${${ORQ_AGENT_ENV.bootstrapToken}:-}`,
        tailscale ? `K=\${${ORQ_AGENT_ENV.tailscaleAuthKey}:-}` : "",
        `unset ${ORQ_AGENT_ENV.bootstrapToken} ${ORQ_AGENT_ENV.tailscaleAuthKey}`,
        `[ -n "$T" ] || die "${ORQ_AGENT_ENV.bootstrapToken} is not set"`,
        `printf '%s' "$T" >"$TF"`,
        "T="
      );
      if (tailscale) {
        lines.push(`[ -n "$K" ] || die "${ORQ_AGENT_ENV.tailscaleAuthKey} is not set"`, `printf '%s' "$K" >"$KF"`, "K=");
      }
      break;
    case "files":
      lines.push(`[ -s "$TF" ] || die "missing bootstrap token file $TF"`);
      break;
  }
  return lines.join("\n");
}

/** Joins the tailnet when a key file exists. Containers: userspace tailscaled + proxy for orq-agent. */
function posixTailscale(container: boolean): string {
  if (container) {
    return `if [ -s "$KF" ]; then
  say "joining the tailnet (userspace networking)"
  TD="$D/tailscale"
  mkdir -p "$TD"
  case "$A" in x64) TA=amd64 ;; *) TA=arm64 ;; esac
  code=$(fetch "https://pkgs.tailscale.com/stable/tailscale_latest_$TA.tgz" "$TD/ts.tgz" 0) || code=000
  [ "$code" = 200 ] || die "could not download Tailscale (HTTP $code)"
  tar -xzf "$TD/ts.tgz" -C "$TD"
  mv -f "$TD"/tailscale_*/tailscale "$TD"/tailscale_*/tailscaled "$TD"/
  rm -rf "$TD"/tailscale_* "$TD/ts.tgz"
  nohup "$TD/tailscaled" --tun=userspace-networking --socks5-server=127.0.0.1:1055 \\
    --outbound-http-proxy-listen=127.0.0.1:1055 --statedir="$TD/state" \\
    --socket="$TD/tailscaled.sock" >"$TD/tailscaled.log" 2>&1 &
  n=0
  until [ -S "$TD/tailscaled.sock" ]; do
    n=$((n + 1)); [ "$n" -le 60 ] || die "tailscaled did not start (see $TD/tailscaled.log)"
    sleep 1
  done
  "$TD/tailscale" --socket="$TD/tailscaled.sock" up --auth-key="file:$KF" --hostname="orq-$ORQ_BOX_ID" --timeout=180s >&2 \\
    || { rm -f "$KF"; die "tailscale up failed"; }
  rm -f "$KF"
  PX=${shQuote(TAILSCALE_USERSPACE_PROXY)}
  ${ORQ_AGENT_ENV.proxy}=$PX
  export ${ORQ_AGENT_ENV.proxy}
fi`;
  }
  return `if [ -s "$KF" ]; then
  say "joining the tailnet"
  if ! command -v tailscale >/dev/null 2>&1; then
    [ "$OS" = linux ] || die "Tailscale is not installed on this machine"
    [ "$ROOT" = 1 ] || die "installing Tailscale needs root"
    code=$(fetch https://tailscale.com/install.sh "$D/ts-install.sh" 0) || code=000
    [ "$code" = 200 ] || die "could not download the Tailscale installer (HTTP $code)"
    sh "$D/ts-install.sh" >&2 || die "the Tailscale installer failed"
    rm -f "$D/ts-install.sh"
  fi
  if [ "$OS" = linux ] && [ "$ROOT" = 1 ]; then
    if [ "$SYSTEMD" = 1 ]; then
      systemctl enable --now tailscaled >&2 || die "could not start tailscaled"
    elif ! tailscale status >/dev/null 2>&1 && [ ! -S /var/run/tailscale/tailscaled.sock ]; then
      mkdir -p /var/lib/tailscale
      nohup tailscaled --state=/var/lib/tailscale/tailscaled.state >/var/log/tailscaled.log 2>&1 &
      n=0
      until [ -S /var/run/tailscale/tailscaled.sock ]; do
        n=$((n + 1)); [ "$n" -le 60 ] || die "tailscaled did not start"
        sleep 1
      done
    fi
  fi
  tailscale up --auth-key="file:$KF" --hostname="orq-$ORQ_BOX_ID" --timeout=180s >&2 \\
    || { rm -f "$KF"; die "tailscale up failed"; }
  rm -f "$KF"
fi`;
}

/**
 * The POSIX pieces every script below is assembled from. Order matters: each piece uses the
 * shell variables the ones before it set (`D`, `TF`, `KF`, `PX`, `ROOT`, `OS`, `A`, `P`, `SYSTEMD`).
 */
const posix = {
  /** Shebang, strict mode, `say`/`die`. With `vars`, assigns and exports the daemon URL and box id. */
  header(comment: string, vars: { daemonUrl: string; boxId: string } | null): string {
    const assign = vars
      ? `${ORQ_AGENT_ENV.daemonUrl}=${shQuote(vars.daemonUrl)}
${ORQ_AGENT_ENV.boxId}=${shQuote(vars.boxId)}
export ${ORQ_AGENT_ENV.daemonUrl} ${ORQ_AGENT_ENV.boxId}
`
      : "";
    return `#!/bin/sh
${comment}
set +x
set -eu
umask 077
${assign}say() { printf 'orq-bootstrap: %s\\n' "$*" >&2; }
die() { say "error: $*"; exit 1; }
`;
  },

  /**
   * The data dir `D`, the token file `TF`, the key file `KF` and the proxy `PX`. `fromEnv`: the
   * second stage, which takes the token file, URL, box id and proxy from the first stage's env.
   */
  dataDir(options: { tailscale: boolean; fromEnv: boolean }): string {
    const paths = options.fromEnv
      ? `TF=\${${ORQ_AGENT_ENV.bootstrapTokenFile}:-}
[ -n "\${${ORQ_AGENT_ENV.daemonUrl}:-}" ] && [ -n "\${${ORQ_AGENT_ENV.boxId}:-}" ] && [ -s "$TF" ] \\
  || die "${ORQ_AGENT_ENV.daemonUrl}, ${ORQ_AGENT_ENV.boxId} and ${ORQ_AGENT_ENV.bootstrapTokenFile} must be set (by the first stage)"
PX=\${${ORQ_AGENT_ENV.proxy}:-}`
      : `TF="$D/bootstrap-token"
${options.tailscale ? `KF="$D/ts-authkey"\n` : ""}PX=`;
    return `if [ "$(id -u)" = 0 ]; then ROOT=1; D=${POSIX_ROOT_DATA_DIR}; else ROOT=0; D="$HOME/.orq-agent"; fi
mkdir -p "$D/bin"
chmod 700 "$D"
${paths}
`;
  },

  /** VMs: `SYSTEMD`. */
  systemd(container: boolean): string {
    return container
      ? ""
      : `SYSTEMD=0
if [ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1; then SYSTEMD=1; fi
`;
  },

  /** `OS`, `A` and `orq-agent`'s platform `P` (musl detection); VMs: `SYSTEMD`. */
  platform(container: boolean): string {
    return `OS=$(uname -s)
M=$(uname -m)
case "$OS" in Linux) OS=linux ;; Darwin) OS=darwin ;; *) die "unsupported OS: $OS" ;; esac
case "$M" in x86_64 | amd64) A=x64 ;; aarch64 | arm64) A=arm64 ;; *) die "unsupported CPU: $M" ;; esac
if [ "$OS" = darwin ] && [ "$A" = x64 ] && [ "$(sysctl -n hw.optional.arm64 2>/dev/null || true)" = 1 ]; then A=arm64; fi
P="$OS-$A"
if [ "$OS" = linux ]; then
  if ls /lib/ld-musl-* >/dev/null 2>&1 || ldd --version 2>&1 | grep -qi musl; then P="$P-musl"; fi
fi
${posix.systemd(container)}`;
  },

  /**
   * Only what the tailnet join reads, for the first stage: containers (always Linux) need the CPU
   * for the Tailscale download (`A`); VMs need `OS` and `SYSTEMD`.
   */
  tailnetPlatform(container: boolean): string {
    return container
      ? `case "$(uname -m)" in x86_64 | amd64) A=x64 ;; aarch64 | arm64) A=arm64 ;; *) die "unsupported CPU: $(uname -m)" ;; esac\n`
      : `case "$(uname -s)" in Linux) OS=linux ;; Darwin) OS=darwin ;; *) die "unsupported OS: $(uname -s)" ;; esac\n${posix.systemd(false)}`;
  },

  /** curl, else GNU wget, else curl from apk (Alpine as root); `fetch URL OUT AUTH`. */
  fetch(): string {
    return `# fetch URL OUT AUTH -> prints the HTTP status. AUTH=1: the daemon (bearer token, ORQ proxy, no redirects).
if command -v curl >/dev/null 2>&1; then
  FETCH=curl
elif wget --help 2>&1 | grep -q -- '--config'; then
  FETCH=wget
elif [ "$ROOT" = 1 ] && command -v apk >/dev/null 2>&1 && apk add --no-cache curl >/dev/null 2>&1; then
  FETCH=curl
else
  die "curl or GNU wget is required"
fi
fetch() {
  if [ "$FETCH" = curl ]; then
    if [ "$3" = 1 ]; then
      {
        printf 'header = "Authorization: Bearer %s"\\n' "$(cat "$TF")"
        if [ -n "$PX" ]; then printf 'proxy = "%s"\\n' "$PX"; fi
      } | curl -K - -sS -o "$2" -w '%{http_code}' --connect-timeout 20 --max-time 900 "$1"
    else
      curl -sS -L -o "$2" -w '%{http_code}' --connect-timeout 20 --max-time 900 "$1"
    fi
  else
    rc="$D/wgetrc.$$"
    : >"$rc"
    if [ "$3" = 1 ]; then
      # Never follow a redirect with the bearer token (curl above does not either).
      printf 'header = Authorization: Bearer %s\\nmax_redirect = 0\\n' "$(cat "$TF")" >>"$rc"
      if [ -n "$PX" ]; then printf 'use_proxy = on\\nhttps_proxy = %s\\nhttp_proxy = %s\\n' "$PX" "$PX" >>"$rc"; fi
    fi
    wget --config="$rc" -q -S -T 20 -O "$2" "$1" 2>&1 | awk '/^  HTTP\\//{c=$2} END{if (c == "") c = "000"; print c}'
    rm -f "$rc"
  fi
}
`;
  },

  /**
   * Downloads `$ORQ_DAEMON_URL<path>` to `<out>.download` with the bearer token, retrying with a
   * backoff until {@link DOWNLOAD_DEADLINE_SECONDS}. `spent` runs on 401/403 before giving up: it
   * may `break` to keep what a restarted box already has (its token was spent on first connect).
   */
  download(options: { what: string; path: string; out: string; spent: string; missing: string; deadlineSeconds?: number }): string {
    return `say "downloading ${options.what}"
end=$(($(date +%s) + ${options.deadlineSeconds ?? DOWNLOAD_DEADLINE_SECONDS}))
n=0
while :; do
  code=$(fetch "$${ORQ_AGENT_ENV.daemonUrl}${options.path}" "${options.out}.download" 1) || code=000
  case "$code" in
    200) break ;;
    401 | 403)
      # A restarted box whose token was already spent keeps what it has.
      ${options.spent}
      die "the daemon refused the bootstrap token (HTTP $code)" ;;
    404) die "${options.missing}" ;;
  esac
  [ "$(date +%s)" -lt "$end" ] || die "could not download ${options.what} (last HTTP status $code)"
  n=$((n + 1)); w=$((n * 2)); [ "$w" -le 30 ] || w=30
  say "download failed (HTTP $code); retrying in $w s"
  sleep "$w"
done
`;
  },

  /** Downloads `orq-agent` for `P` to `B` and checks that it runs. */
  agent(deadlineSeconds?: number): string {
    const download = posix.download({
      ...(deadlineSeconds === undefined ? {} : { deadlineSeconds }),
      what: "orq-agent ($P)",
      path: "/api/boxes/agent/$P",
      out: "$B",
      spent: `if [ -x "$B" ] && "$B" --version >/dev/null 2>&1; then say "token already used; keeping the installed orq-agent"; rm -f "$B.download"; break; fi`,
      missing: "the daemon has no orq-agent build for $P"
    });
    return `B="$D/bin/orq-agent"
${download}if [ -f "$B.download" ]; then
  chmod 755 "$B.download"
  "$B.download" --version >/dev/null 2>&1 || die "the downloaded orq-agent does not run here ($P)"
  mv -f "$B.download" "$B"
fi
`;
  },

  /** Hands `orq-agent` the token file and starts it (as a systemd service on VMs where it can). */
  start(container: boolean): string {
    const service = container
      ? ""
      : `if [ "$OS" = linux ] && [ "$ROOT" = 1 ] && [ "$SYSTEMD" = 1 ]; then
  say "installing the orq-agent service"
  exec "$B" install-service
fi
`;
    return `${ORQ_AGENT_ENV.bootstrapTokenFile}=$TF
export ${ORQ_AGENT_ENV.bootstrapTokenFile}
${service}say "starting orq-agent"
exec "$B" run
`;
  }
};

/**
 * OOM protection (tailnet machines spec §4.9) for a Linux VM bootstrapped as root under systemd:
 * `tailscaled` and `orq-agent` get {@link OOM_DROPIN_NAME} drop-ins, so the kernel's OOM killer
 * never picks them and the box stays reachable. `orq-agent`'s is written before `install-service`,
 * whose restart applies it; the running `tailscaled` gets the value at once (never restarted: the
 * box may be reached through it). `sshd` needs nothing: see {@link posixMachineFixes}.
 */
function posixBoxOomProtection(): string {
  return `if [ "$OS" = linux ] && [ "$ROOT" = 1 ] && [ "$SYSTEMD" = 1 ]; then
  R=
${posixOomHelpers()}
  if [ "$(systemctl show -p LoadState --value tailscaled.service 2>/dev/null)" = loaded ]; then
    oom_service tailscaled.service || say "could not protect tailscaled from the OOM killer"
  fi
  oom_dropin ${SYSTEMD_SYSTEM_DIR}/orq-agent.service.d || say "could not protect orq-agent from the OOM killer"
fi
`;
}

/**
 * Shell functions writing OOM drop-ins as root: `$R` is empty when the script runs as root, else
 * `sudo -n` (never a prompt). `oom_dropin DIR` writes {@link OOM_DROPIN_NAME} into a unit's drop-in
 * dir, `oom_pid PID` applies {@link OOM_SCORE_ADJUST} to a running process, and `oom_service UNIT`
 * does both for a system unit's main process (no restart).
 */
function posixOomHelpers(): string {
  return `oom_lines() { printf '%s\\n' ${OOM_DROPIN_LINES.map(shQuote).join(" ")}; }
oom_dropin() { $R mkdir -p "$1" && oom_lines | $R tee "$1/${OOM_DROPIN_NAME}" >/dev/null; }
oom_pid() { [ -n "$1" ] && [ "$1" != 0 ] && printf '%s\\n' ${OOM_SCORE_ADJUST} | $R tee "/proc/$1/oom_score_adj" >/dev/null; }
oom_service() {
  oom_dropin "${SYSTEMD_SYSTEM_DIR}/$1.d" && $R systemctl daemon-reload || return 1
  p=$(systemctl show -p MainPID --value "$1" 2>/dev/null) || p=0
  [ -z "$p" ] || [ "$p" = 0 ] || oom_pid "$p"
}`;
}

/**
 * The pairing run's probes and fixes on the owner's machine (tailnet machines spec §4.2.5, §4.9),
 * after `orq-agent` is downloaded and before `install-service`. Fixes use root or `sudo -n` only
 * (never a prompt); what can't be fixed is said in the output, and in unattended mode each fact is
 * also a {@link PAIRING_PROBE_PREFIX} line for the daemon. Sets `R` and `ELEVATE` for later steps.
 *
 * Linux:
 * - **linger** (`loginctl enable-linger`), so the user service survives logout and starts at boot;
 * - **`/dev/kvm`**: the user joins the device's group (often access comes only from the desktop
 *   login's ACL); it applies to orq-agent after the machine restarts (the user manager keeps the
 *   groups it started with);
 * - **OOM protection**:
 *   - `tailscaled`: a system drop-in, applied at once to the running daemon (never restarted:
 *     this SSH session may run through it). Its Tailscale SSH sessions inherit the value.
 *   - `sshd`: OpenSSH protects its listener itself (-1000) and gives each login session the value
 *     it started with, so a unit-level `OOMScoreAdjust` would leak into every session: we only
 *     check the listener (or the systemd socket that re-spawns it) and report it otherwise.
 *   - `orq-agent` as root: a drop-in beside `install-service`'s own system unit (its uninstall
 *     removes the whole drop-in dir).
 *   - `orq-agent` as the user (a systemd user unit): the user manager is unprivileged and can't
 *     lower a unit's score below its own. So, as root, the manager itself (`user@<uid>.service`)
 *     gets the drop-in (and its running process the value), which makes the unit's own drop-in
 *     take effect. Every user unit would then inherit the manager's score plus 100, so
 *     `DefaultOOMScoreAdjust=` (systemd 250+, in `user.conf.d`) puts them back where they were:
 *     the manager's stock score plus 100 (an unprivileged manager's default). The alternatives
 *     were worse: a system unit with `User=` is not what `orq-agent install-service` installs or
 *     uninstalls, and the user manager can't be restarted under a live desktop session.
 *
 * macOS: developer mode (`DevToolsSecurity`), and `xcode-select` pointing at Xcode.
 */
function posixMachineFixes(unattended: boolean): string {
  const probe = unattended ? `printf '${PAIRING_PROBE_PREFIX} %s\\n' "$*" >&2` : ":";
  const managerConf = [
    "# Written by Orquester: user services keep their usual OOM score while the user manager",
    "# (and orq-agent) are protected from the OOM killer. Removed with the machine."
  ];
  return `probe() { ${probe}; }
U=$(id -un)
if [ "$ROOT" = 1 ]; then R=; ELEVATE=1
elif command -v sudo >/dev/null 2>&1 && sudo -n true </dev/null >/dev/null 2>&1; then R="sudo -n"; ELEVATE=1
else R=; ELEVATE=0
fi
if [ "$ELEVATE" = 1 ]; then probe sudo=yes; else probe sudo=no; fi
${posixOomHelpers()}
if [ "$OS" = linux ]; then
  if [ "$ROOT" = 0 ] && [ "$SYSTEMD" = 1 ] && command -v loginctl >/dev/null 2>&1; then
    if [ -e "/var/lib/systemd/linger/$U" ] || [ "$(loginctl show-user "$U" -p Linger --value 2>/dev/null)" = yes ]; then
      probe linger=on
    elif [ "$ELEVATE" = 1 ] && $R loginctl enable-linger "$U" </dev/null >/dev/null 2>&1; then
      say "turned on linger for $U: orq-agent keeps running after logout and starts at boot"
      probe linger=enabled
    else
      say "linger is off for $U: run 'sudo loginctl enable-linger $U' so orq-agent keeps running after logout"
      probe linger=off
    fi
  fi
  if [ "$ROOT" = 0 ] && [ -c /dev/kvm ]; then
    KG=$(stat -c %G /dev/kvm 2>/dev/null) || KG=kvm
    case "$(stat -c %a /dev/kvm 2>/dev/null)" in
      *[67]) probe kvm=ok ;;
      *)
        if id -nG "$U" 2>/dev/null | tr ' ' '\\n' | grep -qx "$KG"; then
          if [ -r /dev/kvm ] && [ -w /dev/kvm ]; then probe kvm=ok; else probe kvm=pending; fi
        elif [ "$KG" != root ] && [ "$ELEVATE" = 1 ] && { $R usermod -aG "$KG" "$U" || $R gpasswd -a "$U" "$KG"; } </dev/null >/dev/null 2>&1; then
          say "added $U to the $KG group for /dev/kvm (orq-agent gets it after this machine restarts)"
          probe kvm=added
        else
          say "$U is not in the $KG group, so orq-agent can't use /dev/kvm: run 'sudo usermod -aG $KG $U' and restart"
          probe "kvm=missing:$KG"
        fi ;;
    esac
  fi
  if [ "$SYSTEMD" = 1 ]; then
    if [ "$(systemctl show -p LoadState --value tailscaled.service 2>/dev/null)" = loaded ]; then
      if [ "$ELEVATE" = 1 ] && oom_service tailscaled.service; then probe oom.tailscaled=applied; else probe oom.tailscaled=missing; fi
    fi
    S=absent
    for u in ssh.service sshd.service; do
      [ "$(systemctl show -p LoadState --value "$u" 2>/dev/null)" = loaded ] || continue
      p=$(systemctl show -p MainPID --value "$u" 2>/dev/null) || p=0
      if [ -n "$p" ] && [ "$p" != 0 ]; then
        a=$(cat "/proc/$p/oom_score_adj" 2>/dev/null) || a=0
        if [ "$a" -le -900 ] 2>/dev/null; then S=ok; else S=missing; fi
        break
      fi
      if systemctl is-active -q "\${u%.service}.socket" 2>/dev/null; then S=ok; break; fi
    done
    probe "oom.sshd=$S"
    if [ "$ROOT" = 1 ]; then
      if oom_dropin ${SYSTEMD_SYSTEM_DIR}/orq-agent.service.d; then probe oom.orq-agent=applied; else probe oom.orq-agent=missing; fi
    elif [ -n "\${XDG_RUNTIME_DIR:-}" ] && [ -d "\${XDG_RUNTIME_DIR:-}/systemd" ]; then
      SV=$(systemctl --version 2>/dev/null | awk 'NR == 1 { print $2 }')
      case "$SV" in '' | *[!0-9]*) SV=0 ;; esac
      N=$(id -u)
      M=$(systemctl show -p MainPID --value "user@$N.service" 2>/dev/null) || M=0
      if [ "$ELEVATE" != 1 ]; then
        probe oom.orq-agent=missing
      elif [ "$SV" -lt ${MIN_SYSTEMD_FOR_USER_OOM} ] || [ -z "$M" ] || [ "$M" = 0 ]; then
        probe oom.orq-agent=unsupported
      else
        MA=$(systemctl show -p OOMScoreAdjust --value "user@$N.service" 2>/dev/null) || MA=100
        case "$MA" in '' | *[!0-9-]*) MA=100 ;; esac
        # Already lowered by an earlier pairing: start from the stock score.
        [ "$MA" -ge 0 ] || MA=100
        DEF=$((MA + 100)); [ "$DEF" -le 1000 ] || DEF=1000
        UD="$HOME/.config/systemd/user/orq-agent.service.d"
        if $R mkdir -p ${SYSTEMD_USER_CONF_DIR} \\
          && printf '%s\\n' ${managerConf.map(shQuote).join(" ")} '[Manager]' "DefaultOOMScoreAdjust=$DEF" | $R tee ${SYSTEMD_USER_CONF_DIR}/${OOM_DROPIN_NAME} >/dev/null \\
          && systemctl --user daemon-reload \\
          && oom_pid "$M" \\
          && oom_dropin "${SYSTEMD_SYSTEM_DIR}/user@$N.service.d" \\
          && $R systemctl daemon-reload \\
          && (umask 022 && mkdir -p "$UD" && oom_lines >"$UD/${OOM_DROPIN_NAME}"); then
          probe oom.orq-agent=applied
        else
          probe oom.orq-agent=missing
        fi
      fi
    fi
  fi
fi
if [ "$OS" = darwin ]; then
  if DevToolsSecurity -status 2>/dev/null | grep -q 'currently enabled'; then
    probe devtools=on
  elif [ "$ELEVATE" = 1 ] && $R DevToolsSecurity -enable </dev/null >/dev/null 2>&1; then
    say "turned on developer mode (DevToolsSecurity)"
    probe devtools=enabled
  else
    say "developer mode is off: run 'sudo DevToolsSecurity -enable'"
    probe devtools=off
  fi
  XP=$(xcode-select -p 2>/dev/null) || XP=
  case "$XP" in
    */Xcode*.app/Contents/Developer) probe xcode=ok ;;
    *)
      XA=
      for x in /Applications/Xcode.app /Applications/Xcode*.app; do
        if [ -d "$x" ]; then XA=$x; break; fi
      done
      if [ -z "$XA" ]; then
        say "Xcode is not installed: iOS simulators need it (install it from the App Store)"
        probe xcode=none
      elif [ "$ELEVATE" = 1 ] && $R xcode-select -s "$XA" </dev/null >/dev/null 2>&1; then
        say "pointed xcode-select at $XA"
        probe xcode=fixed
      else
        say "xcode-select does not point at Xcode: run 'sudo xcode-select -s $XA'"
        probe xcode=cli
      fi ;;
  esac
fi
`;
}

/**
 * Removes what pairing added on a Linux machine (tailnet machines spec §4.2.7), run through
 * `orq-agent` just before it uninstalls itself: the OOM drop-ins ({@link OOM_DROPIN_NAME}) for
 * `tailscaled`, the user manager and the user unit, and the `user.conf.d` default, after which
 * the running processes get their units' scores back. `orq-agent install-service`'s own system
 * drop-in dir is removed by its uninstall. Linger and `kvm` group membership stay: they are fixes
 * to the machine itself that other software may rely on, not Orquester's.
 *
 * Exits 3 and prints `orq-leftover: <path>` for each file it could not remove (no root or
 * passwordless sudo); never prompts.
 */
export function byoUnpairCleanupScript(): string {
  return `set -u
R=; LEFT=0
if [ "$(id -u)" != 0 ]; then
  if command -v sudo >/dev/null 2>&1 && sudo -n true </dev/null >/dev/null 2>&1; then R="sudo -n"; else R=none; fi
fi
N=$(id -u)
UD="$HOME/.config/systemd/user/orq-agent.service.d"
rm -f "$UD/${OOM_DROPIN_NAME}" && rmdir "$UD" 2>/dev/null
CHANGED=0
for f in ${SYSTEMD_SYSTEM_DIR}/tailscaled.service.d/${OOM_DROPIN_NAME} "${SYSTEMD_SYSTEM_DIR}/user@$N.service.d/${OOM_DROPIN_NAME}" ${SYSTEMD_USER_CONF_DIR}/${OOM_DROPIN_NAME}; do
  if [ "$R" = none ]; then
    [ -e "$f" ] || continue
  else
    $R test -e "$f" </dev/null || continue
  fi
  if [ "$R" != none ] && $R rm -f "$f" </dev/null; then
    CHANGED=1
    $R rmdir "$(dirname "$f")" </dev/null 2>/dev/null
  else
    printf 'orq-leftover: %s\\n' "$f"; LEFT=1
  fi
done
if [ "$CHANGED" = 1 ]; then
  $R systemctl daemon-reload </dev/null
  for u in tailscaled.service "user@$N.service"; do
    p=$(systemctl show -p MainPID --value "$u" 2>/dev/null) || p=0
    a=$(systemctl show -p OOMScoreAdjust --value "$u" 2>/dev/null) || a=
    if [ -n "$p" ] && [ "$p" != 0 ] && [ -n "$a" ]; then printf '%s\\n' "$a" | $R tee "/proc/$p/oom_score_adj" >/dev/null; fi
  done
fi
[ "$LEFT" = 0 ] || exit 3
exit 0
`;
}

/** The second stage's variants (`boxRoutes.bootstrapScript(variant)`): VMs, and containers (no service manager). */
const BOOTSTRAP_STAGE2_VARIANTS = ["posix", "container"] as const;
type BootstrapStage2Variant = (typeof BOOTSTRAP_STAGE2_VARIANTS)[number];

function posixScript(options: PosixOptions): string {
  return [
    posix.header(
      `# Orquester box bootstrap (Ephemeral AI VMs). Downloads orq-agent from the
# Orquester daemon and starts it. Secrets stay in mode-0600 files; never in argv
# or this script's output.`,
      options
    ),
    posix.dataDir({ tailscale: options.tailscale, fromEnv: false }),
    posixSecretsPrologue(options.secrets, options.tailscale),
    "",
    posix.platform(options.container),
    posix.fetch(),
    options.tailscale ? posixTailscale(options.container) : "",
    "",
    posix.agent(),
    options.container ? "" : posixBoxOomProtection(),
    posix.start(options.container)
  ].join("\n");
}

/**
 * The second stage of a staged bootstrap ({@link stagedPosixScript}): everything after the
 * tailnet join — download `orq-agent`, start it. Generic per variant (no box id, URL or secret
 * in it): the first stage's environment supplies the daemon URL, the box id, the token file
 * path and, behind tailscaled's userspace proxy, `ORQ_PROXY` ({@link ORQ_AGENT_ENV}).
 * `null` for an unknown variant.
 */
export function bootstrapSecondStage(variant: string): string | null {
  if (!(BOOTSTRAP_STAGE2_VARIANTS as readonly string[]).includes(variant)) return null;
  const container = variant === "container";
  return [
    posix.header(
      `# Orquester box bootstrap, second stage (Ephemeral AI VMs). Run by the first
# stage, which wrote the bootstrap token file and joined the tailnet. Downloads
# orq-agent from the Orquester daemon and starts it.`,
      null
    ),
    posix.dataDir({ tailscale: false, fromEnv: true }),
    posix.platform(container),
    posix.fetch(),
    posix.agent(),
    container ? "" : posixBoxOomProtection(),
    posix.start(container)
  ].join("\n");
}

/**
 * The first stage of a staged bootstrap, for providers that cap the script's size (vast.ai's
 * `onstart`): writes the secrets to 0600 files, joins the tailnet, then downloads the second
 * stage for its variant (`boxRoutes.bootstrapScript`, authenticated with the same bootstrap
 * token, which downloading does not spend) and runs it. A restarted box whose token is spent
 * runs the copy it saved the first time. Compacted like the container command.
 */
function stagedPosixScript(options: PosixOptions): string {
  const variant: BootstrapStage2Variant = options.container ? "container" : "posix";
  return compactShell(
    [
      posix.header("# Orquester box bootstrap, first stage (Ephemeral AI VMs).", options),
      posix.dataDir({ tailscale: options.tailscale, fromEnv: false }),
      posixSecretsPrologue(options.secrets, options.tailscale),
      // Only the tailnet join needs to know the machine.
      options.tailscale ? posix.tailnetPlatform(options.container) : "",
      posix.fetch(),
      options.tailscale ? posixTailscale(options.container) : "",
      `S="$D/bootstrap-stage2.sh"`,
      posix.download({
        what: "the bootstrap",
        path: `/api/boxes/bootstrap/${variant}`,
        out: "$S",
        spent: `if [ -s "$S" ]; then say "token already used; running the saved bootstrap"; rm -f "$S.download"; break; fi`,
        missing: "the daemon does not serve the bootstrap's second stage"
      }),
      `if [ -f "$S.download" ]; then mv -f "$S.download" "$S"; fi`,
      `${ORQ_AGENT_ENV.bootstrapTokenFile}=$TF`,
      `export ${ORQ_AGENT_ENV.bootstrapTokenFile}`,
      `exec sh "$S"`
    ].join("\n")
  );
}

function powershellScript(input: BootstrapInput, daemonUrl: string): string {
  const tailscale =
    input.tailscaleAuthKey === null
      ? ""
      : `
# Join the tailnet first: the daemon is reached at its tailnet address.
$TsKeyFile = Join-Path $Dir 'ts-authkey'
[IO.File]::WriteAllText($TsKeyFile, ${psQuote(input.tailscaleAuthKey)})
$Ts = Join-Path $env:ProgramFiles 'Tailscale\\tailscale.exe'
try {
  if (-not (Test-Path $Ts)) {
    Say 'installing Tailscale'
    $TsArch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'amd64' }
    $Msi = Join-Path $Dir 'tailscale.msi'
    Invoke-WebRequest -UseBasicParsing -Uri "https://pkgs.tailscale.com/stable/tailscale-setup-latest-$TsArch.msi" -OutFile $Msi
    $p = Start-Process -FilePath msiexec.exe -ArgumentList @('/i', ('"' + $Msi + '"'), '/quiet', '/norestart', 'TS_UNATTENDEDMODE=always') -Wait -PassThru
    Remove-Item -Force $Msi
    if ($p.ExitCode -ne 0) { throw "the Tailscale installer failed ($($p.ExitCode))" }
  }
  $Until = (Get-Date).AddMinutes(2)
  while ((Get-Service -Name Tailscale -ErrorAction SilentlyContinue).Status -ne 'Running') {
    if ((Get-Date) -gt $Until) { throw 'the Tailscale service did not start' }
    Start-Service -Name Tailscale -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
  }
  Say 'joining the tailnet'
  & $Ts up "--auth-key=file:$TsKeyFile" "--hostname=orq-$BoxId" --unattended --timeout=180s
  if ($LASTEXITCODE -ne 0) { throw "tailscale up failed ($LASTEXITCODE)" }
} finally {
  Remove-Item -Force -ErrorAction SilentlyContinue $TsKeyFile
}
`;

  return `#ps1_sysnative
# Orquester box bootstrap (Ephemeral AI VMs, Windows). Downloads orq-agent from the
# Orquester daemon and installs it as a service. Secrets stay in files only
# SYSTEM and Administrators can read; never in arguments or this script's output.
Set-PSDebug -Off
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
$DaemonUrl = ${psQuote(daemonUrl)}
$BoxId = ${psQuote(input.boxId)}
function Say([string]$Message) { Write-Host "orq-bootstrap: $Message" }

$Dir = '${WINDOWS_DATA_DIR}'
New-Item -ItemType Directory -Force -Path $Dir | Out-Null
# Only SYSTEM (S-1-5-18) and Administrators (S-1-5-32-544) may read the agent directory.
& icacls.exe $Dir /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'could not restrict the agent directory' }
$TokenFile = Join-Path $Dir 'bootstrap-token'
[IO.File]::WriteAllText($TokenFile, ${psQuote(input.bootstrapToken)})
${tailscale}
$Exe = Join-Path $Dir 'orq-agent.exe'
# Ends in .exe: PowerShell runs only PATHEXT files as programs (any other name is a document).
$Download = Join-Path $Dir 'orq-agent.download.exe'
Say 'downloading orq-agent (win32-x64)'
$Until = (Get-Date).AddSeconds(${DOWNLOAD_DEADLINE_SECONDS})
$Attempt = 0
while ($true) {
  try {
    $Headers = @{ Authorization = 'Bearer ' + [IO.File]::ReadAllText($TokenFile) }
    Invoke-WebRequest -UseBasicParsing -Uri "$DaemonUrl/api/boxes/agent/win32-x64" -Headers $Headers -OutFile $Download -TimeoutSec 900
    $Headers = $null
    break
  } catch {
    $Headers = $null
    $Status = 0
    if ($_.Exception.Response) { $Status = [int]$_.Exception.Response.StatusCode }
    if ($Status -eq 401 -or $Status -eq 403) {
      # A restarted box whose token was already spent keeps the orq-agent it has.
      if (Test-Path $Exe) { Say 'token already used; keeping the installed orq-agent'; break }
      throw "the daemon refused the bootstrap token (HTTP $Status)"
    }
    if ($Status -eq 404) { throw 'the daemon has no orq-agent build for win32-x64' }
    if ((Get-Date) -gt $Until) { throw "could not download orq-agent (HTTP $Status)" }
    $Attempt++
    $Wait = [Math]::Min(30, 2 * $Attempt)
    Say "download failed (HTTP $Status); retrying in $Wait s"
    Start-Sleep -Seconds $Wait
  }
}
if (Test-Path $Download) {
  & $Download --version | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'the downloaded orq-agent does not run here' }
  Move-Item -Force $Download $Exe
}

$env:${ORQ_AGENT_ENV.daemonUrl} = $DaemonUrl
$env:${ORQ_AGENT_ENV.boxId} = $BoxId
$env:${ORQ_AGENT_ENV.bootstrapTokenFile} = $TokenFile
$Admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ($Admin) {
  Say 'installing the orq-agent service'
  & $Exe install-service
} else {
  Say 'starting orq-agent'
  & $Exe run
}
exit $LASTEXITCODE
`;
}

function cloudInit(input: BootstrapInput, script: string): string {
  const files = [
    `  - path: ${POSIX_ROOT_DATA_DIR}/bootstrap-token
    owner: root:root
    permissions: '0600'
    content: '${input.bootstrapToken}'`
  ];
  if (input.tailscaleAuthKey !== null) {
    files.push(`  - path: ${POSIX_ROOT_DATA_DIR}/ts-authkey
    owner: root:root
    permissions: '0600'
    content: '${input.tailscaleAuthKey}'`);
  }
  files.push(`  - path: ${POSIX_ROOT_DATA_DIR}/bootstrap.sh
    owner: root:root
    permissions: '0700'
    encoding: b64
    content: ${Buffer.from(script, "utf8").toString("base64")}`);
  return `#cloud-config
write_files:
${files.join("\n")}
runcmd:
  - [/bin/sh, ${POSIX_ROOT_DATA_DIR}/bootstrap.sh]
`;
}

/**
 * The container start command travels as one argv string, and some providers cap its length
 * (vast.ai's on-start script: 4 KB): drop indentation, comments and blank lines.
 */
function compactShell(script: string): string {
  return script
    .split("\n")
    .map((line) => line.trimStart())
    .filter((line, index) => line.length > 0 && (index === 0 || !line.startsWith("#")))
    .join("\n");
}

/** What a bring-your-own machine's pairing script needs (`service/byo.ts`). */
interface ByoPairingScriptInput {
  boxId: string;
  daemonUrl: string;
  /** The single-use bootstrap token minted when the pairing code was spent. */
  bootstrapToken: string;
  kind: "linux" | "macos";
  /** The owner's name for the machine (only shown in the script's messages). */
  name: string;
  /**
   * Pairing over SSH (`machines/pairing`): nobody is at a terminal, so the script never asks for a
   * sudo password, gives up on an unreachable daemon sooner, and reports each probe as a
   * {@link PAIRING_PROBE_PREFIX} line.
   */
  unattended?: boolean;
}

/** Where a bring-your-own machine keeps `orq-agent` when the pairing script runs as its user. */
const BYO_MACOS_AGENT_PATH = '$HOME/Library/Application Support/Orquester/orq-agent';
const BYO_LINUX_ROOT_AGENT_PATH = "/usr/local/bin/orq-agent";
const BYO_LINUX_USER_AGENT_PATH = "$HOME/.local/bin/orq-agent";

/**
 * The script `curl -fsSL <daemon>/api/boxes/pair/<code> | sh` runs on the owner's own machine: the
 * POSIX bootstrap's pieces (token file, platform, download), then `orq-agent` installed where its
 * user can update it — macOS `~/Library/Application Support/Orquester/orq-agent`; Linux
 * `/usr/local/bin/orq-agent` as root, else `~/.local/bin/orq-agent`, linked into `/usr/local/bin`
 * with sudo when sudo is there (the service runs the real file, which the user can replace on
 * updates) — and `orq-agent install-service`: a LaunchAgent in the user's GUI session on macOS, a
 * systemd (user) service on Linux. The bootstrap token goes into a 0600 file in the data dir and
 * is exchanged for the machine's credential (also 0600) on its first connect. No tailnet join:
 * the machine dials the configured URL as it is. Before `install-service` it probes and fixes the
 * machine ({@link posixMachineFixes}: linger, `/dev/kvm`, OOM protection; developer mode and
 * Xcode on macOS) with root or `sudo -n` only.
 */
export function byoPairingScript(input: ByoPairingScriptInput): string {
  const daemonUrl = normalizeDaemonUrl(input.daemonUrl);
  if (!BOX_ID_PATTERN.test(input.boxId)) throw new Error("Invalid box id for a bootstrap");
  if (!SECRET_PATTERN.test(input.bootstrapToken)) throw new Error("Invalid bootstrap token format");
  const os = input.kind === "macos" ? "darwin" : "linux";
  const osLabel = input.kind === "macos" ? "macOS" : "Linux";
  // Only printed: keep it to plain characters so it can sit in single quotes.
  const name = input.name.replace(/[^\p{L}\p{N} ._()+-]/gu, "").slice(0, 60) || "this machine";
  return [
    posix.header(
      `# Orquester: pair this machine as a bring-your-own ${osLabel} box (Ephemeral AI VMs).
# Downloads orq-agent from the Orquester daemon, installs it for this user and starts
# it as a service. The one-time token stays in a mode-0600 file; never in argv or output.`,
      { daemonUrl, boxId: input.boxId }
    ),
    posix.dataDir({ tailscale: false, fromEnv: false }),
    posixSecretsPrologue({ kind: "literal", token: input.bootstrapToken, tailscaleAuthKey: null }, false),
    "",
    posix.platform(false),
    `[ "$OS" = ${os} ] || { rm -f "$TF"; die "this pairing command is for a ${osLabel} machine, but this one runs $OS"; }`,
    input.kind === "macos"
      ? `[ "$ROOT" = 0 ] || { rm -f "$TF"; die "run the pairing command as the user who stays logged in (not with sudo): orq-agent runs in that user's session"; }`
      : "",
    posix.fetch(),
    posix.agent(input.unattended ? UNATTENDED_DOWNLOAD_DEADLINE_SECONDS : undefined),
    posixMachineFixes(input.unattended === true),
    `case "$OS" in
  darwin) T="${BYO_MACOS_AGENT_PATH}" ;;
  *) if [ "$ROOT" = 1 ]; then T=${BYO_LINUX_ROOT_AGENT_PATH}; else T="${BYO_LINUX_USER_AGENT_PATH}"; fi ;;
esac
(umask 022 && mkdir -p "$(dirname "$T")")
cp "$B" "$T.new" && chmod 755 "$T.new" && mv -f "$T.new" "$T" || die "could not install orq-agent at $T"
rm -f "$B"
say "installed orq-agent at $T"
if [ "$OS" = linux ] && [ "$ROOT" = 0 ]; then
  if [ "$ELEVATE" = 1 ] && $R ln -sf "$T" ${BYO_LINUX_ROOT_AGENT_PATH} </dev/null 2>/dev/null; then
    say "linked ${BYO_LINUX_ROOT_AGENT_PATH}"
  elif ${input.unattended ? "false" : "[ \"$ELEVATE\" = 0 ] && command -v sudo >/dev/null 2>&1"} \
    && sudo -p 'orq-bootstrap: sudo password to link orq-agent into /usr/local/bin: ' ln -sf "$T" ${BYO_LINUX_ROOT_AGENT_PATH} </dev/null 2>/dev/null; then
    say "linked ${BYO_LINUX_ROOT_AGENT_PATH}"
  else
    say "orq-agent stays in $T (no sudo)"
  fi
fi
${ORQ_AGENT_ENV.bootstrapTokenFile}=$TF
export ${ORQ_AGENT_ENV.bootstrapTokenFile}
say "installing the orq-agent service"
"$T" install-service || die "orq-agent install-service failed"
say ${shQuote(`done: this machine connects to Orquester as "${name}". Remove it in Orquester (Settings → Plugins → Ephemeral AI VMs) to uninstall.`)}
`
  ].join("\n");
}

/** Build every bootstrap variant for one box (`BuildBootstrap`, contracts.ts). Throws on invalid input. */
export const buildBootstrap: BuildBootstrap = (input: BootstrapInput): BoxBootstrap => {
  const { daemonUrl } = validateInput(input);
  const base = { daemonUrl, boxId: input.boxId, container: input.container, tailscale: input.tailscaleAuthKey !== null };
  const env: Record<string, string> = {
    [ORQ_AGENT_ENV.daemonUrl]: daemonUrl,
    [ORQ_AGENT_ENV.boxId]: input.boxId,
    [ORQ_AGENT_ENV.bootstrapToken]: input.bootstrapToken
  };
  if (input.tailscaleAuthKey !== null) env[ORQ_AGENT_ENV.tailscaleAuthKey] = input.tailscaleAuthKey;
  const literal: SecretSource = { kind: "literal", token: input.bootstrapToken, tailscaleAuthKey: input.tailscaleAuthKey };
  return {
    posixScript: posixScript({ ...base, secrets: literal }),
    stagedPosixScript: stagedPosixScript({ ...base, secrets: literal }),
    powershellScript: powershellScript(input, daemonUrl),
    // The container's argv is visible to `ps` and in provider dashboards: the secrets come from `env`.
    containerCommand: ["/bin/sh", "-c", compactShell(posixScript({ ...base, container: true, secrets: { kind: "env" } }))],
    env,
    cloudInit: cloudInit(input, posixScript({ ...base, secrets: { kind: "files" } }))
  };
};
