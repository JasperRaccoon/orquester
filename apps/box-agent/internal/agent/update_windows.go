//go:build windows

package agent

import (
	"os"
	"os/exec"
	"syscall"

	"golang.org/x/sys/windows"
)

// replaceExecutable: a running .exe cannot be overwritten or deleted, but it
// can be renamed. Move it aside (removed on the next start), then move the
// staged build into its place; roll back if the second rename fails.
func replaceExecutable(staged, exe string) error {
	old := exe + ".old"
	_ = os.Remove(old)
	if err := os.Rename(exe, old); err != nil {
		return err
	}
	if err := os.Rename(staged, exe); err != nil {
		_ = os.Rename(old, exe)
		return err
	}
	return nil
}

// Reexec starts the updated executable as a new detached process; the caller
// then exits. (Under the service manager the caller exits non-zero instead and
// the service's recovery action restarts it.)
func Reexec(env []string) error {
	exe, err := executablePath()
	if err != nil {
		return err
	}
	cmd := exec.Command(exe, os.Args[1:]...)
	cmd.Env = env
	cmd.SysProcAttr = &syscall.SysProcAttr{
		HideWindow:    true,
		CreationFlags: windows.CREATE_NEW_PROCESS_GROUP | windows.DETACHED_PROCESS,
	}
	return cmd.Start()
}
