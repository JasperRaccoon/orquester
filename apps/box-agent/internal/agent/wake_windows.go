//go:build windows

package agent

import "syscall"

// setBroadcast turns SO_BROADCAST on for a UDP socket.
func setBroadcast(fd uintptr) error {
	return syscall.SetsockoptInt(syscall.Handle(fd), syscall.SOL_SOCKET, syscall.SO_BROADCAST, 1)
}
