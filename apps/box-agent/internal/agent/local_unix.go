//go:build !windows

package agent

import (
	"fmt"
	"io/fs"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"time"
)

// Unix socket paths are limited to ~104 bytes (macOS) / 108 (Linux).
const maxSocketPath = 100

// listenLocal opens a 0600 unix socket (owned by the working user if any).
func listenLocal(path string, work *workUser, _ bool) (net.Listener, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	if info, err := os.Lstat(path); err == nil {
		if info.Mode()&fs.ModeSocket == 0 {
			return nil, fmt.Errorf("%s exists and is not a socket", path)
		}
		// A stale socket from an earlier run.
		_ = os.Remove(path)
	}
	ln, err := net.Listen("unix", path)
	if err != nil {
		return nil, err
	}
	if err := os.Chmod(path, 0o600); err != nil {
		ln.Close()
		return nil, err
	}
	if work != nil {
		if err := work.chown(path); err != nil {
			ln.Close()
			return nil, err
		}
	}
	return ln, nil
}

// DialLocal connects to a control/ssh socket.
func DialLocal(path string, timeout time.Duration) (net.Conn, error) {
	return net.DialTimeout("unix", path, timeout)
}

// localEndpoint is `<dataDir>/<name>.sock`, or the same name in a per-uid
// temp dir when that path is too long for a unix socket.
func localEndpoint(dataDir, name string) string {
	path := filepath.Join(dataDir, name+".sock")
	if len(path) <= maxSocketPath {
		return path
	}
	return filepath.Join(os.TempDir(), fmt.Sprintf("orq-agent-%d", os.Geteuid()), name+".sock")
}

// runAsWorkUser makes a helper command (tar) run as the working user.
func (a *Agent) runAsWorkUser(cmd *exec.Cmd) {
	if a.work == nil {
		return
	}
	cmd.SysProcAttr = &syscall.SysProcAttr{Credential: &syscall.Credential{Uid: a.work.uid, Gid: a.work.gid, Groups: a.work.groups}}
}
