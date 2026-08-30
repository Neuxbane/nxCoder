package db

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	_ "modernc.org/sqlite"
)

type DB struct {
	*sql.DB
}

func Open(dataDir string) (*DB, error) {
	if dataDir == "" {
		dataDir = "."
	}

	if err := os.MkdirAll(dataDir, 0755); err != nil {
		return nil, fmt.Errorf("failed to create data dir: %w", err)
	}

	dbPath := filepath.Join(dataDir, "database.sqlite")
	sqlDb, err := sql.Open("sqlite", dbPath+"?_pragma=foreign_keys(1)&_pragma=journal_mode(WAL)")
	if err != nil {
		return nil, fmt.Errorf("failed to open sqlite database at %s: %w", dbPath, err)
	}

	d := &DB{DB: sqlDb}
	if err := d.Migrate(); err != nil {
		return nil, fmt.Errorf("failed to run migrations: %w", err)
	}

	return d, nil
}

func (d *DB) Migrate() error {
	migrations := []string{
		`CREATE TABLE IF NOT EXISTS api_keys (
			id TEXT PRIMARY KEY,
			name TEXT,
			key TEXT,
			created_at TEXT,
			active INTEGER DEFAULT 1,
			provider_id TEXT DEFAULT 'gemini'
		);`,
		`CREATE TABLE IF NOT EXISTS instructions (
			id TEXT PRIMARY KEY,
			name TEXT,
			text TEXT,
			created_at TEXT
		);`,
		`CREATE TABLE IF NOT EXISTS workspaces (
			id TEXT PRIMARY KEY,
			name TEXT,
			folders_path TEXT,
			instruction_id TEXT,
			created_at TEXT,
			FOREIGN KEY (instruction_id) REFERENCES instructions(id) ON DELETE SET NULL
		);`,
		`CREATE TABLE IF NOT EXISTS workspace_security (
			workspace_id TEXT PRIMARY KEY,
			security_mode TEXT DEFAULT 'auto_harmless',
			allowed_commands TEXT DEFAULT '[]',
			denied_commands TEXT DEFAULT '[]',
			harmless_commands TEXT DEFAULT '["npm test", "git status", "git diff", "ls", "pwd", "echo", "node -v", "npm -v"]',
			allowed_tools TEXT DEFAULT '[]',
			denied_tools TEXT DEFAULT '[]',
			harmless_tools TEXT DEFAULT '["list_dir", "read_file", "regex_search", "view_image", "wait", "wait_terminal", "get_sub_agent_status", "wait_sub_agent", "set_session_name"]',
			FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
		);`,
		`CREATE TABLE IF NOT EXISTS sessions (
			id TEXT PRIMARY KEY,
			workspace_id TEXT,
			name TEXT,
			active_message_id INTEGER,
			created_at TEXT,
			updated_at TEXT,
			FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
		);`,
		`ALTER TABLE sessions ADD COLUMN updated_at TEXT;`,
		`ALTER TABLE sessions ADD COLUMN active_message_id INTEGER;`,
		`CREATE TABLE IF NOT EXISTS messages (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			session_id TEXT NOT NULL,
			parent_id INTEGER,
			role TEXT NOT NULL,
			parts TEXT NOT NULL,
			created_at TEXT NOT NULL,
			FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
			FOREIGN KEY (parent_id) REFERENCES messages(id) ON DELETE SET NULL
		);`,
		`ALTER TABLE messages ADD COLUMN parent_id INTEGER;`,
		`CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);`,
		`CREATE INDEX IF NOT EXISTS idx_messages_parent ON messages(parent_id);`,
		`CREATE TABLE IF NOT EXISTS marketplace_sources (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			type TEXT,
			source TEXT UNIQUE,
			added_at TEXT
		);`,
		`CREATE TABLE IF NOT EXISTS provider_configs (
			id TEXT PRIMARY KEY,
			name TEXT,
			provider_id TEXT,
			config TEXT,
			active INTEGER DEFAULT 0,
			created_at TEXT
		);`,
		`CREATE TABLE IF NOT EXISTS mcp_servers (
			id TEXT PRIMARY KEY,
			name TEXT,
			type TEXT,
			source TEXT UNIQUE,
			active INTEGER DEFAULT 1,
			created_at TEXT
		);`,
		`CREATE TABLE IF NOT EXISTS custom_providers (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			provider_type TEXT NOT NULL,
			base_url TEXT,
			api_key TEXT,
			model_name TEXT NOT NULL,
			is_default INTEGER DEFAULT 0,
			created_at TEXT
		);`,
		`CREATE TABLE IF NOT EXISTS tool_scripts (
			id TEXT PRIMARY KEY,
			file_name TEXT NOT NULL UNIQUE,
			name TEXT NOT NULL,
			description TEXT,
			context TEXT DEFAULT 'always',
			enabled INTEGER DEFAULT 1,
			created_at TEXT
		);`,
		`ALTER TABLE instructions ADD COLUMN description TEXT DEFAULT '';`,
		`ALTER TABLE instructions ADD COLUMN is_conditional INTEGER DEFAULT 0;`,
		`ALTER TABLE instructions ADD COLUMN enabled INTEGER DEFAULT 1;`,
		`ALTER TABLE instructions ADD COLUMN embedding TEXT DEFAULT '';`,
		`ALTER TABLE instructions ADD COLUMN updated_at TEXT;`,
		`CREATE TABLE IF NOT EXISTS app_settings (
			key TEXT PRIMARY KEY,
			value TEXT
		);`,
		`INSERT OR IGNORE INTO app_settings (key, value) VALUES ('instruction_top_k', '3');`,
		`INSERT OR IGNORE INTO app_settings (key, value) VALUES ('tool_output_max_chars', '2500');`,
		`ALTER TABLE custom_providers ADD COLUMN config TEXT DEFAULT '{}';`,
		`INSERT OR IGNORE INTO workspaces (id, name, folders_path, created_at) VALUES ('ws_general', 'Conversations', '[]', datetime('now'));`,
	}

	for _, query := range migrations {
		if _, err := d.Exec(query); err != nil {
			if strings.Contains(err.Error(), "duplicate column name") {
				continue
			}
			return fmt.Errorf("migration query failed (%s): %w", query, err)
		}
	}

	return nil
}
