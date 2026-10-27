// The box tooling provisioner end to end: Better TS Typecheck's plugin over an
// injected `fetch` serving a fake npm registry and real tarballs, the host
// archive cache, and a "box" that is this machine (`localBoxConnection`) with
// its data dir in a temp dir. The box preload it writes is then run under node
// against a fake `typescript` package, to prove the redirect fires and falls
// back safely. A scripted Windows box checks the Windows install path and env.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { access, constants, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { type TestContext, test } from "node:test";

import { type BoxPathMap, type TsCheckerEngine, TS_RUST_PLUGIN_ID, boxPathMapFor } from "@orquester/api";
import { boxToolingArchivePath, boxToolingCacheDir } from "@orquester/config";

import { createTsRustToolingPlugin, type TsRustToolingState } from "../../plugins/ts-rust/box-tooling.ts";
import { NPM_REGISTRY, TS_CHECKER_ENGINE_SPECS } from "../../plugins/ts-rust/installer.ts";
import { type FixtureTarball, makeTsRustTarball, tempRoot } from "../../plugins/testing.ts";
import type { BoxConnection, BoxExecOptions, BoxHub } from "../contracts.ts";
import { type LocalBoxConnection, localBoxConnection, localSysInfo } from "../testing.ts";
import { boxToolingEnv } from "../remote/exec/env.ts";
import { TOOLING_INSTALL_MARKER } from "./install.ts";
import { type BoxToolingProvisionerHandle, createBoxToolingProvisioner } from "./provisioner.ts";

const posix = process.platform !== "win32";
const V1 = "0.16.0-ts7.1.0-dev.20260929";
const V2 = "0.17.0";

/** The stand-in tsrs: answers the smoke test, else echoes its arguments. */
const STUB = `#!/bin/sh
if [ "$1" = "--version" ]; then echo "Version 7.1.0-dev"; exit 0; fi
printf 'tsrs %s\\n' "$*"
exit "\${STUB_EXIT:-0}"
`;

interface Release extends FixtureTarball {
  /** What the registry claims, when it is not the tarball's own integrity. */
  claimed?: string;
}

