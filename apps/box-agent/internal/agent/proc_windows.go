//go:build windows

package agent

import (
	"errors"
	"io"
	"os"
	"os/exec"
	"strconv"
	"sync"
	"syscall"
	"unicode/utf16"
	"unsafe"

	"golang.org/x/sys/windows"
)

// process is a started child, with pipes or a ConPTY.
type process interface {
	pid() int
	stdin() io.WriteCloser
	stdout() io.Reader
	stderr() io.Reader
	wait() (*int, *string)
	signal(name string) error
	resize(cols, rows int) error
	kill()
	closeOutput()
	release()
}

func startProcess(s *startSpec) (process, error) {
	if s.pty != nil {
		return startConPTY(s)
	}
	return startPiped(s)
}

func spawnError(err error) error {
	if errors.Is(err, os.ErrNotExist) {
		return rpcErr("ENOENT", err.Error())
	}
	if errors.Is(err, os.ErrPermission) {
		return rpcErr("EACCES", err.Error())
	}
	return rpcErr("SPAWN_FAILED", err.Error())
}

func clampSize(cols, rows int) (int16, int16) {
	if cols <= 0 {
		cols = 80
	}
	if rows <= 0 {
		rows = 24
	}
	return int16(min(cols, 32767)), int16(min(rows, 32767))
}

// killTree ends a process and its descendants.
func killTree(pid int) {
	cmd := exec.Command("taskkill.exe", "/T", "/F", "/PID", strconv.Itoa(pid))
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	if err := cmd.Run(); err != nil {
		if h, err := windows.OpenProcess(windows.PROCESS_TERMINATE, false, uint32(pid)); err == nil {
			_ = windows.TerminateProcess(h, 1)
			_ = windows.CloseHandle(h)
		}
	}
}

// ---------------------------------------------------------------------------
// Pipes
// ---------------------------------------------------------------------------

type pipedProcess struct {
	cmd    *exec.Cmd
	in     io.WriteCloser
	out    io.ReadCloser
	errOut io.ReadCloser

	waitMu sync.Mutex
	waited bool
	code   *int
}

func startPiped(s *startSpec) (process, error) {
	cmd := &exec.Cmd{Path: s.path, Args: s.args, Dir: s.dir, Env: s.env}
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: windows.CREATE_NEW_PROCESS_GROUP}
	stdinR, stdinW, err := os.Pipe()
	if err != nil {
		return nil, err
	}
	stdoutR, stdoutW, err := os.Pipe()
	if err != nil {
		stdinR.Close()
		stdinW.Close()
		return nil, err
	}
	stderrR, stderrW, err := os.Pipe()
	if err != nil {
		stdinR.Close()
		stdinW.Close()
		stdoutR.Close()
		stdoutW.Close()
		return nil, err
	}
	cmd.Stdin, cmd.Stdout, cmd.Stderr = stdinR, stdoutW, stderrW
	err = cmd.Start()
	stdinR.Close()
	stdoutW.Close()
	stderrW.Close()
	if err != nil {
		stdinW.Close()
		stdoutR.Close()
		stderrR.Close()
		return nil, spawnError(err)
	}
	return &pipedProcess{cmd: cmd, in: stdinW, out: stdoutR, errOut: stderrR}, nil
}

func (p *pipedProcess) pid() int              { return p.cmd.Process.Pid }
func (p *pipedProcess) stdin() io.WriteCloser { return p.in }
func (p *pipedProcess) stdout() io.Reader     { return p.out }
func (p *pipedProcess) stderr() io.Reader     { return p.errOut }

func (p *pipedProcess) wait() (*int, *string) {
	p.waitMu.Lock()
	defer p.waitMu.Unlock()
	if !p.waited {
		_ = p.cmd.Wait()
		code := p.cmd.ProcessState.ExitCode()
		p.code = &code
		p.waited = true
	}
	return p.code, nil
}

func (p *pipedProcess) signal(name string) error {
	switch name {
	case "SIGINT":
		// Best effort: reaches the child only when it shares a console with us.
		_ = windows.GenerateConsoleCtrlEvent(windows.CTRL_BREAK_EVENT, uint32(p.pid()))
		return nil
	case "SIGTERM", "SIGKILL", "SIGHUP", "SIGQUIT":
		killTree(p.pid())
		return nil
	}
	return rpcErr("BAD_REQUEST", "signal "+name+" is not supported on Windows")
}

func (p *pipedProcess) resize(int, int) error { return nil }
func (p *pipedProcess) kill()                 { killTree(p.pid()) }

func (p *pipedProcess) closeOutput() {
	_ = p.out.Close()
	_ = p.errOut.Close()
}

func (p *pipedProcess) release() {
	_ = p.in.Close()
	_ = p.out.Close()
	_ = p.errOut.Close()
}

// ---------------------------------------------------------------------------
// ConPTY
// ---------------------------------------------------------------------------

type conptyProcess struct {
	hpc     windows.Handle
	handle  windows.Handle
	pidNum  int
	in      *os.File
	out     *os.File
	closeMu sync.Mutex
	closed  bool

	waitMu sync.Mutex
	waited bool
	code   *int
}

