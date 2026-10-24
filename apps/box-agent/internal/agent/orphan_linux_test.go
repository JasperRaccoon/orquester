//go:build linux

package agent

import (
	"encoding/json"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

// startLeftover starts `sleep` in its own process group, as a detached process is.
func startLeftover(t *testing.T) *exec.Cmd {
	t.Helper()
	cmd := exec.Command("sleep", "1000")
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
	})
	return cmd
}

func identityOf(t *testing.T, pid int) procIdentity {
	t.Helper()
	start := processStartID(pid)
	if start == "" {
		t.Fatalf("no start time for pid %d", pid)
	}
	return procIdentity{PID: pid, Start: start}
}

func writeState(t *testing.T, state procState) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), procStateFile)
	data, err := json.Marshal(state)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func readState(t *testing.T, path string) procState {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var state procState
	if err := json.Unmarshal(data, &state); err != nil {
		t.Fatal(err)
	}
	return state
}

func quietLogger() *log.Logger { return log.New(io.Discard, "", 0) }

// The previous orq-agent is gone: what it left running is stopped and listed
// as lost; a recorded pid now held by another process is never signalled.
func TestARestartStopsWhatThePreviousAgentLeftRunning(t *testing.T) {
	leftover := startLeftover(t)
	reused := startLeftover(t)
	deadAgent := procIdentity{PID: os.Getpid(), Start: "not-this-process"}
	path := writeState(t, procState{Agent: deadAgent, Procs: []procStateEntry{
		{ProcID: "agent-claude-1", procIdentity: identityOf(t, leftover.Process.Pid)},
		{ProcID: "agent-claude-2", procIdentity: procIdentity{PID: reused.Process.Pid, Start: "1"}},
	}})

	r := newProcRegistry()
	r.recoverFrom(path, quietLogger())

	err := leftover.Wait()
	status, ok := leftover.ProcessState.Sys().(syscall.WaitStatus)
	if err == nil || !ok || !status.Signaled() || status.Signal() != syscall.SIGTERM {
		t.Fatalf("the leftover did not end by SIGTERM: %v", err)
	}
	if processGone(reused.Process.Pid) {
		t.Fatal("signalled a process that only shares a recorded pid")
	}

	listed := map[string]bool{}
	for _, info := range r.list() {
		listed[info.ProcID] = true
		if info.Running || info.Lost == nil || info.PID != nil {
			t.Fatalf("%s is not listed as lost and ended: %+v", info.ProcID, info)
		}
		switch info.ProcID {
		case "agent-claude-1":
			if info.Signal == nil || *info.Signal != "SIGTERM" || *info.Lost != lostStopped {
				t.Fatalf("stopped leftover: %+v", info)
			}
		case "agent-claude-2":
			if info.Signal != nil || *info.Lost != lostEnded {
				t.Fatalf("already-ended leftover: %+v", info)
			}
		}
	}
	if !listed["agent-claude-1"] || !listed["agent-claude-2"] {
		t.Fatalf("listed %v", listed)
	}
	if r.runningCount() != 0 {
		t.Fatal("a lost process holds back updates")
	}

	state := readState(t, path)
	if state.Agent != identityOf(t, os.Getpid()) || len(state.Procs) != 0 {
		t.Fatalf("the record was not taken over: %+v", state)
	}
	// Released by the daemon like any ended process.
	if err := r.release("agent-claude-1"); err != nil || r.get("agent-claude-1") != nil {
		t.Fatalf("release: %v", err)
	}
}

// Another orq-agent still runs on the data dir: its processes are its own.
func TestALiveOwnerKeepsItsProcesses(t *testing.T) {
	owner := startLeftover(t)
	child := startLeftover(t)
	state := procState{Agent: identityOf(t, owner.Process.Pid), Procs: []procStateEntry{
		{ProcID: "agent-claude-1", procIdentity: identityOf(t, child.Process.Pid)},
	}}
	path := writeState(t, state)

	r := newProcRegistry()
	r.recoverFrom(path, quietLogger())

	if processGone(child.Process.Pid) {
		t.Fatal("stopped a process another orq-agent owns")
	}
	if len(r.list()) != 0 || r.statePath != "" {
		t.Fatal("took over another orq-agent's record")
	}
	if got := readState(t, path); len(got.Procs) != 1 || got.Agent != state.Agent {
		t.Fatalf("rewrote another orq-agent's record: %+v", got)
	}
}

// A detached process is on the record while it runs and off it once it ended;
// a lost one refuses a reattach and takes a signal as a no-op.
func TestDetachedProcessesAreRecordedAndALostOneCannotBeFollowed(t *testing.T) {
	d := newTestDaemon(t)
	leftover := startLeftover(t)
	path := writeState(t, procState{Procs: []procStateEntry{
		{ProcID: "old", procIdentity: identityOf(t, leftover.Process.Pid)},
	}})
	d.agent.procs.recoverFrom(path, quietLogger())

	spec := shellSpec("sleep 1000", false)
	spec["detach"] = map[string]any{"procId": "p1"}
	pid := d.openExec(1, spec)
	recorded := readState(t, path).Procs
	if len(recorded) != 1 || recorded[0].ProcID != "p1" || recorded[0].PID != pid || recorded[0].Start != processStartID(pid) {
		t.Fatalf("the running process is not on the record: %+v", recorded)
	}

	d.send(map[string]any{"t": "open", "ch": 2, "spec": map[string]any{"kind": "attach", "procId": "old", "fromOffset": 0}})
	failed := d.expect("open-failed", func(msg map[string]any) bool { return msg["t"] == "open-failed" && msg["ch"] == float64(2) })
	if rpc, _ := failed["error"].(map[string]any); rpc["code"] != "LOST" || rpc["message"] != lostStopped {
		t.Fatalf("the reattach was not refused as lost: %v", failed)
	}
	d.send(map[string]any{"t": "req", "id": 1, "method": "proc.signal", "params": map[string]any{"procId": "old", "signal": "SIGKILL"}})
	if res := d.expect("proc.signal response", func(msg map[string]any) bool { return msg["t"] == "res" && msg["id"] == float64(1) }); res["ok"] != true {
		t.Fatalf("signalling a lost process failed: %v", res)
	}

	d.send(map[string]any{"t": "req", "id": 2, "method": "proc.signal", "params": map[string]any{"procId": "p1", "signal": "SIGTERM"}})
	d.expect("exit", isMsg("exit", 1))
	if left := readState(t, path).Procs; len(left) != 0 {
		t.Fatalf("an ended process is still on the record: %+v", left)
	}
}

// A leftover that ignores SIGTERM is SIGKILLed once the grace is over.
func TestALeftoverIgnoringSigtermIsKilled(t *testing.T) {
	cmd := exec.Command("sh", "-c", `trap "" TERM; echo ready; while :; do sleep 1; done`)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	out, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
	})
	// The trap is set once it says so.
	if _, err := io.ReadFull(out, make([]byte, len("ready\n"))); err != nil {
		t.Fatal(err)
	}
	entry := procStateEntry{ProcID: "p", procIdentity: identityOf(t, cmd.Process.Pid)}
	if got := stopOrphan(entry, 100*time.Millisecond); got != "SIGKILL" {
		t.Fatalf("stopped with %q", got)
	}
	_ = cmd.Wait()
	if status, ok := cmd.ProcessState.Sys().(syscall.WaitStatus); !ok || status.Signal() != syscall.SIGKILL {
		t.Fatalf("not killed: %v", cmd.ProcessState)
	}
}
