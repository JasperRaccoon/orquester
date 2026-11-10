import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  VoxlProbe,
  filterVoxlClientText,
  parseVoxlEnvFile,
  voxlArgs,
  voxlBindFailed,
  voxlEnvFileContent,
  voxlFailureLine,
  voxlListening
} from "./voxl.ts";

const PASSWORD = "c0ffee".repeat(8);

test("voxl's argv carries no secret and pins loopback, no file transfer, no audio; the password is in its env file", () => {
  const args = voxlArgs(43210);
  assert.ok(!args.join(" ").includes(PASSWORD));
  for (const flag of ["--addr=127.0.0.1", "--port=43210", "--file-transfers=none", "--audio-enabled=false", "--enable-resize=true", "--enable-clipboard=true"]) {
    assert.ok(args.includes(flag), flag);
  }
  const env = voxlEnvFileContent({ display: 7, xauthority: "/d/it's/Xauthority", runDir: "/d/run", password: PASSWORD, port: 43210 });
  assert.match(env, /^DISPLAY=':7'$/m);
  assert.match(env, /^XAUTHORITY='\/d\/it'\\''s\/Xauthority'$/m);
  assert.match(env, new RegExp(`^VOXL_PASSWORD='${PASSWORD}'$`, "m"));
  // What a restarted daemon reads back to reach a voxl that is still running.
  assert.deepEqual(parseVoxlEnvFile(env), { port: 43210, password: PASSWORD });
  assert.equal(parseVoxlEnvFile("DISPLAY=':7'\n"), null);
  assert.equal(parseVoxlEnvFile(null), null);
});

test("voxl's log: the listen line for this port, a taken port, and the line that says why it stopped", () => {
  const log = [
    "[2026-11-10T06:42:01Z WARN  voxl::capture] Xvfb framebuffer not found for :7; falling back to GetImage",
    "[2026-11-10T06:42:01Z INFO  voxl] listening on http://127.0.0.1:43210",
    ""
  ].join("\n");
  assert.equal(voxlListening(log, 43210), true);
  assert.equal(voxlListening(log, 4321), false);
  const panic = "thread 'main' panicked at src/lib.rs:410:10:\nbind: Os { code: 98, kind: AddrInUse, message: \"Address already in use\" }\n";
  assert.equal(voxlBindFailed(panic), true);
  assert.equal(voxlBindFailed(log), false);
  assert.equal(voxlFailureLine(`${log}[x ERROR voxl] video init failed: X connect: refused\n`), "[x ERROR voxl] video init failed: X connect: refused");
  assert.equal(voxlFailureLine("[x WARN voxl::capture] Xvfb framebuffer not found; falling back to GetImage\n"), "", "the GetImage fallback is no reason");
});

test("a viewer's sz is clamped to the desktop size limits or dropped; other commands pass unchanged", () => {
  assert.equal(filterVoxlClientText("sz,1920,1080"), "sz,1920,1080");
  assert.equal(filterVoxlClientText("sz,32768,32768"), "sz,7680,4320");
  assert.equal(filterVoxlClientText("sz,10,10"), "sz,320,240");
  assert.equal(filterVoxlClientText("sz,-1,5"), null);
  assert.equal(filterVoxlClientText("sz,1e9,5"), null);
  assert.equal(filterVoxlClientText("sz"), null);
  assert.equal(filterVoxlClientText("m,10,20"), "m,10,20");
  assert.equal(filterVoxlClientText("size,1,1"), "size,1,1");
});

test("host status: voxl from ORQUESTER_VOXL_BIN, else <appdir>/bin, else PATH; a binary that does not run is unavailable", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "orq-voxl-probe-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const appdir = join(root, "appdir");
  const pathDir = join(root, "path");
  mkdirSync(join(appdir, "bin"), { recursive: true });
  mkdirSync(pathDir);
  const script = (path: string, body: string) => {
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
  };
  const probe = (env: NodeJS.ProcessEnv) => new VoxlProbe({ baseDir: appdir, env: () => env, path: () => pathDir }).status();

  // (A host with deploy's /usr/local/bin/voxl finds that one last.)
  if (!existsSync("/usr/local/bin/voxl")) {
    const none = await probe({});
    assert.equal(none.available, false);
    assert.equal(none.path, null);
    assert.match(none.reason ?? "", /not installed/);
  }

  script(join(pathDir, "voxl"), "echo 'voxl 0.3.3'");
  assert.deepEqual(await probe({}), { available: true, version: "0.3.3", path: join(pathDir, "voxl") });

  script(join(appdir, "bin", "voxl"), "echo 'voxl 0.3.4'");
  assert.deepEqual(await probe({}), { available: true, version: "0.3.4", path: join(appdir, "bin", "voxl") });

  const broken = join(root, "broken-voxl");
  script(broken, "echo 'error while loading shared libraries: libx264.so.164' >&2; exit 127");
  const failed = await probe({ ORQUESTER_VOXL_BIN: broken });
  assert.equal(failed.available, false);
  assert.equal(failed.path, broken);
  assert.match(failed.reason ?? "", /libx264\.so\.164/);

  const missing = await probe({ ORQUESTER_VOXL_BIN: join(root, "nope") });
  assert.equal(missing.available, false, "an explicit binary that is not there is not replaced by another");
});
