//go:build !linux && !windows

package agent

// nativeWatch: macOS FSEvents needs cgo, which the cross-compiled build does
// not use, so macOS boxes poll.
func nativeWatch(*watch) error { return errNativeUnavailable }
