//go:build !linux

package agent

import "time"

// processStartID: only Linux can tell a process from a later one with its pid,
// so elsewhere nothing is recorded, and a restart cannot find what it left.
func processStartID(int) string { return "" }

func stopOrphan(procStateEntry, time.Duration) string { return "" }
