//go:build linux

package agent

import (
	"errors"
	"os"
	"strconv"
	"strings"
	"time"

	"golang.org/x/sys/unix"
)

// processStartID is the start time of process `pid` (field 22 of
// /proc/<pid>/stat, in clock ticks since boot): with the pid it names one
// process. "" when there is none, or only its zombie.
func processStartID(pid int) string {
	data, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat")
	if err != nil {
		return ""
	}
	// The command name (field 2) is in parentheses and may hold spaces or ")".
	end := strings.LastIndexByte(string(data), ')')
	if end < 0 {
		return ""
	}
	fields := strings.Fields(string(data[end+1:]))
	// fields[0] is field 3 (the state), so field 22 is fields[19].
	if len(fields) < 20 || fields[0] == "Z" || fields[0] == "X" {
		return ""
	}
	return fields[19]
}

// stopOrphan ends a process a previous orq-agent started, which this one did
// not start and cannot wait for: SIGTERM to its group (its session's groups
// for a PTY), SIGKILL if it is still there after `grace`. Its exit is
// watched through a pidfd. Returns the signal that ended it, or "" when it
// was already gone.
func stopOrphan(entry procStateEntry, grace time.Duration) string {
	pidfd, err := unix.PidfdOpen(entry.PID, 0)
	if err != nil {
		if errors.Is(err, unix.ESRCH) {
			return ""
		}
		pidfd = -1
	} else {
		defer unix.Close(pidfd)
	}
	// The pid may have been reused before the open: only the recorded process is signalled.
	if !entry.alive() {
		return ""
	}
	signalOrphan(entry, unix.SIGTERM)
	if pidfd >= 0 && waitPidfd(pidfd, grace) {
		return "SIGTERM"
	}
	signalOrphan(entry, unix.SIGKILL)
	if pidfd >= 0 {
		waitPidfd(pidfd, grace)
	}
	return "SIGKILL"
}

func signalOrphan(entry procStateEntry, sig unix.Signal) {
	groups := []int{entry.PID}
	if entry.Session {
		for _, group := range sessionGroups(entry.PID) {
			if group != entry.PID {
				groups = append(groups, group)
			}
		}
	}
	for _, group := range groups {
		if err := unix.Kill(-group, sig); errors.Is(err, unix.ESRCH) && group == entry.PID {
			// It left its group (a setpgid or setsid of its own): the process itself.
			_ = unix.Kill(entry.PID, sig)
		}
	}
}

// waitPidfd: whether the process behind `pidfd` exited within `timeout`.
func waitPidfd(pidfd int, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for {
		left := time.Until(deadline)
		if left < 0 {
			left = 0
		}
		fds := []unix.PollFd{{Fd: int32(pidfd), Events: unix.POLLIN}}
		n, err := unix.Poll(fds, int(left.Milliseconds()))
		if errors.Is(err, unix.EINTR) {
			continue
		}
		return err == nil && n > 0
	}
}
