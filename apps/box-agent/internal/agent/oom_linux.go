//go:build linux

package agent

import (
	"os"
	"strconv"
	"strings"
	"sync"
)

// Pairing and the box bootstrap give orq-agent a strongly negative OOMScoreAdjust (a systemd
// drop-in), so the kernel's OOM killer never picks it and the machine stays reachable. A child
// inherits its parent's oom_score_adj, so without this every process orq-agent starts (agent
// CLIs, test runs, emulators, terminals, SSH sessions) would be protected too, and the kernel would
// kill the desktop or small system daemons before the process actually exhausting memory.
//
// So each child gets childOOMScoreAdj back right after it starts. Go runs no code in the child
// between fork and exec, so this is written from the parent after Start returns: for that brief
// window (the child's first instructions after exec) it still has orq-agent's score, and only a
// process it forks within that window keeps it. Raising a score needs no privilege, so this works
// for the root unit and for the user unit alike.

// childOOMScoreAdj is what a process orq-agent starts gets: the kernel's neutral score.
var childOOMScoreAdj = 0

// ownOOMScoreAdj reads orq-agent's own score; read once (see protectedOOMScore).
var ownOOMScoreAdj = func() (int, error) {
	data, err := os.ReadFile("/proc/self/oom_score_adj")
	if err != nil {
		return 0, err
	}
	return strconv.Atoi(strings.TrimSpace(string(data)))
}

// protectedOOMScore: orq-agent's own score is below 0, so its children must not inherit it.
var protectedOOMScore = sync.OnceValue(ownScoreBelowZero)

func ownScoreBelowZero() bool {
	score, err := ownOOMScoreAdj()
	return err == nil && score < 0
}

// resetChildOOMScore gives a just-started child the neutral OOM score when orq-agent is
// protected. A child that already exited (or a /proc that refuses) is left alone.
func resetChildOOMScore(pid int) {
	if pid <= 0 || !protectedOOMScore() {
		return
	}
	_ = os.WriteFile("/proc/"+strconv.Itoa(pid)+"/oom_score_adj", []byte(strconv.Itoa(childOOMScoreAdj)+"\n"), 0)
}
