package agent

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"strings"
)

// pipeName is a Windows named pipe for one data dir.
func pipeName(kind, dataDir string) string {
	sum := sha256.Sum256([]byte(strings.ToLower(dataDir)))
	return `\\.\pipe\orq-agent-` + kind + "-" + hex.EncodeToString(sum[:6])
}

// renameReplacing renames over an existing file (os.Rename replaces on every OS).
func renameReplacing(from, to string) error { return os.Rename(from, to) }
