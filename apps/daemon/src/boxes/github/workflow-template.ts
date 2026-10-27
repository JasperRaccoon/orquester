/**
 * The Blacksmith control repo's workflows (spec §11.2; Devices phase 2 §5). `orquester-box.yml`:
 * one workflow run = one box — macOS on a Blacksmith M4 runner, or Linux on a Blacksmith x64
 * runner (nested virtualization: KVM for Android emulators). It is dispatched with
 * `workflow_dispatch` inputs (box id, lifetime, daemon URL, runner label, OS, what to prepare —
 * nothing secret), downloads `orq-agent` from the daemon authenticated with the job's GitHub OIDC
 * token, restores the device caches for a device host, and runs `orq-agent` in the foreground
 * until the box is destroyed (`orq-agent` exits, or the run is cancelled) or `timeout-minutes`
 * ends it. `orquester-device-cache.yml` builds and saves the device caches (`device-cache.ts`).
 *
 * Inputs are never interpolated into shell: they reach the steps as env vars and
 * are validated first.
 */

import {
  ANDROID_AVD_STEP_SCRIPT,
  ANDROID_CACHE_KEY,
  ANDROID_CACHE_PATHS,
  ANDROID_SDK_STEP_SCRIPT,
  APPLE_RUNNER_CACHE_PATHS,
  APPLE_RUNNER_STEP_SCRIPT,
  appleRunnerCacheKey,
  BLACKSMITH_OSES,
  BLACKSMITH_PREPARES,
  DEVICE_NODE_VERSION,
  DEVICE_TOOLS_CACHE_PATHS,
  DEVICE_TOOLS_STEP_SCRIPT,
  deviceToolsCacheKey,
  KVM_STEP_SCRIPT,
  XCODE_BUILD_STEP_SCRIPT,
  type BlacksmithOs,
  type BlacksmithPrepare
} from "./device-cache.ts";

export type { BlacksmithOs, BlacksmithPrepare } from "./device-cache.ts";

/** Name of the private repo created in the owner's org. */
export const BLACKSMITH_CONTROL_REPO_NAME = "orquester-macos-boxes";
export const BLACKSMITH_WORKFLOW_FILE = "orquester-box.yml";
export const BLACKSMITH_WORKFLOW_PATH = `.github/workflows/${BLACKSMITH_WORKFLOW_FILE}`;
/** The workflow that builds and saves the device caches (dispatched by the device service). */
export const BLACKSMITH_DEVICE_CACHE_WORKFLOW_FILE = "orquester-device-cache.yml";
export const BLACKSMITH_DEVICE_CACHE_WORKFLOW_PATH = `.github/workflows/${BLACKSMITH_DEVICE_CACHE_WORKFLOW_FILE}`;
/**
 * GitHub's limit for a job on a self-hosted runner, which Blacksmith runners are (5 days), for
 * macOS and Linux alike (Blacksmith documents no lower limit).
 */
export const BLACKSMITH_MAX_LIFETIME_MINUTES = 7200;
/** The cache-warming job's time limit. */
export const BLACKSMITH_DEVICE_CACHE_TIMEOUT_MINUTES = 90;

export type BlacksmithSize = "6vcpu" | "12vcpu";
export type BlacksmithImage = "macos-15" | "macos-26" | "macos-27";
export type BlacksmithLinuxSize = "2vcpu" | "4vcpu" | "8vcpu" | "16vcpu" | "32vcpu";
export type BlacksmithLinuxImage = "ubuntu-2404";

export interface BlacksmithSizeInfo<Id extends string> {
  id: Id;
  label: string;
  vcpu: number;
  ramGb: number;
  perMinuteUsd: number;
}

export const BLACKSMITH_SIZES: ReadonlyArray<BlacksmithSizeInfo<BlacksmithSize>> = [
  { id: "6vcpu", label: "6 vCPU M4 · 24 GB", vcpu: 6, ramGb: 24, perMinuteUsd: 0.08 },
  { id: "12vcpu", label: "12 vCPU M4 · 48 GB", vcpu: 12, ramGb: 48, perMinuteUsd: 0.16 }
];

