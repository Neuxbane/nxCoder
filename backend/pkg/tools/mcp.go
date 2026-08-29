package tools

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os/exec"
	"strings"
	"sync"
	"time"

	"github.com/neuxbane/nxcoder/backend/pkg/db"
)

type MCPManager struct {
	mu sync.RWMutex
}

var GlobalMCPManager = &MCPManager{}

type mcpRPCRequest struct {
	JSONRPC string `json:"jsonrpc"`
	ID      any    `json:"id,omitempty"`
	Method  string `json:"method"`
	Params  any    `json:"params,omitempty"`
}

type mcpRPCResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      any             `json:"id"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"error,omitempty"`
}

type mcpToolsListResult struct {
	Tools []struct {
		Name        string          `json:"name"`
		Description string          `json:"description"`
		InputSchema json.RawMessage `json:"inputSchema"`
	} `json:"tools"`
}

type mcpToolCallResult struct {
	Content []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	} `json:"content"`
	IsError bool `json:"isError"`
}

func parseCommandString(cmdStr string) (string, []string) {
	parts := strings.Fields(strings.TrimSpace(cmdStr))
	if len(parts) == 0 {
		return "", nil
	}
	return parts[0], parts[1:]
}

func (m *MCPManager) QueryServerTools(command string) ([]ToolFunctionDeclaration, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	bin, args := parseCommandString(command)
	if bin == "" {
		return nil, fmt.Errorf("empty command string")
	}

	cmd := exec.CommandContext(ctx, bin, args...)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}

	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("failed to start MCP process: %w", err)
	}
	defer func() {
		_ = stdin.Close()
		_ = cmd.Process.Kill()
	}()

	scanner := bufio.NewScanner(stdout)
	buf := make([]byte, 1024*1024)
	scanner.Buffer(buf, 10*1024*1024)

	// 1. Initialize
	initReq := mcpRPCRequest{
		JSONRPC: "2.0",
		ID:      1,
		Method:  "initialize",
		Params: map[string]any{
			"protocolVersion": "2024-11-05",
			"capabilities":    map[string]any{},
			"clientInfo": map[string]any{
				"name":    "nxCoder",
				"version": "1.0.0",
			},
		},
	}
	initBytes, _ := json.Marshal(initReq)
	_, _ = io.WriteString(stdin, string(initBytes)+"\n")

	// Read init response
	if !scanner.Scan() {
		return nil, fmt.Errorf("no response from MCP server on initialize")
	}

	// 2. Initialized notification
	notif := mcpRPCRequest{
		JSONRPC: "2.0",
		Method:  "notifications/initialized",
	}
	notifBytes, _ := json.Marshal(notif)
	_, _ = io.WriteString(stdin, string(notifBytes)+"\n")

	// 3. tools/list
	listReq := mcpRPCRequest{
		JSONRPC: "2.0",
		ID:      2,
		Method:  "tools/list",
		Params:  map[string]any{},
	}
	listBytes, _ := json.Marshal(listReq)
	_, _ = io.WriteString(stdin, string(listBytes)+"\n")

	if !scanner.Scan() {
		return nil, fmt.Errorf("no response from MCP server on tools/list")
	}

	var resp mcpRPCResponse
	if err := json.Unmarshal(scanner.Bytes(), &resp); err != nil {
		return nil, fmt.Errorf("failed to parse tools/list RPC response: %w", err)
	}

	if resp.Error != nil {
		return nil, fmt.Errorf("MCP error: %s (code %d)", resp.Error.Message, resp.Error.Code)
	}

	var listResult mcpToolsListResult
	if err := json.Unmarshal(resp.Result, &listResult); err != nil {
		return nil, fmt.Errorf("failed to parse tools/list result schema: %w", err)
	}

	var decls []ToolFunctionDeclaration
	for _, t := range listResult.Tools {
		var params ToolParameters
		if len(t.InputSchema) > 0 {
			_ = json.Unmarshal(t.InputSchema, &params)
		}
		if params.Type == "" {
			params.Type = "object"
		}
		decls = append(decls, ToolFunctionDeclaration{
			Name:        t.Name,
			Description: t.Description,
			Parameters:  params,
		})
	}

	return decls, nil
}

func (m *MCPManager) CallServerTool(command, toolName string, args map[string]any) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	bin, cmdArgs := parseCommandString(command)
	if bin == "" {
		return "", fmt.Errorf("empty command string")
	}

	cmd := exec.CommandContext(ctx, bin, cmdArgs...)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return "", err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return "", err
	}

	if err := cmd.Start(); err != nil {
		return "", fmt.Errorf("failed to start MCP process: %w", err)
	}
	defer func() {
		_ = stdin.Close()
		_ = cmd.Process.Kill()
	}()

	scanner := bufio.NewScanner(stdout)
	buf := make([]byte, 1024*1024)
	scanner.Buffer(buf, 10*1024*1024)

	// 1. Initialize
	initReq := mcpRPCRequest{
		JSONRPC: "2.0",
		ID:      1,
		Method:  "initialize",
		Params: map[string]any{
			"protocolVersion": "2024-11-05",
			"capabilities":    map[string]any{},
			"clientInfo": map[string]any{
				"name":    "nxCoder",
				"version": "1.0.0",
			},
		},
	}
	initBytes, _ := json.Marshal(initReq)
	_, _ = io.WriteString(stdin, string(initBytes)+"\n")

	if !scanner.Scan() {
		return "", fmt.Errorf("no response on initialize")
	}

	// 2. Initialized notification
	notif := mcpRPCRequest{
		JSONRPC: "2.0",
		Method:  "notifications/initialized",
	}
	notifBytes, _ := json.Marshal(notif)
	_, _ = io.WriteString(stdin, string(notifBytes)+"\n")

	// 3. tools/call
	callReq := mcpRPCRequest{
		JSONRPC: "2.0",
		ID:      2,
		Method:  "tools/call",
		Params: map[string]any{
			"name":      toolName,
			"arguments": args,
		},
	}
	callBytes, _ := json.Marshal(callReq)
	_, _ = io.WriteString(stdin, string(callBytes)+"\n")

	if !scanner.Scan() {
		return "", fmt.Errorf("no response from MCP server on tools/call")
	}

	var resp mcpRPCResponse
	if err := json.Unmarshal(scanner.Bytes(), &resp); err != nil {
		return "", fmt.Errorf("failed to parse tools/call RPC response: %w", err)
	}

	if resp.Error != nil {
		return "", fmt.Errorf("MCP error: %s (code %d)", resp.Error.Message, resp.Error.Code)
	}

	var callResult mcpToolCallResult
	if err := json.Unmarshal(resp.Result, &callResult); err == nil && len(callResult.Content) > 0 {
		var texts []string
		for _, c := range callResult.Content {
			texts = append(texts, c.Text)
		}
		res := strings.Join(texts, "\n")
		if callResult.IsError {
			return "", fmt.Errorf("MCP tool error: %s", res)
		}
		return res, nil
	}

	return string(resp.Result), nil
}

func BuildMCPToolGroup(server db.McpServer, tools []ToolFunctionDeclaration) ToolGroup {
	return ToolGroup{
		ID:            "mcp_" + server.ID,
		Source:        "mcp",
		Context:       "always",
		Label:         server.Name,
		Icon:          "fa-solid fa-plug",
		ActiveVerb:    "Calling MCP",
		CompletedVerb: "Called MCP",
		Enabled:       server.Active == 1,
		Tools:         tools,
	}
}
