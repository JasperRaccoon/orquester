package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"orquester/box-agent/internal/wire"
)

type requestHandler func(ctx context.Context, a *Agent, l *Link, params json.RawMessage) (any, error)

// requestHandlers serves every BoxHostToBoxMethods entry (a test checks the
// set against the golden fixture).
var requestHandlers = map[string]requestHandler{
	"fs.stat":     handleFsStat,
	"fs.readdir":  handleFsReaddir,
	"fs.realpath": handleFsRealpath,
	"fs.mkdir":    handleFsMkdir,
	"fs.rename":   handleFsRename,
	"fs.rm":       handleFsRm,
	"fs.chmod":    handleFsChmod,
	"fs.symlink":  handleFsSymlink,
	"fs.watch":    handleFsWatch,
	"fs.unwatch":  handleFsUnwatch,
	"sys.info": func(_ context.Context, a *Agent, _ *Link, _ json.RawMessage) (any, error) {
		return a.refreshSysInfo(), nil
	},
	"sys.ports": func(ctx context.Context, _ *Agent, _ *Link, _ json.RawMessage) (any, error) {
		return listeningPorts(ctx)
	},
	"sys.stats":         func(ctx context.Context, a *Agent, _ *Link, _ json.RawMessage) (any, error) { return a.stats(ctx) },
	"proc.list":         func(_ context.Context, a *Agent, _ *Link, _ json.RawMessage) (any, error) { return a.procs.list(), nil },
	"proc.signal":       handleProcSignal,
	"proc.release":      handleProcRelease,
	"forward.listen":    handleForwardListen,
	"forward.unlisten":  handleForwardUnlisten,
	"agent.ensurePaths": handleEnsurePaths,
	"agent.update":      handleAgentUpdate,
	"agent.shutdown":    handleAgentShutdown,
}

func decodeParams[T any](raw json.RawMessage) (*T, error) {
	var out T
	if len(raw) == 0 || string(raw) == "null" {
		return &out, nil
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, rpcErr("BAD_REQUEST", fmt.Sprintf("bad params: %v", err))
	}
	return &out, nil
}

func (a *Agent) handleRequest(l *Link, req *wire.Request) {
	handler, ok := requestHandlers[req.Method]
	if !ok {
		_ = l.sendJSON(wire.Response{T: "res", ID: req.ID, OK: false, Error: rpcErr("UNKNOWN_METHOD", "unknown method "+req.Method)})
		return
	}
	ctx, cancel := context.WithTimeout(l.ctx, 10*time.Minute)
	defer cancel()
	result, err := handler(ctx, a, l, req.Params)
	if err != nil {
		_ = l.sendJSON(wire.Response{T: "res", ID: req.ID, OK: false, Error: toRPCError(err)})
		return
	}
	var after func()
	if wrapped, ok := result.(thenRun); ok {
		result, after = wrapped.result, wrapped.after
	}
	raw, err := json.Marshal(result)
	if err != nil {
		_ = l.sendJSON(wire.Response{T: "res", ID: req.ID, OK: false, Error: rpcErr("INTERNAL", "could not encode the result")})
		return
	}
	_ = l.sendJSON(wire.Response{T: "res", ID: req.ID, OK: true, Result: raw})
	if after != nil {
		after()
	}
}

// thenRun is a handler result whose `after` runs once the response was sent
// (shutdown and update must answer before the link goes away).
type thenRun struct {
	result any
	after  func()
}

func handleProcSignal(_ context.Context, a *Agent, _ *Link, raw json.RawMessage) (any, error) {
	p, err := decodeParams[wire.ProcSignalParams](raw)
	if err != nil {
		return nil, err
	}
	proc := a.procs.get(p.ProcID)
	if proc == nil {
		return nil, rpcErr("NOT_FOUND", "no detached process "+p.ProcID)
	}
	if proc.proc == nil {
		// Lost (procstate.go): already ended.
		return nil, nil
	}
	return nil, proc.proc.signal(p.Signal)
}

