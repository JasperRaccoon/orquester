//go:build windows

package agent

import (
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/Microsoft/go-winio"
	"golang.org/x/sys/windows"
)

// The Windows half of the desktop-session helper (desktop_pipe.go): the named pipe, who may use
// it, and the scheduled task that starts the helper (desktop_task.go).
//
// Trust runs both ways:
//   - The service creates the pipe as its first instance (so nothing else holds the name), owned by
//     LocalSystem and open only to LocalSystem and the desktop user (desktopPipeSecurity). A client
//     must be this very orq-agent.exe, running in an interactive session, else it is told to exit.
//   - The helper dials without letting the server impersonate it, and talks only to a pipe owned by
//     LocalSystem: no other process can create one (it would need SeRestorePrivilege), so a process
//     squatting the name before the service starts never gets a command run as the desktop user.

// helperKickInterval: the service starts the helper's task at most this often.
const helperKickInterval = 30 * time.Second

// helperKeepAlive: while no helper is connected, the service runs its task this often. The task's
// own restart-on-failure covers only a helper that failed to start (Task Scheduler does not count
// an exit code as a failure), so this is what brings back one that exited or was ended.
const helperKeepAlive = time.Minute

// startDesktop serves the helper pipe when the helper is installed (desktop-helper.json) and
// orq-agent runs as the service; the returned closer stops it. nil when there is no helper.
func (a *Agent) startDesktop() io.Closer {
	if !a.cfg.Service {
		return nil
	}
	marker, err := readDesktopMarker(a.cfg.DataDir)
	if err != nil {
		a.log.Printf("desktop-session helper unavailable: %v", err)
		return nil
	}
	if marker == nil {
		return nil
	}
	exe, err := executablePath()
	if err != nil {
		a.log.Printf("desktop-session helper unavailable: %v", err)
		return nil
	}
	security, err := desktopPipeSecurity(marker.SID)
	if err != nil {
		a.log.Printf("desktop-session helper unavailable: %v", err)
		return nil
	}
	hub := newDesktopHub(a.log, a.cfg.Version, true)
	hub.verify = func(conn net.Conn) error { return verifyDesktopClient(conn, exe) }
	hub.kick = kickDesktopTask(a.log)
	a.desktop = hub
	listener, err := winio.ListenPipe(pipeName("desktop", a.cfg.DataDir), &winio.PipeConfig{
		SecurityDescriptor: security,
		InputBufferSize:    64 * 1024,
		OutputBufferSize:   64 * 1024,
	})
	if err != nil {
		// The capability stays: desktop execs fail with NO_DESKTOP_SESSION and say why.
		a.log.Printf("desktop-session helper pipe unavailable (does another process hold its name?): %v", err)
		return nil
	}
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			go hub.serveConn(conn)
		}
	}()
	stop := make(chan struct{})
	go func() {
		ticker := time.NewTicker(helperKeepAlive)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				if hub.connected() == nil {
					hub.kick()
				}
			case <-stop:
				return
			}
		}
	}()
	return closerFunc(func() error {
		close(stop)
		err := listener.Close()
		hub.close()
		return err
	})
}

type closerFunc func() error

func (f closerFunc) Close() error { return f() }

// pipeHandle is the Win32 handle under a go-winio pipe connection.
func pipeHandle(conn net.Conn) (windows.Handle, error) {
	f, ok := conn.(interface{ Fd() uintptr })
	if !ok {
		return 0, errors.New("not a named pipe connection")
	}
	return windows.Handle(f.Fd()), nil
}

// verifyDesktopClient: the client is this orq-agent.exe, in an interactive session.
func verifyDesktopClient(conn net.Conn, exe string) error {
	handle, err := pipeHandle(conn)
	if err != nil {
		return err
	}
	var pid uint32
	if err := windows.GetNamedPipeClientProcessId(handle, &pid); err != nil {
		return fmt.Errorf("could not identify the client process: %w", err)
	}
	var session uint32
	if err := windows.ProcessIdToSessionId(pid, &session); err != nil {
		return fmt.Errorf("could not read the client's session: %w", err)
	}
	if session == 0 {
		return errors.New("the client does not run in a desktop session")
	}
	process, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
	if err != nil {
		return fmt.Errorf("could not open the client process: %w", err)
	}
	defer windows.CloseHandle(process)
	buf := make([]uint16, windows.MAX_LONG_PATH)
	size := uint32(len(buf))
	if err := windows.QueryFullProcessImageName(process, 0, &buf[0], &size); err != nil {
		return fmt.Errorf("could not read the client's executable: %w", err)
	}
	image := windows.UTF16ToString(buf[:size])
	if !strings.EqualFold(filepath.Clean(image), filepath.Clean(exe)) {
		return fmt.Errorf("the client runs %s, not %s", image, exe)
	}
	return nil
}

