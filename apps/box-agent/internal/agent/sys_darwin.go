//go:build darwin

package agent

import (
	"context"
	"net"
	"os"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"

	"golang.org/x/sys/unix"

	"orquester/box-agent/internal/wire"
)

func detectLibc() *string { return nil }

func osRelease() string {
	if out, ok := probe("sw_vers", "-productVersion"); ok {
		return "macOS " + strings.TrimSpace(out)
	}
	return "macOS"
}

func totalMemory() int64 {
	n, err := unix.SysctlUint64("hw.memsize")
	if err != nil {
		return 0
	}
	return int64(n)
}

func isElevated() bool { return os.Geteuid() == 0 }

func detectContainer() bool { return false }

func osGPUs() []string {
	out, ok := probe("system_profiler", "SPDisplaysDataType")
	if !ok {
		return nil
	}
	var gpus []string
	for _, line := range strings.Split(out, "\n") {
		if model, ok := strings.CutPrefix(strings.TrimSpace(line), "Chipset Model:"); ok {
			gpus = append(gpus, strings.TrimSpace(model))
		}
	}
	return gpus
}

type cpuSample struct{}

var vmStatLine = regexp.MustCompile(`^(.+):\s+(\d+)\.?$`)
var vmPageSize = regexp.MustCompile(`page size of (\d+) bytes`)

func (a *Agent) stats(context.Context) (wire.Stats, error) {
	var out wire.Stats
	// No cgo for host_processor_info: sum per-process %CPU over the cores.
	if text, ok := probe("ps", "-A", "-o", "%cpu="); ok {
		var sum float64
		for _, line := range strings.Split(text, "\n") {
			if v, err := strconv.ParseFloat(strings.TrimSpace(line), 64); err == nil {
				sum += v
			}
		}
		out.CPUPercent = min(sum/float64(runtime.NumCPU()), 100)
	}
	out.MemTotalBytes = totalMemory()
	if text, ok := probe("vm_stat"); ok {
		pageSize := int64(4096)
		if m := vmPageSize.FindStringSubmatch(text); m != nil {
			pageSize, _ = strconv.ParseInt(m[1], 10, 64)
		}
		pages := map[string]int64{}
		for _, line := range strings.Split(text, "\n") {
			if m := vmStatLine.FindStringSubmatch(strings.TrimSpace(line)); m != nil {
				n, _ := strconv.ParseInt(m[2], 10, 64)
				pages[m[1]] = n
			}
		}
		out.MemUsedBytes = (pages["Pages active"] + pages["Pages wired down"] + pages["Pages occupied by compressor"]) * pageSize
	}
	out.DiskUsedBytes, out.DiskTotalBytes = diskUsage(a.diskPath())
	if tv, err := unix.SysctlTimeval("kern.boottime"); err == nil {
		boot := time.Unix(tv.Sec, int64(tv.Usec)*1000)
		out.UptimeSeconds = time.Since(boot).Seconds()
	}
	return out, nil
}

// listeningPorts from `lsof -F` (p = pid, c = command, n = address:port).
func listeningPorts(context.Context) ([]wire.ListeningPort, error) {
	text, _ := probe("lsof", "-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pcn")
	var out []wire.ListeningPort
	seen := map[string]bool{}
	var pid *int
	var command *string
	for _, line := range strings.Split(text, "\n") {
		if line == "" {
			continue
		}
		value := line[1:]
		switch line[0] {
		case 'p':
			n, err := strconv.Atoi(value)
			if err == nil {
				pid = &n
			}
			command = nil
		case 'c':
			c := value
			command = &c
		case 'n':
			host, portText, err := net.SplitHostPort(value)
			if err != nil {
				continue
			}
			port, err := strconv.Atoi(portText)
			if err != nil {
				continue
			}
			if host == "*" {
				host = "0.0.0.0"
			}
			key := host + ":" + portText
			if seen[key] {
				continue
			}
			seen[key] = true
			out = append(out, wire.ListeningPort{Port: port, Address: host, PID: pid, Command: command})
		}
	}
	if out == nil {
		out = []wire.ListeningPort{}
	}
	return out, nil
}
