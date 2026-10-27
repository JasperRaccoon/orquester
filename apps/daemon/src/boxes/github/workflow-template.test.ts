import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse } from "yaml";

import {
  ANDROID_AVD_STEP_SCRIPT,
  ANDROID_CACHE_KEY,
  ANDROID_CACHE_PATHS,
  ANDROID_SDK_STEP_SCRIPT,
  APPLE_RUNNER_CACHE_PATHS,
  APPLE_RUNNER_STEP_SCRIPT,
  appleRunnerCacheKey,
  DEVICE_TOOLS_CACHE_PATHS,
  DEVICE_TOOLS_STEP_SCRIPT,
  deviceToolsCacheKey,
  KVM_STEP_SCRIPT,
  XCODE_BUILD_STEP_SCRIPT
} from "./device-cache.ts";
import {
  BLACKSMITH_LINUX_RUNNER_LABELS,
  BLACKSMITH_RUNNER_LABELS,
  blacksmithDeviceCacheWorkflowTemplate,
  blacksmithRunnerOs,
  blacksmithWorkflowTemplate,
  CACHE_CHECK_STEP_SCRIPT,
  CHECK_STEP_SCRIPT,
  DOWNLOAD_STEP_SCRIPT,
  PATHS_STEP_SCRIPT
} from "./workflow-template.ts";

interface Step {
  name: string;
  id?: string;
  if?: string;
  run?: string;
  uses?: string;
  env?: Record<string, string>;
  with?: Record<string, string | boolean>;
  "continue-on-error"?: boolean;
}

interface Input {
  type: string;
  required?: boolean;
  default?: string;
  options?: string[];
}

function parsed(options?: Parameters<typeof blacksmithWorkflowTemplate>[0]) {
  return parse(blacksmithWorkflowTemplate(options)) as {
    name: string;
    "run-name": string;
    on: { workflow_dispatch: { inputs: Record<string, Input> } };
    permissions: Record<string, string>;
    jobs: { box: { "runs-on": string; "timeout-minutes": string; steps: Step[] } };
  };
}

function parsedCacheWorkflow() {
  return parse(blacksmithDeviceCacheWorkflowTemplate()) as {
    "run-name": string;
    on: { workflow_dispatch: { inputs: Record<string, Input> } };
    permissions: Record<string, string>;
    jobs: Record<"linux" | "macos", { if: string; "runs-on": string; "timeout-minutes": number; steps: Step[] }>;
  };
}

/**
 * The steps a run executes for these inputs, evaluating the template's `if:` conditions (the
 * subset of GitHub's expression syntax the templates use; cache outputs come from `outputs`).
 */
function stepsFor(steps: Step[], inputs: Record<string, string>, outputs: Record<string, string> = {}): Step[] {
  const evaluate = (condition: string): boolean =>
    condition.split(" && ").every((clause) => {
      const match = /^([a-z.\-_]+) (==|!=) '([^']*)'$/.exec(clause.trim());
      assert.ok(match, `unsupported condition: ${clause}`);
      const [, path, op, value] = match;
      const actual = path!.startsWith("inputs.") ? (inputs[path!.slice(7)] ?? "") : (outputs[path!] ?? "");
      return op === "==" ? actual === value : actual !== value;
    });
  return steps.filter((step) => step.if === undefined || evaluate(step.if));
}

