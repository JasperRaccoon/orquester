package wire

import (
	"encoding/json"
	"fmt"
)

// ---------------------------------------------------------------------------
// Channel specs (BoxChannelSpec), one struct per kind
// ---------------------------------------------------------------------------

type PtySpec struct {
	Cols int    `json:"cols"`
	Rows int    `json:"rows"`
	Term string `json:"term,omitempty"`
}

type DetachSpec struct {
	ProcID      string `json:"procId"`
	BufferBytes *int64 `json:"bufferBytes,omitempty"`
}

type ExecSpec struct {
	Kind     string            `json:"kind"`
	Command  string            `json:"command"`
	Args     []string          `json:"args"`
	Cwd      string            `json:"cwd,omitempty"`
	Env      map[string]string `json:"env,omitempty"`
	EnvUnset []string          `json:"envUnset,omitempty"`
	Pty      *PtySpec          `json:"pty,omitempty"`
	Detach   *DetachSpec       `json:"detach,omitempty"`
	Shell    *bool             `json:"shell,omitempty"`
}

type AttachSpec struct {
	Kind       string `json:"kind"`
	ProcID     string `json:"procId"`
	FromOffset int64  `json:"fromOffset"`
}

type TCPSpec struct {
	Kind string `json:"kind"`
	Host string `json:"host,omitempty"`
	Port int    `json:"port"`
}

type UnixSpec struct {
	Kind string `json:"kind"`
	Path string `json:"path"`
}

type HostTCPSpec struct {
	Kind    string `json:"kind"`
	Target  string `json:"target"`
	BoxPort int    `json:"boxPort"`
}

type FileReadSpec struct {
	Kind   string `json:"kind"`
	Path   string `json:"path"`
	Offset *int64 `json:"offset,omitempty"`
	Length *int64 `json:"length,omitempty"`
}

type FileWriteSpec struct {
	Kind   string `json:"kind"`
	Path   string `json:"path"`
	Mode   *int   `json:"mode,omitempty"`
	Mkdirs *bool  `json:"mkdirs,omitempty"`
	Append *bool  `json:"append,omitempty"`
}

type TarReadSpec struct {
	Kind    string   `json:"kind"`
	Path    string   `json:"path"`
	Exclude []string `json:"exclude,omitempty"`
}

type TarWriteSpec struct {
	Kind string `json:"kind"`
	Path string `json:"path"`
	// Compression of stream 0: "" (plain tar) or "gzip".
	Compression string `json:"compression,omitempty"`
}

type SSHAgentSpec struct {
	Kind string `json:"kind"`
}

type MCPBridgeSpec struct {
	Kind     string `json:"kind"`
	ServerID string `json:"serverId"`
}

// ChannelKinds maps every BoxChannelKind to a constructor of its spec struct.
var ChannelKinds = map[string]func() any{
	"exec":       func() any { return &ExecSpec{} },
	"attach":     func() any { return &AttachSpec{} },
	"tcp":        func() any { return &TCPSpec{} },
	"unix":       func() any { return &UnixSpec{} },
	"host-tcp":   func() any { return &HostTCPSpec{} },
	"file-read":  func() any { return &FileReadSpec{} },
	"file-write": func() any { return &FileWriteSpec{} },
	"tar-read":   func() any { return &TarReadSpec{} },
	"tar-write":  func() any { return &TarWriteSpec{} },
	"ssh-agent":  func() any { return &SSHAgentSpec{} },
	"mcp-bridge": func() any { return &MCPBridgeSpec{} },
}

// DecodeSpec decodes a channel spec into its kind's struct.
func DecodeSpec(raw json.RawMessage, strict bool) (string, any, error) {
	var head struct {
		Kind string `json:"kind"`
	}
	if err := json.Unmarshal(raw, &head); err != nil {
		return "", nil, err
	}
	ctor, ok := ChannelKinds[head.Kind]
	if !ok {
		return head.Kind, nil, fmt.Errorf("unknown channel kind %q", head.Kind)
	}
	spec := ctor()
	if err := Unmarshal(raw, spec, strict); err != nil {
		return head.Kind, nil, err
	}
	return head.Kind, spec, nil
}

// ---------------------------------------------------------------------------
// Method params and results (BoxHostToBoxMethods, BoxBoxToHostMethods)
// ---------------------------------------------------------------------------

type FsStat struct {
	Path     string  `json:"path"`
	Kind     string  `json:"kind"`
	Size     int64   `json:"size"`
	MtimeMs  float64 `json:"mtimeMs"`
	Mode     uint32  `json:"mode"`
	Identity *string `json:"identity"`
}

type FsDirEntry struct {
	Name    string  `json:"name"`
	Kind    string  `json:"kind"`
	Size    int64   `json:"size"`
	MtimeMs float64 `json:"mtimeMs"`
}

type ListeningPort struct {
	Port    int     `json:"port"`
	Address string  `json:"address"`
	PID     *int    `json:"pid"`
	Command *string `json:"command"`
}

type Stats struct {
	CPUPercent     float64 `json:"cpuPercent"`
	MemUsedBytes   int64   `json:"memUsedBytes"`
	MemTotalBytes  int64   `json:"memTotalBytes"`
	DiskUsedBytes  int64   `json:"diskUsedBytes"`
	DiskTotalBytes int64   `json:"diskTotalBytes"`
	UptimeSeconds  float64 `json:"uptimeSeconds"`
}

