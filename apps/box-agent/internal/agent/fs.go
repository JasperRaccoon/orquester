package agent

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"

	"orquester/box-agent/internal/wire"
)

func kindOf(mode fs.FileMode) string {
	switch {
	case mode&fs.ModeSymlink != 0:
		return "symlink"
	case mode.IsDir():
		return "dir"
	case mode.IsRegular():
		return "file"
	default:
		return "other"
	}
}

func mtimeMs(info fs.FileInfo) float64 {
	return float64(info.ModTime().UnixNano()) / 1e6
}

func statOf(path string, info fs.FileInfo) *wire.FsStat {
	return &wire.FsStat{
		Path:     path,
		Kind:     kindOf(info.Mode()),
		Size:     info.Size(),
		MtimeMs:  mtimeMs(info),
		Mode:     nodeMode(info),
		Identity: fileIdentity(info),
	}
}

func requireAbs(path string) error {
	if path == "" || !filepath.IsAbs(path) {
		return rpcErr("BAD_REQUEST", "not an absolute path: "+path)
	}
	return nil
}

func handleFsStat(_ context.Context, _ *Agent, _ *Link, raw json.RawMessage) (any, error) {
	p, err := decodeParams[wire.StatParams](raw)
	if err != nil {
		return nil, err
	}
	if err := requireAbs(p.Path); err != nil {
		return nil, err
	}
	var info fs.FileInfo
	if p.FollowSymlinks != nil && !*p.FollowSymlinks {
		info, err = os.Lstat(p.Path)
	} else {
		info, err = os.Stat(p.Path)
	}
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, nil
		}
		return nil, err
	}
	return statOf(p.Path, info), nil
}

func handleFsReaddir(_ context.Context, _ *Agent, _ *Link, raw json.RawMessage) (any, error) {
	p, err := decodeParams[wire.PathParams](raw)
	if err != nil {
		return nil, err
	}
	if err := requireAbs(p.Path); err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(p.Path)
	if err != nil {
		return nil, err
	}
	out := make([]wire.FsDirEntry, 0, len(entries))
	for _, entry := range entries {
		item := wire.FsDirEntry{Name: entry.Name(), Kind: kindOf(entry.Type())}
		if info, err := entry.Info(); err == nil {
			item.Size = info.Size()
			item.MtimeMs = mtimeMs(info)
			item.Kind = kindOf(info.Mode())
		}
		out = append(out, item)
	}
	return out, nil
}

func handleFsRealpath(_ context.Context, _ *Agent, _ *Link, raw json.RawMessage) (any, error) {
	p, err := decodeParams[wire.PathParams](raw)
	if err != nil {
		return nil, err
	}
	if err := requireAbs(p.Path); err != nil {
		return nil, err
	}
	resolved, err := filepath.EvalSymlinks(p.Path)
	if err != nil {
		return nil, err
	}
	return filepath.Abs(resolved)
}

func handleFsMkdir(_ context.Context, a *Agent, _ *Link, raw json.RawMessage) (any, error) {
	p, err := decodeParams[wire.MkdirParams](raw)
	if err != nil {
		return nil, err
	}
	if err := requireAbs(p.Path); err != nil {
		return nil, err
	}
	mode := os.FileMode(0o777)
	if p.Mode != nil {
		mode = os.FileMode(*p.Mode) & os.ModePerm
	}
	if p.Recursive != nil && *p.Recursive {
		err = os.MkdirAll(p.Path, mode)
	} else {
		err = os.Mkdir(p.Path, mode)
	}
	if err != nil {
		return nil, err
	}
	return nil, a.giveToWorkUser(p.Path)
}

func handleFsRename(_ context.Context, _ *Agent, _ *Link, raw json.RawMessage) (any, error) {
	p, err := decodeParams[wire.RenameParams](raw)
	if err != nil {
		return nil, err
	}
	if err := requireAbs(p.From); err != nil {
		return nil, err
	}
	if err := requireAbs(p.To); err != nil {
		return nil, err
	}
	return nil, os.Rename(p.From, p.To)
}

func handleFsRm(_ context.Context, _ *Agent, _ *Link, raw json.RawMessage) (any, error) {
	p, err := decodeParams[wire.RmParams](raw)
	if err != nil {
		return nil, err
	}
	if err := requireAbs(p.Path); err != nil {
		return nil, err
	}
	if filepath.Dir(p.Path) == p.Path {
		return nil, rpcErr("EPERM", "refusing to remove a filesystem root")
	}
	force := p.Force != nil && *p.Force
	recursive := p.Recursive != nil && *p.Recursive
	info, err := os.Lstat(p.Path)
	if err != nil {
		if force && errors.Is(err, fs.ErrNotExist) {
			return nil, nil
		}
		return nil, err
	}
	if info.IsDir() && !recursive {
		return nil, rpcErr("EISDIR", "is a directory (pass recursive): "+p.Path)
	}
	if recursive {
		return nil, os.RemoveAll(p.Path)
	}
	return nil, os.Remove(p.Path)
}

func handleFsChmod(_ context.Context, _ *Agent, _ *Link, raw json.RawMessage) (any, error) {
	p, err := decodeParams[wire.ChmodParams](raw)
	if err != nil {
		return nil, err
	}
	if err := requireAbs(p.Path); err != nil {
		return nil, err
	}
	return nil, os.Chmod(p.Path, os.FileMode(p.Mode)&(os.ModePerm|os.ModeSetuid|os.ModeSetgid|os.ModeSticky))
}

func handleFsSymlink(_ context.Context, a *Agent, _ *Link, raw json.RawMessage) (any, error) {
	p, err := decodeParams[wire.SymlinkParams](raw)
	if err != nil {
		return nil, err
	}
	if err := requireAbs(p.Path); err != nil {
		return nil, err
	}
	if err := os.Symlink(p.Target, p.Path); err != nil {
		return nil, err
	}
	if a.work != nil {
		_ = a.work.lchown(p.Path)
	}
	return nil, nil
}

func handleFsWatch(_ context.Context, a *Agent, l *Link, raw json.RawMessage) (any, error) {
	p, err := decodeParams[wire.WatchParams](raw)
	if err != nil {
		return nil, err
	}
	if err := requireAbs(p.Path); err != nil {
		return nil, err
	}
	if p.WatchID == "" {
		return nil, rpcErr("BAD_REQUEST", "watchId is required")
	}
	if _, err := os.Stat(p.Path); err != nil {
		return nil, err
	}
	w := newWatch(a, l, *p)
	l.mu.Lock()
	previous := l.watches[p.WatchID]
	l.watches[p.WatchID] = w
	l.mu.Unlock()
	if previous != nil {
		// Same id again (e.g. replayed after a reconnect): the new watch replaces it.
		previous.stop()
	}
	w.start()
	return nil, nil
}

func handleFsUnwatch(_ context.Context, _ *Agent, l *Link, raw json.RawMessage) (any, error) {
	p, err := decodeParams[wire.UnwatchParams](raw)
	if err != nil {
		return nil, err
	}
	l.mu.Lock()
	w := l.watches[p.WatchID]
	delete(l.watches, p.WatchID)
	l.mu.Unlock()
	if w != nil {
		w.stop()
	}
	return nil, nil
}

// giveToWorkUser chowns a path orq-agent created as root to the working user.
func (a *Agent) giveToWorkUser(path string) error {
	if a.work == nil {
		return nil
	}
	return a.work.chown(path)
}
