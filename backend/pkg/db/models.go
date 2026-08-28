package db

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"sync"
	"time"

	"github.com/google/uuid"
)

type ApiKey struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	Key        string `json:"key"`
	CreatedAt  string `json:"created_at"`
	Active     int    `json:"active"`
	ProviderID string `json:"provider_id"`
}

type Instruction struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Text      string `json:"text"`
	CreatedAt string `json:"created_at"`
}

type Workspace struct {
	ID            string          `json:"id"`
	Name          string          `json:"name"`
	FoldersPath   json.RawMessage `json:"folders_path"`
	InstructionID *string         `json:"instruction_id"`
	CreatedAt     string          `json:"created_at"`
}

type WorkspaceSecurity struct {
	WorkspaceID      string `json:"workspace_id"`
	SecurityMode     string `json:"security_mode"`
	AllowedCommands  string `json:"allowed_commands"`
	DeniedCommands   string `json:"denied_commands"`
	HarmlessCommands string `json:"harmless_commands"`
	AllowedTools     string `json:"allowed_tools"`
	DeniedTools      string `json:"denied_tools"`
	HarmlessTools    string `json:"harmless_tools"`
}

type Session struct {
	ID              string `json:"id"`
	WorkspaceID     string `json:"workspace_id"`
	Name            string `json:"name"`
	ActiveMessageID *int64 `json:"active_message_id,omitempty"`
	CreatedAt       string `json:"created_at"`
	UpdatedAt       string `json:"updated_at,omitempty"`
}

type SessionMessage struct {
	ID        int64           `json:"id"`
	SessionID string          `json:"sessionId,omitempty"`
	ParentID  *int64          `json:"parentId"`
	Role      string          `json:"role"`
	Parts     json.RawMessage `json:"parts"`
	CreatedAt string          `json:"createdAt"`
}

type BranchAlternative struct {
	Index       int    `json:"index"`
	BranchName  string `json:"branchName"`
	TargetMsgID int64  `json:"targetMsgId"`
}

type BranchPoint struct {
	AfterMsgID   *int64              `json:"afterMsgId"`
	CurrentIndex int                 `json:"currentIndex"`
	TotalCount   int                 `json:"totalCount"`
	Alternatives []BranchAlternative `json:"alternatives"`
}

type BranchPagination struct {
	CurrentIndex int                 `json:"currentIndex"`
	TotalCount   int                 `json:"totalCount"`
	Alternatives []BranchAlternative `json:"alternatives"`
}

type BranchInfo struct {
	ActiveBranch string                     `json:"activeBranch"`
	Branches     []string                   `json:"branches"`
	Pagination   map[int64]BranchPagination `json:"pagination,omitempty"`
	BranchPoints []BranchPoint              `json:"branchPoints"`
}

type MarketplaceSource struct {
	ID      int64  `json:"id"`
	Type    string `json:"type"`
	Source  string `json:"source"`
	AddedAt string `json:"added_at"`
}

type ProviderConfig struct {
	ID         string          `json:"id"`
	Name       string          `json:"name"`
	ProviderID string          `json:"provider_id"`
	Config     json.RawMessage `json:"config"`
	Active     int             `json:"active"`
	CreatedAt  string          `json:"created_at"`
}

type McpServer struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Type      string `json:"type"`
	Source    string `json:"source"`
	Active    int    `json:"active"`
	CreatedAt string `json:"created_at"`
}

type ToolScript struct {
	ID          string `json:"id"`
	FileName    string `json:"fileName"`
	Name        string `json:"name"`
	Description string `json:"description"`
	Context     string `json:"context"` // "always" | "project"
	Enabled     int    `json:"enabled"`
	CreatedAt   string `json:"createdAt"`
}

type CustomProvider struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	ProviderType string `json:"provider_type"`
	BaseURL      string `json:"base_url"`
	APIKey       string `json:"api_key"`
	ModelName    string `json:"model_name"`
	IsDefault    int    `json:"is_default"`
	CreatedAt    string `json:"created_at"`
}

var (
	keyRotMu sync.Mutex
	keyRotIdx int
)

// API Keys
func (d *DB) GetApiKeys() ([]ApiKey, error) {
	rows, err := d.Query("SELECT id, name, key, created_at, active, provider_id FROM api_keys ORDER BY created_at DESC")
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	keys := make([]ApiKey, 0)
	for rows.Next() {
		var k ApiKey
		if err := rows.Scan(&k.ID, &k.Name, &k.Key, &k.CreatedAt, &k.Active, &k.ProviderID); err != nil {
			return nil, err
		}
		keys = append(keys, k)
	}
	return keys, nil
}

