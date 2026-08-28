package providers

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

type OpenAIClient struct {
	BaseURL string
	APIKey  string
	Model   string
	client  *http.Client
}

func NewOpenAIClient(baseURL, apiKey, model string) *OpenAIClient {
	if baseURL == "" {
		baseURL = "https://api.openai.com/v1"
	}
	baseURL = strings.TrimSuffix(baseURL, "/")
	if model == "" {
		model = "gpt-4o"
	}
	return &OpenAIClient{
		BaseURL: baseURL,
		APIKey:  apiKey,
		Model:   model,
		client: &http.Client{
			Timeout: 10 * time.Minute,
		},
	}
}

type OpenAIMessage struct {
	Role       string           `json:"role"`
	Content    string           `json:"content,omitempty"`
	ToolCalls  []OpenAIToolCall `json:"tool_calls,omitempty"`
	ToolCallID string           `json:"tool_call_id,omitempty"`
}

type OpenAIToolCall struct {
	ID       string `json:"id"`
	Type     string `json:"type"`
	Function struct {
		Name      string `json:"name"`
		Arguments string `json:"arguments"`
	} `json:"function"`
}

type OpenAIRequest struct {
	Model    string          `json:"model"`
	Messages []OpenAIMessage `json:"messages"`
	Tools    []map[string]any `json:"tools,omitempty"`
	Stream   bool            `json:"stream"`
}

type OpenAIChoice struct {
	Delta struct {
		Content          string `json:"content,omitempty"`
		ReasoningContent string `json:"reasoning_content,omitempty"`
		ToolCalls        []struct {
			Index    int    `json:"index"`
			ID       string `json:"id,omitempty"`
			Type     string `json:"type,omitempty"`
			Function struct {
				Name      string `json:"name,omitempty"`
				Arguments string `json:"arguments,omitempty"`
			} `json:"function,omitempty"`
		} `json:"tool_calls,omitempty"`
	} `json:"delta"`
	FinishReason string `json:"finish_reason"`
}

type OpenAIStreamChunk struct {
	Choices []OpenAIChoice `json:"choices"`
	Error   *struct {
		Message string `json:"message"`
		Type    string `json:"type"`
	} `json:"error,omitempty"`
}

func (c *OpenAIClient) StreamChatCompletions(ctx context.Context, messages []OpenAIMessage, tools []map[string]any, cb StreamCallbacks) error {
	url := fmt.Sprintf("%s/chat/completions", c.BaseURL)

	reqBody, err := json.Marshal(OpenAIRequest{
		Model:    c.Model,
		Messages: messages,
		Tools:    tools,
		Stream:   true,
	})
	if err != nil {
		return fmt.Errorf("failed to marshal request: %w", err)
	}

	httpReq, err := http.NewRequestWithContext(ctx, "POST", url, bytes.NewReader(reqBody))
	if err != nil {
		return fmt.Errorf("failed to create http request: %w", err)
	}

	httpReq.Header.Set("Content-Type", "application/json")
	if c.APIKey != "" {
		httpReq.Header.Set("Authorization", "Bearer "+c.APIKey)
	}

	resp, err := c.client.Do(httpReq)
	if err != nil {
		return fmt.Errorf("openai request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("openai api error (HTTP %d): %s", resp.StatusCode, string(body))
	}

	activeToolCalls := make(map[int]*OpenAIToolCall)
	reader := bufio.NewReader(resp.Body)

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}

		line, err := reader.ReadString('\n')
		if err != nil {
			if err == io.EOF {
				break
			}
			return err
		}

		line = strings.TrimSpace(line)
		if line == "data: [DONE]" {
			break
		}
		if strings.HasPrefix(line, "data: ") {
			jsonStr := strings.TrimPrefix(line, "data: ")
			var chunk OpenAIStreamChunk
			if err := json.Unmarshal([]byte(jsonStr), &chunk); err == nil {
				if chunk.Error != nil {
					return fmt.Errorf("openai streaming error: %s", chunk.Error.Message)
				}
				for _, choice := range chunk.Choices {
					if choice.Delta.ReasoningContent != "" && cb.OnThoughtChunk != nil {
						cb.OnThoughtChunk(choice.Delta.ReasoningContent)
					}
					if choice.Delta.Content != "" && cb.OnTextChunk != nil {
						cb.OnTextChunk(choice.Delta.Content)
					}
					for _, tc := range choice.Delta.ToolCalls {
						idx := tc.Index
						if activeToolCalls[idx] == nil {
							activeToolCalls[idx] = &OpenAIToolCall{
								ID:   tc.ID,
								Type: tc.Type,
							}
						}
						if tc.ID != "" {
							activeToolCalls[idx].ID = tc.ID
						}
						if tc.Function.Name != "" {
							activeToolCalls[idx].Function.Name += tc.Function.Name
						}
						if tc.Function.Arguments != "" {
							activeToolCalls[idx].Function.Arguments += tc.Function.Arguments
						}
					}
				}
			}
		}
	}

	for _, tc := range activeToolCalls {
		var args map[string]any
		_ = json.Unmarshal([]byte(tc.Function.Arguments), &args)
		if args == nil {
			args = make(map[string]any)
		}
		if cb.OnFunctionCall != nil {
			cb.OnFunctionCall(FunctionCall{
				ID:   tc.ID,
				Name: tc.Function.Name,
				Args: args,
			})
		}
	}

	return nil
}
