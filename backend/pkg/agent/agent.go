package agent

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/neuxbane/nxcoder/backend/pkg/db"
	"github.com/neuxbane/nxcoder/backend/pkg/providers"
	"github.com/neuxbane/nxcoder/backend/pkg/tools"
	"github.com/neuxbane/nxcoder/backend/pkg/workspace"
)

const DEFAULT_ANTIGRAVITY_PROMPT = `You are Antigravity, a professional systems integration developer and coding agent. Perform tasks step by step and keep responses technical.

Workflow Guidance:
== Plan Stage (Read Only)
 - Gather information first: Thoroughly research the codebase across all layers to identify all files and components that will be affected by the requested feature.
 - Check for existing plan: Check if an ` + "`artifact/implementation_plan.md`" + ` file already exists. If it does, read its contents first.
 - Create or Modify Plan: For non-trivial requests, write a detailed implementation plan into ` + "`artifact/implementation_plan.md`" + `. If the plan already exists, modify/update it with your new findings.
 - Ask the user explicitly if the proposed plan is OK. Stop and wait for user approval before executing modifying commands.
== Execute Stage (Allowed after user approved the plan)
 - Create a task checklist file named ` + "`task.md`" + ` inside ` + "`artifact/`" + ` (i.e. ` + "`artifact/task.md`" + `) to track progress.
 - Implement the plan step-by-step using appropriate tool calls.
== Verify & Walkthrough Stage
 - Verify results of each step. Create test verification scripts inside ` + "`scratchpad/`" + ` (e.g. ` + "`scratchpad/test.js`" + `).
 - Create ` + "`artifact/walkthrough.md`" + ` summarizing changes made and verification results.

Required Artifact Formats:
---
#### ` + "`artifact/implementation_plan.md`" + ` Format:
` + "```markdown" + `
# [Goal Description]
Brief description of the problem and proposed solution.
## User Review Required
Highlight critical items (breaking changes, design decisions).
## Open Questions
Clarifying questions impacting the plan.
## Proposed Changes
Group files by component with relative paths:
### [Component Name]
#### [MODIFY] [file_basename](workspace_mirror/my_project/path/to/file)
- **Target Section/Function:** e.g. functionName()
- **Changes:** Description
#### [NEW] [file_basename](workspace_mirror/my_project/path/to/file)
- **Purpose:** What this new file does
## Verification Plan
### Automated Tests
- Commands to run.
### Manual Verification
- Manual testing details.
` + "```" + `

---
#### ` + "`artifact/task.md`" + ` Format:
` + "```markdown" + `
- [ ] uncompleted tasks
- [/] in-progress tasks
- [x] completed tasks
` + "```" + `

---
#### ` + "`artifact/walkthrough.md`" + ` Format:
` + "```markdown" + `
# Walkthrough
## Changes Made
- List of changes.
## Verification & Testing
- Test results and verification logs.
` + "```" + ``

type AgentEngine struct {
	DB              *db.DB
	TerminalManager *tools.TerminalManager
	ApprovalManager *tools.ApprovalManager
	BaseDir         string
	SubAgentEngine  *SubAgentEngine

	activeGenerations map[string]string // sessionID -> runID
	abortCancels      map[string]context.CancelFunc
	mu                sync.RWMutex
}

func NewAgentEngine(database *db.DB, tm *tools.TerminalManager, am *tools.ApprovalManager, baseDir string) *AgentEngine {
	engine := &AgentEngine{
		DB:                database,
		TerminalManager:   tm,
		ApprovalManager:   am,
		BaseDir:           baseDir,
		activeGenerations: make(map[string]string),
		abortCancels:      make(map[string]context.CancelFunc),
	}
	engine.SubAgentEngine = NewSubAgentEngine(engine)
	return engine
}

func (ae *AgentEngine) CancelGeneration(sessionID string) {
	ae.mu.Lock()
	defer ae.mu.Unlock()

	if cancel, exists := ae.abortCancels[sessionID]; exists {
		cancel()
		delete(ae.abortCancels, sessionID)
	}
	delete(ae.activeGenerations, sessionID)
}

func (ae *AgentEngine) IsGenerating(sessionID string) bool {
	ae.mu.RLock()
	defer ae.mu.RUnlock()
	_, exists := ae.activeGenerations[sessionID]
	return exists
}