// envBlock builds a CreateProcess UTF-16 environment block.
func envBlock(env []string) *uint16 {
	if len(env) == 0 {
		return nil
	}
	var block []uint16
	for _, kv := range env {
		block = append(block, utf16.Encode([]rune(kv))...)
		block = append(block, 0)
	}
	block = append(block, 0)
	return &block[0]
}

func startConPTY(s *startSpec) (process, error) {
	var inR, inW, outR, outW windows.Handle
	if err := windows.CreatePipe(&inR, &inW, nil, 0); err != nil {
		return nil, err
	}
	if err := windows.CreatePipe(&outR, &outW, nil, 0); err != nil {
		windows.CloseHandle(inR)
		windows.CloseHandle(inW)
		return nil, err
	}
	cols, rows := clampSize(s.pty.Cols, s.pty.Rows)
	var hpc windows.Handle
	err := windows.CreatePseudoConsole(windows.Coord{X: cols, Y: rows}, inR, outW, 0, &hpc)
	// The pseudoconsole holds its own duplicates of these ends.
	windows.CloseHandle(inR)
	windows.CloseHandle(outW)
	if err != nil {
		windows.CloseHandle(inW)
		windows.CloseHandle(outR)
		return nil, rpcErr("SPAWN_FAILED", "CreatePseudoConsole: "+err.Error())
	}
	fail := func(err error) (process, error) {
		windows.ClosePseudoConsole(hpc)
		windows.CloseHandle(inW)
		windows.CloseHandle(outR)
		return nil, err
	}
	attrs, err := windows.NewProcThreadAttributeList(1)
	if err != nil {
		return fail(err)
	}
	defer attrs.Delete()
	// The attribute's value is the HPCON itself, not a pointer to it; read the
	// handle's bits as a pointer (the console is not Go memory).
	hpcValue := *(*unsafe.Pointer)(unsafe.Pointer(&hpc))
	if err := attrs.Update(windows.PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, hpcValue, unsafe.Sizeof(hpc)); err != nil {
		return fail(err)
	}
	si := &windows.StartupInfoEx{ProcThreadAttributeList: attrs.List()}
	si.Cb = uint32(unsafe.Sizeof(*si))
	appName, err := windows.UTF16PtrFromString(s.path)
	if err != nil {
		return fail(err)
	}
	cmdLine, err := windows.UTF16PtrFromString(windows.ComposeCommandLine(s.args))
	if err != nil {
		return fail(err)
	}
	var dir *uint16
	if s.dir != "" {
		if dir, err = windows.UTF16PtrFromString(s.dir); err != nil {
			return fail(err)
		}
	}
	var pi windows.ProcessInformation
	flags := uint32(windows.EXTENDED_STARTUPINFO_PRESENT | windows.CREATE_UNICODE_ENVIRONMENT)
	if err := windows.CreateProcess(appName, cmdLine, nil, nil, false, flags, envBlock(s.env), dir, &si.StartupInfo, &pi); err != nil {
		return fail(spawnError(err))
	}
	windows.CloseHandle(pi.Thread)
	return &conptyProcess{
		hpc:    hpc,
		handle: pi.Process,
		pidNum: int(pi.ProcessId),
		in:     os.NewFile(uintptr(inW), "conpty-in"),
		out:    os.NewFile(uintptr(outR), "conpty-out"),
	}, nil
}

func (p *conptyProcess) pid() int              { return p.pidNum }
func (p *conptyProcess) stdin() io.WriteCloser { return p.in }
func (p *conptyProcess) stdout() io.Reader     { return p.out }
func (p *conptyProcess) stderr() io.Reader     { return nil }

func (p *conptyProcess) closeConsole() {
	p.closeMu.Lock()
	defer p.closeMu.Unlock()
	if p.closed {
		return
	}
	p.closed = true
	// Flushes the last output into the pipe, then ends it (our reader sees EOF).
	windows.ClosePseudoConsole(p.hpc)
}

func (p *conptyProcess) wait() (*int, *string) {
	p.waitMu.Lock()
	defer p.waitMu.Unlock()
	if !p.waited {
		_, _ = windows.WaitForSingleObject(p.handle, windows.INFINITE)
		var code uint32
		_ = windows.GetExitCodeProcess(p.handle, &code)
		c := int(code)
		p.code = &c
		p.waited = true
		// Without this the output pipe never reaches EOF.
		go p.closeConsole()
	}
	return p.code, nil
}

func (p *conptyProcess) signal(name string) error {
	switch name {
	case "SIGINT":
		_, err := p.in.Write([]byte{0x03})
		return err
	case "SIGTERM", "SIGKILL", "SIGHUP", "SIGQUIT":
		killTree(p.pidNum)
		return nil
	}
	return rpcErr("BAD_REQUEST", "signal "+name+" is not supported on Windows")
}

func (p *conptyProcess) resize(cols, rows int) error {
	c, r := clampSize(cols, rows)
	return windows.ResizePseudoConsole(p.hpc, windows.Coord{X: c, Y: r})
}

func (p *conptyProcess) kill() { killTree(p.pidNum) }

func (p *conptyProcess) closeOutput() { _ = p.out.Close() }

func (p *conptyProcess) release() {
	p.closeConsole()
	_ = p.in.Close()
	_ = p.out.Close()
	_ = windows.CloseHandle(p.handle)
}
