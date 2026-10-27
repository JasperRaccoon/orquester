package agent

import (
	"bytes"
	"context"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"

	"orquester/box-agent/internal/wire"
)

// probeTimeout bounds every helper command run while detecting the machine.
const probeTimeout = 5 * time.Second

// probe runs a helper command with a deadline; ok is false on any failure.
func probe(name string, args ...string) (string, bool) {
	ctx, cancel := context.WithTimeout(context.Background(), probeTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, name, args...)
	var out bytes.Buffer
	cmd.Stdout = &out
	if err := cmd.Run(); err != nil {
		return out.String(), false
	}
	return out.String(), true
}

func osName() string {
	switch runtime.GOOS {
	case "windows":
		return "win32"
	case "darwin":
		return "darwin"
	default:
		return "linux"
	}
}

func archName() string {
	if runtime.GOARCH == "arm64" {
		return "arm64"
	}
	return "x64"
}

// detectSysInfo gathers BoxSysInfo. When a working user is set, user/home/
// shell describe that account (the one processes run as).
func detectSysInfo(a *Agent) wire.SysInfo {
	info := wire.SysInfo{
		OS:        osName(),
		Arch:      archName(),
		Libc:      detectLibc(),
		OSRelease: osRelease(),
		CPUs:      runtime.NumCPU(),
		MemBytes:  totalMemory(),
		GPUs:      detectGPUs(),
		DataDir:   a.cfg.DataDir,
		Container: detectContainer(),
		Tmux:      detectTmux(),
		Docker:    detectDocker(),
		KVM:       detectKVM(a.work),
	}
	info.Hostname, _ = os.Hostname()
	if exe, err := os.Executable(); err == nil {
		if resolved, err := filepath.EvalSymlinks(exe); err == nil {
			exe = resolved
		}
		info.AgentPath = exe
	}
	if a.work != nil {
		info.User = a.work.name
		info.Home = a.work.home
		info.Shell = a.work.shell
		info.IsRoot = false
		info.CanElevate = true
	} else {
		if u, err := user.Current(); err == nil {
			info.User = u.Username
			info.Home = u.HomeDir
		}
		if home, err := os.UserHomeDir(); err == nil && info.Home == "" {
			info.Home = home
		}
		info.IsRoot = isElevated()
		info.CanElevate = info.IsRoot || canSudo()
		info.Shell = defaultShell(info.User)
	}
	if info.Shell == "" {
		info.Shell = defaultShell(info.User)
	}
	if info.GPUs == nil {
		info.GPUs = []string{}
	}
	return info
}

func defaultShell(userName string) string {
	if isWindows {
		return "powershell.exe"
	}
	if shell := os.Getenv("SHELL"); shell != "" {
		return shell
	}
	if shell := loginShell(userName); shell != "" {
		return shell
	}
	if runtime.GOOS == "darwin" {
		return "/bin/zsh"
	}
	return "/bin/sh"
}

var tmuxVersion = regexp.MustCompile(`(\d+)\.(\d+)`)

// detectTmux: tmux ≥ 3.2 (`tmux 3.4`, `tmux 3.3a`, `tmux next-3.5`).
func detectTmux() bool {
	if isWindows {
		return false
	}
	out, ok := probe("tmux", "-V")
	if !ok {
		return false
	}
	m := tmuxVersion.FindStringSubmatch(out)
	if m == nil {
		return false
	}
	major, _ := strconv.Atoi(m[1])
	minor, _ := strconv.Atoi(m[2])
	return major > 3 || (major == 3 && minor >= 2)
}

func detectDocker() bool {
	out, ok := probe("docker", "info", "--format", "{{.ServerVersion}}")
	return ok && strings.TrimSpace(out) != ""
}

func canSudo() bool {
	if isWindows {
		return false
	}
	_, ok := probe("sudo", "-n", "true")
	return ok
}

// detectGPUs: nvidia-smi everywhere, then OS-specific sources.
func detectGPUs() []string {
	var gpus []string
	if out, ok := probe("nvidia-smi", "--query-gpu=name", "--format=csv,noheader"); ok {
		for _, line := range strings.Split(out, "\n") {
			if name := strings.TrimSpace(line); name != "" {
				gpus = append(gpus, name)
			}
		}
	}
	if len(gpus) == 0 {
		gpus = osGPUs()
	}
	return gpus
}
