import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse } from "yaml";

import { blacksmithDeviceCacheWorkflowTemplate, blacksmithWorkflowTemplate } from "./workflow-template.ts";

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
  // Dispatches from builds that send no os/prepare (and old runs) stay plain macOS boxes.
  const os = workflow.on.workflow_dispatch.inputs.os!;
  assert.deepEqual([os.required, os.type, os.default, os.options], [false, "choice", "macos", ["macos", "linux"]]);
  assert.deepEqual(
    [workflow.on.workflow_dispatch.inputs.prepare!.default, workflow.on.workflow_dispatch.inputs.prepare!.options],
    ["none", ["none", "devices"]]
  );
  assert.deepEqual(workflow.permissions, { "id-token": "write", contents: "read" });
  assert.equal(workflow.jobs.box["runs-on"], "${{ inputs.runner }}");
  assert.equal(workflow.jobs.box["timeout-minutes"], "${{ fromJSON(inputs.lifetime_minutes) }}");
  const steps = workflow.jobs.box.steps;
  assert.equal(steps.find((step) => step.env?.AGENT_PLATFORM)?.env?.AGENT_PLATFORM, "${{ inputs.os == 'linux' && 'linux-x64' || 'darwin-arm64' }}");
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


test("Linux device hosts restore their SDK and tools before the agent, without saving on cancellation", () => {
  const all = parsed().jobs.box.steps;
  assert.ok(!stepsFor(all, { os: "linux", prepare: "none" }).some((step) => step.uses?.startsWith("actions/cache")));
  const devices = stepsFor(all, { os: "linux", prepare: "devices" });
  const android = devices.find((step) => String(step.with?.path).includes("/var/lib/orquester/devices/android-sdk"))!;
  assert.equal(android.uses, "actions/cache/restore@v4");
  assert.equal(android["continue-on-error"], true, "a cache failure does not prevent the agent starting");
  assert.deepEqual(String(android.with!.path).trim().split("\n"), ["/var/lib/orquester/devices/android-sdk", "/var/lib/orquester/devices/avd"]);
  const tools = devices.find((step) => String(step.with?.path).trim() === "/var/lib/orquester/devices/tools")!;
  assert.equal(tools.uses, "actions/cache/restore@v4");
  assert.ok(devices.indexOf(android) < devices.findIndex((step) => step.env?.ORQ_GITHUB_OIDC === "1"));
  assert.ok(!all.some((step) => step.uses?.startsWith("actions/cache/save")));
});

test("macOS device hosts restore the iOS runner only for a known Xcode build", () => {
  const all = parsed().jobs.box.steps;
  const runner = (outputs: Record<string, string>) => stepsFor(all, { os: "macos", prepare: "devices" }, outputs).find((step) => String(step.with?.path).trim() === "~/.agent-device/apple-runner");
  const restored = runner({ "steps.xcode.outputs.build": "17E202" })!;
  assert.equal(restored.uses, "actions/cache/restore@v4");
  assert.match(String(restored.with!.key), /\$\{\{ steps\.[a-z-]+\.outputs\.build \}\}/);
  assert.equal(runner({}), undefined);
});

test("the device-cache workflow saves the same SDK, tools and iOS runner keys and paths that box runs restore", () => {
  const workflow = parsedCacheWorkflow();
  assert.equal(workflow["run-name"], "orq-cache-${{ inputs.os }}-${{ inputs.request_id }}");
  assert.deepEqual(Object.keys(workflow.on.workflow_dispatch.inputs).sort(), ["os", "request_id", "runner"]);
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.equal(workflow.jobs.linux.if, "inputs.os == 'linux'");
  assert.equal(workflow.jobs.macos.if, "inputs.os == 'macos'");
  const box = parsed().jobs.box.steps;
  for (const [os, job] of Object.entries(workflow.jobs)) {
    for (const step of job.steps) assert.ok(!step.run?.includes("${{"), "inputs are passed through env");
    const miss = stepsFor(job.steps, { os }, { "steps.xcode.outputs.build": "17E202" });
    const savedCaches = miss.filter((step) => step.uses === "actions/cache/save@v4");
    assert.deepEqual(new Set(savedCaches.map((step) => String(step.with!.path).trim())), new Set(os === "linux"
      ? ["/var/lib/orquester/devices/tools", "/var/lib/orquester/devices/android-sdk\n/var/lib/orquester/devices/avd"]
      : ["/var/lib/orquester/devices/tools", "~/.agent-device/apple-runner"]));
    for (const saved of savedCaches) {
      const restored = box.find((step) => step.with?.path === saved.with!.path)!;
      assert.ok(restored, "every saved cache can be restored by a box");
      let restoreKey = String(restored.with!.key);
      const osChoice = /^\$\{\{ inputs\.os == 'linux' && '([^']+)' \|\| '([^']+)' \}\}$/.exec(restoreKey);
      if (osChoice) restoreKey = osChoice[os === "linux" ? 1 : 2]!;
      assert.equal(saved.with!.key, restoreKey);
    }
    const hit = stepsFor(job.steps, { os }, { "steps.android.outputs.cache-hit": "true", "steps.tools.outputs.cache-hit": "true", "steps.runner.outputs.cache-hit": "true", "steps.xcode.outputs.build": "17E202" });
    assert.ok(!hit.some((step) => step.uses === "actions/cache/save@v4"), "cache hits do no save work");
    assert.ok(!hit.some((step) => /sdkmanager|npm ci|simctl create/.test(step.run ?? "")), "cache hits do no install/build work");
    assert.equal(job.steps.find((step) => step.id === "tools")!.with!["lookup-only"], undefined);
  }
  const android = workflow.jobs.linux.steps.find((step) => step.id === "android")!;
  assert.equal(android.with!["lookup-only"], true);
});



test("the step scripts pass bash -n", () => {
  const steps = [...parsed().jobs.box.steps, ...Object.values(parsedCacheWorkflow().jobs).flatMap((job) => job.steps)];
  for (const script of new Set(steps.flatMap((step) => step.run ? [step.run] : []))) {
    const syntax = spawnSync("bash", ["-n"], { input: script, encoding: "utf8" });
    assert.equal(syntax.status, 0, syntax.stderr);
  }
});

test("the input check rejects values that could break out of the run", () => {
  const check = (env: Record<string, string>): number | null =>
    spawnSync("bash", ["-c", parsed().jobs.box.steps.find((step) => step.env?.LIFETIME)!.run!], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env }, encoding: "utf8" }).status;
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
    spawnSync("bash", ["-c", parsedCacheWorkflow().jobs.linux.steps.find((step) => step.env?.REQUEST_ID)!.run!], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env }, encoding: "utf8" }).status;
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

    const child = spawn("bash", ["-eo", "pipefail", "-c", parsed().jobs.box.steps.find((step) => step.env?.AGENT_PLATFORM)!.run!], {
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