/**
 * Blacksmith's x64 Linux runners (docs.blacksmith.sh, 2026-10: $0.004 per minute per 2 vCPU).
 * x64 only: ARM runners have no nested virtualization, so no KVM for Android emulators.
 */
export const BLACKSMITH_LINUX_SIZES: ReadonlyArray<BlacksmithSizeInfo<BlacksmithLinuxSize>> = [
  { id: "2vcpu", label: "2 vCPU x64 · 8 GB", vcpu: 2, ramGb: 8, perMinuteUsd: 0.004 },
  { id: "4vcpu", label: "4 vCPU x64 · 16 GB", vcpu: 4, ramGb: 16, perMinuteUsd: 0.008 },
  { id: "8vcpu", label: "8 vCPU x64 · 32 GB", vcpu: 8, ramGb: 32, perMinuteUsd: 0.016 },
  { id: "16vcpu", label: "16 vCPU x64 · 64 GB", vcpu: 16, ramGb: 64, perMinuteUsd: 0.032 },
  { id: "32vcpu", label: "32 vCPU x64 · 128 GB", vcpu: 32, ramGb: 128, perMinuteUsd: 0.064 }
];

/** Blacksmith's macOS labels (docs.blacksmith.sh, 2026-10): `-latest` is macOS 26; 27 is a public beta. */
export const BLACKSMITH_IMAGES: ReadonlyArray<{ id: BlacksmithImage; label: string }> = [
  { id: "macos-26", label: "macOS 26 Tahoe" },
  { id: "macos-15", label: "macOS 15 Sequoia" },
  { id: "macos-27", label: "macOS 27 (beta)" }
];
export const BLACKSMITH_DEFAULT_IMAGE: BlacksmithImage = "macos-26";

/** Blacksmith's Ubuntu labels offered for Linux boxes. */
export const BLACKSMITH_LINUX_IMAGES: ReadonlyArray<{ id: BlacksmithLinuxImage; label: string }> = [{ id: "ubuntu-2404", label: "Ubuntu 24.04" }];
export const BLACKSMITH_DEFAULT_LINUX_IMAGE: BlacksmithLinuxImage = "ubuntu-2404";

export function isBlacksmithSize(value: unknown): value is BlacksmithSize {
  return BLACKSMITH_SIZES.some((size) => size.id === value);
}

export function isBlacksmithImage(value: unknown): value is BlacksmithImage {
  return BLACKSMITH_IMAGES.some((image) => image.id === value);
}

export function isBlacksmithLinuxSize(value: unknown): value is BlacksmithLinuxSize {
  return BLACKSMITH_LINUX_SIZES.some((size) => size.id === value);
}

export function isBlacksmithLinuxImage(value: unknown): value is BlacksmithLinuxImage {
  return BLACKSMITH_LINUX_IMAGES.some((image) => image.id === value);
}

/** The `runs-on` label for a size and image, e.g. `blacksmith-6vcpu-macos-26`, `blacksmith-8vcpu-ubuntu-2404`. */
export function blacksmithRunnerLabel(size: BlacksmithSize | BlacksmithLinuxSize, image: BlacksmithImage | BlacksmithLinuxImage): string {
  return `blacksmith-${size}-${image}`;
}

export const BLACKSMITH_MACOS_RUNNER_LABELS: readonly string[] = BLACKSMITH_SIZES.flatMap((size) =>
  BLACKSMITH_IMAGES.map((image) => blacksmithRunnerLabel(size.id, image.id))
);
export const BLACKSMITH_LINUX_RUNNER_LABELS: readonly string[] = BLACKSMITH_LINUX_SIZES.flatMap((size) =>
  BLACKSMITH_LINUX_IMAGES.map((image) => blacksmithRunnerLabel(size.id, image.id))
);
export const BLACKSMITH_RUNNER_LABELS: readonly string[] = [...BLACKSMITH_MACOS_RUNNER_LABELS, ...BLACKSMITH_LINUX_RUNNER_LABELS];

