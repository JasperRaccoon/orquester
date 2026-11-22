//go:build linux

package agent

import (
	"io"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"testing"

	"orquester/box-agent/internal/wire"
)

// readOOMScore reads a process's oom_score_adj.
func readOOMScore(t *testing.T, path string) int {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Skipf("no oom_score_adj here: %v", err)
	}
	score, err := strconv.Atoi(strings.TrimSpace(string(data)))
	if err != nil {
		t.Fatal(err)
	}
	return score
}

// childScore starts a shell through startProcess (pipes, or a PTY) that prints its own
// oom_score_adj once it reads a line, and returns that score. The line is sent after
// startProcess returned, so the score is read after the reset (not inside the window before it).
func childScore(t *testing.T, withPty bool) int {
	t.Helper()
	spec := &startSpec{path: "/bin/sh", args: []string{"sh", "-c", "read line; echo score=$(cat /proc/self/oom_score_adj)"}, env: os.Environ()}
	if withPty {
		spec.pty = &wire.PtySpec{Cols: 80, Rows: 24}
	}
	proc, err := startProcess(spec)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := io.WriteString(proc.stdin(), "go\n"); err != nil {
		t.Fatal(err)
	}
	out, _ := io.ReadAll(proc.stdout())
	proc.wait()
	proc.release()
	match := regexp.MustCompile(`score=(-?\d+)`).FindSubmatch(out)
	if match == nil {
		t.Fatalf("child printed %q", out)
	}
	score, _ := strconv.Atoi(string(match[1]))
	return score
}

// Every process orq-agent starts gets the neutral score back when orq-agent itself is protected.
// The test process stands in for a protected orq-agent: it raises its own score (no privilege
// needed), so a child that kept the inherited value is told apart from one that was reset; the
// reset target is the test process's original score (lowering below it would need privilege).
func TestChildrenDoNotInheritAProtectedOOMScore(t *testing.T) {
	original := readOOMScore(t, "/proc/self/oom_score_adj")
	if original > 900 {
		t.Skipf("oom_score_adj %d leaves no room to raise", original)
	}
	inherited := original + 100
	if err := os.WriteFile("/proc/self/oom_score_adj", []byte(strconv.Itoa(inherited)), 0); err != nil {
		t.Skipf("cannot change this process's oom_score_adj: %v", err)
	}
	ownScore, target, protected := ownOOMScoreAdj, childOOMScoreAdj, protectedOOMScore
	t.Cleanup(func() {
		ownOOMScoreAdj, childOOMScoreAdj, protectedOOMScore = ownScore, target, protected
		_ = os.WriteFile("/proc/self/oom_score_adj", []byte(strconv.Itoa(original)), 0)
	})
	childOOMScoreAdj = original
	ownIs := func(score int) {
		ownOOMScoreAdj = func() (int, error) { return score, nil }
		protectedOOMScore = sync.OnceValue(ownScoreBelowZero)
	}

	ownIs(-900)
	for _, withPty := range []bool{false, true} {
		if got := childScore(t, withPty); got != original {
			t.Errorf("pty=%v: a child of a protected orq-agent has oom_score_adj %d, want %d", withPty, got, original)
		}
	}

	// Not protected: nothing is touched, the child keeps what it inherited.
	ownIs(0)
	if got := childScore(t, false); got != inherited {
		t.Errorf("a child of an unprotected orq-agent has oom_score_adj %d, want the inherited %d", got, inherited)
	}
}
