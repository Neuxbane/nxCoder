package tools

import (
	"os"
	"strings"
	"testing"

	"github.com/neuxbane/nxcoder/backend/pkg/workspace"
)

func TestFilesystemTools(t *testing.T) {
	tempDir, err := os.MkdirTemp("", "nxcoder_fs_test_*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tempDir)

	wsID := "test_ws"
	sessID := "test_sess"
	repos := []workspace.GitRepo{}

	// Test WriteFile
	testPath := "uploads/hello.txt"
	testContent := "line 1\nline 2\nline 3\nline 4\nline 5\n"
	err = WriteFile(tempDir, wsID, sessID, testPath, testContent, repos)
	if err != nil {
		t.Fatalf("failed to write file: %v", err)
	}

	// Test ReadFile
	readRes, err := ReadFile(tempDir, wsID, sessID, testPath, 2, 4, repos)
	if err != nil {
		t.Fatalf("failed to read file: %v", err)
	}
	if readRes.StartLine != 2 || readRes.EndLine != 4 {
		t.Fatalf("expected lines 2..4, got %d..%d", readRes.StartLine, readRes.EndLine)
	}
	if !strings.Contains(readRes.Content, "line 2") || !strings.Contains(readRes.Content, "line 4") {
		t.Fatalf("unexpected content: %s", readRes.Content)
	}

	// Test EditFile
	editRes, err := EditFile(tempDir, wsID, sessID, testPath, "line 3", "line THREE modified", 1, repos)
	if err != nil {
		t.Fatalf("failed to edit file: %v", err)
	}
	if !editRes.Success {
		t.Fatalf("expected edit success, got false")
	}

	// Verify edited content
	readRes2, _ := ReadFile(tempDir, wsID, sessID, testPath, 1, 10, repos)
	if !strings.Contains(readRes2.Content, "line THREE modified") {
		t.Fatalf("content was not patched properly: %s", readRes2.Content)
	}

	// Test ListDir
	listRes, err := ListDir(tempDir, wsID, sessID, "uploads", repos)
	if err != nil {
		t.Fatalf("failed to list dir: %v", err)
	}
	found := false
	for _, item := range listRes {
		if item.Name == "hello.txt" && item.Type == "file" {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("expected hello.txt in ListDir result, got %+v", listRes)
	}

	// Test RegexSearch
	grepRes, err := RegexSearch(tempDir, wsID, sessID, "THREE", []string{"uploads"}, true, true, nil, repos)
	if err != nil {
		t.Fatalf("failed regex search: %v", err)
	}
	if len(grepRes) == 0 {
		t.Fatalf("expected regex matches, got 0")
	}
}

func TestTruncateOutput(t *testing.T) {
	short := "Hello World"
	if TruncateOutput(short, 100) != short {
		t.Fatalf("short string was modified")
	}

	long := strings.Repeat("A", 1000)
	truncated := TruncateOutput(long, 100)
	if len(truncated) >= 1000 {
		t.Fatalf("long string was not truncated")
	}
}
