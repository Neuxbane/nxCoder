package workspace

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPathsAndSandbox(t *testing.T) {
	tempDir, err := os.MkdirTemp("", "nxcoder_test_*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tempDir)

	wsID := "test_ws"
	sessID := "test_sess"
	paths := GetWorkspacePaths(tempDir, wsID, sessID)

	if paths.SessionFolder == "" || paths.SessionMirrorRoot == "" {
		t.Fatalf("expected non-empty session paths, got %+v", paths)
	}

	repos := []GitRepo{
		{
			RealPath:   filepath.Join(tempDir, "project1"),
			FolderName: "project1",
		},
	}
	_ = os.MkdirAll(repos[0].RealPath, 0755)

	// Test sandbox relative path
	resolved, err := ValidateAndResolvePath(tempDir, wsID, sessID, "uploads/test.txt", repos)
	if err != nil {
		t.Fatalf("unexpected error resolving sandbox path: %v", err)
	}
	if !strings.Contains(resolved, "uploads") {
		t.Fatalf("expected path inside uploads, got %s", resolved)
	}

	// Test workspace mirror resolution
	resolvedMirror, err := ValidateAndResolvePath(tempDir, wsID, sessID, "workspace_mirror/project1/src/main.go", repos)
	if err != nil {
		t.Fatalf("unexpected error resolving mirror path: %v", err)
	}
	if !strings.HasPrefix(resolvedMirror, repos[0].RealPath) {
		t.Fatalf("expected path inside real repo %s, got %s", repos[0].RealPath, resolvedMirror)
	}

	// Test escape traversal rejection
	_, err = ValidateAndResolvePath(tempDir, wsID, sessID, "../../../etc/passwd", repos)
	if err == nil {
		t.Fatalf("expected path traversal error, but got nil")
	}
}
