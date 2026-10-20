//go:build windows

package agent

import (
	"context"
	"strconv"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"

	"orquester/box-agent/internal/wire"
)

func detectLibc() *string { return nil }

func osRelease() string {
	key, err := registry.OpenKey(registry.LOCAL_MACHINE, `SOFTWARE\Microsoft\Windows NT\CurrentVersion`, registry.QUERY_VALUE)
	if err != nil {
		return "Windows"
	}
	defer key.Close()
	name, _, err := key.GetStringValue("ProductName")
	if err != nil || name == "" {
		return "Windows"
	}
	if display, _, err := key.GetStringValue("DisplayVersion"); err == nil && display != "" {
		return name + " " + display
	}
	return name
}

// memoryStatusEx mirrors MEMORYSTATUSEX.
type memoryStatusEx struct {
	Length               uint32
	MemoryLoad           uint32
	TotalPhys            uint64
	AvailPhys            uint64
	TotalPageFile        uint64
	AvailPageFile        uint64
	TotalVirtual         uint64
	AvailVirtual         uint64
	AvailExtendedVirtual uint64
}

var (
	kernel32                 = windows.NewLazySystemDLL("kernel32.dll")
	procGlobalMemoryStatusEx = kernel32.NewProc("GlobalMemoryStatusEx")
	procGetSystemTimes       = kernel32.NewProc("GetSystemTimes")
	procGetTickCount64       = kernel32.NewProc("GetTickCount64")
)

func memoryStatus() (memoryStatusEx, bool) {
	status := memoryStatusEx{Length: uint32(unsafe.Sizeof(memoryStatusEx{}))}
	r, _, _ := procGlobalMemoryStatusEx.Call(uintptr(unsafe.Pointer(&status)))
	return status, r != 0
}

func totalMemory() int64 {
	status, ok := memoryStatus()
	if !ok {
		return 0
	}
	return int64(status.TotalPhys)
}

// isElevated: the process token is elevated (Administrator).
func isElevated() bool {
	return windows.GetCurrentProcessToken().IsElevated()
}

func detectContainer() bool { return false }

func osGPUs() []string {
	for _, path := range []string{`C:\Windows\System32\nvidia-smi.exe`, `C:\Program Files\NVIDIA Corporation\NVSMI\nvidia-smi.exe`} {
		if out, ok := probe(path, "--query-gpu=name", "--format=csv,noheader"); ok {
			var gpus []string
			for _, line := range strings.Split(out, "\n") {
				if name := strings.TrimSpace(line); name != "" {
					gpus = append(gpus, name)
				}
			}
			return gpus
		}
	}
	return nil
}

type cpuSample struct {
	idle, total uint64
}

func readCPU() (cpuSample, bool) {
	var idle, kernel, user windows.Filetime
	r, _, _ := procGetSystemTimes.Call(uintptr(unsafe.Pointer(&idle)), uintptr(unsafe.Pointer(&kernel)), uintptr(unsafe.Pointer(&user)))
	if r == 0 {
		return cpuSample{}, false
	}
	toU := func(ft windows.Filetime) uint64 { return uint64(ft.HighDateTime)<<32 | uint64(ft.LowDateTime) }
	// Kernel time includes idle time.
	return cpuSample{idle: toU(idle), total: toU(kernel) + toU(user)}, true
}

func (a *Agent) stats(context.Context) (wire.Stats, error) {
	var out wire.Stats
	if sample, ok := readCPU(); ok {
		a.sysMu.Lock()
		prev := a.statsPrev
		a.statsPrev = sample
		a.sysMu.Unlock()
		if dt := sample.total - prev.total; dt > 0 {
			out.CPUPercent = float64(dt-(sample.idle-prev.idle)) / float64(dt) * 100
		}
	}
	if status, ok := memoryStatus(); ok {
		out.MemTotalBytes = int64(status.TotalPhys)
		out.MemUsedBytes = int64(status.TotalPhys - status.AvailPhys)
	}
	out.DiskUsedBytes, out.DiskTotalBytes = diskUsage(a.diskPath())
	if r, _, _ := procGetTickCount64.Call(); r != 0 {
		out.UptimeSeconds = float64(r) / 1000
	}
	return out, nil
}

func diskUsage(path string) (used, total int64) {
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return 0, 0
	}
	var free, size, totalFree uint64
	if err := windows.GetDiskFreeSpaceEx(p, &free, &size, &totalFree); err != nil {
		return 0, 0
	}
	return int64(size - totalFree), int64(size)
}

// diskPath: the drive the mapped project paths live on (C:\orq).
func (a *Agent) diskPath() string { return `C:\` }

// listeningPorts from `netstat -ano -p TCP` (and TCPv6); process names are not resolved.
func listeningPorts(context.Context) ([]wire.ListeningPort, error) {
	out := []wire.ListeningPort{}
	seen := map[string]bool{}
	for _, proto := range []string{"TCP", "TCPv6"} {
		text, ok := probe("netstat.exe", "-ano", "-p", proto)
		if !ok {
			continue
		}
		for _, line := range strings.Split(text, "\n") {
			fields := strings.Fields(line)
			if len(fields) < 5 || !strings.EqualFold(fields[0], "TCP") || fields[3] != "LISTENING" {
				continue
			}
			local := fields[1]
			idx := strings.LastIndex(local, ":")
			if idx < 0 {
				continue
			}
			host := strings.Trim(local[:idx], "[]")
			port, err := strconv.Atoi(local[idx+1:])
			if err != nil {
				continue
			}
			key := host + ":" + strconv.Itoa(port)
			if seen[key] {
				continue
			}
			seen[key] = true
			item := wire.ListeningPort{Port: port, Address: host}
			if pid, err := strconv.Atoi(fields[4]); err == nil {
				item.PID = &pid
			}
			out = append(out, item)
		}
	}
	return out, nil
}