/** The OS a runner label runs (null for a label this build does not offer). */
export function blacksmithRunnerOs(label: unknown): BlacksmithOs | null {
  if (BLACKSMITH_MACOS_RUNNER_LABELS.includes(label as string)) return "macos";
  if (BLACKSMITH_LINUX_RUNNER_LABELS.includes(label as string)) return "linux";
  return null;
}

/** The box workflow's dispatch inputs (all strings: the dispatch API takes strings). */
export interface BlacksmithWorkflowInputs {
  box_id: string;
  lifetime_minutes: string;
  daemon_url: string;
  runner: string;
  os: BlacksmithOs;
  prepare: BlacksmithPrepare;
}

/** The cache-warming workflow's dispatch inputs. */
export interface BlacksmithDeviceCacheInputs {
  /** Names the run (`orq-cache-<os>-<request_id>`), so a dispatch answered without details is found. */
  request_id: string;
  os: BlacksmithOs;
  runner: string;
}

export interface BlacksmithWorkflowOptions {
  /**
   * Join the tailnet first with Tailscale's GitHub workload identity federation
   * (`tailscale/github-action@v4`: a federated-identity client id + audience, no secret in
   * the repo). Use when the daemon is reached in `tailscale` mode.
   */
  tailscale?: { oauthClientId: string; audience: string } | null;
}

const TAILSCALE_VALUE = /^[A-Za-z0-9._:/-]{1,200}$/;

/** The step that downloads `orq-agent` (bash; exported for tests). */
export const DOWNLOAD_STEP_SCRIPT = `set +x
set -eu
umask 077
case "$AGENT_PLATFORM" in darwin-arm64 | linux-x64) ;; *) echo "::error::invalid orq-agent platform"; exit 1 ;; esac
URL=\${DAEMON_URL%/}
AUD=$(printf '%s' "$URL" | sed -E 's#^(https?://[^/]+).*#\\1#')
AUD_Q=$(printf '%s' "$AUD" | sed -e 's/:/%3A/g' -e 's#/#%2F#g')
D="$HOME/.orq-agent/bin"
mkdir -p "$D"
end=$(($(date +%s) + 300))
n=0
while :; do
  # A fresh OIDC token (audience = the daemon origin) per attempt; secrets go to curl on stdin.
  printf 'header = "Authorization: Bearer %s"\\n' "$ACTIONS_ID_TOKEN_REQUEST_TOKEN" |
    curl -K - -sSf --retry 3 -o "$RUNNER_TEMP/orq-oidc.json" "$ACTIONS_ID_TOKEN_REQUEST_URL&audience=$AUD_Q"
  JWT=$(sed -n 's/.*"value"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' "$RUNNER_TEMP/orq-oidc.json")
  rm -f "$RUNNER_TEMP/orq-oidc.json"
  [ -n "$JWT" ] || { echo "::error::GitHub returned no OIDC token"; exit 1; }
  code=$(printf 'header = "Authorization: GitHubOIDC %s"\\nheader = "X-Orq-Box-Id: %s"\\n' "$JWT" "$BOX_ID" |
    curl -K - -sS -o "$D/orq-agent.download" -w '%{http_code}' --connect-timeout 20 --max-time 600 \\
      "$URL/api/boxes/agent/$AGENT_PLATFORM") || code=000
  JWT=
  case "$code" in
    200) break ;;
    401 | 403 | 404) echo "::error::the Orquester daemon refused the download (HTTP $code)"; exit 1 ;;
  esac
  [ "$(date +%s)" -lt "$end" ] || { echo "::error::could not download orq-agent (HTTP $code)"; exit 1; }
  n=$((n + 1))
  echo "download failed (HTTP $code); retrying"
  sleep $((n * 3))
done
chmod 755 "$D/orq-agent.download"
"$D/orq-agent.download" --version
mv -f "$D/orq-agent.download" "$D/orq-agent"
`;

