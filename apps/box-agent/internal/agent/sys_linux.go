//go:build linux

package agent

import (
	"bufio"
	"context"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"golang.org/x/sys/unix"

	"orquester/box-agent/internal/wire"
)

func detectLibc() *string {
	glibc, musl := "glibc", "musl"
	if matches, _ := filepath.Glob("/lib/ld-musl-*.so.1"); len(matches) > 0 {
		return &musl
	}
	for _, pattern := range []string{"/lib*/ld-linux*.so*", "/lib/*/ld-linux*.so*", "/lib*/libc.so.6", "/lib/*/libc.so.6", "/usr/lib*/libc.so.6", "/usr/lib/*/libc.so.6"} {
		if matches, _ := filepath.Glob(pattern); len(matches) > 0 {
			return &glibc
		}
	}
	if out, _ := probe("ldd", "--version"); out != "" {
		lower := strings.ToLower(out)
		if strings.Contains(lower, "musl") {
			return &musl
		}
		if strings.Contains(lower, "glibc") || strings.Contains(lower, "gnu libc") {
			return &glibc
		}
	}
	return nil
}

func osRelease() string {
	data, err := os.ReadFile("/etc/os-release")
	if err != nil {
		data, err = os.ReadFile("/usr/lib/os-release")
	}
	if err == nil {
		values := readEnvLines(string(data))
		if name := values["PRETTY_NAME"]; name != "" {
			return name
		}
		if name := strings.TrimSpace(values["NAME"] + " " + values["VERSION"]); name != "" {
			return name
		}
	}
	var uts unix.Utsname
	if unix.Uname(&uts) == nil {
		return "Linux " + unix.ByteSliceToString(uts.Release[:])
	}
	return "Linux"
}

// readEnvLines parses KEY=VALUE lines with optional quotes (os-release).
func readEnvLines(text string) map[string]string {
	out := map[string]string{}
	for _, line := range strings.Split(text, "\n") {
		key, value, ok := strings.Cut(strings.TrimSpace(line), "=")
		if !ok {
			continue
		}
		out[key] = strings.Trim(value, `"'`)
	}
	return out
}

func meminfo() map[string]int64 {
	out := map[string]int64{}
	f, err := os.Open("/proc/meminfo")
	if err != nil {
		return out
	}
	defer f.Close()
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) >= 2 {
			if n, err := strconv.ParseInt(fields[1], 10, 64); err == nil {
				out[strings.TrimSuffix(fields[0], ":")] = n * 1024
			}
		}
	}
	return out
}

func totalMemory() int64 { return meminfo()["MemTotal"] }

func isElevated() bool { return os.Geteuid() == 0 }

func detectContainer() bool {
	for _, marker := range []string{"/.dockerenv", "/run/.containerenv"} {
		if pathExists(marker) {
			return true
		}
	}
	if os.Getenv("container") != "" {
		return true
	}
	if data, err := os.ReadFile("/proc/1/cgroup"); err == nil {
		text := string(data)
		for _, marker := range []string{"docker", "kubepods", "containerd", "lxc", "libpod"} {
			if strings.Contains(text, marker) {
				return true
			}
		}
	}
	return false
}

// osGPUs reads the NVIDIA driver's proc entries when nvidia-smi is missing.
func osGPUs() []string {
	var gpus []string
	matches, _ := filepath.Glob("/proc/driver/nvidia/gpus/*/information")
	for _, path := range matches {
		data, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		for _, line := range strings.Split(string(data), "\n") {
			if model, ok := strings.CutPrefix(line, "Model:"); ok {
				gpus = append(gpus, strings.TrimSpace(model))
			}
		}
	}
	return gpus
}

type cpuSample struct {
	busy, total uint64
}

func readCPU() (cpuSample, bool) {
	data, err := os.ReadFile("/proc/stat")
	if err != nil {
		return cpuSample{}, false
	}
	line, _, _ := strings.Cut(string(data), "\n")
	fields := strings.Fields(line)
	if len(fields) < 5 || fields[0] != "cpu" {
		return cpuSample{}, false
	}
	var s cpuSample
	for i, field := range fields[1:] {
		n, _ := strconv.ParseUint(field, 10, 64)
		s.total += n
		// idle (3) and iowait (4) are not busy time.
		if i != 3 && i != 4 {
			s.busy += n
		}
	}
	return s, true
}

