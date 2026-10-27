/**
 * A local integration box with an isolated device filesystem. Production sees its ordinary
 * remote paths; only this BoxConnection boundary maps them into an existing throwaway root.
 */
import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { Transform } from "node:stream";

import type { BoxExecOptions, BoxProcess } from "../../../boxes/contracts.ts";
import { BOX_DEVICES_DIR } from "../../../boxes/github/device-cache.ts";
import { localBoxConnection, type LocalBoxConnection } from "../../../boxes/testing.ts";

export function isolatedDeviceBox(input: { root: string; boxId: string; provider: "blacksmith" | "byo" }): LocalBoxConnection {
  const root = realpathSync(input.root);
  if (!/^[A-Za-z0-9_./-]+$/.test(root) || ![realpathSync(tmpdir()), "/var/lib/orquester/tmp"].some((base) => root.startsWith(`${base}${sep}`))) {
    throw new Error("A local device box needs a separate throwaway directory under the temporary root");
  }
  const isolatedEnv = {
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
    LANG: "C.UTF-8",
    HOME: join(root, "home"),
    TMPDIR: join(root, "tmp"),
    npm_config_cache: join(root, "cache", "npm")
  };
  const connection = localBoxConnection({ boxId: input.boxId });
  const ownRoot = join(connection.sys.home, ".orquester", "devices");
  const virtualRoot = input.provider === "byo" ? ownRoot : BOX_DEVICES_DIR;
  const aliases = [BOX_DEVICES_DIR, ownRoot].map((path) => new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?![A-Za-z0-9_.-])", "g"));
  const local = (value: string) => aliases.reduce((text, alias) => text.replace(alias, root), value);
  const remote = (value: string) => value.replaceAll(root, virtualRoot);
  const safe = (value: unknown): void => {
    const text = JSON.stringify(value).replaceAll(root, "<isolated-root>");
    if (text.includes("/var/lib/orquester") || text.includes(ownRoot) || JSON.stringify(value).includes(`${root}/..`)) {
      throw new Error("Refusing a local device operation outside its isolated filesystem namespace");
    }
  };
  const map = <T>(value: T, text: (value: string) => string): T => {
    if (typeof value === "string") return text(value) as T;
    if (Array.isArray(value)) return value.map((item) => map(item, text)) as T;
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, map(item, text)])) as T;
    return value;
  };
  // Preserve byte streams, including NUL-separated /proc data. Keep a possible path prefix
  // across chunks; replacing only complete chunks can break process-identity checks.
  const output = (): Transform => {
    const needle = Buffer.from(root);
    const replacement = Buffer.from(virtualRoot);
    let carry = Buffer.alloc(0);
    return new Transform({
      transform(chunk: Buffer, _encoding, done) {
        const bytes = Buffer.concat([carry, chunk]);
        const limit = Math.max(0, bytes.length - needle.length + 1);
        let cursor = 0;
        for (let at = bytes.indexOf(needle); at >= 0 && at < limit; at = bytes.indexOf(needle, cursor)) {
          this.push(bytes.subarray(cursor, at));
          this.push(replacement);
          cursor = at + needle.length;
        }
        const end = Math.max(cursor, limit);
        this.push(bytes.subarray(cursor, end));
        carry = bytes.subarray(end);
        done();
      },
      flush(done) { this.push(carry); done(); }
    });
  };
  const target = (path: string): string => {
    const mapped = resolve(local(path));
    if (mapped !== root && !mapped.startsWith(`${root}${sep}`)) throw new Error("Device files must stay in the isolated root");
    let existing = mapped;
    for (;;) {
      try { lstatSync(existing); break; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; existing = dirname(existing); }
    }
    const canonical = realpathSync(existing);
    if (canonical !== root && !canonical.startsWith(`${root}${sep}`)) throw new Error("Device file symlinks must stay in the isolated root");
    return mapped;
  };
  for (const path of [isolatedEnv.HOME, isolatedEnv.TMPDIR, isolatedEnv.npm_config_cache]) mkdirSync(target(path), { recursive: true, mode: 0o700 });
  const exec = connection.exec.bind(connection);
  connection.exec = (options: BoxExecOptions): BoxProcess => {
    const env = { ...isolatedEnv, ...Object.fromEntries(Object.entries(options.env ?? {}).map(([key, value]) => [key, local(value)])) };
    const envUnset = [...new Set([...Object.keys(process.env).filter((key) => !Object.hasOwn(env, key)), ...(options.envUnset ?? [])])];
    const mapped = { ...options, command: local(options.command), args: options.args?.map(local), cwd: target(options.cwd ?? root), env, envUnset };
    safe(mapped);
    const child = exec(mapped);
    const stdout = output();
    const stderr = output();
    child.stdout.once("error", (error) => stdout.destroy(error));
    child.stderr.once("error", (error) => stderr.destroy(error));
    child.stdout.pipe(stdout);
    child.stderr.pipe(stderr);
    return new Proxy(child, { get(object, key) { if (key === "stdout") return stdout; if (key === "stderr") return stderr; const value = Reflect.get(object, key, object); return typeof value === "function" ? value.bind(object) : value; } });
  };
  const request = connection.request.bind(connection);
  connection.request = (async (method, params, options) => {
    const mapped = map(params, local);
    safe(mapped);
    if (method.startsWith("fs.")) for (const key of ["path", "from", "to", "target"]) { const path = (mapped as Record<string, unknown>)[key]; if (typeof path === "string") (mapped as Record<string, unknown>)[key] = target(path); }
    return map(await request(method, mapped, options), remote);
  }) as LocalBoxConnection["request"];
  const readFile = connection.readFile.bind(connection);
  connection.readFile = async (path, options) => {
    const source = await readFile(target(path), options);
    const translated = output();
    source.once("error", (error) => translated.destroy(error));
    return source.pipe(translated);
  };
  const writeFile = connection.writeFile.bind(connection);
  connection.writeFile = (path, data, options) => writeFile(target(path), typeof data === "string" ? local(data) : data, options);
  // These integrations never need extraction or a raw channel around the namespace checks.
  connection.readTar = async () => { throw new Error("No tar reads in an isolated device box"); };
  connection.writeTar = async () => { throw new Error("No tar writes in an isolated device box"); };
  connection.requestRaw = async () => { throw new Error("No untyped operations in an isolated device box"); };
  connection.openChannel = async () => { throw new Error("No raw channels in an isolated device box"); };
  return connection;
}
