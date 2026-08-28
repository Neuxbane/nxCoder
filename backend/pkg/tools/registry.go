package tools

type ToolParamProperty struct {
	Type        string                       `json:"type"`
	Description string                       `json:"description,omitempty"`
	Items       *ToolParamProperty           `json:"items,omitempty"`
	Properties  map[string]ToolParamProperty `json:"properties,omitempty"`
}

type ToolFunctionDeclaration struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	Parameters  ToolParameters `json:"parameters"`
}

type ToolParameters struct {
	Type       string                       `json:"type"`
	Properties map[string]ToolParamProperty `json:"properties"`
	Required   []string                     `json:"required,omitempty"`
}

type ToolGroup struct {
	ID      string                    `json:"id"`
	Source  string                    `json:"source"`  // "builtin" | "script" | "mcp"
	Context string                    `json:"context"` // "always" | "project"
	Label   string                    `json:"label"`
	Icon    string                    `json:"icon"`
	Tools   []ToolFunctionDeclaration `json:"tools"`
	Enabled bool                      `json:"enabled"`
}

func BuiltinToolGroups() []ToolGroup {
	return []ToolGroup{
		{
			ID:      "filesystem",
			Source:  "builtin",
			Context: "project",
			Label:   "File System",
			Icon:    "fa-solid fa-folder-tree",
			Enabled: true,
			Tools: []ToolFunctionDeclaration{
				{
					Name:        "list_dir",
					Description: "Lists files and directory structures inside paths. All paths are relative to your session workspace root.",
					Parameters: ToolParameters{
						Type: "object",
						Properties: map[string]ToolParamProperty{
							"path": {Type: "string", Description: "Relative path within your session workspace (e.g. \"workspace_mirror/myproject/src\", \"uploads\")."},
						},
						Required: []string{"path"},
					},
				},
				{
					Name:        "read_file",
					Description: "Reads contents of file, supporting pagination. Returns the content and the total line count of the file.",
					Parameters: ToolParameters{
						Type: "object",
						Properties: map[string]ToolParamProperty{
							"path":      {Type: "string", Description: "Relative path to target file (e.g. \"workspace_mirror/myproject/index.html\" or \"uploads/abc.pdf\")."},
							"from_line": {Type: "integer", Description: "First line index target. Use negative values to count from end."},
							"to_line":   {Type: "integer", Description: "End line index target. Use negative values to count from end."},
						},
						Required: []string{"path"},
					},
				},
				{
					Name:        "write_file",
					Description: "Creates a new file or completely overwrites an existing file. Use ONLY for creating new files or when replacing the entire content. For editing existing files, use edit_file instead.",
					Parameters: ToolParameters{
						Type: "object",
						Properties: map[string]ToolParamProperty{
							"path":    {Type: "string", Description: "Relative path within your session workspace (e.g. \"workspace_mirror/myproject/new_file.js\")."},
							"content": {Type: "string", Description: "Complete file contents to write."},
						},
						Required: []string{"path", "content"},
					},
				},
				{
					Name:        "edit_file",
					Description: "Patches an existing file using a search-block / replace-block strategy. Finds an exact occurrence of `search` in the file and replaces it with `replace`. The `search` block must exactly match the file content including whitespace and indentation.",
					Parameters: ToolParameters{
						Type: "object",
						Properties: map[string]ToolParamProperty{
							"path":       {Type: "string", Description: "Relative path to the file to patch (e.g. \"workspace_mirror/myproject/src/index.js\")."},
							"search":     {Type: "string", Description: "The exact text block to find in the file. Must match character-for-character."},
							"replace":    {Type: "string", Description: "The replacement text that will substitute the matched search block."},
							"occurrence": {Type: "integer", Description: "Which occurrence to replace when there are multiple matches (1-based, default 1)."},
						},
						Required: []string{"path", "search", "replace"},
					},
				},
				{
					Name:        "regex_search",
					Description: "Searches for a regular expression in file names or file contents within specified paths.",
					Parameters: ToolParameters{
						Type: "object",
						Properties: map[string]ToolParamProperty{
							"regexStr": {Type: "string", Description: "The regular expression to search for."},
							"paths":    {Type: "array", Items: &ToolParamProperty{Type: "string"}, Description: "The paths to search within."},
						},
						Required: []string{"regexStr", "paths"},
					},
				},
			},
		},
		{
			ID:      "terminal_exec",
			Source:  "builtin",
			Context: "project",
			Label:   "Terminal Execution",
			Icon:    "fa-solid fa-terminal",
			Enabled: true,
			Tools: []ToolFunctionDeclaration{
				{
					Name:        "execute_command",
					Description: "Spawns terminal actions asynchronously. Returns output quickly or terminal_id and relative log_file path you can read with read_file.",
					Parameters: ToolParameters{
						Type: "object",
						Properties: map[string]ToolParamProperty{
							"command": {Type: "string", Description: "The terminal command to run."},
							"path":    {Type: "string", Description: "Relative path within session workspace where command should run (e.g. \"workspace_mirror/myproject\")."},
							"name":    {Type: "string", Description: "Optional descriptive name for the terminal session."},
						},
						Required: []string{"command", "path"},
					},
				},
			},
		},
		{
			ID:      "media",
			Source:  "builtin",
			Context: "project",
			Label:   "Media & Documents",
			Icon:    "fa-solid fa-file-lines",
			Enabled: true,
			Tools: []ToolFunctionDeclaration{
				{
					Name:        "parse_document",
					Description: "Converts a document (PDF, Word, Excel, PowerPoint, Text, HTML, CSV) to Markdown and extracts any embedded images.",
					Parameters: ToolParameters{
						Type: "object",
						Properties: map[string]ToolParamProperty{
							"filepath":   {Type: "string", Description: "Relative path to the document file (e.g. \"uploads/report.pdf\")."},
							"outputName": {Type: "string", Description: "Optional custom name for output folder and Markdown file."},
						},
						Required: []string{"filepath"},
					},
				},
				{
					Name:        "view_image",
					Description: "Loads an image file (PNG, JPEG, WEBP, GIF, SVG) and injects it directly into context.",
					Parameters: ToolParameters{
						Type: "object",
						Properties: map[string]ToolParamProperty{
							"path": {Type: "string", Description: "Relative path to the image file (e.g. \"uploads/photo.png\")."},
						},
						Required: []string{"path"},
					},
				},
			},
		},
		{
			ID:      "terminal_control",
			Source:  "builtin",
			Context: "always",
			Label:   "Terminal Control",
			Icon:    "fa-solid fa-keyboard",
			Enabled: true,
			Tools: []ToolFunctionDeclaration{
				{
					Name:        "send_terminal_input",
					Description: "Sends keyboard input or ASCII/escape sequences to a running terminal session's stdin (e.g. y/n, Enter, Ctrl+C).",
					Parameters: ToolParameters{
						Type: "object",
						Properties: map[string]ToolParamProperty{
							"terminal_id": {Type: "string", Description: "The target terminal session ID returned from execute_command."},
							"input":       {Type: "string", Description: "The input string to write to terminal stdin."},
						},
						Required: []string{"terminal_id", "input"},
					},
				},
				{
					Name:        "wait",
					Description: "Pauses active stream model turns for processing tasks.",
					Parameters: ToolParameters{
						Type: "object",
						Properties: map[string]ToolParamProperty{
							"seconds": {Type: "integer", Description: "Seconds count to pause."},
						},
						Required: []string{"seconds"},
					},
				},
				{
					Name:        "wait_terminal",
					Description: "Awaits complete background program outputs or logs.",
					Parameters: ToolParameters{
						Type: "object",
						Properties: map[string]ToolParamProperty{
							"terminal_id":     {Type: "string", Description: "Target terminal tracking process ID."},
							"timeout_seconds": {Type: "integer", Description: "Max check timeout seconds (Default 10)."},
						},
						Required: []string{"terminal_id"},
					},
				},
				{
					Name:        "terminate_terminal",
					Description: "Immediately kills running terminal tasks.",
					Parameters: ToolParameters{
						Type: "object",
						Properties: map[string]ToolParamProperty{
							"terminal_id": {Type: "string", Description: "Active terminal target ID."},
						},
						Required: []string{"terminal_id"},
					},
				},
			},
		},
		{
			ID:      "agent_control",
			Source:  "builtin",
			Context: "always",
			Label:   "Session Controls",
			Icon:    "fa-solid fa-sliders",
			Enabled: true,
			Tools: []ToolFunctionDeclaration{
				{
					Name:        "set_session_name",
					Description: "Renames the current active chat window title dynamically.",
					Parameters: ToolParameters{
						Type: "object",
						Properties: map[string]ToolParamProperty{
							"name": {Type: "string", Description: "Fresh chat title string."},
						},
						Required: []string{"name"},
					},
				},
			},
		},
		{
			ID:      "subagents",
			Source:  "builtin",
			Context: "always",
			Label:   "Sub-Agent Orchestration",
			Icon:    "fa-solid fa-network-wired",
			Enabled: true,
			Tools: []ToolFunctionDeclaration{
				{
					Name:        "spawn_sub_agent",
					Description: "Spawns a new sub-AI agent asynchronously in the background.",
					Parameters: ToolParameters{
						Type: "object",
						Properties: map[string]ToolParamProperty{
							"name":                   {Type: "string", Description: "A short descriptive name for the sub-agent task."},
							"prompt":                 {Type: "string", Description: "The prompt/task description for the sub-agent to solve."},
							"instruction_profile_id": {Type: "string", Description: "Optional instruction profile ID."},
						},
						Required: []string{"name", "prompt"},
					},
				},
				{
					Name:        "get_sub_agent_status",
					Description: "Checks the current execution status, recent chat history, and final output result of a previously spawned sub-agent.",
					Parameters: ToolParameters{
						Type: "object",
						Properties: map[string]ToolParamProperty{
							"sub_agent_id":     {Type: "string", Description: "The unique ID returned by spawn_sub_agent."},
							"max_recent_chars": {Type: "integer", Description: "Optional limit on returned history text size. Default is 4000."},
						},
						Required: []string{"sub_agent_id"},
					},
				},
				{
					Name:        "wait_sub_agent",
					Description: "Blocks and waits until the target sub-agent completes its execution. Returns final status and output.",
					Parameters: ToolParameters{
						Type: "object",
						Properties: map[string]ToolParamProperty{
							"sub_agent_id": {Type: "string", Description: "The unique ID returned by spawn_sub_agent."},
						},
						Required: []string{"sub_agent_id"},
					},
				},
			},
		},
	}
}

