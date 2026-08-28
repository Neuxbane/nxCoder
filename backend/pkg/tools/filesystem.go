package tools

import (
	"bufio"
	"encoding/base64"
	"fmt"
	"mime"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/neuxbane/nxcoder/backend/pkg/workspace"
)

type FileItem struct {
	Name string `json:"name"`
	Type string `json:"type"` // file, directory
}

type ReadFileResult struct {
	Content    string `json:"content"`
	StartLine  int    `json:"startLine"`
	EndLine    int    `json:"endLine"`
	TotalLines int    `json:"totalLines"`
	Clipped    bool   `json:"clipped"`
}

type EditFileResult struct {
	Success bool   `json:"success"`
	Message string `json:"message"`
	Snippet string `json:"snippet,omitempty"`
}

type GrepMatch struct {
	Path      string `json:"path"`
	Line      int    `json:"line,omitempty"`
	MatchType string `json:"matchType"` // fileName or content
	Text      string `json:"text,omitempty"`
}

type ParseDocResult struct {
	Success         bool     `json:"success"`
	Message         string   `json:"message"`
	OutputDirectory string   `json:"outputDirectory"`
	MarkdownFile    string   `json:"markdownFile"`
	ExtractedImages []string `json:"extractedImages"`
	FilesCreated    []string `json:"filesCreated"`
}

type ViewImageResult struct {
	Success     bool        `json:"success"`
	Message     string      `json:"message"`
	InlineImage InlineImage `json:"inlineImage"`
}

type InlineImage struct {
	Data     string `json:"data"`
	MimeType string `json:"mimeType"`
}

func TruncateOutput(outputStr string, maxLength int) string {
	if maxLength <= 0 {
		maxLength = 8000
	}
	if len(outputStr) <= maxLength {
		return outputStr
	}
	half := maxLength / 2
	return outputStr[:half] + fmt.Sprintf("\n\n...[OUTPUT TRUNCATED: %d characters omitted to preserve context bounds]...\n\n", len(outputStr)-maxLength) + outputStr[len(outputStr)-half:]
}

func SanitizeToolResult(result any, maxStringLength int) any {
	if result == nil {
		return nil
	}
	if maxStringLength <= 0 {
		maxStringLength = 12000
	}

	switch v := result.(type) {
	case string:
		if len(v) > maxStringLength {
			return v[:maxStringLength] + fmt.Sprintf("\n... [truncated %d chars]", len(v)-maxStringLength)
		}
		return v
	case []any:
		sanitized := make([]any, len(v))
		for i, item := range v {
			sanitized[i] = SanitizeToolResult(item, maxStringLength)
		}
		return sanitized
	case map[string]any:
		sanitized := make(map[string]any)
		for k, val := range v {
			if k == "inlineImage" || k == "inlineData" {
				sanitized[k] = map[string]any{
					"mimeType": "image/png",
					"data":     "[binary blob stripped — already injected into context]",
				}
				continue
			}
			sanitized[k] = SanitizeToolResult(val, maxStringLength)
		}
		return sanitized
	default:
		return result
	}
}

func ListDir(baseDir, workspaceID, sessionID, targetPath string, repos []workspace.GitRepo) ([]FileItem, error) {
	resolvedPath, err := workspace.ValidateAndResolvePath(baseDir, workspaceID, sessionID, targetPath, repos)
	if err != nil {
		return nil, err
	}

	entries, err := os.ReadDir(resolvedPath)
	if err != nil {
		return nil, fmt.Errorf("failed to read dir: %w", err)
	}

	var items []FileItem
	for _, entry := range entries {
		itemType := "file"
		if entry.IsDir() {
			itemType = "directory"
		}
		items = append(items, FileItem{
			Name: entry.Name(),
			Type: itemType,
		})
	}
	return items, nil
}

func ReadFile(baseDir, workspaceID, sessionID, filePath string, fromLine, toLine int, repos []workspace.GitRepo) (*ReadFileResult, error) {
	resolvedPath, err := workspace.ValidateAndResolvePath(baseDir, workspaceID, sessionID, filePath, repos)
	if err != nil {
		return nil, err
	}

	stat, err := os.Stat(resolvedPath)
	if err != nil {
		return nil, err
	}
	if stat.IsDir() {
		return nil, fmt.Errorf("target path is a directory")
	}

	file, err := os.Open(resolvedPath)
	if err != nil {
		return nil, err
	}
	defer file.Close()

	var allLines []string
	scanner := bufio.NewScanner(file)
	buf := make([]byte, 1024*1024)
	scanner.Buffer(buf, 10*1024*1024)

	for scanner.Scan() {
		allLines = append(allLines, scanner.Text())
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}

	totalLines := len(allLines)
	if totalLines == 0 {
		return &ReadFileResult{Content: "", StartLine: 1, EndLine: 0, TotalLines: 0, Clipped: false}, nil
	}

	start := fromLine
	if start <= 0 {
		start = 1
	}

	maxCap := 1000
	end := toLine
	if end <= 0 {
		end = start + maxCap - 1
	}

	if start > totalLines {
		start = totalLines
	}
	if end > totalLines {
		end = totalLines
	}
	if end < start {
		return nil, fmt.Errorf("invalid line range: start %d > end %d", start, end)
	}

	selected := allLines[start-1 : end]
	clipped := len(selected) < totalLines

	return &ReadFileResult{
		Content:    TruncateOutput(strings.Join(selected, "\n"), 16000),
		StartLine:  start,
		EndLine:    end,
		TotalLines: totalLines,
		Clipped:    clipped,
	}, nil
}