func (ae *AgentEngine) getFoldersForWorkspace(workspaceID string) []string {
	ws, err := ae.DB.GetWorkspaceByID(workspaceID)
	if err != nil || ws == nil {
		return []string{}
	}
	var folders []string
	_ = json.Unmarshal(ws.FoldersPath, &folders)
	return folders
}

func (ae *AgentEngine) assembleContextualInstruction(workspaceID, sessionID, baseInstruction, userPrompt string) string {
	folders := ae.getFoldersForWorkspace(workspaceID)
	var folderNames []string
	for _, f := range folders {
		folderNames = append(folderNames, filepath.Base(f))
	}

	session, _ := ae.DB.GetSessionByID(sessionID)
	sessionName := "New Agentic Chat Session"
	if session != nil && session.Name != "" {
		sessionName = session.Name
	}

	trackingTerminals := ae.TerminalManager.GetActiveTerminalsForSession(sessionID)
	termJSON, _ := json.MarshalIndent(trackingTerminals, "", "  ")

	systemContext := fmt.Sprintf(`
=========================================
=== SYSTEM CONTEXT (DO NOT OVERWRITE) ===
=========================================
You are an AI coding agent operating inside an overlay session.
You have NO knowledge of the real filesystem paths on the host system.

Your working directory is the ROOT of your session workspace.
All paths you use in tool calls MUST be RELATIVE paths from this root.
NEVER use absolute paths (starting with / or ~). They are FORBIDDEN and will cause an error.

Your session workspace layout:
- Project files (mirrored for editing): %s
- Uploaded user files: uploads/
- Terminal log files: terminals/
- Artifacts directory (for plans, tasks, walkthroughs): artifact/
- Scratchpad directory (for temporary scripts, test verification code, temporary data): scratchpad/

To access a project file, use a path like: "workspace_mirror/%s/src/index.js"
To read an uploaded file, use a path like: "uploads/abc_myfile.pdf"
To read terminal output, use a path like: "terminals/term_12345678.log"
To write plans, task lists, or walkthroughs: use files inside "artifact/" (e.g. "artifact/implementation_plan.md")
To run verification/testing scripts: use files inside "scratchpad/" (e.g. "scratchpad/verify.js")

Current Session Name: "%s"

Priority Directive:
- If the Current Session Name is "New Agentic Chat Session" or is generic/placeholder, your absolute first priority is to call `+"`set_session_name`"+` with a concise, descriptive name based on the user's request.
- Do NOT proceed with other tool calls or the final response until the session has been meaningfully named.

Safety Guardrails:
- You may ONLY operate on paths within your session workspace (relative paths listed above).
- Absolute paths, paths starting with "../", or paths referencing any external location are FORBIDDEN.
- The system will reject any access attempt outside your sandbox with an Access Denied error.

Active Running Background Terminals:
%s

User Latest Context Request:
"%s"

Instructions for Terminal Execution:
- Background processes are completely async. When you call `+"`execute_command`"+`, it starts and returns immediately.
- When starting a background process, ALWAYS provide a descriptive `+"`name`"+` parameter.
- Do NOT block or wait on `+"`wait_terminal`"+` for long-running background processes.
- To check on the output of a process, use `+"`read_file`"+` on the relative `+"`log_file`"+` path returned from `+"`execute_command`"+`.
- Before starting a new server or process, check "Active Running Background Terminals". If a duplicate exists, call `+"`terminate_terminal`"+` with its ID first.
=========================================
`, strings.Join(func() []string {
		var list []string
		for _, n := range folderNames {
			list = append(list, fmt.Sprintf("workspace_mirror/%s/", n))
		}
		return list
	}(), ", "), func() string {
		if len(folderNames) > 0 {
			return folderNames[0]
		}
		return "my_project"
	}(), sessionName, string(termJSON), userPrompt)

	finalInst := fmt.Sprintf("%s\n\n%s", baseInstruction, systemContext)

	// Inject existing text artifacts if present
	wPaths := workspace.GetWorkspacePaths(ae.BaseDir, workspaceID, sessionID)
	if wPaths.SessionArtifactDir != "" {
		if entries, err := os.ReadDir(wPaths.SessionArtifactDir); err == nil {
			var injected strings.Builder
			for _, entry := range entries {
				if !entry.IsDir() && isTextFile(entry.Name()) {
					artPath := filepath.Join(wPaths.SessionArtifactDir, entry.Name())
					if data, err := os.ReadFile(artPath); err == nil {
						relPath := fmt.Sprintf("artifact/%s", entry.Name())
						injected.WriteString(fmt.Sprintf("\n\n=== INJECTED ARTIFACTS ===\n<%s>\n%s\n</artifact>", relPath, string(data)))
					}
				}
			}
			finalInst += injected.String()
		}
	}

	return finalInst
}