/** An npm registry over `fetch`: one main package, one platform package, tarballs from `releases`. */
function registryFetch(engine: TsCheckerEngine, platformPackage: string) {
  const spec = TS_CHECKER_ENGINE_SPECS[engine];
  const base = platformPackage.slice(platformPackage.indexOf("/") + 1);
  const tarballUrl = (version: string) => `${NPM_REGISTRY}/${platformPackage}/-/${base}-${version}.tgz`;
  const registry = {
    latest: V1,
    releases: new Map<string, Release>(),
    calls: { latest: 0, meta: [] as string[], tarballs: [] as string[] },
    fetch: (async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url === `${NPM_REGISTRY}/${spec.mainPackage}/latest`) {
        registry.calls.latest += 1;
        return Response.json({ version: registry.latest });
      }
      const metaPrefix = `${NPM_REGISTRY}/${platformPackage.replace("/", "%2f")}/`;
      if (url.startsWith(metaPrefix)) {
        const version = decodeURIComponent(url.slice(metaPrefix.length));
        registry.calls.meta.push(version);
        const release = registry.releases.get(version);
        if (!release) return new Response("not found", { status: 404 });
        return Response.json({ name: platformPackage, version, dist: { tarball: tarballUrl(version), integrity: release.claimed ?? release.integrity } });
      }
      for (const [version, release] of registry.releases) {
        if (url === tarballUrl(version)) {
          registry.calls.tarballs.push(version);
          return new Response(await readFile(release.tgz));
        }
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch
  };
  return registry;
}

/** The plugins service as the box plugin sees it. */
function fakeSource(state: TsRustToolingState) {
  const events = new EventEmitter();
  const source = {
    state,
    events,
    tsRustToolingState: () => source.state,
    /** Change the state and say so, as the service does after a write. */
    set(next: TsRustToolingState) {
      source.state = next;
      events.emit("changed");
    }
  };
  return source;
}

const onWith = (tsrs: string | null): TsRustToolingState => ({ enabled: true, engine: undefined, current: { tsrs, "tsc-rs": null } });

function fakeHub(connection: BoxConnection & { setConnected?(connected: boolean): void }) {
  const listeners = new Set<(boxId: string, connected: boolean) => void>();
  const hub: Pick<BoxHub, "get" | "onConnectionChange"> = {
    get: (boxId) => (boxId === connection.boxId ? connection : undefined),
    onConnectionChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  };
  return {
    hub,
    setConnected(connected: boolean) {
      connection.setConnected?.(connected);
      for (const listener of listeners) listener(connection.boxId, connected);
    }
  };
}

/** A fake `typescript` package: bin/tsc → lib/tsc.js prints "real tsc <args>". */
async function writeTypescriptProject(project: string): Promise<void> {
  const ts = join(project, "node_modules", "typescript");
  await mkdir(join(ts, "bin"), { recursive: true });
  await mkdir(join(ts, "lib"), { recursive: true });
  await writeFile(join(ts, "package.json"), JSON.stringify({ name: "typescript", version: "5.9.3" }));
  await writeFile(join(ts, "lib", "tsc.js"), 'process.stdout.write("real tsc " + process.argv.slice(2).join(" ") + "\\n");\n');
  await writeFile(join(ts, "bin", "tsc"), '#!/usr/bin/env node\nrequire("../lib/tsc.js");\n', { mode: 0o755 });
  await mkdir(join(project, "node_modules", ".bin"), { recursive: true });
  await symlink("../typescript/bin/tsc", join(project, "node_modules", ".bin", "tsc"));
  await writeFile(join(project, "other.js"), 'process.stdout.write("other\\n");\n');
}

interface Harness {
  root: string;
  appdir: string;
  dataDir: string;
  project: string;
  connection: LocalBoxConnection;
  setConnected(connected: boolean): void;
  registry: ReturnType<typeof registryFetch>;
  source: ReturnType<typeof fakeSource>;
  provisioner: BoxToolingProvisionerHandle;
  statusChanges: string[];
  registryRecord: { purpose: string; state: string } | undefined;
  publish(version: string, options?: { script?: string; noBinary?: boolean; claimed?: string }): Promise<void>;
  /** Run `tsc` from the project with the box's session env. */
  tsc(env: Record<string, string>): ReturnType<typeof spawnSync>;
  sessionEnv(): Promise<Record<string, string>>;
  versionDir(version: string): string;
}

async function harness(t: TestContext, options: { state?: TsRustToolingState; connected?: boolean } = {}): Promise<Harness> {
  const root = await tempRoot("orq-box-tooling-");
  const appdir = join(root, "appdir");
  const workspaces = join(root, "workspaces");
  const dataDir = join(root, "box", "orq-agent");
  const project = join(workspaces, "acme", "app");
  await writeTypescriptProject(project);
  const connection = localBoxConnection({ boxId: "box-1", sys: { os: "linux", arch: "x64", libc: "glibc", dataDir } });
  const { hub, setConnected } = fakeHub(connection);
  if (options.connected === false) setConnected(false);
  const registry = registryFetch("tsrs", "@tsrs/linux-x64-gnu");
  const source = fakeSource(options.state ?? onWith(null));
  let clock = Date.parse("2026-10-20T10:00:00.000Z");
  const h: Harness = {
    root,
    appdir,
    dataDir,
    project,
    connection,
    setConnected,
    registry,
    source,
    provisioner: undefined as never,
    statusChanges: [],
    registryRecord: undefined,
    async publish(version, publishOptions = {}) {
      const tarball = await makeTsRustTarball(root, version, { script: publishOptions.script ?? STUB, noBinary: publishOptions.noBinary }, TS_CHECKER_ENGINE_SPECS.tsrs);
      registry.releases.set(version, { ...tarball, claimed: publishOptions.claimed });
    },
    sessionEnv: async () => ({ PATH: process.env.PATH ?? "", HOME: root, ...(await boxToolingEnv(connection, h.provisioner.contribution("box-1"))) }),
    tsc(env) {
      return spawnSync(process.execPath, [join(project, "node_modules", ".bin", "tsc"), "--noEmit"], { cwd: project, env, encoding: "utf8" });
    },
    versionDir: (version) => join(dataDir, "tooling", "tsrs", "versions", version)
  };
  h.provisioner = createBoxToolingProvisioner({
    baseDir: appdir,
    hub,
    registry: { get: () => (h.registryRecord ? ({ id: "box-1", ...h.registryRecord } as never) : undefined) },
    plugins: [createTsRustToolingPlugin({ source, fetch: registry.fetch })],
    workspacesDir: () => workspaces,
    fetch: registry.fetch,
    now: () => new Date((clock += 1000)),
    logger: { warn: () => {}, error: () => {} },
    onStatusChange: (boxId) => h.statusChanges.push(boxId)
  });
  t.after(async () => {
    await h.provisioner.stop();
    await rm(root, { recursive: true, force: true });
  });
  return h;
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false
  );
}

