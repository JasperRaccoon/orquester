//go:build !linux

package agent

// resetChildOOMScore: only Linux has an OOM score to reset (see oom_linux.go).
func resetChildOOMScore(int) {}
