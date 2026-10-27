//go:build darwin

package agent

import "errors"

// macOS boxes are either GitHub Actions jobs, where orq-agent runs in the foreground as the
// job's long-running step (`orq-agent run`), or the owner's own Mac, where install-service
// sets up a LaunchAgent (service_plan.go).

// detectServiceManager: launchd needs no detection.
func detectServiceManager(*serviceFacts) {}

// startDetached is unused on macOS: install-service always uses a LaunchAgent.
func startDetached([]string, string) error {
	return errors.New("background start is not used on macOS")
}

// installWindowsService is only meaningful on Windows.
func installWindowsService(Config) error { return errors.New("not Windows") }

// uninstallWindowsService is only meaningful on Windows.
func uninstallWindowsService() error { return errors.New("not Windows") }

// RunService is only meaningful on Windows.
func RunService(func() int) (bool, error) { return false, nil }

// SetServiceStop is only meaningful on Windows.
func SetServiceStop(func()) {}

// ProtectService is only meaningful on Linux.
func ProtectService() error { return nil }
