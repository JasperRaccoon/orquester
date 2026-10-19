//go:build darwin

package agent

import "errors"

// InstallService: macOS boxes are GitHub Actions jobs; orq-agent runs in the
// foreground as the job's long-running step (`orq-agent run`).
func InstallService(Config) error {
	return errors.New("install-service is not used on macOS; run `orq-agent run` as the job step")
}

// RunService is only meaningful on Windows.
func RunService(func() int) (bool, error) { return false, nil }

// SetServiceStop is only meaningful on Windows.
func SetServiceStop(func()) {}
