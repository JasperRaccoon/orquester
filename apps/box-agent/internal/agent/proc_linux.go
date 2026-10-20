//go:build linux

package agent

import (
	"os"
	"strconv"
)

// listPids lists the ids of the running processes.
func listPids() []int {
	entries, _ := os.ReadDir("/proc")
	pids := make([]int, 0, len(entries))
	for _, entry := range entries {
		if pid, err := strconv.Atoi(entry.Name()); err == nil && pid > 0 {
			pids = append(pids, pid)
		}
	}
	return pids
}
