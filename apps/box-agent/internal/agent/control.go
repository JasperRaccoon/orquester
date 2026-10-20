package agent

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"time"

	"orquester/box-agent/internal/wire"
)

// The local control socket (`<dataDir>/control.sock`, a named pipe on
// Windows) serves orq-agent's own subcommands running inside the box. One
// request per connection: a JSON line, answered by a JSON line; a `channel`
// request then turns the connection into the channel's byte stream.
//
//	{"op":"rpc","method":"token.get","params":{…},"timeoutMs":60000}
//	{"op":"channel","spec":{"kind":"mcp-bridge","serverId":"…"}}
//	{"op":"status"}
//
// Answers: {"ok":true,"result":…} or {"ok":false,"error":{"code","message"}}.
type ControlRequest struct {
	Op        string          `json:"op"`
	Method    string          `json:"method,omitempty"`
	Params    json.RawMessage `json:"params,omitempty"`
	TimeoutMs int64           `json:"timeoutMs,omitempty"`
	Spec      json.RawMessage `json:"spec,omitempty"`
}

type ControlResponse struct {
	OK     bool            `json:"ok"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  *wire.RPCError  `json:"error,omitempty"`
}

// ControlStatus is the `status` result.
type ControlStatus struct {
	Connected bool   `json:"connected"`
	BoxID     string `json:"boxId"`
	Version   string `json:"version"`
}

const defaultControlTimeout = 60 * time.Second

// ControlPath is where the control endpoint of a data dir lives.
func ControlPath(dataDir string) string { return localEndpoint(dataDir, "control") }

func (a *Agent) startControl() (io.Closer, error) {
	path := ControlPath(a.cfg.DataDir)
	ln, err := listenLocal(path, a.work, true)
	if err != nil {
		return nil, err
	}
	a.controlPath = path
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go a.serveControl(conn)
		}
	}()
	return ln, nil
}

type bufferedConn struct {
	net.Conn
	r *bufio.Reader
}

func (c bufferedConn) Read(p []byte) (int, error) { return c.r.Read(p) }

func (c bufferedConn) CloseWrite() error {
	if hc, ok := c.Conn.(halfCloser); ok {
		return hc.CloseWrite()
	}
	return nil
}

func writeControl(conn net.Conn, res ControlResponse) {
	data, _ := json.Marshal(res)
	_, _ = conn.Write(append(data, '\n'))
}

func (a *Agent) serveControl(conn net.Conn) {
	reader := bufio.NewReaderSize(conn, 64*1024)
	_ = conn.SetReadDeadline(time.Now().Add(30 * time.Second))
	line, err := readLine(reader, 16*1024*1024)
	if err != nil {
		conn.Close()
		return
	}
	_ = conn.SetReadDeadline(time.Time{})
	var req ControlRequest
	if err := json.Unmarshal(line, &req); err != nil {
		writeControl(conn, ControlResponse{Error: rpcErr("BAD_REQUEST", "malformed control request")})
		conn.Close()
		return
	}
	timeout := defaultControlTimeout
	if req.TimeoutMs > 0 {
		timeout = time.Duration(req.TimeoutMs) * time.Millisecond
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	switch req.Op {
	case "status":
		a.authMu.Lock()
		status := ControlStatus{Connected: a.currentLink() != nil, BoxID: a.boxID, Version: a.cfg.Version}
		a.authMu.Unlock()
		raw, _ := json.Marshal(status)
		writeControl(conn, ControlResponse{OK: true, Result: raw})
		conn.Close()
	case "rpc":
		defer conn.Close()
		if req.Method == "" {
			writeControl(conn, ControlResponse{Error: rpcErr("BAD_REQUEST", "method is required")})
			return
		}
		link, err := a.waitLink(ctx)
		if err != nil {
			writeControl(conn, ControlResponse{Error: toRPCError(err)})
			return
		}
		params := req.Params
		if len(params) == 0 {
			params = json.RawMessage("{}")
		}
		result, err := link.Request(ctx, req.Method, params)
		if err != nil {
			writeControl(conn, ControlResponse{Error: toRPCError(err)})
			return
		}
		if len(result) == 0 {
			result = json.RawMessage("null")
		}
		writeControl(conn, ControlResponse{OK: true, Result: result})
	case "channel":
		kind, spec, err := wire.DecodeSpec(req.Spec, false)
		if err != nil || kind != "mcp-bridge" {
			writeControl(conn, ControlResponse{Error: rpcErr("BAD_REQUEST", "only mcp-bridge channels can be opened locally")})
			conn.Close()
			return
		}
		bridgeSpec := spec.(*wire.MCPBridgeSpec)
		if bridgeSpec.ServerID == "" {
			writeControl(conn, ControlResponse{Error: rpcErr("BAD_REQUEST", "serverId is required")})
			conn.Close()
			return
		}
		link, err := a.waitLink(ctx)
		if err != nil {
			writeControl(conn, ControlResponse{Error: toRPCError(err)})
			conn.Close()
			return
		}
		ch, err := link.OpenChannel(ctx, bridgeSpec)
		if err != nil {
			writeControl(conn, ControlResponse{Error: toRPCError(err)})
			conn.Close()
			return
		}
		writeControl(conn, ControlResponse{OK: true})
		bridge(ch, bufferedConn{conn, reader})
	default:
		writeControl(conn, ControlResponse{Error: rpcErr("BAD_REQUEST", "unknown op "+req.Op)})
		conn.Close()
	}
}

var errLineTooLong = errors.New("line too long")

func readLine(r *bufio.Reader, limit int) ([]byte, error) {
	var out []byte
	for {
		chunk, err := r.ReadSlice('\n')
		out = append(out, chunk...)
		if len(out) > limit {
			return nil, errLineTooLong
		}
		if err == nil {
			return out[:len(out)-1], nil
		}
		if !errors.Is(err, bufio.ErrBufferFull) {
			return nil, err
		}
	}
}

// startSSHAgent listens on the socket exported as SSH_AUTH_SOCK; every client
// connection becomes one `ssh-agent` channel to the daemon, which answers
// with the host's keys (the private keys never enter the box).
func (a *Agent) startSSHAgent() (io.Closer, error) {
	path := localEndpoint(a.cfg.DataDir, "ssh-agent")
	ln, err := listenLocal(path, a.work, false)
	if err != nil {
		return nil, err
	}
	a.sshSocket = path
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
				defer cancel()
				link, err := a.waitLink(ctx)
				if err != nil {
					conn.Close()
					return
				}
				ch, err := link.OpenChannel(ctx, wire.SSHAgentSpec{Kind: "ssh-agent"})
				if err != nil {
					conn.Close()
					return
				}
				bridge(ch, conn)
			}()
		}
	}()
	return ln, nil
}
