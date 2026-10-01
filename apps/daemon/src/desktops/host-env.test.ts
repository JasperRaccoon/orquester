import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SOCKET_PATH_LIMIT,
  appEnvFileContent,
  isReservedAppEnvKey,
  buildAppEnv,
  defaultPaContent,
  desktopLayout,
  fallbackSocketDir,
  hostScriptArgs
} from "./host-env.ts";

const layout = desktopLayout("/srv/app/daemon/desktops/abc123", null);

function env(overrides: Partial<Parameters<typeof buildAppEnv>[0]> = {}): Record<string, string> {
  return buildAppEnv({
    base: { PATH: "/usr/bin", HOME: "/home/u" },
    layout,
    display: 7,
    renderNode: false,
    renderThreads: 4,
    user: {},
    ...overrides
  });
}

test("app env: scrubs tmux, ORQUESTER_* and Wayland from the base, adds the desktop wiring", () => {
  const result = env({
    base: {
      PATH: "/usr/bin",
      TMUX: "/tmp/tmux-1/default,1,0",
      TMUX_PANE: "%1",
      ORQUESTER_HTTP_PASSWORD: "secret",
      WAYLAND_DISPLAY: "wayland-0",
      DISPLAY: ":99",
      KEEP: "yes"
    }
  });
  assert.equal(result.TMUX, undefined);
  assert.equal(result.TMUX_PANE, undefined);
  assert.equal(result.ORQUESTER_HTTP_PASSWORD, undefined);
  assert.equal(result.WAYLAND_DISPLAY, undefined);
  assert.equal(result.KEEP, "yes");
  assert.equal(result.DISPLAY, ":7");
  assert.equal(result.XAUTHORITY, "/srv/app/daemon/desktops/abc123/Xauthority");
  assert.equal(result.PULSE_SERVER, "unix:/srv/app/daemon/desktops/abc123/pulse/native");
  assert.equal(result.PULSE_CLIENTCONFIG, "/srv/app/daemon/desktops/abc123/client.conf");
  assert.equal(result.DBUS_SESSION_BUS_ADDRESS, "unix:path=/srv/app/daemon/desktops/abc123/bus");
  assert.equal(result.XDG_RUNTIME_DIR, "/srv/app/daemon/desktops/abc123/run");
});

test("app env: software GL only without a render node", () => {
  assert.equal(env({ renderNode: false }).LIBGL_ALWAYS_SOFTWARE, "1");
  assert.equal(env({ renderNode: true, base: { LIBGL_ALWAYS_SOFTWARE: "1" } }).LIBGL_ALWAYS_SOFTWARE, undefined);
});

test("app env: LP_NUM_THREADS from the desktop, the user's value wins", () => {
  assert.equal(env().LP_NUM_THREADS, "4");
  assert.equal(env({ renderThreads: 2 }).LP_NUM_THREADS, "2");
  const overridden = env({ user: { LP_NUM_THREADS: "8", DISPLAY: ":1", FOO: "bar" } });
  assert.equal(overridden.LP_NUM_THREADS, "8");
  assert.equal(overridden.DISPLAY, ":1");
  assert.equal(overridden.FOO, "bar");
});

test("socket dir fallback above 100 bytes", () => {
  const host = { tmpDir: "/tmp", uid: 1000 };
  assert.equal(fallbackSocketDir("/var/lib/orquester/daemon/desktops/abcdef012345", "abcdef012345", host), null);
  const long = `/${"x".repeat(90)}/desktops/abcdef012345`;
  assert.ok(Buffer.byteLength(join(long, "pulse", "native")) > SOCKET_PATH_LIMIT);
  const fallback = fallbackSocketDir(long, "abcdef012345", host);
  assert.equal(fallback, "/tmp/orqd-1000-abcdef012345");
  const moved = desktopLayout(long, fallback);
  assert.equal(moved.vncSocket, "/tmp/orqd-1000-abcdef012345/vnc.sock");
  assert.equal(moved.pulseSocket, "/tmp/orqd-1000-abcdef012345/pulse/native");
  assert.equal(moved.bus, "/tmp/orqd-1000-abcdef012345/bus");
  // Everything that is not a socket stays in the desktop dir.
  assert.equal(moved.xauthority, `${long}/Xauthority`);
  assert.equal(moved.ready, `${long}/ready`);
  assert.equal(hostScriptArgs(moved, { width: 800, height: 600 }, true).at(-1), fallback);
});

test("default.pa loads one native socket, the orq null sink as default", () => {
  const text = defaultPaContent(layout);
  assert.match(text, /module-native-protocol-unix socket="\/srv\/app\/daemon\/desktops\/abc123\/pulse\/native" auth-anonymous=1/);
  assert.match(text, /module-null-sink sink_name=orq/);
  assert.match(text, /set-default-sink orq/);
});

test("host script args carry no secrets: dir, size, audio flag, socket dir", () => {
  const args = hostScriptArgs(layout, { width: 1280, height: 800 }, false);
  assert.deepEqual(args.slice(1), [layout.dir, "1280", "800", "0", layout.dir]);
  assert.match(args[0], /assets\/desktop-host\.sh$/);
});

test("env file round-trips nasty values through a real sh unchanged", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "orq-desktop-env-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const values: Record<string, string> = {
    QUOTES: `a'b"c''d`,
    DOLLAR: "$HOME ${PATH} $(id) `id`",
    SPACES: "  lead and trail  ",
    UNICODE: "héllo – 日本語 🎧",
    BACKSLASH: "a\\b\\\\c\\n",
    EMPTY: "",
    GLOB: "* ? [a-z]",
    SEMI: "x; rm -rf /tmp/nothing & echo pwned | cat"
  };
  const command = `sh -c 'echo "$1"' _ "it's $HOME"`;
  const file = join(dir, "app.env");
  await writeFile(file, appEnvFileContent({ ...values, "BAD-KEY": "skipped", PATH: process.env.PATH ?? "/usr/bin" }, "/tmp/some dir", command));
  const out = await new Promise<string>((resolve, reject) =>
    execFile(
      "/bin/sh",
      ["-c", 'set -a; . "$1"; set +a; env -0', "sh", file],
      { env: {} },
      (error, stdout) => (error ? reject(error) : resolve(stdout))
    )
  );
  const seen = new Map<string, string>();
  for (const entry of out.split("\0")) {
    const eq = entry.indexOf("=");
    if (eq > 0) seen.set(entry.slice(0, eq), entry.slice(eq + 1));
  }
  for (const [key, value] of Object.entries(values)) {
    assert.equal(seen.get(key), value, key);
  }
  assert.equal(seen.get("ORQ_APP_CWD"), "/tmp/some dir");
  assert.equal(seen.get("ORQ_APP_COMMAND"), command);
  assert.equal(seen.has("BAD-KEY"), false);
});

test("env file never writes app-run.sh's own names or bash read-only variables", () => {
  const content = appEnvFileContent({ __orq_base: "/tmp/x", ORQ_APP_CWD: "/etc", UID: "0", KEEP: "yes" }, "/w/p", "xterm");
  assert.doesNotMatch(content, /__orq_base|^UID=/m);
  assert.match(content, /^KEEP='yes'$/m);
  assert.match(content, /^ORQ_APP_CWD='\/w\/p'$/m);
  assert.ok(isReservedAppEnvKey("__orq_dir") && isReservedAppEnvKey("ORQ_APP_COMMAND") && !isReservedAppEnvKey("ORQ"));
});