func isTextFile(fileName string) bool {
	binaryExts := map[string]bool{
		".pdf": true, ".png": true, ".jpg": true, ".jpeg": true, ".gif": true,
		".webp": true, ".zip": true, ".tar": true, ".gz": true, ".exe": true,
		".db": true, ".sqlite": true, ".bin": true,
	}
	return !binaryExts[strings.ToLower(filepath.Ext(fileName))]
}

func isRetryableError(err error) bool {
	if err == nil {
		return false
	}
	msg := strings.ToLower(err.Error())
	if strings.Contains(msg, "context canceled") || strings.Contains(msg, "abort") {
		return false
	}
	if strings.Contains(msg, "429") || strings.Contains(msg, "quota") || strings.Contains(msg, "rate limit") ||
		strings.Contains(msg, "500") || strings.Contains(msg, "503") || strings.Contains(msg, "timeout") ||
		strings.Contains(msg, "connection reset") {
		return true
	}
	return false
}

func (ae *AgentEngine) ExecuteStream(ctx context.Context, workspaceID, sessionID, prompt, apiKeyID string, broadcast func(string, any)) {
	ae.ExecuteStreamWithParent(ctx, workspaceID, sessionID, prompt, nil, apiKeyID, broadcast)
}

func (ae *AgentEngine) ExecuteStreamWithParent(ctx context.Context, workspaceID, sessionID, prompt string, parentID *int64, apiKeyID string, broadcast func(string, any)) {
	runID := uuid.New().String()

	ae.mu.Lock()
	ae.activeGenerations[sessionID] = runID
	ctx, cancel := context.WithCancel(ctx)
	ae.abortCancels[sessionID] = cancel
	ae.mu.Unlock()

	defer func() {
		ae.mu.Lock()
		if ae.activeGenerations[sessionID] == runID {
			delete(ae.activeGenerations, sessionID)
			delete(ae.abortCancels, sessionID)
		}
		ae.mu.Unlock()
	}()

	broadcast(sessionID, map[string]any{
		"type":   "SESSION_STATUS",
		"status": "generating",
	})

	_ = ae.DB.EnsureSession(workspaceID, sessionID, "New Agentic Chat Session")
	folders := ae.getFoldersForWorkspace(workspaceID)
	repos := workspace.GetGitReposForWorkspace(ae.BaseDir, workspaceID, folders)

	// Save user message to SQLite request chain
	dbUserMsg, _ := ae.DB.InsertSessionMessage(sessionID, parentID, "user", []map[string]any{{"text": prompt}})
	var userMsgID int64 = 1
	if dbUserMsg != nil {
		userMsgID = dbUserMsg.ID
	}
	_ = workspace.CommitSessionMessage(ae.BaseDir, workspaceID, sessionID, userMsgID, "user")

	// Create workspace mirror
	_ = workspace.CreateWorkspaceMirror(ae.BaseDir, workspaceID, sessionID, repos)

	// Base instruction resolution
	baseInstruction := DEFAULT_ANTIGRAVITY_PROMPT
	wsRecord, _ := ae.DB.GetWorkspaceByID(workspaceID)
	if wsRecord != nil && wsRecord.InstructionID != nil && *wsRecord.InstructionID != "" {
		if instRecord, err := ae.DB.GetInstructionByID(*wsRecord.InstructionID); err == nil && instRecord != nil && instRecord.Text != "" {
			baseInstruction = instRecord.Text
		}
	}

	dynamicInstruction := ae.assembleContextualInstruction(workspaceID, sessionID, baseInstruction, prompt)

	// Provider selection (Gemini or Custom Provider)
	customProv, _ := ae.DB.GetDefaultCustomProvider()

	maxRetries := 5
	attempt := 0
	delay := 2 * time.Second

	var finalModelMsgID int64
	for attempt < maxRetries {
		select {
		case <-ctx.Done():
			_ = workspace.CleanWorkspaceMirror(ae.BaseDir, workspaceID, sessionID, repos)
			broadcast(sessionID, map[string]any{"type": "DONE", "modelMessageId": finalModelMsgID})
			broadcast(sessionID, map[string]any{"type": "SESSION_STATUS", "status": "idle"})
			return
		default:
		}

		attempt++
		lastID, err := ae.runAgentLoop(ctx, workspaceID, sessionID, dynamicInstruction, repos, customProv, apiKeyID, broadcast)
		finalModelMsgID = lastID
		if err == nil {
			break
		}

		if !isRetryableError(err) || attempt >= maxRetries {
			_ = workspace.CleanWorkspaceMirror(ae.BaseDir, workspaceID, sessionID, repos)
			broadcast(sessionID, map[string]any{
				"type":    "ERROR",
				"message": err.Error(),
			})
			broadcast(sessionID, map[string]any{"type": "SESSION_STATUS", "status": "idle"})
			return
		}

		broadcast(sessionID, map[string]any{
			"type":        "RETRYING",
			"attempt":     attempt + 1,
			"maxAttempts": maxRetries,
			"delay":       delay.Milliseconds(),
			"message":     err.Error(),
		})

		time.Sleep(delay)
		delay *= 2
		if delay > 30*time.Second {
			delay = 30 * time.Second
		}
	}

	_ = workspace.CleanWorkspaceMirror(ae.BaseDir, workspaceID, sessionID, repos)
	broadcast(sessionID, map[string]any{"type": "DONE", "modelMessageId": finalModelMsgID})
	broadcast(sessionID, map[string]any{"type": "SESSION_STATUS", "status": "idle"})
}

