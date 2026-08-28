package workspace

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

type WorkspacePaths struct {
	WsDir                string
	SrcDir               string
	SessionsDir          string
	SessionFolder        string
	SessionMirrorRoot    string
	SessionUploadsDir    string
	SessionArtifactDir   string
	SessionScratchpadDir string
}

func GetWorkspacePaths(baseDir, workspaceID, sessionID string) WorkspacePaths {
	if baseDir == "" {
		baseDir = "."
	}
	wsDir := filepath.Join(baseDir, "workspaces", workspaceID)
	srcDir := filepath.Join(wsDir, "src")
	sessionsDir := filepath.Join(wsDir, "sessions")

	var sessionFolder, sessionMirrorRoot, sessionUploadsDir, sessionArtifactDir, sessionScratchpadDir string
	if sessionID != "" {
		sessionFolder = filepath.Join(sessionsDir, sessionID)
		sessionMirrorRoot = filepath.Join(sessionFolder, "workspace_mirror")
		sessionUploadsDir = filepath.Join(sessionFolder, "uploads")
		sessionArtifactDir = filepath.Join(sessionFolder, "artifact")
		sessionScratchpadDir = filepath.Join(sessionFolder, "scratchpad")
	}

	return WorkspacePaths{
		WsDir:                wsDir,
		SrcDir:               srcDir,
		SessionsDir:          sessionsDir,
		SessionFolder:        sessionFolder,
		SessionMirrorRoot:    sessionMirrorRoot,
		SessionUploadsDir:    sessionUploadsDir,
		SessionArtifactDir:   sessionArtifactDir,
		SessionScratchpadDir: sessionScratchpadDir,
	}
}

func ValidateAndResolvePath(baseDir, workspaceID, sessionID, targetPath string, repos []GitRepo) (string, error) {
	paths := GetWorkspacePaths(baseDir, workspaceID, sessionID)

	normPath := strings.TrimSpace(strings.ReplaceAll(targetPath, "\\", "/"))
	for strings.HasPrefix(normPath, "/") {
		normPath = normPath[1:]
	}

	// If path starts with workspace_mirror, resolve to physical folder directly
	if strings.HasPrefix(normPath, "workspace_mirror/") || normPath == "workspace_mirror" {
		parts := strings.Split(normPath, "/")
		if len(parts) > 1 {
			requestedFolder := parts[1]
			for _, r := range repos {
				if r.FolderName == requestedFolder {
					subPath := filepath.Join(parts[2:]...)
					return filepath.Join(r.RealPath, subPath), nil
				}
			}
		}
	}

	// Ensure session directories exist
	if paths.SessionFolder != "" {
		_ = os.MkdirAll(paths.SessionFolder, 0755)
		_ = os.MkdirAll(paths.SessionMirrorRoot, 0755)
		_ = os.MkdirAll(paths.SessionUploadsDir, 0755)
		_ = os.MkdirAll(paths.SessionArtifactDir, 0755)
		_ = os.MkdirAll(paths.SessionScratchpadDir, 0755)
	}

	// Reject external absolute paths from model
	if filepath.IsAbs(targetPath) {
		clean := strings.ReplaceAll(targetPath, "\\", "/")
		isSandboxRelative := strings.HasPrefix(clean, "/workspace_mirror") ||
			strings.HasPrefix(clean, "/uploads") ||
			strings.HasPrefix(clean, "/scratchpad") ||
			strings.HasPrefix(clean, "/terminals") ||
			strings.HasPrefix(clean, "/artifact")
		if !isSandboxRelative {
			return "", fmt.Errorf("Access Denied: Absolute paths are not permitted. Use relative paths within your session workspace (e.g. \"workspace_mirror/%s/file.txt\").", func() string {
				if len(repos) > 0 {
					return repos[0].FolderName
				}
				return "my_project"
			}())
		}
	}

	if paths.SessionFolder == "" {
		return filepath.Abs(normPath)
	}

	resolvedTarget := filepath.Join(paths.SessionFolder, filepath.FromSlash(normPath))
	absSessionFolder, _ := filepath.Abs(paths.SessionFolder)
	absResolvedTarget, _ := filepath.Abs(resolvedTarget)

	rel, err := filepath.Rel(absSessionFolder, absResolvedTarget)
	if err != nil || strings.HasPrefix(rel, "..") {
		return "", fmt.Errorf("Access Denied: The path \"%s\" resolves outside of the session sandbox.", targetPath)
	}

	return absResolvedTarget, nil
}
