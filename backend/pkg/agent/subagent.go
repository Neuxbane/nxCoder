package agent

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/neuxbane/nxcoder/backend/pkg/workspace"
)

type SubAgentData struct {
	ID            string                     `json:"id"`
	Name          string                     `json:"name"`
	Prompt        string                     `json:"prompt"`
	InstructionID string                     `json:"instruction_id"`
	Status        string                     `json:"status"` // running, completed, failed
	Result        string                     `json:"result"`
	History       []workspace.SessionMessage `json:"history"`
	CreatedAt     string                     `json:"created_at"`
	UpdatedAt     string                     `json:"updated_at"`
}

type SubAgentEngine struct {
	agent *AgentEngine
}

func NewSubAgentEngine(agent *AgentEngine) *SubAgentEngine {
	return &SubAgentEngine{agent: agent}
}

func (sae *SubAgentEngine) getSubSessionsDir(workspaceID, sessionID string) string {
	wPaths := workspace.GetWorkspacePaths(sae.agent.BaseDir, workspaceID, sessionID)
	dir := filepath.Join(wPaths.SessionFolder, "sub_sessions")
	_ = os.MkdirAll(dir, 0755)
	return dir
}

func (sae *SubAgentEngine) saveSubSession(workspaceID, sessionID string, data *SubAgentData) error {
	dir := sae.getSubSessionsDir(workspaceID, sessionID)
	filePath := filepath.Join(dir, fmt.Sprintf("%s.json", data.ID))
	jsonData, err := json.MarshalIndent(data, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filePath, jsonData, 0644)
}

func (sae *SubAgentEngine) loadSubSession(workspaceID, sessionID, subAgentID string) (*SubAgentData, error) {
	dir := sae.getSubSessionsDir(workspaceID, sessionID)
	filePath := filepath.Join(dir, fmt.Sprintf("%s.json", subAgentID))
	content, err := os.ReadFile(filePath)
	if err != nil {
		return nil, err
	}
	var data SubAgentData
	if err := json.Unmarshal(content, &data); err != nil {
		return nil, err
	}
	return &data, nil
}

func (sae *SubAgentEngine) SpawnSubAgent(workspaceID, sessionID, name, prompt, instructionProfileID string, broadcast func(string, any)) any {
	subAgentID := fmt.Sprintf("sub_sess_%s", randHex(4))
	now := time.Now().UTC().Format(time.RFC3339)

	initialParts, _ := json.Marshal([]map[string]any{{"text": prompt}})
	data := &SubAgentData{
		ID:            subAgentID,
		Name:          name,
		Prompt:        prompt,
		InstructionID: instructionProfileID,
		Status:        "completed",
		Result:        fmt.Sprintf("Sub-agent %s spawned and context registered.", name),
		History: []workspace.SessionMessage{
			{
				ID:        1,
				Role:      "user",
				Parts:     initialParts,
				CreatedAt: now,
			},
		},
		CreatedAt: now,
		UpdatedAt: now,
	}

	_ = sae.saveSubSession(workspaceID, sessionID, data)
	broadcast(sessionID, map[string]any{
		"type":       "SUB_SESSION_CREATED",
		"subAgentId": subAgentID,
		"name":       name,
	})

	return map[string]any{
		"sub_agent_id": subAgentID,
		"status":       "completed",
		"message":      fmt.Sprintf("Sub-agent %s spawned successfully.", name),
	}
}

func (sae *SubAgentEngine) GetSubAgentStatus(workspaceID, sessionID, subAgentID string, maxRecentChars int) any {
	data, err := sae.loadSubSession(workspaceID, sessionID, subAgentID)
	if err != nil {
		return map[string]any{"error": fmt.Sprintf("Sub-agent ID %s not found: %v", subAgentID, err)}
	}

	var historyText strings.Builder
	for _, m := range data.History {
		var parts []map[string]any
		_ = json.Unmarshal(m.Parts, &parts)
		for _, p := range parts {
			if txt, ok := p["text"].(string); ok {
				historyText.WriteString(fmt.Sprintf("[%s]: %s\n", strings.ToUpper(m.Role), txt))
			} else if fc, ok := p["functionCall"].(map[string]any); ok {
				historyText.WriteString(fmt.Sprintf("[TOOL CALL]: %v(%v)\n", fc["name"], fc["args"]))
			} else if fr, ok := p["functionResponse"].(map[string]any); ok {
				historyText.WriteString(fmt.Sprintf("[TOOL RESPONSE]: %v\n", fr["response"]))
			}
		}
	}

	hStr := historyText.String()
	if len(hStr) > maxRecentChars {
		hStr = "..." + hStr[len(hStr)-maxRecentChars:]
	}

	return map[string]any{
		"sub_agent_id":   subAgentID,
		"status":         data.Status,
		"result":         data.Result,
		"recent_history": hStr,
		"updated_at":     data.UpdatedAt,
	}
}

func (sae *SubAgentEngine) WaitSubAgent(workspaceID, sessionID, subAgentID string) any {
	deadline := time.Now().Add(5 * time.Minute)
	for time.Now().Before(deadline) {
		data, err := sae.loadSubSession(workspaceID, sessionID, subAgentID)
		if err != nil {
			return map[string]any{"error": fmt.Sprintf("Error waiting for sub-agent: %v", err)}
		}
		if data.Status != "running" {
			return map[string]any{
				"sub_agent_id": subAgentID,
				"status":       data.Status,
				"result":       data.Result,
			}
		}
		time.Sleep(1 * time.Second)
	}
	return map[string]any{"error": "Timeout waiting for sub-agent to complete."}
}
