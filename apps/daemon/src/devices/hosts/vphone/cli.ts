/**
 * `vphone-cli` on a bring-your-own Mac, over the box link (`BoxConnection.exec`, never a shell,
 * never SSH). Only the commands the research host needs, with their `--json` outputs parsed
 * tolerantly (the CLI is third-party and drifts):
 *
 * - `vm list --json` → `[{name, restoreInfo: {ios: {version, build}}, template, udid, …}]`
 * - `vm template list --json` → `{templates: [{id, stale, key: {summary}, machines}], building, damaged}`
 * - `vm create <name> --template <id> --skip-first-boot` — a clone of a frozen template with a new
 *   identity (`vm clone` cannot reach templates: they live outside the machine names)
 * - `vm clone <base> <name> --new-identity` — a clone of a stopped base machine
 * - `vm launch <name> --headless --api-listen 127.0.0.1:0` — detached; `VPHONE_API_TOKEN` in its env
 * - `vm stop <name>`, `vm delete <name> --force`, `host preflight`
 * - `vm create <name> --iphone-source … --cloudos-source … --skip-first-boot` — builds the template
 *   (needs root), with `=== Stage ===` banners on its output
 *
 * When only `vphone-launchpad-cli` is installed, every command runs as `vphone-launchpad-cli exec …`.
 */

import { isVphoneSource } from "@orquester/config";

import { DeviceError } from "../../errors.ts";
import type { DeviceCommandResult } from "../../host.ts";
import type { BoxConnection } from "../../../boxes/contracts.ts";

export type VphoneBoxLink = Pick<BoxConnection, "exec">;

/** How to run vphone-cli on the Mac. */
export interface VphoneCliLocation {
  /** The executable. */
  command: string;
  /** Arguments before vphone-cli's own (`["exec"]` for vphone-launchpad-cli). */
  prefix: string[];
}

export interface RunOptions {
  env?: Record<string, string>;
  signal?: AbortSignal;
  /** Default 2 minutes. */
  timeoutMs?: number;
  /** Each output line (stdout and stderr), as it arrives. */
  onLine?: (line: string) => void;
}

const OUTPUT_LIMIT = 4 * 1024 * 1024;

/** Run one program in the box, without a shell; never rejects for a nonzero exit. */
export function runInBox(link: VphoneBoxLink, command: string, args: readonly string[], options: RunOptions = {}): Promise<DeviceCommandResult> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new Error("cancelled"));
      return;
    }
    let child;
    try {
      child = link.exec({ command, args: [...args], ...(options.env ? { env: options.env } : {}) });
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let size = 0;
    const lines = options.onLine ? lineSplitter(options.onLine) : null;
    const collect = (into: Buffer[]) => (chunk: Buffer) => {
      if (size < OUTPUT_LIMIT) {
        into.push(chunk);
        size += chunk.length;
      }
      lines?.push(chunk);
    };
    child.stdout.on("data", collect(out));
    child.stderr.on("data", collect(err));
    let settled = false;
    const finish = (error: Error | null, exitCode = -1) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      lines?.flush();
      if (error) reject(error);
      else resolve({ exitCode, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") });
    };
    const onAbort = () => {
      child.kill("SIGTERM");
      finish(new Error("cancelled"));
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(new Error(`${command} ${args.slice(0, 3).join(" ")} did not finish in time`));
    }, options.timeoutMs ?? 120_000);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", (error) => finish(error));
    child.on("exit", (code) => finish(null, code ?? -1));
  });
}

/** Feed byte chunks, get whole lines (without `\r`). */
export function lineSplitter(onLine: (line: string) => void): { push(chunk: Buffer): void; flush(): void } {
  let pending = "";
  return {
    push(chunk) {
      pending += chunk.toString("utf8");
      let at: number;
      while ((at = pending.search(/\r?\n|\r/)) !== -1) {
        const line = pending.slice(0, at);
        pending = pending.slice(at + (pending[at] === "\r" && pending[at + 1] === "\n" ? 2 : 1));
        if (line.trim()) onLine(line);
      }
      if (pending.length > 64 * 1024) {
        onLine(pending);
        pending = "";
      }
    },
    flush() {
      if (pending.trim()) onLine(pending);
      pending = "";
    }
  };
}

