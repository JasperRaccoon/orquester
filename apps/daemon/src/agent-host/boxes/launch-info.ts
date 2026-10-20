/**
 * Agent host — the box a thread's CLI runs in (spec 2026-10-19 §8.5): the
 * field-wise validation of {@link HostThreadBox} as it arrives on a create,
 * fork or identity request and as `launch.json` keeps it, plus the path
 * mapping every box launch goes through.
 *
 * Pure: the orchestrator's launch-config store and the daemon's tests import
 * it without loading anything that talks to a box.
 */

import { BOX_WINDOWS_PATH_PREFIX, hostToBoxPath, type BoxPathMap, type BoxSysInfo } from "@orquester/api";

import type { SessionToolingContribution } from "../../boxes/contracts.ts";
import type { HostThreadBox } from "../host-protocol.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0) : [];
}

function stringRecord(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isRecord(value)) return out;
  for (const [key, entry] of Object.entries(value)) {
    if (key.length > 0 && typeof entry === "string") out[key] = entry;
  }
  return out;
}

/** A {@link BoxPathMap}, or undefined for anything else (a newer build's kind is not guessed at). */
export function parseBoxPathMap(value: unknown): BoxPathMap | undefined {
  if (!isRecord(value)) return undefined;
  if (value.kind === "identity") return { kind: "identity" };
  if (value.kind === "windows-prefix") {
    const prefix = typeof value.prefix === "string" && value.prefix.length > 0 ? value.prefix : BOX_WINDOWS_PATH_PREFIX;
    return { kind: "windows-prefix", prefix };
  }
  return undefined;
}

/**
 * {@link BoxSysInfo}, field-wise: the fields a launch reads must be there
 * (`os`, `arch`, `agentPath`, `home`), the rest default. Unknown fields are
 * dropped — this is the host's own copy, not a tolerant store of somebody
 * else's records.
 */
function parseBoxSysInfo(value: unknown): BoxSysInfo | undefined {
  if (!isRecord(value)) return undefined;
  const os = value.os;
  const arch = value.arch;
  if ((os !== "linux" && os !== "darwin" && os !== "win32") || (arch !== "x64" && arch !== "arm64")) return undefined;
  if (typeof value.agentPath !== "string" || value.agentPath.length === 0) return undefined;
  if (typeof value.home !== "string" || value.home.length === 0) return undefined;
  const text = (key: string, fallback = ""): string => (typeof value[key] === "string" ? (value[key] as string) : fallback);
  const flag = (key: string): boolean => value[key] === true;
  const count = (key: string): number => (typeof value[key] === "number" && Number.isFinite(value[key]) ? (value[key] as number) : 0);
  return {
    os,
    arch,
    libc: value.libc === "glibc" || value.libc === "musl" ? value.libc : null,
    hostname: text("hostname"),
    osRelease: text("osRelease"),
    user: text("user"),
    isRoot: flag("isRoot"),
    canElevate: flag("canElevate"),
    home: value.home,
    shell: text("shell", os === "win32" ? "powershell.exe" : "/bin/sh"),
    tmux: flag("tmux"),
    docker: flag("docker"),
    cpus: count("cpus"),
    memBytes: count("memBytes"),
    gpus: stringList(value.gpus),
    agentPath: value.agentPath,
    dataDir: text("dataDir"),
    container: flag("container")
  };
}

function parseTooling(value: unknown): SessionToolingContribution {
  if (!isRecord(value)) return { pathPrepend: [], env: {}, nodeRequire: [] };
  return {
    pathPrepend: stringList(value.pathPrepend),
    env: stringRecord(value.env),
    nodeRequire: stringList(value.nodeRequire)
  };
}

/**
 * A {@link HostThreadBox}, or undefined when the value is not one. Used for the
 * requests that carry one and for `launch.json`; a box field that does not
 * read is reported by the caller (a box thread must never quietly run on this
 * machine instead).
 */
export function parseHostThreadBox(value: unknown): HostThreadBox | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.boxId !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(value.boxId)) return undefined;
  if (typeof value.socketPath !== "string" || value.socketPath.length === 0) return undefined;
  const sys = parseBoxSysInfo(value.sys);
  const paths = parseBoxPathMap(value.paths);
  if (sys === undefined || paths === undefined) return undefined;
  return { boxId: value.boxId, socketPath: value.socketPath, sys, paths, tooling: parseTooling(value.tooling) };
}

/** The path separator and PATH delimiter of a box's OS. */
export function boxPathSyntax(os: BoxSysInfo["os"]): { sep: "/" | "\\"; delimiter: ":" | ";" } {
  return os === "win32" ? { sep: "\\", delimiter: ";" } : { sep: "/", delimiter: ":" };
}

/** Join box path segments with the box's own separator (no normalisation beyond that). */
export function joinBoxPath(os: BoxSysInfo["os"], base: string, ...segments: string[]): string {
  const { sep } = boxPathSyntax(os);
  const trimmed = base.replace(/[\\/]+$/, "");
  return [trimmed, ...segments.map((segment) => segment.replace(/^[\\/]+|[\\/]+$/g, ""))].filter((part) => part.length > 0).join(sep);
}

/**
 * Map a host path into the box (`hostToBoxPath`, identity on POSIX boxes).
 * A value that is not an absolute POSIX path is returned unchanged — env
 * values and arguments are passed through this, and only paths move.
 */
export function mapHostValue(paths: BoxPathMap, value: string): string {
  if (!value.startsWith("/") || value.includes("\n")) return value;
  // A PATH-like list of absolute paths maps entry by entry.
  if (value.includes(":") && value.split(":").every((part) => part.startsWith("/"))) {
    if (paths.kind === "identity") return value;
    return value
      .split(":")
      .map((part) => hostToBoxPath(paths, part))
      .join(";");
  }
  return hostToBoxPath(paths, value);
}