func (d *DB) GetApiKeyByID(id string) (*ApiKey, error) {
	var k ApiKey
	err := d.QueryRow("SELECT id, name, key, created_at, active, provider_id FROM api_keys WHERE id = ?", id).
		Scan(&k.ID, &k.Name, &k.Key, &k.CreatedAt, &k.Active, &k.ProviderID)
	if err != nil {
		return nil, err
	}
	return &k, nil
}

func (d *DB) GetNextApiKey(requestedKeyID string) string {
	if requestedKeyID != "" {
		var key string
		err := d.QueryRow("SELECT key FROM api_keys WHERE id = ? AND (active IS NULL OR active = 1)", requestedKeyID).Scan(&key)
		if err == nil && key != "" {
			return key
		}
	}

	rows, err := d.Query("SELECT key FROM api_keys WHERE (active IS NULL OR active = 1)")
	if err != nil {
		return os.Getenv("GEMINI_API_KEY")
	}
	defer rows.Close()

	var keys []string
	for rows.Next() {
		var k string
		if err := rows.Scan(&k); err == nil && k != "" {
			keys = append(keys, k)
		}
	}

	if len(keys) == 0 {
		return os.Getenv("GEMINI_API_KEY")
	}

	keyRotMu.Lock()
	defer keyRotMu.Unlock()

	key := keys[keyRotIdx%len(keys)]
	keyRotIdx++
	return key
}

func (d *DB) CreateApiKey(name, key, providerID string) (*ApiKey, error) {
	id := "key_" + uuid.New().String()[:8]
	createdAt := time.Now().UTC().Format(time.RFC3339)
	if providerID == "" {
		providerID = "gemini"
	}

	_, err := d.Exec("INSERT INTO api_keys (id, name, key, created_at, active, provider_id) VALUES (?, ?, ?, ?, 1, ?)",
		id, name, key, createdAt, providerID)
	if err != nil {
		return nil, err
	}

	return &ApiKey{
		ID:         id,
		Name:       name,
		Key:        key,
		CreatedAt:  createdAt,
		Active:     1,
		ProviderID: providerID,
	}, nil
}

func (d *DB) UpdateApiKey(id, name, key string) error {
	_, err := d.Exec("UPDATE api_keys SET name = ?, key = ? WHERE id = ?", name, key, id)
	return err
}

func (d *DB) ToggleApiKey(id string, active int) error {
	_, err := d.Exec("UPDATE api_keys SET active = ? WHERE id = ?", active, id)
	return err
}

func (d *DB) DeleteApiKey(id string) error {
	_, err := d.Exec("DELETE FROM api_keys WHERE id = ?", id)
	return err
}

// Instructions
func (d *DB) GetInstructions() ([]Instruction, error) {
	rows, err := d.Query("SELECT id, name, text, created_at FROM instructions ORDER BY created_at DESC")
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	list := make([]Instruction, 0)
	for rows.Next() {
		var item Instruction
		if err := rows.Scan(&item.ID, &item.Name, &item.Text, &item.CreatedAt); err != nil {
			return nil, err
		}
		list = append(list, item)
	}
	return list, nil
}

func (d *DB) GetInstructionByID(id string) (*Instruction, error) {
	var item Instruction
	err := d.QueryRow("SELECT id, name, text, created_at FROM instructions WHERE id = ?", id).
		Scan(&item.ID, &item.Name, &item.Text, &item.CreatedAt)
	if err != nil {
		return nil, err
	}
	return &item, nil
}

func (d *DB) CreateInstruction(name, text string) (*Instruction, error) {
	id := "inst_" + uuid.New().String()[:8]
	createdAt := time.Now().UTC().Format(time.RFC3339)

	_, err := d.Exec("INSERT INTO instructions (id, name, text, created_at) VALUES (?, ?, ?, ?)",
		id, name, text, createdAt)
	if err != nil {
		return nil, err
	}

	return &Instruction{ID: id, Name: name, Text: text, CreatedAt: createdAt}, nil
}

func (d *DB) UpdateInstruction(id, name, text string) error {
	_, err := d.Exec("UPDATE instructions SET name = ?, text = ? WHERE id = ?", name, text, id)
	return err
}

func (d *DB) DeleteInstruction(id string) error {
	_, err := d.Exec("DELETE FROM instructions WHERE id = ?", id)
	return err
}

// Workspaces
func (d *DB) GetWorkspaces() ([]Workspace, error) {
	rows, err := d.Query("SELECT id, name, folders_path, instruction_id, created_at FROM workspaces WHERE id != 'ws_general' AND id != 'ws_default' ORDER BY created_at DESC")
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	list := make([]Workspace, 0)
	for rows.Next() {
		var w Workspace
		var fp string
		if err := rows.Scan(&w.ID, &w.Name, &fp, &w.InstructionID, &w.CreatedAt); err != nil {
			return nil, err
		}
		if fp == "" || fp == "null" {
			w.FoldersPath = json.RawMessage("[]")
		} else {
			w.FoldersPath = json.RawMessage(fp)
		}
		list = append(list, w)
	}
	return list, nil
}

