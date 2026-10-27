//go:build linux

package agent

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

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

// detectServiceManager reads which systemd managers install-service can use.
func detectServiceManager(f *serviceFacts) {
	f.SystemSystemd = pathExists("/run/systemd/system")
	f.Needrestart = pathExists(needrestartDir)
	if f.Euid == 0 || !f.SystemSystemd {
		return
	}
	// The user manager's runtime dir: present while it runs (a login session, or lingering).
	if runtimeDir := os.Getenv("XDG_RUNTIME_DIR"); runtimeDir != "" {
		f.UserSystemd = pathExists(filepath.Join(runtimeDir, "systemd"))
	}
	if f.UserSystemd {
		f.Linger = lingerEnabled(f.Username)
	}
}

// lingerEnabled: the user's manager runs without a login session, so a user unit starts at
// boot and survives logout. False when it cannot tell.
func lingerEnabled(username string) bool {
	if username == "" {
		return false
	}
	if pathExists(filepath.Join("/var/lib/systemd/linger", username)) {
		return true
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "loginctl", "show-user", username, "-p", "Linger").Output()
	return err == nil && strings.TrimSpace(string(out)) == "Linger=yes"
}

// startDetached runs argv in its own session, outliving install-service, with its output
// appended to logPath.
func startDetached(argv []string, logPath string) error {
	logFile, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return err
	}
	defer logFile.Close()
	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Stdout = logFile
	cmd.Stderr = logFile
	cmd.Env = os.Environ()
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		return err
	}
	return cmd.Process.Release()
}

// installWindowsService is only meaningful on Windows.
func installWindowsService(Config) error { return errors.New("not Windows") }

// uninstallWindowsService is only meaningful on Windows.
func uninstallWindowsService() error { return errors.New("not Windows") }

// RunService is only meaningful on Windows.
func RunService(func() int) (bool, error) { return false, nil }

// SetServiceStop is only meaningful on Windows.
func SetServiceStop(func()) {}
