/**
 * The pairing run's probe lines (`orq-probe: key=value`, printed by the unattended pairing script,
 * `boxes/bootstrap/bootstrap.ts` `posixMachineFixes`) as the machine's {@link MachineProbeResult}:
 * passwordless sudo, and a {@link MachineProblem} with the exact fix for every gap the run could
 * not close. Only known keys and plain values are read; nothing else from the output is kept.
 */

import type { MachineProblem, MachineSudoInfo } from "@orquester/api";

import { PAIRING_PROBE_PREFIX } from "../../boxes/bootstrap/bootstrap.ts";
import type { MachineProbeResult } from "../ports.ts";

const PROBE_LINE = /^([a-z][a-z.-]{0,40})=([A-Za-z0-9_.:,-]{1,80})$/;

/** The probe facts in an output (later lines win). */
export function parseProbeLines(output: string): Map<string, string> {
  const facts = new Map<string, string>();
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith(PAIRING_PROBE_PREFIX)) continue;
    const match = PROBE_LINE.exec(line.slice(PAIRING_PROBE_PREFIX.length).trim());
    if (match) facts.set(match[1]!, match[2]!);
  }
  return facts;
}

export interface ProbeContext {
  machineId: string;
  machineName: string;
  /** The login user the run used. */
  user: string;
}

/** What the facts mean for the owner; `facts` empty means the run never got as far as the probes. */
export function probeResult(facts: ReadonlyMap<string, string>, context: ProbeContext, probedAt: string): MachineProbeResult {
  const { machineId, machineName, user } = context;
  const problems: MachineProblem[] = [];
  const add = (code: MachineProblem["code"], message: string, fix: string) => problems.push({ code, machineId, message, fix });
  const sudoFact = facts.get("sudo");
  const sudo: MachineSudoInfo = sudoFact === "yes" ? { passwordless: true } : sudoFact === "no" ? { passwordless: false } : {};
  const noSudo = sudo.passwordless === false;

  if (facts.get("linger") === "off") {
    add("linger-off", `Linger is off for ${user} on ${machineName}, so orq-agent stops when ${user} logs out and doesn't start at boot.`, `On ${machineName}: sudo loginctl enable-linger ${user}`);
  }
  const kvm = facts.get("kvm");
  if (kvm === "added" || kvm === "pending") {
    add(
      "kvm-permission",
      `${user} is now in the kvm group on ${machineName}, but orq-agent gets /dev/kvm only after ${machineName} restarts (until then only while ${user} is logged in at its desktop).`,
      `Restart ${machineName}.`
    );
  } else if (kvm?.startsWith("missing")) {
    const group = /^missing:([a-z_][a-z0-9_-]{0,31})$/.exec(kvm)?.[1] ?? "kvm";
    add(
      "kvm-permission",
      `orq-agent on ${machineName} can't open /dev/kvm: ${user} isn't in the ${group} group, so Android emulators get no acceleration once ${user} logs out.`,
      group === "root" ? `On ${machineName}: give the ${user} account read-write access to /dev/kvm (a udev rule), then restart it.` : `On ${machineName}: sudo usermod -aG ${group} ${user}, then restart ${machineName}.`
    );
  }

  const unprotected: string[] = [];
  const fixes: string[] = [];
  if (facts.get("oom.tailscaled") === "missing") {
    unprotected.push("tailscaled");
    fixes.push("sudo systemctl edit tailscaled (add [Service] OOMScoreAdjust=-900)");
  }
  if (facts.get("oom.sshd") === "missing") {
    unprotected.push("sshd");
    fixes.push("sudo systemctl edit ssh (add [Service] OOMScoreAdjust=-900; its login sessions inherit it)");
  }
  const agent = facts.get("oom.orq-agent");
  if (agent === "missing") {
    unprotected.push("orq-agent");
    fixes.push(noSudo ? `allow passwordless sudo for ${user} and pair again (orq-agent's protection is set up by pairing)` : "pair again (orq-agent's protection is set up by pairing)");
  } else if (agent === "unsupported") {
    unprotected.push("orq-agent");
    fixes.push("upgrade to systemd 250 or later (a user service can't be protected before that), then pair again");
  }
  if (unprotected.length > 0) {
    add(
      "oom-protection-missing",
      `${unprotected.join(", ")} on ${machineName} ${unprotected.length === 1 ? "isn't" : "aren't"} protected from the kernel's OOM killer, so running out of memory can take ${machineName} off the network.`,
      `On ${machineName}: ${fixes.join("; ")}.`
    );
  }

  const devtools = facts.get("devtools");
  if (devtools === "off") {
    add("devtools-security-off", `Developer mode is off on ${machineName}, so simulators and debugging ask for an administrator password.`, `On ${machineName}: sudo DevToolsSecurity -enable`);
  }
  const xcode = facts.get("xcode");
  if (xcode === "cli") {
    add("xcode-path", `xcode-select on ${machineName} points at the Command Line Tools, not Xcode, so iOS simulators aren't available.`, `On ${machineName}: sudo xcode-select -s /Applications/Xcode.app`);
  } else if (xcode === "none") {
    add("xcode-path", `Xcode isn't installed on ${machineName}, so it can't run iOS simulators.`, `Install Xcode from the App Store on ${machineName}, open it once, then run sudo xcode-select -s /Applications/Xcode.app`);
  }

  if (noSudo && problems.length > 0) {
    problems.unshift({
      code: "sudo-unavailable",
      machineId,
      message: `sudo on ${machineName} asks ${user} for a password, so Orquester couldn't fix these itself (it never prompts).`,
      fix: `Run the fixes below on ${machineName}, or allow passwordless sudo for ${user} and pair again.`
    });
  }
  return { sudo, problems, probedAt };
}

/** Secrets that must never leave in a message, even from our own script's output. */
const SECRET_LIKE = /tskey-[A-Za-z0-9-]+|obt_[A-Za-z0-9._~+/=-]+|Bearer\s+\S+/g;

/**
 * The bootstrap's own last error (`orq-bootstrap: error: …`, fixed text written by the script)
 * for a `pair-bootstrap-failed` message; null when it printed none. Anything token-like is masked.
 */
export function bootstrapErrorLine(output: string): string | null {
  const lines = output.split(/\r?\n/).filter((line) => line.startsWith("orq-bootstrap: error: "));
  const last = lines.at(-1);
  if (!last) return null;
  return last
    .slice("orq-bootstrap: error: ".length)
    .replace(SECRET_LIKE, "[hidden]")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .slice(0, 200);
}