func (d *DB) GetAllWorkspaces() ([]Workspace, error) {
	rows, err := d.Query("SELECT id, name, folders_path, instruction_id, created_at FROM workspaces ORDER BY created_at DESC")
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	list := make([]Workspace, 0)
	for rows.Next() {
		var w Workspace
		var fp string
		if err := rows.Scan(&w.ID, &w.Name, &fp, &w.InstructionID, &w.CreatedAt); err != nil {
			return nil, err
		}
		if fp == "" || fp == "null" {
			w.FoldersPath = json.RawMessage("[]")
		} else {
			w.FoldersPath = json.RawMessage(fp)
		}
		list = append(list, w)
	}
	return list, nil
}

func (d *DB) GetWorkspaceByID(id string) (*Workspace, error) {
	var w Workspace
	var fp string
	err := d.QueryRow("SELECT id, name, folders_path, instruction_id, created_at FROM workspaces WHERE id = ?", id).
		Scan(&w.ID, &w.Name, &fp, &w.InstructionID, &w.CreatedAt)
	if err != nil {
		return nil, err
	}
	if fp == "" || fp == "null" {
		w.FoldersPath = json.RawMessage("[]")
	} else {
		w.FoldersPath = json.RawMessage(fp)
	}
	return &w, nil
}

func (d *DB) CreateWorkspace(name string, foldersPath []string, instructionID *string) (*Workspace, error) {
	id := "ws_" + uuid.New().String()[:8]
	createdAt := time.Now().UTC().Format(time.RFC3339)
	fpJSON, _ := json.Marshal(foldersPath)

	_, err := d.Exec("INSERT INTO workspaces (id, name, folders_path, instruction_id, created_at) VALUES (?, ?, ?, ?, ?)",
		id, name, string(fpJSON), instructionID, createdAt)
	if err != nil {
		return nil, err
	}

	_, _ = d.Exec(`INSERT OR IGNORE INTO workspace_security (workspace_id) VALUES (?)`, id)

	return &Workspace{
		ID:            id,
		Name:          name,
		FoldersPath:   json.RawMessage(fpJSON),
		InstructionID: instructionID,
		CreatedAt:     createdAt,
	}, nil
}

func (d *DB) UpdateWorkspace(id, name string, foldersPath []string, instructionID *string) error {
	fpJSON, _ := json.Marshal(foldersPath)
	_, err := d.Exec("UPDATE workspaces SET name = ?, folders_path = ?, instruction_id = ? WHERE id = ?",
		name, string(fpJSON), instructionID, id)
	return err
}

func (d *DB) DeleteWorkspace(id string) error {
	_, err := d.Exec("DELETE FROM workspaces WHERE id = ?", id)
	return err
}

// Workspace Security
func (d *DB) GetOrCreateWorkspaceSecurity(workspaceID string) (*WorkspaceSecurity, error) {
	defaultHarmlessTools := `["list_dir", "read_file", "regex_search", "view_image", "wait", "wait_terminal", "get_sub_agent_status", "wait_sub_agent", "set_session_name"]`
	defaultHarmlessCmds := `["npm test", "git status", "git diff", "ls", "pwd", "echo", "node -v", "npm -v"]`

	_, _ = d.Exec(`INSERT OR IGNORE INTO workspace_security 
		(workspace_id, security_mode, allowed_commands, denied_commands, harmless_commands, allowed_tools, denied_tools, harmless_tools) 
		VALUES (?, 'auto_harmless', '[]', '[]', ?, '[]', '[]', ?)`,
		workspaceID, defaultHarmlessCmds, defaultHarmlessTools)

	var s WorkspaceSecurity
	err := d.QueryRow(`SELECT workspace_id, security_mode, allowed_commands, denied_commands, harmless_commands, allowed_tools, denied_tools, harmless_tools 
		FROM workspace_security WHERE workspace_id = ?`, workspaceID).
		Scan(&s.WorkspaceID, &s.SecurityMode, &s.AllowedCommands, &s.DeniedCommands, &s.HarmlessCommands, &s.AllowedTools, &s.DeniedTools, &s.HarmlessTools)
	if err != nil {
		return nil, err
	}
	return &s, nil
}

func (d *DB) UpdateWorkspaceSecurity(s *WorkspaceSecurity) error {
	_, err := d.Exec(`UPDATE workspace_security 
		SET security_mode = ?, allowed_commands = ?, denied_commands = ?, harmless_commands = ?, allowed_tools = ?, denied_tools = ?, harmless_tools = ? 
		WHERE workspace_id = ?`,
		s.SecurityMode, s.AllowedCommands, s.DeniedCommands, s.HarmlessCommands, s.AllowedTools, s.DeniedTools, s.HarmlessTools, s.WorkspaceID)
	return err
}

