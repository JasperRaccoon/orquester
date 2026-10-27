import assert from "node:assert/strict";
import test from "node:test";

import { parseApiListenPort, parseMachineList, parseStageBanner, parseTemplateList, machineNameForLease } from "./cli.ts";
import {
  evaluateVphoneReadiness,
  probeVphoneHost,
  VPHONE_TEMPLATE_ACTION,
  type VphoneProbe
} from "./readiness.ts";
import { FakeMacLink, VPHONE_CLI_PATH } from "./testing.ts";

const cli = { command: "/Applications/VPhone.bundle/Contents/MacOS/vphone-cli", prefix: [] };

function readiness(id: string, overrides: Partial<VphoneProbe>, context = { sourcesSet: false, canElevate: false }) {
  const ready: VphoneProbe = { cli, macosVersion: "26.1", hvVmmPresent: "0", researchGuests: "Allow Research Guests status: enabled.", bootArgs: "", processes: "", preflight: { exitCode: 0, lastLine: "ok" }, templates: [{ id: "t1", summary: "iOS", stale: false }], machines: [] };
  const check = evaluateVphoneReadiness({ ...ready, ...overrides }, context).find((check) => check.id === id);
  assert.ok(check, `Missing required ${id} readiness gate`);
  return check;
}

test("vphone-cli is found at $VPHONE_CLI_PATH, on PATH, in the Homebrew prefixes, else through Launchpad", async (t) => {
  const locate = async (envPath: string | null, executable: Set<string>) => {
    const mac = new FakeMacLink({ answer: (command, args) => {
      if (command === "/usr/bin/printenv") return envPath ? { stdout: envPath } : { exitCode: 1 };
      if (command === "/usr/bin/which") return { exitCode: 1 };
      if (command === "/bin/test") return { exitCode: executable.has(args[1]!) ? 0 : 1 };
      return undefined;
    } });
    t.after(() => mac.close());
    return (await probeVphoneHost(mac)).cli;
  };
  const executable = new Set(["/custom/vphone-cli", "/opt/homebrew/bin/vphone-cli", "/Applications/vphone-launchpad.app/Contents/MacOS/vphone-launchpad-cli"]);
  assert.deepEqual(await locate("/custom/vphone-cli", executable), { command: "/custom/vphone-cli", prefix: [] });
  assert.deepEqual(await locate("/missing", executable), { command: "/opt/homebrew/bin/vphone-cli", prefix: [] });
  assert.deepEqual(await locate(null, new Set(["/Applications/vphone-launchpad.app/Contents/MacOS/vphone-launchpad-cli"])), {
    command: "/Applications/vphone-launchpad.app/Contents/MacOS/vphone-launchpad-cli",
    prefix: ["exec"]
  });
  assert.equal(await locate(null, new Set()), null);
});

