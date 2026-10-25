//go:build linux

package agent

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
)

const systemdUnitPath = "/etc/systemd/system/orq-agent.service"

// needrestartDir is needrestart's config dir. Ubuntu and Debian run needrestart after every apt
// run, unattended-upgrades included, and it restarts a unit when a process in the unit's cgroup
// still maps an upgraded library. KillMode=process keeps the agent CLIs and terminals orq-agent
// started in its cgroup, so after one upgrade every later apt run restarts orq-agent again, and
// each restart loses its record of those processes: no reattach can reach them.
const needrestartDir = "/etc/needrestart"

// needrestartOverride tells needrestart never to restart orq-agent.service by itself.
const needrestartOverride = "# Written by orq-agent: restarting orq-agent.service loses the agent CLIs and terminals it runs.\n" +
	"$nrconf{override_rc}->{qr(^orq-agent\\.service$)} = 0;\n"

// systemdDropInDir holds orq-agent.service's drop-ins.
const systemdDropInDir = "/etc/systemd/system/orq-agent.service.d"

// oomPolicyDropIn: systemd's default OOMPolicy=stop stops the whole unit when the kernel's OOM
// killer kills any process in its cgroup. KillMode=process keeps the agent CLIs and test runs
// orq-agent starts in that cgroup, so one test run that exhausts the box's memory stopped
// orq-agent, and every agent CLI it served ended with it (their stdin is orq-agent's pipe).
const oomPolicyDropIn = "# Written by orq-agent: a process of this unit killed for memory (a test run) must not stop\n" +
	"# orq-agent, and with it every agent CLI it serves.\n" +
	"[Service]\n" +
	"OOMPolicy=continue\n"

// ProtectService keeps package upgrades (see needrestartDir) and a process killed for memory
// (see oomPolicyDropIn) from stopping orq-agent. It runs at every start, so boxes installed
// before it existed get it with their next update.
func ProtectService() error {
	if os.Geteuid() != 0 {
		return nil
	}
	if err := writeNeedrestartOverride(needrestartDir); err != nil {
		return err
	}
	if !pathExists("/run/systemd/system") || !pathExists(systemdUnitPath) {
		return nil
	}
	changed, err := writeOOMPolicyDropIn(systemdDropInDir)
	if err != nil || !changed {
		return err
	}
	// Applies to the running unit at once; nothing is restarted.
	if out, err := exec.Command("systemctl", "daemon-reload").CombinedOutput(); err != nil {
		return fmt.Errorf("systemctl daemon-reload: %v: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}

// writeOOMPolicyDropIn writes the OOM policy drop-in under `dir`; false when it was already there.
func writeOOMPolicyDropIn(dir string) (bool, error) {
	path := filepath.Join(dir, "oom-policy.conf")
	if current, err := os.ReadFile(path); err == nil && string(current) == oomPolicyDropIn {
		return false, nil
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return false, err
	}
	return true, writeFileAtomic(path, []byte(oomPolicyDropIn), 0o644)
}

// writeNeedrestartOverride writes the override under `dir` when needrestart is installed there.
func writeNeedrestartOverride(dir string) error {
	if !pathExists(dir) {
		return nil
	}
	confDir := filepath.Join(dir, "conf.d")
	path := filepath.Join(confDir, "orq-agent.conf")
	if current, err := os.ReadFile(path); err == nil && string(current) == needrestartOverride {
		return nil
	}
	if err := os.MkdirAll(confDir, 0o755); err != nil {
		return err
	}
	return writeFileAtomic(path, []byte(needrestartOverride), 0o644)
}

// InstallService installs and starts orq-agent as a systemd unit when systemd
// runs; otherwise (containers, Fly machines) it starts `orq-agent run` as a
// detached background process.
func InstallService(cfg Config) error {
	if err := writeServiceEnv(cfg); err != nil {
		return err
	}
	exe, err := executablePath()
	if err != nil {
		return err
	}
	if !pathExists("/run/systemd/system") || os.Geteuid() != 0 {
		return startBackground(exe, cfg)
	}
	// KillMode=process: a crash or restart of orq-agent must not take the
	// detached processes (agent CLIs, terminals) it owns with it.
	unit := strings.Join([]string{
		"[Unit]",
		"Description=Orquester box agent (orq-agent)",
		"Wants=network-online.target",
		"After=network-online.target",
		"",
		"[Service]",
		"Type=simple",
		fmt.Sprintf("ExecStart=%s run --data-dir %s", systemdQuote(exe), systemdQuote(cfg.DataDir)),
		"Restart=on-failure",
		"RestartSec=2",
		"KillMode=process",
		"",
		"[Install]",
		"WantedBy=multi-user.target",
		"",
	}, "\n")
	if err := writeFileAtomic(systemdUnitPath, []byte(unit), 0o644); err != nil {
		return err
	}
	if err := ProtectService(); err != nil {
		return fmt.Errorf("writing the needrestart override: %w", err)
	}
	for _, args := range [][]string{{"daemon-reload"}, {"enable", "orq-agent.service"}, {"restart", "orq-agent.service"}} {
		out, err := exec.Command("systemctl", args...).CombinedOutput()
		if err != nil {
			return fmt.Errorf("systemctl %s: %v: %s", strings.Join(args, " "), err, strings.TrimSpace(string(out)))
		}
	}
	return nil
}

func systemdQuote(value string) string {
	if !strings.ContainsAny(value, " \t\"'\\") {
		return value
	}
	return `"` + strings.NewReplacer(`\`, `\\`, `"`, `\"`).Replace(value) + `"`
}

func startBackground(exe string, cfg Config) error {
	logPath := filepath.Join(cfg.DataDir, "agent.log")
	logFile, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return err
	}
	defer logFile.Close()
	cmd := exec.Command(exe, "run", "--data-dir", cfg.DataDir)
	cmd.Stdout = logFile
	cmd.Stderr = logFile
	cmd.Env = os.Environ()
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		return err
	}
	return cmd.Process.Release()
}

// RunService is only meaningful on Windows.
func RunService(func() int) (bool, error) { return false, nil }

// SetServiceStop is only meaningful on Windows.
func SetServiceStop(func()) {}
