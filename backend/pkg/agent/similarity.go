package agent

import (
	"hash/fnv"
	"math"
	"sort"
	"strings"
	"unicode"

	"github.com/neuxbane/nxcoder/backend/pkg/db"
)

// CosineSimilarity computes cosine similarity between two float32 vectors
func CosineSimilarity(a, b []float32) float32 {
	if len(a) == 0 || len(b) == 0 || len(a) != len(b) {
		return 0
	}

	var dot, normA, normB float32
	for i := 0; i < len(a); i++ {
		dot += a[i] * b[i]
		normA += a[i] * a[i]
		normB += b[i] * b[i]
	}

	if normA == 0 || normB == 0 {
		return 0
	}

	return dot / (float32(math.Sqrt(float64(normA))) * float32(math.Sqrt(float64(normB))))
}

// GenerateTextVector produces a dense 384-dimensional normalized vector from text
// based on character n-grams and subwords (FastText/MiniLM-style hashing projection)
func GenerateTextVector(text string, dim int) []float32 {
	if dim <= 0 {
		dim = 384
	}
	vec := make([]float32, dim)
	clean := strings.ToLower(text)

	// Tokenize into words
	words := strings.FieldsFunc(clean, func(r rune) bool {
		return !unicode.IsLetter(r) && !unicode.IsNumber(r)
	})

	if len(words) == 0 {
		return vec
	}

	for _, w := range words {
		if len(w) == 0 {
			continue
		}
		// Hash whole word
		h := fnv32(w)
		idx := int(h % uint32(dim))
		sign := float32(1.0)
		if (h>>16)%2 == 1 {
			sign = -1.0
		}
		vec[idx] += 2.0 * sign

		// Character 3-grams and 4-grams for subword semantics
		padded := "<" + w + ">"
		for n := 3; n <= 4 && n <= len(padded); n++ {
			for i := 0; i <= len(padded)-n; i++ {
				ngram := padded[i : i+n]
				nh := fnv32(ngram)
				nidx := int(nh % uint32(dim))
				nsign := float32(1.0)
				if (nh>>16)%2 == 1 {
					nsign = -1.0
				}
				vec[nidx] += 1.0 * nsign
			}
		}
	}

	// L2 normalize
	var norm float32
	for _, v := range vec {
		norm += v * v
	}
	if norm > 0 {
		scale := float32(1.0 / math.Sqrt(float64(norm)))
		for i := range vec {
			vec[i] *= scale
		}
	}

	return vec
}

func fnv32(s string) uint32 {
	h := fnv.New32a()
	_, _ = h.Write([]byte(s))
	return h.Sum32()
}

type ScoredInstruction struct {
	Instruction db.Instruction
	Score       float32
}

// MatchInstructions filters and ranks enabled instructions against the user prompt.
// Non-conditional instructions are always included.
// Conditional instructions are ranked by semantic similarity and trimmed to topK.
func MatchInstructions(instructions []db.Instruction, userPrompt string, topK int) []db.Instruction {
	if topK <= 0 {
		topK = 3
	}

	var alwaysOn []db.Instruction
	var scoredCond []ScoredInstruction

	var promptVec []float32
	if strings.TrimSpace(userPrompt) != "" {
		promptVec = GenerateTextVector(userPrompt, 384)
	}

	for _, inst := range instructions {
		if !inst.Enabled {
			continue
		}

		if !inst.IsConditional {
			alwaysOn = append(alwaysOn, inst)
			continue
		}

		// Conditional matching
		condText := strings.TrimSpace(inst.Name + " " + inst.Description)
		if condText == "" {
			continue
		}

		var instVec []float32
		if len(inst.Embedding) == 384 {
			instVec = inst.Embedding
		} else {
			instVec = GenerateTextVector(condText, 384)
		}

		var score float32
		if len(promptVec) > 0 && len(instVec) > 0 {
			score = CosineSimilarity(promptVec, instVec)
		}

		scoredCond = append(scoredCond, ScoredInstruction{
			Instruction: inst,
			Score:       score,
		})
	}

	// Sort conditional instructions by score descending
	sort.SliceStable(scoredCond, func(i, j int) bool {
		return scoredCond[i].Score > scoredCond[j].Score
	})

	var selectedCond []db.Instruction
	for i := 0; i < len(scoredCond) && i < topK; i++ {
		// Include if positive similarity score or if top matches
		if scoredCond[i].Score > 0.05 || (i == 0 && scoredCond[i].Score > 0) {
			selectedCond = append(selectedCond, scoredCond[i].Instruction)
		}
	}

	result := make([]db.Instruction, 0, len(alwaysOn)+len(selectedCond))
	result = append(result, alwaysOn...)
	result = append(result, selectedCond...)
	return result
}
