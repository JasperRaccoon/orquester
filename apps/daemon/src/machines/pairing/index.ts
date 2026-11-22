/**
 * "Pair over SSH" (tailnet machines spec §4.2 items 1–5, §4.9, §4.10): the {@link MachinePairingPort}
 * the machines registry calls from its owner-only `pair-ssh` route.
 *
 * 1. **Where and as whom.** The machine's `~/.ssh/config` alias, else its MagicDNS name, else its
 *    first tailnet IP; the owner's user, port and identity file overrides on top (the request's
 *    win over the saved ones). With no alias, the daemon user's `~/.ssh/id_ed25519` is offered
 *    first. A user must be known: given, or set by `~/.ssh/config` for that host (`ssh -G`);
 *    otherwise the owner is asked for one rather than guessing this server's own user name.
 * 2. **Host key.** A first `ssh` with `StrictHostKeyChecking=yes` against the daemon user's own
 *    known_hosts: a known, matching key goes straight on; a changed one blocks pairing. An unknown
 *    one is fetched by an `ssh` run with every authentication method off that writes it into a
 *    throwaway known_hosts, and answered as `confirm-host-key`. The confirming call fetches it again
 *    and, if it is the confirmed fingerprint, pins exactly that key in a throwaway known_hosts for
 *    the rest of the run (strict checking). Nothing is ever trusted on first use, and the daemon
 *    user's own known_hosts is never written.
 * 3. **The bootstrap.** A `pairing` BYO record and its unattended pairing script (`byo.addForSsh`)
 *    with the daemon URL filled in: the daemon's tailnet HTTPS URL for a tailnet peer while
 *    `tailscale serve` routes to it, else the configured route. The script, which carries the
 *    bootstrap token, goes over stdin to `sh -s`: no secret is in any argv, here or on the machine.
 *    It probes and fixes the machine (linger, `/dev/kvm`, OOM protection; developer mode and Xcode
 *    on macOS) with `sudo -n` only, and installs `orq-agent`, which then connects on its own.
 *
 *    **Windows** (the registry says so, and `echo %OS%` answers `Windows_NT` from cmd.exe, or
 *    `%OS%` from a PowerShell login shell): the PowerShell script goes over stdin to
 *    {@link WINDOWS_PAIRING_COMMAND} instead. It needs an administrator (elevated over SSH without a
 *    prompt, which is what `sudo.passwordless` means there: `orq-agent` then runs as LocalSystem),
 *    installs the OrqAgent service and the desktop-session helper's logon task, and probes the
 *    Windows Hypervisor Platform and the desktop session (`probe.ts`). It prints ASCII only, so the
 *    console's code page can't garble what is parsed here. No OOM protection on Windows (§4.9.3).
 * 4. **Result.** `pairing` once the script succeeded; otherwise the record is removed and the
 *    failure classified (`classify.ts`). The probe's findings stay in {@link MachinePairingPort.lastProbe}
 *    (in memory: the next pairing probes again).
 *
 * Raw `ssh` output is never logged or returned: problems carry fixed text naming the machine and the fix.
 */

import { constants } from "node:fs";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";

import type { MachineProblem, MachineSummary, PairMachineOverSshRequest, PairMachineOverSshResponse } from "@orquester/api";

import { WINDOWS_PAIRING_COMMAND } from "../../boxes/bootstrap/bootstrap.ts";
import type { ByoMachines } from "../../boxes/service/byo.ts";
import { BoxError } from "../../boxes/service/errors.ts";
import type { LocalTailscale } from "../../boxes/tailscale/local.ts";
import type { MachinePairingPort, MachineProbeResult, MachineTarget } from "../ports.ts";
import { classifySshFailure, type SshFailureContext } from "./classify.ts";
import { parseKnownHosts, preferredHostKey } from "./host-keys.ts";
import { bootstrapErrorLine, parseProbeLines, probeResult } from "./probe.ts";
import { spawnSshRunner, type SshProcessRunner, type SshRunResult } from "./runner.ts";

export { classifySshFailure } from "./classify.ts";
export type { SshProcessRunner, SshRunResult } from "./runner.ts";

