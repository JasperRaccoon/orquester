package agent

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"strings"
	"testing"
	"unsafe"

	"golang.org/x/sys/windows"
)

// createPipeInstance creates a server instance of the pipe `name` (the first when sddl is set).
func createPipeInstance(name, sddl string) (windows.Handle, error) {
	path, err := windows.UTF16PtrFromString(name)
	if err != nil {
		return 0, err
	}
	flags := uint32(windows.PIPE_ACCESS_DUPLEX)
	var sa *windows.SecurityAttributes
	if sddl != "" {
		sd, err := windows.SecurityDescriptorFromString(sddl)
		if err != nil {
			return 0, err
		}
		flags |= windows.FILE_FLAG_FIRST_PIPE_INSTANCE
		sa = &windows.SecurityAttributes{SecurityDescriptor: sd}
		sa.Length = uint32(unsafe.Sizeof(*sa))
	}
	return windows.CreateNamedPipe(path, flags, windows.PIPE_TYPE_BYTE|windows.PIPE_WAIT|windows.PIPE_REJECT_REMOTE_CLIENTS,
		windows.PIPE_UNLIMITED_INSTANCES, 4096, 4096, 0, sa)
}

func TestDesktopPipeLetsTheUserDialButNotServeIt(t *testing.T) {
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		t.Fatal(err)
	}
	sid := user.User.Sid.String()
	sddl, err := desktopPipeSecurity(sid)
	if err != nil {
		t.Skipf("not run by a user account (%s): %v", sid, err)
	}
	// Owner LocalSystem needs SeRestorePrivilege: owned by this user, the pipe gives it the same
	// access (an owner gains only READ_CONTROL and WRITE_DAC), and the helper must refuse it.
	owned := strings.Replace(sddl, "O:SY", "O:"+sid, 1)
	suffix := make([]byte, 6)
	_, _ = rand.Read(suffix)
	name := `\\.\pipe\orq-test-desktop-` + hex.EncodeToString(suffix)
	service, err := createPipeInstance(name, owned)
	if err != nil {
		t.Fatal(err)
	}
	connected := make(chan struct{})
	go func() {
		_ = windows.ConnectNamedPipe(service, nil)
		close(connected)
	}()
	t.Cleanup(func() {
		select {
		case <-connected:
		default:
			// Release the pending ConnectNamedPipe.
			path, _ := windows.UTF16PtrFromString(name)
			if client, err := windows.CreateFile(path, windows.GENERIC_READ, 0, nil, windows.OPEN_EXISTING, 0, 0); err == nil {
				_ = windows.CloseHandle(client)
				<-connected
			}
		}
		_ = windows.CloseHandle(service)
	})

	// The desktop user's process (unelevated, too) must not be able to stand in for the service.
	if rogue, err := createPipeInstance(name, ""); err == nil {
		_ = windows.CloseHandle(rogue)
		t.Fatal("the desktop user added a server instance of the service's pipe")
	} else if !errors.Is(err, windows.ERROR_ACCESS_DENIED) {
		t.Fatalf("adding an instance: %v, want access denied", err)
	}

	// The helper's dial gets through the pipe's DACL, then refuses an owner other than LocalSystem.
	conn, err := dialDesktopPipe(name)
	if err == nil {
		conn.Close()
		t.Fatal("the helper accepted a pipe the user owns")
	}
	if !strings.Contains(err.Error(), "LocalSystem") {
		t.Fatalf("dial: %v, want the owner refused", err)
	}
}
