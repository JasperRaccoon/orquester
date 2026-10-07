import assert from "node:assert/strict";
import { isDarkBrandColor, processIconKind } from "./process-icons";

const kind = (name: string, cmdline = name) => processIconKind({ name, cmdline });

// A tool running on a runtime is recognised by its command line, not the runtime's name.
assert.deepEqual(kind("node", "node node_modules/.bin/../vite/bin/vite.js --config vite.config.ts"), { brand: "vite" });
assert.deepEqual(kind("node", "node /repo/node_modules/vitest/vitest.mjs run"), { brand: "vitest" }, "vitest is not vite");
// Agents the app already has artwork for use it, whether npm-installed (on node) or native.
assert.deepEqual(kind("node", "node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js"), { app: "claude" });
assert.deepEqual(kind("claude", "claude --output-format stream-json"), { app: "claude" });
assert.deepEqual(kind("node", "node /usr/lib/node_modules/@openai/codex/bin/codex.js app-server"), { app: "codex" });
assert.deepEqual(kind("codex", "/usr/lib/node_modules/@openai/codex/vendor/codex app-server"), { app: "codex" });
assert.deepEqual(kind("node", "node /usr/lib/node_modules/@xai-official/grok/bin/grok.js --yolo"), { app: "grok" });
assert.deepEqual(kind("grok", "grok --yolo"), { app: "grok" });
assert.deepEqual(kind("opencode", "opencode serve --port 4096"), { app: "opencode" });
assert.deepEqual(kind("node", "node /usr/lib/node_modules/opencode-ai/bin/opencode"), { app: "opencode" });
assert.deepEqual(kind("deepseek"), { app: "deepseek" });
assert.deepEqual(kind("node", "node /repo/node_modules/.pnpm/esbuild@0.25.12/node_modules/esbuild/bin/esbuild"), { brand: "esbuild" });
assert.deepEqual(kind("node", "node /usr/bin/pnpm test"), { brand: "pnpm" });
assert.deepEqual(kind("node", "node /repo/node_modules/next/dist/server/next-server.js"), { brand: "nextdotjs" });
assert.deepEqual(kind("node", "node --import tsx apps/daemon/src/cli.ts"), { brand: "typescript" });
assert.deepEqual(kind("node", "node server.js"), { brand: "nodedotjs" }, "an unrecognised script is plain Node");
assert.deepEqual(kind("python3.12", "python3.12 -m http.server"), { brand: "python" });
// A native binary's own name wins: a cmdline mentioning vite does not make bash Vite.
assert.deepEqual(kind("bash", "/bin/bash -c pnpm exec vite"), { app: "bash" });

// Known products by their (possibly truncated) comm name.
assert.deepEqual(kind("dockerd"), { brand: "docker" });
assert.deepEqual(kind("containerd"), { brand: "containerd" });
assert.deepEqual(kind("postgres", "postgres: 16/main: checkpointer"), { brand: "postgresql" });
assert.deepEqual(kind("redis-server"), { brand: "redis" });
assert.deepEqual(kind("tmux: server"), { brand: "tmux" });
assert.deepEqual(kind("php-fpm8.2"), { brand: "php" });
assert.deepEqual(kind("chrome", "/opt/google/chrome/chrome --type=renderer"), { app: "chrome" });
assert.deepEqual(kind("chromium-browse"), { app: "chromium" }, "comm names are cut at 15 chars");
assert.deepEqual(kind("code", "/usr/share/code/code --type=renderer"), { app: "vscode" });
assert.deepEqual(kind("zsh", "-zsh"), { app: "zsh" });

// No brand: a category glyph, and the generic one when nothing is known.
assert.deepEqual(kind("nano", "nano notes.txt"), { category: "editor" });
assert.deepEqual(kind("systemd", "/sbin/init"), { category: "system" });
assert.deepEqual(kind("sshd"), { category: "key" });
assert.deepEqual(kind("aider"), { category: "agent" });
assert.deepEqual(kind("containerd-shim"), { category: "container" });
assert.deepEqual(kind("sh"), { category: "shell" });
assert.deepEqual(kind("svgbench", "/build/htmlui-bench"), { category: "generic" });

// Near-black brand colours fall back to the text colour on dark surfaces.
assert.equal(isDarkBrandColor("000000"), true);
assert.equal(isDarkBrandColor("242424"), true);
assert.equal(isDarkBrandColor("575757"), true);
assert.equal(isDarkBrandColor("2496ED"), false);
assert.equal(isDarkBrandColor("5FA04E"), false);
assert.equal(isDarkBrandColor("not-a-colour"), true);

console.log("process-icons.check.ts OK");