func GetActiveGroups(hasProject bool, isSubAgent bool, scriptGroups []ToolGroup, mcpGroups []ToolGroup) []ToolGroup {
	var active []ToolGroup

	for _, g := range BuiltinToolGroups() {
		if isSubAgent && g.ID == "subagents" {
			continue
		}
		if g.Context == "project" && !hasProject {
			continue
		}
		active = append(active, g)
	}

	for _, sg := range scriptGroups {
		if !sg.Enabled {
			continue
		}
		if sg.Context == "project" && !hasProject {
			continue
		}
		active = append(active, sg)
	}

	for _, mg := range mcpGroups {
		if !mg.Enabled {
			continue
		}
		if mg.Context == "project" && !hasProject {
			continue
		}
		active = append(active, mg)
	}

	return active
}

func GroupsToGeminiDeclarations(groups []ToolGroup) []map[string]any {
	var fnDecls []map[string]any

	for _, g := range groups {
		for _, d := range g.Tools {
			fnDecls = append(fnDecls, map[string]any{
				"name":        d.Name,
				"description": d.Description,
				"parameters":  d.Parameters,
			})
		}
	}

	if len(fnDecls) == 0 {
		return nil
	}

	return []map[string]any{
		{"function_declarations": fnDecls},
	}
}

func GroupsToOpenAIDeclarations(groups []ToolGroup) []map[string]any {
	var openAITools []map[string]any

	for _, g := range groups {
		for _, d := range g.Tools {
			openAITools = append(openAITools, map[string]any{
				"type": "function",
				"function": map[string]any{
					"name":        d.Name,
					"description": d.Description,
					"parameters":  d.Parameters,
				},
			})
		}
	}

	return openAITools
}

func GetGeminiToolDeclarations(isSubAgent bool) []map[string]any {
	groups := GetActiveGroups(true, isSubAgent, nil, nil)
	return GroupsToGeminiDeclarations(groups)
}

func GetOpenAIToolDeclarations(isSubAgent bool) []map[string]any {
	groups := GetActiveGroups(true, isSubAgent, nil, nil)
	return GroupsToOpenAIDeclarations(groups)
}
