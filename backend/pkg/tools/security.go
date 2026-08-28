package tools

import (
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/neuxbane/nxcoder/backend/pkg/db"
)

type PendingApproval struct {
	ID          string
	WorkspaceID string
	SessionID   string
	Type        string // command or tool
	Command     string
	ToolName    string
	Args        any
	ResultChan  chan string
	CreatedAt   time.Time
}

type ApprovalManager struct {
	approvals map[string]*PendingApproval
	mu        sync.RWMutex
}

func NewApprovalManager() *ApprovalManager {
	return &ApprovalManager{
		approvals: make(map[string]*PendingApproval),
	}
}

func (am *ApprovalManager) ResolveApproval(approvalID, action string) bool {
	am.mu.Lock()
	appr, exists := am.approvals[approvalID]
	if exists {
		delete(am.approvals, approvalID)
	}
	am.mu.Unlock()

	if exists && appr != nil {
		select {
		case appr.ResultChan <- action:
		default:
		}
		return true
	}
	return false
}

func (am *ApprovalManager) RequestCommandApproval(workspaceID, sessionID, command string, broadcaster func(string, any)) (string, error) {
	approvalID := "appr_" + uuid.New().String()[:8]
	resultChan := make(chan string, 1)

	appr := &PendingApproval{
		ID:          approvalID,
		WorkspaceID: workspaceID,
		SessionID:   sessionID,
		Type:        "command",
		Command:     command,
		ResultChan:  resultChan,
		CreatedAt:   time.Now(),
	}

	am.mu.Lock()
	am.approvals[approvalID] = appr
	am.mu.Unlock()

	broadcaster(sessionID, map[string]any{
		"type":       "COMMAND_APPROVAL_REQUEST",
		"approvalId": approvalID,
		"command":    command,
	})

	select {
	case action := <-resultChan:
		return action, nil
	case <-time.After(5 * time.Minute):
		am.mu.Lock()
		delete(am.approvals, approvalID)
		am.mu.Unlock()
		broadcaster(sessionID, map[string]any{
			"type":       "COMMAND_APPROVAL_TIMEOUT",
			"approvalId": approvalID,
		})
		return "deny", nil
	}
}

func (am *ApprovalManager) RequestToolApproval(workspaceID, sessionID, toolName string, args any, broadcaster func(string, any)) (string, error) {
	approvalID := "appr_" + uuid.New().String()[:8]
	resultChan := make(chan string, 1)

	appr := &PendingApproval{
		ID:          approvalID,
		WorkspaceID: workspaceID,
		SessionID:   sessionID,
		Type:        "tool",
		ToolName:    toolName,
		Args:        args,
		ResultChan:  resultChan,
		CreatedAt:   time.Now(),
	}

	am.mu.Lock()
	am.approvals[approvalID] = appr
	am.mu.Unlock()

	broadcaster(sessionID, map[string]any{
		"type":       "TOOL_APPROVAL_REQUEST",
		"approvalId": approvalID,
		"toolName":   toolName,
		"args":       args,
	})

	select {
	case action := <-resultChan:
		return action, nil
	case <-time.After(5 * time.Minute):
		am.mu.Lock()
		delete(am.approvals, approvalID)
		am.mu.Unlock()
		broadcaster(sessionID, map[string]any{
			"type":       "TOOL_APPROVAL_TIMEOUT",
			"approvalId": approvalID,
		})
		return "deny", nil
	}
}

func IsCommandMatched(targetCommand string, rulesList []string) bool {
	if strings.TrimSpace(targetCommand) == "" || len(rulesList) == 0 {
		return false
	}
	targetClean := strings.ToLower(strings.TrimSpace(targetCommand))

	for _, rule := range rulesList {
		ruleClean := strings.ToLower(strings.TrimSpace(rule))
		if ruleClean == "" {
			continue
		}

		if targetClean == ruleClean {
			return true
		}

		if strings.HasPrefix(targetClean, ruleClean) {
			remainder := targetClean[len(ruleClean):]
			if len(remainder) == 0 || remainder[0] == ' ' || remainder[0] == '\t' {
				return true
			}
		}
	}
	return false
}

