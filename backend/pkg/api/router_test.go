package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"github.com/neuxbane/nxcoder/backend/pkg/db"
)

func TestAPIRouter(t *testing.T) {
	tempDir, err := os.MkdirTemp("", "nxcoder_api_test_*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tempDir)

	database, err := db.Open(tempDir)
	if err != nil {
		t.Fatalf("failed to open database: %v", err)
	}
	defer database.Close()

	server := NewServer(database, tempDir, tempDir)
	handler := server.Routes()

	// 1. Health check
	req := httptest.NewRequest("GET", "/api/health", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("health check returned status %d", rec.Code)
	}

	var healthResp map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &healthResp)
	if healthResp["status"] != "ok" || healthResp["engine"] != "go" {
		t.Fatalf("unexpected health response: %+v", healthResp)
	}

	// 2. Create API key
	keyBody, _ := json.Marshal(map[string]any{
		"name": "Test Key",
		"key":  "test-secret-12345",
	})
	reqKey := httptest.NewRequest("POST", "/api/key", bytes.NewReader(keyBody))
	reqKey.Header.Set("Content-Type", "application/json")
	recKey := httptest.NewRecorder()
	handler.ServeHTTP(recKey, reqKey)

	if recKey.Code != http.StatusCreated {
		t.Fatalf("create key returned status %d", recKey.Code)
	}

	// 3. Create instruction
	instBody, _ := json.Marshal(map[string]any{
		"name": "Coding Standard",
		"text": "Write modular code",
	})
	reqInst := httptest.NewRequest("POST", "/api/instruction", bytes.NewReader(instBody))
	reqInst.Header.Set("Content-Type", "application/json")
	recInst := httptest.NewRecorder()
	handler.ServeHTTP(recInst, reqInst)

	if recInst.Code != http.StatusCreated {
		t.Fatalf("create instruction returned status %d", recInst.Code)
	}

	// 4. Create Workspace
	wsBody, _ := json.Marshal(map[string]any{
		"name":        "Test Workspace",
		"folders_path": []string{tempDir},
	})
	reqWs := httptest.NewRequest("POST", "/api/workspace", bytes.NewReader(wsBody))
	reqWs.Header.Set("Content-Type", "application/json")
	recWs := httptest.NewRecorder()
	handler.ServeHTTP(recWs, reqWs)

	if recWs.Code != http.StatusCreated {
		t.Fatalf("create workspace returned status %d", recWs.Code)
	}

	var wsResp map[string]any
	_ = json.Unmarshal(recWs.Body.Bytes(), &wsResp)
	wsID, _ := wsResp["id"].(string)

	// 5. Create Session in Workspace
	sessBody, _ := json.Marshal(map[string]any{
		"name": "Test Chat Session",
	})
	reqSess := httptest.NewRequest("POST", "/api/workspace/"+wsID+"/session", bytes.NewReader(sessBody))
	reqSess.Header.Set("Content-Type", "application/json")
	recSess := httptest.NewRecorder()
	handler.ServeHTTP(recSess, reqSess)

	if recSess.Code != http.StatusCreated {
		t.Fatalf("create session returned status %d", recSess.Code)
	}

	var sessResp map[string]any
	_ = json.Unmarshal(recSess.Body.Bytes(), &sessResp)
	sessID, _ := sessResp["id"].(string)

	// 6. Post User Message
	msgBody, _ := json.Marshal(map[string]any{
		"message": "Hello nxCoder Go!",
	})
	reqMsg := httptest.NewRequest("POST", "/api/workspace/"+wsID+"/session/"+sessID, bytes.NewReader(msgBody))
	reqMsg.Header.Set("Content-Type", "application/json")
	recMsg := httptest.NewRecorder()
	handler.ServeHTTP(recMsg, reqMsg)

	if recMsg.Code != http.StatusOK {
		t.Fatalf("post message returned status %d: %s", recMsg.Code, recMsg.Body.String())
	}

	// 7. Get Session Messages
	reqGetMsgs := httptest.NewRequest("GET", "/api/workspace/"+wsID+"/session/"+sessID, nil)
	recGetMsgs := httptest.NewRecorder()
	handler.ServeHTTP(recGetMsgs, reqGetMsgs)

	if recGetMsgs.Code != http.StatusOK {
		t.Fatalf("get messages returned status %d", recGetMsgs.Code)
	}

	var msgsResp map[string]any
	_ = json.Unmarshal(recGetMsgs.Body.Bytes(), &msgsResp)
	if msgsResp["id"] != sessID {
		t.Fatalf("expected session ID %s, got %v", sessID, msgsResp["id"])
	}

	// 8. Post Assistant Message with Thoughts and Parts
	asstBody, _ := json.Marshal(map[string]any{
		"text":     "Here is the result",
		"thoughts": "Thinking deeply...",
		"parts": []map[string]any{
			{"thought": true, "text": "Thinking deeply..."},
			{"text": "Here is the result"},
		},
	})
	reqAsst := httptest.NewRequest("POST", "/api/workspace/"+wsID+"/session/"+sessID+"/assistant", bytes.NewReader(asstBody))
	reqAsst.Header.Set("Content-Type", "application/json")
	recAsst := httptest.NewRecorder()
	handler.ServeHTTP(recAsst, reqAsst)

	if recAsst.Code != http.StatusOK {
		t.Fatalf("post assistant message returned status %d: %s", recAsst.Code, recAsst.Body.String())
	}

	// 9. Re-fetch session messages and verify thoughts are present in history
	reqGetMsgs2 := httptest.NewRequest("GET", "/api/workspace/"+wsID+"/session/"+sessID, nil)
	recGetMsgs2 := httptest.NewRecorder()
	handler.ServeHTTP(recGetMsgs2, reqGetMsgs2)

	if recGetMsgs2.Code != http.StatusOK {
		t.Fatalf("get messages 2 returned status %d", recGetMsgs2.Code)
	}

	var msgsResp2 map[string]any
	_ = json.Unmarshal(recGetMsgs2.Body.Bytes(), &msgsResp2)
	history, _ := msgsResp2["sessionHistory"].([]any)
	if len(history) < 2 {
		t.Fatalf("expected at least 2 messages in session history, got %d", len(history))
	}

	lastMsg, _ := history[len(history)-1].(map[string]any)
	if lastMsg["role"] != "model" {
		t.Fatalf("expected last message role to be model, got %v", lastMsg["role"])
	}

	// 10. Fork a new deep thread / branch off message 1 (User Msg 1)
	firstMsg, _ := history[0].(map[string]any)
	firstMsgID := int64(firstMsg["id"].(float64))

	forkBody, _ := json.Marshal(map[string]any{
		"message":  "Branching to alternative path",
		"parentId": firstMsgID,
	})
	reqFork := httptest.NewRequest("POST", "/api/workspace/"+wsID+"/session/"+sessID, bytes.NewReader(forkBody))
	reqFork.Header.Set("Content-Type", "application/json")
	recFork := httptest.NewRecorder()
	handler.ServeHTTP(recFork, reqFork)

	if recFork.Code != http.StatusOK {
		t.Fatalf("fork turn returned status %d: %s", recFork.Code, recFork.Body.String())
	}

	// 11. Fetch branch points and verify there is now a branch point with 2 alternatives
	reqBranches := httptest.NewRequest("GET", "/api/workspace/"+wsID+"/session/"+sessID+"/branches", nil)
	recBranches := httptest.NewRecorder()
	handler.ServeHTTP(recBranches, reqBranches)

	if recBranches.Code != http.StatusOK {
		t.Fatalf("get branches returned status %d: %s", recBranches.Code, recBranches.Body.String())
	}

	var branchResp map[string]any
	_ = json.Unmarshal(recBranches.Body.Bytes(), &branchResp)
	bPoints, _ := branchResp["branchPoints"].([]any)
	if len(bPoints) == 0 {
		t.Fatalf("expected at least 1 branch point after forking thread")
	}

	// 12. Create Conditional Instruction & Test Matching
	condBody, _ := json.Marshal(map[string]any{
		"title":          "SQL Safety",
		"description":    "Database queries postgres migrations",
		"instruction":    "Always sanitize SQL inputs",
		"is_conditional": true,
		"enabled":        true,
	})
	reqCond := httptest.NewRequest("POST", "/api/instruction", bytes.NewReader(condBody))
	reqCond.Header.Set("Content-Type", "application/json")
	recCond := httptest.NewRecorder()
	handler.ServeHTTP(recCond, reqCond)
	if recCond.Code != http.StatusCreated {
		t.Fatalf("create conditional instruction failed: %d", recCond.Code)
	}

	// 13. Test Settings Top-K
	topKBody, _ := json.Marshal(map[string]any{"top_k": 2})
	reqTopK := httptest.NewRequest("POST", "/api/settings/instruction-top-k", bytes.NewReader(topKBody))
	recTopK := httptest.NewRecorder()
	handler.ServeHTTP(recTopK, reqTopK)
	if recTopK.Code != http.StatusOK {
		t.Fatalf("set top_k failed: %d", recTopK.Code)
	}

	// 14. Test Match Endpoint
	reqMatch := httptest.NewRequest("GET", "/api/instruction/match?prompt=how+to+run+postgres+migration", nil)
	recMatch := httptest.NewRecorder()
	handler.ServeHTTP(recMatch, reqMatch)
	if recMatch.Code != http.StatusOK {
		t.Fatalf("match instruction failed: %d", recMatch.Code)
	}
	// 15. Test Settings Tool Output Max Chars
	maxCharsBody, _ := json.Marshal(map[string]any{"max_chars": 3000})
	reqMaxChars := httptest.NewRequest("POST", "/api/settings/tool-output-max-chars", bytes.NewReader(maxCharsBody))
	recMaxChars := httptest.NewRecorder()
	handler.ServeHTTP(recMaxChars, reqMaxChars)
	if recMaxChars.Code != http.StatusOK {
		t.Fatalf("set tool_output_max_chars failed: %d", recMaxChars.Code)
	}

	reqGetMaxChars := httptest.NewRequest("GET", "/api/settings/tool-output-max-chars", nil)
	recGetMaxChars := httptest.NewRecorder()
	handler.ServeHTTP(recGetMaxChars, reqGetMaxChars)
	if recGetMaxChars.Code != http.StatusOK {
		t.Fatalf("get tool_output_max_chars failed: %d", recGetMaxChars.Code)
	}
	var maxCharsData map[string]any
	_ = json.Unmarshal(recGetMaxChars.Body.Bytes(), &maxCharsData)
	if mc, ok := maxCharsData["max_chars"].(float64); !ok || int(mc) != 3000 {
		t.Fatalf("expected max_chars 3000, got %v", maxCharsData["max_chars"])
	}
}
