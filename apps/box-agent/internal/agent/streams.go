package agent

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"sync"
	"time"

	"orquester/box-agent/internal/wire"
)

// halfCloser is a connection whose write side can be closed alone.
type halfCloser interface {
	CloseWrite() error
}

// bridge pipes a channel and a local connection both ways: channel stream 0
// → conn, conn → channel stream 1. A clean EOF half-closes; an error on
// either side tears down both.
func bridge(ch *Channel, conn io.ReadWriteCloser) {
	ch.SetHandlers(nil, nil, func(err *wire.RPCError) {
		// A plain close after the peer's eof: let the last bytes drain to conn.
		if err == nil && ch.gotEOF() {
			return
		}
		_ = conn.Close()
	})
	var once sync.Once
	abort := func() {
		once.Do(func() {
			_ = conn.Close()
			ch.Close(nil)
		})
	}
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		_, err := io.Copy(conn, ch.Reader())
		if err != nil {
			abort()
			return
		}
		if hc, ok := conn.(halfCloser); ok {
			_ = hc.CloseWrite()
		}
		if !ch.alive() {
			// The peer already closed: nothing more can travel the other way.
			abort()
		}
	}()
	go func() {
		defer wg.Done()
		_, err := io.Copy(ch.StreamWriter(wire.StreamFromBox), conn)
		if err != nil {
			abort()
			return
		}
		ch.EOF(wire.StreamFromBox)
	}()
	wg.Wait()
	abort()
}

func openTCP(ch *Channel, spec *wire.TCPSpec) {
	host := spec.Host
	if host == "" {
		host = "127.0.0.1"
	}
	if spec.Port <= 0 || spec.Port > 65535 {
		ch.OpenFailed(rpcErr("BAD_REQUEST", "port out of range"))
		return
	}
	conn, err := net.DialTimeout("tcp", net.JoinHostPort(host, strconv.Itoa(spec.Port)), 15*time.Second)
	if err != nil {
		ch.OpenFailed(err)
		return
	}
	if err := ch.Opened(nil); err != nil {
		conn.Close()
		return
	}
	bridge(ch, conn)
}

// openUnix connects to a Unix socket in the box (a desktop's VNC, X11 and PulseAudio sockets).
func openUnix(ch *Channel, spec *wire.UnixSpec) {
	if err := requireAbs(spec.Path); err != nil {
		ch.OpenFailed(err)
		return
	}
	conn, err := net.DialTimeout("unix", spec.Path, 15*time.Second)
	if err != nil {
		ch.OpenFailed(err)
		return
	}
	if err := ch.Opened(nil); err != nil {
		conn.Close()
		return
	}
	bridge(ch, conn)
}

func openFileRead(ch *Channel, spec *wire.FileReadSpec) {
	if err := requireAbs(spec.Path); err != nil {
		ch.OpenFailed(err)
		return
	}
	f, err := os.Open(spec.Path)
	if err != nil {
		ch.OpenFailed(err)
		return
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		ch.OpenFailed(err)
		return
	}
	if info.IsDir() {
		ch.OpenFailed(rpcErr("EISDIR", "is a directory: "+spec.Path))
		return
	}
	var reader io.Reader = f
	if spec.Offset != nil && *spec.Offset > 0 {
		if _, err := f.Seek(*spec.Offset, io.SeekStart); err != nil {
			ch.OpenFailed(err)
			return
		}
	}
	if spec.Length != nil {
		reader = io.LimitReader(f, max(*spec.Length, 0))
	}
	size := info.Size()
	if err := ch.Opened(&wire.OpenedInfo{Size: &size}); err != nil {
		return
	}
	if _, err := io.Copy(ch.StreamWriter(wire.StreamFromBox), reader); err != nil {
		ch.Close(err)
		return
	}
	ch.EOF(wire.StreamFromBox)
	ch.Close(nil)
}

// openFileWrite writes stream 0 to a temp file next to the target and renames
// it into place on eof (or appends). Success = eof on stream 1, then close;
// failure = close with an error.
func (a *Agent) openFileWrite(ch *Channel, spec *wire.FileWriteSpec) {
	if err := requireAbs(spec.Path); err != nil {
		ch.OpenFailed(err)
		return
	}
	dir := filepath.Dir(spec.Path)
	if spec.Mkdirs != nil && *spec.Mkdirs {
		if err := a.ensurePath(dir); err != nil {
			ch.OpenFailed(err)
			return
		}
	}
	mode := os.FileMode(0o644)
	existing, statErr := os.Stat(spec.Path)
	if statErr == nil {
		if existing.IsDir() {
			ch.OpenFailed(rpcErr("EISDIR", "is a directory: "+spec.Path))
			return
		}
		mode = existing.Mode().Perm()
	}
	if spec.Mode != nil {
		mode = os.FileMode(*spec.Mode) & os.ModePerm
	}
	appendMode := spec.Append != nil && *spec.Append
	var f *os.File
	var tmpName string
	var err error
	if appendMode {
		f, err = os.OpenFile(spec.Path, os.O_WRONLY|os.O_APPEND|os.O_CREATE, mode)
	} else {
		f, err = os.CreateTemp(dir, "."+filepath.Base(spec.Path)+".orq-tmp-*")
		if err == nil {
			tmpName = f.Name()
		}
	}
	if err != nil {
		ch.OpenFailed(err)
		return
	}
	cleanup := func() {
		f.Close()
		if tmpName != "" {
			os.Remove(tmpName)
		}
	}
	if err := ch.Opened(nil); err != nil {
		cleanup()
		return
	}
	if _, err := io.Copy(f, ch.Reader()); err != nil {
		// The channel died before eof (or the disk failed): nothing replaced.
		cleanup()
		ch.Close(err)
		return
	}
	commit := func() error {
		if tmpName != "" {
			if err := f.Chmod(mode); err != nil && !isWindows {
				return err
			}
		}
		if err := f.Sync(); err != nil {
			return err
		}
		if err := f.Close(); err != nil {
			return err
		}
		if tmpName != "" {
			if a.work != nil && statErr != nil {
				if err := a.work.chown(tmpName); err != nil {
					return err
				}
			}
			if err := renameReplacing(tmpName, spec.Path); err != nil {
				return err
			}
			tmpName = ""
		}
		return nil
	}
	if err := commit(); err != nil {
		cleanup()
		ch.Close(err)
		return
	}
	ch.EOF(wire.StreamFromBox)
	ch.Close(nil)
}

