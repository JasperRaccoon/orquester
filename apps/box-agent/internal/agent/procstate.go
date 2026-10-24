package agent

import (
	"encoding/json"
	"errors"
	"log"
	"os"
	"sync"
)

// procStateFile, in the data dir, records the running detached processes, so
// an orq-agent that restarted (a crash, a service restart) knows what the
// previous one left running. Their output pipes ended with that orq-agent, so
// nothing can follow them any more: they are stopped and reported as lost
// rather than left running unseen.
const procStateFile = "procs.json"

type procState struct {
	// Agent is the orq-agent that wrote the file: while it still runs, its
	// processes are its own and a second instance leaves them alone.
	Agent procIdentity     `json:"agent"`
	Procs []procStateEntry `json:"procs"`
}

type procIdentity struct {
	PID int `json:"pid"`
	// Start tells the process apart from a later one with the same pid
	// (Linux: the start time in /proc/<pid>/stat).
	Start string `json:"start"`
}

type procStateEntry struct {
	ProcID string `json:"procId"`
	procIdentity
	// Session: a PTY process leads its own session (its background jobs are
	// other groups of it); otherwise it leads its own process group.
	Session bool `json:"session"`
}

const (
	lostStopped = "orq-agent restarted in the box, so this process's output could no longer be followed; it was stopped"
	lostEnded   = "orq-agent restarted in the box, so this process's output could no longer be followed; it has ended"
)

// alive: the process `id` names still runs (not merely the same pid).
func (id procIdentity) alive() bool {
	return id.PID > 0 && id.Start != "" && processStartID(id.PID) == id.Start
}

// persist rewrites the state file from the running processes; a no-op without one.
func (r *procRegistry) persist() error {
	if r.statePath == "" {
		return nil
	}
	r.writeMu.Lock()
	defer r.writeMu.Unlock()
	state := procState{Agent: r.self, Procs: []procStateEntry{}}
	r.mu.Lock()
	for _, d := range r.procs {
		d.mu.Lock()
		if d.running && d.startID != "" {
			state.Procs = append(state.Procs, procStateEntry{
				ProcID:       d.id,
				procIdentity: procIdentity{PID: d.pid, Start: d.startID},
				Session:      d.pty,
			})
		}
		d.mu.Unlock()
	}
	r.mu.Unlock()
	data, err := json.Marshal(state)
	if err != nil {
		return err
	}
	return writeFileAtomic(r.statePath, data, 0o600)
}

// recoverFrom takes over what a previous orq-agent recorded in `statePath`: a
// process still running is stopped, and each one is listed as lost (ended,
// with the reason) until the daemon releases it. From then on the registry
// records its processes there.
func (r *procRegistry) recoverFrom(statePath string, logger *log.Logger) {
	self := procIdentity{PID: os.Getpid(), Start: processStartID(os.Getpid())}
	var state procState
	data, err := os.ReadFile(statePath)
	switch {
	case errors.Is(err, os.ErrNotExist):
	case err != nil:
		logger.Printf("reading %s: %v", statePath, err)
	case json.Unmarshal(data, &state) != nil:
		logger.Printf("%s is not valid; ignoring it", statePath)
		state = procState{}
	}
	if state.Agent.PID != self.PID && state.Agent.alive() {
		// Another orq-agent on this data dir still runs and owns these.
		logger.Printf("orq-agent %d still runs on this data dir; not recording detached processes", state.Agent.PID)
		return
	}
	// Stopped side by side: each may take its SIGTERM grace, and the link waits for all of them.
	var wg sync.WaitGroup
	for _, entry := range state.Procs {
		if entry.ProcID == "" || entry.PID <= 0 || entry.Start == "" || r.get(entry.ProcID) != nil {
			continue
		}
		d := &detachedProc{id: entry.ProcID, ring: newRing(0), delivered: true, lost: lostEnded}
		d.ring.finish()
		r.mu.Lock()
		r.procs[d.id] = d
		r.mu.Unlock()
		if !entry.alive() {
			continue
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			if signal := stopOrphan(entry, hangupGrace); signal != "" {
				d.mu.Lock()
				d.signal = &signal
				d.lost = lostStopped
				d.mu.Unlock()
				logger.Printf("detached process %s (pid %d) outlived the previous orq-agent; stopped it with %s", entry.ProcID, entry.PID, signal)
			}
		}()
	}
	wg.Wait()
	r.statePath = statePath
	r.self = self
	if err := r.persist(); err != nil {
		logger.Printf("writing %s: %v", statePath, err)
	}
}