/** A machine in `vm list --json`. */
export interface VphoneMachine {
  name: string;
  iosVersion: string | null;
  template: string | null;
  udid: string | null;
}

/** A frozen template in `vm template list --json`. */
export interface VphoneTemplate {
  id: string;
  summary: string;
  stale: boolean;
}

const rec = (value: unknown): Record<string, unknown> | null => (value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null);
const text = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);

/** The JSON document in a command's stdout (the last line that parses, if progress preceded it). */
export function parseJsonOutput(stdout: string): unknown {
  const trimmed = stdout.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // Some builds print notes before the document: take the first line that opens one.
    const start = trimmed.search(/^[[{]/m);
    if (start > 0) {
      try {
        return JSON.parse(trimmed.slice(start));
      } catch {
        return null;
      }
    }
    return null;
  }
}

export function parseMachine(value: unknown): VphoneMachine | null {
  const record = rec(value);
  const name = text(record?.name);
  if (!record || !name) return null;
  const ios = rec(rec(record.restoreInfo)?.ios);
  return { name, iosVersion: text(ios?.version), template: text(record.template), udid: text(record.udid) };
}

export function parseMachineList(stdout: string): VphoneMachine[] {
  const parsed = parseJsonOutput(stdout);
  const list = Array.isArray(parsed) ? parsed : Array.isArray(rec(parsed)?.machines) ? (rec(parsed)!.machines as unknown[]) : [];
  return list.map(parseMachine).filter((machine): machine is VphoneMachine => machine !== null);
}

export function parseTemplateList(stdout: string): VphoneTemplate[] {
  const parsed = parseJsonOutput(stdout);
  const list = Array.isArray(parsed) ? parsed : Array.isArray(rec(parsed)?.templates) ? (rec(parsed)!.templates as unknown[]) : [];
  const out: VphoneTemplate[] = [];
  for (const entry of list) {
    const record = rec(entry);
    const id = text(record?.id);
    if (!record || !id) continue;
    out.push({ id, summary: text(rec(record.key)?.summary) ?? id, stale: record.stale === true });
  }
  return out;
}

/** The address `vm launch --api-listen 127.0.0.1:0` reports: `[api] HTTP/WebSocket API: http://127.0.0.1:8765`. */
export function parseApiListenPort(line: string): number | null {
  const match = /\[api\][^\n]*?https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):(\d{1,5})\b/i.exec(line);
  if (!match) return null;
  const port = Number(match[1]);
  return port > 0 && port < 65536 ? port : null;
}

/**
 * A stage banner (`=== CFW install (host-mount) ===`), as vphone-cli prints them between the
 * stages of a long command; null for any other line. Tolerant of drift: any run of `=` around text.
 */
export function parseStageBanner(line: string): string | null {
  const match = /^\s*={2,}\s*(.+?)\s*={2,}\s*$/.exec(line);
  return match ? match[1]! : null;
}

/** The stages `vm create` announces, in order (from vphone-ws's mapping), to turn banners into a percentage. */
export const CREATE_STAGES: readonly { banner: RegExp; label: string }[] = [
  { banner: /template|find/i, label: "Finding a template" },
  { banner: /prepare/i, label: "Preparing firmware" },
  { banner: /patch/i, label: "Patching firmware" },
  { banner: /restore/i, label: "Restoring iOS" },
  { banner: /cfw|install/i, label: "Installing the guest environment" },
  { banner: /trim|setup|slim/i, label: "Setting up the template" },
  { banner: /first boot|boot/i, label: "First boot" }
];

/** A banner's stage index in {@link CREATE_STAGES}, or -1 for one this build does not know. */
export function createStageIndex(banner: string): number {
  return CREATE_STAGES.findIndex((stage) => stage.banner.test(banner));
}

/** vphone-cli, with the box link and where it lives. */
export class VphoneCli {
  constructor(
    private readonly link: VphoneBoxLink,
    readonly location: VphoneCliLocation
  ) {}

  run(args: readonly string[], options: RunOptions = {}): Promise<DeviceCommandResult> {
    return runInBox(this.link, this.location.command, [...this.location.prefix, ...args], options);
  }