async function listDir(path: string): Promise<string[]> {
  return (await readdir(path).catch(() => [] as string[])).sort();
}

const signal = () => AbortSignal.timeout(60_000);

test("provision installs the box's release, writes its preload and state, and the preload redirects tsc in the box", { skip: posix ? false : "the stand-in tsrs is a shell script" }, async (t) => {
  const h = await harness(t);
  await h.publish(V1);
  await h.provisioner.provision("box-1", signal());

  // The verified archive is cached on the host under (tool, version, os, arch, libc).
  const cached = boxToolingArchivePath(h.appdir, { tool: "tsrs", version: V1, os: "linux", arch: "x64", libc: "glibc" });
  assert.equal(await exists(cached), true);
  // Installed in the box: the binary beside its package files, executable, with its marker.
  const binary = join(h.versionDir(V1), "tsrs");
  await access(binary, constants.X_OK);
  assert.equal(await exists(join(h.versionDir(V1), "lib.d.ts")), true, "the whole package dir is the version dir");
  const marker = JSON.parse(await readFile(join(h.versionDir(V1), TOOLING_INSTALL_MARKER), "utf8"));
  assert.equal(marker.integrity, h.registry.releases.get(V1)?.integrity);
  assert.deepEqual(await listDir(join(h.dataDir, "tooling", "tsrs", ".tmp")), [], "no staging left");
  const pluginDir = join(h.dataDir, "tooling", "ts-rust");
  assert.deepEqual(JSON.parse(await readFile(join(pluginDir, "state.json"), "utf8")), { enabled: true, engine: "tsrs", version: V1 });
  const preload = await readFile(join(pluginDir, "preload.cjs"), "utf8");
  assert.doesNotMatch(preload, new RegExp(h.appdir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "no host appdir path in the box preload");

  const expected = { pathPrepend: [], env: {}, nodeRequire: [join(pluginDir, "preload.cjs")] };
  assert.deepEqual(h.provisioner.contribution("box-1"), expected);
  assert.deepEqual(
    h.provisioner.toolingStatus("box-1").map(({ pluginId, state, message }) => ({ pluginId, state, message })),
    [{ pluginId: TS_RUST_PLUGIN_ID, state: "ready", message: `tsrs ${V1}` }]
  );
  assert.deepEqual(h.provisioner.pluginStatuses(TS_RUST_PLUGIN_ID).map((status) => [status.boxId, status.state]), [["box-1", "ready"]]);

  // The redirect fires: tsc through node_modules/.bin runs the box's tsrs with tsrs's checker default.
  const env = await h.sessionEnv();
  assert.equal(env.NODE_OPTIONS, `--require ${JSON.stringify(join(pluginDir, "preload.cjs"))}`);
  const redirected = h.tsc(env);
  assert.equal(redirected.stderr, "");
  assert.equal(redirected.stdout, "tsrs --noEmit --checkers 4\n");
  assert.equal(redirected.status, 0);
  const other = spawnSync(process.execPath, [join(h.project, "other.js")], { cwd: h.project, env, encoding: "utf8" });
  assert.equal(other.stdout, "other\n", "anything but tsc runs as it is");

  // Falls back safely: a corrupt state file, then a missing binary, run the real tsc.
  const statePath = join(pluginDir, "state.json");
  const good = await readFile(statePath, "utf8");
  await writeFile(statePath, "{");
  assert.equal(h.tsc(env).stdout, "real tsc --noEmit\n");
  await writeFile(statePath, good);
  await rm(binary);
  const missing = h.tsc(env);
  assert.equal(missing.stdout, "real tsc --noEmit\n");
  assert.match(String(missing.stderr), /^orquester: tsrs failed to start \(ENOENT\); running tsc\n$/);
});

test("a second provision reuses the cache and installs nothing", { skip: posix ? false : "shell-script stand-in" }, async (t) => {
  const h = await harness(t);
  await h.publish(V1);
  await h.provisioner.provision("box-1", signal());
  const marker = await readFile(join(h.versionDir(V1), TOOLING_INSTALL_MARKER), "utf8");
  await h.provisioner.provision("box-1", signal());
  assert.deepEqual(h.registry.calls.tarballs, [V1], "downloaded once");
  assert.equal(await readFile(join(h.versionDir(V1), TOOLING_INSTALL_MARKER), "utf8"), marker, "not reinstalled");
  assert.equal(h.provisioner.toolingStatus("box-1")[0]?.state, "ready");

  // A cached archive that no longer matches is downloaded again, never sent.
  const cached = boxToolingArchivePath(h.appdir, { tool: "tsrs", version: V1, os: "linux", arch: "x64", libc: "glibc" });
  await writeFile(cached, "garbage");
  await rm(h.versionDir(V1), { recursive: true });
  await h.provisioner.provision("box-1", signal());
  assert.deepEqual(h.registry.calls.tarballs, [V1, V1]);
  assert.equal(await exists(join(h.versionDir(V1), "tsrs")), true);
});

test("off, a new version, a disconnected box: every box follows the plugin", { skip: posix ? false : "shell-script stand-in" }, async (t) => {
  const h = await harness(t, { state: onWith(V1) });
  await h.publish(V1);
  await h.publish(V2);
  await h.provisioner.provision("box-1", signal());
  assert.deepEqual(h.registry.calls.meta, [V1], "pinned to the host's current version");
  const envFromBefore = await h.sessionEnv();

  // Off: the state file says so at once, new sessions get nothing, and running ones stop redirecting.
  h.source.set({ ...onWith(V1), enabled: false });
  await h.provisioner.settled();
  const pluginDir = join(h.dataDir, "tooling", "ts-rust");
  assert.deepEqual(JSON.parse(await readFile(join(pluginDir, "state.json"), "utf8")), { enabled: false });
  assert.equal(await exists(join(pluginDir, "preload.cjs")), true, "the preload stays for sessions that require it");
  assert.deepEqual(h.provisioner.contribution("box-1"), { pathPrepend: [], env: {}, nodeRequire: [] });
  assert.equal((await h.sessionEnv()).NODE_OPTIONS, undefined);
  assert.equal(h.provisioner.toolingStatus("box-1")[0]?.state, "off");
  assert.equal(h.tsc(envFromBefore).stdout, "real tsc --noEmit\n");

  // A new host version: installed in the box, the old one pruned there and from the cache.
  h.source.set(onWith(V2));
  await h.provisioner.settled();
  assert.deepEqual(await listDir(join(h.dataDir, "tooling", "tsrs", "versions")), [V2]);
  assert.deepEqual(await listDir(join(boxToolingCacheDir(h.appdir), "tsrs")), [V2]);
  assert.deepEqual(JSON.parse(await readFile(join(pluginDir, "state.json"), "utf8")), { enabled: true, engine: "tsrs", version: V2 });
  assert.equal(h.tsc(envFromBefore).stdout, "tsrs --noEmit --checkers 4\n");

  // A change while the box is away reaches it when it connects again.
  h.setConnected(false);
  h.source.set({ ...onWith(V2), enabled: false });
  await h.provisioner.settled();
  assert.equal(h.provisioner.toolingStatus("box-1")[0]?.state, "ready", "nothing ran while disconnected");
  h.setConnected(true);
  await h.provisioner.settled();
  assert.equal(h.provisioner.toolingStatus("box-1")[0]?.state, "off");
  assert.deepEqual(JSON.parse(await readFile(join(pluginDir, "state.json"), "utf8")), { enabled: false });
});

test("failures leave the box as it was and show as the box's status", { skip: posix ? false : "shell-script stand-in" }, async (t) => {
  const h = await harness(t, { state: onWith(V1) });
  await h.publish(V1);
  await h.provisioner.provision("box-1", signal());
  const before = h.provisioner.contribution("box-1");
  const statePath = join(h.dataDir, "tooling", "ts-rust", "state.json");
  const state = await readFile(statePath, "utf8");

  const cases: Array<[string, { script?: string; noBinary?: boolean; claimed?: string }, RegExp]> = [
    ["0.20.0", { claimed: `sha512-${Buffer.alloc(64).toString("base64")}` }, /^integrity: the download does not match the registry's sha512 integrity$/],
    ["0.21.0", { script: "#!/bin/sh\nexit 1\n" }, /^smoke-test: tsrs --version exited with code 1$/],
    ["0.22.0", { script: "#!/bin/sh\necho hello\n" }, /^smoke-test: tsrs --version printed no "Version" line$/],
    ["0.23.0", { noBinary: true }, /^extract: the archive has no tsrs$/]
  ];
  for (const [version, publishOptions, message] of cases) {
    await h.publish(version, publishOptions);
    h.source.state = onWith(version);
    await assert.rejects(h.provisioner.provision("box-1", signal()), /Plugin tooling failed in box box-1/);
    const status = h.provisioner.toolingStatus("box-1")[0];
    assert.equal(status?.state, "failed", version);
    assert.match(status?.message ?? "", message);
    assert.deepEqual(h.provisioner.contribution("box-1"), before, "new sessions keep what worked");
    assert.equal(await readFile(statePath, "utf8"), state, "the box's state file is untouched");
    assert.deepEqual(await listDir(join(h.dataDir, "tooling", "tsrs", "versions")), [V1]);
    assert.deepEqual(await listDir(join(h.dataDir, "tooling", "tsrs", ".tmp")), [], "no staging left");
  }

  // A version the registry does not have fails at resolve.
  h.source.state = onWith("9.9.9");
  await assert.rejects(h.provisioner.provision("box-1", signal()));
  assert.match(h.provisioner.toolingStatus("box-1")[0]?.message ?? "", /^resolve: HTTP 404/);
});

test("a box that is not connected is refused; a set-up project box is provisioned when it connects", { skip: posix ? false : "shell-script stand-in" }, async (t) => {
  const h = await harness(t, { connected: false });
  await h.publish(V1);
  await assert.rejects(h.provisioner.provision("box-1", signal()), /not connected/);

  // A temporary box gets no tooling; a project box still provisioning gets it from its setup step.
  for (const record of [{ purpose: "temporary", state: "ready" }, { purpose: "project", state: "provisioning" }]) {
    h.registryRecord = record;
    h.setConnected(true);
    await h.provisioner.settled();
    h.setConnected(false);
  }
  assert.deepEqual(h.provisioner.toolingStatus("box-1"), []);

  h.registryRecord = { purpose: "project", state: "ready" };
  h.setConnected(true);
  await h.provisioner.settled();
  assert.equal(h.provisioner.toolingStatus("box-1")[0]?.state, "ready");

  h.provisioner.forget("box-1");
  assert.deepEqual(h.provisioner.toolingStatus("box-1"), []);
  assert.deepEqual(h.provisioner.contribution("box-1"), { pathPrepend: [], env: {}, nodeRequire: [] });
});

// ---- a scripted Windows box --------------------------------------------------------------------

/**
 * A Windows box run from a script: an in-memory file system keyed by Windows
 * paths, `tar.exe` that "extracts" the tsc-rs layout, and a `tsc.exe` that
 * answers the smoke test. Every path the provisioner sends is recorded.
 */
function scriptedWindowsBox() {
  const files = new Map<string, Buffer>();
  const dirs = new Set<string>();
  const paths: string[] = [];
  const execs: Array<{ command: string; args: string[]; cwd?: string }> = [];
  const methods: string[] = [];
  const under = (path: string, root: string) => path === root || path.startsWith(`${root}\\`);
  const fileStat = (path: string, size: number) => ({ path, kind: "file" as const, size, mtimeMs: 0, mode: 0o644, identity: null });
  const map: BoxPathMap = boxPathMapFor("win32");
  const connection = {
    boxId: "win-box",
    sys: localSysInfo({ os: "win32", arch: "x64", libc: null, dataDir: "C:\\orq\\agent", shell: "powershell.exe" }),
    paths: map,
    connected: true,
    agentVersion: "test",
    detachedProcs: () => [],
    async request(method: string, params: Record<string, unknown>) {
      methods.push(method);
      for (const key of ["path", "from", "to"]) if (typeof params[key] === "string") paths.push(params[key] as string);
      const path = params.path as string;
      switch (method) {
        case "fs.stat": {
          const file = files.get(path);
          if (file) return fileStat(path, file.byteLength);
          return dirs.has(path) ? { ...fileStat(path, 0), kind: "dir" } : null;
        }
        case "fs.mkdir":
          dirs.add(path);
          return undefined;
        case "fs.rm":
          for (const key of [...files.keys()]) if (under(key, path)) files.delete(key);
          for (const key of [...dirs]) if (under(key, path)) dirs.delete(key);
          return undefined;
        case "fs.rename": {
          const [from, to] = [params.from as string, params.to as string];
          for (const [key, value] of [...files]) {
            if (!under(key, from)) continue;
            files.delete(key);
            files.set(to + key.slice(from.length), value);
          }
          return undefined;
        }
        case "fs.readdir": {
          const names = new Set<string>();
          for (const key of [...files.keys(), ...dirs]) {
            if (key.startsWith(`${path}\\`)) names.add(key.slice(path.length + 1).split("\\")[0] as string);
          }
          return [...names].map((name) => ({ name, kind: "dir", size: 0, mtimeMs: 0 }));
        }
        default:
          throw new Error(`unexpected ${method}`);
      }
    },
    async writeFile(path: string, data: Readable | Uint8Array | string) {
      paths.push(path);
      const chunks: Buffer[] = [];
      for await (const chunk of typeof data === "string" || data instanceof Uint8Array ? Readable.from([data]) : data) {
        chunks.push(Buffer.from(chunk as Buffer));
      }
      files.set(path, Buffer.concat(chunks));
    },
    async readFile(path: string) {
      const file = files.get(path);
      if (!file) throw new Error(`ENOENT ${path}`);
      return Readable.from([file]);
    },
    exec(options: BoxExecOptions) {
      execs.push({ command: options.command, args: options.args ?? [], cwd: options.cwd });
      const proc = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        pid: 1,
        procId: null,
        exitCode: null,
        signalCode: null,
        killed: false,
        kill: () => false,
        resize: () => undefined
      });
      setImmediate(() => {
        if (options.command === "tar.exe") {
          files.set(`${options.cwd}\\extract\\package\\lib\\tsc.exe`, Buffer.from("MZ"));
          files.set(`${options.cwd}\\extract\\package\\lib\\lib.d.ts`, Buffer.from("//"));
        } else if (options.command.endsWith("\\tsc.exe")) {
          proc.stdout.write("Version 7.1.0-dev\r\n");
        }
        proc.stdout.end();
        proc.stderr.end();
        proc.emit("exit", files.has(options.command) || options.command === "tar.exe" ? 0 : 1, null);
      });
      return proc;
    }
  } as unknown as BoxConnection;
  return { connection, files, paths, execs, methods };
}

