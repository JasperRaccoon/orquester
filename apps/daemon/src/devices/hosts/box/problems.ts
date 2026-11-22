/**
 * Environment problems of the owner's own device hosts that are not their probe's Linux findings
 * (`android-remote.ts` `androidProbeProblems`): a machine that is asleep or offline, and a Mac's
 * Xcode path and developer mode (tailnet machines spec §4.4.8, §4.10). Each names the machine and
 * the exact fix; never raw command output.
 */

import type { MachineProblem } from "@orquester/api";

/** The machine paired as ready but its orq-agent is not connected: asleep, off, or orq-agent stopped. */
export function unreachableProblem(machine: string, os: "linux" | "macos"): MachineProblem {
  return os === "macos"
    ? {
        code: "machine-asleep",
        message: `${machine} is asleep or offline, so its simulators can't be used.`,
        fix: "Wake the Mac (open its lid). With the lid closed it sleeps unless it has power and an external display (clamshell mode); after a restart FileVault needs it unlocked once at the Mac."
      }
    : {
        code: "machine-asleep",
        message: `${machine} is asleep or offline, so its emulators can't be used.`,
        fix: `Wake ${machine} (or turn it on), and check that orq-agent runs there; its devices come back when it reconnects.`
      };
}

/** What the Mac probe reads for the problems below (`remote.ts` `RemoteProbe`). */
export interface MacEnvironment {
  /** `xcode-select -p`; null when unknown. */
  xcodePath: string | null;
  /** `DevToolsSecurity -status` says enabled; null when unknown. */
  devTools: boolean | null;
}

/** The Xcode command-line path must be a full Xcode (simctl lives there), and developer mode on (simulators and agent-device's runner need it without prompts). */
export function macProblems(env: MacEnvironment, machine: string): MachineProblem[] {
  const problems: MachineProblem[] = [];
  if (env.xcodePath !== null && !/\.app\/Contents\/Developer\/?$/.test(env.xcodePath)) {
    problems.push({
      code: "xcode-path",
      message: `${machine}'s command-line developer tools point at ${env.xcodePath}, not at Xcode, so iOS simulators can't run.`,
      fix: "sudo xcode-select -s /Applications/Xcode.app/Contents/Developer"
    });
  }
  if (env.devTools === false) {
    problems.push({ code: "devtools-security-off", message: `Developer mode is off on ${machine}: simulators and their test runner ask for a password there.`, fix: "sudo DevToolsSecurity -enable" });
  }
  return problems;
}