test("the workflow: dispatch inputs, OIDC permission, runner choice, lifetime, steps", () => {
  const workflow = parsed();
  assert.equal(workflow["run-name"], "orq-${{ inputs.box_id }}");
  for (const input of ["box_id", "lifetime_minutes", "daemon_url", "runner", "os", "prepare"]) assert.ok(workflow.on.workflow_dispatch.inputs[input]);
  assert.ok(workflow.on.workflow_dispatch.inputs.runner!.options!.includes("blacksmith-6vcpu-macos-26"));
  assert.ok(workflow.on.workflow_dispatch.inputs.runner!.options!.includes("blacksmith-12vcpu-macos-15"));
  assert.deepEqual(workflow.on.workflow_dispatch.inputs.runner!.options, [...BLACKSMITH_RUNNER_LABELS]);
  // Dispatches from builds that send no os/prepare (and old runs) stay plain macOS boxes.
  assert.deepEqual(workflow.on.workflow_dispatch.inputs.os, {
    description: "The runner's OS",
    required: false,
    type: "choice",
    default: "macos",
    options: ["macos", "linux"]
  } as Input);
  assert.deepEqual(
    [workflow.on.workflow_dispatch.inputs.prepare!.default, workflow.on.workflow_dispatch.inputs.prepare!.options],
    ["none", ["none", "devices"]]
  );
  assert.deepEqual(workflow.permissions, { "id-token": "write", contents: "read" });
  assert.equal(workflow.jobs.box["runs-on"], "${{ inputs.runner }}");
  assert.equal(workflow.jobs.box["timeout-minutes"], "${{ fromJSON(inputs.lifetime_minutes) }}");
  const steps = workflow.jobs.box.steps;
  const env = steps.find((step) => step.env?.ORQ_GITHUB_OIDC === "1")!.env!;
  assert.equal(env.ORQ_DAEMON_URL, "${{ inputs.daemon_url }}");
  assert.equal(env.ORQ_BOX_ID, "${{ inputs.box_id }}");
  // Inputs reach shell only through env, never interpolated into a script.
  for (const step of steps) assert.ok(!step.run?.includes("${{"), `${step.name} interpolates an expression into shell`);
});

test("the optional Tailscale step uses workload identity, the box tag and hostname", () => {
  const steps = parsed({ tailscale: { oauthClientId: "kAbc123CNTRL", audience: "api.tailscale.com/kAbc123CNTRL" } }).jobs.box.steps;
  const step = steps.find((candidate) => candidate.uses?.startsWith("tailscale/github-action@"))!;
  assert.deepEqual(step.with, {
    "oauth-client-id": "kAbc123CNTRL",
    audience: "api.tailscale.com/kAbc123CNTRL",
    tags: "tag:orq-box",
    hostname: "orq-${{ inputs.box_id }}"
  });
  assert.ok(steps.indexOf(step) < steps.findIndex((candidate) => candidate.env?.ACTIONS_ID_TOKEN_REQUEST_URL !== undefined || candidate.run?.includes("ACTIONS_ID_TOKEN_REQUEST_URL")), "joins before the authenticated download");
  assert.throws(() => blacksmithWorkflowTemplate({ tailscale: { oauthClientId: "x\ny", audience: "a" } }), /Invalid/);
});

test("macOS without devices runs exactly the macOS box steps", () => {
  const steps = stepsFor(parsed().jobs.box.steps, { os: "macos", prepare: "none" });
  assert.deepEqual(
    steps.map((step) => step.name),
    ["Check inputs", "Download orq-agent", "Prepare paths", "Run orq-agent"]
  );
  assert.equal(steps[1]!.env!.AGENT_PLATFORM, "${{ inputs.os == 'linux' && 'linux-x64' || 'darwin-arm64' }}");
});

test("Linux boxes enable KVM before orq-agent starts; device hosts restore the Android and tool caches", () => {
  const all = parsed().jobs.box.steps;
  const plain = stepsFor(all, { os: "linux", prepare: "none" });
  assert.deepEqual(
    plain.map((step) => step.name),
    ["Check inputs", "Enable KVM", "Download orq-agent", "Prepare paths", "Run orq-agent"]
  );
  assert.equal(plain[1]!.run!.trimEnd(), KVM_STEP_SCRIPT.trimEnd());

  const devices = stepsFor(all, { os: "linux", prepare: "devices" });
  assert.deepEqual(
    devices.map((step) => step.name),
    [
      "Check inputs",
      "Enable KVM",
      "Download orq-agent",
      "Prepare paths",
      "Set up Node for the device tools",
      "Restore the Android SDK and AVDs",
      "Restore the device tools",
      "Run orq-agent"
    ]
  );
  const android = devices.find((step) => step.name === "Restore the Android SDK and AVDs")!;
  assert.equal(android.uses, "actions/cache/restore@v4");
  assert.equal(android["continue-on-error"], true, "a cache problem never keeps orq-agent from starting");
  assert.equal(android.with!.key, ANDROID_CACHE_KEY);
  assert.deepEqual((android.with!.path as string).trim().split("\n"), [...ANDROID_CACHE_PATHS]);
  const tools = devices.find((step) => step.name === "Restore the device tools")!;
  assert.equal(tools.with!.key, `\${{ inputs.os == 'linux' && '${deviceToolsCacheKey("linux")}' || '${deviceToolsCacheKey("macos")}' }}`);
  assert.deepEqual((tools.with!.path as string).trim().split("\n"), [...DEVICE_TOOLS_CACHE_PATHS]);
  // Box runs never save: a destroy cancels the run.
  assert.ok(!all.some((step) => step.uses?.startsWith("actions/cache/save")));
});

