//go:build !windows

package agent

import "golang.org/x/sys/unix"

// diskUsage of the filesystem holding path.
func diskUsage(path string) (used, total int64) {
	var st unix.Statfs_t
	if err := unix.Statfs(path, &st); err != nil {
		return 0, 0
	}
	total = int64(st.Blocks) * int64(st.Bsize)
	free := int64(st.Bavail) * int64(st.Bsize)
	return total - free, total
}

// diskPath: the filesystem projects live on (the root).
func (a *Agent) diskPath() string { return "/" }
