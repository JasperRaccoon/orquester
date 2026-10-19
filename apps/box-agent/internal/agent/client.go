package agent

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"sync"
	"time"

	"orquester/box-agent/internal/wire"
)

// Client side of the control socket, used by the subcommands that run inside
// the box (`token`, `git-credential`, `mcp-bridge`, `rpc`).

// ClientControlPath: $ORQ_AGENT_CONTROL (set for every process orq-agent
// starts), else the default for ORQ_DATA_DIR / the default data dir.
func ClientControlPath() string {
	if path := os.Getenv("ORQ_AGENT_CONTROL"); path != "" {
		return path
	}
	dataDir := os.Getenv("ORQ_DATA_DIR")
	if dataDir == "" {
		dataDir = DefaultDataDir()
	}
	return ControlPath(dataDir)
}

func dialControl() (net.Conn, error) {
	conn, err := DialLocal(ClientControlPath(), 10*time.Second)
	if err != nil {
		return nil, fmt.Errorf("orq-agent is not running here (control socket %s): %w", ClientControlPath(), err)
	}
	return conn, nil
}

func sendControl(conn net.Conn, req ControlRequest) (*bufio.Reader, ControlResponse, error) {
	data, err := json.Marshal(req)
	if err != nil {
		return nil, ControlResponse{}, err
	}
	if _, err := conn.Write(append(data, '\n')); err != nil {
		return nil, ControlResponse{}, err
	}
	reader := bufio.NewReaderSize(conn, 64*1024)
	line, err := readLine(reader, 64*1024*1024)
	if err != nil {
		return nil, ControlResponse{}, fmt.Errorf("reading orq-agent's answer: %w", err)
	}
	var res ControlResponse
	if err := json.Unmarshal(line, &res); err != nil {
		return nil, ControlResponse{}, errors.New("malformed answer from orq-agent")
	}
	return reader, res, nil
}

// ClientRPC sends a box → host request through the running agent.
func ClientRPC(method string, params json.RawMessage, timeout time.Duration) (json.RawMessage, error) {
	conn, err := dialControl()
	if err != nil {
		return nil, err
	}
	defer conn.Close()
	_, res, err := sendControl(conn, ControlRequest{Op: "rpc", Method: method, Params: params, TimeoutMs: timeout.Milliseconds()})
	if err != nil {
		return nil, err
	}
	if !res.OK {
		if res.Error == nil {
			return nil, &wire.RPCError{Code: "INTERNAL", Message: "request failed"}
		}
		return nil, res.Error
	}
	return res.Result, nil
}

// ClientStatus asks the running agent whether it is connected.
func ClientStatus() (ControlStatus, error) {
	conn, err := dialControl()
	if err != nil {
		return ControlStatus{}, err
	}
	defer conn.Close()
	_, res, err := sendControl(conn, ControlRequest{Op: "status"})
	if err != nil {
		return ControlStatus{}, err
	}
	var status ControlStatus
	if !res.OK || json.Unmarshal(res.Result, &status) != nil {
		return ControlStatus{}, errors.New("orq-agent did not report its status")
	}
	return status, nil
}

// ClientMCPBridge connects stdin/stdout to an `mcp-bridge` channel; it
// returns when the host side ends the stream.
func ClientMCPBridge(serverID string, stdin io.Reader, stdout io.Writer) error {
	conn, err := dialControl()
	if err != nil {
		return err
	}
	defer conn.Close()
	spec, _ := json.Marshal(wire.MCPBridgeSpec{Kind: "mcp-bridge", ServerID: serverID})
	reader, res, err := sendControl(conn, ControlRequest{Op: "channel", Spec: spec, TimeoutMs: defaultControlTimeout.Milliseconds()})
	if err != nil {
		return err
	}
	if !res.OK {
		if res.Error != nil {
			return res.Error
		}
		return errors.New("orq-agent refused the bridge")
	}
	var once sync.Once
	done := make(chan error, 1)
	go func() {
		_, err := io.Copy(conn, stdin)
		if hc, ok := conn.(halfCloser); ok && err == nil {
			_ = hc.CloseWrite()
		} else {
			once.Do(func() { conn.Close() })
		}
	}()
	go func() {
		_, err := io.Copy(stdout, reader)
		done <- err
	}()
	return <-done
}