test("a Windows box: tar.exe, Windows paths only, no chmod, and NODE_OPTIONS with Windows quoting", async (t) => {
  const root = await tempRoot("orq-box-tooling-win-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const box = scriptedWindowsBox();
  const { hub } = fakeHub(box.connection);
  // The host runs tsrs; a Windows box gets tsc-rs, at the registry's latest.
  const registry = registryFetch("tsc-rs", "@tsc-rs/win32-x64");
  registry.latest = "0.7.0";
  registry.releases.set("0.7.0", await makeTsRustTarball(root, "0.7.0", {}, TS_CHECKER_ENGINE_SPECS["tsc-rs"]));
  const source = fakeSource({ enabled: true, engine: "tsrs", current: { tsrs: V1, "tsc-rs": null } });
  const provisioner = createBoxToolingProvisioner({
    baseDir: join(root, "appdir"),
    hub,
    plugins: [createTsRustToolingPlugin({ source, fetch: registry.fetch })],
    workspacesDir: () => "/var/lib/orquester/workspaces",
    fetch: registry.fetch,
    logger: { warn: () => {}, error: () => {} }
  });
  t.after(() => provisioner.stop());
  await provisioner.provision("win-box", signal());

  assert.equal(provisioner.toolingStatus("win-box")[0]?.message, "tsc-rs 0.7.0");
  assert.equal(box.execs.length, 2);
  const [tar, smoke] = box.execs;
  assert.equal(tar?.command, "tar.exe");
  assert.deepEqual(tar?.args, ["-xzf", "archive.tgz", "-C", "extract"]);
  assert.match(tar?.cwd ?? "", /^C:\\orq\\agent\\tooling\\tsc-rs\\\.tmp\\0\.7\.0-[0-9a-f-]+$/);
  assert.equal(smoke?.command, `${tar?.cwd}\\extract\\package\\lib\\tsc.exe`);
  assert.deepEqual(smoke?.args, ["--version"]);
  assert.equal(box.methods.includes("fs.chmod"), false, "no chmod on Windows");
  for (const path of [...box.paths, ...box.execs.flatMap((exec) => [exec.cwd ?? "", exec.command === "tar.exe" ? "C:\\orq\\" : exec.command])]) {
    assert.match(path, /^C:\\orq\\/, `a Windows box path: ${path}`);
  }
  assert.ok(box.files.has("C:\\orq\\agent\\tooling\\tsc-rs\\versions\\0.7.0\\tsc.exe"));
  assert.ok(box.files.has(`C:\\orq\\agent\\tooling\\tsc-rs\\versions\\0.7.0\\${TOOLING_INSTALL_MARKER}`));
  assert.deepEqual(JSON.parse(box.files.get("C:\\orq\\agent\\tooling\\ts-rust\\state.json")?.toString() ?? ""), {
    enabled: true,
    engine: "tsc-rs",
    version: "0.7.0"
  });
  const preload = box.files.get("C:\\orq\\agent\\tooling\\ts-rust\\preload.cjs")?.toString() ?? "";
  assert.match(preload, /var WORKSPACES_ROOTS = \["C:\\\\orq\\\\var\\\\lib\\\\orquester\\\\workspaces"\];/);

  const env = await boxToolingEnv(box.connection, provisioner.contribution("win-box"));
  assert.deepEqual(env, {
    NODE_OPTIONS: String.raw`--require "C:\\orq\\agent\\tooling\\ts-rust\\preload.cjs"`
  });
  assert.deepEqual(provisioner.contribution("win-box").nodeRequire, ["C:\\orq\\agent\\tooling\\ts-rust\\preload.cjs"]);
});
