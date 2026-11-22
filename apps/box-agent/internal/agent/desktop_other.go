//go:build !windows

package agent

import (
	"errors"
	"io"
	"os"
)

// Only Windows separates the service's session from the user's desktop: elsewhere orq-agent runs
// where its user's programs do (a LaunchAgent in the Mac's GUI session, a systemd unit), so there
// is no helper and an exec with session "desktop" fails with NO_DESKTOP_SESSION.

func (a *Agent) startDesktop() io.Closer { return nil }

var errDesktopHelperWindowsOnly = errors.New("the desktop-session helper exists only on Windows")

// DesktopHelperCommand is only meaningful on Windows.
func DesktopHelperCommand(string, string) int {
	_, _ = os.Stderr.WriteString("orq-agent: " + errDesktopHelperWindowsOnly.Error() + "\n")
	return 2
}

// InstallDesktopHelperCommand is only meaningful on Windows.
func InstallDesktopHelperCommand(DesktopHelperOptions, io.Writer) error {
	return errDesktopHelperWindowsOnly
}

// UninstallDesktopHelperCommand is only meaningful on Windows.
func UninstallDesktopHelperCommand(DesktopHelperOptions, io.Writer) error {
	return errDesktopHelperWindowsOnly
}