// dialDesktopPipe connects the helper to the service, refusing a pipe LocalSystem does not own.
func dialDesktopPipe(dataDir string) (net.Conn, error) {
	timeout := 5 * time.Second
	conn, err := winio.DialPipe(pipeName("desktop", dataDir), &timeout)
	if err != nil {
		return nil, err
	}
	handle, err := pipeHandle(conn)
	if err == nil {
		var sd *windows.SECURITY_DESCRIPTOR
		sd, err = windows.GetSecurityInfo(handle, windows.SE_KERNEL_OBJECT, windows.OWNER_SECURITY_INFORMATION)
		if err == nil {
			owner, _, ownerErr := sd.Owner()
			switch {
			case ownerErr != nil:
				err = ownerErr
			case owner == nil || !owner.IsWellKnown(windows.WinLocalSystemSid):
				err = errors.New("the pipe is not the orq-agent service's (not owned by LocalSystem)")
			}
		}
	}
	if err != nil {
		_ = conn.Close()
		return nil, err
	}
	return conn, nil
}

// kickDesktopTask runs the helper's task (it starts only while its user is signed in), at most
// once per helperKickInterval.
func kickDesktopTask(logger *log.Logger) func() {
	var mu sync.Mutex
	var last time.Time
	return func() {
		mu.Lock()
		if !last.IsZero() && time.Since(last) < helperKickInterval {
			mu.Unlock()
			return
		}
		last = time.Now()
		mu.Unlock()
		if err := runHidden("schtasks.exe", "/Run", "/TN", desktopTaskName); err != nil {
			logger.Printf("could not start the desktop-session helper's task (is its user signed in?)")
		}
	}
}

