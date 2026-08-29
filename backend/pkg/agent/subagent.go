package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/neuxbane/nxcoder/backend/pkg/providers"
	"github.com/neuxbane/nxcoder/backend/pkg/tools"
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
		Status:        "running",
		Result:        "",
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

	go sae.runSubAgentTask(workspaceID, sessionID, subAgentID, prompt, instructionProfileID, broadcast)

	return map[string]any{
		"sub_agent_id": subAgentID,
		"status":       "running",
		"message":      "Sub-agent spawned successfully.",
	}
}

func (sae *SubAgentEngine) runSubAgentTask(workspaceID, sessionID, subAgentID, prompt, instructionProfileID string, broadcast func(string, any)) {
	data, err := sae.loadSubSession(workspaceID, sessionID, subAgentID)
	if err != nil {
		return
	}

	instructionPrompt := DEFAULT_ANTIGRAVITY_PROMPT
	if instructionProfileID != "" {
		if record, err := sae.agent.DB.GetInstructionByID(instructionProfileID); err == nil && record != nil && record.Text != "" {
			instructionPrompt = record.Text
		}
	}

	systemInstruction := sae.agent.assembleContextualInstruction(workspaceID, sessionID, instructionPrompt, prompt)
	folders := sae.agent.getFoldersForWorkspace(workspaceID)
	repos := workspace.GetGitReposForWorkspace(sae.agent.BaseDir, workspaceID, folders)

	apiKey := sae.agent.DB.GetNextApiKey("")
	client := providers.NewGeminiClient(apiKey, "gemini-2.5-flash")

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
	defer cancel()

	keepRunning := true
	for keepRunning {
		select {
		case <-ctx.Done():
			data.Status = "failed"
			data.Result = "Sub-agent execution timed out."
			data.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
			_ = sae.saveSubSession(workspaceID, sessionID, data)
			broadcast(sessionID, map[string]any{"type": "SUB_SESSION_FAILED", "subAgentId": subAgentID, "error": data.Result})
			return
		default:
		}

		// Build contents
		geminiContents := make([]providers.GeminiContent, 0)
		for _, m := range data.History {
			var rawParts []map[string]any
			_ = json.Unmarshal(m.Parts, &rawParts)

			var parts []providers.GeminiPart
			for _, p := range rawParts {
				if txt, ok := p["text"].(string); ok {
					parts = append(parts, providers.GeminiPart{Text: txt})
				} else if inlineData, ok := p["inlineData"].(map[string]any); ok {
					mimeType, _ := inlineData["mimeType"].(string)
					dataB64, _ := inlineData["data"].(string)
					if mimeType != "" && dataB64 != "" {
						parts = append(parts, providers.GeminiPart{
							InlineData: &providers.GeminiBlob{
								MimeType: mimeType,
								Data:     dataB64,
							},
						})
					}
				} else if fc, ok := p["functionCall"].(map[string]any); ok {
					name, _ := fc["name"].(string)
					args, _ := fc["args"].(map[string]any)
					callID, _ := fc["id"].(string)
					parts = append(parts, providers.GeminiPart{FunctionCall: &providers.FunctionCall{ID: callID, Name: name, Args: args}})
				} else if fr, ok := p["functionResponse"].(map[string]any); ok {
					name, _ := fr["name"].(string)
					resp, _ := fr["response"].(map[string]any)
					callID, _ := fr["id"].(string)
					parts = append(parts, providers.GeminiPart{FunctionResp: &providers.FunctionResp{ID: callID, Name: name, Response: resp}})
				}
			}
			if len(parts) > 0 {
				geminiContents = append(geminiContents, providers.GeminiContent{Role: m.Role, Parts: parts})
			}
		}

		var pendingCalls []providers.FunctionCall
		var streamedText strings.Builder
		var streamedThought strings.Builder

		cb := providers.StreamCallbacks{
			OnTextChunk: func(chunk string) {
				streamedText.WriteString(chunk)
				broadcast(subAgentID, map[string]any{"type": "TOKEN_STREAM", "text": chunk})
			},
			OnThoughtChunk: func(chunk string) {
				streamedThought.WriteString(chunk)
				broadcast(subAgentID, map[string]any{"type": "THOUGHT_STREAM", "text": chunk})
			},
			OnFunctionCall: func(fc providers.FunctionCall) {
				if fc.ID == "" {
					fc.ID = "call_" + randHex(4)
				}
				pendingCalls = append(pendingCalls, fc)
				broadcast(subAgentID, map[string]any{"type": "FUNCTION_CALL", "name": fc.Name, "callId": fc.ID, "args": fc.Args})
			},
		}

		req := providers.GeminiRequest{
			Contents: geminiContents,
			SystemInstruction: &providers.GeminiContent{
				Role:  "system",
				Parts: []providers.GeminiPart{{Text: systemInstruction}},
			},
			Tools: tools.GetGeminiToolDeclarations(true), // Subagent tools only (no nested spawning)
		}

		err := client.StreamGenerateContent(ctx, req, cb)
		if err != nil {
			data.Status = "failed"
			data.Result = fmt.Sprintf("Error: %v", err)
			data.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
			_ = sae.saveSubSession(workspaceID, sessionID, data)
			broadcast(sessionID, map[string]any{"type": "SUB_SESSION_FAILED", "subAgentId": subAgentID, "error": data.Result})
			return
		}

		// Save model turn
		modelMsgID := int64(len(data.History) + 1)
		modelParts := make([]map[string]any, 0)
		if streamedThought.Len() > 0 {
			modelParts = append(modelParts, map[string]any{"thought": true, "text": streamedThought.String()})
		}
		if streamedText.Len() > 0 {
			modelParts = append(modelParts, map[string]any{"text": streamedText.String()})
		}
		for _, fc := range pendingCalls {
			modelParts = append(modelParts, map[string]any{"functionCall": map[string]any{"id": fc.ID, "name": fc.Name, "args": fc.Args}})
		}
		pBytes, _ := json.Marshal(modelParts)
		data.History = append(data.History, workspace.SessionMessage{
			ID:        modelMsgID,
			Role:      "model",
			Parts:     pBytes,
			CreatedAt: time.Now().UTC().Format(time.RFC3339),
		})

		if len(pendingCalls) > 0 {
			toolResponseParts := make([]map[string]any, 0)
			for _, call := range pendingCalls {
				toolResult := sae.agent.ExecuteTool(workspaceID, sessionID, call.Name, call.Args, repos, broadcast)
				sanitized := tools.SanitizeToolResult(toolResult, 12000)

				broadcast(subAgentID, map[string]any{
					"type":     "FUNCTION_RESPONSE",
					"callId":   call.ID,
					"response": map[string]any{"result": toolResult},
				})

				toolResponseParts = append(toolResponseParts, map[string]any{
					"functionResponse": map[string]any{
						"id":       call.ID,
						"name":     call.Name,
						"response": map[string]any{"result": sanitized},
					},
				})

				if imgRes, ok := toolResult.(*tools.ViewImageResult); ok && imgRes != nil && imgRes.InlineImage.Data != "" {
					toolResponseParts = append(toolResponseParts, map[string]any{
						"inlineData": map[string]any{
							"mimeType": imgRes.InlineImage.MimeType,
							"data":     imgRes.InlineImage.Data,
						},
					})
				} else if imgMap, ok := toolResult.(map[string]any); ok {
					if inlineImg, ok := imgMap["inlineImage"].(map[string]any); ok {
						mimeType, _ := inlineImg["mimeType"].(string)
						dataB64, _ := inlineImg["data"].(string)
						if mimeType != "" && dataB64 != "" {
							toolResponseParts = append(toolResponseParts, map[string]any{
								"inlineData": map[string]any{
									"mimeType": mimeType,
									"data":     dataB64,
								},
							})
						}
					}
				}
			}

			trBytes, _ := json.Marshal(toolResponseParts)
			data.History = append(data.History, workspace.SessionMessage{
				ID:        int64(len(data.History) + 1),
				Role:      "user",
				Parts:     trBytes,
				CreatedAt: time.Now().UTC().Format(time.RFC3339),
			})

			data.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
			_ = sae.saveSubSession(workspaceID, sessionID, data)
			keepRunning = true
		} else {
			keepRunning = false
			data.Status = "completed"
			data.Result = streamedText.String()
			data.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
			_ = sae.saveSubSession(workspaceID, sessionID, data)

			broadcast(sessionID, map[string]any{"type": "SUB_SESSION_COMPLETED", "subAgentId": subAgentID, "result": data.Result})
			broadcast(subAgentID, map[string]any{"type": "DONE"})
		}
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
