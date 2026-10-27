/**
 * What a Mac needs before it can run vphone research VMs, probed over the box link (the checks
 * mirror vphone-ws's `HostReadiness` and vphone-cli's host-setup guide). Each check that fails says
 * in plain English what is wrong and gives the exact command that fixes it; Orquester never
 * changes SIP, AMFI or boot-args itself. Only the template can be built for the owner (the
 * `vphone-template` setup action), from the IPSWs set in Settings, when the agent may use sudo.
 *
 * The evaluators are pure (tested against captured command outputs); {@link probeVphoneHost}
 * gathers those outputs.
 */

import type { DeviceReadinessCheck } from "@orquester/api";

import {
  lastLine,
  runInBox,
  VPHONE_BASE_MACHINE,
  VphoneCli,
  type VphoneBoxLink,
  type VphoneCliLocation,
  type VphoneMachine,
  type VphoneTemplate
} from "./cli.ts";

/** The setup action that builds the template. */
export const VPHONE_TEMPLATE_ACTION = "vphone-template";

/** Where vphone-cli may be (besides `$VPHONE_CLI_PATH` and PATH). */
const VPHONE_CLI_CANDIDATES = ["/opt/homebrew/bin/vphone-cli", "/usr/local/bin/vphone-cli"];
const VPHONE_LAUNCHPAD_CANDIDATES = [
  "/opt/homebrew/bin/vphone-launchpad-cli",
  "/usr/local/bin/vphone-launchpad-cli",
  "/Applications/vphone-launchpad.app/Contents/MacOS/vphone-launchpad-cli"
];

/** Everything the checks read, as captured from the Mac. */
export interface VphoneProbe {
  /** vphone-cli (or vphone-launchpad-cli) as found; null: neither. */
  cli: VphoneCliLocation | null;
  /** `sw_vers -productVersion`. */
  macosVersion: string;
  /** `sysctl -n kern.hv_vmm_present`. */
  hvVmmPresent: string;
  /** `csrutil allow-research-guests status`. */
  researchGuests: string;
  /** `nvram boot-args`. */
  bootArgs: string;
  /** `ps -ax -o command=`. */
  processes: string;
  /** `vphone-cli host preflight`; null when not run. */
  preflight: { exitCode: number; lastLine: string } | null;
  templates: VphoneTemplate[];
  machines: VphoneMachine[];
}

export interface VphoneReadinessContext {
  /** Both IPSW sources are set for this machine in Settings. */
  sourcesSet: boolean;
  /** The box agent runs as root or has passwordless sudo (building a template needs root). */
  canElevate: boolean;
}

/** Pick vphone-cli: `$VPHONE_CLI_PATH`, PATH, the Homebrew prefixes; else vphone-launchpad-cli (`exec`). */
function locateVphoneCli(found: { envPath: string | null; whichCli: string | null; whichLaunchpad: string | null; executable: ReadonlySet<string> }): VphoneCliLocation | null {
  const cli = [found.envPath, found.whichCli, ...VPHONE_CLI_CANDIDATES].find((path): path is string => !!path && found.executable.has(path));
  if (cli) return { command: cli, prefix: [] };
  const launchpad = [found.whichLaunchpad, ...VPHONE_LAUNCHPAD_CANDIDATES].find((path): path is string => !!path && found.executable.has(path));
  return launchpad ? { command: launchpad, prefix: ["exec"] } : null;
}

function checkCli(cli: VphoneCliLocation | null): DeviceReadinessCheck {
  if (cli) {
    return { id: "vphone-cli", label: "vphone-cli", state: "ok", detail: cli.prefix.length > 0 ? `${cli.command} (through Launchpad)` : cli.command };
  }
  return {
    id: "vphone-cli",
    label: "vphone-cli",
    state: "missing",
    detail:
      "vphone-cli is not on PATH, in /opt/homebrew/bin or /usr/local/bin, or at $VPHONE_CLI_PATH. Install vphone Launchpad, then run: " +
      "ln -s /Applications/vphone-launchpad.app/Contents/MacOS/vphone-launchpad-cli /opt/homebrew/bin/ " +
      "(or set VPHONE_CLI_PATH to vphone-cli's full path for the Orquester agent)."
  };
}

function checkMacos(version: string): DeviceReadinessCheck {
  const trimmed = version.trim();
  const major = Number.parseInt(trimmed.split(".")[0] ?? "", 10);
  if (Number.isFinite(major) && major >= 15) return { id: "macos", label: "macOS 15 or newer", state: "ok", detail: `macOS ${trimmed}` };
  return {
    id: "macos",
    label: "macOS 15 or newer",
    state: Number.isFinite(major) ? "error" : "missing",
    detail: Number.isFinite(major)
      ? `This Mac runs macOS ${trimmed}. Update to macOS 15 or newer in System Settings → General → Software Update.`
      : "Could not read the macOS version (sw_vers -productVersion). Research iPhones need an Apple Silicon Mac on macOS 15 or newer."
  };
}

