package api

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/go-chi/cors"
	"github.com/neuxbane/nxcoder/backend/pkg/agent"
	"github.com/neuxbane/nxcoder/backend/pkg/db"
	"github.com/neuxbane/nxcoder/backend/pkg/tools"
	"github.com/neuxbane/nxcoder/backend/pkg/workspace"
)

type Server struct {
	db              *db.DB
	hub             *Hub
	terminalManager *tools.TerminalManager
	approvalManager *tools.ApprovalManager
	agentEngine     *agent.AgentEngine
	staticDir       string
	baseDir         string
}

func NewServer(database *db.DB, staticDir string, dataDir string) *Server {
	if dataDir == "" {
		dataDir = staticDir
	}
	tm := tools.NewTerminalManager()
	am := tools.NewApprovalManager()
	agentEng := agent.NewAgentEngine(database, tm, am, dataDir)
	hub := NewHub(agentEng, am)
	go hub.Run()

	return &Server{
		db:              database,
		hub:             hub,
		terminalManager: tm,
		approvalManager: am,
		agentEngine:     agentEng,
		staticDir:       staticDir,
		baseDir:         dataDir,
	}
}

func (s *Server) Routes() http.Handler {
	r := chi.NewRouter()

	r.Use(middleware.RequestID)
	r.Use(middleware.RealIP)
	r.Use(middleware.Logger)
	r.Use(middleware.Recoverer)

	r.Use(cors.Handler(cors.Options{
		AllowedOrigins:   []string{"*"},
		AllowedMethods:   []string{"GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"},
		AllowedHeaders:   []string{"*"},
		AllowCredentials: true,
	}))

	// Health check
	r.Get("/api/health", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{
			"status": "ok",
			"engine": "go",
		})
	})

	// Folder Browser & Native Pickers
	r.Get("/api/folder", s.handleFolderBrowser)
	r.Get("/api/find-folder", s.handleFindFolder)
	r.Get("/api/pick-folder", s.handlePickFolder)
	r.Post("/api/open-window", s.handleOpenWindow)
	r.Get("/api/read-file", s.handleReadLocalFile)
	r.Post("/api/read-file", s.handleReadLocalFile)

	// API Keys
	r.Get("/api/key", s.handleGetApiKeys)
	r.Post("/api/key", s.handleCreateApiKey)
	r.Patch("/api/key/{id}/toggle", s.handleToggleApiKey)
	r.Put("/api/key/{id}", s.handleUpdateApiKey)
	r.Delete("/api/key/{id}", s.handleDeleteApiKey)

	// Instructions & Conditional Prompt Rules
	r.Get("/api/instruction", s.handleGetInstructions)
	r.Post("/api/instruction", s.handleCreateInstruction)
	r.Put("/api/instruction/{id}", s.handleUpdateInstruction)
	r.Post("/api/instruction/{id}/toggle", s.handleToggleInstruction)
	r.Delete("/api/instruction/{id}", s.handleDeleteInstruction)
	r.Get("/api/instruction/match", s.handleMatchInstructions)
	r.Get("/api/settings/instruction-top-k", s.handleGetInstructionTopK)
	r.Post("/api/settings/instruction-top-k", s.handleSetInstructionTopK)

	// Workspaces
	r.Get("/api/workspace", s.handleGetWorkspaces)
	r.Post("/api/workspace", s.handleCreateWorkspace)
	r.Put("/api/workspace/{id}", s.handleUpdateWorkspace)
	r.Delete("/api/workspace/{id}", s.handleDeleteWorkspace)
	r.Get("/api/workspace/{id}/security", s.handleGetWorkspaceSecurity)
	r.Put("/api/workspace/{id}/security", s.handleUpdateWorkspaceSecurity)

	// Sessions
	r.Get("/api/workspace/{id}/session", s.handleGetSessions)
	r.Post("/api/workspace/{id}/session", s.handleCreateSession)
	r.Put("/api/workspace/{id}/session/{sessionID}", s.handleUpdateSessionName)
	r.Delete("/api/workspace/{id}/session/{sessionID}", s.handleDeleteSession)
	r.Get("/api/workspace/{id}/session/{sessionID}", s.handleGetSessionMessages)
	r.Post("/api/workspace/{id}/session/{sessionID}", s.handlePostUserMessage)
	r.Post("/api/workspace/{id}/session/{sessionID}/message", s.handlePostUserMessage)
	r.Post("/api/workspace/{id}/session/{sessionID}/assistant", s.handlePostAssistantMessage)
	r.Post("/api/workspace/{id}/session/{sessionID}/tools/execute", s.handleExecuteTool)

	// Rollback, Source Control, Branches & Artifacts
	r.Get("/api/workspace/{id}/session/{sessionID}/rollback-preview/{messageID}", s.handleRollbackPreview)
	r.Post("/api/workspace/{id}/session/{sessionID}/rollback/{messageID}", s.handleRollbackExecute)
	r.Get("/api/workspace/{id}/source-control/files", s.handleSourceControlFiles)
	r.Post("/api/workspace/{id}/source-control/ignore", s.handleSourceControlIgnore)
	r.Get("/api/workspace/{id}/source-control/timeline", s.handleSourceControlTimeline)
	r.Get("/api/workspace/{id}/session/{sessionID}/branches", s.handleGetSessionBranches)
	r.Post("/api/workspace/{id}/session/{sessionID}/checkout-branch/{branchName}", s.handleCheckoutBranch)
	r.Get("/api/workspace/{id}/session/{sessionID}/artifacts", s.handleGetArtifacts)
	r.Get("/api/workspace/{id}/session/{sessionID}/artifacts/read", s.handleReadArtifact)
	r.Get("/api/workspace/{id}/session/{sessionID}/sub-sessions", s.handleGetSubSessions)
	r.Get("/api/workspace/{id}/session/{sessionID}/sub-session/{subSessionID}", s.handleGetSubSessionDetails)

	// Marketplace
	r.Get("/api/marketplace/sources", s.handleGetMarketplaceSources)
	r.Post("/api/marketplace/sources", s.handleCreateMarketplaceSource)
	r.Delete("/api/marketplace/sources/{id}", s.handleDeleteMarketplaceSource)
	r.Get("/api/marketplace/providers", s.handleGetMarketplaceProviders)
	r.Get("/api/marketplace/providers/configs", s.handleGetProviderConfigs)
	r.Post("/api/marketplace/providers/configs", s.handleCreateProviderConfig)
	r.Put("/api/marketplace/providers/configs/{id}", s.handleUpdateProviderConfig)
	r.Delete("/api/marketplace/providers/configs/{id}", s.handleDeleteProviderConfig)
	r.Post("/api/marketplace/providers/configs/{id}/active", s.handleSetActiveProviderConfig)
	r.Get("/api/marketplace/mcps", s.handleGetMcpServers)
	r.Post("/api/marketplace/mcps", s.handleCreateMcpServer)
	r.Delete("/api/marketplace/mcps/{id}", s.handleDeleteMcpServer)
	r.Post("/api/marketplace/mcps/{id}/toggle", s.handleToggleMcpServer)
	r.Post("/api/marketplace/sync", s.handleSyncMarketplace)

	// Custom Model Providers & Provider Extension Files
	r.Get("/api/custom-providers", s.handleGetCustomProviders)
	r.Post("/api/custom-providers", s.handleCreateCustomProvider)
	r.Put("/api/custom-providers/{id}", s.handleUpdateCustomProvider)
	r.Delete("/api/custom-providers/{id}", s.handleDeleteCustomProvider)
	r.Put("/api/custom-providers/{id}/default", s.handleSetDefaultCustomProvider)
	r.Get("/api/providers/files", s.handleGetProviderFiles)
	r.Post("/api/providers/files", s.handleSaveProviderFile)
	r.Post("/api/providers/import-url", s.handleImportProviderFromURL)
	r.Delete("/api/providers/files/{filename}", s.handleDeleteProviderFile)

	// Modular Tools, JS Scripts & MCP Servers
	r.Get("/api/tools", s.handleGetToolGroups)
	r.Post("/api/tools/group/{id}/toggle", s.handleToggleToolGroup)
	r.Get("/api/tool-scripts", s.handleGetToolScripts)
	r.Post("/api/tool-scripts", s.handleSaveToolScript)
	r.Post("/api/tool-scripts/import-url", s.handleImportToolScriptFromURL)
	r.Delete("/api/tool-scripts/{id}", s.handleDeleteToolScript)
	r.Put("/api/tool-scripts/{id}/toggle", s.handleToggleToolScript)
	r.Get("/api/mcp", s.handleGetMcpServers)
	r.Post("/api/mcp", s.handleCreateMcpServer)
	r.Delete("/api/mcp/{id}", s.handleDeleteMcpServer)
	r.Put("/api/mcp/{id}/toggle", s.handleToggleMcpServer)
	r.Get("/api/mcp/{id}/tools", s.handleGetMcpServerTools)

	// WebSockets
	r.HandleFunc("/stream/workspace/{id}/session/{sessionID}", s.hub.HandleWebSocket)
	r.HandleFunc("/stream/workspace/{id}/session/{sessionID}/sub-session/{subSessionID}", s.hub.HandleWebSocket)

	// Serve Static Files & SPA Fallback
	if s.staticDir != "" {
		fileServer := http.FileServer(http.Dir(s.staticDir))
		r.Handle("/*", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			path := filepath.Join(s.staticDir, r.URL.Path)
			if _, err := os.Stat(path); os.IsNotExist(err) {
				http.ServeFile(w, r, filepath.Join(s.staticDir, "index.html"))
				return
			}
			fileServer.ServeHTTP(w, r)
		}))
	}

	return r
}

