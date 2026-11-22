//go:build !windows

package agent

import (
	"os"
	"path/filepath"
	"strconv"
)

// sshDefaultPath is sshd's PATH when orq-agent's env has none.
const sshDefaultPath = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

// sshShellArgv is what sshd runs: a login shell ("-bash"), or `shell -c command`.
func sshShellArgv(shell, command string, isExec bool) []string {
	name := filepath.Base(shell)
	if isExec {
		return []string{name, "-c", command}
	}
	return []string{"-" + name}
}

// sshPlatformEnv sets the login variables sshd sets.
func sshPlatformEnv(env *envMap, login sshLoginInfo, work *workUser) {
	env.set("HOME", login.home)
	env.set("USER", login.user)
	env.set("LOGNAME", login.user)
	env.set("SHELL", login.shell)
	env.setDefault("PATH", sshDefaultPath)
	if work == nil {
		return
	}
	// orq-agent runs as root here: root's per-user locations are not the work user's.
	env.del("MAIL")
	env.del("XDG_RUNTIME_DIR")
	runtimeDir := "/run/user/" + strconv.FormatUint(uint64(work.uid), 10)
	if st, err := os.Stat(runtimeDir); err == nil && st.IsDir() {
		env.set("XDG_RUNTIME_DIR", runtimeDir)
	}
}