/** The runner label must run the requested OS (choice inputs already limit both to known values). */
const RUNNER_CHECK = `case "$OS:$RUNNER" in
  macos:blacksmith-*-macos-* | linux:blacksmith-*-ubuntu-*) ;;
  *) echo "::error::the runner does not match os"; exit 1 ;;
esac
`;

/** The input check step (bash; exported for tests). */
export const CHECK_STEP_SCRIPT = `set -eu
printf '%s' "$BOX_ID" | grep -Eq '^[A-Za-z0-9-]{8,64}$' || { echo "::error::invalid box_id"; exit 1; }
printf '%s' "$DAEMON_URL" | grep -Eq '^https://[A-Za-z0-9.-]+(:[0-9]+)?(/[A-Za-z0-9._~/-]*)?$' || { echo "::error::invalid daemon_url"; exit 1; }
case "$LIFETIME" in '' | *[!0-9]*) echo "::error::invalid lifetime_minutes"; exit 1 ;; esac
if [ "$LIFETIME" -lt 1 ] || [ "$LIFETIME" -gt ${BLACKSMITH_MAX_LIFETIME_MINUTES} ]; then echo "::error::lifetime_minutes must be 1-${BLACKSMITH_MAX_LIFETIME_MINUTES}"; exit 1; fi
${RUNNER_CHECK}case "$PREPARE" in none | devices) ;; *) echo "::error::invalid prepare"; exit 1 ;; esac
`;

/** The cache-warming workflow's input check (bash; exported for tests). */
export const CACHE_CHECK_STEP_SCRIPT = `set -eu
printf '%s' "$REQUEST_ID" | grep -Eq '^[A-Za-z0-9-]{8,64}$' || { echo "::error::invalid request_id"; exit 1; }
${RUNNER_CHECK}`;

/**
 * Box host paths (spec §8.6) live under the daemon's appdir; orq-agent creates the rest itself.
 * The runner user owns /var/lib/orquester (user and group: on Linux the group is not `staff`),
 * so the device caches restore into it without sudo.
 */
export const PATHS_STEP_SCRIPT = `set -eu
sudo mkdir -p /var/lib/orquester
sudo chown "$(id -un):$(id -gn)" /var/lib/orquester
if [ "\${PREPARE:-none}" = devices ]; then mkdir -p /var/lib/orquester/devices; fi
`;

function indent(text: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  return text
    .trimEnd()
    .split("\n")
    .map((line) => (line.length > 0 ? pad + line : line))
    .join("\n");
}

interface CacheStep {
  name: string;
  id?: string;
  if?: string;
  action: "restore" | "save";
  paths: readonly string[];
  key: string;
  lookupOnly?: boolean;
  /** Restores in a box run: a slow or failing cache never keeps orq-agent from starting. */
  bestEffort?: boolean;
}

/** An `actions/cache/restore@v4` or `actions/cache/save@v4` step (8-space step indent). */
function cacheStep(step: CacheStep): string {
  return [
    `      - name: ${step.name}`,
    ...(step.id ? [`        id: ${step.id}`] : []),
    ...(step.if ? [`        if: ${step.if}`] : []),
    ...(step.bestEffort ? ["        continue-on-error: true", "        timeout-minutes: 8"] : []),
    `        uses: actions/cache/${step.action}@v4`,
    "        with:",
    "          path: |",
    ...step.paths.map((path) => `            ${path}`),
    `          key: ${step.key}`,
    ...(step.lookupOnly ? ["          lookup-only: true"] : [])
  ].join("\n");
}

