package workspace

import (
	"archive/zip"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// ExtractZipSafe extracts a ZIP archive into destDir with Zip Slip protection.
// It returns a list of extracted relative file paths.
func ExtractZipSafe(zipPath, destDir string) ([]string, error) {
	reader, err := zip.OpenReader(zipPath)
	if err != nil {
		return nil, fmt.Errorf("failed to open zip file: %w", err)
	}
	defer reader.Close()

	if err := os.MkdirAll(destDir, 0755); err != nil {
		return nil, fmt.Errorf("failed to create destination directory: %w", err)
	}

	destClean := filepath.Clean(destDir)
	var extractedFiles []string

	for _, file := range reader.File {
		// Clean and prevent Zip Slip (Directory Traversal)
		cleanPath := filepath.Clean(file.Name)
		if strings.HasPrefix(cleanPath, "..") || filepath.IsAbs(cleanPath) {
			continue
		}

		targetPath := filepath.Join(destClean, cleanPath)
		if !strings.HasPrefix(targetPath, destClean+string(os.PathSeparator)) && targetPath != destClean {
			continue
		}

		if file.FileInfo().IsDir() {
			if err := os.MkdirAll(targetPath, 0755); err != nil {
				return extractedFiles, fmt.Errorf("failed to create folder %s: %w", targetPath, err)
			}
			continue
		}

		if err := os.MkdirAll(filepath.Dir(targetPath), 0755); err != nil {
			return extractedFiles, fmt.Errorf("failed to create parent directory for %s: %w", targetPath, err)
		}

		outFile, err := os.OpenFile(targetPath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, file.Mode())
		if err != nil {
			return extractedFiles, fmt.Errorf("failed to open output file %s: %w", targetPath, err)
		}

		rc, err := file.Open()
		if err != nil {
			_ = outFile.Close()
			return extractedFiles, fmt.Errorf("failed to read zip entry %s: %w", file.Name, err)
		}

		_, copyErr := io.Copy(outFile, rc)
		_ = rc.Close()
		_ = outFile.Close()

		if copyErr != nil {
			return extractedFiles, fmt.Errorf("failed to write file %s: %w", targetPath, copyErr)
		}

		rel, _ := filepath.Rel(destClean, targetPath)
		extractedFiles = append(extractedFiles, rel)
	}

	return extractedFiles, nil
}