func (s *Server) getFoldersForWorkspace(workspaceID string) []string {
	ws, err := s.db.GetWorkspaceByID(workspaceID)
	if err != nil || ws == nil {
		return []string{}
	}
	var folders []string
	_ = json.Unmarshal(ws.FoldersPath, &folders)
	return folders
}

func (s *Server) handleFolderBrowser(w http.ResponseWriter, r *http.Request) {
	target := r.URL.Query().Get("path")
	if target == "" || target == "undefined" || target == "null" {
		target, _ = os.UserHomeDir()
	}

	entries, err := os.ReadDir(target)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	type FolderItem struct {
		Name     string `json:"name"`
		Type     string `json:"type"`
		FullPath string `json:"full_path"`
		Path     string `json:"path"`
		IsFolder bool   `json:"isFolder"`
	}

	items := make([]FolderItem, 0)
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".") {
			continue
		}
		itemType := "file"
		if entry.IsDir() {
			itemType = "folder"
		}
		full := filepath.Join(target, entry.Name())
		items = append(items, FolderItem{
			Name:     entry.Name(),
			Type:     itemType,
			FullPath: full,
			Path:     full,
			IsFolder: entry.IsDir(),
		})
	}

	gitBranch := ""
	if out, err := exec.Command("git", "-C", target, "branch", "--show-current").Output(); err == nil {
		gitBranch = strings.TrimSpace(string(out))
	}

	json.NewEncoder(w).Encode(map[string]any{
		"currentPath": target,
		"parentPath":  filepath.Dir(target),
		"items":       items,
		"folders":     items,
		"gitBranch":   gitBranch,
	})
}

func (s *Server) handlePickFolder(w http.ResponseWriter, r *http.Request) {
	var cmd *exec.Cmd
	if _, err := exec.LookPath("zenity"); err == nil {
		cmd = exec.Command("zenity", "--file-selection", "--directory", "--title=Select Workspace Project Folder")
	} else if _, err := exec.LookPath("kdialog"); err == nil {
		cmd = exec.Command("kdialog", "--getexistingdirectory")
	} else if _, err := exec.LookPath("qarma"); err == nil {
		cmd = exec.Command("qarma", "--file-selection", "--directory", "--title=Select Workspace Project Folder")
	}

	if cmd != nil {
		out, err := cmd.Output()
		if err == nil {
			selectedPath := strings.TrimSpace(string(out))
			if selectedPath != "" {
				json.NewEncoder(w).Encode(map[string]any{
					"path": selectedPath,
					"name": filepath.Base(selectedPath),
				})
				return
			}
		}
	}

	json.NewEncoder(w).Encode(map[string]any{"canceled": true})
}

func (s *Server) handleFindFolder(w http.ResponseWriter, r *http.Request) {
	name := r.URL.Query().Get("name")
	if name == "" {
		http.Error(w, "Missing name parameter", http.StatusBadRequest)
		return
	}

	if filepath.IsAbs(name) {
		if stat, err := os.Stat(name); err == nil && stat.IsDir() {
			json.NewEncoder(w).Encode(map[string]any{
				"path": name,
				"name": filepath.Base(name),
			})
			return
		}
	}

	home, _ := os.UserHomeDir()
	searchRoots := []string{
		home,
		filepath.Join(home, "Projects"),
		filepath.Join(home, "Desktop"),
		filepath.Join(home, "Documents"),
		".",
	}

	for _, root := range searchRoots {
		target := filepath.Join(root, name)
		if stat, err := os.Stat(target); err == nil && stat.IsDir() {
			abs, _ := filepath.Abs(target)
			json.NewEncoder(w).Encode(map[string]any{
				"path": abs,
				"name": filepath.Base(abs),
			})
			return
		}
	}

	http.Error(w, "Folder not found", http.StatusNotFound)
}

