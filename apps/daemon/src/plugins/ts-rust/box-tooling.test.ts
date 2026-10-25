// Better TS Typecheck in boxes: the engine, platform package, archive layout
// and files each of the seven orq-agent platforms gets, resolved from a fake
// npm registry; and the box preload rendered for a Windows box from this
// (POSIX) daemon. The provisioning flow itself, with the preload run under
// node, is boxes/tooling/provisioner.test.ts.

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { Script } from "node:vm";

import { BOX_AGENT_PLATFORMS, type BoxArch, type BoxLibc, type BoxOs, type TsCheckerEngine, boxPathMapFor } from "@orquester/api";

import { toolingTargetContext } from "../../boxes/tooling/provisioner.ts";
import { ToolingStepError, type ToolingPlan } from "../../boxes/tooling/types.ts";
import { type TsRustToolingState, createTsRustToolingPlugin, tsRustEngineForTarget, tsRustTargetEngines } from "./box-tooling.ts";
import { NPM_REGISTRY } from "./installer.ts";

const HOST_WORKSPACES = "/var/lib/orquester/workspaces";
const TSRS_VERSION = "0.16.0-ts7.1.0-dev.20260929";
const TSC_RS_VERSION = "0.7.0";
const INTEGRITY = `sha512-${Buffer.alloc(64, 7).toString("base64")}`;

function targetOf(platform: string): { os: BoxOs; arch: BoxArch; libc: BoxLibc | null } {
  const [os, arch, musl] = platform.split("-") as [BoxOs, BoxArch, string | undefined];
  return { os, arch, libc: os === "linux" ? (musl === "musl" ? "musl" : "glibc") : null };
}

function dataDirOf(os: BoxOs): string {
  return os === "win32" ? "C:\\orq\\agent" : "/var/lib/orq-agent";
}

function contextFor(platform: string) {
  const target = targetOf(platform);
  return toolingTargetContext({
    boxId: `box-${platform}`,
    sys: { ...target, dataDir: dataDirOf(target.os) },
    paths: boxPathMapFor(target.os),
    pluginId: "ts-rust",
    hostWorkspacesRoots: [HOST_WORKSPACES]
  });
}

/** A registry answering every package; `meta` records the platform packages asked for, with their version. */
function registry(options: { integrity?: string } = {}) {
  const asked = { latest: [] as string[], meta: [] as string[] };
  return {
    asked,
    deps: {
      fetchJson: async (url: string) => {
        const path = url.slice(NPM_REGISTRY.length + 1);
        if (path === "tsrs/latest" || path === "tsc-rs/latest") {
          const main = path.slice(0, -"/latest".length);
          asked.latest.push(main);
          return { version: main === "tsrs" ? TSRS_VERSION : TSC_RS_VERSION };
        }
        const slash = path.lastIndexOf("/");
        const name = decodeURIComponent(path.slice(0, slash));
        const version = decodeURIComponent(path.slice(slash + 1));
        asked.meta.push(`${name}@${version}`);
        const base = name.slice(name.indexOf("/") + 1);
        return {
          name,
          version,
          dist: { tarball: `${NPM_REGISTRY}/${name}/-/${base}-${version}.tgz`, integrity: options.integrity ?? INTEGRITY }
        };
      }
    }
  };
}

function source(state: TsRustToolingState | null) {
  const events = new EventEmitter();
  const holder = { state };
  return { holder, events, tsRustToolingState: () => holder.state };
}

const on = (engine?: TsCheckerEngine, current: Partial<Record<TsCheckerEngine, string>> = {}): TsRustToolingState => ({
  enabled: true,
  engine,
  current: { tsrs: current.tsrs ?? null, "tsc-rs": current["tsc-rs"] ?? null }
});

