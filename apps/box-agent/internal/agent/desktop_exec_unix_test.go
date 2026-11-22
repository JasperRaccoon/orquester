//go:build !windows

package agent

import (
	"slices"
	"strings"
	"testing"

	"orquester/box-agent/internal/wire"
)

// openFailedCode opens an exec channel that must fail, and returns the error's code.
func (d *testDaemon) openFailedCode(ch int, spec map[string]any) string {
	d.t.Helper()
	spec["kind"] = "exec"
	d.send(map[string]any{"t": "open", "ch": ch, "spec": spec})
	msg := d.expect("open-failed", isMsg("open-failed", ch))
	failure, _ := msg["error"].(map[string]any)
	code, _ := failure["code"].(string)
	return code
}

func desktopSpec(command string) map[string]any {
	spec := shellSpec(command, false)
	spec["session"] = "desktop"
	return spec
}

// readUntil reads channel output until it contains `want`.
func (d *testDaemon) readUntil(ch int, want string) string {
	d.t.Helper()
	var out strings.Builder
	for !strings.Contains(out.String(), want) {
		out.Write(d.nextData(ch))
	}
	return out.String()
}

func TestDesktopSessionExecRunsThroughTheHelperOrFailsNamingTheCause(t *testing.T) {
	// No helper on this machine at all.
	bare := newTestDaemon(t)
	if code := bare.openFailedCode(1, desktopSpec("true")); code != "NO_DESKTOP_SESSION" {
		t.Fatalf("no helper: %q", code)
	}
	if caps := (&Agent{procs: newProcRegistry()}).hello(wire.Auth{}).Capabilities; slices.Contains(caps, wire.CapabilityDesktopSession) {
		t.Fatalf("capabilities without a helper: %v", caps)
	}

	hub := testHub("")
	d := newTestDaemon(t, func(a *Agent) { a.desktop = hub })
	if caps := (&Agent{procs: newProcRegistry(), desktop: hub}).hello(wire.Auth{}).Capabilities; !slices.Contains(caps, wire.CapabilityDesktopSession) {
		t.Fatalf("capabilities with the helper installed: %v", caps)
	}
	// Installed, but nobody signed in: nothing connects in time.
	hub.wait = 0
	if code := d.openFailedCode(2, desktopSpec("true")); code != "NO_DESKTOP_SESSION" {
		t.Fatalf("helper not connected: %q", code)
	}

	hub.wait = desktopHelperWait
	connectHelper(t, hub, "", func(spec *startSpec) (process, error) { return startProcess(spec) })
	d.openExec(3, desktopSpec(`read line; echo "got $line box=$ORQ_BOX_ID home=${HOME:-none}"; exit 4`))
	d.sendInput(3, "hi\n")
	out := d.readUntil(3, "\n")
	// The helper's own environment (no HOME in it), with orq-agent's identity added.
	if !strings.Contains(out, "got hi box= home=none") {
		t.Fatalf("output %q", out)
	}
	exit := d.expect("exit", isMsg("exit", 3))
	if exit["code"] != float64(4) {
		t.Fatalf("exit = %v", exit)
	}
	d.expect("close", isMsg("close", 3))
}

func TestDesktopSessionExecEndsKilledWhenTheHelperGoesAway(t *testing.T) {
	hub := testHub("")
	d := newTestDaemon(t, func(a *Agent) { a.desktop = hub })
	session, _ := connectHelper(t, hub, "", func(spec *startSpec) (process, error) { return startProcess(spec) })
	d.openExec(1, desktopSpec(`echo "$$"; exec sleep 1000`))
	pid := d.readPID(1)
	session.conn.close()
	exit := d.expect("exit", isMsg("exit", 1))
	if exit["signal"] != "SIGKILL" {
		t.Fatalf("exit = %v", exit)
	}
	assertGone(t, pid)
	// The next desktop exec waits for a helper again rather than using the one that left.
	hub.wait = 0
	if code := d.openFailedCode(2, desktopSpec("true")); code != "NO_DESKTOP_SESSION" {
		t.Fatalf("after the helper left: %q", code)
	}
}
