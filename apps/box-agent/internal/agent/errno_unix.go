//go:build !windows

package agent

import "syscall"

func errnoName(errno syscall.Errno) string {
	switch errno {
	case syscall.ENOENT:
		return "ENOENT"
	case syscall.EEXIST:
		return "EEXIST"
	case syscall.EACCES:
		return "EACCES"
	case syscall.EPERM:
		return "EPERM"
	case syscall.ENOTDIR:
		return "ENOTDIR"
	case syscall.EISDIR:
		return "EISDIR"
	case syscall.ENOTEMPTY:
		return "ENOTEMPTY"
	case syscall.EXDEV:
		return "EXDEV"
	case syscall.ENOSPC:
		return "ENOSPC"
	case syscall.EBUSY:
		return "EBUSY"
	case syscall.ELOOP:
		return "ELOOP"
	case syscall.ENAMETOOLONG:
		return "ENAMETOOLONG"
	case syscall.EINVAL:
		return "EINVAL"
	case syscall.ECONNREFUSED:
		return "ECONNREFUSED"
	case syscall.EADDRINUSE:
		return "EADDRINUSE"
	case syscall.EROFS:
		return "EROFS"
	}
	return ""
}