func (ae *AgentEngine) runAgentLoop(
	ctx context.Context,
	workspaceID, sessionID, dynamicInstruction string,
	repos []workspace.GitRepo,
	customProv *db.CustomProvider,
	apiKeyID string,
	broadcast func(string, any),
) (int64, error) {
	liveMessages, _ := ae.DB.GetSessionThread(sessionID, nil)

	var lastModelMsgID int64

	keepRunning := true
	for keepRunning {
		select {
		case <-ctx.Done():
			return lastModelMsgID, ctx.Err()
		default:
		}

		// Build Gemini contents or OpenAI messages from session history
		geminiContents := make([]providers.GeminiContent, 0)
		openAIMessages := make([]providers.OpenAIMessage, 0)

		if customProv != nil {
			openAIMessages = append(openAIMessages, providers.OpenAIMessage{
				Role:    "system",
				Content: dynamicInstruction,
			})
		}

		for _, m := range liveMessages {
			var rawParts []map[string]any
			_ = json.Unmarshal(m.Parts, &rawParts)

			var geminiParts []providers.GeminiPart
			var textAccumulator strings.Builder

			for _, p := range rawParts {
				if txt, ok := p["text"].(string); ok {
					textAccumulator.WriteString(txt)
					geminiParts = append(geminiParts, providers.GeminiPart{Text: txt})
				} else if fc, ok := p["functionCall"].(map[string]any); ok {
					name, _ := fc["name"].(string)
					args, _ := fc["args"].(map[string]any)
					callID, _ := fc["id"].(string)
					geminiParts = append(geminiParts, providers.GeminiPart{
						FunctionCall: &providers.FunctionCall{ID: callID, Name: name, Args: args},
					})
				} else if fr, ok := p["functionResponse"].(map[string]any); ok {
					name, _ := fr["name"].(string)
					resp, _ := fr["response"].(map[string]any)
					callID, _ := fr["id"].(string)
					geminiParts = append(geminiParts, providers.GeminiPart{
						FunctionResp: &providers.FunctionResp{ID: callID, Name: name, Response: resp},
					})
				}
			}

			if len(geminiParts) > 0 {
				geminiContents = append(geminiContents, providers.GeminiContent{
					Role:  m.Role,
					Parts: geminiParts,
				})
			}

			if customProv != nil {
				openAIMessages = append(openAIMessages, providers.OpenAIMessage{
					Role:    m.Role,
					Content: textAccumulator.String(),
				})
			}
		}

		var pendingCalls []providers.FunctionCall
		var streamedText strings.Builder
		var streamedThought strings.Builder

		cb := providers.StreamCallbacks{
			OnTextChunk: func(chunk string) {
				streamedText.WriteString(chunk)
				broadcast(sessionID, map[string]any{
					"type": "TOKEN_STREAM",
					"text": chunk,
				})
			},
			OnThoughtChunk: func(chunk string) {
				streamedThought.WriteString(chunk)
				broadcast(sessionID, map[string]any{
					"type": "THOUGHT_STREAM",
					"text": chunk,
				})
			},
			OnFunctionCall: func(fc providers.FunctionCall) {
				if fc.ID == "" {
					fc.ID = "call_" + randHex(4)
				}
				pendingCalls = append(pendingCalls, fc)
				broadcast(sessionID, map[string]any{
					"type":   "FUNCTION_CALL",
					"name":   fc.Name,
					"callId": fc.ID,
					"args":   fc.Args,
				})
			},
		}

		hasProject := workspaceID != "" && workspaceID != "ws_general"
		activeGroups := ae.getActiveToolGroups(hasProject, false)

		if customProv != nil {
			client := providers.NewOpenAIClient(customProv.BaseURL, customProv.APIKey, customProv.ModelName)
			err := client.StreamChatCompletions(ctx, openAIMessages, tools.GroupsToOpenAIDeclarations(activeGroups), cb)
			if err != nil {
				return lastModelMsgID, err
			}
		} else {
			apiKey := ae.DB.GetNextApiKey(apiKeyID)
			if apiKey == "" {
				return lastModelMsgID, fmt.Errorf("no API key available in rotation storage")
			}
			client := providers.NewGeminiClient(apiKey, "gemini-2.5-flash")
			req := providers.GeminiRequest{
				Contents: geminiContents,
				SystemInstruction: &providers.GeminiContent{
					Role:  "system",
					Parts: []providers.GeminiPart{{Text: dynamicInstruction}},
				},
				Tools: tools.GroupsToGeminiDeclarations(activeGroups),
			}
			err := client.StreamGenerateContent(ctx, req, cb)
			if err != nil {
				return lastModelMsgID, err
			}
		}

		// Record model turn in history
		var prevMsgID *int64
		if len(liveMessages) > 0 {
			pID := liveMessages[len(liveMessages)-1].ID
			prevMsgID = &pID
		}

		modelParts := make([]map[string]any, 0)
		if streamedThought.Len() > 0 {
			modelParts = append(modelParts, map[string]any{"thought": true, "text": streamedThought.String()})
		}
		if streamedText.Len() > 0 {
			modelParts = append(modelParts, map[string]any{"text": streamedText.String()})
		}
		for _, fc := range pendingCalls {
			modelParts = append(modelParts, map[string]any{
				"functionCall": map[string]any{
					"id":   fc.ID,
					"name": fc.Name,
					"args": fc.Args,
				},
			})
		}

		dbModelMsg, _ := ae.DB.InsertSessionMessage(sessionID, prevMsgID, "model", modelParts)
		modelMsgID := int64(1)
		if dbModelMsg != nil {
			modelMsgID = dbModelMsg.ID
		}
		lastModelMsgID = modelMsgID

		_ = workspace.CommitSessionMessage(ae.BaseDir, workspaceID, sessionID, modelMsgID, "model")

		if len(pendingCalls) > 0 {
			// Execute tools and append user turn with function responses
			toolResponseParts := make([]map[string]any, 0)
			toolOutputMsgID := modelMsgID + 1

			for _, call := range pendingCalls {
				select {
				case <-ctx.Done():
					return lastModelMsgID, ctx.Err()
				default:
				}

				toolResult := ae.ExecuteTool(workspaceID, sessionID, call.Name, call.Args, repos, broadcast)
				sanitized := tools.SanitizeToolResult(toolResult, 12000)

				broadcast(sessionID, map[string]any{
					"type":      "FUNCTION_RESPONSE",
					"callId":    call.ID,
					"response":  map[string]any{"result": toolResult},
					"messageId": toolOutputMsgID,
				})

				toolResponseParts = append(toolResponseParts, map[string]any{
					"functionResponse": map[string]any{
						"id":       call.ID,
						"name":     call.Name,
						"response": map[string]any{"result": sanitized},
					},
				})
			}

			dbToolMsg, _ := ae.DB.InsertSessionMessage(sessionID, &modelMsgID, "user", toolResponseParts)
			if dbToolMsg != nil {
				toolOutputMsgID = dbToolMsg.ID
			}
			_ = workspace.CommitSessionMessage(ae.BaseDir, workspaceID, sessionID, toolOutputMsgID, "user")

			// Refresh live message chain for next turn
			liveMessages, _ = ae.DB.GetSessionThread(sessionID, nil)

			keepRunning = true
		} else {
			keepRunning = false
		}
	}

	_ = workspace.CommitSessionMessage(ae.BaseDir, workspaceID, sessionID, lastModelMsgID, "model")
	_ = workspace.MergeMirrorChangesBack(ae.BaseDir, workspaceID, sessionID, repos, lastModelMsgID)
	return lastModelMsgID, nil
}

