//go:build !windows

package agent

import (
	"bufio"
	"fmt"
	"os"
	"os/user"
	"strconv"
	"strings"
)

// workUser is the account processes run as when orq-agent runs as root
// with ORQ_WORK_USER set (nil otherwise: everything runs as orq-agent).
type workUser struct {
	name   string
	uid    uint32
	gid    uint32
	groups []uint32
	home   string
	shell  string
}

func resolveWorkUser(name string) (*workUser, error) {
	if name == "" {
		return nil, nil
	}
	u, err := user.Lookup(name)
	if err != nil {
		return nil, fmt.Errorf("ORQ_WORK_USER %q: %w", name, err)
	}
	if os.Geteuid() != 0 {
		if u.Uid == strconv.Itoa(os.Geteuid()) {
			return nil, nil
		}
		return nil, fmt.Errorf("ORQ_WORK_USER %q needs orq-agent to run as root", name)
	}
	if u.Uid == "0" {
		return nil, nil
	}
	uid, err := strconv.ParseUint(u.Uid, 10, 32)
	if err != nil {
		return nil, fmt.Errorf("ORQ_WORK_USER %q: bad uid", name)
	}
	gid, err := strconv.ParseUint(u.Gid, 10, 32)
	if err != nil {
		return nil, fmt.Errorf("ORQ_WORK_USER %q: bad gid", name)
	}
	w := &workUser{name: u.Username, uid: uint32(uid), gid: uint32(gid), home: u.HomeDir, shell: loginShell(u.Username)}
	if ids, err := u.GroupIds(); err == nil {
		for _, id := range ids {
			if g, err := strconv.ParseUint(id, 10, 32); err == nil {
				w.groups = append(w.groups, uint32(g))
			}
		}
	}
	return w, nil
}

func (w *workUser) chown(path string) error { return os.Chown(path, int(w.uid), int(w.gid)) }

func (w *workUser) lchown(path string) error { return os.Lchown(path, int(w.uid), int(w.gid)) }

// loginShell reads a user's shell from /etc/passwd ("" when not listed).
func loginShell(name string) string {
	f, err := os.Open("/etc/passwd")
	if err != nil {
		return ""
	}
	defer f.Close()
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		fields := strings.Split(scanner.Text(), ":")
		if len(fields) >= 7 && fields[0] == name {
			return fields[6]
		}
	}
	return ""
}