export interface MachinePairingDeps {
  byo: Pick<ByoMachines, "addForSsh" | "remove">;
  /** The configured route bring-your-own machines dial (`BoxSettings.route("byo")`); throws a `BoxError` when there is none. */
  byoRoute(): { mode: "public-url" | "tailscale"; daemonUrl: string };
  /** The daemon host's Tailscale, read only (`LocalTailscale.state`); null when unavailable. */
  localTailscale: Pick<LocalTailscale, "state"> | null;
  /** The machine as the registry shows it, for the `pairing` answer. */
  summarize(machineId: string): MachineSummary;
  /**
   * The BYO record pairing just created for a machine, before its bootstrap runs (`orq-agent` may
   * connect before `ssh` returns). On failure the record is removed again.
   */
  linkBox?(machineId: string, boxId: string): void | Promise<void>;
  /** The daemon user's home (for `~/.ssh/id_ed25519`); default `os.homedir()`. */
  home?: string;
  /** The daemon user's name (what `ssh` would fall back to); default `os.userInfo().username`. */
  localUser?: string;
  /** Default `ssh` on PATH. */
  sshBinary?: string;
  run?: SshProcessRunner;
  /** Where the throwaway known_hosts files go; default `os.tmpdir()`. */
  tempDir?: string;
  now?: () => number;
  logger: Pick<Console, "warn">;
}

const CONNECT_TIMEOUT_SECONDS = 15;
const CONFIG_TIMEOUT_MS = 10_000;
const PREFLIGHT_TIMEOUT_MS = 60_000;
/** The script downloads `orq-agent` (giving up after 3 min) and installs it. */
const BOOTSTRAP_TIMEOUT_MS = 10 * 60_000;

const USER_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}\$?$/;
const ALIAS_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.@%+-]{0,127}$/;
const HOST_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/;

/** Options of every run: never interactive, no reuse of a shared connection, no forwardings, no writes to ~/.ssh. */
const COMMON_OPTIONS = [
  "-T",
  "-o",
  "BatchMode=yes",
  "-o",
  `ConnectTimeout=${CONNECT_TIMEOUT_SECONDS}`,
  "-o",
  "ServerAliveInterval=15",
  "-o",
  "ServerAliveCountMax=4",
  "-o",
  "ControlMaster=no",
  "-o",
  "ControlPath=none",
  "-o",
  "UpdateHostKeys=no",
  "-o",
  "ClearAllForwardings=yes",
  "-o",
  "ForwardAgent=no",
  "-o",
  "ForwardX11=no",
  "-o",
  "PermitLocalCommand=no",
  "-o",
  "LogLevel=ERROR"
];

/** ssh option values are split on whitespace unless quoted. */
function optionPath(path: string): string {
  return `"${path}"`;
}

interface Plan {
  machineId: string;
  name: string;
  destination: string;
  /** `-p`, `-l`, `-i`, as overridden. */
  overrides: string[];
  context: SshFailureContext;
}