type FsChangeEvent struct {
	WatchID string     `json:"watchId"`
	Changes []FsChange `json:"changes"`
}

type FsChange struct {
	Path string `json:"path"`
	Type string `json:"type"`
}

type PathParams struct {
	Path string `json:"path"`
}

type StatParams struct {
	Path           string `json:"path"`
	FollowSymlinks *bool  `json:"followSymlinks,omitempty"`
}

type MkdirParams struct {
	Path      string `json:"path"`
	Recursive *bool  `json:"recursive,omitempty"`
	Mode      *int   `json:"mode,omitempty"`
}

type RenameParams struct {
	From string `json:"from"`
	To   string `json:"to"`
}

type RmParams struct {
	Path      string `json:"path"`
	Recursive *bool  `json:"recursive,omitempty"`
	Force     *bool  `json:"force,omitempty"`
}

type ChmodParams struct {
	Path string `json:"path"`
	Mode int    `json:"mode"`
}

type SymlinkParams struct {
	Target string `json:"target"`
	Path   string `json:"path"`
}

type WatchParams struct {
	WatchID   string   `json:"watchId"`
	Path      string   `json:"path"`
	Recursive bool     `json:"recursive"`
	Ignore    []string `json:"ignore,omitempty"`
}

type UnwatchParams struct {
	WatchID string `json:"watchId"`
}

type Empty struct{}

type ProcSignalParams struct {
	ProcID string `json:"procId"`
	Signal string `json:"signal"`
}

type ProcIDParams struct {
	ProcID string `json:"procId"`
}

type UnlistenParams struct {
	BoxPort int `json:"boxPort"`
}

type EnsurePathsParams struct {
	Paths []string `json:"paths"`
}

type UpdateParams struct {
	URL    string `json:"url"`
	SHA256 string `json:"sha256"`
}

type ShutdownParams struct {
	Reason string `json:"reason"`
}

type TokenGetParams struct {
	Agent           string `json:"agent"`
	AccountID       string `json:"accountId"`
	MinValidSeconds *int64 `json:"minValidSeconds,omitempty"`
	// RejectedAccessToken: the token the CLI was refused with; the host renews it while it is current.
	RejectedAccessToken string `json:"rejectedAccessToken,omitempty"`
}

type TokenGetResult struct {
	AccessToken string            `json:"accessToken"`
	ExpiresAt   *int64            `json:"expiresAt"`
	Extra       map[string]string `json:"extra,omitempty"`
}

type GitCredentialParams struct {
	Operation string `json:"operation"`
	Input     string `json:"input"`
}

type GitCredentialResult struct {
	Output string `json:"output"`
}

// MethodTypes pairs a params constructor with a result constructor; nil Result = void.
type MethodTypes struct {
	Params func() any
	Result func() any
}

// HostToBoxMethods is every BoxHostToBoxMethods entry.
var HostToBoxMethods = map[string]MethodTypes{
	"fs.stat":           {func() any { return &StatParams{} }, func() any { return &FsStat{} }},
	"fs.readdir":        {func() any { return &PathParams{} }, func() any { return &[]FsDirEntry{} }},
	"fs.realpath":       {func() any { return &PathParams{} }, func() any { return new(string) }},
	"fs.mkdir":          {func() any { return &MkdirParams{} }, nil},
	"fs.rename":         {func() any { return &RenameParams{} }, nil},
	"fs.rm":             {func() any { return &RmParams{} }, nil},
	"fs.chmod":          {func() any { return &ChmodParams{} }, nil},
	"fs.symlink":        {func() any { return &SymlinkParams{} }, nil},
	"fs.watch":          {func() any { return &WatchParams{} }, nil},
	"fs.unwatch":        {func() any { return &UnwatchParams{} }, nil},
	"sys.info":          {func() any { return &Empty{} }, func() any { return &SysInfo{} }},
	"sys.ports":         {func() any { return &Empty{} }, func() any { return &[]ListeningPort{} }},
	"sys.stats":         {func() any { return &Empty{} }, func() any { return &Stats{} }},
	"proc.list":         {func() any { return &Empty{} }, func() any { return &[]DetachedProcInfo{} }},
	"proc.signal":       {func() any { return &ProcSignalParams{} }, nil},
	"proc.release":      {func() any { return &ProcIDParams{} }, nil},
	"forward.listen":    {func() any { return &ForwardSpec{} }, nil},
	"forward.unlisten":  {func() any { return &UnlistenParams{} }, nil},
	"agent.ensurePaths": {func() any { return &EnsurePathsParams{} }, nil},
	"agent.update":      {func() any { return &UpdateParams{} }, nil},
	"agent.shutdown":    {func() any { return &ShutdownParams{} }, nil},
}

// BoxToHostMethods is every BoxBoxToHostMethods entry.
var BoxToHostMethods = map[string]MethodTypes{
	"token.get":      {func() any { return &TokenGetParams{} }, func() any { return &TokenGetResult{} }},
	"git.credential": {func() any { return &GitCredentialParams{} }, func() any { return &GitCredentialResult{} }},
}
