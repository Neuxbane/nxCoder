//go:build windows

package tools

import (
	"os/exec"
)

func setProcessGroup(cmd *exec.Cmd) {
	// Windows handles process management differently; Setpgid is not used.
}

func killProcessGroup(cmd *exec.Cmd) {
	if cmd != nil && cmd.Process != nil {
		_ = cmd.Process.Kill()
	}
}

func terminateProcessGracefully(cmd *exec.Cmd) {
	if cmd != nil && cmd.Process != nil {
		_ = cmd.Process.Kill()
	}
}