func (ae *AgentEngine) ExecuteTool(workspaceID, sessionID, toolName string, args map[string]any, repos []workspace.GitRepo, broadcast func(string, any)) any {
	// Verify tool security permission
	err := tools.VerifyToolPermission(ae.DB, workspaceID, sessionID, toolName, args, ae.ApprovalManager, broadcast)
	if err != nil {
		return map[string]any{"error": err.Error()}
	}

	getString := func(key string) string {
		if v, ok := args[key].(string); ok {
			return v
		}
		return ""
	}
	getInt := func(key string) int {
		if v, ok := args[key].(float64); ok {
			return int(v)
		}
		if v, ok := args[key].(int); ok {
			return v
		}
		return 0
	}
	getBool := func(key string) bool {
		if v, ok := args[key].(bool); ok {
			return v
		}
		return false
	}
	getStringSlice := func(key string) []string {
		if v, ok := args[key].([]any); ok {
			var res []string
			for _, item := range v {
				if s, ok := item.(string); ok {
					res = append(res, s)
				}
			}
			return res
		}
		return nil
	}

	switch toolName {
	case "list_dir":
		res, err := tools.ListDir(ae.BaseDir, workspaceID, sessionID, getString("path"), repos)
		if err != nil {
			return map[string]any{"error": err.Error()}
		}
		return res

	case "read_file":
		res, err := tools.ReadFile(ae.BaseDir, workspaceID, sessionID, getString("path"), getInt("from_line"), getInt("to_line"), repos)
		if err != nil {
			return map[string]any{"error": err.Error()}
		}
		return res

	case "write_file":
		err := tools.WriteFile(ae.BaseDir, workspaceID, sessionID, getString("path"), getString("content"), repos)
		if err != nil {
			return map[string]any{"error": err.Error()}
		}
		return map[string]any{"success": true, "message": "File written successfully."}

	case "edit_file":
		occ := getInt("occurrence")
		if occ <= 0 {
			occ = 1
		}
		res, err := tools.EditFile(ae.BaseDir, workspaceID, sessionID, getString("path"), getString("search"), getString("replace"), occ, repos)
		if err != nil {
			return map[string]any{"error": err.Error()}
		}
		return res

	case "regex_search":
		paths := getStringSlice("paths")
		if len(paths) == 0 && getString("path") != "" {
			paths = []string{getString("path")}
		}
		if len(paths) == 0 {
			paths = []string{"."}
		}
		searchFileContent := getBool("searchFileContent")
		searchFileName := getBool("searchFileName")
		if !searchFileContent && !searchFileName {
			searchFileContent = true
		}
		res, err := tools.RegexSearch(ae.BaseDir, workspaceID, sessionID, getString("regexStr"), paths, searchFileName, searchFileContent, getStringSlice("ignore"), repos)
		if err != nil {
			return map[string]any{"error": err.Error()}
		}
		return res

	case "execute_command":
		cmd := getString("command")
		ok, err := tools.VerifyCommandPermission(ae.DB, workspaceID, sessionID, cmd, ae.ApprovalManager, broadcast)
		if !ok || err != nil {
			if err != nil {
				return map[string]any{"error": err.Error()}
			}
			return map[string]any{"error": "Command execution rejected by user."}
		}
		res, err := ae.TerminalManager.ExecuteCommand(ae.BaseDir, workspaceID, sessionID, cmd, getString("path"), getString("name"), repos)
		if err != nil {
			return map[string]any{"error": err.Error()}
		}
		return res

	case "send_terminal_input":
		err := ae.TerminalManager.SendTerminalInput(getString("terminal_id"), getString("input"))
		if err != nil {
			return map[string]any{"error": err.Error()}
		}
		return map[string]any{"success": true, "message": "Successfully wrote inputs to terminal stdin."}

	case "wait":
		msg := ae.TerminalManager.Wait(getInt("seconds"))
		return map[string]any{"message": msg}

	case "wait_terminal":
		res, err := ae.TerminalManager.WaitTerminal(getString("terminal_id"), getInt("timeout_seconds"))
		if err != nil {
			return map[string]any{"error": err.Error()}
		}
		return res

	case "terminate_terminal":
		err := ae.TerminalManager.TerminateTerminal(getString("terminal_id"))
		if err != nil {
			return map[string]any{"error": err.Error()}
		}
		return map[string]any{"success": true, "message": fmt.Sprintf("Terminal \"%s\" terminated.", getString("terminal_id"))}

	case "set_session_name":
		name := strings.TrimSpace(getString("name"))
		if name != "" {
			_ = ae.DB.UpdateSessionName(sessionID, name)
		}
		return map[string]any{"success": true, "name": name, "message": fmt.Sprintf("Session renamed to \"%s\".", name)}

	case "parse_document":
		apiKey := ae.DB.GetNextApiKey("")
		res, err := tools.ParseDocument(ae.BaseDir, workspaceID, sessionID, getString("filepath"), getString("outputName"), apiKey, repos)
		if err != nil {
			return map[string]any{"error": err.Error()}
		}
		return res

	case "view_image":
		res, err := tools.ViewImage(ae.BaseDir, workspaceID, sessionID, getString("path"), repos)
		if err != nil {
			return map[string]any{"error": err.Error()}
		}
		return res

	case "spawn_sub_agent":
		return ae.SubAgentEngine.SpawnSubAgent(workspaceID, sessionID, getString("name"), getString("prompt"), getString("instruction_profile_id"), broadcast)

	case "get_sub_agent_status":
		maxChars := getInt("max_recent_chars")
		if maxChars <= 0 {
			maxChars = 4000
		}
		return ae.SubAgentEngine.GetSubAgentStatus(workspaceID, sessionID, getString("sub_agent_id"), maxChars)

	case "wait_sub_agent":
		return ae.SubAgentEngine.WaitSubAgent(workspaceID, sessionID, getString("sub_agent_id"))

	default:
		// 1. Try JavaScript script tools
		scriptToolsDir := filepath.Join(ae.BaseDir, "tool-scripts")
		if dbScripts, err := ae.DB.GetToolScripts(); err == nil {
			for _, s := range dbScripts {
				if s.Enabled == 1 && s.Name == toolName {
					filePath := filepath.Join(scriptToolsDir, s.FileName)
					out, err := tools.ExecuteScriptTool(filePath, args)
					if err != nil {
						return map[string]any{"error": err.Error()}
					}
					var parsed any
					if json.Unmarshal([]byte(out), &parsed) == nil {
						return map[string]any{"result": parsed}
					}
					return map[string]any{"output": out}
				}
			}
		}

		// 2. Try MCP servers
		if mcpServers, err := ae.DB.GetMcpServers(); err == nil {
			for _, s := range mcpServers {
				if s.Active == 1 {
					out, err := tools.GlobalMCPManager.CallServerTool(s.Source, toolName, args)
					if err == nil {
						var parsed any
						if json.Unmarshal([]byte(out), &parsed) == nil {
							return map[string]any{"result": parsed}
						}
						return map[string]any{"output": out}
					}
				}
			}
		}

		return map[string]any{"error": fmt.Sprintf("Unknown tool: %s", toolName)}
	}
}

