//go:build windows

package agent

// sshShellArgv: PowerShell (sysInfo's shell on Windows), interactive or running `command`.
func sshShellArgv(shell, command string, isExec bool) []string {
	if isExec {
		return []string{shell, "-NoProfile", "-NonInteractive", "-Command", command}
	}
	return []string{shell, "-NoLogo"}
}

// sshPlatformEnv: Windows processes already carry USERPROFILE, USERNAME and PATH from orq-agent's env.
func sshPlatformEnv(*envMap, sshLoginInfo, *workUser) {}
