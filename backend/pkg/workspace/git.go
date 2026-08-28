package workspace

import (
	"bufio"
	"bytes"
	"crypto/md5"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

type GitRepo struct {
	RealPath   string `json:"real_path"`
	GitDir     string `json:"git_dir"`
	HashedName string `json:"hashed_name"`
	FolderName string `json:"folder_name"`
}

type SessionMessage struct {
	ID        int64           `json:"id"`
	ParentID  *int64          `json:"parentId,omitempty"`
	Role      string          `json:"role"`
	Parts     json.RawMessage `json:"parts"`
	CreatedAt string          `json:"createdAt"`
}

func GetGitReposForWorkspace(baseDir, workspaceID string, folders []string) []GitRepo {
	paths := GetWorkspacePaths(baseDir, workspaceID, "")
	var repos []GitRepo

	for _, folder := range folders {
		realPath, err := filepath.Abs(folder)
		if err != nil {
			realPath = folder
		}
		hasher := md5.New()
		hasher.Write([]byte(realPath))
		hashedName := hex.EncodeToString(hasher.Sum(nil))

		gitDir := filepath.Join(paths.WsDir, "git_repos", hashedName, ".git")
		folderName := filepath.Base(realPath)
		if folderName == "." || folderName == "/" || folderName == "" {
			folderName = "root"
		}

		repos = append(repos, GitRepo{
			RealPath:   realPath,
			GitDir:     gitDir,
			HashedName: hashedName,
			FolderName: folderName,
		})
	}

	return repos
}

func ExecGit(repo GitRepo, args ...string) (string, error) {
	cmdArgs := append([]string{
		fmt.Sprintf("--git-dir=%s", repo.GitDir),
		fmt.Sprintf("--work-tree=%s", repo.RealPath),
	}, args...)

	cmd := exec.Command("git", cmdArgs...)
	cmd.Dir = repo.RealPath

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	err := cmd.Run()
	if err != nil {
		return stdout.String(), fmt.Errorf("git error (%v): %s", err, stderr.String())
	}
	return stdout.String(), nil
}

func ExecSessionGit(sessionDir string, args ...string) (string, error) {
	cmd := exec.Command("git", args...)
	cmd.Dir = sessionDir

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	err := cmd.Run()
	if err != nil {
		return stdout.String(), fmt.Errorf("session git error (%v): %s", err, stderr.String())
	}
	return stdout.String(), nil
}

func SyncWorkspaceOnDisk(baseDir, workspaceID string, folders []string) error {
	repos := GetGitReposForWorkspace(baseDir, workspaceID, folders)
	for _, repo := range repos {
		_ = os.MkdirAll(filepath.Dir(repo.GitDir), 0755)
		if _, err := os.Stat(repo.GitDir); os.IsNotExist(err) {
			_ = os.MkdirAll(repo.RealPath, 0755)
			cmd := exec.Command("git", "init")
			cmd.Dir = repo.RealPath
			_ = cmd.Run()

			// Create shadow git repo structure if needed
			cmdInit := exec.Command("git", fmt.Sprintf("--git-dir=%s", repo.GitDir), fmt.Sprintf("--work-tree=%s", repo.RealPath), "init")
			_ = cmdInit.Run()

			_, _ = ExecGit(repo, "config", "user.name", "nxCoder")
			_, _ = ExecGit(repo, "config", "user.email", "nxcoder@localhost")
		}
	}
	return nil
}

func InitSessionGit(baseDir, workspaceID, sessionID string) error {
	paths := GetWorkspacePaths(baseDir, workspaceID, sessionID)
	_ = os.MkdirAll(paths.SessionFolder, 0755)

	gitDir := filepath.Join(paths.SessionFolder, ".git")
	if _, err := os.Stat(gitDir); os.IsNotExist(err) {
		cmd := exec.Command("git", "init")
		cmd.Dir = paths.SessionFolder
		if err := cmd.Run(); err != nil {
			return err
		}
		_, _ = ExecSessionGit(paths.SessionFolder, "config", "user.name", "nxCoder")
		_, _ = ExecSessionGit(paths.SessionFolder, "config", "user.email", "nxcoder@localhost")
	}
	return nil
}

func LoadSessionMessages(baseDir, workspaceID, sessionID string) ([]SessionMessage, error) {
	paths := GetWorkspacePaths(baseDir, workspaceID, sessionID)
	messagesFile := filepath.Join(paths.SessionFolder, "messages.jsonl")

	data, err := os.ReadFile(messagesFile)
	if err != nil {
		return []SessionMessage{}, nil
	}

	var messages []SessionMessage
	scanner := bufio.NewScanner(bytes.NewReader(data))
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		var msg SessionMessage
		if err := json.Unmarshal([]byte(line), &msg); err == nil {
			messages = append(messages, msg)
		}
	}
	return messages, nil
}