function checkNotVm(hvVmmPresent: string): DeviceReadinessCheck {
  const value = hvVmmPresent.trim();
  if (value === "0") return { id: "not-vm", label: "A physical Mac (not a VM)", state: "ok", detail: "kern.hv_vmm_present = 0" };
  return {
    id: "not-vm",
    label: "A physical Mac (not a VM)",
    state: "error",
    detail:
      value === "1"
        ? "This Mac is itself a virtual machine (kern.hv_vmm_present = 1): research iPhones cannot boot nested. Use a physical Apple Silicon Mac."
        : "Could not tell whether this Mac is a virtual machine (sysctl -n kern.hv_vmm_present gave no answer). Research iPhones need a physical Apple Silicon Mac."
  };
}

function checkResearchGuests(csrutilOutput: string): DeviceReadinessCheck {
  // `csrutil allow-research-guests status` → "Allow Research Guests status: enabled." / "…: disabled."
  const enabled = /:\s*enabled\b/i.test(csrutilOutput) && !/:\s*disabled\b/i.test(csrutilOutput);
  if (enabled) return { id: "research-guests", label: "Research guests allowed", state: "ok", detail: "csrutil allow-research-guests: enabled" };
  return {
    id: "research-guests",
    label: "Research guests allowed",
    state: "missing",
    detail:
      "macOS does not allow research guests, so vphone VMs won't boot. Restart into macOS Recovery, open Terminal and run: " +
      "csrutil allow-research-guests enable — then restart. Orquester never changes this for you."
  };
}

/** True when `boot-args` carries `key=<v>` with a nonzero value. */
function bootArgIsSet(bootArgs: string, key: string): boolean {
  for (const token of bootArgs.split(/[\s\t\n]+/)) {
    if (!token.startsWith(`${key}=`)) continue;
    const value = token.slice(key.length + 1);
    return value !== "" && value !== "0" && value !== "0x0";
  }
  return false;
}

/** The bundle a vphone-cli path sits in (`…/VPhone.bundle`), for the escalator command. */
function bundleOf(cli: VphoneCliLocation | null): string | null {
  const match = cli && /^(.*)\/Contents\/MacOS\/vphone-cli$/.exec(cli.command);
  return match ? match[1]! : null;
}

function checkAmfi(probe: Pick<VphoneProbe, "processes" | "bootArgs" | "preflight" | "cli">): DeviceReadinessCheck {
  const amfidont = probe.processes.split("\n").some((line) => line.includes("amfidont") && !line.includes("vphone-amfidont"));
  const bootArg = bootArgIsSet(probe.bootArgs, "amfi_get_out_of_my_way");
  const preflightOk = probe.preflight?.exitCode === 0;
  const label = "AMFI lets vphone-vm run";
  if (preflightOk) return { id: "amfi", label, state: "ok", detail: "vphone-cli host preflight passed" };
  if (probe.preflight === null && (bootArg || amfidont)) {
    return { id: "amfi", label, state: "ok", detail: bootArg ? "amfi_get_out_of_my_way=1 is in boot-args" : "amfidont is running" };
  }
  const bundle = bundleOf(probe.cli) ?? "/path/to/VPhone.bundle";
  const preflightNote = probe.preflight ? ` (vphone-cli host preflight: ${probe.preflight.lastLine})` : "";
  return {
    id: "amfi",
    label,
    state: probe.preflight ? "error" : "missing",
    detail:
      `AMFI will stop the signed vphone-vm${preflightNote}. Pick one: start amfidont; or, with SIP debugging relaxed ` +
      `(Recovery: csrutil enable --without debug), run: sudo "${bundle}/Contents/MacOS/vphone-escalator" allow "${bundle}/Contents/MacOS/vphone-vm"; ` +
      `or (Recovery: csrutil disable) add the boot-arg — review the current boot-args first — with: sudo nvram boot-args="amfi_get_out_of_my_way=1" and restart. ` +
      "Orquester never changes SIP or AMFI for you."
  };
}

/** A usable (current) template, else the base machine to `vm clone`. */
export function chooseCloneSource(probe: Pick<VphoneProbe, "templates" | "machines">): { kind: "template"; id: string; summary: string } | { kind: "machine"; name: string } | null {
  const template = probe.templates.find((entry) => !entry.stale);
  if (template) return { kind: "template", id: template.id, summary: template.summary };
  if (probe.machines.some((machine) => machine.name === VPHONE_BASE_MACHINE)) return { kind: "machine", name: VPHONE_BASE_MACHINE };
  return null;
}

