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