const EXPECTED: Record<string, { engine: TsCheckerEngine; pkg: string; entry: string; stripPrefix: string }> = {
  "linux-x64": { engine: "tsrs", pkg: "@tsrs/linux-x64-gnu", entry: "tsrs", stripPrefix: "package" },
  "linux-arm64": { engine: "tsrs", pkg: "@tsrs/linux-arm64-gnu", entry: "tsrs", stripPrefix: "package" },
  "linux-x64-musl": { engine: "tsrs", pkg: "@tsrs/linux-x64-musl", entry: "tsrs", stripPrefix: "package" },
  "linux-arm64-musl": { engine: "tsrs", pkg: "@tsrs/linux-arm64-musl", entry: "tsrs", stripPrefix: "package" },
  "darwin-arm64": { engine: "tsrs", pkg: "@tsrs/darwin-arm64", entry: "tsrs", stripPrefix: "package" },
  "darwin-x64": { engine: "tsc-rs", pkg: "@tsc-rs/darwin-x64", entry: "tsc", stripPrefix: "package/lib" },
  "win32-x64": { engine: "tsc-rs", pkg: "@tsc-rs/win32-x64", entry: "tsc.exe", stripPrefix: "package/lib" }
};

test("every orq-agent platform resolves its engine, platform package and archive layout from the registry", async () => {
  assert.deepEqual(Object.keys(EXPECTED).sort(), [...BOX_AGENT_PLATFORMS].sort(), "the table covers every platform");
  for (const platform of BOX_AGENT_PLATFORMS) {
    const expected = EXPECTED[platform]!;
    const fake = registry();
    const plugin = createTsRustToolingPlugin({ source: source(on()), registry: fake.deps });
    const context = contextFor(platform);
    const plan = await plugin.plan(context, AbortSignal.timeout(5000));
    assert.equal(plan.kind, "install", platform);
    if (plan.kind !== "install") continue;
    const version = expected.engine === "tsrs" ? TSRS_VERSION : TSC_RS_VERSION;
    assert.deepEqual(fake.asked.meta, [`${expected.pkg}@${version}`], platform);
    assert.deepEqual(plan.artifacts, [
      {
        tool: expected.engine,
        version,
        url: `${NPM_REGISTRY}/${expected.pkg}/-/${expected.pkg.split("/")[1]}-${version}.tgz`,
        integrity: INTEGRITY,
        archive: "tar.gz",
        stripPrefix: expected.stripPrefix,
        entry: expected.entry,
        smokeTest: { args: ["--version"], expectLinePrefix: "Version " }
      }
    ]);
    assert.equal(plan.summary, `${expected.engine} ${version}`);
    const state = plan.files.find((file) => file.path.endsWith("state.json"));
    assert.deepEqual(JSON.parse(state?.content ?? ""), { enabled: true, engine: expected.engine, version });
    const preload = plan.files[0];
    assert.equal(preload?.path, context.path.join(dataDirOf(context.target.os), "tooling", "ts-rust", "preload.cjs"));
    assert.deepEqual(plan.contribution, { pathPrepend: [], env: {}, nodeRequire: [preload?.path] });
    assert.equal(plan.files.at(-1), state, "the state file, which turns the preload on, goes last");
  }
});

test("the chosen engine is kept where the box has a build, else the box's default; tsc-rs's Linux build serves musl too", () => {
  const musl = targetOf("linux-x64-musl");
  assert.equal(tsRustEngineForTarget(musl, "tsc-rs"), "tsc-rs");
  assert.equal(tsRustTargetEngines(musl).packages["tsc-rs"], "@tsc-rs/linux-x64", "statically linked");
  assert.equal(tsRustEngineForTarget(targetOf("win32-x64"), "tsrs"), "tsc-rs", "a Windows box gets tsc-rs under a tsrs host");
  assert.equal(tsRustEngineForTarget(targetOf("darwin-x64"), "tsrs"), "tsc-rs");
  assert.equal(tsRustEngineForTarget(targetOf("darwin-arm64"), undefined), "tsrs");
  assert.deepEqual(tsRustTargetEngines(targetOf("win32-x64")).supported, ["tsc-rs"]);
  assert.deepEqual(tsRustTargetEngines(targetOf("linux-arm64")).supported, ["tsrs", "tsc-rs"]);
  assert.equal(tsRustEngineForTarget({ os: "linux", arch: "riscv64" as BoxArch, libc: "glibc" }, undefined), null);
});

