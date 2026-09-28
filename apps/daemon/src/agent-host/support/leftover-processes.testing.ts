import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import type { TestContext } from "node:test";

interface KernelProcess {
  environ: string;
  starttime: number;
  sid: number;
  ppid?: number;
  diesOn?: NodeJS.Signals;
  zombie?: boolean;
}

/** Raw Linux kernel files and signals; never implements selection or sweep policy. */
export function mockProc(t: TestContext, initial: Record<number, KernelProcess>) {
  const table = new Map(Object.entries(initial).map(([pid, row]) => [Number(pid), row]));
  const signals: Array<[number, NodeJS.Signals]> = [];
  const reads: string[] = [];
  const hooks: { environ?: (pid: number) => void; signal?: (pid: number, signal: NodeJS.Signals) => void } = {};
  const readFile = fs.readFile;
  const readdir = fs.readdir;
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...platform, value: "linux" });
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    Object.defineProperty(process, "platform", platform);
  });
  const missing = () => { throw Object.assign(new Error("process vanished"), { code: "ENOENT" }); };
  t.mock.method(fs, "readdir", (async (file: Parameters<typeof fs.readdir>[0], ...args: unknown[]) => {
    const path = String(file);
    if (!path.startsWith("/proc")) return Reflect.apply(readdir, fs, [file, ...args]);
    reads.push(path);
    if (path === "/proc") return [...table.keys()].map(String);
    const pid = Number(/^\/proc\/(\d+)\/task$/.exec(path)?.[1]);
    return table.has(pid) ? [String(pid)] : missing();
  }) as typeof fs.readdir);
  t.mock.method(fs, "readFile", (async (file: Parameters<typeof fs.readFile>[0], ...args: unknown[]) => {
    const path = String(file);
    if (!path.startsWith("/proc/")) return Reflect.apply(readFile, fs, [file, ...args]);
    reads.push(path);
    const pid = Number(path.split("/")[2]);
    const row = table.get(pid);
    if (!row) return missing();
    if (path.endsWith("/environ")) {
      const bytes = row.environ;
      hooks.environ?.(pid);
      return bytes;
    }
    if (path.endsWith("/stat")) {
      // Linux proc_pid_stat(5): state/ppid/pgrp/session are fields 3–6; starttime is field 22.
      const fields = Array<string>(20).fill("0");
      fields[0] = row.zombie ? "Z" : "S";
      fields[1] = String(row.ppid ?? 1);
      fields[2] = String(pid);
      fields[3] = String(row.sid);
      fields[19] = String(row.starttime);
      return `${pid} (provider (child)) ${fields.join(" ")}\n`;
    }
    if (path.endsWith("/children")) {
      return [...table].filter(([, child]) => child.ppid === pid).map(([child]) => child).join(" ");
    }
    return missing();
  }) as typeof fs.readFile);
  t.mock.method(process, "kill", (pid: number, signal: string | number = "SIGTERM") => {
    const named = signal as NodeJS.Signals;
    signals.push([pid, named]);
    hooks.signal?.(pid, named);
    const row = table.get(pid);
    if (!row) return missing();
    if (named === "SIGKILL" || row.diesOn === named) table.delete(pid);
    return true;
  });
  syncBuiltinESMExports();
  return { table, signals, reads, hooks };
}

/** Drain promise continuations after a native timer tick or a mocked OS reply. */
export const drain = () => new Promise<void>((resolve) => setImmediate(resolve));