func parseStringArray(raw string) []string {
	var list []string
	_ = json.Unmarshal([]byte(raw), &list)
	return list
}

func VerifyCommandPermission(database *db.DB, workspaceID, sessionID, command string, approvalMgr *ApprovalManager, broadcaster func(string, any)) (bool, error) {
	if workspaceID == "" {
		return true, nil
	}

	sec, err := database.GetOrCreateWorkspaceSecurity(workspaceID)
	if err != nil {
		return true, nil
	}

	denied := parseStringArray(sec.DeniedCommands)
	if IsCommandMatched(command, denied) {
		return false, fmt.Errorf("Access Denied: Command \"%s\" is denied by workspace security policies.", command)
	}

	shouldPrompt := true
	if sec.SecurityMode == "relax" {
		shouldPrompt = false
	} else if sec.SecurityMode == "auto_harmless" {
		allowed := parseStringArray(sec.AllowedCommands)
		harmless := parseStringArray(sec.HarmlessCommands)
		if IsCommandMatched(command, allowed) || IsCommandMatched(command, harmless) {
			shouldPrompt = false
		}
	} else { // ask
		allowed := parseStringArray(sec.AllowedCommands)
		if IsCommandMatched(command, allowed) {
			shouldPrompt = false
		}
	}

	if shouldPrompt {
		action, err := approvalMgr.RequestCommandApproval(workspaceID, sessionID, command, broadcaster)
		if err != nil || action == "deny" {
			return false, fmt.Errorf("Permission Denied: Execution of \"%s\" was rejected by the user.", command)
		}
		if action == "always_allow" {
			allowed := parseStringArray(sec.AllowedCommands)
			allowed = append(allowed, strings.TrimSpace(command))
			newJSON, _ := json.Marshal(allowed)
			sec.AllowedCommands = string(newJSON)
			_ = database.UpdateWorkspaceSecurity(sec)
		}
	}

	return true, nil
}

func VerifyToolPermission(database *db.DB, workspaceID, sessionID, toolName string, args any, approvalMgr *ApprovalManager, broadcaster func(string, any)) error {
	if workspaceID == "" || toolName == "execute_command" {
		return nil
	}

	sec, err := database.GetOrCreateWorkspaceSecurity(workspaceID)
	if err != nil {
		return nil
	}

	denied := parseStringArray(sec.DeniedTools)
	for _, d := range denied {
		if d == toolName {
			return fmt.Errorf("Access Denied: Tool \"%s\" is denied by workspace security policies.", toolName)
		}
	}

	shouldPrompt := true
	if sec.SecurityMode == "relax" {
		shouldPrompt = false
	} else if sec.SecurityMode == "auto_harmless" {
		allowed := parseStringArray(sec.AllowedTools)
		harmless := parseStringArray(sec.HarmlessTools)
		for _, a := range allowed {
			if a == toolName {
				shouldPrompt = false
				break
			}
		}
		for _, h := range harmless {
			if h == toolName {
				shouldPrompt = false
				break
			}
		}
	} else { // ask
		allowed := parseStringArray(sec.AllowedTools)
		for _, a := range allowed {
			if a == toolName {
				shouldPrompt = false
				break
			}
		}
	}

	if shouldPrompt {
		action, err := approvalMgr.RequestToolApproval(workspaceID, sessionID, toolName, args, broadcaster)
		if err != nil || action == "deny" {
			return fmt.Errorf("Tool execution denied by user: \"%s\"", toolName)
		}
		if action == "always_allow" {
			allowed := parseStringArray(sec.AllowedTools)
			allowed = append(allowed, toolName)
			newJSON, _ := json.Marshal(allowed)
			sec.AllowedTools = string(newJSON)
			_ = database.UpdateWorkspaceSecurity(sec)
		}
	}

	return nil
}