function runStep(step: { name: string; id?: string; if?: string; env?: Record<string, string>; script: string }): string {
  return [
    `      - name: ${step.name}`,
    ...(step.id ? [`        id: ${step.id}`] : []),
    ...(step.if ? [`        if: ${step.if}`] : []),
    ...(step.env ? ["        env:", ...Object.entries(step.env).map(([key, value]) => `          ${key}: ${value}`)] : []),
    "        run: |",
    indent(step.script, 10)
  ].join("\n");
}

function setupNodeStep(condition: string | null): string {
  return [
    "      - name: Set up Node for the device tools",
    ...(condition ? [`        if: ${condition}`] : []),
    "        uses: actions/setup-node@v4",
    "        with:",
    `          node-version: "${DEVICE_NODE_VERSION}"`
  ].join("\n");
}

const DEVICES = "inputs.prepare == 'devices'";
const DEVICES_LINUX = `${DEVICES} && inputs.os == 'linux'`;
const DEVICES_MACOS = `${DEVICES} && inputs.os == 'macos'`;

/** The box run's device-cache restores (only when `prepare=devices`; restores only, see device-cache.ts). */
function deviceRestoreSteps(): string {
  return [
    setupNodeStep(DEVICES),
    runStep({ name: "Find the Xcode build", id: "xcode", if: DEVICES_MACOS, script: XCODE_BUILD_STEP_SCRIPT }),
    cacheStep({
      name: "Restore the Android SDK and AVDs",
      if: DEVICES_LINUX,
      action: "restore",
      paths: ANDROID_CACHE_PATHS,
      key: ANDROID_CACHE_KEY,
      bestEffort: true
    }),
    cacheStep({
      name: "Restore the device tools",
      if: DEVICES,
      action: "restore",
      paths: DEVICE_TOOLS_CACHE_PATHS,
      key: `\${{ inputs.os == 'linux' && '${deviceToolsCacheKey("linux")}' || '${deviceToolsCacheKey("macos")}' }}`,
      bestEffort: true
    }),
    cacheStep({
      name: "Restore agent-device's iOS runner",
      if: `${DEVICES_MACOS} && steps.xcode.outputs.build != ''`,
      action: "restore",
      paths: APPLE_RUNNER_CACHE_PATHS,
      key: appleRunnerCacheKey("${{ steps.xcode.outputs.build }}"),
      bestEffort: true
    })
  ].join("\n");
}

function checkTailscale(options: BlacksmithWorkflowOptions): { oauthClientId: string; audience: string } | null {
  const tailscale = options.tailscale ?? null;
  if (tailscale !== null && (!TAILSCALE_VALUE.test(tailscale.oauthClientId) || !TAILSCALE_VALUE.test(tailscale.audience))) {
    throw new Error("Invalid Tailscale workload identity settings");
  }
  return tailscale;
}

