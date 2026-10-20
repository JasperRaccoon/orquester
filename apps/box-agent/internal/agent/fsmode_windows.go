//go:build windows

package agent

import "io/fs"

// nodeMode synthesises Node's st_mode on Windows: S_IFDIR/S_IFREG/S_IFLNK plus
// 0o666 (0o444 when read-only), and 0o111 for directories, like libuv does.
func nodeMode(info fs.FileInfo) uint32 {
	mode := info.Mode()
	perm := uint32(0o666)
	if mode.Perm()&0o200 == 0 {
		perm = 0o444
	}
	switch {
	case mode&fs.ModeSymlink != 0:
		return 0o120000 | perm
	case mode.IsDir():
		return 0o040000 | perm | 0o111
	default:
		return 0o100000 | perm
	}
}

// fileIdentity is unavailable from a FileInfo on Windows (box-protocol.ts allows null).
func fileIdentity(fs.FileInfo) *string { return nil }
