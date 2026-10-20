//go:build darwin

package agent

import "golang.org/x/sys/unix"

// listPids lists the ids of the running processes.
func listPids() []int {
	procs, _ := unix.SysctlKinfoProcSlice("kern.proc.all")
	pids := make([]int, 0, len(procs))
	for _, proc := range procs {
		if pid := int(proc.Proc.P_pid); pid > 0 {
			pids = append(pids, pid)
		}
	}
	return pids
}
