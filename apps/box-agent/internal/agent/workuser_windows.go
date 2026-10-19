//go:build windows

package agent

import "errors"

// workUser: Windows boxes run processes as orq-agent's own account.
type workUser struct {
	name  string
	home  string
	shell string
}

func resolveWorkUser(name string) (*workUser, error) {
	if name == "" {
		return nil, nil
	}
	return nil, errors.New("ORQ_WORK_USER is not supported on Windows")
}

func (w *workUser) chown(string) error  { return nil }
func (w *workUser) lchown(string) error { return nil }

// loginShell: Windows has no /etc/passwd.
func loginShell(string) string { return "" }