// stats: CPU% since the previous sys.stats call (since boot on the first).
func (a *Agent) stats(context.Context) (wire.Stats, error) {
	var out wire.Stats
	if sample, ok := readCPU(); ok {
		a.sysMu.Lock()
		prev := a.statsPrev
		a.statsPrev = sample
		a.sysMu.Unlock()
		if dt := sample.total - prev.total; dt > 0 {
			out.CPUPercent = float64(sample.busy-prev.busy) / float64(dt) * 100
		}
	}
	mem := meminfo()
	out.MemTotalBytes = mem["MemTotal"]
	if available, ok := mem["MemAvailable"]; ok {
		out.MemUsedBytes = out.MemTotalBytes - available
	} else {
		out.MemUsedBytes = out.MemTotalBytes - mem["MemFree"] - mem["Buffers"] - mem["Cached"]
	}
	out.DiskUsedBytes, out.DiskTotalBytes = diskUsage(a.diskPath())
	if data, err := os.ReadFile("/proc/uptime"); err == nil {
		if fields := strings.Fields(string(data)); len(fields) > 0 {
			out.UptimeSeconds, _ = strconv.ParseFloat(fields[0], 64)
		}
	}
	return out, nil
}

// listeningPorts parses /proc/net/tcp{,6} for LISTEN sockets and maps socket
// inodes to processes through /proc/<pid>/fd (best effort: other users'
// processes are unreadable without root).
func listeningPorts(context.Context) ([]wire.ListeningPort, error) {
	type entry struct {
		port    int
		address string
		inode   string
	}
	var entries []entry
	for _, file := range []string{"/proc/net/tcp", "/proc/net/tcp6"} {
		data, err := os.ReadFile(file)
		if err != nil {
			continue
		}
		lines := strings.Split(string(data), "\n")
		for _, line := range lines[1:] {
			fields := strings.Fields(line)
			if len(fields) < 10 || fields[3] != "0A" {
				continue
			}
			host, portHex, ok := strings.Cut(fields[1], ":")
			if !ok {
				continue
			}
			port, err := strconv.ParseUint(portHex, 16, 16)
			if err != nil {
				continue
			}
			entries = append(entries, entry{port: int(port), address: procNetAddress(host), inode: fields[9]})
		}
	}
	owners := map[string]int{}
	if len(entries) > 0 {
		procs, _ := filepath.Glob("/proc/[0-9]*/fd/*")
		for _, fd := range procs {
			target, err := os.Readlink(fd)
			if err != nil || !strings.HasPrefix(target, "socket:[") {
				continue
			}
			inode := strings.TrimSuffix(strings.TrimPrefix(target, "socket:["), "]")
			pid, err := strconv.Atoi(strings.Split(fd, "/")[2])
			if err == nil {
				owners[inode] = pid
			}
		}
	}
	out := make([]wire.ListeningPort, 0, len(entries))
	seen := map[string]bool{}
	for _, e := range entries {
		key := e.address + ":" + strconv.Itoa(e.port)
		if seen[key] {
			continue
		}
		seen[key] = true
		item := wire.ListeningPort{Port: e.port, Address: e.address}
		if pid, ok := owners[e.inode]; ok {
			p := pid
			item.PID = &p
			if comm, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/comm"); err == nil {
				name := strings.TrimSpace(string(comm))
				item.Command = &name
			}
		}
		out = append(out, item)
	}
	return out, nil
}

// procNetAddress decodes /proc/net/tcp's little-endian hex addresses.
func procNetAddress(hexAddr string) string {
	raw := make([]byte, 0, 16)
	for i := 0; i+8 <= len(hexAddr); i += 8 {
		word, err := strconv.ParseUint(hexAddr[i:i+8], 16, 32)
		if err != nil {
			return hexAddr
		}
		raw = append(raw, byte(word), byte(word>>8), byte(word>>16), byte(word>>24))
	}
	switch len(raw) {
	case 4:
		return strconv.Itoa(int(raw[0])) + "." + strconv.Itoa(int(raw[1])) + "." + strconv.Itoa(int(raw[2])) + "." + strconv.Itoa(int(raw[3]))
	case 16:
		allZero := true
		for _, b := range raw {
			if b != 0 {
				allZero = false
			}
		}
		if allZero {
			return "::"
		}
		v4mapped := true
		for _, b := range raw[:10] {
			if b != 0 {
				v4mapped = false
			}
		}
		if v4mapped && raw[10] == 0xff && raw[11] == 0xff {
			return strconv.Itoa(int(raw[12])) + "." + strconv.Itoa(int(raw[13])) + "." + strconv.Itoa(int(raw[14])) + "." + strconv.Itoa(int(raw[15]))
		}
		var parts []string
		for i := 0; i < 16; i += 2 {
			parts = append(parts, strconv.FormatUint(uint64(raw[i])<<8|uint64(raw[i+1]), 16))
		}
		return strings.Join(parts, ":")
	}
	return hexAddr
}