// boundedBuffer keeps the first `limit` bytes written (tar's stderr).
type boundedBuffer struct {
	buf   bytes.Buffer
	limit int
}

func (b *boundedBuffer) Write(p []byte) (int, error) {
	if room := b.limit - b.buf.Len(); room > 0 {
		b.buf.Write(p[:min(room, len(p))])
	}
	return len(p), nil
}

func tarError(err error, stderr *boundedBuffer) error {
	msg := bytes.TrimSpace(stderr.buf.Bytes())
	if len(msg) == 0 {
		return rpcErr("TAR_FAILED", err.Error())
	}
	return rpcErr("TAR_FAILED", fmt.Sprintf("%v: %s", err, msg))
}

func tarCommand() string {
	if isWindows {
		return "tar.exe"
	}
	return "tar"
}

// openTarRead streams `tar -c` of a path as stream 1. Entries are named
// relative to the path's parent (`<basename>/…`), like the local test double.
func (a *Agent) openTarRead(ch *Channel, spec *wire.TarReadSpec) {
	if err := requireAbs(spec.Path); err != nil {
		ch.OpenFailed(err)
		return
	}
	clean := filepath.Clean(spec.Path)
	if _, err := os.Lstat(clean); err != nil {
		ch.OpenFailed(err)
		return
	}
	args := []string{"-cf", "-", "-C", filepath.Dir(clean)}
	for _, pattern := range spec.Exclude {
		args = append(args, "--exclude="+pattern)
	}
	args = append(args, filepath.Base(clean))
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	cmd := exec.CommandContext(ctx, tarCommand(), args...)
	cmd.Env = a.processEnv(nil, nil, nil)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		ch.OpenFailed(err)
		return
	}
	stderr := &boundedBuffer{limit: 16 * 1024}
	cmd.Stderr = stderr
	if err := cmd.Start(); err != nil {
		ch.OpenFailed(spawnError(err))
		return
	}
	ch.SetHandlers(nil, nil, func(*wire.RPCError) { cancel() })
	if err := ch.Opened(nil); err != nil {
		cancel()
		_ = cmd.Wait()
		return
	}
	_, copyErr := io.Copy(ch.StreamWriter(wire.StreamFromBox), stdout)
	if copyErr != nil {
		cancel()
	}
	if err := cmd.Wait(); err != nil {
		ch.Close(tarError(err, stderr))
		return
	}
	if copyErr != nil {
		ch.Close(copyErr)
		return
	}
	ch.EOF(wire.StreamFromBox)
	ch.Close(nil)
}

// openTarWrite extracts stream 0 into directory `path` (created if needed).
// Success = eof on stream 1, then close; failure = close with an error.
func (a *Agent) openTarWrite(ch *Channel, spec *wire.TarWriteSpec) {
	if err := requireAbs(spec.Path); err != nil {
		ch.OpenFailed(err)
		return
	}
	if err := a.ensurePath(spec.Path); err != nil {
		ch.OpenFailed(err)
		return
	}
	args := []string{"-xf", "-", "-C", spec.Path}
	if !isWindows && os.Geteuid() == 0 && a.work == nil {
		// Root would otherwise restore the host's uids from the archive.
		args = append(args, "--no-same-owner")
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	cmd := exec.CommandContext(ctx, tarCommand(), args...)
	cmd.Env = a.processEnv(nil, nil, nil)
	a.runAsWorkUser(cmd)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		ch.OpenFailed(err)
		return
	}
	stderr := &boundedBuffer{limit: 16 * 1024}
	cmd.Stderr = stderr
	if err := cmd.Start(); err != nil {
		ch.OpenFailed(spawnError(err))
		return
	}
	if err := ch.Opened(nil); err != nil {
		cancel()
		_ = cmd.Wait()
		return
	}
	_, copyErr := io.Copy(stdin, ch.Reader())
	if copyErr != nil && !errors.Is(copyErr, errChannelClosed) {
		// tar stopped reading (it failed); its exit status says why.
		copyErr = nil
	}
	if copyErr != nil {
		cancel()
		_ = cmd.Wait()
		return
	}
	_ = stdin.Close()
	if err := cmd.Wait(); err != nil {
		ch.Close(tarError(err, stderr))
		return
	}
	ch.EOF(wire.StreamFromBox)
	ch.Close(nil)
}