test("host checks read captured outputs, each failure names its exact fix", () => {
  assert.equal(readiness("macos", { macosVersion: "15.6.1\n" }).state, "ok");
  assert.equal(readiness("macos", { macosVersion: "26.1" }).state, "ok");
  const old = readiness("macos", { macosVersion: "14.7" });
  assert.equal(old.state, "error");
  assert.match(old.detail!, /macOS 14\.7.*Software Update/);

  assert.equal(readiness("not-vm", { hvVmmPresent: "0\n" }).state, "ok");
  assert.match(readiness("not-vm", { hvVmmPresent: "1" }).detail!, /virtual machine.*physical/);
  assert.equal(readiness("not-vm", { hvVmmPresent: "" }).state, "error");

  assert.equal(readiness("research-guests", { researchGuests: "Allow Research Guests status: enabled." }).state, "ok");
  const off = readiness("research-guests", { researchGuests: "Allow Research Guests status: disabled." });
  assert.equal(off.state, "missing");
  assert.match(off.detail!, /Recovery.*csrutil allow-research-guests enable/);
  assert.equal(off.fixActionId, undefined, "Orquester never changes SIP");

  assert.equal(readiness("amfi", { processes: "", bootArgs: "boot-args\tamfi_get_out_of_my_way=1 -v", preflight: null, cli }).state, "ok");
  assert.equal(readiness("amfi", { processes: "", bootArgs: "boot-args\tamfi_get_out_of_my_way=0x0", preflight: null, cli }).state, "missing");
  assert.equal(readiness("amfi", { processes: "", bootArgs: "", preflight: { exitCode: 0, lastLine: "ok" }, cli }).state, "ok");
  assert.equal(readiness("amfi", { processes: "/usr/bin/python3 /usr/local/bin/amfidont daemon", bootArgs: "", preflight: null, cli }).state, "ok");
  assert.equal(readiness("amfi", { processes: "/usr/local/bin/vphone-amfidont", bootArgs: "", preflight: null, cli }).state, "missing");
  const refused = readiness("amfi", { processes: "", bootArgs: "", preflight: { exitCode: 1, lastLine: "error: AMFI refused vphone-vm" }, cli });
  assert.equal(refused.state, "error");
  assert.match(refused.detail!, /AMFI refused vphone-vm/);
  assert.match(refused.detail!, /sudo "\/Applications\/VPhone\.bundle\/Contents\/MacOS\/vphone-escalator" allow "\/Applications\/VPhone\.bundle\/Contents\/MacOS\/vphone-vm"/);
  assert.match(refused.detail!, /amfi_get_out_of_my_way=1/);
  assert.equal(refused.fixActionId, undefined, "Orquester never changes AMFI");
  // Every independently required safety gate reaches the public readiness result.
  const unsafe = evaluateVphoneReadiness({ cli, macosVersion: "14.7", hvVmmPresent: "1", researchGuests: "Allow Research Guests status: disabled.", bootArgs: "", processes: "", preflight: null, templates: [], machines: [] }, { sourcesSet: false, canElevate: false });
  for (const [id, state] of [["macos", "error"], ["not-vm", "error"], ["research-guests", "missing"], ["amfi", "missing"], ["template", "missing"]]) assert.equal(unsafe.find((check) => check.id === id)?.state, state);

  const missingCli = evaluateVphoneReadiness({ cli: null, macosVersion: "26.1", hvVmmPresent: "0", researchGuests: "Allow Research Guests status: enabled.", bootArgs: "", processes: "", preflight: null, templates: [], machines: [] }, { sourcesSet: false, canElevate: false }).find((check) => check.id === "vphone-cli")!;
  assert.equal(missingCli.state, "missing");
  assert.match(missingCli.detail!, /ln -s \/Applications\/vphone-launchpad\.app\/Contents\/MacOS\/vphone-launchpad-cli \/opt\/homebrew\/bin\//);
});

test("the template check: ok with a current template or the base machine; otherwise a fix action only when Orquester can build it", () => {
  const none = { templates: [], machines: [], cli };
  assert.equal(readiness("template", { ...none, templates: [{ id: "abc1", summary: "iOS 26", stale: false }] }, { sourcesSet: false, canElevate: false }).state, "ok");
  assert.equal(readiness("template", { ...none, machines: [{ name: "orq-base", iosVersion: null, template: null, udid: null }] }, { sourcesSet: false, canElevate: false }).state, "ok");
  const stale = readiness("template", { ...none, templates: [{ id: "abc1", summary: "iOS 26", stale: true }] }, { sourcesSet: false, canElevate: false });
  assert.equal(stale.state, "missing");
  assert.match(stale.detail!, /stale/);
  assert.match(stale.detail!, /sudo vphone-cli vm create orq-base --iphone-source/);
  assert.equal(readiness("template", none, { sourcesSet: true, canElevate: true }).fixActionId, VPHONE_TEMPLATE_ACTION);
  assert.equal(readiness("template", none, { sourcesSet: true, canElevate: false }).fixActionId, undefined);
  assert.match(readiness("template", none, { sourcesSet: true, canElevate: false }).detail!, /passwordless sudo/);
});


test("probe: runs each command without a shell over the box link", async () => {
  const mac = new FakeMacLink();
  const probe = await probeVphoneHost(mac);
  assert.deepEqual(probe.cli, { command: VPHONE_CLI_PATH, prefix: [] });
  assert.equal(probe.macosVersion, "26.1");
  assert.equal(probe.hvVmmPresent, "0");
  assert.equal(probe.preflight?.exitCode, 0);
  assert.deepEqual(probe.templates.map((template) => template.id), ["3f2a91c0d4e7"]);
  assert.ok(evaluateVphoneReadiness(probe, { sourcesSet: false, canElevate: false }).every((check) => check.state === "ok"));
  assert.ok(mac.execs.every((exec) => !["/bin/sh", "/bin/bash", "/bin/zsh"].includes(exec.command)));
});

test("vphone-cli outputs: lists, the API address, stage banners", () => {
  assert.deepEqual(parseMachineList('[{"name":"a","restoreInfo":{"ios":{"version":"26.1","build":"x"}},"template":"t1"},{"bad":1}]'), [
    { name: "a", iosVersion: "26.1", template: "t1", udid: null }
  ]);
  assert.deepEqual(parseMachineList("warning: skipping x\nnot json"), []);
  assert.deepEqual(parseTemplateList('{"templates":[{"id":"t1","key":{"summary":"s"},"stale":true}],"building":[]}'), [{ id: "t1", summary: "s", stale: true }]);
  assert.equal(parseApiListenPort("[api] HTTP/WebSocket API: http://127.0.0.1:8765"), 8765);
  assert.equal(parseApiListenPort("[api] token: 3f9c"), null);
  assert.equal(parseStageBanner("=== CFW install (host-mount) ==="), "CFW install (host-mount)");
  assert.equal(parseStageBanner("==== fw prepare ===="), "fw prepare");
  assert.equal(parseStageBanner("progress 3/10"), null);
  assert.equal(machineNameForLease("1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed"), "orq-1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed");
  assert.equal(machineNameForLease("../x y"), "orq-xy");
});
