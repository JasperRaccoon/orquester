// The "Better TS Typecheck" preload (spec §3.2): a dependency-free CommonJS file
// every Orquester session loads into each Node process through
// `NODE_OPTIONS=--require`. While the plugin is on, in a process running
// TypeScript's `tsc` inside a workspace, it runs the active engine's installed
// binary (tsrs or tsc-rs) with the same arguments and leaves with its status;
// everywhere else it returns at once and the process runs unchanged.
//
// The file runs inside arbitrary user processes on any Node >= 18, so it is
// plain ES5-style CommonJS, swallows every error, prints nothing outside a
// redirect, and does no file I/O unless `argv[1]` looks like tsc.
//
// Two renderings: the host's (`renderTsRustPreload`), which reads plugins.json
// and the daemon's own install dirs, and a box's (`renderTsRustBoxPreload`,
// Ephemeral AI VMs spec §10), which bakes in only box paths — in the box's
// path syntax — and reads the small state file the daemon pushes to the box.

import { dirname, join, posix, resolve, win32 } from "node:path";

import { type BoxOs, TS_RUST_PLUGIN_ID, type TsCheckerEngine } from "@orquester/api";
import { tsRustPluginDir, tsrsEngineDir } from "@orquester/config";

import { writeFileAtomic } from "../../agent-hooks.ts";

export interface TsRustPreloadOptions {
  /** Absolute path of plugins.json, baked into the preload. */
  statePath: string;
  /** Resolved workspaces root, baked into the preload. */
  workspacesRoot: string;
  /**
   * The workspaces root as configured (absolute, symlinks kept), when that is
   * a different path to `workspacesRoot`: a `tsc` reached through it matches too.
   */
  configuredWorkspacesRoot?: string;
  /**
   * The engines with a build on this host, and the one used when plugins.json
   * names none of them: the plugins service's own rule, so both pick the same
   * engine. Default: both supported, tsc-rs the default.
   */
  supportedEngines?: readonly TsCheckerEngine[];
  defaultEngine?: TsCheckerEngine;
}

/**
 * The engines' `versions/` dirs. `statePath` is `pluginsConfigPath(appdir)`
 * (`<appdir>/daemon/plugins.json`), so the appdir is two levels up.
 */
function versionsDirs(statePath: string): Record<TsCheckerEngine, string> {
  const appdir = dirname(dirname(resolve(statePath)));
  return {
    "tsc-rs": resolve(join(tsRustPluginDir(appdir), "versions")),
    tsrs: resolve(join(tsrsEngineDir(appdir), "versions"))
  };
}

// The preload's code after its baked constants, in three parts: steps 1–2,
// step 3 (where the state comes from: plugins.json on the host, the daemon's
// state file in a box), and the redirect. Raw, so its regexes and string
// escapes are written exactly as they appear in preload.cjs.
const PRELOAD_HEAD = String.raw`
  // Ends in typescript/bin/tsc or typescript/lib/tsc.js, with either separator.
  var TSC_SCRIPT = /[\\/]typescript[\\/](?:bin[\\/]tsc|lib[\\/]tsc\.js)$/;
  // A version names a directory under VERSIONS_DIRS: no separators, no "..".
  var SAFE_VERSION = /^[0-9A-Za-z][0-9A-Za-z.+_-]*$/;
  // Passed on to the engine while this process waits for it (those this OS has).
  var FORWARDED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT", "SIGBREAK"];
  // Arguments that already set tsrs's checker threads (tsc options ignore case).
  var CHECKERS_SET = /^--(?:checkers|singlethreaded)(?:=|$)/i;
  // tsrs's checker threads when the arguments set none: its default is one per
  // core up to 16, which starves the rest of a busy host.
  var TSRS_CHECKERS = "4";

  try {
    var script = process.argv[1];
    if (typeof script !== "string" || script.length === 0) return;
    var path = require("path");

    // 1. Only tsc. The unresolved path is a string test; the real path is looked
    //    up only for a script named like tsc (npm's node_modules/.bin/tsc symlink).
    var unresolved = path.resolve(script);
    var name = path.basename(unresolved);
    if (!TSC_SCRIPT.test(unresolved) && name !== "tsc" && name !== "tsc.js") return;
    var fs = require("fs");
    var real = fs.realpathSync(unresolved);
    if (!TSC_SCRIPT.test(unresolved) && !TSC_SCRIPT.test(real)) return;
    if (!require("worker_threads").isMainThread) return;

    // 2. Inside a workspace: a first segment under a root of the UNRESOLVED
    //    script path (pnpm's global virtual store can put the real one
    //    elsewhere), else of the working directory.
    var workspaceOf = function (candidate) {
      for (var i = 0; i < WORKSPACES_ROOTS.length; i++) {
        var relative = path.relative(WORKSPACES_ROOTS[i], candidate);
        if (relative.length === 0 || path.isAbsolute(relative)) continue;
        var first = relative.split(/[\\/]/)[0];
        if (first.length > 0 && first !== "..") return first;
      }
      return null;
    };
    var workspace = workspaceOf(unresolved) || workspaceOf(process.cwd());
    if (!workspace) return;

`;