function checkTemplate(probe: Pick<VphoneProbe, "templates" | "machines" | "cli">, context: VphoneReadinessContext): DeviceReadinessCheck {
  const label = "A vphone template to clone";
  const source = chooseCloneSource(probe);
  if (source) {
    return { id: "template", label, state: "ok", detail: source.kind === "template" ? `Template ${source.id} (${source.summary})` : `Base machine ${source.name}` };
  }
  const stale = probe.templates.length > 0 ? " The templates on this Mac are stale (built by another vphone-cli series)." : "";
  if (context.sourcesSet && context.canElevate && probe.cli) {
    return {
      id: "template",
      label,
      state: "missing",
      detail: `No template yet.${stale} Orquester can build one from the IPSWs set for this machine (about an hour; it runs vphone-cli with sudo).`,
      fixActionId: VPHONE_TEMPLATE_ACTION
    };
  }
  const why = context.sourcesSet && !context.canElevate ? " Building one needs root, and the Orquester agent on this Mac has no passwordless sudo, so run it yourself:" : " On the Mac run:";
  return {
    id: "template",
    label,
    state: "missing",
    detail:
      `No vphone template yet.${stale}${why} sudo vphone-cli vm create ${VPHONE_BASE_MACHINE} --iphone-source <iPhone17,3 restore IPSW> --cloudos-source <cloudOS IPSW> --skip-first-boot` +
      (context.sourcesSet ? "" : " — or set both IPSW sources for this machine in Settings → Devices and let Orquester build it.")
  };
}

/** Every check, in display order. */
export function evaluateVphoneReadiness(probe: VphoneProbe, context: VphoneReadinessContext): DeviceReadinessCheck[] {
  return [
    checkCli(probe.cli),
    checkMacos(probe.macosVersion),
    checkNotVm(probe.hvVmmPresent),
    checkResearchGuests(probe.researchGuests),
    checkAmfi(probe),
    checkTemplate(probe, context)
  ];
}

/** Gather the probe's outputs from the Mac (each command on its own, no shell; failures read as empty). */
export async function probeVphoneHost(link: VphoneBoxLink, signal?: AbortSignal): Promise<VphoneProbe> {
  const out = async (command: string, args: string[], timeoutMs = 20_000): Promise<{ exitCode: number; text: string }> => {
    try {
      const result = await runInBox(link, command, args, { ...(signal ? { signal } : {}), timeoutMs });
      return { exitCode: result.exitCode, text: `${result.stdout}${result.stderr ? `\n${result.stderr}` : ""}`.trim() };
    } catch {
      return { exitCode: -1, text: "" };
    }
  };
  const firstLine = (value: { exitCode: number; text: string }): string | null => (value.exitCode === 0 ? value.text.split("\n")[0]!.trim() || null : null);

  const [envPath, whichCli, whichLaunchpad, macos, hv, research, bootArgs, processes] = await Promise.all([
    out("/usr/bin/printenv", ["VPHONE_CLI_PATH"]).then(firstLine),
    out("/usr/bin/which", ["vphone-cli"]).then(firstLine),
    out("/usr/bin/which", ["vphone-launchpad-cli"]).then(firstLine),
    out("/usr/bin/sw_vers", ["-productVersion"]),
    out("/usr/sbin/sysctl", ["-n", "kern.hv_vmm_present"]),
    out("/usr/bin/csrutil", ["allow-research-guests", "status"]),
    out("/usr/sbin/nvram", ["boot-args"]),
    out("/bin/ps", ["-ax", "-o", "command="])
  ]);
  const candidates = [...new Set([envPath, whichCli, whichLaunchpad, ...VPHONE_CLI_CANDIDATES, ...VPHONE_LAUNCHPAD_CANDIDATES].filter((path): path is string => !!path))];
  const executable = new Set<string>();
  await Promise.all(
    candidates.map(async (path) => {
      if ((await out("/bin/test", ["-x", path])).exitCode === 0) executable.add(path);
    })
  );
  const cli = locateVphoneCli({ envPath, whichCli, whichLaunchpad, executable });

  let preflight: VphoneProbe["preflight"] = null;
  let templates: VphoneTemplate[] = [];
  let machines: VphoneMachine[] = [];
  if (cli) {
    const vphone = new VphoneCli(link, cli);
    const [checked, foundTemplates, foundMachines] = await Promise.all([
      vphone.preflight(signal).catch(() => null),
      vphone.listTemplates(signal).catch(() => []),
      vphone.listMachines(signal).catch(() => [])
    ]);
    preflight = checked ? { exitCode: checked.exitCode, lastLine: lastLine(checked) } : null;
    templates = foundTemplates;
    machines = foundMachines;
  }
  return {
    cli,
    macosVersion: macos.exitCode === 0 ? macos.text : "",
    hvVmmPresent: hv.exitCode === 0 ? hv.text : "",
    researchGuests: research.text,
    bootArgs: bootArgs.exitCode === 0 ? bootArgs.text : "",
    processes: processes.text,
    preflight,
    templates,
    machines
  };
}
