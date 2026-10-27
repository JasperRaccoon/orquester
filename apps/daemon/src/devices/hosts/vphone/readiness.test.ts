import assert from "node:assert/strict";
import test from "node:test";

import { parseApiListenPort, parseMachineList, parseStageBanner, parseTemplateList, createStageIndex, machineNameForLease } from "./cli.ts";
import {
  bootArgIsSet,
  checkAmfi,
  checkMacos,
  checkNotVm,
  checkResearchGuests,
  checkTemplate,
  evaluateVphoneReadiness,
  locateVphoneCli,
  probeVphoneHost,
  VPHONE_TEMPLATE_ACTION,
  type VphoneProbe
} from "./readiness.ts";
import { FakeMacLink, VPHONE_CLI_PATH } from "./testing.ts";

const cli = { command: "/Applications/VPhone.bundle/Contents/MacOS/vphone-cli", prefix: [] };

test("vphone-cli is found at $VPHONE_CLI_PATH, on PATH, in the Homebrew prefixes, else through Launchpad", () => {
  const executable = new Set(["/custom/vphone-cli", "/opt/homebrew/bin/vphone-cli", "/Applications/vphone-launchpad.app/Contents/MacOS/vphone-launchpad-cli"]);
  assert.deepEqual(locateVphoneCli({ envPath: "/custom/vphone-cli", whichCli: null, whichLaunchpad: null, executable }), { command: "/custom/vphone-cli", prefix: [] });
  assert.deepEqual(locateVphoneCli({ envPath: "/missing", whichCli: null, whichLaunchpad: null, executable }), { command: "/opt/homebrew/bin/vphone-cli", prefix: [] });
  assert.deepEqual(locateVphoneCli({ envPath: null, whichCli: null, whichLaunchpad: null, executable: new Set(["/Applications/vphone-launchpad.app/Contents/MacOS/vphone-launchpad-cli"]) }), {
    command: "/Applications/vphone-launchpad.app/Contents/MacOS/vphone-launchpad-cli",
    prefix: ["exec"]
  });
  assert.equal(locateVphoneCli({ envPath: null, whichCli: null, whichLaunchpad: null, executable: new Set() }), null);
});

test("host checks read captured outputs, each failure names its exact fix", () => {
  assert.equal(checkMacos("15.6.1\n").state, "ok");
  assert.equal(checkMacos("26.1").state, "ok");
  const old = checkMacos("14.7");
  assert.equal(old.state, "error");
  assert.match(old.detail!, /macOS 14\.7.*Software Update/);

  assert.equal(checkNotVm("0\n").state, "ok");
  assert.match(checkNotVm("1").detail!, /virtual machine.*physical/);
  assert.equal(checkNotVm("").state, "error");

  assert.equal(checkResearchGuests("Allow Research Guests status: enabled.").state, "ok");
  const off = checkResearchGuests("Allow Research Guests status: disabled.");
  assert.equal(off.state, "missing");
  assert.match(off.detail!, /Recovery.*csrutil allow-research-guests enable/);
  assert.equal(off.fixActionId, undefined, "Orquester never changes SIP");

  assert.equal(bootArgIsSet("boot-args\tamfi_get_out_of_my_way=1 -v", "amfi_get_out_of_my_way"), true);
  assert.equal(bootArgIsSet("boot-args\tamfi_get_out_of_my_way=0x0", "amfi_get_out_of_my_way"), false);
  assert.equal(checkAmfi({ processes: "", bootArgs: "", preflight: { exitCode: 0, lastLine: "ok" }, cli }).state, "ok");
  assert.equal(checkAmfi({ processes: "/usr/bin/python3 /usr/local/bin/amfidont daemon", bootArgs: "", preflight: null, cli }).detail, "amfidont is running");
  assert.equal(checkAmfi({ processes: "/usr/local/bin/vphone-amfidont", bootArgs: "", preflight: null, cli }).state, "missing");
  const refused = checkAmfi({ processes: "", bootArgs: "", preflight: { exitCode: 1, lastLine: "error: AMFI refused vphone-vm" }, cli });
  assert.equal(refused.state, "error");
  assert.match(refused.detail!, /AMFI refused vphone-vm/);
  assert.match(refused.detail!, /sudo "\/Applications\/VPhone\.bundle\/Contents\/MacOS\/vphone-escalator" allow "\/Applications\/VPhone\.bundle\/Contents\/MacOS\/vphone-vm"/);
  assert.match(refused.detail!, /amfi_get_out_of_my_way=1/);
  assert.equal(refused.fixActionId, undefined, "Orquester never changes AMFI");
});

test("the template check: ok with a current template or the base machine; otherwise a fix action only when Orquester can build it", () => {
  const none = { templates: [], machines: [], cli };
  assert.equal(checkTemplate({ ...none, templates: [{ id: "abc1", summary: "iOS 26", stale: false }] }, { sourcesSet: false, canElevate: false }).state, "ok");
  assert.equal(checkTemplate({ ...none, machines: [{ name: "orq-base", iosVersion: null, template: null, udid: null }] }, { sourcesSet: false, canElevate: false }).state, "ok");
  const stale = checkTemplate({ ...none, templates: [{ id: "abc1", summary: "iOS 26", stale: true }] }, { sourcesSet: false, canElevate: false });
  assert.equal(stale.state, "missing");
  assert.match(stale.detail!, /stale/);
  assert.match(stale.detail!, /sudo vphone-cli vm create orq-base --iphone-source/);
  assert.equal(checkTemplate(none, { sourcesSet: true, canElevate: true }).fixActionId, VPHONE_TEMPLATE_ACTION);
  assert.equal(checkTemplate(none, { sourcesSet: true, canElevate: false }).fixActionId, undefined);
  assert.match(checkTemplate(none, { sourcesSet: true, canElevate: false }).detail!, /passwordless sudo/);
});

test("evaluate: every check in order", () => {
  const probe: VphoneProbe = {
    cli: null,
    macosVersion: "26.1",
    hvVmmPresent: "0",
    researchGuests: "Allow Research Guests status: enabled.",
    bootArgs: "",
    processes: "",
    preflight: null,
    templates: [],
    machines: []
  };
  const checks = evaluateVphoneReadiness(probe, { sourcesSet: false, canElevate: false });
  assert.deepEqual(checks.map((check) => [check.id, check.state]), [
    ["vphone-cli", "missing"],
    ["macos", "ok"],
    ["not-vm", "ok"],
    ["research-guests", "ok"],
    ["amfi", "missing"],
    ["template", "missing"]
  ]);
  assert.match(checks[0]!.detail!, /ln -s \/Applications\/vphone-launchpad\.app\/Contents\/MacOS\/vphone-launchpad-cli \/opt\/homebrew\/bin\//);
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
  assert.equal(createStageIndex("Restore phase"), 3);
  assert.equal(createStageIndex("JB Finalize"), -1);
  assert.equal(machineNameForLease("1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed"), "orq-1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed".slice(0, 52));
  assert.equal(machineNameForLease("../x y"), "orq-xy");
});