test("a box follows the host's current version of its engine, and the registry's latest when the host has none", async () => {
  const fake = registry();
  const plugin = createTsRustToolingPlugin({ source: source(on("tsrs", { tsrs: "0.15.0" })), registry: fake.deps });
  const linux = await plugin.plan(contextFor("linux-x64"), AbortSignal.timeout(5000));
  assert.equal(linux.kind === "install" && linux.artifacts[0]?.version, "0.15.0");
  const windows = await plugin.plan(contextFor("win32-x64"), AbortSignal.timeout(5000));
  assert.equal(windows.kind === "install" && windows.artifacts[0]?.version, TSC_RS_VERSION);
  assert.deepEqual(fake.asked.latest, ["tsc-rs"], "latest is asked only for the engine the host has no version of");
  assert.deepEqual(fake.asked.meta, ["@tsrs/linux-x64-gnu@0.15.0", `@tsc-rs/win32-x64@${TSC_RS_VERSION}`]);
});

test("a Windows box's preload and contribution carry only Windows box paths, quoted for NODE_OPTIONS", async () => {
  const plugin = createTsRustToolingPlugin({ source: source(on()), registry: registry().deps });
  const plan = await plugin.plan(contextFor("win32-x64"), AbortSignal.timeout(5000));
  assert.equal(plan.kind, "install");
  if (plan.kind !== "install") return;
  const preload = plan.files[0]?.content ?? "";
  new Script(preload, { filename: "preload.cjs" }); // compiles
  for (const path of [
    "C:\\orq\\agent\\tooling\\ts-rust\\state.json",
    "C:\\orq\\var\\lib\\orquester\\workspaces",
    "C:\\orq\\agent\\tooling\\tsc-rs\\versions",
    "C:\\orq\\agent\\tooling\\tsrs\\versions"
  ]) assert.ok(preload.includes(JSON.stringify(path)), `missing box path ${path}`);
  assert.doesNotMatch(preload, /plugins\.json"|"\/var\/lib/, "no host path or host state file");
  assert.deepEqual(plan.contribution.nodeRequire, ["C:\\orq\\agent\\tooling\\ts-rust\\preload.cjs"]);
  assert.ok(plan.files.every((file) => file.path.startsWith("C:\\orq\\agent\\tooling\\ts-rust\\")));
});

test("off, unsupported and refusals: state says off; no build means unsupported; no sha512 or no plugins.json fails resolve", async () => {
  const off = createTsRustToolingPlugin({ source: source({ ...on(), enabled: false }), registry: registry().deps });
  const plan: ToolingPlan = await off.plan(contextFor("linux-x64"), AbortSignal.timeout(5000));
  assert.deepEqual(plan, { kind: "off", files: [{ path: "/var/lib/orq-agent/tooling/ts-rust/state.json", content: '{"enabled":false}\n' }] });

  const riscv = toolingTargetContext({
    boxId: "r",
    sys: { os: "linux", arch: "riscv64" as BoxArch, libc: "glibc", dataDir: "/d" },
    paths: { kind: "identity" },
    pluginId: "ts-rust",
    hostWorkspacesRoots: [HOST_WORKSPACES]
  });
  const unsupported = await createTsRustToolingPlugin({ source: source(on()), registry: registry().deps }).plan(riscv, AbortSignal.timeout(5000));
  assert.equal(unsupported.kind, "unsupported");

  const md5 = createTsRustToolingPlugin({ source: source(on()), registry: registry({ integrity: "md5-AAAA" }).deps });
  await assert.rejects(md5.plan(contextFor("linux-x64"), AbortSignal.timeout(5000)), (error: unknown) => {
    assert.ok(error instanceof ToolingStepError);
    assert.equal(error.step, "resolve");
    assert.match(error.message, /no sha512 integrity/);
    return true;
  });
  const unreadable = createTsRustToolingPlugin({ source: source(null), registry: registry().deps });
  await assert.rejects(unreadable.plan(contextFor("linux-x64"), AbortSignal.timeout(5000)), /plugins\.json does not read/);
});

test("onChange fires only when what a box gets changes", () => {
  const src = source(on());
  const plugin = createTsRustToolingPlugin({ source: src, registry: registry().deps });
  let fired = 0;
  const off = plugin.onChange(() => (fired += 1));
  src.events.emit("changed");
  assert.equal(fired, 0, "a job-progress event changes nothing");
  src.holder.state = on("tsrs", { tsrs: TSRS_VERSION });
  src.events.emit("changed");
  src.events.emit("changed");
  assert.equal(fired, 1);
  off();
  src.holder.state = { ...on(), enabled: false };
  src.events.emit("changed");
  assert.equal(fired, 1);
});