test("macOS device hosts restore agent-device's iOS runner keyed on the Xcode build", () => {
  const all = parsed().jobs.box.steps;
  const names = (outputs: Record<string, string>) => stepsFor(all, { os: "macos", prepare: "devices" }, outputs).map((step) => step.name);
  assert.deepEqual(names({ "steps.xcode.outputs.build": "17E202" }), [
    "Check inputs",
    "Download orq-agent",
    "Prepare paths",
    "Set up Node for the device tools",
    "Find the Xcode build",
    "Restore the device tools",
    "Restore agent-device's iOS runner",
    "Run orq-agent"
  ]);
  assert.ok(!names({}).includes("Restore agent-device's iOS runner"), "skipped when the Xcode build is unknown");
  const runner = all.find((step) => step.name === "Restore agent-device's iOS runner")!;
  assert.equal(runner.with!.key, appleRunnerCacheKey("${{ steps.xcode.outputs.build }}"));
  assert.deepEqual((runner.with!.path as string).trim().split("\n"), [...APPLE_RUNNER_CACHE_PATHS]);
  assert.equal(all.find((step) => step.name === "Find the Xcode build")!.id, "xcode");
});

test("the device-cache workflow builds what is missing and saves it under the keys box runs restore", () => {
  const workflow = parsedCacheWorkflow();
  assert.equal(workflow["run-name"], "orq-cache-${{ inputs.os }}-${{ inputs.request_id }}");
  assert.deepEqual(Object.keys(workflow.on.workflow_dispatch.inputs), ["request_id", "os", "runner"]);
  assert.deepEqual(workflow.permissions, { contents: "read" }, "no OIDC: it never talks to the daemon");
  assert.equal(workflow.jobs.linux.if, "inputs.os == 'linux'");
  assert.equal(workflow.jobs.macos.if, "inputs.os == 'macos'");
  for (const job of Object.values(workflow.jobs)) {
    for (const step of job.steps) assert.ok(!step.run?.includes("${{"), `${step.name} interpolates an expression into shell`);
  }

  const linux = workflow.jobs.linux.steps;
  const linuxMiss = stepsFor(linux, { os: "linux" }).map((step) => step.name);
  assert.deepEqual(linuxMiss, [
    "Check inputs",
    "Enable KVM",
    "Prepare paths",
    "Look up the Android cache",
    "Set up Java for the Android SDK tools",
    "Install the Android SDK",
    "Create the AVDs and their golden snapshots",
    "Save the Android cache",
    "Set up Node for the device tools",
    "Look up the device tools cache",
    "Install the device tools",
    "Save the device tools"
  ]);
  const hit = stepsFor(linux, { os: "linux" }, { "steps.android.outputs.cache-hit": "true", "steps.tools.outputs.cache-hit": "true" });
  assert.deepEqual(
    hit.map((step) => step.name),
    ["Check inputs", "Enable KVM", "Prepare paths", "Look up the Android cache", "Set up Node for the device tools", "Look up the device tools cache"]
  );
  const lookup = linux.find((step) => step.id === "android")!;
  const save = linux.find((step) => step.name === "Save the Android cache")!;
  assert.equal(lookup.with!["lookup-only"], true);
  assert.equal(save.uses, "actions/cache/save@v4");
  // actions/cache versions an entry by its paths: save and restore must list the same ones.
  const boxRestore = parsed().jobs.box.steps.find((step) => step.name === "Restore the Android SDK and AVDs")!;
  assert.deepEqual([save.with!.key, save.with!.path], [boxRestore.with!.key, boxRestore.with!.path]);

  const macos = workflow.jobs.macos.steps;
  const macMiss = stepsFor(macos, { os: "macos" }, { "steps.xcode.outputs.build": "17E202" }).map((step) => step.name);
  assert.deepEqual(macMiss, [
    "Check inputs",
    "Prepare paths",
    "Set up Node for the device tools",
    "Restore the device tools",
    "Install the device tools",
    "Save the device tools",
    "Find the Xcode build",
    "Look up agent-device's iOS runner",
    "Build agent-device's iOS runner",
    "Save agent-device's iOS runner"
  ]);
  const runnerSave = macos.find((step) => step.name === "Save agent-device's iOS runner")!;
  const boxRunner = parsed().jobs.box.steps.find((step) => step.name === "Restore agent-device's iOS runner")!;
  assert.deepEqual([runnerSave.with!.key, runnerSave.with!.path], [boxRunner.with!.key, boxRunner.with!.path]);
  // The macOS tools are restored for real (the runner build needs agent-device), Linux's only looked up.
  assert.equal(macos.find((step) => step.id === "tools")!.with!["lookup-only"], undefined);
});