func WriteFile(baseDir, workspaceID, sessionID, filePath, content string, repos []workspace.GitRepo) error {
	resolvedPath, err := workspace.ValidateAndResolvePath(baseDir, workspaceID, sessionID, filePath, repos)
	if err != nil {
		return err
	}

	if err := os.MkdirAll(filepath.Dir(resolvedPath), 0755); err != nil {
		return err
	}
	return os.WriteFile(resolvedPath, []byte(content), 0644)
}

func EditFile(baseDir, workspaceID, sessionID, filePath, search, replace string, occurrence int, repos []workspace.GitRepo) (*EditFileResult, error) {
	resolvedPath, err := workspace.ValidateAndResolvePath(baseDir, workspaceID, sessionID, filePath, repos)
	if err != nil {
		return nil, err
	}

	data, err := os.ReadFile(resolvedPath)
	if err != nil {
		return nil, err
	}

	original := string(data)
	if occurrence <= 0 {
		occurrence = 1
	}

	searchFrom := 0
	matchCount := 0
	matchIndex := -1

	for {
		idx := strings.Index(original[searchFrom:], search)
		if idx == -1 {
			break
		}
		realIdx := searchFrom + idx
		matchCount++
		if matchCount == occurrence {
			matchIndex = realIdx
		}
		searchFrom = realIdx + len(search)
	}

	if matchCount == 0 {
		preview := original
		if len(preview) > 400 {
			preview = preview[:400]
		}
		preview = strings.ReplaceAll(preview, "\n", "\\n")
		return nil, fmt.Errorf("Search block not found in file. File begins with: ...%s...", preview)
	}

	if matchIndex == -1 {
		return nil, fmt.Errorf("Only %d occurrence(s) found but occurrence=%d was requested", matchCount, occurrence)
	}

	patched := original[:matchIndex] + replace + original[matchIndex+len(search):]
	if err := os.WriteFile(resolvedPath, []byte(patched), 0644); err != nil {
		return nil, err
	}

	patchedLines := strings.Split(patched, "\n")
	startLineIdx := len(strings.Split(original[:matchIndex], "\n")) - 1
	endLineIdx := startLineIdx + len(strings.Split(replace, "\n")) - 1

	rangeStart := startLineIdx - 10
	if rangeStart < 0 {
		rangeStart = 0
	}
	rangeEnd := endLineIdx + 11
	if rangeEnd > len(patchedLines) {
		rangeEnd = len(patchedLines)
	}

	snippet := strings.Join(patchedLines[rangeStart:rangeEnd], "\n")

	return &EditFileResult{
		Success: true,
		Message: fmt.Sprintf("Patch applied (occurrence %d/%d). Replaced %d chars with %d chars.", occurrence, matchCount, len(search), len(replace)),
		Snippet: snippet,
	}, nil
}

func RegexSearch(baseDir, workspaceID, sessionID, regexStr string, paths []string, searchFileName, searchFileContent bool, ignore []string, repos []workspace.GitRepo) ([]GrepMatch, error) {
	re, err := regexp.Compile(regexStr)
	if err != nil {
		return nil, fmt.Errorf("invalid regex pattern: %w", err)
	}

	wPaths := workspace.GetWorkspacePaths(baseDir, workspaceID, sessionID)
	var results []GrepMatch

	ignoreList := []string{".git", "node_modules", "target", "dist", "build"}
	ignoreList = append(ignoreList, ignore...)

	isIgnored := func(path string) bool {
		for _, ign := range ignoreList {
			if strings.Contains(path, ign) {
				return true
			}
		}
		return false
	}

	searchFile := func(filePath string) {
		if isIgnored(filePath) {
			return
		}
		rel, _ := filepath.Rel(wPaths.SessionFolder, filePath)
		if searchFileName && re.MatchString(filepath.Base(filePath)) {
			results = append(results, GrepMatch{
				Path:      rel,
				MatchType: "fileName",
			})
		}
		if searchFileContent {
			f, err := os.Open(filePath)
			if err != nil {
				return
			}
			defer f.Close()

			scanner := bufio.NewScanner(f)
			lineNum := 0
			for scanner.Scan() {
				lineNum++
				line := scanner.Text()
				if re.MatchString(line) {
					results = append(results, GrepMatch{
						Path:      rel,
						Line:      lineNum,
						MatchType: "content",
						Text:      strings.TrimSpace(line),
					})
					if len(results) >= 100 {
						return
					}
				}
			}
		}
	}

	for _, targetPath := range paths {
		resolved, err := workspace.ValidateAndResolvePath(baseDir, workspaceID, sessionID, targetPath, repos)
		if err != nil {
			continue
		}

		stat, err := os.Stat(resolved)
		if err != nil {
			continue
		}

		if stat.IsDir() {
			_ = filepath.WalkDir(resolved, func(p string, d os.DirEntry, err error) error {
				if err != nil || d == nil {
					return nil
				}
				if d.IsDir() {
					if isIgnored(p) {
						return filepath.SkipDir
					}
					return nil
				}
				searchFile(p)
				return nil
			})
		} else {
			searchFile(resolved)
		}
	}

	return results, nil
}

