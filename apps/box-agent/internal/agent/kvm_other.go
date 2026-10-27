//go:build !linux

package agent

// detectKVM: KVM exists only on Linux.
func detectKVM(*workUser) bool { return false }
