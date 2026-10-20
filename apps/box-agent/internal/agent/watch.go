package agent

import (
	"context"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"orquester/box-agent/internal/wire"
)

// Debounce: changes are batched for watchQuiet after the last one, but never
// held longer than watchMaxDelay after the first.
const (
	watchQuiet    = 100 * time.Millisecond
	watchMaxDelay = time.Second
	pollInterval  = 1500 * time.Millisecond
	pollMaxItems  = 200_000
)

// errNativeUnavailable makes a watch fall back to polling.
var errNativeUnavailable = errors.New("native file watching unavailable")

// watch is one `fs.watch`: a native backend (inotify on Linux,
// ReadDirectoryChangesW on Windows) or polling (macOS, and wherever the
// native one fails), feeding a debounced, coalesced `fs.change` stream.
type watch struct {
	agent  *Agent
	link   *Link
	params wire.WatchParams
	root   string
	ctx    context.Context
	cancel context.CancelFunc

	mu      sync.Mutex
	pending map[string]string
	order   []string
	timer   *time.Timer
	firstAt time.Time
}

func newWatch(a *Agent, l *Link, p wire.WatchParams) *watch {
	ctx, cancel := context.WithCancel(l.ctx)
	return &watch{agent: a, link: l, params: p, root: filepath.Clean(p.Path), ctx: ctx, cancel: cancel, pending: map[string]string{}}
}

func (w *watch) start() {
	go func() {
		err := nativeWatch(w)
		if w.ctx.Err() != nil {
			return
		}
		if err != nil {
			pollWatch(w)
		}
	}()
}

func (w *watch) stop() {
	w.cancel()
	w.mu.Lock()
	if w.timer != nil {
		w.timer.Stop()
	}
	w.mu.Unlock()
}

// ignored applies `ignore`: a pattern matches any path segment, the path
// relative to the root (both with filepath.Match syntax), or a prefix of it.
func (w *watch) ignored(path string) bool {
	if len(w.params.Ignore) == 0 {
		return false
	}
	rel, err := filepath.Rel(w.root, path)
	if err != nil || rel == "." {
		return false
	}
	rel = filepath.ToSlash(rel)
	segments := strings.Split(rel, "/")
	for _, pattern := range w.params.Ignore {
		pattern = strings.TrimSuffix(filepath.ToSlash(pattern), "/")
		if pattern == "" {
			continue
		}
		if ok, _ := filepath.Match(pattern, rel); ok || strings.HasPrefix(rel, pattern+"/") {
			return true
		}
		for _, segment := range segments {
			if ok, _ := filepath.Match(pattern, segment); ok {
				return true
			}
		}
	}
	return false
}

// inScope: non-recursive watches report the root and its direct children only.
func (w *watch) inScope(path string) bool {
	if w.params.Recursive {
		return true
	}
	return path == w.root || filepath.Dir(path) == w.root
}

// emit queues one change, coalescing with what is already pending.
func (w *watch) emit(path, kind string) {
	if w.ctx.Err() != nil || !w.inScope(path) || w.ignored(path) {
		return
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	prev, seen := w.pending[path]
	next := kind
	if seen {
		switch {
		case prev == "create" && kind == "delete":
			delete(w.pending, path)
			return
		case prev == "create":
			next = "create"
		case prev == "delete" && kind != "delete":
			next = "update"
		}
	} else {
		w.order = append(w.order, path)
	}
	w.pending[path] = next
	now := time.Now()
	if w.timer == nil {
		w.firstAt = now
		w.timer = time.AfterFunc(watchQuiet, w.flush)
		return
	}
	wait := watchQuiet
	if limit := watchMaxDelay - now.Sub(w.firstAt); limit < wait {
		wait = max(limit, 0)
	}
	w.timer.Reset(wait)
}

func (w *watch) flush() {
	w.mu.Lock()
	changes := make([]wire.FsChange, 0, len(w.pending))
	for _, path := range w.order {
		if kind, ok := w.pending[path]; ok {
			changes = append(changes, wire.FsChange{Path: path, Type: kind})
		}
	}
	w.pending = map[string]string{}
	w.order = nil
	w.timer = nil
	w.mu.Unlock()
	if len(changes) == 0 || w.ctx.Err() != nil || w.link == nil {
		return
	}
	_ = w.link.SendEvent("fs.change", wire.FsChangeEvent{WatchID: w.params.WatchID, Changes: changes})
}

type pollEntry struct {
	mtime int64
	size  int64
	dir   bool
}

// scan maps every (in-scope, not ignored) path under the root to its state.
func (w *watch) scan() map[string]pollEntry {
	out := map[string]pollEntry{}
	_ = filepath.WalkDir(w.root, func(path string, d fs.DirEntry, err error) error {
		if w.ctx.Err() != nil {
			return filepath.SkipAll
		}
		if err != nil {
			return nil
		}
		if path != w.root && (w.ignored(path) || !w.inScope(path)) {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if len(out) >= pollMaxItems {
			return filepath.SkipAll
		}
		info, err := d.Info()
		if err != nil {
			return nil
		}
		out[path] = pollEntry{mtime: info.ModTime().UnixNano(), size: info.Size(), dir: d.IsDir()}
		if !w.params.Recursive && path != w.root && d.IsDir() {
			return filepath.SkipDir
		}
		return nil
	})
	return out
}

// pollWatch compares tree snapshots every pollInterval.
func pollWatch(w *watch) {
	previous := w.scan()
	ticker := time.NewTicker(pollInterval)
	defer ticker.Stop()
	for {
		select {
		case <-w.ctx.Done():
			return
		case <-ticker.C:
		}
		current := w.scan()
		for path, entry := range current {
			old, ok := previous[path]
			switch {
			case !ok:
				w.emit(path, "create")
			case old.dir != entry.dir:
				w.emit(path, "delete")
				w.emit(path, "create")
			case !entry.dir && (old.mtime != entry.mtime || old.size != entry.size):
				w.emit(path, "update")
			}
		}
		for path := range previous {
			if _, ok := current[path]; !ok {
				w.emit(path, "delete")
			}
		}
		previous = current
	}
}

// walkDirs lists directories under the root that a native backend must watch.
func (w *watch) walkDirs(root string, visit func(dir string) error) error {
	return filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			if path == root {
				return err
			}
			return nil
		}
		if !d.IsDir() {
			return nil
		}
		if path != w.root && w.ignored(path) {
			return filepath.SkipDir
		}
		if err := visit(path); err != nil {
			return err
		}
		if !w.params.Recursive && path != root {
			return filepath.SkipDir
		}
		return nil
	})
}

// emitTree reports everything under a directory that appeared before its
// native watch was in place.
func (w *watch) emitTree(dir string) {
	_ = filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil || path == dir {
			return nil
		}
		if w.ignored(path) {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		w.emit(path, "create")
		return nil
	})
}

func pathExists(path string) bool {
	_, err := os.Lstat(path)
	return err == nil
}
