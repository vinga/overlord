//go:build windows

package main

import (
	"os/exec"
	"syscall"
)

const createNewProcessGroup = 0x00000200
const detachedProcess = 0x00000008

func detach(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: detachedProcess | createNewProcessGroup}
}

func ownGroup(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: createNewProcessGroup}
}

func killGroup(cmd *exec.Cmd, force bool) {
	if cmd.Process == nil {
		return
	}
	_ = cmd.Process.Kill()
}
