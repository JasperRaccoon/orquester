/**
 * The Blacksmith control repo's workflow (spec §11.2): one workflow run = one
 * macOS box. It is dispatched with `workflow_dispatch` inputs (box id, lifetime,
 * daemon URL, runner label — nothing secret), downloads `orq-agent` from the
 * daemon authenticated with the job's GitHub OIDC token, and runs it in the
 * foreground until the box is destroyed (`orq-agent` exits, or the run is
 * cancelled) or `timeout-minutes` ends it.
 *
 * Inputs are never interpolated into shell: they reach the steps as env vars and
 * are validated first.
 */

/** Name of the private repo created in the owner's org. */
export const BLACKSMITH_CONTROL_REPO_NAME = "orquester-macos-boxes";
export const BLACKSMITH_WORKFLOW_FILE = "orquester-box.yml";
export const BLACKSMITH_WORKFLOW_PATH = `.github/workflows/${BLACKSMITH_WORKFLOW_FILE}`;
/** GitHub's limit for a job on a self-hosted runner, which Blacksmith runners are (5 days). */
export const BLACKSMITH_MAX_LIFETIME_MINUTES = 7200;

export type BlacksmithSize = "6vcpu" | "12vcpu";
export type BlacksmithImage = "macos-15" | "macos-26" | "macos-27";

export const BLACKSMITH_SIZES: ReadonlyArray<{ id: BlacksmithSize; label: string; vcpu: number; ramGb: number; perMinuteUsd: number }> = [
  { id: "6vcpu", label: "6 vCPU M4 · 24 GB", vcpu: 6, ramGb: 24, perMinuteUsd: 0.08 },
  { id: "12vcpu", label: "12 vCPU M4 · 48 GB", vcpu: 12, ramGb: 48, perMinuteUsd: 0.16 }
];

/** Blacksmith's macOS labels (docs.blacksmith.sh, 2026-10): `-latest` is macOS 26; 27 is a public beta. */
export const BLACKSMITH_IMAGES: ReadonlyArray<{ id: BlacksmithImage; label: string }> = [
  { id: "macos-26", label: "macOS 26 Tahoe" },
  { id: "macos-15", label: "macOS 15 Sequoia" },
  { id: "macos-27", label: "macOS 27 (beta)" }
];
export const BLACKSMITH_DEFAULT_IMAGE: BlacksmithImage = "macos-26";

export function isBlacksmithSize(value: unknown): value is BlacksmithSize {
  return BLACKSMITH_SIZES.some((size) => size.id === value);
}

export function isBlacksmithImage(value: unknown): value is BlacksmithImage {
  return BLACKSMITH_IMAGES.some((image) => image.id === value);
}

/** The `runs-on` label for a size and image, e.g. `blacksmith-6vcpu-macos-26`. */
export function blacksmithRunnerLabel(size: BlacksmithSize, image: BlacksmithImage): string {
  return `blacksmith-${size}-${image}`;
}

export const BLACKSMITH_RUNNER_LABELS: readonly string[] = BLACKSMITH_SIZES.flatMap((size) =>
  BLACKSMITH_IMAGES.map((image) => blacksmithRunnerLabel(size.id, image.id))
);

/** The dispatch inputs (all strings: the dispatch API takes strings). */
export interface BlacksmithWorkflowInputs {
  box_id: string;
  lifetime_minutes: string;
  daemon_url: string;
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
URL=\${DAEMON_URL%/}
AUD=$(printf '%s' "$URL" | sed -E 's#^(https://[^/]+).*#\\1#')
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
      "$URL/api/boxes/agent/darwin-arm64") || code=000
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

/** The input check step (bash; exported for tests). */
export const CHECK_STEP_SCRIPT = `set -eu
printf '%s' "$BOX_ID" | grep -Eq '^[A-Za-z0-9-]{8,64}$' || { echo "::error::invalid box_id"; exit 1; }
printf '%s' "$DAEMON_URL" | grep -Eq '^https://[A-Za-z0-9.-]+(:[0-9]+)?(/[A-Za-z0-9._~/-]*)?$' || { echo "::error::invalid daemon_url"; exit 1; }
case "$LIFETIME" in '' | *[!0-9]*) echo "::error::invalid lifetime_minutes"; exit 1 ;; esac
if [ "$LIFETIME" -lt 1 ] || [ "$LIFETIME" -gt ${BLACKSMITH_MAX_LIFETIME_MINUTES} ]; then echo "::error::lifetime_minutes must be 1-${BLACKSMITH_MAX_LIFETIME_MINUTES}"; exit 1; fi
`;

/** Box host paths (spec §8.6) live under the daemon's appdir; orq-agent creates the rest itself. */
export const PATHS_STEP_SCRIPT = `set -eu
sudo mkdir -p /var/lib/orquester
sudo chown "$(id -un)" /var/lib/orquester
`;

function indent(text: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  return text
    .trimEnd()
    .split("\n")
    .map((line) => (line.length > 0 ? pad + line : line))
    .join("\n");
}

/** The workflow file's content. Deterministic: the control repo client compares it to decide whether to commit. */
export function blacksmithWorkflowTemplate(options: BlacksmithWorkflowOptions = {}): string {
  const tailscale = options.tailscale ?? null;
  if (tailscale !== null && (!TAILSCALE_VALUE.test(tailscale.oauthClientId) || !TAILSCALE_VALUE.test(tailscale.audience))) {
    throw new Error("Invalid Tailscale workload identity settings");
  }
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
  return `# Orquester macOS boxes (Ephemeral AI VMs). Managed by Orquester: edits are overwritten.
# Each run is one macOS box. It downloads orq-agent from the Orquester daemon,
# authenticated with this job's GitHub OIDC token, and runs it until the box is
# destroyed or the time limit ends. No secrets are stored in this repository.
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
        description: Blacksmith macOS runner
        required: true
        type: choice
        options:
${BLACKSMITH_RUNNER_LABELS.map((label) => `          - ${label}`).join("\n")}

permissions:
  id-token: write
  contents: read

jobs:
  box:
    name: orq-\${{ inputs.box_id }}
    runs-on: \${{ inputs.runner }}
    timeout-minutes: \${{ fromJSON(inputs.lifetime_minutes) }}
    steps:
      - name: Check inputs
        env:
          BOX_ID: \${{ inputs.box_id }}
          DAEMON_URL: \${{ inputs.daemon_url }}
          LIFETIME: \${{ inputs.lifetime_minutes }}
        run: |
${indent(CHECK_STEP_SCRIPT, 10)}
${tailscaleStep}      - name: Download orq-agent
        env:
          BOX_ID: \${{ inputs.box_id }}
          DAEMON_URL: \${{ inputs.daemon_url }}
        run: |
${indent(DOWNLOAD_STEP_SCRIPT, 10)}
      - name: Prepare paths
        run: |
${indent(PATHS_STEP_SCRIPT, 10)}
      - name: Run orq-agent
        env:
          ORQ_DAEMON_URL: \${{ inputs.daemon_url }}
          ORQ_BOX_ID: \${{ inputs.box_id }}
          ORQ_GITHUB_OIDC: "1"
        run: exec "$HOME/.orq-agent/bin/orq-agent" run
`;
}