func handleProcRelease(_ context.Context, a *Agent, _ *Link, raw json.RawMessage) (any, error) {
	p, err := decodeParams[wire.ProcIDParams](raw)
	if err != nil {
		return nil, err
	}
	if err := a.procs.release(p.ProcID); err != nil {
		return nil, err
	}
	a.applyPendingUpdate()
	return nil, nil
}

func handleForwardListen(_ context.Context, _ *Agent, l *Link, raw json.RawMessage) (any, error) {
	p, err := decodeParams[wire.ForwardSpec](raw)
	if err != nil {
		return nil, err
	}
	if p.BoxPort <= 0 || p.BoxPort > 65535 {
		return nil, rpcErr("BAD_REQUEST", "boxPort out of range")
	}
	return nil, l.listenForward(*p)
}

func handleForwardUnlisten(_ context.Context, _ *Agent, l *Link, raw json.RawMessage) (any, error) {
	p, err := decodeParams[wire.UnlistenParams](raw)
	if err != nil {
		return nil, err
	}
	l.unlistenForward(p.BoxPort)
	return nil, nil
}

func handleEnsurePaths(_ context.Context, a *Agent, _ *Link, raw json.RawMessage) (any, error) {
	p, err := decodeParams[wire.EnsurePathsParams](raw)
	if err != nil {
		return nil, err
	}
	for _, path := range p.Paths {
		if !filepath.IsAbs(path) {
			return nil, rpcErr("BAD_REQUEST", "not an absolute path: "+path)
		}
		if err := a.ensurePath(path); err != nil {
			return nil, err
		}
	}
	return nil, nil
}

// ensurePath creates `path` with parents; as root with a working user, the
// directories it created (and `path` itself) are given to that user.
func (a *Agent) ensurePath(path string) error {
	path = filepath.Clean(path)
	var created []string
	for dir := path; ; dir = filepath.Dir(dir) {
		if _, err := os.Lstat(dir); err == nil {
			break
		}
		created = append(created, dir)
		if filepath.Dir(dir) == dir {
			break
		}
	}
	if err := os.MkdirAll(path, 0o755); err != nil {
		return err
	}
	if a.work == nil {
		return nil
	}
	owned := created
	if len(created) == 0 || created[0] != path {
		owned = append([]string{path}, created...)
	}
	for _, dir := range owned {
		if err := a.work.chown(dir); err != nil {
			return err
		}
	}
	return nil
}

func handleAgentUpdate(ctx context.Context, a *Agent, _ *Link, raw json.RawMessage) (any, error) {
	p, err := decodeParams[wire.UpdateParams](raw)
	if err != nil {
		return nil, err
	}
	if p.URL == "" || len(p.SHA256) != 64 {
		return nil, rpcErr("BAD_REQUEST", "agent.update needs url and a sha256 hex digest")
	}
	if running := a.procs.runningCount(); running > 0 {
		// Replacing the executable would orphan detached processes' output:
		// defer until they have all exited and been released.
		a.updateMu.Lock()
		a.pendingUpdate = p
		a.updateMu.Unlock()
		return nil, rpcErr("BUSY", fmt.Sprintf("%d detached processes running; the update is applied once they end", running))
	}
	path, err := a.downloadUpdate(ctx, p.URL, p.SHA256)
	if err != nil {
		return nil, err
	}
	// Answer first, then restart: the daemon sees the link drop and come back.
	return thenRun{nil, func() { a.installAndRestart(path) }}, nil
}

func handleAgentShutdown(_ context.Context, a *Agent, _ *Link, raw json.RawMessage) (any, error) {
	p, err := decodeParams[wire.ShutdownParams](raw)
	if err != nil {
		return nil, err
	}
	return thenRun{nil, func() { a.shutdown("daemon request: "+p.Reason, p.Uninstall) }}, nil
}
