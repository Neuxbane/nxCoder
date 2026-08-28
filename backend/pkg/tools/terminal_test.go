package tools

import (
	"os"
	"strings"
	"testing"

	"github.com/neuxbane/nxcoder/backend/pkg/workspace"
)

func TestTerminalManagerFastPath(t *testing.T) {
	tempDir, err := os.MkdirTemp("", "nxcoder_term_test_*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tempDir)

	tm := NewTerminalManager()
	res, err := tm.ExecuteCommand(tempDir, "test_ws", "test_sess", "echo 'nxCoder Go Engine'", ".", "test_echo", []workspace.GitRepo{})
	if err != nil {
		t.Fatalf("command execution error: %v", err)
	}

	if !res.Success {
		t.Fatalf("expected command success, got false (err: %s)", res.Error)
	}
	if !strings.Contains(res.Output, "nxCoder Go Engine") {
		t.Fatalf("expected output 'nxCoder Go Engine', got '%s'", res.Output)
	}
}