func SaveSessionMessages(baseDir, workspaceID, sessionID string, messages []SessionMessage) error {
	paths := GetWorkspacePaths(baseDir, workspaceID, sessionID)
	_ = os.MkdirAll(paths.SessionFolder, 0755)
	messagesFile := filepath.Join(paths.SessionFolder, "messages.jsonl")

	var buf bytes.Buffer
	for _, msg := range messages {
		lineBytes, err := json.Marshal(msg)
		if err == nil {
			buf.Write(lineBytes)
			buf.WriteByte('\n')
		}
	}
	return os.WriteFile(messagesFile, buf.Bytes(), 0644)
}

func CommitSessionMessage(baseDir, workspaceID, sessionID string, messageID int64, role string) error {
	paths := GetWorkspacePaths(baseDir, workspaceID, sessionID)
	_ = InitSessionGit(baseDir, workspaceID, sessionID)

	_, _ = ExecSessionGit(paths.SessionFolder, "add", "messages.jsonl")
	commitMsg := fmt.Sprintf("msg_%s%d", func() string {
		if role == "user" {
			return "user_"
		}
		return ""
	}(), messageID)

	_, err := ExecSessionGit(paths.SessionFolder, "commit", "-m", commitMsg, "--no-gpg-sign")
	return err
}

func GetSessionActiveBranch(baseDir, workspaceID, sessionID string) string {
	paths := GetWorkspacePaths(baseDir, workspaceID, sessionID)
	out, err := ExecSessionGit(paths.SessionFolder, "branch", "--show-current")
	if err == nil && strings.TrimSpace(out) != "" {
		return strings.TrimSpace(out)
	}
	return "master"
}

func CreateWorkspaceMirror(baseDir, workspaceID, sessionID string, repos []GitRepo) error {
	paths := GetWorkspacePaths(baseDir, workspaceID, sessionID)
	_ = os.MkdirAll(paths.SessionMirrorRoot, 0755)

	for _, repo := range repos {
		mirrorFolder := filepath.Join(paths.SessionMirrorRoot, repo.FolderName)
		_ = os.Remove(mirrorFolder)

		err := os.Symlink(repo.RealPath, mirrorFolder)
		if err != nil {
			_ = os.MkdirAll(mirrorFolder, 0755)
		}
	}
	return nil
}

func CleanWorkspaceMirror(baseDir, workspaceID, sessionID string, repos []GitRepo) error {
	paths := GetWorkspacePaths(baseDir, workspaceID, sessionID)
	for _, repo := range repos {
		mirrorFolder := filepath.Join(paths.SessionMirrorRoot, repo.FolderName)
		_ = os.Remove(mirrorFolder)
	}
	_ = os.Remove(paths.SessionMirrorRoot)
	return nil
}

func MergeMirrorChangesBack(baseDir, workspaceID, sessionID string, repos []GitRepo, modelMessageID int64) error {
	activeBranch := GetSessionActiveBranch(baseDir, workspaceID, sessionID)
	sessBranch := fmt.Sprintf("sess_%s_%s", sessionID, activeBranch)

	for _, repo := range repos {
		realActiveBranch := "master"
		if out, err := ExecGit(repo, "branch", "--show-current"); err == nil && strings.TrimSpace(out) != "" {
			realActiveBranch = strings.TrimSpace(out)
		}

		// 1. Checkout session branch
		_, _ = ExecGit(repo, "checkout", "-B", sessBranch)

		// 2. Stage all changes
		_, _ = ExecGit(repo, "add", "-A")

		// 3. Commit changes
		commitMsg := fmt.Sprintf("msg_%d", modelMessageID)
		_, _ = ExecGit(repo, "commit", "-m", commitMsg, "--no-gpg-sign", "--allow-empty")

		// 4. Checkout real active branch and merge
		_, _ = ExecGit(repo, "checkout", realActiveBranch)
		_, err := ExecGit(repo, "merge", sessBranch, "--no-gpg-sign")
		if err != nil {
			return fmt.Errorf("merge conflict in repository %s: %w", repo.FolderName, err)
		}
	}
	return nil
}

