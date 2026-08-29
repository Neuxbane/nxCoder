package tools

import (
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/neuxbane/nxcoder/backend/pkg/workspace"
)

type TerminalInstance struct {
	ID             string    `json:"terminal_id"`
	Name           string    `json:"name,omitempty"`
	Command        string    `json:"command"`
	LogFilePath    string    `json:"-"`
	LogFileRelPath string    `json:"log_file"`
	Status         string    `json:"status"` // running, completed, failed, killed, error
	ExitCode       *int      `json:"exit_code,omitempty"`
	StartedAt      string    `json:"started_at"`
	SessionID      string    `json:"session_id"`
	WorkspaceID    string    `json:"workspace_id"`
	cmd            *exec.Cmd `json:"-"`
	stdin          io.WriteCloser
	mu             sync.Mutex
}

type TerminalInfo struct {
	TerminalID   string `json:"terminal_id"`
	Name         string `json:"name,omitempty"`
	Command      string `json:"command"`
	Status       string `json:"status"`
	LogFile      string `json:"log_file"`
	StartedAt    string `json:"started_at"`
	LatestOutput string `json:"latest_output,omitempty"`
}

type TerminalManager struct {
	terminals map[string]*TerminalInstance
	mu        sync.RWMutex
}

func NewTerminalManager() *TerminalManager {
	return &TerminalManager{
		terminals: make(map[string]*TerminalInstance),
	}
}

type ExecuteCommandResult struct {
	Success    bool   `json:"success"`
	Output     string `json:"output,omitempty"`
	ExitCode   *int   `json:"exitCode,omitempty"`
	TerminalID string `json:"terminal_id,omitempty"`
	LogFile    string `json:"log_file,omitempty"`
	Message    string `json:"message"`
	Error      string `json:"error,omitempty"`
}