const HOST_STATE = String.raw`    // 3. The plugin is on and the active engine has a current version installed.
    //    The engine is the one plugins.json names when it has a build here, else
    //    this host's default; tsc-rs's versions are the record's own fields
    //    (as older builds wrote them), tsrs's are under "tsrs".
    var state = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
    var plugin = state && state.plugins ? state.plugins[PLUGIN_ID] : null;
    if (!plugin || typeof plugin !== "object") return;
    if (plugin.enabled !== true) return;
    var engine = SUPPORTED_ENGINES.indexOf(plugin.engine) !== -1 ? plugin.engine : DEFAULT_ENGINE;
    var record = engine === "tsrs" ? plugin.tsrs : plugin;
    var current = record && typeof record === "object" ? record.current : null;
    var version = current && typeof current === "object" ? current.version : null;
    if (typeof version !== "string" || !SAFE_VERSION.test(version) || version.indexOf("..") !== -1) return;
`;

// A box has no plugins.json: the daemon pushes {"enabled", "engine", "version"}
// (written by the box tooling provisioner on every change) and the engine is
// already this box's own choice.
const BOX_STATE = String.raw`    // 3. The plugin is on in this box and its engine has a version installed:
    //    the state file the daemon pushes names both.
    var state = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
    if (!state || typeof state !== "object" || state.enabled !== true) return;
    var engine = state.engine;
    if (SUPPORTED_ENGINES.indexOf(engine) === -1) return;
    var version = state.version;
    if (typeof version !== "string" || !SAFE_VERSION.test(version) || version.indexOf("..") !== -1) return;
`;

