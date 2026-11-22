//go:build windows

package agent

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
)

const windowsServiceName = "OrqAgent"

// detectServiceManager: the service control manager needs no detection.
func detectServiceManager(*serviceFacts) {}

// startDetached is unused on Windows: install-service always registers a service.
func startDetached([]string, string) error {
	return errors.New("background start is not used on Windows")
}

// installWindowsService registers orq-agent as an automatic Windows service
// (LocalSystem) that restarts on failure, and starts it. install-service has
// written agent.env already.
func installWindowsService(cfg Config) error {
	exe, err := executablePath()
	if err != nil {
		return err
	}
	m, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("connecting to the service manager: %w", err)
	}
	defer m.Disconnect()
	s, err := m.OpenService(windowsServiceName)
	if err == nil {
		// Reinstall: stop and replace the old registration.
		_, _ = s.Control(svc.Stop)
		deadline := time.Now().Add(30 * time.Second)
		for time.Now().Before(deadline) {
			status, err := s.Query()
			if err != nil || status.State == svc.Stopped {
				break
			}
			time.Sleep(500 * time.Millisecond)
		}
		if err := s.Delete(); err != nil {
			s.Close()
			return fmt.Errorf("removing the old service: %w", err)
		}
		s.Close()
	}
	s, err = m.CreateService(windowsServiceName, exe, mgr.Config{
		DisplayName:  "Orquester box agent",
		Description:  "Connects this machine to the Orquester daemon (orq-agent).",
		StartType:    mgr.StartAutomatic,
		ErrorControl: mgr.ErrorNormal,
	}, "service", "--data-dir", cfg.DataDir)
	if err != nil {
		return fmt.Errorf("creating the service: %w", err)
	}
	defer s.Close()
	// Any non-zero exit (crash, or an update asking for a restart) restarts it.
	if err := s.SetRecoveryActions([]mgr.RecoveryAction{
		{Type: mgr.ServiceRestart, Delay: 2 * time.Second},
		{Type: mgr.ServiceRestart, Delay: 5 * time.Second},
		{Type: mgr.ServiceRestart, Delay: 10 * time.Second},
	}, 86400); err != nil {
		return fmt.Errorf("setting recovery actions: %w", err)
	}
	if err := s.SetRecoveryActionsOnNonCrashFailures(true); err != nil {
		return fmt.Errorf("setting recovery actions: %w", err)
	}
	return s.Start()
}

// uninstallWindowsService removes the desktop-session helper's task (desktop_windows.go), then
// deletes and stops the service; none installed is not an error.
func uninstallWindowsService(dataDir string) error {
	helperErr := removeDesktopHelper(dataDir, func(string, ...any) {})
	if err := deleteWindowsService(); err != nil {
		return errors.Join(helperErr, err)
	}
	return helperErr
}

// removeDataDirAfterExit deletes the data dir, orq-agent.exe in it, once this process exited (a
// running executable cannot be deleted): a hidden PowerShell waits for this pid, then removes the
// directory, and its parent when that is left empty (C:\orq). Only a data dir holding this very
// executable is removed (the layout the pairing bootstrap installs).
func removeDataDirAfterExit(dataDir string) error {
	exe, err := executablePath()
	if err != nil {
		return err
	}
	dir, err := filepath.Abs(dataDir)
	if err != nil {
		return err
	}
	if !strings.EqualFold(filepath.Dir(exe), dir) || filepath.Dir(dir) == dir {
		return nil
	}
	quote := func(s string) string { return "'" + strings.ReplaceAll(s, "'", "''") + "'" }
	script := fmt.Sprintf(`& { $d = %s; Wait-Process -Id %d -Timeout 120 -ErrorAction SilentlyContinue; `+
		`for ($i = 0; $i -lt 10 -and (Test-Path -LiteralPath $d); $i++) { Remove-Item -LiteralPath $d -Recurse -Force -ErrorAction SilentlyContinue; if (Test-Path -LiteralPath $d) { Start-Sleep -Seconds 2 } }; `+
		`$p = Split-Path -Parent $d; if ($p -and -not (Get-ChildItem -LiteralPath $p -Force -ErrorAction SilentlyContinue)) { Remove-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue } }`,
		quote(dir), os.Getpid())
	cmd := exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script)
	cmd.SysProcAttr = &syscall.SysProcAttr{
		HideWindow:    true,
		CreationFlags: windows.CREATE_NEW_PROCESS_GROUP | windows.DETACHED_PROCESS,
	}
	return cmd.Start()
}

// deleteWindowsService deletes and stops the service; none installed is not an error.
func deleteWindowsService() error {
	m, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("connecting to the service manager: %w", err)
	}
	defer m.Disconnect()
	s, err := m.OpenService(windowsServiceName)
	if errors.Is(err, windows.ERROR_SERVICE_DOES_NOT_EXIST) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("opening the service: %w", err)
	}
	defer s.Close()
	// Delete first: the service goes once stopped, and stopping it may end this very process.
	if err := s.Delete(); err != nil && !errors.Is(err, windows.ERROR_SERVICE_MARKED_FOR_DELETE) {
		return fmt.Errorf("deleting the service: %w", err)
	}
	_, _ = s.Control(svc.Stop)
	return nil
}

type serviceHandler struct {
	run  func() int
	code int
}

func (h *serviceHandler) Execute(_ []string, requests <-chan svc.ChangeRequest, status chan<- svc.Status) (bool, uint32) {
	status <- svc.Status{State: svc.StartPending}
	done := make(chan int, 1)
	go func() { done <- h.run() }()
	status <- svc.Status{State: svc.Running, Accepts: svc.AcceptStop | svc.AcceptShutdown}
	for {
		select {
		case code := <-done:
			h.code = code
			status <- svc.Status{State: svc.StopPending}
			// A non-zero service exit code makes the recovery actions restart us.
			return code != 0, uint32(code)
		case req := <-requests:
			switch req.Cmd {
			case svc.Interrogate:
				status <- req.CurrentStatus
			case svc.Stop, svc.Shutdown:
				status <- svc.Status{State: svc.StopPending}
				serviceStop()
			}
		}
	}
}

// serviceStop is set by main to stop the running agent.
var serviceStop = func() {}

// SetServiceStop installs the function a service stop request calls.
func SetServiceStop(stop func()) { serviceStop = stop }

// RunService runs `run` under the service control manager. ok is false when
// the process was not started by the SCM.
func RunService(run func() int) (bool, error) {
	isService, err := svc.IsWindowsService()
	if err != nil || !isService {
		return false, err
	}
	return true, svc.Run(windowsServiceName, &serviceHandler{run: run})
}

// ProtectService is only meaningful on Linux.
func ProtectService() error { return nil }
