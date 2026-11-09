//go:build !windows

package main

import (
	"os/exec"
	"syscall"
)

// detach starts cmd in its own session, so it survives this process and the
// terminal that started it.
func detach(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
}

// ownGroup puts cmd in a fresh process group so killGroup reaches the helper
// processes the real server starts (chrome-devtools-mcp runs a watchdog).
func ownGroup(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

func killGroup(cmd *exec.Cmd, force bool) {
	if cmd.Process == nil {
		return
	}
	sig := syscall.SIGTERM
	if force {
		sig = syscall.SIGKILL
	}
	_ = syscall.Kill(-cmd.Process.Pid, sig)
}
