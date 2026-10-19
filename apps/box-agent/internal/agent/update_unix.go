//go:build !windows

package agent

import (
	"os"
	"syscall"
)

// replaceExecutable renames the staged build over the executable (atomic on
// one filesystem; the running image is unaffected).
func replaceExecutable(staged, exe string) error {
	return os.Rename(staged, exe)
}

// Reexec replaces this process with the (updated) executable, same pid, so
// systemd and the job step keep tracking it.
func Reexec(env []string) error {
	exe, err := executablePath()
	if err != nil {
		return err
	}
	return syscall.Exec(exe, os.Args, env)
}
