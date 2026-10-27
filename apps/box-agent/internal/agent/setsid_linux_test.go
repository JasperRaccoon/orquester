//go:build linux

package agent

import (
	"bufio"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"

	"golang.org/x/sys/unix"
)

// The fixture reports its PID from inside the new session, then closes its
// readiness pipe before exec. It does not copy the device launcher's script.
const setsidScript = `log=$1; shift
umask 077
mkdir -p "$(dirname "$log")"
pid=$(setsid /bin/sh -c 'printf "%s\n" "$$" >&3; exec 3>&-; exec "$@"' orq-session "$@" 3>&1 >> "$log" 2>&1 < /dev/null &)
printf '%s\n' "$pid"
`

// holdAfterSetsid keeps the exec running after the setsid'd start, ignoring the channel's
// SIGHUP so the SIGKILL after hangupGrace has to end its group.
const holdAfterSetsid = "trap '' HUP; sleep 1000"

func setsidExecSpec(t *testing.T, hold bool) map[string]any {
	script := setsidScript
	if hold {
		script += holdAfterSetsid + "\n"
	}
	logPath := filepath.Join(t.TempDir(), "logs", "detached.log")
	return map[string]any{"command": "/bin/sh", "args": []string{"-c", script, "orq-detach", logPath, "sleep", "1000"}}
}

// assertSessionLeader checks that `pid` already leads its own session when the script prints it:
// the script waits for setsid, since until then the child is in the exec's group, which a
// channel close or link drop hangs up.
func assertSessionLeader(t *testing.T, pid int) {
	t.Helper()
	if sid, err := unix.Getsid(pid); err != nil || sid != pid {
		t.Fatalf("process %d was printed before it led its own session (session %d, %v)", pid, sid, err)
	}
}

// assertDetachedSurvivor: `pid` still runs, in a session of its own (its pid is its group).
func assertDetachedSurvivor(t *testing.T, pid, execPID int) {
	t.Helper()
	if processGone(pid) {
		t.Fatalf("the setsid'd process %d did not survive", pid)
	}
	if sid, err := unix.Getsid(pid); err != nil || sid != pid {
		t.Fatalf("the setsid'd process %d leads session %d (%v)", pid, sid, err)
	}
	if group, err := unix.Getpgid(pid); err != nil || group == execPID {
		t.Fatalf("the setsid'd process %d is in group %d (%v), the exec's is %d", pid, group, err, execPID)
	}
}

// A process started with `setsid` from a plain (non-detached) exec is outside the exec's process
// group, which is all the agent ever signals for it: it survives the exec finishing, the daemon
// closing the channel and the link dropping (SIGHUP, then SIGKILL after hangupGrace).
func TestASetsidProcessOutlivesItsExec(t *testing.T) {
	for _, tc := range []struct {
		name string
		hold bool
		end  func(t *testing.T, d *testDaemon)
	}{
		{"exec-finishes", false, func(t *testing.T, d *testDaemon) {
			exit := d.expect("exit", isMsg("exit", 1))
			if exit["code"] != float64(0) {
				t.Errorf("exit = %v; want code 0", exit)
			}
		}},
		{"channel-closed", true, func(t *testing.T, d *testDaemon) { d.send(map[string]any{"t": "close", "ch": 1}) }},
		{"link-dropped", true, func(t *testing.T, d *testDaemon) { _ = d.conn.CloseNow() }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			d := newTestDaemon(t)
			shell := d.openExec(1, setsidExecSpec(t, tc.hold))
			detached := d.readPID(1)
			assertSessionLeader(t, detached)
			tc.end(t, d)
			// The exec's own group is gone. With hold its shell ignores SIGHUP, so it is gone
			// only once the agent's SIGKILL after hangupGrace has run.
			assertGone(t, shell)
			assertDetachedSurvivor(t, detached, shell)
		})
	}
}

// An orq-agent restart stops what the previous one recorded (its `detach` processes, by group),
// not what such a process started with `setsid`; systemd's KillMode=process (service_plan.go)
// leaves the rest of the unit's cgroup alone too.
func TestARestartLeavesASetsidProcessRunning(t *testing.T) {
	cmd := exec.Command("/bin/sh", setsidExecSpec(t, true)["args"].([]string)...)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	out, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = unix.Kill(-cmd.Process.Pid, unix.SIGKILL)
		_ = cmd.Wait()
	})
	line, err := bufio.NewReader(out).ReadString('\n')
	if err != nil {
		t.Fatal(err)
	}
	detached, err := strconv.Atoi(strings.TrimSpace(line))
	if err != nil {
		t.Fatalf("no pid printed: %q", line)
	}
	killOnCleanup(t, detached)
	assertSessionLeader(t, detached)

	deadAgent := procIdentity{PID: os.Getpid(), Start: "not-this-process"}
	path := writeState(t, procState{Agent: deadAgent, Procs: []procStateEntry{
		{ProcID: "hub-starter", procIdentity: identityOf(t, cmd.Process.Pid)},
	}})
	r := newProcRegistry()
	r.recoverFrom(path, quietLogger())

	if err := cmd.Wait(); err == nil {
		t.Fatal("the recorded process was not stopped")
	}
	assertDetachedSurvivor(t, detached, cmd.Process.Pid)
}