  /** The argv of a command (for detached launches). */
  argv(args: readonly string[]): { command: string; args: string[] } {
    return { command: this.location.command, args: [...this.location.prefix, ...args] };
  }

  async listMachines(signal?: AbortSignal): Promise<VphoneMachine[]> {
    const result = await this.run(["vm", "list", "--json"], { ...(signal ? { signal } : {}), timeoutMs: 60_000 });
    if (result.exitCode !== 0) throw new Error(`vphone-cli vm list failed: ${lastLine(result)}`);
    return parseMachineList(result.stdout);
  }

  async machineInfo(name: string, signal?: AbortSignal): Promise<VphoneMachine | null> {
    const result = await this.run(["vm", "info", name, "--json"], { ...(signal ? { signal } : {}), timeoutMs: 60_000 });
    if (result.exitCode !== 0) return null;
    return parseMachine(parseJsonOutput(result.stdout));
  }

  async listTemplates(signal?: AbortSignal): Promise<VphoneTemplate[]> {
    const result = await this.run(["vm", "template", "list", "--json"], { ...(signal ? { signal } : {}), timeoutMs: 60_000 });
    if (result.exitCode !== 0) return [];
    return parseTemplateList(result.stdout);
  }

  /** Clone `name` from a frozen template: a new identity, no IPSWs, seconds on APFS. */
  createFromTemplate(name: string, templateId: string, options: RunOptions = {}): Promise<DeviceCommandResult> {
    return this.run(["vm", "create", name, "--template", templateId, "--skip-first-boot"], { timeoutMs: 10 * 60_000, ...options });
  }

  /** Clone `name` from a stopped base machine with a new identity. */
  cloneMachine(base: string, name: string, options: RunOptions = {}): Promise<DeviceCommandResult> {
    return this.run(["vm", "clone", base, name, "--new-identity"], { timeoutMs: 10 * 60_000, ...options });
  }

  /** `vm launch` argv: headless, the API on an OS-chosen loopback port (printed once listening). */
  launchArgs(name: string): string[] {
    return ["vm", "launch", name, "--headless", "--api-listen", "127.0.0.1:0"];
  }

  stop(name: string, options: RunOptions = {}): Promise<DeviceCommandResult> {
    return this.run(["vm", "stop", name], { timeoutMs: 90_000, ...options });
  }

  delete(name: string, options: RunOptions = {}): Promise<DeviceCommandResult> {
    return this.run(["vm", "delete", name, "--force"], { timeoutMs: 120_000, ...options });
  }

  preflight(signal?: AbortSignal): Promise<DeviceCommandResult> {
    return this.run(["host", "preflight"], { ...(signal ? { signal } : {}), timeoutMs: 60_000 });
  }

  /**
   * Build a template (and the machine `name` cloned from it) from two IPSWs. Needs root on the Mac.
   * Each source must be an absolute path or an https:// URL ({@link isVphoneSource}; the settings
   * check it too): nothing that `sudo -n vphone-cli` could read as an option.
   */
  createTemplateArgs(name: string, iphoneSource: string, cloudosSource: string): string[] {
    for (const [label, source] of [["iPhone", iphoneSource], ["cloudOS", cloudosSource]] as const) {
      if (!isVphoneSource(source)) throw new DeviceError("INVALID_ARGUMENT", `The ${label} IPSW source must be an absolute path on the Mac or an https:// URL.`);
    }
    return ["vm", "create", name, "--iphone-source", iphoneSource, "--cloudos-source", cloudosSource, "--skip-first-boot"];
  }
}

/** The last meaningful output line of a failed command (no secrets: vphone-cli never prints ours). */
export function lastLine(result: DeviceCommandResult): string {
  const lines = `${result.stderr}\n${result.stdout}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines[lines.length - 1]?.slice(0, 300) ?? `exit ${result.exitCode}`;
}

/** A lease's machine: `orq-<leaseId>` (letters, digits and dashes). */
export function machineNameForLease(leaseId: string): string {
  return `orq-${leaseId.replace(/[^A-Za-z0-9-]/g, "").slice(0, 48)}`;
}

/** The base machine `vm clone` uses when no template exists. */
export const VPHONE_BASE_MACHINE = "orq-base";
