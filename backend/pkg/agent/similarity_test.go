package agent

import (
	"testing"

	"github.com/neuxbane/nxcoder/backend/pkg/db"
)

func TestCosineSimilarity(t *testing.T) {
	v1 := []float32{1.0, 0.0, 0.0}
	v2 := []float32{1.0, 0.0, 0.0}
	v3 := []float32{0.0, 1.0, 0.0}

	sim1 := CosineSimilarity(v1, v2)
	if sim1 < 0.99 {
		t.Errorf("expected ~1.0 for identical vectors, got %f", sim1)
	}

	sim2 := CosineSimilarity(v1, v3)
	if sim2 > 0.01 {
		t.Errorf("expected ~0.0 for orthogonal vectors, got %f", sim2)
	}
}

func TestMatchInstructions(t *testing.T) {
	instructions := []db.Instruction{
		{
			ID:            "inst_1",
			Name:          "General Style",
			Text:          "Be concise.",
			IsConditional: false,
			Enabled:       true,
		},
		{
			ID:            "inst_2",
			Name:          "Database Rules",
			Description:   "Postgres SQL queries table migrations schema",
			Text:          "Always use parameterized SQL queries.",
			IsConditional: true,
			Enabled:       true,
		},
		{
			ID:            "inst_3",
			Name:          "Frontend UI Rules",
			Description:   "Tailwind CSS React components HTML buttons",
			Text:          "Use responsive flexbox and Tailwind classes.",
			IsConditional: true,
			Enabled:       true,
		},
		{
			ID:            "inst_4",
			Name:          "Disabled Instruction",
			Text:          "Should not appear.",
			IsConditional: false,
			Enabled:       false,
		},
	}

	// 1. Query matching database
	matchedDB := MatchInstructions(instructions, "How do I create a new postgres migration table?", 1)
	if len(matchedDB) != 2 {
		t.Fatalf("expected 2 instructions (1 always-on + 1 conditional), got %d", len(matchedDB))
	}
	if matchedDB[0].ID != "inst_1" {
		t.Errorf("expected inst_1 (always on) as first result, got %s", matchedDB[0].ID)
	}
	if matchedDB[1].ID != "inst_2" {
		t.Errorf("expected inst_2 (database rules) as matched conditional, got %s", matchedDB[1].ID)
	}

	// 2. Query matching frontend UI
	matchedUI := MatchInstructions(instructions, "Fix button styling in React Tailwind component", 1)
	if len(matchedUI) != 2 {
		t.Fatalf("expected 2 instructions (1 always-on + 1 conditional), got %d", len(matchedUI))
	}
	if matchedUI[1].ID != "inst_3" {
		t.Errorf("expected inst_3 (frontend UI rules) as matched conditional, got %s", matchedUI[1].ID)
	}
}
