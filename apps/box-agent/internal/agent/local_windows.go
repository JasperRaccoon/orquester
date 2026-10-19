//go:build windows

package agent

import (
	"net"
	"os/exec"
	"time"

	"github.com/Microsoft/go-winio"
)

// Only SYSTEM, Administrators and the pipe's owner may connect.
const pipeSecurity = "D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GA;;;OW)"

// listenLocal opens a named pipe. Message mode gives the control pipe a
// half-close (CloseWrite sends a zero-length message); OpenSSH's agent
// pipe is byte mode.
func listenLocal(path string, _ *workUser, messageMode bool) (net.Listener, error) {
	return winio.ListenPipe(path, &winio.PipeConfig{
		SecurityDescriptor: pipeSecurity,
		MessageMode:        messageMode,
		InputBufferSize:    64 * 1024,
		OutputBufferSize:   64 * 1024,
	})
}

// DialLocal connects to a control/ssh pipe.
func DialLocal(path string, timeout time.Duration) (net.Conn, error) {
	return winio.DialPipe(path, &timeout)
}

func localEndpoint(dataDir, name string) string { return pipeName(name, dataDir) }

func (a *Agent) runAsWorkUser(*exec.Cmd) {}