export function createMachinePairing(deps: MachinePairingDeps): MachinePairingPort {
  const run = deps.run ?? spawnSshRunner;
  const ssh = deps.sshBinary ?? "ssh";
  const home = deps.home ?? homedir();
  const localUser = deps.localUser ?? userInfo().username;
  const now = deps.now ?? Date.now;
  const probes = new Map<string, MachineProbeResult>();
  const inFlight = new Set<string>();

  const failed = (problem: MachineProblem): PairMachineOverSshResponse => ({ status: "failed", problem });
  const problemOf = (target: MachineTarget, code: MachineProblem["code"], message: string, fix?: string): MachineProblem => ({
    code,
    machineId: target.machineId,
    message,
    ...(fix ? { fix } : {})
  });

  /** Where to connect and as whom; a failed answer when the inputs can't make a connection. */
  async function plan(target: MachineTarget, request: PairMachineOverSshRequest): Promise<Plan | PairMachineOverSshResponse> {
    const name = (request.name ?? "").trim() || target.name;
    if (target.os !== "linux" && target.os !== "macos" && target.os !== "windows") {
      return failed(problemOf(target, "pair-bootstrap-failed", `${target.name} doesn't run Linux, macOS or Windows, so it can't be paired.`));
    }
    if (target.boxId !== null) {
      return failed(problemOf(target, "pair-bootstrap-failed", `${target.name} is paired already.`, `Remove ${target.name} first to pair it again.`));
    }
    const alias = request.sshAlias ?? target.ssh.sshAlias ?? null;
    const user = request.user ?? target.ssh.user ?? null;
    const port = request.port ?? target.ssh.port ?? null;
    const identity = request.identityFile ?? target.ssh.identityFile ?? null;
    if (alias !== null && !ALIAS_PATTERN.test(alias)) {
      return failed(problemOf(target, "ssh-resolve-failed", `"${alias.slice(0, 80)}" isn't a usable ~/.ssh/config alias for ${target.name}.`, "Use the alias's Host name exactly as in ~/.ssh/config."));
    }
    if (user !== null && !USER_PATTERN.test(user)) {
      return failed(problemOf(target, "ssh-auth-refused", `"${user.slice(0, 80)}" isn't a valid user name for ${target.name}.`, "Enter the account name you log in to it with."));
    }
    if (port !== null && (!Number.isInteger(port) || port < 1 || port > 65_535)) {
      return failed(problemOf(target, "ssh-unreachable", `${String(port).slice(0, 12)} isn't a valid SSH port for ${target.name}.`, "Use a port from 1 to 65535 (SSH's default is 22)."));
    }
    let identityFile: string | null = null;
    if (identity !== null) {
      if (!identity.startsWith("/") || /[\u0000-\u001f\u007f]/.test(identity)) {
        return failed(problemOf(target, "ssh-auth-refused", `The identity file for ${target.name} must be an absolute path on the Orquester server.`));
      }
      if (!(await readable(identity))) {
        return failed(problemOf(target, "ssh-auth-refused", `The identity file ${identity} for ${target.name} doesn't exist on the Orquester server (or can't be read).`, "Give the path of a private key the Orquester server's user can read."));
      }
      identityFile = identity;
    } else if (alias === null) {
      const fallback = join(home, ".ssh", "id_ed25519");
      if (await readable(fallback)) identityFile = fallback;
    }
    const address = alias ?? target.dnsName ?? target.tailnetIps[0] ?? null;
    if (address === null || (alias === null && !HOST_PATTERN.test(address) && isIP(address) === 0)) {
      return failed(problemOf(target, "ssh-resolve-failed", `${target.name} has no tailnet name or address to connect to.`, "Pair it through an ~/.ssh/config alias."));
    }
    const overrides: string[] = [];
    if (port !== null) overrides.push("-p", String(port));
    if (user !== null) overrides.push("-l", user);
    if (identityFile !== null) overrides.push("-i", identityFile);

    // What ssh will really use, after ~/.ssh/config.
    const config = await run(ssh, ["-G", ...overrides, "--", address], { timeoutMs: CONFIG_TIMEOUT_MS });
    const resolved = parseSshConfig(config.stdout);
    const context: SshFailureContext = {
      machineId: target.machineId,
      machineName: target.name,
      destination: address,
      user,
      port: port ?? (resolved.port !== null && resolved.port !== 22 ? resolved.port : null),
      identityFile
    };
    if (config.code !== 0) {
      return failed(classifySshFailure({ ...config, code: 255 }, context) ?? problemOf(target, "ssh-resolve-failed", `The Orquester server's ~/.ssh/config can't be read for ${target.name}.`));
    }
    if (user === null) {
      // ssh falls back to this server's own user: only an alias or a config entry may choose that.
      if (alias === null && (resolved.user === null || resolved.user === localUser)) {
        return failed(
          problemOf(target, "ssh-auth-refused", `Orquester doesn't know which user to log in to ${target.name} as.`, `Enter the SSH user for ${target.name} (the account you log in to it with), or set one in an ~/.ssh/config alias, and pair again.`)
        );
      }
      context.user = resolved.user;
    }
    return { machineId: target.machineId, name, destination: address, overrides, context };
  }

  function sshArgs(p: Plan, hostKeys: string[], command: string): string[] {
    return [...COMMON_OPTIONS, ...hostKeys, ...p.overrides, "--", p.destination, command];
  }

  /** `ssh` with every authentication method off: it records the offered host key into `file`, then fails to log in. */
  async function fetchHostKey(p: Plan, file: string): Promise<{ keys: ReturnType<typeof parseKnownHosts>; result: SshRunResult }> {
    const options = [
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-o",
      `UserKnownHostsFile=${optionPath(file)}`,
      "-o",
      "GlobalKnownHostsFile=/dev/null",
      "-o",
      "HashKnownHosts=no",
      "-o",
      "CheckHostIP=no",
      "-o",
      "IdentityAgent=none",
      "-o",
      "PubkeyAuthentication=no",
      "-o",
      "PasswordAuthentication=no",
      "-o",
      "KbdInteractiveAuthentication=no",
      "-o",
      "GSSAPIAuthentication=no",
      "-o",
      "HostbasedAuthentication=no",
      "-o",
      "PreferredAuthentications=publickey"
    ];
    const result = await run(ssh, sshArgs(p, options, "true"), { timeoutMs: PREFLIGHT_TIMEOUT_MS });
    const text = await readFile(file, "utf8").catch(() => "");
    return { keys: parseKnownHosts(text), result };
  }

  async function pair(target: MachineTarget, request: PairMachineOverSshRequest): Promise<PairMachineOverSshResponse> {
    const planned = await plan(target, request);
    if ("status" in planned) return planned;
    const p = planned;
    const dir = await mkdtemp(join(deps.tempDir ?? tmpdir(), "orq-pair-"));
    // Win32-OpenSSH runs commands with cmd.exe (or PowerShell): no uname there.
    const osCommand = target.os === "windows" ? "echo %OS%" : "uname -s";
    try {
      const strict = ["-o", "StrictHostKeyChecking=yes"];
      let hostKeys = strict;
      let preflight = await run(ssh, sshArgs(p, hostKeys, osCommand), { timeoutMs: PREFLIGHT_TIMEOUT_MS });
      let problem = preflight.code === 0 ? null : classifySshFailure(preflight, p.context);
      if (problem?.code === "ssh-host-key-unknown") {
        const { keys, result } = await fetchHostKey(p, join(dir, "offered"));
        const key = preferredHostKey(keys);
        if (key === null) {
          return failed(
            classifySshFailure(result, p.context) ?? problemOf(target, "ssh-unreachable", `The Orquester server couldn't read the SSH host key of ${target.name}.`, "Check that its SSH server is running, then pair again.")
          );
        }
        const accepted = request.acceptHostKeyFingerprint?.trim();
        if (!accepted) return { status: "confirm-host-key", hostKey: { keyType: key.keyType, fingerprint: key.fingerprint, host: p.destination } };
        const pinned = keys.filter((candidate) => candidate.fingerprint === accepted);
        if (pinned.length === 0) {
          return failed(
            problemOf(
              target,
              "ssh-host-key-changed",
              `The SSH host key ${target.name} offers now (${key.fingerprint}) isn't the one you confirmed, so pairing is blocked.`,
              `If ${target.name} was just reinstalled, pair again and confirm its current fingerprint; otherwise someone may be intercepting the connection.`
            )
          );
        }
        const pinnedFile = join(dir, "pinned");
        await writeFile(pinnedFile, `${pinned.map((candidate) => candidate.line).join("\n")}\n`, { mode: 0o600 });
        hostKeys = [...strict, "-o", `UserKnownHostsFile=${optionPath(pinnedFile)}`, "-o", "GlobalKnownHostsFile=/dev/null", "-o", "CheckHostIP=no"];
        preflight = await run(ssh, sshArgs(p, hostKeys, osCommand), { timeoutMs: PREFLIGHT_TIMEOUT_MS });
        problem = preflight.code === 0 ? null : classifySshFailure(preflight, p.context);
      }
      if (problem) return failed(problem);
      if (preflight.code !== 0) {
        return failed(problemOf(target, "pair-bootstrap-failed", `${target.name} accepted the SSH login but couldn't run a shell command.`, `Check ${p.context.user ?? "the user"}'s login shell on ${target.name}.`));
      }
      const uname = preflight.stdout.trim().split(/\s+/).at(-1) ?? "";
      const kind =
        target.os === "windows" ? (uname === "Windows_NT" || uname === "%OS%" ? "windows" : null) : uname === "Linux" ? "linux" : uname === "Darwin" ? "macos" : null;
      if (kind === null) {
        return failed(
          problemOf(
            target,
            "pair-bootstrap-failed",
            target.os === "windows"
              ? `${target.name} answered the SSH login, but not like Windows' OpenSSH server, so it can't be paired over SSH.`
              : `${target.name} doesn't run Linux or macOS, so it can't be paired over SSH.`,
            target.os === "windows" ? `Pair it with the copy-paste command from Settings → Plugins → Ephemeral AI VMs → Add your machine, in an administrator PowerShell on ${target.name}.` : undefined
          )
        );
      }

      let route: { mode: "public-url" | "tailscale"; daemonUrl: string };
      let boxId: string;
      let script: string;
      try {
        route = await daemonRoute(target);
        ({ boxId, script } = await deps.byo.addForSsh({ kind, name: p.name, daemonUrl: route.daemonUrl, connectRoute: route.mode }));
      } catch (error) {
        return failed(problemOf(target, "pair-bootstrap-failed", `Orquester couldn't prepare the pairing of ${target.name}: ${userMessage(error)}`));
      }
      try {
        await deps.linkBox?.(target.machineId, boxId);
        const result = await run(ssh, sshArgs(p, hostKeys, kind === "windows" ? WINDOWS_PAIRING_COMMAND : "sh -s"), { input: script, timeoutMs: BOOTSTRAP_TIMEOUT_MS });
        const facts = parseProbeLines(`${result.stderr}\n${result.stdout}`);
        if (facts.size > 0) {
          probes.set(target.machineId, probeResult(facts, { machineId: target.machineId, machineName: target.name, user: p.context.user ?? localUser }, new Date(now()).toISOString()));
        }
        if (result.code === 0 && !result.timedOut) return { status: "pairing", machine: deps.summarize(target.machineId) };
        await deps.byo.remove(boxId).catch((error: unknown) => deps.logger.warn(`Machine ${target.machineId}: could not remove the failed pairing's record`, userMessage(error)));
        if (result.timedOut) {
          return failed(problemOf(target, "pair-bootstrap-failed", `The pairing script on ${target.name} didn't finish within ${BOOTSTRAP_TIMEOUT_MS / 60_000} minutes.`, `Check that ${target.name} can reach the Orquester server, then pair again.`));
        }
        const classified = result.code === 255 || result.spawnError !== undefined ? classifySshFailure(result, p.context) : null;
        if (classified) return failed(classified);
        if (kind === "windows" && facts.get("sudo") === "no") {
          const user = p.context.user ?? "the SSH user";
          return failed(
            problemOf(
              target,
              "sudo-unavailable",
              `${user} isn't an administrator on ${target.name}, so orq-agent can't be installed as a Windows service there.`,
              `Pair over SSH as an administrator of ${target.name}, or add ${user} to its Administrators group, then pair again.`
            )
          );
        }
        const reason = bootstrapErrorLine(`${result.stderr}\n${result.stdout}`);
        return failed(
          problemOf(
            target,
            "pair-bootstrap-failed",
            reason ? `Pairing ${target.name} failed: ${reason}.` : `The pairing script on ${target.name} stopped (exit ${result.code ?? "unknown"}).`,
            `Fix it on ${target.name}, then pair again (or pair it with the copy-paste command to see the whole output).`
          )
        );
      } catch (error) {
        await deps.byo.remove(boxId).catch(() => undefined);
        throw error;
      }
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** The daemon's tailnet HTTPS URL for a tailnet peer while `tailscale serve` routes to it, else the configured route. */
  async function daemonRoute(target: MachineTarget): Promise<{ mode: "public-url" | "tailscale"; daemonUrl: string }> {
    const peer = target.dnsName !== null || target.tailnetIps.length > 0;
    if (peer && deps.localTailscale) {
      const local = await deps.localTailscale.state();
      if (local.running && local.serving && local.suggestedUrl) return { mode: "tailscale", daemonUrl: local.suggestedUrl };
    }
    return deps.byoRoute();
  }

  return {
    async pairOverSsh(target, request) {
      if (inFlight.has(target.machineId)) {
        return failed(problemOf(target, "pair-bootstrap-failed", `A pairing of ${target.name} is already running.`, "Wait for it to finish."));
      }
      inFlight.add(target.machineId);
      try {
        return await pair(target, request ?? {});
      } finally {
        inFlight.delete(target.machineId);
      }
    },
    lastProbe(machineId) {
      return probes.get(machineId) ?? null;
    }
  };
}

async function readable(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/** `ssh -G`'s answer: only the fields pairing reads. */
function parseSshConfig(text: string): { user: string | null; port: number | null } {
  let user: string | null = null;
  let port: number | null = null;
  for (const line of text.split("\n")) {
    const [key, value] = line.trim().split(/\s+/, 2);
    if (key === "user" && value && USER_PATTERN.test(value)) user = value;
    if (key === "port" && value && /^\d{1,5}$/.test(value)) port = Number(value);
  }
  return { user, port };
}

/** A thrown error's user-facing message: `BoxError`s are written for the owner; anything else is generic. */
function userMessage(error: unknown): string {
  return error instanceof BoxError ? error.message : "an internal error occurred";
}
