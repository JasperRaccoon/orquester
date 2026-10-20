//go:build !windows

package agent

import (
	"io/fs"
	"strconv"
	"syscall"
)

// nodeMode is st_mode as Node's fs.Stats.mode reports it (type bits included).
func nodeMode(info fs.FileInfo) uint32 {
	if st, ok := info.Sys().(*syscall.Stat_t); ok {
		return uint32(st.Mode)
	}
	return uint32(info.Mode().Perm())
}

func fileIdentity(info fs.FileInfo) *string {
	st, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return nil
	}
	id := strconv.FormatUint(uint64(st.Dev), 10) + ":" + strconv.FormatUint(uint64(st.Ino), 10)
	return &id
}
