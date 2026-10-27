// Package wire mirrors packages/api/src/box-protocol.ts: the protocol between
// the Orquester daemon and orq-agent. The TypeScript file is the source of
// truth; the golden fixtures in apps/box-agent/fixtures are written from typed
// TypeScript values and decoded strictly here (wire_test.go), so a field added,
// renamed or retyped on one side fails a test on the other.
package wire

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
)

// Constants (box-protocol.ts).
const (
	ProtocolVersion           = 1
	ChannelWindowBytes        = 1024 * 1024
	MaxFramePayload           = 256 * 1024
	HeartbeatMs               = 15_000
	DetachBufferBytes         = 4 * 1024 * 1024
	DataFrameHeaderBytes      = 5
	WindowsPathPrefix         = `C:\orq`
	StreamToBox          byte = 0
	StreamFromBox        byte = 1
	StreamStderr         byte = 2
)

// AgentPlatforms lists every build target (BOX_AGENT_PLATFORMS).
var AgentPlatforms = []string{
	"linux-x64",
	"linux-arm64",
	"linux-x64-musl",
	"linux-arm64-musl",
	"darwin-arm64",
	"darwin-x64",
	"win32-x64",
}

// ---------------------------------------------------------------------------
// Box facts
// ---------------------------------------------------------------------------

type SysInfo struct {
	OS         string   `json:"os"`
	Arch       string   `json:"arch"`
	Libc       *string  `json:"libc"`
	Hostname   string   `json:"hostname"`
	OSRelease  string   `json:"osRelease"`
	User       string   `json:"user"`
	IsRoot     bool     `json:"isRoot"`
	CanElevate bool     `json:"canElevate"`
	Home       string   `json:"home"`
	Shell      string   `json:"shell"`
	Tmux       bool     `json:"tmux"`
	Docker     bool     `json:"docker"`
	CPUs       int      `json:"cpus"`
	MemBytes   int64    `json:"memBytes"`
	GPUs       []string `json:"gpus"`
	AgentPath  string   `json:"agentPath"`
	DataDir    string   `json:"dataDir"`
	Container  bool     `json:"container"`
	// KVM: Linux, /dev/kvm opens read-write for the account processes run as.
	KVM bool `json:"kvm"`
}

type PathMap struct {
	Kind   string `json:"kind"`
	Prefix string `json:"prefix,omitempty"`
}

// ---------------------------------------------------------------------------
// Handshake
// ---------------------------------------------------------------------------

type Auth struct {
	Kind       string `json:"kind"`
	Token      string `json:"token,omitempty"`
	BoxID      string `json:"boxId,omitempty"`
	Credential string `json:"credential,omitempty"`
	JWT        string `json:"jwt,omitempty"`
}

type DetachedProcInfo struct {
	ProcID      string  `json:"procId"`
	PID         *int    `json:"pid"`
	Running     bool    `json:"running"`
	ExitCode    *int    `json:"exitCode"`
	Signal      *string `json:"signal"`
	OutputBytes int64   `json:"outputBytes"`
	BufferStart int64   `json:"bufferStart"`
	// Lost: a previous orq-agent started it and this one could not follow it; why, and what became of it.
	Lost *string `json:"lost,omitempty"`
}

type Hello struct {
	T            string             `json:"t"`
	Protocol     int                `json:"protocol"`
	AgentVersion string             `json:"agentVersion"`
	Auth         Auth               `json:"auth"`
	Sys          SysInfo            `json:"sys"`
	Procs        []DetachedProcInfo `json:"procs"`
}

type ForwardSpec struct {
	BoxPort int    `json:"boxPort"`
	Target  string `json:"target"`
}

type AgentConfig struct {
	Paths       PathMap       `json:"paths"`
	HeartbeatMs int           `json:"heartbeatMs"`
	Forwards    []ForwardSpec `json:"forwards"`
}

type Welcome struct {
	T          string      `json:"t"`
	BoxID      string      `json:"boxId"`
	Credential string      `json:"credential,omitempty"`
	Config     AgentConfig `json:"config"`
}

type Reject struct {
	T          string `json:"t"`
	Code       string `json:"code"`
	Message    string `json:"message"`
	UpgradeURL string `json:"upgradeUrl,omitempty"`
}

// ---------------------------------------------------------------------------
// Requests and events
// ---------------------------------------------------------------------------

type RPCError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func (e *RPCError) Error() string { return e.Code + ": " + e.Message }

type Ping struct {
	T  string `json:"t"`
	ID int64  `json:"id"`
}

type Request struct {
	T      string          `json:"t"`
	ID     int64           `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
}

type Response struct {
	T      string          `json:"t"`
	ID     int64           `json:"id"`
	OK     bool            `json:"ok"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  *RPCError       `json:"error,omitempty"`
}