// Sessions
func (d *DB) GetSessions(workspaceID string) ([]Session, error) {
	if workspaceID == "" {
		workspaceID = "ws_general"
	}
	query := `
		SELECT id, workspace_id, name, active_message_id, created_at, COALESCE(updated_at, created_at) as updated_at
		FROM sessions
		WHERE workspace_id = ?
		ORDER BY updated_at DESC`
	
	rows, err := d.Query(query, workspaceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	list := make([]Session, 0)
	for rows.Next() {
		var s Session
		var activeMsgID sql.NullInt64
		if err := rows.Scan(&s.ID, &s.WorkspaceID, &s.Name, &activeMsgID, &s.CreatedAt, &s.UpdatedAt); err != nil {
			return nil, err
		}
		if activeMsgID.Valid {
			v := activeMsgID.Int64
			s.ActiveMessageID = &v
		}
		list = append(list, s)
	}
	return list, nil
}

func (d *DB) GetSessionByID(sessionID string) (*Session, error) {
	var s Session
	var activeMsgID sql.NullInt64
	err := d.QueryRow("SELECT id, workspace_id, name, active_message_id, created_at, COALESCE(updated_at, created_at) FROM sessions WHERE id = ?", sessionID).
		Scan(&s.ID, &s.WorkspaceID, &s.Name, &activeMsgID, &s.CreatedAt, &s.UpdatedAt)
	if err != nil {
		return nil, err
	}
	if activeMsgID.Valid {
		v := activeMsgID.Int64
		s.ActiveMessageID = &v
	}
	return &s, nil
}

func (d *DB) CreateSession(workspaceID, name string) (*Session, error) {
	if workspaceID == "" {
		workspaceID = "ws_general"
	}
	id := "sess_" + uuid.New().String()[:8]
	createdAt := time.Now().UTC().Format(time.RFC3339)
	if name == "" {
		name = "New Agentic Chat Session"
	}

	var wsCount int
	_ = d.QueryRow("SELECT COUNT(1) FROM workspaces WHERE id = ?", workspaceID).Scan(&wsCount)
	if wsCount == 0 {
		wsName := "General"
		if workspaceID != "ws_general" && workspaceID != "ws_default" {
			wsName = "Workspace " + workspaceID
		}
		_, _ = d.Exec("INSERT OR IGNORE INTO workspaces (id, name, folders_path, created_at) VALUES (?, ?, '[]', ?)",
			workspaceID, wsName, createdAt)
	}

	_, err := d.Exec("INSERT INTO sessions (id, workspace_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
		id, workspaceID, name, createdAt, createdAt)
	if err != nil {
		return nil, err
	}

	return &Session{
		ID:          id,
		WorkspaceID: workspaceID,
		Name:        name,
		CreatedAt:   createdAt,
		UpdatedAt:   createdAt,
	}, nil
}

func (d *DB) EnsureSession(workspaceID, sessionID, name string) error {
	var count int
	_ = d.QueryRow("SELECT COUNT(1) FROM sessions WHERE id = ?", sessionID).Scan(&count)
	if count == 0 {
		if name == "" {
			name = "New Agentic Chat Session"
		}
		createdAt := time.Now().UTC().Format(time.RFC3339)
		if workspaceID == "" {
			workspaceID = "ws_general"
		}
		var wsCount int
		_ = d.QueryRow("SELECT COUNT(1) FROM workspaces WHERE id = ?", workspaceID).Scan(&wsCount)
		if wsCount == 0 {
			wsName := "General"
			if workspaceID != "ws_general" && workspaceID != "ws_default" {
				wsName = "Workspace " + workspaceID
			}
			_, _ = d.Exec("INSERT OR IGNORE INTO workspaces (id, name, folders_path, created_at) VALUES (?, ?, '[]', ?)",
				workspaceID, wsName, createdAt)
		}
		_, err := d.Exec("INSERT OR IGNORE INTO sessions (id, workspace_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
			sessionID, workspaceID, name, createdAt, createdAt)
		return err
	}
	return nil
}

func (d *DB) DeleteSession(id string) error {
	_, err := d.Exec("DELETE FROM sessions WHERE id = ?", id)
	return err
}

func (d *DB) UpdateSessionName(id, name string) error {
	now := time.Now().UTC().Format(time.RFC3339)
	_, err := d.Exec("UPDATE sessions SET name = ?, updated_at = ? WHERE id = ?", name, now, id)
	return err
}

func (d *DB) TouchSession(sessionID string) error {
	now := time.Now().UTC().Format(time.RFC3339)
	_, err := d.Exec("UPDATE sessions SET updated_at = ? WHERE id = ?", now, sessionID)
	return err
}

// Chain of Request & Tree Thread Storage
func (d *DB) InsertSessionMessage(sessionID string, parentID *int64, role string, parts any) (*SessionMessage, error) {
	partsJSON, err := json.Marshal(parts)
	if err != nil {
		return nil, err
	}

	// If parentID is nil, inherit from the session's active_message_id
	if parentID == nil {
		var activeMsgID sql.NullInt64
		_ = d.QueryRow("SELECT active_message_id FROM sessions WHERE id = ?", sessionID).Scan(&activeMsgID)
		if activeMsgID.Valid && activeMsgID.Int64 > 0 {
			pID := activeMsgID.Int64
			parentID = &pID
		}
	}

	createdAt := time.Now().UTC().Format(time.RFC3339)
	var res sql.Result
	if parentID != nil {
		res, err = d.Exec("INSERT INTO messages (session_id, parent_id, role, parts, created_at) VALUES (?, ?, ?, ?, ?)",
			sessionID, *parentID, role, string(partsJSON), createdAt)
	} else {
		res, err = d.Exec("INSERT INTO messages (session_id, parent_id, role, parts, created_at) VALUES (?, NULL, ?, ?, ?)",
			sessionID, role, string(partsJSON), createdAt)
	}
	if err != nil {
		return nil, err
	}

	newID, _ := res.LastInsertId()
	_, _ = d.Exec("UPDATE sessions SET active_message_id = ?, updated_at = ? WHERE id = ?", newID, createdAt, sessionID)

	return &SessionMessage{
		ID:        newID,
		SessionID: sessionID,
		ParentID:  parentID,
		Role:      role,
		Parts:     partsJSON,
		CreatedAt: createdAt,
	}, nil
}

func (d *DB) GetSessionThread(sessionID string, targetMessageID *int64) ([]SessionMessage, error) {
	if targetMessageID == nil {
		var activeMsgID sql.NullInt64
		_ = d.QueryRow("SELECT active_message_id FROM sessions WHERE id = ?", sessionID).Scan(&activeMsgID)
		if activeMsgID.Valid && activeMsgID.Int64 > 0 {
			v := activeMsgID.Int64
			targetMessageID = &v
		} else {
			var lastID sql.NullInt64
			_ = d.QueryRow("SELECT id FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT 1", sessionID).Scan(&lastID)
			if lastID.Valid && lastID.Int64 > 0 {
				v := lastID.Int64
				targetMessageID = &v
			}
		}
	}

	if targetMessageID == nil {
		return []SessionMessage{}, nil
	}

	query := `
		WITH RECURSIVE thread_chain AS (
			SELECT id, session_id, parent_id, role, parts, created_at, 0 AS depth
			FROM messages
			WHERE id = ? AND session_id = ?
			UNION ALL
			SELECT m.id, m.session_id, m.parent_id, m.role, m.parts, m.created_at, tc.depth + 1
			FROM messages m
			JOIN thread_chain tc ON m.id = tc.parent_id
		)
		SELECT id, session_id, parent_id, role, parts, created_at
		FROM thread_chain
		ORDER BY depth DESC`

	rows, err := d.Query(query, *targetMessageID, sessionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	list := make([]SessionMessage, 0)
	for rows.Next() {
		var m SessionMessage
		var parentID sql.NullInt64
		var partsStr string
		if err := rows.Scan(&m.ID, &m.SessionID, &parentID, &m.Role, &partsStr, &m.CreatedAt); err != nil {
			return nil, err
		}
		if parentID.Valid {
			pID := parentID.Int64
			m.ParentID = &pID
		}
		m.Parts = json.RawMessage(partsStr)
		list = append(list, m)
	}

	if len(list) == 0 {
		// Fallback for unlinked messages
		allRows, err := d.Query("SELECT id, session_id, parent_id, role, parts, created_at FROM messages WHERE session_id = ? ORDER BY id ASC", sessionID)
		if err == nil {
			defer allRows.Close()
			for allRows.Next() {
				var m SessionMessage
				var parentID sql.NullInt64
				var partsStr string
				if err := allRows.Scan(&m.ID, &m.SessionID, &parentID, &m.Role, &partsStr, &m.CreatedAt); err == nil {
					if parentID.Valid {
						pID := parentID.Int64
						m.ParentID = &pID
					}
					m.Parts = json.RawMessage(partsStr)
					list = append(list, m)
				}
			}
		}
	}

	return list, nil
}

func (d *DB) findDeepestLeaf(sessionID string, rootMsgID int64) int64 {
	query := `
		WITH RECURSIVE descendants AS (
			SELECT id, parent_id, 0 AS depth
			FROM messages
			WHERE id = ? AND session_id = ?
			UNION ALL
			SELECT m.id, m.parent_id, d.depth + 1
			FROM messages m
			JOIN descendants d ON m.parent_id = d.id
			WHERE m.session_id = ?
		)
		SELECT id FROM descendants ORDER BY depth DESC, id DESC LIMIT 1`

	var leafID int64
	err := d.QueryRow(query, rootMsgID, sessionID, sessionID).Scan(&leafID)
	if err != nil {
		return rootMsgID
	}
	return leafID
}

func (d *DB) SetActiveMessage(sessionID string, targetMsgID int64) error {
	leafID := d.findDeepestLeaf(sessionID, targetMsgID)
	now := time.Now().UTC().Format(time.RFC3339)
	_, err := d.Exec("UPDATE sessions SET active_message_id = ?, updated_at = ? WHERE id = ?", leafID, now, sessionID)
	return err
}

func (d *DB) GetSessionBranchPoints(sessionID string, activeThread []SessionMessage) ([]BranchPoint, error) {
	parentIDs := make([]*int64, 0)
	parentIDs = append(parentIDs, nil)
	for _, msg := range activeThread {
		msgID := msg.ID
		parentIDs = append(parentIDs, &msgID)
	}

	activeMsgSet := make(map[int64]bool)
	for _, msg := range activeThread {
		activeMsgSet[msg.ID] = true
	}

	branchPoints := make([]BranchPoint, 0)

	for _, parentID := range parentIDs {
		var rows *sql.Rows
		var err error
		if parentID == nil {
			rows, err = d.Query("SELECT id FROM messages WHERE session_id = ? AND parent_id IS NULL ORDER BY id ASC", sessionID)
		} else {
			rows, err = d.Query("SELECT id FROM messages WHERE session_id = ? AND parent_id = ? ORDER BY id ASC", sessionID, *parentID)
		}
		if err != nil {
			continue
		}

		siblingIDs := make([]int64, 0)
		for rows.Next() {
			var sID int64
			if err := rows.Scan(&sID); err == nil {
				siblingIDs = append(siblingIDs, sID)
			}
		}
		rows.Close()

		if len(siblingIDs) > 1 {
			currentIdx := 1
			alternatives := make([]BranchAlternative, 0, len(siblingIDs))

			for idx, sID := range siblingIDs {
				if activeMsgSet[sID] {
					currentIdx = idx + 1
				}
				leafID := d.findDeepestLeaf(sessionID, sID)
				alternatives = append(alternatives, BranchAlternative{
					Index:       idx + 1,
					BranchName:  fmt.Sprintf("%d", leafID),
					TargetMsgID: leafID,
				})
			}

			branchPoints = append(branchPoints, BranchPoint{
				AfterMsgID:   parentID,
				CurrentIndex: currentIdx,
				TotalCount:   len(siblingIDs),
				Alternatives: alternatives,
			})
		}
	}

	return branchPoints, nil
}

func (d *DB) GetSessionBranchesInfo(sessionID string) (*BranchInfo, error) {
	thread, err := d.GetSessionThread(sessionID, nil)
	if err != nil {
		return nil, err
	}
	branchPoints, err := d.GetSessionBranchPoints(sessionID, thread)
	if err != nil {
		return nil, err
	}

	var activeLeafID int64
	if len(thread) > 0 {
		activeLeafID = thread[len(thread)-1].ID
	}

	branches := make([]string, 0)
	for _, bp := range branchPoints {
		for _, alt := range bp.Alternatives {
			branches = append(branches, alt.BranchName)
		}
	}
	if len(branches) == 0 && activeLeafID > 0 {
		branches = append(branches, fmt.Sprintf("%d", activeLeafID))
	}

	return &BranchInfo{
		ActiveBranch: fmt.Sprintf("%d", activeLeafID),
		Branches:     branches,
		BranchPoints: branchPoints,
	}, nil
}

// Custom Model Providers
func (d *DB) GetCustomProviders() ([]CustomProvider, error) {
	rows, err := d.Query("SELECT id, name, provider_type, base_url, api_key, model_name, is_default, created_at FROM custom_providers ORDER BY is_default DESC, created_at DESC")
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	list := make([]CustomProvider, 0)
	for rows.Next() {
		var p CustomProvider
		var bUrl, aKey sql.NullString
		if err := rows.Scan(&p.ID, &p.Name, &p.ProviderType, &bUrl, &aKey, &p.ModelName, &p.IsDefault, &p.CreatedAt); err != nil {
			return nil, err
		}
		if bUrl.Valid {
			p.BaseURL = bUrl.String
		}
		if aKey.Valid {
			p.APIKey = aKey.String
		}
		list = append(list, p)
	}
	return list, nil
}

func (d *DB) GetDefaultCustomProvider() (*CustomProvider, error) {
	var p CustomProvider
	var bUrl, aKey sql.NullString
	err := d.QueryRow("SELECT id, name, provider_type, base_url, api_key, model_name, is_default, created_at FROM custom_providers WHERE is_default = 1 LIMIT 1").
		Scan(&p.ID, &p.Name, &p.ProviderType, &bUrl, &aKey, &p.ModelName, &p.IsDefault, &p.CreatedAt)
	if err != nil {
		return nil, err
	}
	if bUrl.Valid {
		p.BaseURL = bUrl.String
	}
	if aKey.Valid {
		p.APIKey = aKey.String
	}
	return &p, nil
}

func (d *DB) CreateCustomProvider(name, providerType, baseURL, apiKey, modelName string, isDefault int) (*CustomProvider, error) {
	id := "prov_" + uuid.New().String()[:8]
	createdAt := time.Now().UTC().Format(time.RFC3339)

	if isDefault == 1 {
		_, _ = d.Exec("UPDATE custom_providers SET is_default = 0")
	}

	_, err := d.Exec("INSERT INTO custom_providers (id, name, provider_type, base_url, api_key, model_name, is_default, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
		id, name, providerType, baseURL, apiKey, modelName, isDefault, createdAt)
	if err != nil {
		return nil, err
	}

	return &CustomProvider{
		ID:           id,
		Name:         name,
		ProviderType: providerType,
		BaseURL:      baseURL,
		APIKey:       apiKey,
		ModelName:    modelName,
		IsDefault:    isDefault,
		CreatedAt:    createdAt,
	}, nil
}

func (d *DB) DeleteCustomProvider(id string) error {
	_, err := d.Exec("DELETE FROM custom_providers WHERE id = ?", id)
	return err
}

func (d *DB) SetDefaultCustomProvider(id string) error {
	if _, err := d.Exec("UPDATE custom_providers SET is_default = 0"); err != nil {
		return err
	}
	_, err := d.Exec("UPDATE custom_providers SET is_default = 1 WHERE id = ?", id)
	return err
}

// Marketplace Sources
func (d *DB) GetMarketplaceSources() ([]MarketplaceSource, error) {
	rows, err := d.Query("SELECT id, type, source, added_at FROM marketplace_sources ORDER BY id ASC")
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	list := make([]MarketplaceSource, 0)
	for rows.Next() {
		var s MarketplaceSource
		if err := rows.Scan(&s.ID, &s.Type, &s.Source, &s.AddedAt); err != nil {
			return nil, err
		}
		list = append(list, s)
	}
	return list, nil
}

func (d *DB) AddMarketplaceSource(srcType, source string) (*MarketplaceSource, error) {
	addedAt := time.Now().UTC().Format(time.RFC3339)
	res, err := d.Exec("INSERT INTO marketplace_sources (type, source, added_at) VALUES (?, ?, ?)", srcType, source, addedAt)
	if err != nil {
		return nil, err
	}
	lastID, _ := res.LastInsertId()
	return &MarketplaceSource{
		ID:      lastID,
		Type:    srcType,
		Source:  source,
		AddedAt: addedAt,
	}, nil
}

func (d *DB) DeleteMarketplaceSource(id int64) error {
	var src string
	_ = d.QueryRow("SELECT source FROM marketplace_sources WHERE id = ?", id).Scan(&src)
	if src != "" {
		_, _ = d.Exec("DELETE FROM mcp_servers WHERE source = ?", src)
	}
	_, err := d.Exec("DELETE FROM marketplace_sources WHERE id = ?", id)
	return err
}

// Provider Configs
func (d *DB) GetProviderConfigs() ([]ProviderConfig, error) {
	rows, err := d.Query("SELECT id, name, provider_id, config, active, created_at FROM provider_configs ORDER BY created_at DESC")
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	list := make([]ProviderConfig, 0)
	for rows.Next() {
		var p ProviderConfig
		var cfgStr string
		if err := rows.Scan(&p.ID, &p.Name, &p.ProviderID, &cfgStr, &p.Active, &p.CreatedAt); err != nil {
			return nil, err
		}
		p.Config = json.RawMessage(cfgStr)
		list = append(list, p)
	}
	return list, nil
}

func (d *DB) AddProviderConfig(name, providerID, config string) (*ProviderConfig, error) {
	id := "cfg_" + uuid.New().String()[:8]
	createdAt := time.Now().UTC().Format(time.RFC3339)

	var count int
	_ = d.QueryRow("SELECT COUNT(1) FROM provider_configs").Scan(&count)
	active := 0
	if count == 0 {
		active = 1
	}

	_, err := d.Exec("INSERT INTO provider_configs (id, name, provider_id, config, active, created_at) VALUES (?, ?, ?, ?, ?, ?)",
		id, name, providerID, config, active, createdAt)
	if err != nil {
		return nil, err
	}

	return &ProviderConfig{
		ID:         id,
		Name:       name,
		ProviderID: providerID,
		Config:     json.RawMessage(config),
		Active:     active,
		CreatedAt:  createdAt,
	}, nil
}

func (d *DB) UpdateProviderConfig(id, name, config string) error {
	_, err := d.Exec("UPDATE provider_configs SET name = ?, config = ? WHERE id = ?", name, config, id)
	return err
}

func (d *DB) DeleteProviderConfig(id string) error {
	_, err := d.Exec("DELETE FROM provider_configs WHERE id = ?", id)
	return err
}

func (d *DB) SetActiveProviderConfig(id string) error {
	if _, err := d.Exec("UPDATE provider_configs SET active = 0"); err != nil {
		return err
	}
	_, err := d.Exec("UPDATE provider_configs SET active = 1 WHERE id = ?", id)
	return err
}

// MCP Servers
func (d *DB) GetMcpServers() ([]McpServer, error) {
	rows, err := d.Query("SELECT id, name, type, source, active, created_at FROM mcp_servers ORDER BY created_at DESC")
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	list := make([]McpServer, 0)
	for rows.Next() {
		var s McpServer
		if err := rows.Scan(&s.ID, &s.Name, &s.Type, &s.Source, &s.Active, &s.CreatedAt); err != nil {
			return nil, err
		}
		list = append(list, s)
	}
	return list, nil
}

func (d *DB) AddMcpServer(name, serverType, source string) (*McpServer, error) {
	id := "mcp_" + uuid.New().String()[:8]
	createdAt := time.Now().UTC().Format(time.RFC3339)

	_, err := d.Exec("INSERT OR IGNORE INTO mcp_servers (id, name, type, source, active, created_at) VALUES (?, ?, ?, ?, 1, ?)",
		id, name, serverType, source, createdAt)
	if err != nil {
		return nil, err
	}

	return &McpServer{
		ID:        id,
		Name:      name,
		Type:      serverType,
		Source:    source,
		Active:    1,
		CreatedAt: createdAt,
	}, nil
}

func (d *DB) DeleteMcpServer(id string) error {
	_, err := d.Exec("DELETE FROM mcp_servers WHERE id = ?", id)
	return err
}

func (d *DB) ToggleMcpServer(id string, active int) error {
	_, err := d.Exec("UPDATE mcp_servers SET active = ? WHERE id = ?", active, id)
	return err
}

// Tool Scripts
func (d *DB) GetToolScripts() ([]ToolScript, error) {
	rows, err := d.Query("SELECT id, file_name, name, description, context, enabled, created_at FROM tool_scripts ORDER BY created_at DESC")
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	list := make([]ToolScript, 0)
	for rows.Next() {
		var s ToolScript
		var desc sql.NullString
		if err := rows.Scan(&s.ID, &s.FileName, &s.Name, &desc, &s.Context, &s.Enabled, &s.CreatedAt); err != nil {
			return nil, err
		}
		if desc.Valid {
			s.Description = desc.String
		}
		list = append(list, s)
	}
	return list, nil
}

func (d *DB) UpsertToolScript(id, fileName, name, description, contextStr string, enabled int) (*ToolScript, error) {
	if id == "" {
		id = "tool_" + uuid.New().String()[:8]
	}
	createdAt := time.Now().UTC().Format(time.RFC3339)
	if contextStr == "" {
		contextStr = "always"
	}

	_, err := d.Exec(`INSERT INTO tool_scripts (id, file_name, name, description, context, enabled, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(file_name) DO UPDATE SET
			name = excluded.name,
			description = excluded.description,
			context = excluded.context,
			enabled = excluded.enabled`,
		id, fileName, name, description, contextStr, enabled, createdAt)
	if err != nil {
		return nil, err
	}

	return &ToolScript{
		ID:          id,
		FileName:    fileName,
		Name:        name,
		Description: description,
		Context:     contextStr,
		Enabled:     enabled,
		CreatedAt:   createdAt,
	}, nil
}

func (d *DB) DeleteToolScript(id string) error {
	_, err := d.Exec("DELETE FROM tool_scripts WHERE id = ?", id)
	return err
}

func (d *DB) DeleteToolScriptByFileName(fileName string) error {
	_, err := d.Exec("DELETE FROM tool_scripts WHERE file_name = ?", fileName)
	return err
}

func (d *DB) ToggleToolScript(id string, enabled int) error {
	_, err := d.Exec("UPDATE tool_scripts SET enabled = ? WHERE id = ?", enabled, id)
	return err
}