func FindCommitHashForMessage(repo GitRepo, messageID int64) string {
	pattern1 := fmt.Sprintf("msg_%d$", messageID)
	pattern2 := fmt.Sprintf("msg_user_%d$", messageID)
	out, err := ExecGit(repo, "log", "--all", fmt.Sprintf("--grep=%s", pattern1), fmt.Sprintf("--grep=%s", pattern2), "--format=%H", "-n", "1")
	if err == nil {
		return strings.TrimSpace(out)
	}
	return ""
}

func FindSessionCommitHashForMessage(sessionDir string, messageID int64) string {
	pattern1 := fmt.Sprintf("msg_%d$", messageID)
	pattern2 := fmt.Sprintf("msg_user_%d$", messageID)
	out, err := ExecSessionGit(sessionDir, "log", "--all", fmt.Sprintf("--grep=%s", pattern1), fmt.Sprintf("--grep=%s", pattern2), "--format=%H", "-n", "1")
	if err == nil {
		return strings.TrimSpace(out)
	}
	return ""
}

type AffectedFile struct {
	File    string `json:"file"`
	Added   int    `json:"added"`
	Deleted int    `json:"deleted"`
}

func RollbackPreview(baseDir, workspaceID, sessionID string, targetMessageID int64, repos []GitRepo) ([]AffectedFile, error) {
	allMessages, err := LoadSessionMessages(baseDir, workspaceID, sessionID)
	if err != nil {
		return nil, err
	}

	targetIdx := -1
	for i, m := range allMessages {
		if m.ID == targetMessageID {
			targetIdx = i
			break
		}
	}

	var priorMsgID int64 = -1
	if targetIdx > 0 {
		priorMsgID = allMessages[targetIdx-1].ID
	}

	var affected []AffectedFile
	for _, repo := range repos {
		var priorHash string
		if priorMsgID != -1 {
			priorHash = FindCommitHashForMessage(repo, priorMsgID)
		} else if len(allMessages) > 0 {
			firstHash := FindCommitHashForMessage(repo, allMessages[0].ID)
			if firstHash != "" {
				priorHash = firstHash + "~1"
			}
		}

		if priorHash != "" {
			out, err := ExecGit(repo, "diff", "--numstat", priorHash, "HEAD")
			if err == nil {
				lines := strings.Split(strings.TrimSpace(out), "\n")
				for _, line := range lines {
					parts := strings.Split(line, "\t")
					if len(parts) >= 3 {
						added, _ := strconv.Atoi(strings.TrimSpace(parts[0]))
						deleted, _ := strconv.Atoi(strings.TrimSpace(parts[1]))
						filePath := filepath.Join(repo.FolderName, strings.TrimSpace(parts[2]))
						affected = append(affected, AffectedFile{
							File:    filePath,
							Added:   added,
							Deleted: deleted,
						})
					}
				}
			}
		}
	}

	return affected, nil
}