type Event struct {
	T    string          `json:"t"`
	Name string          `json:"name"`
	Data json.RawMessage `json:"data"`
}

// ---------------------------------------------------------------------------
// Channel control
// ---------------------------------------------------------------------------

type Open struct {
	T    string          `json:"t"`
	Ch   uint32          `json:"ch"`
	Spec json.RawMessage `json:"spec"`
}

type OpenedInfo struct {
	PID          *int   `json:"pid,omitempty"`
	DroppedBytes *int64 `json:"droppedBytes,omitempty"`
	Size         *int64 `json:"size,omitempty"`
}

type Opened struct {
	T    string      `json:"t"`
	Ch   uint32      `json:"ch"`
	Info *OpenedInfo `json:"info,omitempty"`
}

type OpenFailed struct {
	T     string   `json:"t"`
	Ch    uint32   `json:"ch"`
	Error RPCError `json:"error"`
}

type Eof struct {
	T      string `json:"t"`
	Ch     uint32 `json:"ch"`
	Stream byte   `json:"stream"`
}

type Exit struct {
	T      string  `json:"t"`
	Ch     uint32  `json:"ch"`
	Code   *int    `json:"code"`
	Signal *string `json:"signal"`
}

type Resize struct {
	T    string `json:"t"`
	Ch   uint32 `json:"ch"`
	Cols int    `json:"cols"`
	Rows int    `json:"rows"`
}

type Signal struct {
	T      string `json:"t"`
	Ch     uint32 `json:"ch"`
	Signal string `json:"signal"`
}

type Credit struct {
	T     string `json:"t"`
	Ch    uint32 `json:"ch"`
	Bytes int64  `json:"bytes"`
}

type Close struct {
	T     string    `json:"t"`
	Ch    uint32    `json:"ch"`
	Error *RPCError `json:"error,omitempty"`
}

// DecodeControl decodes a text frame into its concrete message type
// (*Hello, *Welcome, …). Unknown fields are tolerated unless strict is set
// (the golden tests decode strictly; the live link is lenient so a newer peer
// adding an optional field does not break an older one).
func DecodeControl(data []byte, strict bool) (any, error) {
	var head struct {
		T string `json:"t"`
	}
	if err := json.Unmarshal(data, &head); err != nil {
		return nil, err
	}
	var msg any
	switch head.T {
	case "hello":
		msg = &Hello{}
	case "welcome":
		msg = &Welcome{}
	case "reject":
		msg = &Reject{}
	case "ping", "pong":
		msg = &Ping{}
	case "req":
		msg = &Request{}
	case "res":
		msg = &Response{}
	case "event":
		msg = &Event{}
	case "open":
		msg = &Open{}
	case "opened":
		msg = &Opened{}
	case "open-failed":
		msg = &OpenFailed{}
	case "eof":
		msg = &Eof{}
	case "exit":
		msg = &Exit{}
	case "resize":
		msg = &Resize{}
	case "signal":
		msg = &Signal{}
	case "credit":
		msg = &Credit{}
	case "close":
		msg = &Close{}
	default:
		return nil, fmt.Errorf("unknown control message %q", head.T)
	}
	if err := Unmarshal(data, msg, strict); err != nil {
		return nil, err
	}
	return msg, nil
}

// Unmarshal decodes JSON, rejecting unknown fields when strict.
func Unmarshal(data []byte, into any, strict bool) error {
	if !strict {
		return json.Unmarshal(data, into)
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(into); err != nil {
		return err
	}
	if dec.More() {
		return errors.New("trailing data after JSON value")
	}
	return nil
}

// ---------------------------------------------------------------------------
// Binary data frames: [u32 BE channel][u8 stream][payload]
// ---------------------------------------------------------------------------

func EncodeDataFrame(channel uint32, stream byte, payload []byte) ([]byte, error) {
	if len(payload) > MaxFramePayload {
		return nil, fmt.Errorf("frame payload of %d bytes exceeds %d", len(payload), MaxFramePayload)
	}
	frame := make([]byte, DataFrameHeaderBytes+len(payload))
	binary.BigEndian.PutUint32(frame[0:4], channel)
	frame[4] = stream
	copy(frame[DataFrameHeaderBytes:], payload)
	return frame, nil
}

func DecodeDataFrame(frame []byte) (channel uint32, stream byte, payload []byte, err error) {
	if len(frame) < DataFrameHeaderBytes {
		return 0, 0, nil, errors.New("data frame shorter than its header")
	}
	stream = frame[4]
	if stream > 2 {
		return 0, 0, nil, fmt.Errorf("bad stream %d", stream)
	}
	return binary.BigEndian.Uint32(frame[0:4]), stream, frame[DataFrameHeaderBytes:], nil
}