func (ae *AgentEngine) getActiveToolGroups(hasProject bool, isSubAgent bool) []tools.ToolGroup {
	scriptToolsDir := filepath.Join(ae.BaseDir, "tool-scripts")
	_ = os.MkdirAll(scriptToolsDir, 0755)

	var scriptGroups []tools.ToolGroup
	if dbScripts, err := ae.DB.GetToolScripts(); err == nil {
		for _, s := range dbScripts {
			if s.Enabled != 1 {
				continue
			}
			filePath := filepath.Join(scriptToolsDir, s.FileName)
			decl, _ := tools.ExtractScriptDeclaration(filePath)
			scriptGroups = append(scriptGroups, tools.BuildScriptToolGroup(s, decl))
		}
	}

	var mcpGroups []tools.ToolGroup
	if mcpServers, err := ae.DB.GetMcpServers(); err == nil {
		for _, s := range mcpServers {
			if s.Active != 1 {
				continue
			}
			decls, err := tools.GlobalMCPManager.QueryServerTools(s.Source)
			if err == nil && len(decls) > 0 {
				mcpGroups = append(mcpGroups, tools.BuildMCPToolGroup(s, decls))
			}
		}
	}

	return tools.GetActiveGroups(hasProject, isSubAgent, scriptGroups, mcpGroups)
}

func randHex(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

