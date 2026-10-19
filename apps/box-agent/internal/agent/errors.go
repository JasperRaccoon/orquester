package agent

import (
	"errors"
	"io/fs"
	"os"
	"syscall"

	"orquester/box-agent/internal/wire"
)

// toRPCError maps Go errors to protocol errors whose codes match Node's
// errno names (ENOENT, EEXIST, …), so daemon code can treat box file
// operations like local ones.
func toRPCError(err error) *wire.RPCError {
	if err == nil {
		return nil
	}
	var rpc *wire.RPCError
	if errors.As(err, &rpc) {
		return rpc
	}
	return &wire.RPCError{Code: errnoCode(err), Message: err.Error()}
}

func errnoCode(err error) string {
	switch {
	case errors.Is(err, fs.ErrNotExist):
		return "ENOENT"
	case errors.Is(err, fs.ErrExist):
		return "EEXIST"
	case errors.Is(err, fs.ErrPermission):
		return "EACCES"
	}
	var errno syscall.Errno
	if errors.As(err, &errno) {
		if name := errnoName(errno); name != "" {
			return name
		}
	}
	var pathErr *os.PathError
	if errors.As(err, &pathErr) {
		return "EIO"
	}
	return "INTERNAL"
}

func rpcErr(code, message string) *wire.RPCError {
	return &wire.RPCError{Code: code, Message: message}
}
