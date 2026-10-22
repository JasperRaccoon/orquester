/**
 * The POSIX shell scripts that install the desktop stack and Google Chrome in a Linux box, and the
 * one that checks whether Chrome's sandbox starts there. The install scripts expect to run as root
 * (the installer wraps them in `sudo -n` for a sudoer); every line they print is a progress line
 * for the tab, so they `say` what they are about to do. Exit codes: 0 done, 3 a required step
 * failed, 4 the box cannot have it (architecture). Pure: the installer runs them.
 */

import { shQuote } from "../../service/box-exec.ts";
import { PROBE_PATH, type BoxPackageManager, type PackageChoice } from "./probe.ts";

/** Google's Linux package signing key, and the fingerprint of its primary key (stable since 2016; subkeys rotate). */
export const GOOGLE_SIGNING_KEY_URL = "https://dl.google.com/linux/linux_signing_key.pub";
export const GOOGLE_SIGNING_KEY_FINGERPRINT = "EB4C1BFD4F042F6DDDCCEC917721F63BD38B4796";
export const GOOGLE_CHROME_DEB_REPO = "https://dl.google.com/linux/chrome/deb/";
export const GOOGLE_CHROME_RPM_REPO = "https://dl.google.com/linux/chrome/rpm/stable/$basearch";
const APT_KEYRING = "/etc/apt/keyrings/google-chrome.asc";
/** The file name Chrome's own postinst manages, so it never adds a second, conflicting entry. */
const APT_SOURCE = "/etc/apt/sources.list.d/google-chrome.list";
const RPM_REPO_FILE = "/etc/yum.repos.d/google-chrome.repo";

export const EXIT_REQUIRED_FAILED = 3;
export const EXIT_UNSUPPORTED = 4;

/** The prelude every install script starts with: environment, `say`, and the package helpers. */
function prelude(manager: BoxPackageManager): string[] {
  const lines = [
    "set -u",
    `PATH=${PROBE_PATH}`,
    // needrestart (Ubuntu) would otherwise ask which services to restart.
    "LC_ALL=C DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a NEEDRESTART_SUSPEND=1",
    "export PATH LC_ALL DEBIAN_FRONTEND NEEDRESTART_MODE NEEDRESTART_SUSPEND",
    "say() { printf '%s\\n' \"$*\"; }"
  ];
  if (manager === "apt") {
    lines.push(
      // Wait for another apt (cloud-init, unattended-upgrades) instead of failing on its lock.
      "apt_get() { apt-get -q -y -o DPkg::Lock::Timeout=600 -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold \"$@\"; }",
      "updated=0",
      "refresh() { [ \"$updated\" = 1 ] && return 0; say 'Refreshing the package lists (apt-get update)'; apt_get update && updated=1; }",
      "add() { apt_get install --no-install-recommends \"$@\"; }",
      // Stale lists name package versions the mirror no longer has: refresh once and retry.
      "install_set() { add \"$@\" || { refresh && add \"$@\"; }; }",
      // Finish an install an earlier, interrupted run left half-configured.
      "dpkg --configure -a >/dev/null 2>&1 || true",
      // A fresh image often ships without package lists.
      "ls /var/lib/apt/lists/*_Packages >/dev/null 2>&1 || refresh || true"
    );
  } else if (manager === "dnf") {
    lines.push("add() { dnf install -y --setopt=install_weak_deps=False \"$@\"; }", "install_set() { add \"$@\"; }");
  } else {
    lines.push("add() { yum install -y \"$@\"; }", "install_set() { add \"$@\"; }");
  }
  return lines;
}

function words(choices: readonly PackageChoice[]): string {
  return choices.map((choice) => shQuote(choice[0]!)).join(" ");
}

function label(choices: readonly PackageChoice[]): string {
  return choices.map((choice) => choice[0]!).join(" ");
}

/**
 * Install the desktop packages: the required set in one transaction (failure exits 3), then the
 * optional set (sound, OpenGL, a terminal, fonts) — in one go, else one package at a time, trying
 * each alternative name, so a package the distro lacks costs only that feature. Finally create
 * `/etc/machine-id` where it is missing (containers): D-Bus and PulseAudio refuse to start without.
 */