func (s *Server) handleReadLocalFile(w http.ResponseWriter, r *http.Request) {
	filePath := r.URL.Query().Get("path")
	if filePath == "" {
		var body struct {
			Path string `json:"path"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		filePath = body.Path
	}

	if filePath == "" {
		http.Error(w, "Missing file path", http.StatusBadRequest)
		return
	}

	// Expand ~ to home directory if present
	if strings.HasPrefix(filePath, "~/") {
		if home, err := os.UserHomeDir(); err == nil {
			filePath = filepath.Join(home, filePath[2:])
		}
	}

	info, err := os.Stat(filePath)
	if err != nil {
		http.Error(w, "File not found: "+err.Error(), http.StatusNotFound)
		return
	}

	if info.IsDir() {
		type DroppedFileInfo struct {
			Name         string `json:"name"`
			RelativePath string `json:"relativePath"`
			FullPath     string `json:"fullPath"`
			Size         int64  `json:"size"`
			Mime         string `json:"mime"`
		}
		var results []DroppedFileInfo
		baseDir := filepath.Dir(filePath)
		_ = filepath.Walk(filePath, func(p string, fi os.FileInfo, err error) error {
			if err != nil || fi.IsDir() {
				return nil
			}
			rel, _ := filepath.Rel(baseDir, p)
			ext := filepath.Ext(p)
			mimeType := mime.TypeByExtension(ext)
			if mimeType == "" {
				mimeType = "application/octet-stream"
			}
			results = append(results, DroppedFileInfo{
				Name:         fi.Name(),
				RelativePath: filepath.ToSlash(rel),
				FullPath:     p,
				Size:         fi.Size(),
				Mime:         mimeType,
			})
			return nil
		})
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{
			"isDirectory": true,
			"files":       results,
		})
		return
	}

	ext := filepath.Ext(filePath)
	mimeType := mime.TypeByExtension(ext)
	if mimeType == "" {
		mimeType = "application/octet-stream"
	}

	data, err := os.ReadFile(filePath)
	if err != nil {
		http.Error(w, "Failed to read file: "+err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", mimeType)
	w.Header().Set("Content-Length", strconv.Itoa(len(data)))
	w.Header().Set("X-File-Name", filepath.Base(filePath))
	w.Header().Set("X-File-Size", strconv.FormatInt(info.Size(), 10))
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}

func (s *Server) handleOpenWindow(w http.ResponseWriter, r *http.Request) {
	var req struct {
		URL string `json:"url"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.URL == "" {
		http.Error(w, "Invalid URL", http.StatusBadRequest)
		return
	}

	var cmd *exec.Cmd
	switch {
	case execLookPath("xdg-open"):
		cmd = exec.Command("xdg-open", req.URL)
	case execLookPath("open"):
		cmd = exec.Command("open", req.URL)
	case execLookPath("rundll32"):
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", req.URL)
	default:
		cmd = exec.Command("x-www-browser", req.URL)
	}

	if cmd != nil {
		_ = cmd.Start()
	}
	json.NewEncoder(w).Encode(map[string]any{"status": "ok", "opened": req.URL})
}

func execLookPath(file string) bool {
	_, err := exec.LookPath(file)
	return err == nil
}

// API Keys
func (s *Server) handleGetApiKeys(w http.ResponseWriter, r *http.Request) {
	keys, err := s.db.GetApiKeys()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	json.NewEncoder(w).Encode(keys)
}

func (s *Server) handleCreateApiKey(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name       string `json:"name"`
		Key        string `json:"key"`
		ProviderID string `json:"provider_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Name == "" || body.Key == "" {
		http.Error(w, "Missing name or key", http.StatusBadRequest)
		return
	}

	key, err := s.db.CreateApiKey(body.Name, body.Key, body.ProviderID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(key)
}

func (s *Server) handleToggleApiKey(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	var body struct {
		Active int `json:"active"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	if err := s.db.ToggleApiKey(id, body.Active); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	json.NewEncoder(w).Encode(map[string]any{"success": true})
}

func (s *Server) handleUpdateApiKey(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	var body struct {
		Name string `json:"name"`
		Key  string `json:"key"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Name == "" || body.Key == "" {
		http.Error(w, "Missing name or key", http.StatusBadRequest)
		return
	}
	if err := s.db.UpdateApiKey(id, body.Name, body.Key); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	json.NewEncoder(w).Encode(map[string]any{"success": true})
}

func (s *Server) handleDeleteApiKey(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if err := s.db.DeleteApiKey(id); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	json.NewEncoder(w).Encode(map[string]any{"success": true})
}

// Instructions
func (s *Server) handleGetInstructions(w http.ResponseWriter, r *http.Request) {
	list, err := s.db.GetInstructions()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	json.NewEncoder(w).Encode(list)
}

func (s *Server) handleCreateInstruction(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name          string    `json:"name"`
		Title         string    `json:"title"`
		Description   string    `json:"description"`
		Text          string    `json:"text"`
		Instruction   string    `json:"instruction"`
		IsConditional bool      `json:"is_conditional"`
		Enabled       *bool     `json:"enabled"`
		Embedding     []float32 `json:"embedding"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "Invalid JSON payload", http.StatusBadRequest)
		return
	}

	name := body.Title
	if name == "" {
		name = body.Name
	}
	text := body.Instruction
	if text == "" {
		text = body.Text
	}

	if name == "" || text == "" {
		http.Error(w, "Missing title or instruction content", http.StatusBadRequest)
		return
	}

	enabled := true
	if body.Enabled != nil {
		enabled = *body.Enabled
	}

	inst, err := s.db.CreateInstruction(name, body.Description, text, body.IsConditional, enabled, body.Embedding)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(inst)
}

func (s *Server) handleUpdateInstruction(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	var body struct {
		Name          string    `json:"name"`
		Title         string    `json:"title"`
		Description   string    `json:"description"`
		Text          string    `json:"text"`
		Instruction   string    `json:"instruction"`
		IsConditional bool      `json:"is_conditional"`
		Enabled       *bool     `json:"enabled"`
		Embedding     []float32 `json:"embedding"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	name := body.Title
	if name == "" {
		name = body.Name
	}
	text := body.Instruction
	if text == "" {
		text = body.Text
	}

	enabled := true
	if body.Enabled != nil {
		enabled = *body.Enabled
	}

	if err := s.db.UpdateInstruction(id, name, body.Description, text, body.IsConditional, enabled, body.Embedding); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	json.NewEncoder(w).Encode(map[string]any{"success": true})
}

func (s *Server) handleToggleInstruction(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	var body struct {
		Enabled bool `json:"enabled"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if err := s.db.ToggleInstruction(id, body.Enabled); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	json.NewEncoder(w).Encode(map[string]any{"success": true, "enabled": body.Enabled})
}

func (s *Server) handleDeleteInstruction(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if err := s.db.DeleteInstruction(id); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	json.NewEncoder(w).Encode(map[string]any{"success": true})
}

func (s *Server) handleMatchInstructions(w http.ResponseWriter, r *http.Request) {
	prompt := r.URL.Query().Get("prompt")
	allInsts, err := s.db.GetInstructions()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	topK := 3
	topKStr := s.db.GetAppSetting("instruction_top_k", "3")
	if k, err := strconv.Atoi(topKStr); err == nil && k > 0 {
		topK = k
	}

	matched := agent.MatchInstructions(allInsts, prompt, topK)
	var promptSnippet strings.Builder
	if len(matched) > 0 {
		promptSnippet.WriteString("\n\n=========================================\n=== ACTIVE INSTRUCTIONS & RULES ===\n=========================================\n")
		for _, mi := range matched {
			condTag := "ALWAYS-ON"
			if mi.IsConditional {
				condTag = "MATCHED CONDITIONAL"
			}
			promptSnippet.WriteString(fmt.Sprintf("\n--- [%s] %s ---\n%s\n", condTag, mi.Name, mi.Text))
		}
		promptSnippet.WriteString("=========================================\n")
	}

	json.NewEncoder(w).Encode(map[string]any{
		"matched": matched,
		"top_k":   topK,
		"snippet": promptSnippet.String(),
	})
}

func (s *Server) handleGetInstructionTopK(w http.ResponseWriter, r *http.Request) {
	topKStr := s.db.GetAppSetting("instruction_top_k", "3")
	topK, _ := strconv.Atoi(topKStr)
	if topK <= 0 {
		topK = 3
	}
	json.NewEncoder(w).Encode(map[string]any{"top_k": topK})
}

func (s *Server) handleSetInstructionTopK(w http.ResponseWriter, r *http.Request) {
	var body struct {
		TopK int `json:"top_k"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.TopK <= 0 {
		http.Error(w, "Invalid top_k (must be > 0)", http.StatusBadRequest)
		return
	}
	if err := s.db.SetAppSetting("instruction_top_k", strconv.Itoa(body.TopK)); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	json.NewEncoder(w).Encode(map[string]any{"success": true, "top_k": body.TopK})
}

// Workspaces
func (s *Server) handleGetWorkspaces(w http.ResponseWriter, r *http.Request) {
	list, err := s.db.GetWorkspaces()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	json.NewEncoder(w).Encode(list)
}

func (s *Server) handleCreateWorkspace(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name          string   `json:"name"`
		FoldersPath   []string `json:"folders_path"`
		InstructionID *string  `json:"instruction_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Name == "" {
		http.Error(w, "Invalid payload", http.StatusBadRequest)
		return
	}
	ws, err := s.db.CreateWorkspace(body.Name, body.FoldersPath, body.InstructionID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	_ = workspace.SyncWorkspaceOnDisk(s.baseDir, ws.ID, body.FoldersPath)
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(ws)
}

func (s *Server) handleUpdateWorkspace(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	var body struct {
		Name          string   `json:"name"`
		FoldersPath   []string `json:"folders_path"`
		InstructionID *string  `json:"instruction_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if err := s.db.UpdateWorkspace(id, body.Name, body.FoldersPath, body.InstructionID); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	_ = workspace.SyncWorkspaceOnDisk(s.baseDir, id, body.FoldersPath)
	json.NewEncoder(w).Encode(map[string]any{"success": true})
}

func (s *Server) handleDeleteWorkspace(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if err := s.db.DeleteWorkspace(id); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	wPaths := workspace.GetWorkspacePaths(s.baseDir, id, "")
	_ = os.RemoveAll(wPaths.WsDir)
	json.NewEncoder(w).Encode(map[string]any{"success": true})
}

func (s *Server) handleGetWorkspaceSecurity(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	sec, err := s.db.GetOrCreateWorkspaceSecurity(id)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	json.NewEncoder(w).Encode(map[string]any{
		"workspace_id":      sec.WorkspaceID,
		"security_mode":     sec.SecurityMode,
		"allowed_commands":  json.RawMessage(sec.AllowedCommands),
		"denied_commands":   json.RawMessage(sec.DeniedCommands),
		"harmless_commands": json.RawMessage(sec.HarmlessCommands),
		"allowed_tools":     json.RawMessage(sec.AllowedTools),
		"denied_tools":      json.RawMessage(sec.DeniedTools),
		"harmless_tools":    json.RawMessage(sec.HarmlessTools),
	})
}

func (s *Server) handleUpdateWorkspaceSecurity(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	var body struct {
		SecurityMode     string   `json:"security_mode"`
		AllowedCommands  []string `json:"allowed_commands"`
		DeniedCommands   []string `json:"denied_commands"`
		HarmlessCommands []string `json:"harmless_commands"`
		AllowedTools     []string `json:"allowed_tools"`
		DeniedTools      []string `json:"denied_tools"`
		HarmlessTools    []string `json:"harmless_tools"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	acJSON, _ := json.Marshal(body.AllowedCommands)
	dcJSON, _ := json.Marshal(body.DeniedCommands)
	hcJSON, _ := json.Marshal(body.HarmlessCommands)
	atJSON, _ := json.Marshal(body.AllowedTools)
	dtJSON, _ := json.Marshal(body.DeniedTools)
	htJSON, _ := json.Marshal(body.HarmlessTools)

	sec := &db.WorkspaceSecurity{
		WorkspaceID:      id,
		SecurityMode:     body.SecurityMode,
		AllowedCommands:  string(acJSON),
		DeniedCommands:   string(dcJSON),
		HarmlessCommands: string(hcJSON),
		AllowedTools:     string(atJSON),
		DeniedTools:      string(dtJSON),
		HarmlessTools:    string(htJSON),
	}

	if err := s.db.UpdateWorkspaceSecurity(sec); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	json.NewEncoder(w).Encode(map[string]any{"success": true, "message": "Security settings updated"})
}

// Sessions
func (s *Server) handleGetSessions(w http.ResponseWriter, r *http.Request) {
	workspaceID := chi.URLParam(r, "id")
	sessions, err := s.db.GetSessions(workspaceID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	type SubSessionSummary struct {
		ID        string `json:"id"`
		Name      string `json:"name"`
		Status    string `json:"status"`
		CreatedAt string `json:"created_at"`
		UpdatedAt string `json:"updated_at"`
	}

	type SessionWithExtra struct {
		db.Session
		Status             string              `json:"status"`
		HasRunningTerminal bool                `json:"hasRunningTerminal"`
		SubSessions        []SubSessionSummary `json:"subSessions"`
	}

	result := make([]SessionWithExtra, 0, len(sessions))
	for _, sess := range sessions {
		hasTerm := s.terminalManager.HasRunningTerminal(sess.ID)
		genStatus := "idle"
		if s.agentEngine.IsGenerating(sess.ID) {
			genStatus = "generating"
		}

		var subSessions []SubSessionSummary
		wPaths := workspace.GetWorkspacePaths(s.baseDir, workspaceID, sess.ID)
		subDir := filepath.Join(wPaths.SessionFolder, "sub_sessions")
		if entries, err := os.ReadDir(subDir); err == nil {
			for _, entry := range entries {
				if strings.HasSuffix(entry.Name(), ".json") {
					if content, err := os.ReadFile(filepath.Join(subDir, entry.Name())); err == nil {
						var item SubSessionSummary
						if err := json.Unmarshal(content, &item); err == nil {
							subSessions = append(subSessions, item)
						}
					}
				}
			}
		}

		result = append(result, SessionWithExtra{
			Session:            sess,
			Status:             genStatus,
			HasRunningTerminal: hasTerm,
			SubSessions:        subSessions,
		})
	}

	json.NewEncoder(w).Encode(result)
}

func (s *Server) handleCreateSession(w http.ResponseWriter, r *http.Request) {
	workspaceID := chi.URLParam(r, "id")
	var body struct {
		Name string `json:"name"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)

	sess, err := s.db.CreateSession(workspaceID, body.Name)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(sess)
}

func (s *Server) handleUpdateSessionName(w http.ResponseWriter, r *http.Request) {
	sessionID := chi.URLParam(r, "sessionID")
	var body struct {
		Name string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || strings.TrimSpace(body.Name) == "" {
		http.Error(w, "name is required", http.StatusBadRequest)
		return
	}
	if err := s.db.UpdateSessionName(sessionID, strings.TrimSpace(body.Name)); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	json.NewEncoder(w).Encode(map[string]any{"success": true})
}

func (s *Server) handleDeleteSession(w http.ResponseWriter, r *http.Request) {
	workspaceID := chi.URLParam(r, "id")
	sessionID := chi.URLParam(r, "sessionID")

	s.agentEngine.CancelGeneration(sessionID)
	s.terminalManager.TerminateSessionTerminals(sessionID)

	_ = s.db.DeleteSession(sessionID)
	wPaths := workspace.GetWorkspacePaths(s.baseDir, workspaceID, sessionID)
	_ = os.RemoveAll(wPaths.SessionFolder)

	json.NewEncoder(w).Encode(map[string]any{"success": true, "message": "Session deleted successfully"})
}

func (s *Server) handleGetSessionMessages(w http.ResponseWriter, r *http.Request) {
	workspaceID := chi.URLParam(r, "id")
	sessionID := chi.URLParam(r, "sessionID")

	messages, err := s.db.GetSessionThread(sessionID, nil)
	if err != nil || len(messages) == 0 {
		fileMsgs, _ := workspace.LoadSessionMessages(s.baseDir, workspaceID, sessionID)
		if len(fileMsgs) > 0 {
			var prevID *int64
			for _, fm := range fileMsgs {
				sm, err := s.db.InsertSessionMessage(sessionID, prevID, fm.Role, fm.Parts)
				if err == nil && sm != nil {
					pID := sm.ID
					prevID = &pID
				}
			}
			messages, _ = s.db.GetSessionThread(sessionID, nil)
		}
	}

	branchPoints, _ := s.db.GetSessionBranchPoints(sessionID, messages)

	host := r.Host
	protocol := "ws"
	if r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https" {
		protocol = "wss"
	}
	wsURL := fmt.Sprintf("%s://%s/stream/workspace/%s/session/%s", protocol, host, workspaceID, sessionID)

	json.NewEncoder(w).Encode(map[string]any{
		"id":             sessionID,
		"sessionHistory": messages,
		"messages":       messages,
		"branchPoints":   branchPoints,
		"sessionBranchData": map[string]any{
			"branchPoints": branchPoints,
		},
		"wsURL": wsURL,
	})
}

func formatBytes(b int64) string {
	const unit = 1024
	if b < unit {
		return fmt.Sprintf("%d B", b)
	}
	div, exp := int64(unit), 0
	for n := b / unit; n >= unit; n /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %cB", float64(b)/float64(div), "KMGTPE"[exp])
}

func classifyFileType(filename, mimeType string) string {
	ext := strings.ToLower(filepath.Ext(filename))
	if ext == ".zip" {
		return "ZIP archive"
	}
	if strings.HasPrefix(mimeType, "image/") || ext == ".png" || ext == ".jpg" || ext == ".jpeg" || ext == ".webp" || ext == ".gif" || ext == ".svg" || ext == ".bmp" || ext == ".ico" {
		return "image"
	}
	if strings.HasPrefix(mimeType, "video/") || ext == ".mp4" || ext == ".webm" || ext == ".mkv" || ext == ".mov" || ext == ".avi" {
		return "video"
	}
	if strings.HasPrefix(mimeType, "audio/") || ext == ".mp3" || ext == ".wav" || ext == ".ogg" || ext == ".m4a" || ext == ".flac" {
		return "audio"
	}
	if ext == ".pdf" || ext == ".doc" || ext == ".docx" || ext == ".txt" || ext == ".md" || ext == ".csv" || ext == ".json" {
		return "document"
	}
	return "file"
}

func (s *Server) handlePostUserMessage(w http.ResponseWriter, r *http.Request) {
	workspaceID := chi.URLParam(r, "id")
	sessionID := chi.URLParam(r, "sessionID")

	_ = s.db.EnsureSession(workspaceID, sessionID, "New Agentic Chat Session")
	wPaths := workspace.GetWorkspacePaths(s.baseDir, workspaceID, sessionID)
	_ = os.MkdirAll(wPaths.SessionUploadsDir, 0755)

	var text string
	var parts []map[string]any
	var parentID *int64

	if strings.HasPrefix(r.Header.Get("Content-Type"), "multipart/form-data") {
		if err := r.ParseMultipartForm(128 << 20); err == nil {
			text = r.FormValue("message")
			if pStr := r.FormValue("parentId"); pStr != "" {
				if pVal, err := strconv.ParseInt(pStr, 10, 64); err == nil {
					parentID = &pVal
				}
			}
			if text != "" {
				parts = append(parts, map[string]any{"text": text})
			}

			relPaths := r.MultipartForm.Value["paths"]
			if len(relPaths) == 0 {
				relPaths = r.MultipartForm.Value["relative_paths"]
			}

			var uploadedSummary []string
			var fileIndex int

			if r.MultipartForm != nil && r.MultipartForm.File != nil {
				for _, fileHeaders := range r.MultipartForm.File {
					for _, fh := range fileHeaders {
						file, err := fh.Open()
						if err != nil {
							continue
						}

						ext := filepath.Ext(fh.Filename)
						baseName := strings.TrimSuffix(fh.Filename, ext)
						cleanBase := regexp.MustCompile(`[^a-zA-Z0-9.-]`).ReplaceAllString(baseName, "_")

						relPath := ""
						if fileIndex < len(relPaths) && relPaths[fileIndex] != "" {
							relPath = relPaths[fileIndex]
						}
						fileIndex++

						var localFilePath string
						var sessionRelPath string

						if relPath != "" {
							cleanRel := filepath.Clean(filepath.ToSlash(relPath))
							cleanRel = strings.TrimPrefix(cleanRel, "/")
							for strings.HasPrefix(cleanRel, "../") {
								cleanRel = strings.TrimPrefix(cleanRel, "../")
							}
							if cleanRel == "" || cleanRel == "." {
								cleanRel = fh.Filename
							}
							localFilePath = filepath.Join(wPaths.SessionUploadsDir, cleanRel)
							sessionRelPath = fmt.Sprintf("uploads/%s", filepath.ToSlash(cleanRel))
						} else {
							randHash := randHex(3)
							secureFileName := fmt.Sprintf("%s_%s%s", randHash, cleanBase, ext)
							localFilePath = filepath.Join(wPaths.SessionUploadsDir, secureFileName)
							sessionRelPath = fmt.Sprintf("uploads/%s", secureFileName)
						}

						_ = os.MkdirAll(filepath.Dir(localFilePath), 0755)
						outFile, err := os.Create(localFilePath)
						if err == nil {
							_, _ = io.Copy(outFile, file)
							_ = outFile.Close()

							mimeType := mime.TypeByExtension(ext)
							if mimeType == "" {
								mimeType = "application/octet-stream"
							}

							fileType := classifyFileType(fh.Filename, mimeType)
							fileSize := formatBytes(fh.Size)

							parts = append(parts, map[string]any{
								"_localFilePath": localFilePath,
								"mimeType":       mimeType,
							})

							if strings.ToLower(ext) == ".zip" {
								extractDirName := cleanBase
								if extractDirName == "" {
									extractDirName = "archive_" + randHex(3)
								}
								extractDest := filepath.Join(wPaths.SessionUploadsDir, extractDirName)
								extractedFiles, extractErr := workspace.ExtractZipSafe(localFilePath, extractDest)

								extractRelPath := fmt.Sprintf("uploads/%s/", extractDirName)
								if extractErr == nil && len(extractedFiles) > 0 {
									var sampleList []string
									for i, ef := range extractedFiles {
										if i >= 8 {
											sampleList = append(sampleList, fmt.Sprintf("...and %d more files", len(extractedFiles)-8))
											break
										}
										sampleList = append(sampleList, ef)
									}
									zipNote := fmt.Sprintf("[User uploaded ZIP archive: \"%s\" (%s) -> Saved at relative path: \"%s\" and automatically extracted into: \"%s\" (%d files: %s)]",
										fh.Filename, fileSize, sessionRelPath, extractRelPath, len(extractedFiles), strings.Join(sampleList, ", "))
									parts = append(parts, map[string]any{"text": zipNote})
									uploadedSummary = append(uploadedSummary, fmt.Sprintf("- %s (%s) -> Extracted into %s (%d files)", sessionRelPath, fileSize, extractRelPath, len(extractedFiles)))
								} else {
									zipNote := fmt.Sprintf("[User uploaded ZIP archive: \"%s\" (%s) -> Saved at relative path: \"%s\"]", fh.Filename, fileSize, sessionRelPath)
									parts = append(parts, map[string]any{"text": zipNote})
									uploadedSummary = append(uploadedSummary, fmt.Sprintf("- %s (%s)", sessionRelPath, fileSize))
								}
							} else {
								fileNote := fmt.Sprintf("[User uploaded %s: \"%s\" (%s) -> Available in workspace at relative path: \"%s\"]",
									fileType, fh.Filename, fileSize, sessionRelPath)
								parts = append(parts, map[string]any{"text": fileNote})
								uploadedSummary = append(uploadedSummary, fmt.Sprintf("- %s (%s, %s)", sessionRelPath, fileType, fileSize))
							}
						}
						_ = file.Close()
					}
				}
			}

			if len(uploadedSummary) > 1 {
				summaryBlock := fmt.Sprintf("\n[WORKSPACE UPLOAD SUMMARY]\nAll uploaded files/folders are saved in your session \"uploads/\" directory:\n%s\nYou can inspect, read, or process them using relative paths.\n", strings.Join(uploadedSummary, "\n"))
				parts = append(parts, map[string]any{"text": summaryBlock})
			}
		}
	} else {
		var body struct {
			Message  string           `json:"message"`
			Parts    []map[string]any `json:"parts"`
			ParentID *int64           `json:"parentId"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		text = body.Message
		parentID = body.ParentID
		if len(body.Parts) > 0 {
			parts = body.Parts
		} else if text != "" {
			parts = append(parts, map[string]any{"text": text})
		}
	}

	if len(parts) == 0 {
		http.Error(w, "Must provide message text or file attachments", http.StatusBadRequest)
		return
	}

	userMsg, err := s.db.InsertSessionMessage(sessionID, parentID, "user", parts)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	// Keep workspace mirror and file session updated
	folders := s.getFoldersForWorkspace(workspaceID)
	repos := workspace.GetGitReposForWorkspace(s.baseDir, workspaceID, folders)
	_ = workspace.CreateWorkspaceMirror(s.baseDir, workspaceID, sessionID, repos)
	_ = workspace.CommitSessionMessage(s.baseDir, workspaceID, sessionID, userMsg.ID, "user")

	json.NewEncoder(w).Encode(map[string]any{
		"success":   true,
		"messageId": userMsg.ID,
	})
}

func (s *Server) handlePostAssistantMessage(w http.ResponseWriter, r *http.Request) {
	workspaceID := chi.URLParam(r, "id")
	sessionID := chi.URLParam(r, "sessionID")

	_ = s.db.EnsureSession(workspaceID, sessionID, "New Session")

	var body struct {
		Text     string           `json:"text"`
		Thoughts string           `json:"thoughts"`
		Parts    []map[string]any `json:"parts"`
		ParentID *int64           `json:"parentId"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)

	parts := make([]map[string]any, 0)
	if len(body.Parts) > 0 {
		parts = body.Parts
	} else {
		if body.Thoughts != "" {
			parts = append(parts, map[string]any{"thought": true, "text": body.Thoughts})
		}
		if body.Text != "" {
			parts = append(parts, map[string]any{"text": body.Text})
		}
	}

	modelMsg, err := s.db.InsertSessionMessage(sessionID, body.ParentID, "model", parts)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	folders := s.getFoldersForWorkspace(workspaceID)
	repos := workspace.GetGitReposForWorkspace(s.baseDir, workspaceID, folders)
	_ = workspace.CommitSessionMessage(s.baseDir, workspaceID, sessionID, modelMsg.ID, "model")
	_ = workspace.MergeMirrorChangesBack(s.baseDir, workspaceID, sessionID, repos, modelMsg.ID)

	json.NewEncoder(w).Encode(map[string]any{
		"success":   true,
		"messageId": modelMsg.ID,
	})
}

func (s *Server) handleExecuteTool(w http.ResponseWriter, r *http.Request) {
	workspaceID := chi.URLParam(r, "id")
	sessionID := chi.URLParam(r, "sessionID")

	var body struct {
		CallID string         `json:"callId"`
		Name   string         `json:"name"`
		Args   map[string]any `json:"args"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Name == "" {
		http.Error(w, "Invalid tool execution request", http.StatusBadRequest)
		return
	}

	folders := s.getFoldersForWorkspace(workspaceID)
	repos := workspace.GetGitReposForWorkspace(s.baseDir, workspaceID, folders)
	_ = workspace.CreateWorkspaceMirror(s.baseDir, workspaceID, sessionID, repos)

	broadcast := func(sessID string, msg any) {
		s.hub.BroadcastJSON(sessID, msg)
	}

	toolResult := s.agentEngine.ExecuteTool(workspaceID, sessionID, body.Name, body.Args, repos, broadcast)
	sanitized := tools.SanitizeToolResult(toolResult, 12000)

	if body.CallID != "" {
		broadcast(sessionID, map[string]any{
			"type":     "FUNCTION_RESPONSE",
			"callId":   body.CallID,
			"response": map[string]any{"result": sanitized},
		})
	}

	json.NewEncoder(w).Encode(map[string]any{
		"success":   true,
		"callId":    body.CallID,
		"name":      body.Name,
		"result":    toolResult,
		"sanitized": sanitized,
	})
}

func (s *Server) handleRollbackPreview(w http.ResponseWriter, r *http.Request) {
	workspaceID := chi.URLParam(r, "id")
	sessionID := chi.URLParam(r, "sessionID")
	msgIDStr := chi.URLParam(r, "messageID")
	msgID, _ := strconv.ParseInt(msgIDStr, 10, 64)

	folders := s.getFoldersForWorkspace(workspaceID)
	repos := workspace.GetGitReposForWorkspace(s.baseDir, workspaceID, folders)

	affected, err := workspace.RollbackPreview(s.baseDir, workspaceID, sessionID, msgID, repos)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	json.NewEncoder(w).Encode(map[string]any{
		"affectedFiles":    affected,
		"targetMessageID": msgID,
	})
}

func (s *Server) handleRollbackExecute(w http.ResponseWriter, r *http.Request) {
	workspaceID := chi.URLParam(r, "id")
	sessionID := chi.URLParam(r, "sessionID")
	msgIDStr := chi.URLParam(r, "messageID")
	msgID, _ := strconv.ParseInt(msgIDStr, 10, 64)

	folders := s.getFoldersForWorkspace(workspaceID)
	repos := workspace.GetGitReposForWorkspace(s.baseDir, workspaceID, folders)

	if err := workspace.ExecuteRollback(s.baseDir, workspaceID, sessionID, msgID, repos); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	json.NewEncoder(w).Encode(map[string]any{
		"success": true,
		"message": "History rolled back and branched successfully",
	})
}

func (s *Server) handleSourceControlFiles(w http.ResponseWriter, r *http.Request) {
	workspaceID := chi.URLParam(r, "id")
	targetPrefix := r.URL.Query().Get("path")

	folders := s.getFoldersForWorkspace(workspaceID)
	repos := workspace.GetGitReposForWorkspace(s.baseDir, workspaceID, folders)

	type SCItem struct {
		Name         string `json:"name"`
		Path         string `json:"path"`
		Type         string `json:"type"`
		IsDeleted    bool   `json:"isDeleted"`
		HistoryCount int    `json:"historyCount"`
		LastUpdate   string `json:"lastUpdate"`
		Size         int64  `json:"size"`
		HistorySize  int64  `json:"historySize"`
		RepoHash     string `json:"repoHash"`
	}

	if targetPrefix == "" {
		var items []SCItem
		for _, repo := range repos {
			out, _ := workspace.ExecGit(repo, "log", "--oneline")
			count := len(strings.Split(strings.TrimSpace(out), "\n"))
			lastUp := "Unknown"
			if uOut, err := workspace.ExecGit(repo, "log", "-1", "--format=%cd (%s)", "--date=relative"); err == nil && strings.TrimSpace(uOut) != "" {
				lastUp = strings.TrimSpace(uOut)
			}
			items = append(items, SCItem{
				Name:         repo.FolderName,
				Path:         repo.FolderName,
				Type:         "directory",
				HistoryCount: count,
				LastUpdate:   lastUp,
				RepoHash:     repo.HashedName,
			})
		}
		json.NewEncoder(w).Encode(map[string]any{"items": items})
		return
	}

	parts := strings.Split(targetPrefix, "/")
	targetFolder := parts[0]
	relInside := ""
	if len(parts) > 1 {
		relInside = strings.Join(parts[1:], "/")
	}

	var targetRepo *workspace.GitRepo
	for _, r := range repos {
		if r.FolderName == targetFolder {
			targetRepo = &r
			break
		}
	}

	if targetRepo == nil {
		json.NewEncoder(w).Encode(map[string]any{"items": []SCItem{}})
		return
	}

	out, _ := workspace.ExecGit(*targetRepo, "log", "--pretty=format:", "--name-only", "--all")
	pathSet := make(map[string]bool)
	for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
		p := strings.TrimSpace(line)
		if p != "" {
			pathSet[p] = true
		}
	}

	prefixFilter := relInside
	if prefixFilter != "" && !strings.HasSuffix(prefixFilter, "/") {
		prefixFilter += "/"
	}

	childrenMap := make(map[string]map[string]string)
	for p := range pathSet {
		if prefixFilter == "" || strings.HasPrefix(p, prefixFilter) {
			rel := p
			if prefixFilter != "" {
				rel = strings.TrimPrefix(p, prefixFilter)
			}
			if rel == "" {
				continue
			}

			segs := strings.Split(rel, "/")
			name := segs[0]
			fullRel := prefixFilter + name
			itemType := "file"
			if len(segs) > 1 {
				itemType = "directory"
			}
			childrenMap[name] = map[string]string{"type": itemType, "fullPath": fullRel}
		}
	}

	var items []SCItem
	for name, info := range childrenMap {
		realPath := filepath.Join(targetRepo.RealPath, info["fullPath"])
		isDeleted := true
		var size int64 = 0
		if stat, err := os.Stat(realPath); err == nil {
			isDeleted = false
			if info["type"] == "file" {
				size = stat.Size()
			}
		}

		cOut, _ := workspace.ExecGit(*targetRepo, "log", "--oneline", "--", info["fullPath"])
		hCount := len(strings.Split(strings.TrimSpace(cOut), "\n"))
		lastUp := "Unknown"
		if uOut, err := workspace.ExecGit(*targetRepo, "log", "-1", "--format=%cd (%s)", "--date=relative", "--", info["fullPath"]); err == nil && strings.TrimSpace(uOut) != "" {
			lastUp = strings.TrimSpace(uOut)
		}

		items = append(items, SCItem{
			Name:         name,
			Path:         fmt.Sprintf("%s/%s", targetFolder, info["fullPath"]),
			Type:         info["type"],
			IsDeleted:    isDeleted,
			HistoryCount: hCount,
			LastUpdate:   lastUp,
			Size:         size,
			RepoHash:     targetRepo.HashedName,
		})
	}

	json.NewEncoder(w).Encode(map[string]any{"items": items})
}

func (s *Server) handleSourceControlIgnore(w http.ResponseWriter, r *http.Request) {
	workspaceID := chi.URLParam(r, "id")
	var body struct {
		Path string `json:"path"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Path == "" {
		http.Error(w, "Missing path", http.StatusBadRequest)
		return
	}

	folders := s.getFoldersForWorkspace(workspaceID)
	repos := workspace.GetGitReposForWorkspace(s.baseDir, workspaceID, folders)

	parts := strings.Split(body.Path, "/")
	targetFolder := parts[0]
	relInside := ""
	if len(parts) > 1 {
		relInside = strings.Join(parts[1:], "/")
	}

	for _, repo := range repos {
		if repo.FolderName == targetFolder {
			excludePath := filepath.Join(repo.GitDir, "info", "exclude")
			_ = os.MkdirAll(filepath.Dir(excludePath), 0755)
			cur, _ := os.ReadFile(excludePath)
			if !strings.Contains(string(cur), relInside) {
				_ = os.WriteFile(excludePath, []byte(string(cur)+"\n"+relInside+"\n"), 0644)
			}
			break
		}
	}

	json.NewEncoder(w).Encode(map[string]any{"success": true, "message": "Path ignored successfully."})
}

func (s *Server) handleSourceControlTimeline(w http.ResponseWriter, r *http.Request) {
	workspaceID := chi.URLParam(r, "id")
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	if limit <= 0 {
		limit = 20
	}
	offset, _ := strconv.Atoi(r.URL.Query().Get("offset"))

	folders := s.getFoldersForWorkspace(workspaceID)
	repos := workspace.GetGitReposForWorkspace(s.baseDir, workspaceID, folders)

	timeline, totalCount, hasMore, err := workspace.GetSourceControlTimeline(s.baseDir, workspaceID, repos, limit, offset)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	json.NewEncoder(w).Encode(map[string]any{
		"timeline":   timeline,
		"totalCount": totalCount,
		"hasMore":    hasMore,
	})
}

func (s *Server) handleGetSessionBranches(w http.ResponseWriter, r *http.Request) {
	sessionID := chi.URLParam(r, "sessionID")

	info, err := s.db.GetSessionBranchesInfo(sessionID)
	if err != nil || info == nil || len(info.BranchPoints) == 0 {
		workspaceID := chi.URLParam(r, "id")
		if gInfo, gErr := workspace.GetSessionBranchesInfo(s.baseDir, workspaceID, sessionID); gErr == nil && gInfo != nil {
			var bPoints []db.BranchPoint
			for _, bp := range gInfo.BranchPoints {
				var alts []db.BranchAlternative
				for _, a := range bp.Alternatives {
					alts = append(alts, db.BranchAlternative{
						Index:       a.Index,
						BranchName:  a.BranchName,
						TargetMsgID: a.TargetMsgID,
					})
				}
				bPoints = append(bPoints, db.BranchPoint{
					AfterMsgID:   bp.AfterMsgID,
					CurrentIndex: bp.CurrentIndex,
					TotalCount:   bp.TotalCount,
					Alternatives: alts,
				})
			}
			info = &db.BranchInfo{
				ActiveBranch: gInfo.ActiveBranch,
				Branches:     gInfo.Branches,
				BranchPoints: bPoints,
			}
		}
	}
	if info == nil {
		info = &db.BranchInfo{
			Branches:     []string{},
			BranchPoints: []db.BranchPoint{},
		}
	}
	json.NewEncoder(w).Encode(info)
}

func (s *Server) handleCheckoutBranch(w http.ResponseWriter, r *http.Request) {
	workspaceID := chi.URLParam(r, "id")
	sessionID := chi.URLParam(r, "sessionID")
	branchName := chi.URLParam(r, "branchName")

	if targetMsgID, err := strconv.ParseInt(branchName, 10, 64); err == nil {
		_ = s.db.SetActiveMessage(sessionID, targetMsgID)
	}

	folders := s.getFoldersForWorkspace(workspaceID)
	repos := workspace.GetGitReposForWorkspace(s.baseDir, workspaceID, folders)
	_ = workspace.CheckoutBranch(s.baseDir, workspaceID, sessionID, branchName, repos)

	json.NewEncoder(w).Encode(map[string]any{"success": true, "message": fmt.Sprintf("Checked out branch %s", branchName)})
}

func (s *Server) handleGetArtifacts(w http.ResponseWriter, r *http.Request) {
	workspaceID := chi.URLParam(r, "id")
	sessionID := chi.URLParam(r, "sessionID")

	wPaths := workspace.GetWorkspacePaths(s.baseDir, workspaceID, sessionID)
	_ = os.MkdirAll(wPaths.SessionArtifactDir, 0755)

	type ArtifactItem struct {
		Name      string `json:"name"`
		Path      string `json:"path"`
		Size      int64  `json:"size"`
		UpdatedAt string `json:"updatedAt"`
	}

	var items []ArtifactItem
	_ = filepath.WalkDir(wPaths.SessionArtifactDir, func(p string, d os.DirEntry, err error) error {
		if err != nil || d == nil || d.IsDir() {
			return nil
		}
		rel, _ := filepath.Rel(wPaths.SessionFolder, p)
		info, _ := d.Info()
		var size int64 = 0
		modTime := time.Now().UTC().Format(time.RFC3339)
		if info != nil {
			size = info.Size()
			modTime = info.ModTime().UTC().Format(time.RFC3339)
		}
		items = append(items, ArtifactItem{
			Name:      d.Name(),
			Path:      filepath.ToSlash(rel),
			Size:      size,
			UpdatedAt: modTime,
		})
		return nil
	})

	json.NewEncoder(w).Encode(map[string]any{"items": items})
}

func (s *Server) handleReadArtifact(w http.ResponseWriter, r *http.Request) {
	workspaceID := chi.URLParam(r, "id")
	sessionID := chi.URLParam(r, "sessionID")
	targetPath := r.URL.Query().Get("path")

	if targetPath == "" {
		http.Error(w, "Missing path parameter", http.StatusBadRequest)
		return
	}

	wPaths := workspace.GetWorkspacePaths(s.baseDir, workspaceID, sessionID)
	absPath := filepath.Join(wPaths.SessionFolder, filepath.FromSlash(targetPath))

	stat, err := os.Stat(absPath)
	if err != nil {
		http.Error(w, err.Error(), http.StatusNotFound)
		return
	}
	if stat.IsDir() {
		http.Error(w, "Target path is a directory", http.StatusBadRequest)
		return
	}

	content, err := os.ReadFile(absPath)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	json.NewEncoder(w).Encode(map[string]any{
		"path":    targetPath,
		"name":    filepath.Base(absPath),
		"size":    stat.Size(),
		"content": string(content),
	})
}

func (s *Server) handleGetSubSessions(w http.ResponseWriter, r *http.Request) {
	workspaceID := chi.URLParam(r, "id")
	sessionID := chi.URLParam(r, "sessionID")

	wPaths := workspace.GetWorkspacePaths(s.baseDir, workspaceID, sessionID)
	subDir := filepath.Join(wPaths.SessionFolder, "sub_sessions")

	var list []map[string]any
	if entries, err := os.ReadDir(subDir); err == nil {
		for _, entry := range entries {
			if strings.HasSuffix(entry.Name(), ".json") {
				if content, err := os.ReadFile(filepath.Join(subDir, entry.Name())); err == nil {
					var item map[string]any
					if err := json.Unmarshal(content, &item); err == nil {
						list = append(list, item)
					}
				}
			}
		}
	}

	sort.Slice(list, func(i, j int) bool {
		u1, _ := list[i]["updated_at"].(string)
		u2, _ := list[j]["updated_at"].(string)
		return u1 > u2
	})

	json.NewEncoder(w).Encode(list)
}

func (s *Server) handleGetSubSessionDetails(w http.ResponseWriter, r *http.Request) {
	workspaceID := chi.URLParam(r, "id")
	sessionID := chi.URLParam(r, "sessionID")
	subSessionID := chi.URLParam(r, "subSessionID")

	wPaths := workspace.GetWorkspacePaths(s.baseDir, workspaceID, sessionID)
	filePath := filepath.Join(wPaths.SessionFolder, "sub_sessions", subSessionID+".json")

	content, err := os.ReadFile(filePath)
	if err != nil {
		http.Error(w, "Sub-session not found", http.StatusNotFound)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.Write(content)
}

// Marketplace
func (s *Server) handleGetMarketplaceSources(w http.ResponseWriter, r *http.Request) {
	sources, err := s.db.GetMarketplaceSources()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	json.NewEncoder(w).Encode(sources)
}

func (s *Server) handleCreateMarketplaceSource(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Type   string `json:"type"`
		Source string `json:"source"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Source == "" {
		http.Error(w, "Invalid payload", http.StatusBadRequest)
		return
	}
	if body.Type == "" {
		body.Type = "mcp"
	}

	res, err := s.db.AddMarketplaceSource(body.Type, body.Source)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	json.NewEncoder(w).Encode(res)
}

func (s *Server) handleDeleteMarketplaceSource(w http.ResponseWriter, r *http.Request) {
	idStr := chi.URLParam(r, "id")
	id, _ := strconv.ParseInt(idStr, 10, 64)
	if err := s.db.DeleteMarketplaceSource(id); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	json.NewEncoder(w).Encode(map[string]any{"success": true})
}

func (s *Server) handleGetMarketplaceProviders(w http.ResponseWriter, r *http.Request) {
	pDir := s.getProvidersDir()
	entries, err := os.ReadDir(pDir)
	if err != nil {
		json.NewEncoder(w).Encode([]map[string]any{})
		return
	}
	var list []map[string]any
	for _, entry := range entries {
		if !entry.IsDir() && strings.HasSuffix(entry.Name(), ".js") {
			name := strings.TrimSuffix(entry.Name(), ".js")
			list = append(list, map[string]any{
				"id":        name,
				"name":      name,
				"installed": true,
				"fileName":  entry.Name(),
			})
		}
	}
	json.NewEncoder(w).Encode(list)
}

func (s *Server) handleGetProviderConfigs(w http.ResponseWriter, r *http.Request) {
	configs, err := s.db.GetProviderConfigs()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	json.NewEncoder(w).Encode(configs)
}

func (s *Server) handleCreateProviderConfig(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name       string          `json:"name"`
		ProviderID string          `json:"providerId"`
		Config     json.RawMessage `json:"config"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Name == "" {
		http.Error(w, "Invalid payload", http.StatusBadRequest)
		return
	}
	cfg, err := s.db.AddProviderConfig(body.Name, body.ProviderID, string(body.Config))
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(cfg)
}

func (s *Server) handleUpdateProviderConfig(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	var body struct {
		Name   string          `json:"name"`
		Config json.RawMessage `json:"config"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if err := s.db.UpdateProviderConfig(id, body.Name, string(body.Config)); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	json.NewEncoder(w).Encode(map[string]any{"success": true})
}

func (s *Server) handleDeleteProviderConfig(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if err := s.db.DeleteProviderConfig(id); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	json.NewEncoder(w).Encode(map[string]any{"success": true})
}

func (s *Server) handleSetActiveProviderConfig(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if err := s.db.SetActiveProviderConfig(id); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	json.NewEncoder(w).Encode(map[string]any{"success": true})
}

func (s *Server) handleGetMcpServers(w http.ResponseWriter, r *http.Request) {
	servers, err := s.db.GetMcpServers()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	json.NewEncoder(w).Encode(servers)
}

func (s *Server) handleCreateMcpServer(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name   string `json:"name"`
		Type   string `json:"type"`
		Source string `json:"source"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Name == "" || body.Source == "" {
		http.Error(w, "Invalid payload", http.StatusBadRequest)
		return
	}
	if body.Type == "" {
		body.Type = "sse"
	}
	srv, err := s.db.AddMcpServer(body.Name, body.Type, body.Source)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(srv)
}

func (s *Server) handleDeleteMcpServer(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if err := s.db.DeleteMcpServer(id); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	json.NewEncoder(w).Encode(map[string]any{"success": true})
}

func (s *Server) handleToggleMcpServer(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	var body struct {
		Active bool `json:"active"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	val := 0
	if body.Active {
		val = 1
	}
	if err := s.db.ToggleMcpServer(id, val); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	json.NewEncoder(w).Encode(map[string]any{"success": true})
}

func (s *Server) handleSyncMarketplace(w http.ResponseWriter, r *http.Request) {
	sourcesPath := filepath.Join(s.baseDir, "marketplace", "sources.json")
	if data, err := os.ReadFile(sourcesPath); err == nil {
		var sources []struct {
			Type   string `json:"type"`
			Source string `json:"source"`
		}
		if err := json.Unmarshal(data, &sources); err == nil {
			for _, src := range sources {
				_, _ = s.db.AddMarketplaceSource(src.Type, src.Source)
			}
		}
	}
	json.NewEncoder(w).Encode(map[string]any{"success": true})
}

// Custom Providers
func (s *Server) handleGetCustomProviders(w http.ResponseWriter, r *http.Request) {
	list, err := s.db.GetCustomProviders()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	json.NewEncoder(w).Encode(list)
}

func (s *Server) handleCreateCustomProvider(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name         string          `json:"name"`
		ProviderType string          `json:"provider_type"`
		BaseURL      string          `json:"base_url"`
		APIKey       string          `json:"api_key"`
		ModelName    string          `json:"model_name"`
		IsDefault    int             `json:"is_default"`
		Config       json.RawMessage `json:"config"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Name == "" || body.ModelName == "" {
		http.Error(w, "name and model_name are required", http.StatusBadRequest)
		return
	}
	if body.ProviderType == "" {
		body.ProviderType = "openai_compatible"
	}
	cfgStr := "{}"
	if len(body.Config) > 0 {
		cfgStr = string(body.Config)
	}
	p, err := s.db.CreateCustomProvider(body.Name, body.ProviderType, body.BaseURL, body.APIKey, body.ModelName, body.IsDefault, cfgStr)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(p)
}

func (s *Server) handleUpdateCustomProvider(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	var body struct {
		Name         string          `json:"name"`
		ProviderType string          `json:"provider_type"`
		BaseURL      string          `json:"base_url"`
		APIKey       string          `json:"api_key"`
		ModelName    string          `json:"model_name"`
		IsDefault    int             `json:"is_default"`
		Config       json.RawMessage `json:"config"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Name == "" || body.ModelName == "" {
		http.Error(w, "name and model_name are required", http.StatusBadRequest)
		return
	}
	if body.ProviderType == "" {
		body.ProviderType = "openai_compatible"
	}
	cfgStr := "{}"
	if len(body.Config) > 0 {
		cfgStr = string(body.Config)
	}
	if err := s.db.UpdateCustomProvider(id, body.Name, body.ProviderType, body.BaseURL, body.APIKey, body.ModelName, body.IsDefault, cfgStr); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	json.NewEncoder(w).Encode(map[string]any{"success": true})
}

func (s *Server) handleDeleteCustomProvider(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if err := s.db.DeleteCustomProvider(id); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	json.NewEncoder(w).Encode(map[string]any{"success": true})
}

func (s *Server) handleSetDefaultCustomProvider(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if err := s.db.SetDefaultCustomProvider(id); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	json.NewEncoder(w).Encode(map[string]any{"success": true})
}

func (s *Server) getProvidersDir() string {
	pDir := filepath.Join(s.baseDir, "providers")
	_ = os.MkdirAll(pDir, 0755)

	// Copy/sync built-in providers from staticDir
	if s.staticDir != "" && s.staticDir != s.baseDir {
		staticPDir := filepath.Join(s.staticDir, "providers")
		if entries, err := os.ReadDir(staticPDir); err == nil {
			for _, e := range entries {
				if !e.IsDir() && strings.HasSuffix(e.Name(), ".js") {
					targetFile := filepath.Join(pDir, e.Name())
					if content, err := os.ReadFile(filepath.Join(staticPDir, e.Name())); err == nil {
						_ = os.WriteFile(targetFile, content, 0644)
					}
				}
			}
		}
	}
	return pDir
}

type ProviderFileInfo struct {
	FileName  string `json:"file_name"`
	Path      string `json:"path"`
	Code      string `json:"code"`
	UpdatedAt string `json:"updated_at"`
}

func (s *Server) handleGetProviderFiles(w http.ResponseWriter, r *http.Request) {
	pDir := s.getProvidersDir()
	entries, err := os.ReadDir(pDir)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	files := make([]ProviderFileInfo, 0)
	for _, entry := range entries {
		if !entry.IsDir() && strings.HasSuffix(entry.Name(), ".js") {
			fullPath := filepath.Join(pDir, entry.Name())
			data, err := os.ReadFile(fullPath)
			if err != nil {
				continue
			}
			info, _ := entry.Info()
			modTime := time.Now().UTC().Format(time.RFC3339)
			if info != nil {
				modTime = info.ModTime().UTC().Format(time.RFC3339)
			}
			files = append(files, ProviderFileInfo{
				FileName:  entry.Name(),
				Path:      fullPath,
				Code:      string(data),
				UpdatedAt: modTime,
			})
		}
	}
	json.NewEncoder(w).Encode(files)
}

func (s *Server) handleSaveProviderFile(w http.ResponseWriter, r *http.Request) {
	var body struct {
		FileName string `json:"file_name"`
		Code     string `json:"code"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.FileName == "" || body.Code == "" {
		http.Error(w, "file_name and code are required", http.StatusBadRequest)
		return
	}
	if !strings.HasSuffix(body.FileName, ".js") {
		body.FileName += ".js"
	}
	body.FileName = filepath.Base(body.FileName)

	pDir := s.getProvidersDir()
	targetPath := filepath.Join(pDir, body.FileName)
	if err := os.WriteFile(targetPath, []byte(body.Code), 0644); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	json.NewEncoder(w).Encode(map[string]any{
		"success":   true,
		"file_name": body.FileName,
		"path":      targetPath,
	})
}

func (s *Server) handleImportProviderFromURL(w http.ResponseWriter, r *http.Request) {
	var body struct {
		URL      string `json:"url"`
		FileName string `json:"file_name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.URL == "" {
		http.Error(w, "url is required", http.StatusBadRequest)
		return
	}

	resp, err := http.Get(body.URL)
	if err != nil || resp.StatusCode != http.StatusOK {
		http.Error(w, "Failed to download URL", http.StatusBadRequest)
		return
	}
	defer resp.Body.Close()

	codeBytes, err := io.ReadAll(resp.Body)
	if err != nil {
		http.Error(w, "Failed to read response body", http.StatusInternalServerError)
		return
	}

	fileName := body.FileName
	if fileName == "" {
		parts := strings.Split(body.URL, "/")
		last := parts[len(parts)-1]
		if strings.Contains(last, "?") {
			last = strings.Split(last, "?")[0]
		}
		if last != "" && strings.HasSuffix(last, ".js") {
			fileName = last
		} else {
			fileName = "provider-" + time.Now().Format("20060102-150405") + ".js"
		}
	}
	if !strings.HasSuffix(fileName, ".js") {
		fileName += ".js"
	}
	fileName = filepath.Base(fileName)

	pDir := s.getProvidersDir()
	targetPath := filepath.Join(pDir, fileName)
	if err := os.WriteFile(targetPath, codeBytes, 0644); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	json.NewEncoder(w).Encode(map[string]any{
		"success":   true,
		"file_name": fileName,
		"code":      string(codeBytes),
		"path":      targetPath,
	})
}

func (s *Server) handleDeleteProviderFile(w http.ResponseWriter, r *http.Request) {
	fileName := filepath.Base(chi.URLParam(r, "filename"))
	pDir := s.getProvidersDir()
	targetPath := filepath.Join(pDir, fileName)
	if err := os.Remove(targetPath); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	json.NewEncoder(w).Encode(map[string]any{"success": true})
}

// -------------------------------------------------------------
// Modular Tool Scripts & MCP Handlers
// -------------------------------------------------------------

func (s *Server) getToolScriptsDir() string {
	tsDir := filepath.Join(s.baseDir, "tool-scripts")
	_ = os.MkdirAll(tsDir, 0755)
	return tsDir
}

type ToolScriptItem struct {
	ID          string                       `json:"id"`
	FileName    string                       `json:"fileName"`
	Name        string                       `json:"name"`
	Description string                       `json:"description"`
	Context     string                       `json:"context"`
	Enabled     int                          `json:"enabled"`
	Code        string                       `json:"code"`
	Parameters  *tools.ToolParameters        `json:"parameters,omitempty"`
	CreatedAt   string                       `json:"createdAt"`
}

func (s *Server) handleGetToolGroups(w http.ResponseWriter, r *http.Request) {
	disabledJSON := s.db.GetAppSetting("disabled_tool_groups", "[]")
	var disabledList []string
	_ = json.Unmarshal([]byte(disabledJSON), &disabledList)
	disabledMap := make(map[string]bool)
	for _, id := range disabledList {
		disabledMap[id] = true
	}

	builtin := tools.BuiltinToolGroups()
	for i := range builtin {
		builtin[i].Enabled = !disabledMap[builtin[i].ID]
	}

	tsDir := s.getToolScriptsDir()
	var scriptGroups []tools.ToolGroup
	if dbScripts, err := s.db.GetToolScripts(); err == nil {
		for _, scr := range dbScripts {
			filePath := filepath.Join(tsDir, scr.FileName)
			decl, _ := tools.ExtractScriptDeclaration(filePath)
			scriptGroups = append(scriptGroups, tools.BuildScriptToolGroup(scr, decl))
		}
	}

	var mcpGroups []tools.ToolGroup
	if mcpServers, err := s.db.GetMcpServers(); err == nil {
		for _, mcp := range mcpServers {
			decls, _ := tools.GlobalMCPManager.QueryServerTools(mcp.Source)
			mcpGroups = append(mcpGroups, tools.BuildMCPToolGroup(mcp, decls))
		}
	}

	json.NewEncoder(w).Encode(map[string]any{
		"builtin": builtin,
		"scripts": scriptGroups,
		"mcp":     mcpGroups,
	})
}

func (s *Server) handleToggleToolGroup(w http.ResponseWriter, r *http.Request) {
	groupID := chi.URLParam(r, "id")
	var body struct {
		Enabled bool `json:"enabled"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)

	if strings.HasPrefix(groupID, "script_") {
		scriptID := strings.TrimPrefix(groupID, "script_")
		enabledInt := 0
		if body.Enabled {
			enabledInt = 1
		}
		_ = s.db.ToggleToolScript(scriptID, enabledInt)
		json.NewEncoder(w).Encode(map[string]any{"success": true, "enabled": body.Enabled})
		return
	}

	if strings.HasPrefix(groupID, "mcp_") {
		mcpID := strings.TrimPrefix(groupID, "mcp_")
		activeInt := 0
		if body.Enabled {
			activeInt = 1
		}
		_ = s.db.ToggleMcpServer(mcpID, activeInt)
		json.NewEncoder(w).Encode(map[string]any{"success": true, "enabled": body.Enabled})
		return
	}

	disabledJSON := s.db.GetAppSetting("disabled_tool_groups", "[]")
	var disabledList []string
	_ = json.Unmarshal([]byte(disabledJSON), &disabledList)

	disabledMap := make(map[string]bool)
	for _, id := range disabledList {
		disabledMap[id] = true
	}

	if body.Enabled {
		delete(disabledMap, groupID)
	} else {
		disabledMap[groupID] = true
	}

	var newList []string
	for id := range disabledMap {
		newList = append(newList, id)
	}
	newJSON, _ := json.Marshal(newList)
	_ = s.db.SetAppSetting("disabled_tool_groups", string(newJSON))

	json.NewEncoder(w).Encode(map[string]any{"success": true, "enabled": body.Enabled})
}

func (s *Server) handleGetToolScripts(w http.ResponseWriter, r *http.Request) {
	tsDir := s.getToolScriptsDir()
	dbScripts, err := s.db.GetToolScripts()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	dbMap := make(map[string]db.ToolScript)
	for _, scr := range dbScripts {
		dbMap[scr.FileName] = scr
	}

	entries, err := os.ReadDir(tsDir)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	items := make([]ToolScriptItem, 0)
	for _, entry := range entries {
		if !entry.IsDir() && strings.HasSuffix(entry.Name(), ".js") {
			fullPath := filepath.Join(tsDir, entry.Name())
			codeBytes, _ := os.ReadFile(fullPath)
			decl, _ := tools.ExtractScriptDeclaration(fullPath)

			scr, exists := dbMap[entry.Name()]
			if !exists {
				name := entry.Name()
				desc := ""
				ctx := "always"
				if decl != nil {
					name = decl.Name
					desc = decl.Description
					if decl.Context != "" {
						ctx = decl.Context
					}
				}
				newScr, err := s.db.UpsertToolScript("", entry.Name(), name, desc, ctx, 1)
				if err == nil && newScr != nil {
					scr = *newScr
				}
			}

			var params *tools.ToolParameters
			if decl != nil {
				params = &decl.Parameters
				if scr.Name == "" {
					scr.Name = decl.Name
				}
				if scr.Description == "" {
					scr.Description = decl.Description
				}
			}

			items = append(items, ToolScriptItem{
				ID:          scr.ID,
				FileName:    scr.FileName,
				Name:        scr.Name,
				Description: scr.Description,
				Context:     scr.Context,
				Enabled:     scr.Enabled,
				Code:        string(codeBytes),
				Parameters:  params,
				CreatedAt:   scr.CreatedAt,
			})
		}
	}

	json.NewEncoder(w).Encode(items)
}

func (s *Server) handleSaveToolScript(w http.ResponseWriter, r *http.Request) {
	var body struct {
		FileName string `json:"fileName"`
		Code     string `json:"code"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.FileName == "" || body.Code == "" {
		http.Error(w, "fileName and code are required", http.StatusBadRequest)
		return
	}
	if !strings.HasSuffix(body.FileName, ".js") {
		body.FileName += ".js"
	}
	body.FileName = filepath.Base(body.FileName)

	tsDir := s.getToolScriptsDir()
	targetPath := filepath.Join(tsDir, body.FileName)
	if err := os.WriteFile(targetPath, []byte(body.Code), 0644); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	decl, _ := tools.ExtractScriptDeclaration(targetPath)
	name := strings.TrimSuffix(body.FileName, ".js")
	desc := ""
	ctx := "always"
	if decl != nil {
		if decl.Name != "" {
			name = decl.Name
		}
		desc = decl.Description
		if decl.Context != "" {
			ctx = decl.Context
		}
	}

	scr, err := s.db.UpsertToolScript("", body.FileName, name, desc, ctx, 1)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(scr)
}

func (s *Server) handleImportToolScriptFromURL(w http.ResponseWriter, r *http.Request) {
	var body struct {
		URL      string `json:"url"`
		FileName string `json:"fileName"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.URL == "" {
		http.Error(w, "url is required", http.StatusBadRequest)
		return
	}

	resp, err := http.Get(body.URL)
	if err != nil {
		http.Error(w, "failed to download script: "+err.Error(), http.StatusBadRequest)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		http.Error(w, fmt.Sprintf("download returned status %d", resp.StatusCode), http.StatusBadRequest)
		return
	}

	codeBytes, err := io.ReadAll(resp.Body)
	if err != nil {
		http.Error(w, "failed to read script body: "+err.Error(), http.StatusInternalServerError)
		return
	}

	fileName := body.FileName
	if fileName == "" {
		parts := strings.Split(body.URL, "/")
		last := parts[len(parts)-1]
		if strings.Contains(last, "?") {
			last = strings.Split(last, "?")[0]
		}
		if last != "" && strings.HasSuffix(last, ".js") {
			fileName = last
		} else {
			fileName = "tool-" + time.Now().Format("20060102-150405") + ".js"
		}
	}
	if !strings.HasSuffix(fileName, ".js") {
		fileName += ".js"
	}
	fileName = filepath.Base(fileName)

	tsDir := s.getToolScriptsDir()
	targetPath := filepath.Join(tsDir, fileName)
	if err := os.WriteFile(targetPath, codeBytes, 0644); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	decl, _ := tools.ExtractScriptDeclaration(targetPath)
	name := strings.TrimSuffix(fileName, ".js")
	desc := ""
	ctx := "always"
	if decl != nil {
		if decl.Name != "" {
			name = decl.Name
		}
		desc = decl.Description
		if decl.Context != "" {
			ctx = decl.Context
		}
	}

	scr, err := s.db.UpsertToolScript("", fileName, name, desc, ctx, 1)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	json.NewEncoder(w).Encode(scr)
}

func (s *Server) handleDeleteToolScript(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	scripts, _ := s.db.GetToolScripts()
	var targetFile string
	for _, scr := range scripts {
		if scr.ID == id {
			targetFile = scr.FileName
			break
		}
	}

	if targetFile != "" {
		tsDir := s.getToolScriptsDir()
		_ = os.Remove(filepath.Join(tsDir, targetFile))
	}

	if err := s.db.DeleteToolScript(id); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	json.NewEncoder(w).Encode(map[string]any{"success": true})
}

func (s *Server) handleToggleToolScript(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	var body struct {
		Enabled bool `json:"enabled"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)

	en := 0
	if body.Enabled {
		en = 1
	}
	if err := s.db.ToggleToolScript(id, en); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	json.NewEncoder(w).Encode(map[string]any{"success": true, "enabled": en})
}

func (s *Server) handleGetMcpServerTools(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	servers, err := s.db.GetMcpServers()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	var target *db.McpServer
	for _, srv := range servers {
		if srv.ID == id {
			target = &srv
			break
		}
	}

	if target == nil {
		http.Error(w, "MCP server not found", http.StatusNotFound)
		return
	}

	decls, err := tools.GlobalMCPManager.QueryServerTools(target.Source)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	json.NewEncoder(w).Encode(decls)
}

func randHex(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