/** The box workflow file's content. Deterministic: the control repo client compares it to decide whether to commit. */
export function blacksmithWorkflowTemplate(options: BlacksmithWorkflowOptions = {}): string {
  const tailscale = checkTailscale(options);
  const tailscaleStep =
    tailscale === null
      ? ""
      : `      - name: Join the tailnet
        uses: tailscale/github-action@v4
        with:
          oauth-client-id: "${tailscale.oauthClientId}"
          audience: "${tailscale.audience}"
          tags: tag:orq-box
          hostname: orq-\${{ inputs.box_id }}
`;
  return `# Orquester boxes (Ephemeral AI VMs) on Blacksmith. Managed by Orquester: edits are overwritten.
# Each run is one macOS or Linux box. It downloads orq-agent from the Orquester
# daemon, authenticated with this job's GitHub OIDC token, and runs it until the
# box is destroyed or the time limit ends. Device hosts restore the device caches
# that orquester-device-cache.yml saves. No secrets are stored in this repository.
name: Orquester box
run-name: orq-\${{ inputs.box_id }}

on:
  workflow_dispatch:
    inputs:
      box_id:
        description: Orquester box id
        required: true
        type: string
      lifetime_minutes:
        description: Time limit in minutes (1-${BLACKSMITH_MAX_LIFETIME_MINUTES})
        required: true
        type: string
      daemon_url:
        description: Orquester daemon URL
        required: true
        type: string
      runner:
        description: Blacksmith runner
        required: true
        type: choice
        options:
${BLACKSMITH_RUNNER_LABELS.map((label) => `          - ${label}`).join("\n")}
      os:
        description: The runner's OS
        required: false
        type: choice
        default: macos
        options:
${BLACKSMITH_OSES.map((os) => `          - ${os}`).join("\n")}
      prepare:
        description: What to prepare before orq-agent starts
        required: false
        type: choice
        default: none
        options:
${BLACKSMITH_PREPARES.map((prepare) => `          - ${prepare}`).join("\n")}

permissions:
  id-token: write
  contents: read

jobs:
  box:
    name: orq-\${{ inputs.box_id }}
    runs-on: \${{ inputs.runner }}
    timeout-minutes: \${{ fromJSON(inputs.lifetime_minutes) }}
    steps:
${runStep({
  name: "Check inputs",
  env: {
    BOX_ID: "${{ inputs.box_id }}",
    DAEMON_URL: "${{ inputs.daemon_url }}",
    LIFETIME: "${{ inputs.lifetime_minutes }}",
    RUNNER: "${{ inputs.runner }}",
    OS: "${{ inputs.os }}",
    PREPARE: "${{ inputs.prepare }}"
  },
  script: CHECK_STEP_SCRIPT
})}
${runStep({ name: "Enable KVM", if: "inputs.os == 'linux'", script: KVM_STEP_SCRIPT })}
${tailscaleStep}${runStep({
  name: "Download orq-agent",
  env: {
    BOX_ID: "${{ inputs.box_id }}",
    DAEMON_URL: "${{ inputs.daemon_url }}",
    AGENT_PLATFORM: "${{ inputs.os == 'linux' && 'linux-x64' || 'darwin-arm64' }}"
  },
  script: DOWNLOAD_STEP_SCRIPT
})}
${runStep({ name: "Prepare paths", env: { PREPARE: "${{ inputs.prepare }}" }, script: PATHS_STEP_SCRIPT })}
${deviceRestoreSteps()}
      - name: Run orq-agent
        env:
          ORQ_DAEMON_URL: \${{ inputs.daemon_url }}
          ORQ_BOX_ID: \${{ inputs.box_id }}
          ORQ_GITHUB_OIDC: "1"
        run: exec "$HOME/.orq-agent/bin/orq-agent" run
`;
}

const ANDROID_MISS = "steps.android.outputs.cache-hit != 'true'";
const TOOLS_MISS = "steps.tools.outputs.cache-hit != 'true'";
const RUNNER_MISS = "steps.xcode.outputs.build != '' && steps.runner.outputs.cache-hit != 'true'";

/** Restore (or look up) the tools cache, install on a miss, save. */
function toolsSteps(os: BlacksmithOs, lookupOnly: boolean): string {
  const key = deviceToolsCacheKey(os);
  return [
    setupNodeStep(null),
    cacheStep({
      name: lookupOnly ? "Look up the device tools cache" : "Restore the device tools",
      id: "tools",
      action: "restore",
      paths: DEVICE_TOOLS_CACHE_PATHS,
      key,
      lookupOnly
    }),
    runStep({ name: "Install the device tools", if: TOOLS_MISS, script: DEVICE_TOOLS_STEP_SCRIPT }),
    cacheStep({ name: "Save the device tools", if: TOOLS_MISS, action: "save", paths: DEVICE_TOOLS_CACHE_PATHS, key })
  ].join("\n");
}

