// The tsc-rs preload (spec §3.2): a dependency-free CommonJS file every Orquester
// session loads into each Node process through `NODE_OPTIONS=--require`. In a
// process running TypeScript's `tsc` from a workspace where the plugin is on, it
// runs the installed tsc-rs with the same arguments and leaves with its status;
// everywhere else it returns at once and the process runs unchanged.
//
// The file runs inside arbitrary user processes on any Node >= 18, so it is
// plain ES5-style CommonJS, swallows every error, prints nothing outside a
// redirect, and does no file I/O unless `argv[1]` looks like tsc.

import { dirname, join, resolve } from "node:path";

import { TS_RUST_PLUGIN_ID } from "@orquester/api";
import { tsRustPluginDir } from "@orquester/config";

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
}

/**
 * `versions/` of the tsc-rs plugin dir. `statePath` is `pluginsConfigPath(appdir)`
 * (`<appdir>/daemon/plugins.json`), so the appdir is two levels up.
 */
function tsRustVersionsDir(statePath: string): string {
  return resolve(join(tsRustPluginDir(dirname(dirname(resolve(statePath)))), "versions"));
}

// The preload's code after its baked constants. Raw, so its regexes and string
// escapes are written exactly as they appear in preload.cjs.
const PRELOAD_BODY = String.raw`
  // Ends in typescript/bin/tsc or typescript/lib/tsc.js, with either separator.
  var TSC_SCRIPT = /[\\/]typescript[\\/](?:bin[\\/]tsc|lib[\\/]tsc\.js)$/;
  // A version names a directory under VERSIONS_DIR: no separators, no "..".
  var SAFE_VERSION = /^[0-9A-Za-z][0-9A-Za-z.+_-]*$/;
  // Passed on to tsc-rs while this process waits for it (those this OS has).
  var FORWARDED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT", "SIGBREAK"];

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

    // 2. The workspace: the first segment under a root of the UNRESOLVED script
    //    path (pnpm's global virtual store can put the real one elsewhere), else
    //    of the working directory.
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

    // 3. The plugin is on here and a current version is installed.
    var state = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
    var plugin = state && state.plugins ? state.plugins[PLUGIN_ID] : null;
    if (!plugin || typeof plugin !== "object") return;
    var enabled = plugin.enabledWorkspaces;
    if (!Array.isArray(enabled) || enabled.indexOf(workspace) === -1) return;
    var version = plugin.current && typeof plugin.current === "object" ? plugin.current.version : null;
    if (typeof version !== "string" || !SAFE_VERSION.test(version) || version.indexOf("..") !== -1) return;
    var binary = path.join(VERSIONS_DIR, version, process.platform === "win32" ? "tsc.exe" : "tsc");
    var failed = function (error) {
      var code = error && (error.code || error.message);
      process.stderr.write("orquester: tsc-rs failed to start (" + (code || String(error)) + "); running tsc\n");
    };
    try {
      fs.accessSync(binary, process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
    } catch (error) {
      failed(error);
      return;
    }
    var args = process.argv.slice(2);

    // 4a. Become tsc-rs (Node >= 22.15): the same pid, so every signal sent to
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
    //     and wait for tsc-rs asynchronously, passing signals on, so it never
    //     outlives this process. The real tsc runs only if tsc-rs fails to start.
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
    //     from here): run tsc-rs to completion, then leave the way it did.
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

/** The preload.cjs source with `options` baked in. */
export function renderTsRustPreload(options: TsRustPreloadOptions): string {
  const roots = [resolve(options.workspacesRoot)];
  if (options.configuredWorkspacesRoot !== undefined && !roots.includes(resolve(options.configuredWorkspacesRoot))) {
    roots.push(resolve(options.configuredWorkspacesRoot));
  }
  const constants = [
    `var STATE_PATH = ${JSON.stringify(resolve(options.statePath))};`,
    `var WORKSPACES_ROOTS = ${JSON.stringify(roots)};`,
    `var VERSIONS_DIR = ${JSON.stringify(tsRustVersionsDir(options.statePath))};`,
    `var PLUGIN_ID = ${JSON.stringify(TS_RUST_PLUGIN_ID)};`
  ];
  return `// Generated by Orquester (Settings → Plugins → Better TS Typecheck); rewritten on
// every daemon start, so do not edit. Loaded through NODE_OPTIONS=--require into
// Node processes started from Orquester sessions: a TypeScript \`tsc\` run in a
// workspace where the plugin is on runs tsc-rs instead; anything else is untouched.
"use strict";
(function () {
  ${constants.join("\n  ")}
${PRELOAD_BODY}`;
}

/** Atomically write the rendered preload to `path` (mode 0644), creating parent dirs. */
export async function writeTsRustPreload(path: string, options: TsRustPreloadOptions): Promise<void> {
  await writeFileAtomic(path, renderTsRustPreload(options), 0o644, false);
}
