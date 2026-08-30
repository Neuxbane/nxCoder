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

type GeminiClient struct {
	APIKey string
	Model  string
	client *http.Client
}

func NewGeminiClient(apiKey, model string) *GeminiClient {
	if model == "" {
		model = "gemini-2.5-flash"
	}
	return &GeminiClient{
		APIKey: apiKey,
		Model:  model,
		client: &http.Client{
			Timeout: 10 * time.Minute,
		},
	}
}

type GeminiBlob struct {
	MimeType string `json:"mimeType"`
	Data     string `json:"data"`
}

type GeminiPart struct {
	Text         string        `json:"text,omitempty"`
	Thought      bool          `json:"thought,omitempty"`
	InlineData   *GeminiBlob   `json:"inlineData,omitempty"`
	FunctionCall *FunctionCall `json:"functionCall,omitempty"`
	FunctionResp *FunctionResp `json:"functionResponse,omitempty"`
}

type FunctionCall struct {
	ID   string         `json:"-"`
	Name string         `json:"name"`
	Args map[string]any `json:"args"`
}

type FunctionResp struct {
	ID       string         `json:"-"`
	Name     string         `json:"name"`
	Response map[string]any `json:"response"`
}

type GeminiContent struct {
	Role  string       `json:"role"`
	Parts []GeminiPart `json:"parts"`
}

type GeminiRequest struct {
	Contents          []GeminiContent  `json:"contents"`
	SystemInstruction *GeminiContent   `json:"systemInstruction,omitempty"`
	Tools             []map[string]any `json:"tools,omitempty"`
}

type GeminiCandidate struct {
	Content struct {
		Parts []GeminiPart `json:"parts"`
		Role  string       `json:"role"`
	} `json:"content"`
	FinishReason string `json:"finishReason"`
}

type GeminiResponse struct {
	Candidates []GeminiCandidate `json:"candidates"`
	Error      *struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
		Status  string `json:"status"`
	} `json:"error,omitempty"`
}

type StreamCallbacks struct {
	OnTextChunk    func(string)
	OnThoughtChunk func(string)
	OnFunctionCall func(FunctionCall)
}

func (g *GeminiClient) StreamGenerateContent(ctx context.Context, req GeminiRequest, cb StreamCallbacks) error {
	url := fmt.Sprintf("https://generativelanguage.googleapis.com/v1beta/models/%s:streamGenerateContent?alt=sse&key=%s", g.Model, g.APIKey)

	reqBody, err := json.Marshal(req)
	if err != nil {
		return fmt.Errorf("failed to marshal gemini request: %w", err)
	}

	httpReq, err := http.NewRequestWithContext(ctx, "POST", url, bytes.NewReader(reqBody))
	if err != nil {
		return fmt.Errorf("failed to create http request: %w", err)
	}
	httpReq.Header.Set("Content-Type", "application/json")

	resp, err := g.client.Do(httpReq)
	if err != nil {
		return fmt.Errorf("gemini request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("gemini api error (HTTP %d): %s", resp.StatusCode, string(body))
	}

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
		if strings.HasPrefix(line, "data: ") {
			jsonStr := strings.TrimPrefix(line, "data: ")
			var geminiResp GeminiResponse
			if err := json.Unmarshal([]byte(jsonStr), &geminiResp); err == nil {
				if geminiResp.Error != nil {
					return fmt.Errorf("gemini streaming error: %s (code %d)", geminiResp.Error.Message, geminiResp.Error.Code)
				}
				for _, cand := range geminiResp.Candidates {
					for _, part := range cand.Content.Parts {
						if part.Thought && part.Text != "" {
							if cb.OnThoughtChunk != nil {
								cb.OnThoughtChunk(part.Text)
							}
						} else if part.Text != "" {
							if cb.OnTextChunk != nil {
								cb.OnTextChunk(part.Text)
							}
						}
						if part.FunctionCall != nil {
							if cb.OnFunctionCall != nil {
								cb.OnFunctionCall(*part.FunctionCall)
							}
						}
					}
				}
			}
		}
	}

	return nil
}