const PRELOAD_TAIL = String.raw`    var binaryName = engine === "tsrs" ? "tsrs" : "tsc";
    var binary = path.join(VERSIONS_DIRS[engine], version, process.platform === "win32" ? binaryName + ".exe" : binaryName);
    var failed = function (error) {
      var code = error && (error.code || error.message);
      process.stderr.write("orquester: " + engine + " failed to start (" + (code || String(error)) + "); running tsc\n");
    };
    try {
      fs.accessSync(binary, process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
    } catch (error) {
      failed(error);
      return;
    }
    var args = process.argv.slice(2);
    // tsrs gets 4 checker threads unless the arguments choose (or build mode,
    // which runs its own per-project checkers, is on).
    if (engine === "tsrs") {
      var first = args.length > 0 ? String(args[0]).toLowerCase() : "";
      var chosen = args.some(function (arg) {
        return CHECKERS_SET.test(arg);
      });
      if (!chosen && first !== "-b" && first !== "--build") args = args.concat(["--checkers", TSRS_CHECKERS]);
    }

    // 4a. Become the engine (Node >= 22.15): the same pid, so every signal sent to
    //     this process reaches it, as TypeScript 7's own bin/tsc does. Only for
    //     a native executable: a failed execve ends the process (Node 24 aborts
    //     rather than throwing), and the common causes besides those the access
    //     check caught (a script's missing interpreter) are ruled out this way.
    var native = false;
    if (process.platform !== "win32" && typeof process.execve === "function") {
      try {
        var fd = fs.openSync(binary, "r");
        var head = Buffer.alloc(4);
        var magic = fs.readSync(fd, head, 0, 4, 0) === 4 ? head.readUInt32BE(0) : 0;
        fs.closeSync(fd);
        // ELF, then Mach-O (32/64-bit, either byte order) and universal.
        native = [0x7f454c46, 0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe].indexOf(magic) !== -1;
      } catch (error) {
        native = false;
      }
    }
    if (native) {
      try {
        process.execve(binary, [binary].concat(args), process.env);
      } catch (error) {
        failed(error);
      }
      return;
    }

    // 4b. A CommonJS tsc (the typescript package below 7): skip its main module
    //     and wait for the engine asynchronously, passing signals on, so it never
    //     outlives this process. The real tsc runs only if the engine fails to start.
    var entry = TSC_SCRIPT.test(real) ? real : unresolved;
    var packageDir = path.dirname(path.dirname(entry));
    var commonJs = false;
    try {
      var manifest = JSON.parse(fs.readFileSync(path.join(packageDir, "package.json"), "utf8"));
      var major = typeof manifest.version === "string" ? parseInt(manifest.version, 10) : NaN;
      commonJs = manifest.name === "typescript" && manifest.type !== "module" && major >= 1 && major < 7;
    } catch (error) {
      commonJs = false;
    }
    if (commonJs) {
      // Listening BEFORE the spawn: a signal that arrives meanwhile is queued
      // for the next turn of the event loop, when there is a child to pass it to.
      var available = require("os").constants.signals;
      var signals = FORWARDED_SIGNALS.filter(function (signal) {
        return Object.prototype.hasOwnProperty.call(available, signal);
      });
      var child = null;
      var forward = function (signal) {
        try {
          child.kill(signal);
        } catch (error) {
          // Already gone: its exit is on the way.
        }
      };
      var settled = false;
      var settle = function () {
        if (settled) return false;
        settled = true;
        signals.forEach(function (signal) {
          process.removeListener(signal, forward);
        });
        return true;
      };
      signals.forEach(function (signal) {
        process.on(signal, forward);
      });
      try {
        child = require("child_process").spawn(binary, args, { stdio: "inherit" });
      } catch (error) {
        settle();
        failed(error);
        return;
      }
      var Module = require("module");
      var compile = Module.prototype._compile;
      Module.prototype._compile = function (content, filename) {
        if (filename !== real && filename !== unresolved) return compile.apply(this, arguments);
        Module.prototype._compile = compile;
        return compile.call(this, "", filename);
      };
      child.on("error", function (error) {
        if (!settle()) return;
        failed(error);
        try {
          var tscJs = fs.realpathSync(path.join(packageDir, "lib", "tsc.js"));
          delete require.cache[tscJs];
          require(tscJs);
        } catch (tscError) {
          process.stderr.write(String((tscError && tscError.stack) || tscError) + "\n");
          process.exitCode = 1;
        }
      });
      child.on("exit", function (code, signal) {
        if (!settle()) return;
        if (signal) process.kill(process.pid, signal);
        process.exit(typeof code === "number" ? code : 1);
      });
      return;
    }

    // 4c. Any other tsc (TypeScript 7's is an ES module, which cannot be skipped
    //     from here): run the engine to completion, then leave the way it did.
    var result = require("child_process").spawnSync(binary, args, { stdio: "inherit" });
    if (result.error) {
      failed(result.error);
      return;
    }
    if (result.signal) {
      process.kill(process.pid, result.signal);
      process.exit(1);
    }
    process.exit(typeof result.status === "number" ? result.status : 1);
  } catch (error) {
    // Anything unexpected: the real tsc runs.
  }
})();
`;

const PRELOAD_BODY = `${PRELOAD_HEAD}${HOST_STATE}${PRELOAD_TAIL}`;
const BOX_PRELOAD_BODY = `${PRELOAD_HEAD}${BOX_STATE}${PRELOAD_TAIL}`;

