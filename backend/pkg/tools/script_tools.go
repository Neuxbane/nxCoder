package tools

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"strings"
	"time"

	"github.com/neuxbane/nxcoder/backend/pkg/db"
)

type ScriptToolDeclaration struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	Context     string         `json:"context,omitempty"`
	Parameters  ToolParameters `json:"parameters"`
}

func ExtractScriptDeclaration(scriptPath string) (*ScriptToolDeclaration, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	evalCode := fmt.Sprintf(`
import('%s').then(m => {
  const decl = m.declaration || {};
  process.stdout.write(JSON.stringify(decl));
  process.exit(0);
}).catch(err => {
  process.stderr.write(err.message || String(err));
  process.exit(1);
});
`, scriptPath)

	cmd := exec.CommandContext(ctx, "node", "--input-type=module", "-e", evalCode)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	if err := cmd.Run(); err != nil {
		return nil, fmt.Errorf("failed to evaluate script declaration: %s (err: %w)", strings.TrimSpace(stderr.String()), err)
	}

	var decl ScriptToolDeclaration
	if err := json.Unmarshal(stdout.Bytes(), &decl); err != nil {
		return nil, fmt.Errorf("failed to parse declaration JSON: %w", err)
	}

	if decl.Name == "" {
		return nil, fmt.Errorf("script declaration missing 'name'")
	}
	if decl.Context == "" {
		decl.Context = "always"
	}
	if decl.Parameters.Type == "" {
		decl.Parameters.Type = "object"
	}

	return &decl, nil
}

func ExecuteScriptTool(scriptPath string, args map[string]any) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	argsJSON, err := json.Marshal(args)
	if err != nil {
		argsJSON = []byte("{}")
	}

	evalCode := fmt.Sprintf(`
import('%s').then(async m => {
  if (typeof m.execute !== 'function') {
    throw new Error("Script does not export an 'execute' async function.");
  }
  const args = JSON.parse(process.env.NX_TOOL_ARGS || '{}');
  const result = await m.execute(args);
  if (typeof result === 'object' && result !== null) {
    process.stdout.write(JSON.stringify(result, null, 2));
  } else {
    process.stdout.write(String(result));
  }
  process.exit(0);
}).catch(err => {
  process.stderr.write(err.stack || err.message || String(err));
  process.exit(1);
});
`, scriptPath)

	cmd := exec.CommandContext(ctx, "node", "--input-type=module", "-e", evalCode)
	cmd.Env = append(cmd.Environ(), "NX_TOOL_ARGS="+string(argsJSON))

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	if err := cmd.Run(); err != nil {
		errText := strings.TrimSpace(stderr.String())
		if errText == "" {
			errText = err.Error()
		}
		return "", fmt.Errorf("script tool execution failed: %s", errText)
	}

	return stdout.String(), nil
}

func BuildScriptToolGroup(script db.ToolScript, decl *ScriptToolDeclaration) ToolGroup {
	contextStr := script.Context
	if contextStr == "" && decl != nil && decl.Context != "" {
		contextStr = decl.Context
	}
	if contextStr == "" {
		contextStr = "always"
	}

	name := script.Name
	desc := script.Description
	params := ToolParameters{Type: "object", Properties: map[string]ToolParamProperty{}}

	if decl != nil {
		if name == "" {
			name = decl.Name
		}
		if desc == "" {
			desc = decl.Description
		}
		params = decl.Parameters
	}

	return ToolGroup{
		ID:            "script_" + script.ID,
		Source:        "script",
		Context:       contextStr,
		Label:         name,
		Icon:          "fa-solid fa-code",
		ActiveVerb:    "Executing",
		CompletedVerb: "Executed",
		Enabled:       script.Enabled == 1,
		Tools: []ToolFunctionDeclaration{
			{
				Name:        name,
				Description: desc,
				Parameters:  params,
			},
		},
	}
}
