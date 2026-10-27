import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse } from "yaml";

import { blacksmithWorkflowTemplate } from "./workflow-template.ts";

interface Step {
  name: string;
  run?: string;
  uses?: string;
  env?: Record<string, string>;
  with?: Record<string, string>;
}

function parsed(options?: Parameters<typeof blacksmithWorkflowTemplate>[0]) {
  return parse(blacksmithWorkflowTemplate(options)) as {
    name: string;
    "run-name": string;
    on: { workflow_dispatch: { inputs: Record<string, { type: string; options?: string[] }> } };
    permissions: Record<string, string>;
    jobs: { box: { "runs-on": string; "timeout-minutes": string; steps: Step[] } };
  };
}

test("the workflow: dispatch inputs, OIDC permission, runner choice, lifetime, steps", () => {
  const workflow = parsed();
  assert.equal(workflow["run-name"], "orq-${{ inputs.box_id }}");
  for (const input of ["box_id", "lifetime_minutes", "daemon_url", "runner"]) assert.ok(workflow.on.workflow_dispatch.inputs[input]);
  assert.ok(workflow.on.workflow_dispatch.inputs.runner!.options!.includes("blacksmith-6vcpu-macos-26"));
  assert.ok(workflow.on.workflow_dispatch.inputs.runner!.options!.includes("blacksmith-12vcpu-macos-15"));
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

test("the step scripts pass bash -n", () => {
  for (const { run: script } of parsed().jobs.box.steps) {
    if (!script) continue;
    const syntax = spawnSync("bash", ["-n"], { input: script, encoding: "utf8" });
    assert.equal(syntax.status, 0, syntax.stderr);
  }
});

test("the input check rejects values that could break out of the run", () => {
  const script = parsed().jobs.box.steps.find((step) => step.env?.LIFETIME)!.run!;
  const check = (env: Record<string, string>): number | null =>
    spawnSync("bash", ["-c", script], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env }, encoding: "utf8" }).status;
  const good = { BOX_ID: "box-0123456789ab", DAEMON_URL: "https://orq.example.com:8443/t4", LIFETIME: "120" };
  assert.equal(check(good), 0);
  assert.equal(check({ ...good, BOX_ID: "x; curl evil" }), 1);
  assert.equal(check({ ...good, DAEMON_URL: "http://orq.example.com" }), 1);
  assert.equal(check({ ...good, DAEMON_URL: "https://orq.example.com/$(id)" }), 1);
  assert.equal(check({ ...good, LIFETIME: "7201" }), 1);
  assert.equal(check({ ...good, LIFETIME: "0" }), 1);
  assert.equal(check({ ...good, LIFETIME: "1e3" }), 1);
});

test("the download step gets an OIDC token for the daemon origin and sends it as GitHubOIDC", async (t) => {
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
    if (request.url === "/base/api/boxes/agent/darwin-arm64" && request.headers.authorization === "GitHubOIDC aaa.bbb.ccc") {
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

  const script = parsed().jobs.box.steps.find((step) => step.env?.DAEMON_URL && !step.env.LIFETIME)!.run!;
  const child = spawn("bash", ["-eo", "pipefail", "-c", script], {
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: home,
      RUNNER_TEMP: runnerTemp,
      ACTIONS_ID_TOKEN_REQUEST_URL: `${origin}/oidc?api-version=2.0`,
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-token-SECRET",
      BOX_ID: "box-0123456789ab",
      DAEMON_URL: `${origin}/base/`
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
  assert.equal(seen[1]!.url, "/base/api/boxes/agent/darwin-arm64");
  assert.equal(seen[1]!.authorization, "GitHubOIDC aaa.bbb.ccc");
  assert.equal(seen[1]!.boxId, "box-0123456789ab");
  assert.match(await readFile(join(home, ".orq-agent", "bin", "orq-agent"), "utf8"), /0\.0\.0-test/);
});