func (tm *TerminalManager) ExecuteCommand(baseDir, workspaceID, sessionID, command, targetPath, name string, repos []workspace.GitRepo) (*ExecuteCommandResult, error) {
	resolvedPath, err := workspace.ValidateAndResolvePath(baseDir, workspaceID, sessionID, targetPath, repos)
	if err != nil {
		resolvedPath = "."
	}
	_ = os.MkdirAll(resolvedPath, 0755)

	wPaths := workspace.GetWorkspacePaths(baseDir, workspaceID, sessionID)
	terminalsDir := filepath.Join(wPaths.SessionFolder, "terminals")
	_ = os.MkdirAll(terminalsDir, 0755)

	termID := "term_" + uuid.New().String()[:8]
	logFilePath := filepath.Join(terminalsDir, termID+".log")
	logFileRelPath := fmt.Sprintf("terminals/%s.log", termID)

	logFile, err := os.OpenFile(logFilePath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
	if err != nil {
		return nil, fmt.Errorf("failed to create terminal log: %w", err)
	}

	cmd := exec.Command("bash", "-c", command)
	cmd.Dir = resolvedPath

	// Environment configuration
	childEnv := os.Environ()
	childEnv = append(childEnv, "FORCE_COLOR=1", fmt.Sprintf("HOME=%s", wPaths.SessionFolder))
	for _, repo := range repos {
		if strings.HasPrefix(resolvedPath, repo.RealPath) {
			childEnv = append(childEnv, fmt.Sprintf("GIT_DIR=%s", repo.GitDir), fmt.Sprintf("GIT_WORK_TREE=%s", repo.RealPath))
			break
		}
	}
	cmd.Env = childEnv

	// Process group configuration for clean termination
	setProcessGroup(cmd)

	stdinPipe, _ := cmd.StdinPipe()
	cmd.Stdout = logFile
	cmd.Stderr = logFile

	termInst := &TerminalInstance{
		ID:             termID,
		Name:           name,
		Command:        command,
		LogFilePath:    logFilePath,
		LogFileRelPath: logFileRelPath,
		Status:         "running",
		StartedAt:      time.Now().UTC().Format(time.RFC3339),
		SessionID:      sessionID,
		WorkspaceID:    workspaceID,
		cmd:            cmd,
		stdin:          stdinPipe,
	}

	tm.mu.Lock()
	tm.terminals[termID] = termInst
	tm.mu.Unlock()

	if err := cmd.Start(); err != nil {
		termInst.Status = "error"
		_ = logFile.Close()
		return &ExecuteCommandResult{
			Success: false,
			Error:   err.Error(),
		}, nil
	}

	doneChan := make(chan struct{})
	go func() {
		err := cmd.Wait()
		termInst.mu.Lock()
		defer termInst.mu.Unlock()

		if err != nil {
			if exitErr, ok := err.(*exec.ExitError); ok {
				code := exitErr.ExitCode()
				termInst.ExitCode = &code
				termInst.Status = "failed"
			} else {
				termInst.Status = "error"
			}
		} else {
			zero := 0
			termInst.ExitCode = &zero
			termInst.Status = "completed"
		}
		_ = logFile.Close()
		close(doneChan)
	}()

	// Wait up to 5 seconds for quick completion
	select {
	case <-doneChan:
		time.Sleep(100 * time.Millisecond) // Allow buffer flush
		outData, _ := os.ReadFile(logFilePath)
		success := termInst.Status == "completed"
		return &ExecuteCommandResult{
			Success:  success,
			Output:   TruncateOutput(string(outData), 8000),
			ExitCode: termInst.ExitCode,
			Message:  "Command completed within 5 seconds.",
		}, nil

	case <-time.After(5 * time.Second):
		return &ExecuteCommandResult{
			Success:    true,
			TerminalID: termID,
			LogFile:    logFileRelPath,
			Message:    fmt.Sprintf("The terminal run is continuing in the background. Check logs with read_file at \"%s\".", logFileRelPath),
		}, nil
	}
}

func decodeEscapeSequences(s string) string {
	s = strings.ReplaceAll(s, "\\n", "\n")
	s = strings.ReplaceAll(s, "\\r", "\r")
	s = strings.ReplaceAll(s, "\\t", "\t")
	s = strings.ReplaceAll(s, "\\b", "\b")
	s = strings.ReplaceAll(s, "\\f", "\f")
	s = strings.ReplaceAll(s, "\\v", "\v")
	s = strings.ReplaceAll(s, "\\e", "\x1b")
	return s
}

func (tm *TerminalManager) SendTerminalInput(terminalID, input string) error {
	tm.mu.RLock()
	inst, ok := tm.terminals[terminalID]
	tm.mu.RUnlock()

	if !ok {
		return fmt.Errorf("terminal \"%s\" not found", terminalID)
	}
	if inst.Status != "running" || inst.stdin == nil {
		return fmt.Errorf("terminal \"%s\" is not active (status: %s)", terminalID, inst.Status)
	}

	decoded := decodeEscapeSequences(input)
	_, err := io.WriteString(inst.stdin, decoded)
	return err
}

func (tm *TerminalManager) Wait(seconds int) string {
	if seconds < 1 {
		seconds = 1
	}
	if seconds > 60 {
		seconds = 60
	}
	time.Sleep(time.Duration(seconds) * time.Second)
	return fmt.Sprintf("Completed wait of %d seconds.", seconds)
}

type WaitTerminalResult struct {
	TerminalID string `json:"terminal_id"`
	Status     string `json:"status"`
	Completed  bool   `json:"completed"`
	Logs       string `json:"logs"`
}

func (tm *TerminalManager) WaitTerminal(terminalID string, timeoutSeconds int) (*WaitTerminalResult, error) {
	tm.mu.RLock()
	inst, ok := tm.terminals[terminalID]
	tm.mu.RUnlock()

	if !ok {
		return nil, fmt.Errorf("terminal instance \"%s\" not found", terminalID)
	}

	if timeoutSeconds <= 0 {
		timeoutSeconds = 120
	}
	if timeoutSeconds > 300 {
		timeoutSeconds = 300
	}

	deadline := time.Now().Add(time.Duration(timeoutSeconds) * time.Second)
	for time.Now().Before(deadline) {
		inst.mu.Lock()
		status := inst.Status
		inst.mu.Unlock()

		if status != "running" {
			break
		}
		time.Sleep(500 * time.Millisecond)
	}

	logs, _ := os.ReadFile(inst.LogFilePath)
	return &WaitTerminalResult{
		TerminalID: terminalID,
		Status:     inst.Status,
		Completed:  inst.Status != "running",
		Logs:       TruncateOutput(string(logs), 4000),
	}, nil
}

func (tm *TerminalManager) TerminateTerminal(terminalID string) error {
	tm.mu.Lock()
	defer tm.mu.Unlock()

	inst, ok := tm.terminals[terminalID]
	if !ok {
		return fmt.Errorf("terminal \"%s\" not found", terminalID)
	}

	if inst.Status == "running" && inst.cmd != nil && inst.cmd.Process != nil {
		terminateProcessGracefully(inst.cmd)
	}

	inst.Status = "killed"
	return nil
}

func (tm *TerminalManager) TerminateSessionTerminals(sessionID string) {
	tm.mu.Lock()
	defer tm.mu.Unlock()

	for _, inst := range tm.terminals {
		if inst.SessionID == sessionID && inst.Status == "running" && inst.cmd != nil && inst.cmd.Process != nil {
			killProcessGroup(inst.cmd)
			inst.Status = "killed"
		}
	}
}

func (tm *TerminalManager) HasRunningTerminal(sessionID string) bool {
	tm.mu.RLock()
	defer tm.mu.RUnlock()

	for _, inst := range tm.terminals {
		if inst.SessionID == sessionID && inst.Status == "running" {
			return true
		}
	}
	return false
}

func (tm *TerminalManager) GetActiveTerminalsForSession(sessionID string) []TerminalInfo {
	tm.mu.RLock()
	defer tm.mu.RUnlock()

	var list []TerminalInfo
	for _, inst := range tm.terminals {
		if inst.SessionID == sessionID {
			latestOutput := ""
			if inst.LogFilePath != "" {
				if data, err := os.ReadFile(inst.LogFilePath); err == nil {
					str := string(data)
					if len(str) > 200 {
						latestOutput = str[len(str)-200:]
					} else {
						latestOutput = str
					}
				}
			}
			list = append(list, TerminalInfo{
				TerminalID:   inst.ID,
				Name:         inst.Name,
				Command:      inst.Command,
				Status:       inst.Status,
				LogFile:      inst.LogFileRelPath,
				StartedAt:    inst.StartedAt,
				LatestOutput: latestOutput,
			})
		}
	}
	return list
}