func ViewImage(baseDir, workspaceID, sessionID, filePath string, repos []workspace.GitRepo) (*ViewImageResult, error) {
	resolvedPath, err := workspace.ValidateAndResolvePath(baseDir, workspaceID, sessionID, filePath, repos)
	if err != nil {
		return nil, err
	}

	data, err := os.ReadFile(resolvedPath)
	if err != nil {
		return nil, err
	}

	mimeType := mime.TypeByExtension(filepath.Ext(resolvedPath))
	if mimeType == "" {
		mimeType = http.DetectContentType(data)
	}

	b64 := base64.StdEncoding.EncodeToString(data)
	return &ViewImageResult{
		Success: true,
		Message: fmt.Sprintf("Image at \"%s\" has been injected into context as an inline asset.", filePath),
		InlineImage: InlineImage{
			Data:     b64,
			MimeType: mimeType,
		},
	}, nil
}

func ParseDocument(baseDir, workspaceID, sessionID, filePath, outputName string, apiKey string, repos []workspace.GitRepo) (*ParseDocResult, error) {
	resolvedPath, err := workspace.ValidateAndResolvePath(baseDir, workspaceID, sessionID, filePath, repos)
	if err != nil {
		return nil, err
	}

	wPaths := workspace.GetWorkspacePaths(baseDir, workspaceID, sessionID)
	baseName := strings.TrimSuffix(filepath.Base(resolvedPath), filepath.Ext(resolvedPath))
	if outputName == "" {
		outputName = baseName
	}
	cleanFolderName := regexp.MustCompile(`[^a-zA-Z0-9.-]`).ReplaceAllString(outputName, "_")

	outputDir := filepath.Join(wPaths.SessionFolder, cleanFolderName)
	_ = os.MkdirAll(outputDir, 0755)

	ext := strings.ToLower(filepath.Ext(resolvedPath))
	if ext == ".pdf" {
		imgPrefix := filepath.Join(outputDir, "img")
		cmd := exec.Command("pdfimages", "-png", resolvedPath, imgPrefix)
		_ = cmd.Run()
	} else if ext == ".docx" || ext == ".pptx" || ext == ".xlsx" {
		cmd := exec.Command("unzip", "-j", "-q", resolvedPath, "*/media/*", "-d", outputDir)
		_ = cmd.Run()
	}

	entries, _ := os.ReadDir(outputDir)
	var imageFiles []string
	imgExts := map[string]bool{".png": true, ".jpg": true, ".jpeg": true, ".gif": true, ".webp": true}

	for _, entry := range entries {
		if !entry.IsDir() && imgExts[strings.ToLower(filepath.Ext(entry.Name()))] {
			imageFiles = append(imageFiles, entry.Name())
		}
	}
	sort.Strings(imageFiles)

	var renamedImages []string
	for i, file := range imageFiles {
		fExt := filepath.Ext(file)
		newName := fmt.Sprintf("image_%d%s", i+1, fExt)
		_ = os.Rename(filepath.Join(outputDir, file), filepath.Join(outputDir, newName))
		renamedImages = append(renamedImages, newName)
	}

	outputMdPath := filepath.Join(outputDir, cleanFolderName+".md")
	mdContent := fmt.Sprintf("# Document: %s\n\nParsed at %s\n\n", filepath.Base(resolvedPath), time.Now().Format(time.RFC3339))
	for _, img := range renamedImages {
		mdContent += fmt.Sprintf("![Image](%s)\n\n", img)
	}
	_ = os.WriteFile(outputMdPath, []byte(mdContent), 0644)

	relMd, _ := filepath.Rel(wPaths.SessionFolder, outputMdPath)
	relDir, _ := filepath.Rel(wPaths.SessionFolder, outputDir)

	filesCreated := []string{relMd}
	for _, img := range renamedImages {
		filesCreated = append(filesCreated, filepath.Join(relDir, img))
	}

	return &ParseDocResult{
		Success:         true,
		Message:         "Parsed document successfully.",
		OutputDirectory: relDir,
		MarkdownFile:    relMd,
		ExtractedImages: renamedImages,
		FilesCreated:    filesCreated,
	}, nil
}