export function desktopInstallScript(plan: { manager: BoxPackageManager; required: readonly PackageChoice[]; optional: readonly PackageChoice[] }): string {
  const lines = prelude(plan.manager);
  if (plan.required.length > 0) {
    lines.push(
      shSay(`Installing the desktop packages: ${label(plan.required)}`),
      `install_set ${words(plan.required)} || { say 'Could not install the desktop packages.'; exit ${EXIT_REQUIRED_FAILED}; }`
    );
  }
  if (plan.optional.length > 0) {
    lines.push(shSay(`Installing sound, OpenGL, terminal and font packages: ${label(plan.optional)}`), `if ! install_set ${words(plan.optional)}; then`);
    lines.push("  say 'Installing them one at a time'");
    for (const choice of plan.optional) {
      const attempts = choice.map((name) => `add ${shQuote(name)}`).join(" || ");
      lines.push(`  ${attempts} || ${shSay(`Skipped ${choice.join(" / ")}: it cannot be installed here.`)}`);
    }
    lines.push("fi");
  }
  lines.push(
    "if ! grep -q '[^[:space:]]' /etc/machine-id 2>/dev/null; then",
    "  say 'Creating /etc/machine-id (D-Bus and PulseAudio need one)'",
    "  if command -v dbus-uuidgen >/dev/null 2>&1; then dbus-uuidgen --ensure=/etc/machine-id; else systemd-machine-id-setup; fi || say 'Could not create /etc/machine-id.'",
    "fi",
    "say 'Desktop packages are installed.'"
  );
  return lines.join("\n");
}

/**
 * Install `google-chrome-stable` from Google's signed repository (amd64 and arm64). apt: the
 * signing key is fetched over HTTPS, its primary fingerprint checked against the pinned one when
 * gpg is available, and apt verifies the repository's signature with it (`signed-by`). dnf/yum:
 * the repository file names the same key, and rpm checks every package's signature with it.
 */
export function browserInstallScript(manager: BoxPackageManager): string {
  const lines = prelude(manager);
  lines.push(
    "fetch() {",
    "  if command -v curl >/dev/null 2>&1; then curl -fsSL --proto '=https' --tlsv1.2 -o \"$2\" \"$1\"",
    "  elif command -v wget >/dev/null 2>&1; then wget -q --https-only -O \"$2\" \"$1\"",
    "  else return 127; fi",
    "}"
  );
  if (manager === "apt") {
    lines.push(
      "arch=$(dpkg --print-architecture)",
      `case $arch in amd64 | arm64) ;; *) say "Google Chrome has no Linux build for $arch."; exit ${EXIT_UNSUPPORTED} ;; esac`,
      "if { ! command -v curl >/dev/null 2>&1 && ! command -v wget >/dev/null 2>&1; } || [ ! -s /etc/ssl/certs/ca-certificates.crt ]; then",
      "  say 'Installing curl and the CA certificates'",
      `  install_set ca-certificates curl || exit ${EXIT_REQUIRED_FAILED}`,
      "fi",
      "say \"Adding Google's signed Chrome repository\"",
      "install -d -m 0755 /etc/apt/keyrings",
      `key=${shQuote(`${APT_KEYRING}.tmp`)}`,
      `fetch ${shQuote(GOOGLE_SIGNING_KEY_URL)} "$key" || { say "Could not download Google's signing key."; exit ${EXIT_REQUIRED_FAILED}; }`,
      `grep -q 'BEGIN PGP PUBLIC KEY BLOCK' "$key" || { say "Google's signing key download is not a key."; rm -f "$key"; exit ${EXIT_REQUIRED_FAILED}; }`,
      "if command -v gpg >/dev/null 2>&1; then",
      "  home=$(mktemp -d)",
      "  fpr=$(GNUPGHOME=$home gpg --batch --show-keys --with-colons \"$key\" 2>/dev/null | awk -F: '$1 == \"fpr\" { print $10; exit }')",
      "  rm -rf \"$home\"",
      `  if [ "$fpr" != ${shQuote(GOOGLE_SIGNING_KEY_FINGERPRINT)} ]; then say "Google's signing key has an unexpected fingerprint ($fpr)."; rm -f "$key"; exit ${EXIT_REQUIRED_FAILED}; fi`,
      "  say \"Google's signing key fingerprint checks out.\"",
      "fi",
      `chmod 0644 "$key" && mv -f "$key" ${shQuote(APT_KEYRING)}`,
      `printf 'deb [arch=%s signed-by=%s] %s stable main\\n' "$arch" ${shQuote(APT_KEYRING)} ${shQuote(GOOGLE_CHROME_DEB_REPO)} > ${shQuote(APT_SOURCE)}`,
      `updated=0; refresh || exit ${EXIT_REQUIRED_FAILED}`
    );
  } else {
    lines.push(
      "case $(uname -m) in x86_64 | aarch64) ;; *) say \"Google Chrome has no Linux build for $(uname -m).\"; exit " + EXIT_UNSUPPORTED + " ;; esac",
      "say \"Adding Google's signed Chrome repository\"",
      `cat > ${shQuote(RPM_REPO_FILE)} <<'ORQ_REPO'`,
      "[google-chrome]",
      "name=google-chrome",
      `baseurl=${GOOGLE_CHROME_RPM_REPO}`,
      "enabled=1",
      "gpgcheck=1",
      `gpgkey=${GOOGLE_SIGNING_KEY_URL}`,
      "ORQ_REPO"
    );
  }
  lines.push(
    "say 'Installing google-chrome-stable'",
    `install_set google-chrome-stable || { say 'Could not install google-chrome-stable.'; exit ${EXIT_REQUIRED_FAILED}; }`,
    "say 'Google Chrome is installed.'"
  );
  return lines.join("\n");
}

