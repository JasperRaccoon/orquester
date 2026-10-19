//go:build windows

package agent

import (
	"os"
	"path/filepath"
	"unsafe"

	"golang.org/x/sys/windows"
)

const dirChangeMask = windows.FILE_NOTIFY_CHANGE_FILE_NAME | windows.FILE_NOTIFY_CHANGE_DIR_NAME |
	windows.FILE_NOTIFY_CHANGE_SIZE | windows.FILE_NOTIFY_CHANGE_LAST_WRITE | windows.FILE_NOTIFY_CHANGE_CREATION

// nativeWatch uses ReadDirectoryChangesW (natively recursive) with overlapped
// I/O, so stopping the watch cancels the pending read.
func nativeWatch(w *watch) error {
	info, err := os.Stat(w.root)
	if err != nil {
		return err
	}
	dir := w.root
	if !info.IsDir() {
		dir = filepath.Dir(w.root)
	}
	name, err := windows.UTF16PtrFromString(dir)
	if err != nil {
		return errNativeUnavailable
	}
	handle, err := windows.CreateFile(name, windows.FILE_LIST_DIRECTORY,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, nil,
		windows.OPEN_EXISTING, windows.FILE_FLAG_BACKUP_SEMANTICS|windows.FILE_FLAG_OVERLAPPED, 0)
	if err != nil {
		return errNativeUnavailable
	}
	defer windows.CloseHandle(handle)
	event, err := windows.CreateEvent(nil, 1, 0, nil)
	if err != nil {
		return errNativeUnavailable
	}
	defer windows.CloseHandle(event)
	stopEvent, err := windows.CreateEvent(nil, 1, 0, nil)
	if err != nil {
		return errNativeUnavailable
	}
	defer windows.CloseHandle(stopEvent)
	go func() {
		<-w.ctx.Done()
		_ = windows.SetEvent(stopEvent)
	}()

	buf := make([]byte, 64*1024)
	for {
		overlapped := windows.Overlapped{HEvent: event}
		_ = windows.ResetEvent(event)
		err := windows.ReadDirectoryChanges(handle, &buf[0], uint32(len(buf)), w.params.Recursive || !info.IsDir(),
			dirChangeMask, nil, &overlapped, 0)
		if err != nil && err != windows.ERROR_IO_PENDING {
			return errNativeUnavailable
		}
		which, err := windows.WaitForMultipleObjects([]windows.Handle{event, stopEvent}, false, windows.INFINITE)
		if err != nil {
			return errNativeUnavailable
		}
		if which == windows.WAIT_OBJECT_0+1 {
			_ = windows.CancelIoEx(handle, &overlapped)
			return nil
		}
		var n uint32
		if err := windows.GetOverlappedResult(handle, &overlapped, &n, false); err != nil {
			return errNativeUnavailable
		}
		if n == 0 {
			// The kernel buffer overflowed: report the root so consumers rescan.
			w.emit(w.root, "update")
			continue
		}
		for offset := uint32(0); ; {
			entry := (*windows.FileNotifyInformation)(unsafe.Pointer(&buf[offset]))
			nameLen := entry.FileNameLength / 2
			chars := unsafe.Slice(&entry.FileName, nameLen)
			path := filepath.Join(dir, windows.UTF16ToString(chars))
			if info.IsDir() || path == w.root {
				switch entry.Action {
				case windows.FILE_ACTION_ADDED, windows.FILE_ACTION_RENAMED_NEW_NAME:
					w.emit(path, "create")
				case windows.FILE_ACTION_REMOVED, windows.FILE_ACTION_RENAMED_OLD_NAME:
					w.emit(path, "delete")
				case windows.FILE_ACTION_MODIFIED:
					if fi, err := os.Stat(path); err == nil && !fi.IsDir() {
						w.emit(path, "update")
					}
				}
			}
			if entry.NextEntryOffset == 0 {
				break
			}
			offset += entry.NextEntryOffset
		}
	}
}