func ExecuteRollback(baseDir, workspaceID, sessionID string, targetMessageID int64, repos []GitRepo) error {
	paths := GetWorkspacePaths(baseDir, workspaceID, sessionID)
	allMessages, err := LoadSessionMessages(baseDir, workspaceID, sessionID)
	if err != nil {
		return err
	}

	targetIdx := -1
	for i, m := range allMessages {
		if m.ID == targetMessageID {
			targetIdx = i
			break
		}
	}

	var priorMsgID int64 = -1
	if targetIdx > 0 {
		priorMsgID = allMessages[targetIdx-1].ID
	}

	branchSuffix := fmt.Sprintf("branch_%d", time.Now().UnixMilli())

	if priorMsgID == -1 {
		_, _ = ExecSessionGit(paths.SessionFolder, "checkout", "--orphan", branchSuffix)
		_, _ = ExecSessionGit(paths.SessionFolder, "rm", "-rf", ".")
		_ = SaveSessionMessages(baseDir, workspaceID, sessionID, []SessionMessage{})
		_, _ = ExecSessionGit(paths.SessionFolder, "add", "messages.jsonl")
		_, _ = ExecSessionGit(paths.SessionFolder, "commit", "-m", "msg_initial", "--no-gpg-sign")
	} else {
		sessHash := FindSessionCommitHashForMessage(paths.SessionFolder, priorMsgID)
		if sessHash == "" {
			return fmt.Errorf("could not find session commit hash for message ID %d", priorMsgID)
		}
		_, err := ExecSessionGit(paths.SessionFolder, "checkout", "-b", branchSuffix, sessHash)
		if err != nil {
			return fmt.Errorf("session checkout to branch failed: %w", err)
		}
	}

	newSessionBranch := fmt.Sprintf("sess_%s_%s", sessionID, branchSuffix)
	for _, repo := range repos {
		if priorMsgID == -1 {
			out, err := ExecGit(repo, "rev-list", "--max-parents=0", "HEAD")
			if err == nil {
				rootHash := strings.TrimSpace(strings.Split(out, "\n")[0])
				if rootHash != "" {
					_, _ = ExecGit(repo, "checkout", "-B", newSessionBranch, rootHash)
				}
			}
		} else {
			repoHash := FindCommitHashForMessage(repo, priorMsgID)
			if repoHash != "" {
				_, _ = ExecGit(repo, "checkout", "-B", newSessionBranch, repoHash)
			}
		}
	}

	return nil
}

type BranchInfo struct {
	ActiveBranch string                            `json:"activeBranch"`
	Branches     []string                          `json:"branches"`
	Pagination   map[int64]BranchPagination        `json:"pagination"`
	BranchPoints []BranchPoint                     `json:"branchPoints"`
}