function cacheJobHead(os: BlacksmithOs): string {
  return `  ${os}:
    name: orq-cache-${os}
    if: inputs.os == '${os}'
    runs-on: \${{ inputs.runner }}
    timeout-minutes: ${BLACKSMITH_DEVICE_CACHE_TIMEOUT_MINUTES}
    steps:
${runStep({
  name: "Check inputs",
  env: { REQUEST_ID: "${{ inputs.request_id }}", RUNNER: "${{ inputs.runner }}", OS: "${{ inputs.os }}" },
  script: CACHE_CHECK_STEP_SCRIPT
})}`;
}

/**
 * The cache-warming workflow file's content (`orquester-device-cache.yml`). One run builds and
 * saves the device caches of one OS; caches that already exist are only looked up, not rebuilt.
 * It never talks to the daemon. Deterministic, like {@link blacksmithWorkflowTemplate}.
 */
export function blacksmithDeviceCacheWorkflowTemplate(): string {
  return `# Orquester device caches on Blacksmith. Managed by Orquester: edits are overwritten.
# Builds and saves what device-host boxes restore before orq-agent starts:
# Linux: the Android SDK, system image and AVDs with golden snapshots; macOS:
# agent-device's iOS runner; both: the pinned device tools. No secrets are
# stored in this repository.
name: Orquester device cache
run-name: orq-cache-\${{ inputs.os }}-\${{ inputs.request_id }}

on:
  workflow_dispatch:
    inputs:
      request_id:
        description: Orquester request id
        required: true
        type: string
      os:
        description: Which caches to build
        required: true
        type: choice
        options:
${BLACKSMITH_OSES.map((os) => `          - ${os}`).join("\n")}
      runner:
        description: Blacksmith runner
        required: true
        type: choice
        options:
${BLACKSMITH_RUNNER_LABELS.map((label) => `          - ${label}`).join("\n")}

permissions:
  contents: read

jobs:
${cacheJobHead("linux")}
${runStep({ name: "Enable KVM", script: KVM_STEP_SCRIPT })}
${runStep({ name: "Prepare paths", env: { PREPARE: "devices" }, script: PATHS_STEP_SCRIPT })}
${cacheStep({ name: "Look up the Android cache", id: "android", action: "restore", paths: ANDROID_CACHE_PATHS, key: ANDROID_CACHE_KEY, lookupOnly: true })}
      - name: Set up Java for the Android SDK tools
        if: ${ANDROID_MISS}
        uses: actions/setup-java@v4
        with:
          distribution: temurin
          java-version: "17"
${runStep({ name: "Install the Android SDK", if: ANDROID_MISS, script: ANDROID_SDK_STEP_SCRIPT })}
${runStep({ name: "Create the AVDs and their golden snapshots", if: ANDROID_MISS, script: ANDROID_AVD_STEP_SCRIPT })}
${cacheStep({ name: "Save the Android cache", if: ANDROID_MISS, action: "save", paths: ANDROID_CACHE_PATHS, key: ANDROID_CACHE_KEY })}
${toolsSteps("linux", true)}

${cacheJobHead("macos")}
${runStep({ name: "Prepare paths", env: { PREPARE: "devices" }, script: PATHS_STEP_SCRIPT })}
${toolsSteps("macos", false)}
${runStep({ name: "Find the Xcode build", id: "xcode", script: XCODE_BUILD_STEP_SCRIPT })}
${cacheStep({
  name: "Look up agent-device's iOS runner",
  id: "runner",
  if: "steps.xcode.outputs.build != ''",
  action: "restore",
  paths: APPLE_RUNNER_CACHE_PATHS,
  key: appleRunnerCacheKey("${{ steps.xcode.outputs.build }}"),
  lookupOnly: true
})}
${runStep({ name: "Build agent-device's iOS runner", if: RUNNER_MISS, script: APPLE_RUNNER_STEP_SCRIPT })}
${cacheStep({
  name: "Save agent-device's iOS runner",
  if: RUNNER_MISS,
  action: "save",
  paths: APPLE_RUNNER_CACHE_PATHS,
  key: appleRunnerCacheKey("${{ steps.xcode.outputs.build }}")
})}
`;
}
