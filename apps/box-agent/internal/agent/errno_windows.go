//go:build windows

package agent

import (
	"syscall"

	"golang.org/x/sys/windows"
)

func errnoName(errno syscall.Errno) string {
	switch errno {
	case windows.ERROR_FILE_NOT_FOUND, windows.ERROR_PATH_NOT_FOUND:
		return "ENOENT"
	case windows.ERROR_ALREADY_EXISTS, windows.ERROR_FILE_EXISTS:
		return "EEXIST"
	case windows.ERROR_ACCESS_DENIED:
		return "EACCES"
	case windows.ERROR_DIR_NOT_EMPTY:
		return "ENOTEMPTY"
	case windows.ERROR_DIRECTORY:
		return "ENOTDIR"
	case windows.ERROR_NOT_SAME_DEVICE:
		return "EXDEV"
	case windows.ERROR_DISK_FULL:
		return "ENOSPC"
	case windows.ERROR_SHARING_VIOLATION, windows.ERROR_LOCK_VIOLATION:
		return "EBUSY"
	case windows.ERROR_INVALID_PARAMETER, windows.ERROR_INVALID_NAME:
		return "EINVAL"
	case windows.WSAECONNREFUSED:
		return "ECONNREFUSED"
	case windows.WSAEADDRINUSE:
		return "EADDRINUSE"
	}
	return ""
}
