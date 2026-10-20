//go:build linux

package agent

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"unsafe"

	"golang.org/x/sys/unix"
)

const inotifyMask = unix.IN_CREATE | unix.IN_DELETE | unix.IN_MODIFY | unix.IN_CLOSE_WRITE |
	unix.IN_MOVED_FROM | unix.IN_MOVED_TO | unix.IN_ATTRIB | unix.IN_DELETE_SELF | unix.IN_MOVE_SELF

// nativeWatch emulates a recursive watch with one inotify watch per directory.
// It returns errNativeUnavailable when inotify (or its watch limit) fails.
func nativeWatch(w *watch) error {
	fd, err := unix.InotifyInit1(unix.IN_CLOEXEC | unix.IN_NONBLOCK)
	if err != nil {
		return errNativeUnavailable
	}
	// A non-blocking fd goes through Go's poller, so Close unblocks Read.
	file := os.NewFile(uintptr(fd), "inotify")
	defer file.Close()
	go func() {
		<-w.ctx.Done()
		file.Close()
	}()

	dirs := map[int32]string{}
	add := func(dir string) error {
		wd, err := unix.InotifyAddWatch(fd, dir, inotifyMask)
		if err != nil {
			if errors.Is(err, unix.ENOSPC) || errors.Is(err, unix.ENOMEM) {
				return errNativeUnavailable
			}
			return nil
		}
		dirs[int32(wd)] = dir
		return nil
	}
	info, err := os.Stat(w.root)
	if err != nil {
		return err
	}
	if !info.IsDir() {
		// A single file: watch its directory, scoped to the file.
		if err := add(filepath.Dir(w.root)); err != nil {
			return err
		}
	} else if err := w.walkDirs(w.root, add); err != nil {
		return errNativeUnavailable
	}

	buf := make([]byte, 64*1024)
	for {
		n, err := file.Read(buf)
		if err != nil {
			if w.ctx.Err() != nil {
				return nil
			}
			return errNativeUnavailable
		}
		for offset := 0; offset+unix.SizeofInotifyEvent <= n; {
			event := (*unix.InotifyEvent)(unsafe.Pointer(&buf[offset]))
			nameBytes := buf[offset+unix.SizeofInotifyEvent : offset+unix.SizeofInotifyEvent+int(event.Len)]
			offset += unix.SizeofInotifyEvent + int(event.Len)
			if event.Mask&unix.IN_Q_OVERFLOW != 0 {
				// Events were lost: report the root changed so consumers rescan.
				w.emit(w.root, "update")
				continue
			}
			dir, ok := dirs[event.Wd]
			if !ok {
				continue
			}
			if event.Mask&unix.IN_IGNORED != 0 {
				delete(dirs, event.Wd)
				continue
			}
			name := strings.TrimRight(string(nameBytes), "\x00")
			path := dir
			if name != "" {
				path = filepath.Join(dir, name)
			}
			if !info.IsDir() && path != w.root {
				continue
			}
			switch {
			case event.Mask&(unix.IN_CREATE|unix.IN_MOVED_TO) != 0:
				w.emit(path, "create")
				if event.Mask&unix.IN_ISDIR != 0 && w.params.Recursive && !w.ignored(path) {
					if err := w.walkDirs(path, add); errors.Is(err, errNativeUnavailable) {
						return err
					}
					w.emitTree(path)
				}
			case event.Mask&(unix.IN_DELETE|unix.IN_MOVED_FROM) != 0:
				w.emit(path, "delete")
				if event.Mask&unix.IN_ISDIR != 0 {
					// Forget watches under a directory that moved away; a move
					// inside the tree re-adds them through its IN_MOVED_TO.
					for wd, watched := range dirs {
						if watched == path || strings.HasPrefix(watched, path+string(filepath.Separator)) {
							_, _ = unix.InotifyRmWatch(fd, uint32(wd))
							delete(dirs, wd)
						}
					}
				}
			case event.Mask&(unix.IN_DELETE_SELF|unix.IN_MOVE_SELF) != 0:
				if name == "" && dir == w.root {
					w.emit(w.root, "delete")
				}
			case event.Mask&(unix.IN_MODIFY|unix.IN_CLOSE_WRITE|unix.IN_ATTRIB) != 0:
				if event.Mask&unix.IN_ISDIR == 0 {
					w.emit(path, "update")
				}
			}
		}
	}
}