type BranchPagination struct {
	CurrentIndex int                   `json:"currentIndex"`
	TotalCount   int                   `json:"totalCount"`
	Alternatives []BranchAlternative   `json:"alternatives"`
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

func GetSessionBranchesInfo(baseDir, workspaceID, sessionID string) (*BranchInfo, error) {
	paths := GetWorkspacePaths(baseDir, workspaceID, sessionID)
	_ = InitSessionGit(baseDir, workspaceID, sessionID)

	var branches []string
	out, err := ExecSessionGit(paths.SessionFolder, "branch", "--format=%(refname:short)")
	if err == nil {
		for _, b := range strings.Split(strings.TrimSpace(out), "\n") {
			b = strings.TrimSpace(b)
			if b != "" {
				branches = append(branches, b)
			}
		}
	}

	activeBranch := GetSessionActiveBranch(baseDir, workspaceID, sessionID)
	if len(branches) == 0 {
		branches = []string{activeBranch}
	}

	branchHistories := make(map[string][]int64)
	for _, b := range branches {
		logOut, err := ExecSessionGit(paths.SessionFolder, "log", b, "--format=%s")
		if err == nil {
			var ids []int64
			for _, line := range strings.Split(strings.TrimSpace(logOut), "\n") {
				line = strings.TrimSpace(line)
				if strings.HasPrefix(line, "msg_") {
					idStr := strings.TrimPrefix(line, "msg_")
					idStr = strings.TrimPrefix(idStr, "user_")
					if id, err := strconv.ParseInt(idStr, 10, 64); err == nil {
						ids = append(ids, id)
					}
				}
			}
			// Reverse to chronological order
			for i, j := 0, len(ids)-1; i < j; i, j = i+1, j-1 {
				ids[i], ids[j] = ids[j], ids[i]
			}
			branchHistories[b] = ids
		}
	}

	activeHistory := branchHistories[activeBranch]
	pagination := make(map[int64]BranchPagination)

	for idx, msgID := range activeHistory {
		var parentID int64 = -1
		if idx > 0 {
			parentID = activeHistory[idx-1]
		}

		var alternatives []BranchAlternative
		seenChildIDs := make(map[int64]bool)

		for _, b := range branches {
			history := branchHistories[b]
			pIdx := -1
			if parentID != -1 {
				for hIdx, hID := range history {
					if hID == parentID {
						pIdx = hIdx
						break
					}
				}
			}

			if parentID == -1 && len(history) > 0 {
				childID := history[0]
				if !seenChildIDs[childID] {
					seenChildIDs[childID] = true
					alternatives = append(alternatives, BranchAlternative{
						BranchName:  b,
						TargetMsgID: childID,
					})
				}
			} else if pIdx != -1 && pIdx+1 < len(history) {
				childID := history[pIdx+1]
				if !seenChildIDs[childID] {
					seenChildIDs[childID] = true
					alternatives = append(alternatives, BranchAlternative{
						BranchName:  b,
						TargetMsgID: childID,
					})
				}
			}
		}

		if len(alternatives) > 1 {
			activeAltIdx := -1
			for aIdx, alt := range alternatives {
				if alt.TargetMsgID == msgID {
					activeAltIdx = aIdx
					break
				}
			}

			if activeAltIdx != -1 {
				for i := range alternatives {
					alternatives[i].Index = i + 1
				}
				pagination[msgID] = BranchPagination{
					CurrentIndex: activeAltIdx + 1,
					TotalCount:   len(alternatives),
					Alternatives: alternatives,
				}
			}
		}
	}

	return &BranchInfo{
		ActiveBranch: activeBranch,
		Branches:     branches,
		Pagination:   pagination,
		BranchPoints: []BranchPoint{},
	}, nil
}

func CheckoutBranch(baseDir, workspaceID, sessionID, branchName string, repos []GitRepo) error {
	paths := GetWorkspacePaths(baseDir, workspaceID, sessionID)
	_, err := ExecSessionGit(paths.SessionFolder, "checkout", branchName)
	if err != nil {
		return err
	}

	newSessionBranch := fmt.Sprintf("sess_%s_%s", sessionID, branchName)
	for _, repo := range repos {
		out, _ := ExecGit(repo, "show-ref", "--verify", fmt.Sprintf("refs/heads/%s", newSessionBranch))
		if strings.TrimSpace(out) != "" {
			_, _ = ExecGit(repo, "checkout", newSessionBranch)
		}
	}
	return nil
}

type TimelineItem struct {
	Hash     string          `json:"hash"`
	Date     string          `json:"date"`
	Subject  string          `json:"subject"`
	Message  *SessionMessage `json:"message"`
	RepoHash string          `json:"repoHash"`
	Branches []string        `json:"branches"`
}

func GetSourceControlTimeline(baseDir, workspaceID string, repos []GitRepo, limit, offset int) ([]TimelineItem, int, bool, error) {
	type rawCommit struct {
		hash      string
		timestamp int64
		date      string
		subject   string
		repoHash  string
	}

	var allCommits []rawCommit
	for _, repo := range repos {
		out, err := ExecGit(repo, "log", "--format=%H|%at|%cd|%s")
		if err == nil {
			for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
				parts := strings.Split(line, "|")
				if len(parts) >= 4 {
					ts, _ := strconv.ParseInt(parts[1], 10, 64)
					allCommits = append(allCommits, rawCommit{
						hash:      parts[0],
						timestamp: ts,
						date:      parts[2],
						subject:   parts[3],
						repoHash:  repo.HashedName,
					})
				}
			}
		}
	}

	sort.Slice(allCommits, func(i, j int) bool {
		return allCommits[i].timestamp > allCommits[j].timestamp
	})

	totalCount := len(allCommits)
	if offset > totalCount {
		offset = totalCount
	}
	end := offset + limit
	if end > totalCount {
		end = totalCount
	}

	sliced := allCommits[offset:end]
	var timeline []TimelineItem

	for _, c := range sliced {
		var branches []string
		for _, repo := range repos {
			if repo.HashedName == c.repoHash {
				bOut, err := ExecGit(repo, "branch", "--contains", c.hash)
				if err == nil {
					for _, b := range strings.Split(strings.TrimSpace(bOut), "\n") {
						clean := strings.TrimSpace(strings.ReplaceAll(b, "*", ""))
						if clean != "" {
							branches = append(branches, clean)
						}
					}
				}
				break
			}
		}

		timeline = append(timeline, TimelineItem{
			Hash:     c.hash,
			Date:     c.date,
			Subject:  c.subject,
			Message:  nil,
			RepoHash: c.repoHash,
			Branches: branches,
		})
	}

	hasMore := offset+limit < totalCount
	return timeline, totalCount, hasMore, nil
}