/** The host's preload.cjs source with `options` baked in. */
export function renderTsRustPreload(options: TsRustPreloadOptions): string {
  const roots = [resolve(options.workspacesRoot)];
  if (options.configuredWorkspacesRoot !== undefined && !roots.includes(resolve(options.configuredWorkspacesRoot))) {
    roots.push(resolve(options.configuredWorkspacesRoot));
  }
  const constants = [
    `var STATE_PATH = ${JSON.stringify(resolve(options.statePath))};`,
    `var WORKSPACES_ROOTS = ${JSON.stringify(roots)};`,
    `var VERSIONS_DIRS = ${JSON.stringify(versionsDirs(options.statePath))};`,
    `var SUPPORTED_ENGINES = ${JSON.stringify(options.supportedEngines ?? ["tsrs", "tsc-rs"])};`,
    `var DEFAULT_ENGINE = ${JSON.stringify(options.defaultEngine ?? "tsc-rs")};`,
    `var PLUGIN_ID = ${JSON.stringify(TS_RUST_PLUGIN_ID)};`
  ];
  return `// Generated by Orquester (Settings → Plugins → Better TS Typecheck); rewritten on
// every daemon start, so do not edit. Loaded through NODE_OPTIONS=--require into
// Node processes started from Orquester sessions: while the plugin is on, a
// TypeScript \`tsc\` run inside a workspace runs tsrs or tsc-rs instead; anything else is untouched.
"use strict";
(function () {
  ${constants.join("\n  ")}
${PRELOAD_BODY}`;
}

export interface TsRustBoxPreloadOptions {
  /** The box's OS: its path rules apply to every path below. */
  os: BoxOs;
  /** The box path of the state file the daemon pushes (`{ enabled, engine, version }`). */
  statePath: string;
  /** The workspaces root(s) as box paths: real and configured, when they differ. */
  workspacesRoots: readonly string[];
  /** Each engine's `versions/` dir in the box. */
  versionsDirs: Readonly<Record<TsCheckerEngine, string>>;
  /** The engines with a build for the box; a state file naming another is ignored. */
  supportedEngines: readonly TsCheckerEngine[];
}

/**
 * A box's preload.cjs source. Every path is checked to be absolute and
 * normalised with the box's path rules — never resolved against this
 * machine — so a Windows box gets `C:\…` paths from a Linux daemon.
 */
export function renderTsRustBoxPreload(options: TsRustBoxPreloadOptions): string {
  const rules = options.os === "win32" ? win32 : posix;
  const boxPath = (value: string): string => {
    if (!rules.isAbsolute(value)) throw new Error(`Not an absolute ${options.os} path: ${value}`);
    return rules.normalize(value);
  };
  const roots: string[] = [];
  for (const root of options.workspacesRoots.map(boxPath)) {
    if (!roots.includes(root)) roots.push(root);
  }
  if (roots.length === 0) throw new Error("A box preload needs a workspaces root");
  const constants = [
    `var STATE_PATH = ${JSON.stringify(boxPath(options.statePath))};`,
    `var WORKSPACES_ROOTS = ${JSON.stringify(roots)};`,
    `var VERSIONS_DIRS = ${JSON.stringify({
      "tsc-rs": boxPath(options.versionsDirs["tsc-rs"]),
      tsrs: boxPath(options.versionsDirs.tsrs)
    })};`,
    `var SUPPORTED_ENGINES = ${JSON.stringify(options.supportedEngines)};`
  ];
  return `// Generated by Orquester (Settings → Plugins → Better TS Typecheck) for this box;
// the daemon rewrites it whenever the plugin changes, so do not edit. Loaded through
// NODE_OPTIONS=--require into Node processes started from Orquester sessions in the
// box: while the plugin is on, a TypeScript \`tsc\` run inside a workspace runs tsrs or
// tsc-rs instead; anything else is untouched.
"use strict";
(function () {
  ${constants.join("\n  ")}
${BOX_PRELOAD_BODY}`;
}

/** Atomically write the rendered preload to `path` (mode 0644), creating parent dirs. */
export async function writeTsRustPreload(path: string, options: TsRustPreloadOptions): Promise<void> {
  await writeFileAtomic(path, renderTsRustPreload(options), 0o644, false);
}