test("the templates are deterministic", () => {
  assert.equal(blacksmithWorkflowTemplate(), blacksmithWorkflowTemplate());
  assert.equal(blacksmithDeviceCacheWorkflowTemplate(), blacksmithDeviceCacheWorkflowTemplate());
});

test("runner labels: macOS M4 and x64 Ubuntu 24.04, no ARM Linux", () => {
  assert.deepEqual(BLACKSMITH_LINUX_RUNNER_LABELS, [
    "blacksmith-2vcpu-ubuntu-2404",
    "blacksmith-4vcpu-ubuntu-2404",
    "blacksmith-8vcpu-ubuntu-2404",
    "blacksmith-16vcpu-ubuntu-2404",
    "blacksmith-32vcpu-ubuntu-2404"
  ]);
  assert.ok(!BLACKSMITH_RUNNER_LABELS.some((label) => label.endsWith("-arm")));
  assert.equal(blacksmithRunnerOs("blacksmith-6vcpu-macos-26"), "macos");
  assert.equal(blacksmithRunnerOs("blacksmith-8vcpu-ubuntu-2404"), "linux");
  assert.equal(blacksmithRunnerOs("blacksmith-8vcpu-ubuntu-2404-arm"), null);
  assert.equal(blacksmithRunnerOs(undefined), null);
});

test("the step scripts pass bash -n", () => {
  for (const script of [
    CHECK_STEP_SCRIPT,
    CACHE_CHECK_STEP_SCRIPT,
    DOWNLOAD_STEP_SCRIPT,
    PATHS_STEP_SCRIPT,
    KVM_STEP_SCRIPT,
    XCODE_BUILD_STEP_SCRIPT,
    DEVICE_TOOLS_STEP_SCRIPT,
    ANDROID_SDK_STEP_SCRIPT,
    ANDROID_AVD_STEP_SCRIPT,
    APPLE_RUNNER_STEP_SCRIPT
  ]) {
    const syntax = spawnSync("bash", ["-n"], { input: script, encoding: "utf8" });
    assert.equal(syntax.status, 0, syntax.stderr);
  }
});