// runHidden runs a console program without a window and waits; output is dropped (schtasks
// prints localized text, which nothing reads).
func runHidden(name string, args ...string) error {
	cmd := exec.Command(name, args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	return cmd.Run()
}

// DesktopHelperCommand is `orq-agent desktop-helper`: it serves the service from the desktop
// session until the service tells it to exit (exit code 3; the service then runs the task again,
// which starts the build on disk), dialling again whenever the pipe drops.
func DesktopHelperCommand(version, dataDir string) int {
	dir, err := desktopDataDir(dataDir)
	if err != nil {
		return 1
	}
	logger := desktopHelperLogger()
	// A scheduled task opens a console window for a console program: give it back at once.
	// Programs the helper starts get hidden windows of their own (startPiped's HideWindow).
	freeConsole()
	logger.Printf("desktop-session helper %s started (pid %d)", version, os.Getpid())
	attempt := 0
	for {
		conn, err := dialDesktopPipe(dir)
		if err == nil {
			attempt = 0
			err = runDeskHelperSession(conn, version, startProcess, os.Environ)
			if errors.Is(err, errDeskHelperExit) {
				logger.Printf("%v", err)
				return 3
			}
		}
		if err != nil {
			logger.Printf("desktop pipe: %v", err)
		}
		attempt++
		time.Sleep(backoff(attempt))
	}
}

// desktopHelperLogger writes to %LOCALAPPDATA%\Orquester\desktop-helper.log (truncated past 1 MB).
func desktopHelperLogger() *log.Logger {
	base := os.Getenv("LOCALAPPDATA")
	if base == "" {
		return log.New(io.Discard, "", 0)
	}
	dir := filepath.Join(base, "Orquester")
	if os.MkdirAll(dir, 0o700) != nil {
		return log.New(io.Discard, "", 0)
	}
	path := filepath.Join(dir, "desktop-helper.log")
	flags := os.O_CREATE | os.O_WRONLY | os.O_APPEND
	if info, err := os.Stat(path); err == nil && info.Size() > 1<<20 {
		flags |= os.O_TRUNC
	}
	f, err := os.OpenFile(path, flags, 0o600)
	if err != nil {
		return log.New(io.Discard, "", 0)
	}
	return log.New(f, "orq-agent desktop-helper ", log.LstdFlags)
}

var procFreeConsole = windows.NewLazySystemDLL("kernel32.dll").NewProc("FreeConsole")

func freeConsole() { _, _, _ = procFreeConsole.Call() }

// InstallDesktopHelperCommand is `orq-agent install-desktop-helper --user NAME`: it registers the
// helper's logon task for that user, records the user for the service (desktop-helper.json) and
// starts the task now (it runs only while the user is signed in). Run it as an administrator,
// before install-service: the service reads desktop-helper.json when it starts.
func InstallDesktopHelperCommand(opts DesktopHelperOptions, out io.Writer) error {
	dataDir, err := desktopDataDir(opts.DataDir)
	if err != nil {
		return err
	}
	if opts.User == "" {
		return errors.New("--user is required (the desktop user, name or DOMAIN\\name)")
	}
	sid, _, accType, err := windows.LookupSID("", opts.User)
	if err != nil {
		return fmt.Errorf("no account %q on this machine: %w", opts.User, err)
	}
	if accType != windows.SidTypeUser {
		return fmt.Errorf("%q is not a user account", opts.User)
	}
	account, domain, _, err := sid.LookupAccount("")
	if err != nil {
		return fmt.Errorf("could not resolve %q: %w", opts.User, err)
	}
	user := account
	if domain != "" {
		user = domain + `\` + account
	}
	exe, err := executablePath()
	if err != nil {
		return err
	}
	task, err := renderDesktopTask(desktopTaskData{User: user, Exe: exe, DataDir: dataDir})
	if err != nil {
		return err
	}
	marker := desktopMarker{User: user, SID: sid.String()}
	if !userSIDPattern.MatchString(marker.SID) {
		return fmt.Errorf("%s (%s) is not a user account Orquester can run the helper as", user, marker.SID)
	}
	if opts.DryRun {
		fmt.Fprintln(out, "# orq-agent install-desktop-helper --dry-run: nothing is written or run.")
		fmt.Fprintf(out, "run: schtasks /Create /TN %s /XML <task.xml> /F\n", windowsArg(desktopTaskName))
		fmt.Fprintf(out, "----- begin task.xml -----\n%s----- end task.xml -----\n", task)
		fmt.Fprintf(out, "write %s: user %s (%s)\n", filepath.Join(dataDir, desktopMarkerFile), marker.User, marker.SID)
		fmt.Fprintf(out, "run: schtasks /Run /TN %s  (failure ignored: it starts at %s's next sign-in)\n", windowsArg(desktopTaskName), user)
		return nil
	}
	if !windows.GetCurrentProcessToken().IsElevated() {
		return errors.New("registering the desktop-session helper needs an administrator: run it from an elevated PowerShell")
	}
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		return err
	}
	xmlPath := filepath.Join(dataDir, "desktop-helper-task.xml")
	if err := writeFileAtomic(xmlPath, utf16File(task), 0o600); err != nil {
		return err
	}
	defer os.Remove(xmlPath)
	if err := runCommand([]string{"schtasks.exe", "/Create", "/TN", desktopTaskName, "/XML", xmlPath, "/F"}); err != nil {
		return fmt.Errorf("registering the scheduled task %q failed: %w", desktopTaskName, err)
	}
	if err := writeDesktopMarker(dataDir, marker); err != nil {
		return err
	}
	fmt.Fprintf(out, "registered the scheduled task %q: the desktop-session helper runs while %s is signed in\n", desktopTaskName, user)
	if err := runHidden("schtasks.exe", "/Run", "/TN", desktopTaskName); err != nil {
		fmt.Fprintf(out, "note: %s is not signed in now; the helper starts at the next sign-in\n", user)
	}
	return nil
}

// UninstallDesktopHelperCommand is `orq-agent uninstall-desktop-helper`.
func UninstallDesktopHelperCommand(opts DesktopHelperOptions, out io.Writer) error {
	dataDir, err := desktopDataDir(opts.DataDir)
	if err != nil {
		return err
	}
	if opts.DryRun {
		fmt.Fprintln(out, "# orq-agent uninstall-desktop-helper --dry-run: nothing is removed or run.")
		fmt.Fprintf(out, "run: schtasks /End /TN %s  (failure ignored)\n", windowsArg(desktopTaskName))
		fmt.Fprintf(out, "run: schtasks /Delete /TN %s /F  (when it exists)\n", windowsArg(desktopTaskName))
		fmt.Fprintf(out, "rm %s\n", filepath.Join(dataDir, desktopMarkerFile))
		return nil
	}
	return removeDesktopHelper(dataDir, func(format string, args ...any) { fmt.Fprintf(out, format+"\n", args...) })
}

// removeDesktopHelper ends and deletes the helper's task and removes desktop-helper.json; none
// installed is not an error.
func removeDesktopHelper(dataDir string, logf func(string, ...any)) error {
	var errs []error
	if runHidden("schtasks.exe", "/Query", "/TN", desktopTaskName) == nil {
		_ = runHidden("schtasks.exe", "/End", "/TN", desktopTaskName)
		if err := runCommand([]string{"schtasks.exe", "/Delete", "/TN", desktopTaskName, "/F"}); err != nil {
			errs = append(errs, fmt.Errorf("deleting the scheduled task %q: %w", desktopTaskName, err))
		} else {
			logf("removed the scheduled task %q", desktopTaskName)
		}
	}
	if err := os.Remove(filepath.Join(dataDir, desktopMarkerFile)); err != nil && !errors.Is(err, os.ErrNotExist) {
		errs = append(errs, err)
	}
	return errors.Join(errs...)
}