/**
 * Start Chrome headless (as the box user, never through sudo) and dump a data: page, with the
 * sandbox (`sandbox=ok|fail`; skipped when `trySandbox` is false or the user is root, which Chrome
 * refuses to sandbox) and, when that fails or was skipped, without it (`nosandbox=ok|fail`). A
 * failed attempt prints its log's last lines as `<label>-log: …`. Arguments: `$1` = Chrome's path,
 * `$2` = `1` to try the sandbox.
 */
export function chromeStartScript(): string {
  return [
    "chrome=$1",
    "try_sandbox=$2",
    "tmp=$(mktemp -d) || exit 1",
    "trap 'rm -rf \"$tmp\"' EXIT",
    "limit=; if command -v timeout >/dev/null 2>&1; then limit='timeout -k 5 90'; fi",
    "try() {",
    "  label=$1; shift",
    "  out=$($limit \"$chrome\" \"$@\" --headless=new --no-first-run --no-default-browser-check --disable-gpu --disable-dev-shm-usage \\",
    "    --user-data-dir=\"$tmp/$label\" --dump-dom 'data:text/html,<p>orq-gui-ok</p>' 2>\"$tmp/$label.log\" </dev/null)",
    "  case $out in *orq-gui-ok*) printf '%s=ok\\n' \"$label\"; return 0 ;; esac",
    "  printf '%s=fail\\n' \"$label\"",
    "  tail -n 8 \"$tmp/$label.log\" | sed \"s/^/$label-log: /\"",
    "  return 1",
    "}",
    "if [ \"$try_sandbox\" = 1 ] && [ \"$(id -u)\" != 0 ]; then try sandbox && exit 0; fi",
    "try nosandbox --no-sandbox"
  ].join("\n");
}

export interface ChromeStartResult {
  /** Started with the sandbox; null when that was not tried. */
  sandbox: boolean | null;
  /** Started with --no-sandbox; null when that was not needed. */
  noSandbox: boolean | null;
  /** The failed attempts' log lines. */
  log: string[];
}

export function parseChromeStart(stdout: string): ChromeStartResult {
  const result: ChromeStartResult = { sandbox: null, noSandbox: null, log: [] };
  for (const line of stdout.split(/\r?\n/)) {
    if (line === "sandbox=ok" || line === "sandbox=fail") result.sandbox = line.endsWith("ok");
    else if (line === "nosandbox=ok" || line === "nosandbox=fail") result.noSandbox = line.endsWith("ok");
    else if (/^(no)?sandbox-log: /.test(line)) result.log.push(line);
  }
  return result;
}

/** `say '<text>'`, quoted for the shell. */
function shSay(text: string): string {
  return `say ${shQuote(text)}`;
}