test("the input check rejects values that could break out of the run", () => {
  const check = (env: Record<string, string>): number | null =>
    spawnSync("bash", ["-c", CHECK_STEP_SCRIPT], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env }, encoding: "utf8" }).status;
  const good = {
    BOX_ID: "box-0123456789ab",
    DAEMON_URL: "https://orq.example.com:8443/t4",
    LIFETIME: "120",
    RUNNER: "blacksmith-6vcpu-macos-26",
    OS: "macos",
    PREPARE: "none"
  };
  assert.equal(check(good), 0);
  assert.equal(check({ ...good, RUNNER: "blacksmith-8vcpu-ubuntu-2404", OS: "linux", PREPARE: "devices" }), 0);
  assert.equal(check({ ...good, RUNNER: "blacksmith-8vcpu-ubuntu-2404" }), 1, "a Linux runner for a macOS box");
  assert.equal(check({ ...good, OS: "linux" }), 1, "a macOS runner for a Linux box");
  assert.equal(check({ ...good, OS: "windows" }), 1);
  assert.equal(check({ ...good, PREPARE: "everything" }), 1);
  assert.equal(check({ ...good, BOX_ID: "x; curl evil" }), 1);
  assert.equal(check({ ...good, DAEMON_URL: "http://orq.example.com" }), 1);
  assert.equal(check({ ...good, DAEMON_URL: "https://orq.example.com/$(id)" }), 1);
  assert.equal(check({ ...good, LIFETIME: "7201" }), 1);
  assert.equal(check({ ...good, LIFETIME: "0" }), 1);
  assert.equal(check({ ...good, LIFETIME: "1e3" }), 1);

  const cacheCheck = (env: Record<string, string>): number | null =>
    spawnSync("bash", ["-c", CACHE_CHECK_STEP_SCRIPT], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env }, encoding: "utf8" }).status;
  const cache = { REQUEST_ID: "6f1c1d1e-4a1b-4c7d-9e2f-0a1b2c3d4e5f", OS: "linux", RUNNER: "blacksmith-8vcpu-ubuntu-2404" };
  assert.equal(cacheCheck(cache), 0);
  assert.equal(cacheCheck({ ...cache, REQUEST_ID: "x; id" }), 1);
  assert.equal(cacheCheck({ ...cache, OS: "macos" }), 1);
});

for (const platform of ["darwin-arm64", "linux-x64"]) {
  test(`the download step (${platform}) gets an OIDC token for the daemon origin and sends it as GitHubOIDC`, async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "orq-wf-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const seen: Array<{ url: string; authorization?: string; boxId?: string }> = [];
    const server = createServer((request, response) => {
      seen.push({ url: request.url ?? "", authorization: request.headers.authorization, boxId: request.headers["x-orq-box-id"] as string | undefined });
      if (request.url?.startsWith("/oidc?")) {
        if (request.headers.authorization !== "Bearer request-token-SECRET") return void response.writeHead(401).end();
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ count: 1, value: "aaa.bbb.ccc" }));
        return;
      }
      if (request.url === `/base/api/boxes/agent/${platform}` && request.headers.authorization === "GitHubOIDC aaa.bbb.ccc") {
        response.writeHead(200).end("#!/bin/sh\n[ \"$1\" = --version ] && echo 0.0.0-test\n");
        return;
      }
      response.writeHead(403).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const home = join(dir, "home");
    const runnerTemp = join(dir, "tmp");
    await mkdir(home);
    await mkdir(runnerTemp);

    const child = spawn("bash", ["-eo", "pipefail", "-c", DOWNLOAD_STEP_SCRIPT], {
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: home,
        RUNNER_TEMP: runnerTemp,
        ACTIONS_ID_TOKEN_REQUEST_URL: `${origin}/oidc?api-version=2.0`,
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-token-SECRET",
        BOX_ID: "box-0123456789ab",
        DAEMON_URL: `${origin}/base/`,
        AGENT_PLATFORM: platform
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
    assert.equal(code, 0, output);
    assert.ok(!output.includes("SECRET") && !output.includes("aaa.bbb.ccc"), "no token in the step log");

    const oidc = new URL(seen[0]!.url, origin);
    assert.equal(oidc.searchParams.get("audience"), origin, "audience = the daemon origin, without the base path");
    assert.equal(seen[1]!.url, `/base/api/boxes/agent/${platform}`);
    assert.equal(seen[1]!.authorization, "GitHubOIDC aaa.bbb.ccc");
    assert.equal(seen[1]!.boxId, "box-0123456789ab");
    assert.match(await readFile(join(home, ".orq-agent", "bin", "orq-agent"), "utf8"), /0\.0\.0-test/);
  });
}
