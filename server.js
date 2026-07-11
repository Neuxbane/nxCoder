import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { GoogleGenAI, Type } from '@google/genai';
import multer from 'multer';
import mime from 'mime';
import path from 'path';
import fs from 'fs/promises';
import fsSync from 'fs';
import os from 'os';
import crypto from 'crypto';
import sqlite3 from 'sqlite3';
import { spawn, exec } from 'child_process';
import { promisify } from 'util';
import readline from 'readline';
import { fileURLToPath } from 'url';
import { deviceManager, createVisualGrid } from './deviceControl.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dbSource = './database.sqlite';
const sqliteDb = new sqlite3.Database(dbSource);

// Enable foreign key cascading constraints automatically
sqliteDb.run("PRAGMA foreign_keys = ON");

const dbQuery = (query, params = []) => {
  return new Promise((resolve, reject) => {
    sqliteDb.all(query, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
};

const dbGet = (query, params = []) => {
  return new Promise((resolve, reject) => {
    sqliteDb.get(query, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
};

const dbRun = (query, params = []) => {
  return new Promise((resolve, reject) => {
    sqliteDb.run(query, params, function (err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
};

function getWorkspacePaths(workspaceId, sessionId) {
  const wsDir = path.resolve(path.join(__dirname, 'workspaces', workspaceId));
  const srcDir = path.join(wsDir, 'src');
  const sessionsDir = path.join(wsDir, 'sessions');
  const sessionFolder = sessionId ? path.join(sessionsDir, sessionId) : null;
  const sessionMirrorRoot = sessionFolder ? path.join(sessionFolder, 'workspace_mirror') : null;
  const sessionUploadsDir = sessionFolder ? path.join(sessionFolder, 'uploads') : null;
  const sessionArtifactDir = sessionFolder ? path.join(sessionFolder, 'artifact') : null;
  const sessionScratchpadDir = sessionFolder ? path.join(sessionFolder, 'scratchpad') : null;
  return {
    wsDir,
    srcDir,
    sessionsDir,
    sessionFolder,
    sessionMirrorRoot,
    sessionUploadsDir,
    sessionArtifactDir,
    sessionScratchpadDir
  };
}

async function getGitReposForWorkspace(workspaceId) {
  const ws = await dbGet("SELECT folders_path FROM workspaces WHERE id = ?", [workspaceId]);
  if (!ws) return [];
  let folders = [];
  try {
    folders = JSON.parse(ws.folders_path);
  } catch (e) {
    return [];
  }
  const { wsDir } = getWorkspacePaths(workspaceId);
  return folders.map(folder => {
    const realPath = path.resolve(folder);
    const hashedName = crypto.createHash('md5').update(realPath).digest('hex');
    const gitDir = path.join(wsDir, 'git_repos', hashedName);
    return {
      realPath,
      gitDir: path.join(gitDir, '.git'),
      hashedName,
      folderName: path.basename(realPath)
    };
  });
}

async function execGit(repo, gitCommand, options = {}) {
  const cmd = `git --git-dir="${repo.gitDir}" --work-tree="${repo.realPath}" ${gitCommand}`;
  return execPromise(cmd, { cwd: repo.realPath, ...options });
}

function execGitWithStdin(repo, gitCommand, stdinContent) {
  return new Promise((resolve, reject) => {
    const cmd = `git --git-dir="${repo.gitDir}" --work-tree="${repo.realPath}" ${gitCommand}`;
    const child = exec(cmd, { cwd: repo.realPath, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(error);
      } else {
        resolve({ stdout, stderr });
      }
    });
    if (stdinContent) {
      child.stdin.write(stdinContent);
      child.stdin.end();
    }
  });
}

// Session JSONL and Git helpers
async function loadSessionMessages(wsDir, sessionId) {
  const messagesFile = path.join(wsDir, 'sessions', sessionId, 'messages.jsonl');
  try {
    const content = await fs.readFile(messagesFile, 'utf-8');
    return content.split('\n').filter(Boolean).map(line => JSON.parse(line));
  } catch {
    return [];
  }
}

async function saveSessionMessages(wsDir, sessionId, messages) {
  const sessionDir = path.join(wsDir, 'sessions', sessionId);
  await fs.mkdir(sessionDir, { recursive: true });
  const messagesFile = path.join(sessionDir, 'messages.jsonl');
  const content = messages.map(msg => JSON.stringify(msg)).join('\n') + '\n';
  await fs.writeFile(messagesFile, content, 'utf-8');
}

async function initSessionGit(wsDir, sessionId) {
  const sessionDir = path.join(wsDir, 'sessions', sessionId);
  await fs.mkdir(sessionDir, { recursive: true });
  const gitDir = path.join(sessionDir, '.git');
  let gitExists = false;
  try {
    await fs.access(gitDir);
    gitExists = true;
  } catch {
    try {
      await execPromise('git init', { cwd: sessionDir });
      gitExists = true;
    } catch (e) {
      console.error(`Failed to init git in session ${sessionId}:`, e.message);
    }
  }

  if (gitExists) {
    try {
      await execPromise('git config user.name "nxCoder"', { cwd: sessionDir });
      await execPromise('git config user.email "nxcoder@localhost"', { cwd: sessionDir });
    } catch {}
  }
}

async function commitSessionMessage(wsDir, sessionId, messageId, role) {
  const sessionDir = path.join(wsDir, 'sessions', sessionId);
  const commitMsg = `msg_${role === 'user' ? 'user_' : ''}${messageId}`;
  try {
    await execPromise('git add messages.jsonl', { cwd: sessionDir });
    await execPromise(`git commit -m "${commitMsg}" --no-gpg-sign`, { cwd: sessionDir });
  } catch (e) {
    // Commit fails if no changes, which is fine
  }
}

async function getSessionActiveBranch(wsDir, sessionId) {
  const sessionDir = path.join(wsDir, 'sessions', sessionId);
  try {
    const { stdout } = await execPromise('git branch --show-current', { cwd: sessionDir });
    return stdout.trim() || 'master';
  } catch {
    return 'master';
  }
}

async function createWorkspaceMirror(workspaceId, sessionId) {
  const { wsDir } = getWorkspacePaths(workspaceId);
  const repos = await getGitReposForWorkspace(workspaceId);
  const mirrorBase = path.join(wsDir, 'sessions', sessionId, 'workspace_mirror');
  await fs.mkdir(mirrorBase, { recursive: true });

  const activeBranch = await getSessionActiveBranch(wsDir, sessionId);

  for (const repo of repos) {
    const mirrorFolder = path.join(mirrorBase, repo.folderName);
    await fs.mkdir(mirrorFolder, { recursive: true });

    // 1. Ensure mirror repo is set to the correct branch using mirrorFolder as work-tree
    const sessBranch = `sess_${sessionId}_${activeBranch}`;
    try {
      const { stdout: exists } = await execGit(repo, `show-ref --verify refs/heads/${sessBranch}`).catch(() => ({ stdout: '' }));
      if (exists.trim()) {
        await execPromise(`git --git-dir="${repo.gitDir}" --work-tree="${mirrorFolder}" checkout ${sessBranch}`);
      } else {
        await execPromise(`git --git-dir="${repo.gitDir}" --work-tree="${mirrorFolder}" checkout -B ${sessBranch}`);
      }
    } catch (e) {
      console.error(`Failed to checkout session branch ${sessBranch} in mirror ${mirrorFolder}:`, e.message);
    }

    // 2. Populate mirror with all tracked & untracked files from user realPath
    let files = [];
    try {
      const { stdout: lsOut } = await execGit(repo, 'ls-files');
      files.push(...lsOut.trim().split('\n').map(f => f.trim()).filter(Boolean));

      const { stdout: statusOut } = await execGit(repo, 'status --porcelain');
      const lines = statusOut.trim().split('\n').filter(Boolean);
      for (const line of lines) {
        if (line.startsWith('?? ')) {
          files.push(line.substring(3).trim());
        }
      }
    } catch (e) {
      console.error(`Failed to list files for mirror copy in ${repo.folderName}:`, e.message);
    }

    const uniqueFiles = Array.from(new Set(files));
    for (const file of uniqueFiles) {
      const srcPath = path.join(repo.realPath, file);
      const destPath = path.join(mirrorFolder, file);
      try {
        await fs.mkdir(path.dirname(destPath), { recursive: true });
        await fs.copyFile(srcPath, destPath);
      } catch (e) {}
    }

    // 3. Remove files in mirrorFolder that have been deleted in realPath
    try {
      const { stdout: lsMirror } = await execPromise(`git --git-dir="${repo.gitDir}" --work-tree="${mirrorFolder}" ls-files`);
      const mirrorFiles = lsMirror.trim().split('\n').map(f => f.trim()).filter(Boolean);
      for (const f of mirrorFiles) {
        const realF = path.join(repo.realPath, f);
        try {
          await fs.access(realF);
        } catch {
          await fs.rm(path.join(mirrorFolder, f), { force: true });
        }
      }
    } catch {}
  }
}

async function mergeMirrorChangesBack(workspaceId, sessionId, modelMessageId) {
  const repos = await getGitReposForWorkspace(workspaceId);
  const { wsDir } = getWorkspacePaths(workspaceId);
  const activeBranch = await getSessionActiveBranch(wsDir, sessionId);
  const sessBranch = `sess_${sessionId}_${activeBranch}`;
  
  for (const repo of repos) {
    const mirrorFolder = path.join(wsDir, 'sessions', sessionId, 'workspace_mirror', repo.folderName);
    
    let realActiveBranch = 'master';
    try {
      const { stdout: curBranch } = await execPromise(`git --git-dir="${repo.gitDir}" --work-tree="${repo.realPath}" branch --show-current`);
      realActiveBranch = curBranch.trim() || 'master';
    } catch {}

    let changesMap = new Map();
    try {
      const { stdout } = await execPromise(`git --git-dir="${repo.gitDir}" --work-tree="${mirrorFolder}" status --porcelain -u`);
      const lines = stdout.split('\n').filter(Boolean);
      for (const line of lines) {
        const status = line.substring(0, 2);
        const filePath = line.substring(3).trim();
        changesMap.set(filePath, status);
      }
    } catch (e) {
      console.error(`Failed to get status in mirror repo ${repo.folderName}:`, e.message);
    }

    try {
      const { stdout } = await execPromise(`git --git-dir="${repo.gitDir}" diff --name-status ${activeBranch}..${sessBranch}`);
      const lines = stdout.split('\n').filter(Boolean);
      for (const line of lines) {
        const parts = line.split('\t');
        if (parts.length === 3 && parts[0].trim().startsWith('R')) {
          const oldPath = parts[1].trim();
          const newPath = parts[2].trim();
          changesMap.set(oldPath, 'D');
          changesMap.set(newPath, 'A');
        } else if (parts.length >= 2) {
          const status = parts[0].trim();
          const filePath = parts[1].trim();
          if (!changesMap.has(filePath)) {
            changesMap.set(filePath, status);
          }
        }
      }
    } catch (e) {
      console.error(`Failed to get diff in mirror repo ${repo.folderName}:`, e.message);
    }

    const changes = Array.from(changesMap.entries()).map(([filePath, status]) => ({ status, filePath }));

    if (changes.length > 0) {
      // 1. Copy the edits from mirrorFolder back to the real project folder
      for (const change of changes) {
        const srcPath = path.join(mirrorFolder, change.filePath);
        const destPath = path.join(repo.realPath, change.filePath);

        if (change.status.includes('D')) {
          try {
            await fs.rm(destPath, { recursive: true, force: true });
          } catch {}
        } else {
          try {
            const stat = await fs.stat(srcPath);
            if (stat.isDirectory()) {
              await fs.mkdir(destPath, { recursive: true });
            } else {
              await fs.mkdir(path.dirname(destPath), { recursive: true });
              await fs.copyFile(srcPath, destPath);
            }
          } catch (e) {
            console.error(`Failed to sync path ${change.filePath} back to real folder:`, e.message);
          }
        }
      }

      // 2. Stage, commit, and checkout branch on the real folder
      try {
        await execPromise(`git --git-dir="${repo.gitDir}" --work-tree="${repo.realPath}" checkout -B ${sessBranch}`);
        await execPromise(`git --git-dir="${repo.gitDir}" --work-tree="${repo.realPath}" add -A`);
        const commitMsg = `msg_${modelMessageId}`;
        await execPromise(`git --git-dir="${repo.gitDir}" --work-tree="${repo.realPath}" commit -m "${commitMsg}" --no-gpg-sign --allow-empty`);

        // Switch real folder back to original active branch and merge session changes
        await execPromise(`git --git-dir="${repo.gitDir}" --work-tree="${repo.realPath}" checkout ${realActiveBranch}`);
        await execPromise(`git --git-dir="${repo.gitDir}" --work-tree="${repo.realPath}" merge ${sessBranch} --no-gpg-sign`);

        // Always keep master pointing to the latest committed state
        if (realActiveBranch !== 'master') {
          try {
            // Ensure master branch exists
            const { stdout: masterExists } = await execPromise(`git --git-dir="${repo.gitDir}" branch --list master`).catch(() => ({ stdout: '' }));
            if (!masterExists.trim()) {
              await execPromise(`git --git-dir="${repo.gitDir}" --work-tree="${repo.realPath}" checkout -B master`);
              await execPromise(`git --git-dir="${repo.gitDir}" --work-tree="${repo.realPath}" checkout ${realActiveBranch}`);
            } else {
              // Fast-forward master to the current tip of realActiveBranch
              await execPromise(`git --git-dir="${repo.gitDir}" branch -f master ${realActiveBranch}`);
            }
          } catch (e) {
            console.warn(`Could not fast-forward master in ${repo.folderName}: ${e.message}`);
          }
        }
      } catch (e) {
        throw new Error(`Merge conflict in repository ${repo.folderName}: ${e.message}. Please resolve in files.`);
      }
    }
  }
}

async function getPathHistorySize(repo, itemPath) {
  try {
    const pathspec = itemPath ? ` -- "${itemPath}"` : '';
    const { stdout } = await execGit(repo, `rev-list --objects --all${pathspec}`);
    const lines = stdout.trim().split('\n');
    const hashes = new Set();
    const isDir = itemPath ? (itemPath.endsWith('/') ? itemPath : itemPath + '/') : '';
    
    for (const line of lines) {
      if (!line) continue;
      const parts = line.split(/\s+/);
      const hash = parts[0];
      const filePath = parts.slice(1).join(' ');
      
      if (!filePath) continue; // Skip tree/commit lines that don't map to a path
      
      if (itemPath === "" || filePath === itemPath || filePath.startsWith(isDir)) {
        hashes.add(hash);
      }
    }
    
    if (hashes.size === 0) return 0;
    
    const { stdout: sizeOut } = await execGitWithStdin(repo, 'cat-file --batch-check="%(objectsize)"', Array.from(hashes).join('\n'));
    let totalSize = 0;
    const sizeLines = sizeOut.trim().split('\n');
    for (const line of sizeLines) {
      const sizeVal = parseInt(line.trim(), 10);
      if (!isNaN(sizeVal)) {
        totalSize += sizeVal;
      }
    }
    return totalSize;
  } catch (e) {
    console.error(`Failed to get history size for ${itemPath}:`, e.message);
    return 0;
  }
}

async function purgePathFromGitHistory(repo, itemPath) {
  const escapedPath = itemPath.replace(/(["'$`\\])/g, '\\$1');
  const filterCmd = `filter-branch --force --index-filter "git rm -r --cached --ignore-unmatch '${escapedPath}'" --prune-empty --tag-name-filter cat -- --all`;
  await execGit(repo, filterCmd);
  
  try {
    const { stdout } = await execGit(repo, 'for-each-ref --format="%(refname)" refs/original/');
    const refs = stdout.trim().split('\n').filter(Boolean);
    for (const ref of refs) {
      await execGit(repo, `update-ref -d "${ref}"`);
    }
    await execGit(repo, 'reflog expire --expire=now --all');
    await execGit(repo, 'gc --prune=now');
  } catch (e) {
    console.error(`Failed to clean up original backup refs: ${e.message}`);
  }
}

async function syncWorkspaceOnDisk(workspaceId, foldersPath) {
  const { wsDir, srcDir, sessionsDir } = getWorkspacePaths(workspaceId);

  // 1. Create workspace root, src and sessions dirs
  await fs.mkdir(wsDir, { recursive: true });
  await fs.mkdir(srcDir, { recursive: true });
  await fs.mkdir(sessionsDir, { recursive: true });

  // 2. Initialize private git repositories for each folder
  const repos = await getGitReposForWorkspace(workspaceId);
  for (const repo of repos) {
    const gitDir = repo.gitDir;
    const repoDir = path.dirname(gitDir);
    
    await fs.mkdir(repoDir, { recursive: true });
    
    let gitExists = false;
    try {
      await fs.access(gitDir);
      gitExists = true;
    } catch {
      try {
        await execPromise('git init', { cwd: repoDir });
        gitExists = true;
      } catch (e) {
        console.error(`Failed to initialize git in ${repoDir}:`, e.message);
      }
    }

    if (gitExists) {
      // Write private exclude patterns
      const excludePath = path.join(gitDir, 'info', 'exclude');
      try {
        await fs.mkdir(path.dirname(excludePath), { recursive: true });
        await fs.writeFile(excludePath, 'sessions/\n.sessions/\n.git/\n', 'utf-8');
      } catch (e) {
        console.error(`Failed to write exclude file in ${gitDir}:`, e.message);
      }

      // Create initial commit if empty
      let needsInitialCommit = false;
      try {
        await execGit(repo, 'rev-parse HEAD');
      } catch {
        needsInitialCommit = true;
      }

      if (needsInitialCommit) {
        try {
          await execGit(repo, 'config user.name "nxCoder"');
          await execGit(repo, 'config user.email "nxcoder@localhost"');
          await execGit(repo, 'add -A');
          await execGit(repo, 'commit -m "Initial commit" --no-gpg-sign');
          console.log(`Initial commit created for workspace folder ${repo.realPath}`);
        } catch (e) {
          console.error(`Failed to create initial commit for ${repo.realPath}: ${e.message}`);
        }
      }
    }
  }

  // 4. Create hashed symlinks under src/
  // Calculate existing links that need to keep/delete
  const currentHashed = new Map();
  for (const folder of foldersPath) {
    const realPath = path.resolve(folder);
    const hashedName = crypto.createHash('md5').update(realPath).digest('hex');
    currentHashed.set(hashedName, realPath);
  }

  // Remove any links under src/ that aren't in current list
  try {
    const existingEntries = await fs.readdir(srcDir, { withFileTypes: true });
    for (const entry of existingEntries) {
      if (!currentHashed.has(entry.name)) {
        const entryPath = path.join(srcDir, entry.name);
        await fs.rm(entryPath, { recursive: true, force: true });
      }
    }
  } catch (e) {
    console.error(`Failed to read/cleanup src directory ${srcDir}:`, e.message);
  }

  // Create new or verify existing links
  for (const [hashedName, realPath] of currentHashed.entries()) {
    const targetSymlink = path.join(srcDir, hashedName);
    let exists = false;
    try {
      // If it exists, verify it points to the correct place
      const linkTarget = await fs.readlink(targetSymlink);
      if (path.resolve(linkTarget) === realPath) {
        exists = true;
      } else {
        await fs.unlink(targetSymlink);
      }
    } catch {
      // Might not exist, or might be a file/directory
      try {
        await fs.rm(targetSymlink, { recursive: true, force: true });
      } catch {}
    }

    if (!exists) {
      try {
        await fs.symlink(realPath, targetSymlink, 'dir');
      } catch (e) {
        console.error(`Failed to create symlink from ${realPath} to ${targetSymlink}:`, e.message);
      }
    }
  }
}

async function syncAllWorkspaces() {
  try {
    const list = await dbQuery("SELECT id, folders_path FROM workspaces");
    for (const ws of list) {
      const folders = JSON.parse(ws.folders_path);
      await syncWorkspaceOnDisk(ws.id, folders);
    }
    console.log("🔄 All workspaces synchronized successfully.");
  } catch (err) {
    console.error("❌ Failed to sync workspaces on startup:", err);
  }
}

async function getAffectedFilesForCommits(repos, commitHashes) {
  const fileMap = new Map();
  for (const hash of commitHashes) {
    for (const repo of repos) {
      try {
        const { stdout } = await execGit(repo, `diff-tree --no-commit-id --name-status -r ${hash}`);
        const lines = stdout.trim().split('\n');
        for (const line of lines) {
          if (!line) continue;
          const parts = line.split(/\s+/);
          if (parts.length >= 2) {
            const status = parts[0];
            const filePath = parts.slice(1).join(' ');
            if (status && filePath) {
              if (!fileMap.has(filePath)) {
                fileMap.set(filePath, new Set());
              }
              fileMap.get(filePath).add(status);
            }
          }
        }
        break; // Found the commit in this repo, so stop searching other repos
      } catch (e) {
        // Commit might not be in this repo
      }
    }
  }
  
  const affectedFiles = [];
  for (const [filePath, statuses] of fileMap.entries()) {
    let finalStatus = 'modified';
    if (statuses.has('A') && !statuses.has('D')) {
      finalStatus = 'added';
    } else if (statuses.has('D') && !statuses.has('A')) {
      finalStatus = 'deleted';
    }
    affectedFiles.push({ file: filePath, status: finalStatus });
  }
  return affectedFiles;
}

function sendToSession(sessionId, message) {
  const sockets = sessionSockets.get(sessionId);
  if (sockets) {
    sockets.forEach(ws => {
      if (ws.readyState === 1) { // OPEN
        ws.send(JSON.stringify(message));
      }
    });
  }
}

async function initDatabase() {
  await dbRun(`CREATE TABLE IF NOT EXISTS api_keys (
    id TEXT PRIMARY KEY,
    name TEXT,
    key TEXT,
    created_at TEXT
  )`);
  
  await dbRun(`CREATE TABLE IF NOT EXISTS instructions (
    id TEXT PRIMARY KEY,
    name TEXT,
    text TEXT,
    created_at TEXT
  )`);

  await dbRun(`CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY,
    name TEXT,
    folders_path TEXT,
    instruction_id TEXT,
    created_at TEXT,
    FOREIGN KEY (instruction_id) REFERENCES instructions(id) ON DELETE SET NULL
  )`);

  await dbRun(`CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    workspace_id TEXT,
    name TEXT,
    created_at TEXT,
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
  )`);

  await dbRun(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT,
    role TEXT,
    parts TEXT,
    created_at TEXT,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
  )`);


  
  console.log("💾 SQLite database schemas initialized successfully.");
}

initDatabase().then(() => {
  return syncAllWorkspaces();
}).catch(err => {
  console.error("❌ Schema initialization failed:", err);
});

const execPromise = promisify(exec);
const activeTerminals = new Map(); // Global registry tracking terminalId -> process details
const sessionAbortFlags = new Map(); // sessionId -> boolean abort signal
const sessionSockets = new Map(); // sessionId -> Set<WebSocket>
const sessionStatus = new Map(); // sessionId -> 'idle' | 'generating'
const activeGenerations = new Map(); // sessionId -> runId (UUID) to prevent concurrent generations from duplicating history
let keyRotationIndex = 0; // Circular pointer to track key rotation index

async function getNextApiKey(requestedKeyId) {
  if (requestedKeyId) {
    const keyRecord = await dbGet("SELECT key FROM api_keys WHERE id = ?", [requestedKeyId]);
    if (keyRecord) return keyRecord.key;
  }
  const keys = await dbQuery("SELECT key FROM api_keys");
  if (!keys || keys.length === 0) {
    return process.env.GEMINI_API_KEY;
  }
  const selected = keys[keyRotationIndex % keys.length];
  keyRotationIndex++;
  return selected.key;
}

// Resolve a model-visible relative path into a real absolute path on disk.
// All model tool calls use paths RELATIVE to the session sandbox root.
// The session sandbox root is: workspaces/<wsId>/sessions/<sessId>/
// - Project files are under: workspace_mirror/<folderName>/...
// - Uploaded files are under: uploads/
// - Terminal logs are under: terminals/
async function validateAndResolvePath(workspaceId, sessionId, targetPath) {
  const { wsDir, sessionFolder, sessionMirrorRoot, sessionUploadsDir, sessionArtifactDir, sessionScratchpadDir } = getWorkspacePaths(workspaceId, sessionId);

  // Create session storage directories automatically
  await fs.mkdir(sessionFolder, { recursive: true });
  await fs.mkdir(sessionMirrorRoot, { recursive: true });
  await fs.mkdir(sessionUploadsDir, { recursive: true });
  await fs.mkdir(sessionArtifactDir, { recursive: true });
  await fs.mkdir(sessionScratchpadDir, { recursive: true });

  // Reject absolute paths from the model entirely
  if (path.isAbsolute(targetPath)) {
    throw new Error(`Access Denied: Absolute paths are not permitted. Use paths relative to your session workspace root (e.g. "my_project/index.html" or "uploads/file.txt").`);
  }

  // Resolve relative to the session folder
  const resolvedTarget = path.resolve(sessionFolder, targetPath);

  // Ensure the resolved path is strictly within the session folder (prevent path traversal)
  const rel = path.relative(sessionFolder, resolvedTarget);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Access Denied: The path "${targetPath}" resolves outside of the session sandbox.`);
  }

  // During generation, if path is within workspace_mirror, redirect to live mirror
  // (mirror is already inside session folder, so resolvedTarget IS the mirror path)
  return {
    resolvedPath: resolvedTarget,
    sessionFolder
  };
}

function truncateOutput(outputStr, maxLength = 8000) {
  if (!outputStr) return "";
  const str = typeof outputStr === 'string' ? outputStr : JSON.stringify(outputStr);
  if (str.length <= maxLength) return str;
  const half = Math.floor(maxLength / 2);
  return str.slice(0, half) + `\n\n...[OUTPUT TRUNCATED: ${str.length - maxLength} characters omitted to preserve context bounds]...\n\n` + str.slice(str.length - half);
}

async function listDirTool(workspaceId, sessionId, targetPath) {
  try {
    const { resolvedPath } = await validateAndResolvePath(workspaceId, sessionId, targetPath);
    const files = await fs.readdir(resolvedPath, { withFileTypes: true });
    const payload = files.map(f => ({
      name: f.name,
      type: f.isDirectory() ? 'directory' : 'file'
    }));
    return truncateOutput(payload);
  } catch (e) {
    return { error: `Failed to list directory: ${e.message}` };
  }
}

async function readFileTool(workspaceId, sessionId, filePath, fromLine, toLine) {
  try {
    if (!filePath) {
      return { error: 'File path is required.' };
    }
    const { resolvedPath } = await validateAndResolvePath(workspaceId, sessionId, filePath);
    const stat = await fs.stat(resolvedPath);
    if (!stat.isFile()) {
      return { error: 'Target path is not a file.' };
    }

    // First pass: count total lines
    let totalLines = 0;
    const countStream = fsSync.createReadStream(resolvedPath);
    const countRl = readline.createInterface({
      input: countStream,
      crlfDelay: Infinity
    });
    for await (const _ of countRl) {
      totalLines++;
    }

    // Resolve start and end line indices
    let start = fromLine !== undefined ? parseInt(fromLine, 10) : 1;
    const maxLinesCap = 1000;
    let end = toLine !== undefined ? parseInt(toLine, 10) : (fromLine !== undefined ? start + maxLinesCap - 1 : maxLinesCap);

    // Handle negative indices (relative to end of file)
    if (start < 0) start = totalLines + start + 1;
    if (end < 0) end = totalLines + end + 1;

    // Clamp values to valid range [1, totalLines]
    const startLine = Math.max(1, start);
    const endLine = Math.min(totalLines, end);

    if (endLine < startLine) {
      return { error: `Invalid line range requested: from_line (${startLine}) is greater than to_line (${endLine})` };
    }

    // Second pass: read the actual lines in the requested range
    const fileStream = fsSync.createReadStream(resolvedPath);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity
    });

    let currentLineNum = 0;
    const lines = [];
    let hasMoreLines = false;

    for await (const line of rl) {
      currentLineNum++;
      if (currentLineNum >= startLine && currentLineNum <= endLine) {
        lines.push(line);
      }
      if (currentLineNum > endLine) {
        hasMoreLines = true;
        fileStream.destroy();
        break;
      }
    }

    const actualEndLine = Math.min(currentLineNum, endLine);
    const combinedContent = lines.join('\n');

    return {
      content: truncateOutput(combinedContent),
      startLine,
      endLine: actualEndLine,
      totalLines,
      clipped: hasMoreLines || startLine > 1 || (toLine === undefined && currentLineNum > maxLinesCap)
    };
  } catch (e) {
    return { error: `Failed to read file safely: ${e.message}` };
  }
}

async function writeFileTool(workspaceId, sessionId, filePath, content) {
  try {
    const { resolvedPath } = await validateAndResolvePath(workspaceId, sessionId, filePath);
    await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
    await fs.writeFile(resolvedPath, content, 'utf-8');
    return { success: true, message: `File written successfully.` };
  } catch (e) {
    return { error: `Failed to write file: ${e.message}` };
  }
}

async function regexSearchTool(workspaceId, sessionId, regexStr, paths, options = {}) {
  try {
    const { searchFileName = false, searchFileContent = false, ignore = [] } = options;
    const regex = new RegExp(regexStr);
    const results = [];

    const { sessionFolder } = getWorkspacePaths(workspaceId, sessionId);
    const ignorePatterns = ignore;

    const ignoreRegexes = ignorePatterns.map(p => {
      const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '.*').replace(/\\\?/g, '.');
      return new RegExp(escaped.endsWith('/') ? `${escaped}.*` : `${escaped}$`);
    });

    function isIgnored(filePath) {
      const relPath = path.relative(sessionFolder, filePath);
      return ignoreRegexes.some(re => re.test(relPath));
    }

    async function searchInFile(filePath) {
      if (isIgnored(filePath)) return;

      if (searchFileName && regex.test(path.basename(filePath))) {
        results.push({ path: path.relative(sessionFolder, filePath), matchType: 'fileName' });
      }
      
      if (searchFileContent) {
        try {
          const fileStream = fsSync.createReadStream(filePath);
          const rl = readline.createInterface({
            input: fileStream,
            crlfDelay: Infinity
          });

          let lineNumber = 0;
          for await (const line of rl) {
            lineNumber++;
            if (regex.test(line)) {
              results.push({ path: path.relative(sessionFolder, filePath), line: lineNumber, matchType: 'content', text: line.trim() });
            }
          }
        } catch (err) {
          // Handle files that can't be read
        }
      }
    }

    async function walk(dir) {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (isIgnored(fullPath)) continue;

        if (entry.isDirectory()) {
          await walk(fullPath);
        } else if (entry.isFile()) {
          await searchInFile(fullPath);
        }
      }
    }

    for (const targetPath of paths) {
      const { resolvedPath } = await validateAndResolvePath(workspaceId, sessionId, targetPath);
      const stats = await fs.stat(resolvedPath);
      if (stats.isDirectory()) {
        await walk(resolvedPath);
      } else if (stats.isFile()) {
        await searchInFile(resolvedPath);
      }
    }

    return truncateOutput(results);
  } catch (e) {
    return { error: `Regex search failed: ${e.message}` };
  }
}


// Patch a file using a search block -> replace block strategy.
// `occurrence` (1-based) selects which match to replace when multiple exist (default: 1).
async function editFileTool(workspaceId, sessionId, filePath, search, replace, occurrence = 1) {
  try {
    const { resolvedPath } = await validateAndResolvePath(workspaceId, sessionId, filePath);
    let original;
    try {
      original = await fs.readFile(resolvedPath, 'utf-8');
    } catch (e) {
      return { error: `Cannot read file to patch: ${e.message}` };
    }

    // Count occurrences
    let searchFrom = 0;
    let matchCount = 0;
    let matchIndex = -1;
    while (true) {
      const idx = original.indexOf(search, searchFrom);
      if (idx === -1) break;
      matchCount++;
      if (matchCount === occurrence) matchIndex = idx;
      searchFrom = idx + search.length;
    }

    if (matchCount === 0) {
      // Give the model a helpful snippet of the file so it can self-correct
      const preview = original.slice(0, 400).replace(/\n/g, '\\n');
      return {
        error: `Search block not found in file. The file starts with: ...${preview}...`,
        tip: 'Ensure your search block exactly matches the file content including whitespace and indentation.'
      };
    }
    if (matchIndex === -1) {
      return {
        error: `Only ${matchCount} occurrence(s) found but occurrence=${occurrence} was requested.`
      };
    }

    const patched = original.slice(0, matchIndex) + replace + original.slice(matchIndex + search.length);
    await fs.writeFile(resolvedPath, patched, 'utf-8');

    // Extract context snippet (10 lines above and 10 lines below the patched area)
    const patchedLines = patched.split('\n');
    const startLineIdx = original.slice(0, matchIndex).split('\n').length - 1;
    const endLineIdx = startLineIdx + replace.split('\n').length - 1;
    const rangeStart = Math.max(0, startLineIdx - 10);
    const rangeEnd = Math.min(patchedLines.length, endLineIdx + 11);
    const snippet = patchedLines.slice(rangeStart, rangeEnd).join('\n');

    return {
      success: true,
      message: `Patch applied (occurrence ${occurrence}/${matchCount}). Replaced ${search.length} chars with ${replace.length} chars.`,
      snippet: snippet
    };
  } catch (e) {
    return { error: `Patch failed: ${e.message}` };
  }
}

async function executeCommandTool(workspaceId, sessionId, command, targetPath, name) {
  try {
    const { resolvedPath, sessionFolder } = await validateAndResolvePath(workspaceId, sessionId, targetPath || '.');
    await fs.mkdir(resolvedPath, { recursive: true });

    const { wsDir } = getWorkspacePaths(workspaceId, sessionId);

    const terminalId = 'term_' + crypto.randomUUID().substring(0, 8);
    const terminalsDir = path.join(sessionFolder, 'terminals');
    await fs.mkdir(terminalsDir, { recursive: true });
    const logFilePath = path.join(terminalsDir, `${terminalId}.log`);
    // Relative path shown to the model
    const logFileRelPath = `terminals/${terminalId}.log`;

    const logStream = fsSync.createWriteStream(logFilePath, { flags: 'a' });
    logStream.on('error', (err) => {
      console.error(`logStream error for terminal ${terminalId}:`, err);
    });
    
    // Auto-override GIT_DIR and GIT_WORK_TREE if executing inside the sandboxed mirror
    const repos = await getGitReposForWorkspace(workspaceId);
    const repo = repos.find(r => resolvedPath.startsWith(path.join(wsDir, 'sessions', sessionId, 'workspace_mirror', r.folderName)));
    const childEnv = { ...process.env, FORCE_COLOR: '1', HOME: sessionFolder };
    if (repo) {
      const mirrorFolder = path.join(wsDir, 'sessions', sessionId, 'workspace_mirror', repo.folderName);
      childEnv.GIT_DIR = repo.gitDir;
      childEnv.GIT_WORK_TREE = mirrorFolder;
    }

    const childProc = spawn(command, {
      shell: true,
      cwd: resolvedPath,
      detached: true,
      stdio: 'pipe',
      env: childEnv
    });

    childProc.unref();

    childProc.stdout.pipe(logStream, { end: false });
    childProc.stderr.pipe(logStream, { end: false });

    const terminalDescriptor = {
      id: terminalId,
      name: name || undefined,
      process: childProc,
      command,
      logFilePath,
      logFileRelPath,
      status: 'running',
      started_at: new Date().toISOString(),
      sessionId,
      workspaceId
    };

    activeTerminals.set(terminalId, terminalDescriptor);

    childProc.on('exit', (code, signal) => {
      terminalDescriptor.status = code === 0 ? 'completed' : (signal ? 'killed' : 'failed');
      terminalDescriptor.exitCode = code;
      terminalDescriptor.signal = signal;
    });

    childProc.on('close', (code, signal) => {
      if (!logStream.writableEnded) {
        logStream.end();
      }
    });

    childProc.on('error', (err) => {
      terminalDescriptor.status = 'error';
      terminalDescriptor.error = err.message;
      if (!logStream.writableEnded) {
        logStream.write(`\nProcess Runtime Error: ${err.message}\n`, () => {
          if (!logStream.writableEnded) {
            logStream.end();
          }
        });
      }
    });

    // Wait up to 5 seconds for the process to complete.
    // If it finishes quickly, we return the output directly.
    // If it takes longer, we return the terminal_id and log_file for background tracking.
    const finishPromise = new Promise((resolve) => {
      childProc.once('close', (code, signal) => resolve({ type: 'exit', code, signal }));
      childProc.once('error', (err) => resolve({ type: 'error', err }));
    });

    const timeoutPromise = new Promise((resolve) => {
      setTimeout(() => resolve({ type: 'timeout' }), 5000);
    });

    const raceResult = await Promise.race([finishPromise, timeoutPromise]);

    if (raceResult.type === 'timeout') {
      return {
        success: true,
        terminal_id: terminalId,
        log_file: logFileRelPath,
        message: `The terminal run is taking longer than 5 seconds and is continuing in the background. To check output, use read_file with path "${logFileRelPath}".`
      };
    } else {
      try {
        // Give a tiny window for any final buffered output to hit the disk
        await new Promise(r => setTimeout(r, 100)); 
        const output = await fs.readFile(logFilePath, 'utf8');
        return {
          success: raceResult.type === 'exit' && raceResult.code === 0,
          output: output,
          exitCode: raceResult.code,
          message: `Command completed within 5 seconds.`
        };
      } catch (readErr) {
        return { 
          error: `Process finished quickly but failed to read output: ${readErr.message}`,
          terminal_id: terminalId,
          log_file: logFileRelPath 
        };
      }
    }
  } catch (e) {
    return { error: `Could not launch terminal run: ${e.message}` };
  }
}

function parseInputString(str) {
  return str
    .replace(/\\x([0-9a-fA-F]{2})/g, (match, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\u([0-9a-fA-F]{4})/g, (match, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\b/g, '\b')
    .replace(/\\f/g, '\f')
    .replace(/\\v/g, '\v')
    .replace(/\\e/g, '\x1b');
}

async function sendTerminalInputTool(terminalId, input) {
  try {
    const term = activeTerminals.get(terminalId);
    if (!term) {
      return { error: `Terminal "${terminalId}" is not active or has been cleaned up.` };
    }
    if (term.status !== 'running') {
      return { error: `Terminal "${terminalId}" is not running (status: ${term.status}).` };
    }

    const childProc = term.process;
    if (!childProc || !childProc.stdin || !childProc.stdin.writable) {
      return { error: `Terminal "${terminalId}" stdin is not writable.` };
    }

    const decoded = parseInputString(input);
    childProc.stdin.write(decoded);

    return { 
      success: true, 
      message: `Successfully wrote inputs to terminal stdin.` 
    };
  } catch (err) {
    return { error: `Failed to write inputs to terminal: ${err.message}` };
  }
}

async function waitTool(seconds) {
  const waitMs = Math.min(60, Math.max(1, parseInt(seconds, 10))) * 1000;
  await new Promise(resolve => setTimeout(resolve, waitMs));
  return { message: `Completed wait of ${waitMs / 1000} seconds.` };
}

async function waitTerminalTool(terminalId, timeoutSeconds) {
  try {
    const term = activeTerminals.get(terminalId);
    if (!term) {
      return { error: `Active terminal instance with ID "${terminalId}" not found.` };
    }

    const waitLimit = Math.min(60, timeoutSeconds || 120) * 1000;
    const interval = 500;
    let elapsed = 0;

    while (term.status === 'running' && elapsed < waitLimit) {
      await new Promise(resolve => setTimeout(resolve, interval));
      elapsed += interval;
    }

    let latestLogs = "";
    try {
      latestLogs = await fs.readFile(term.logFilePath, 'utf-8');
    } catch (err) {
      latestLogs = `(Unable to load logs: ${err.message})`;
    }

    return {
      terminal_id: terminalId,
      status: term.status,
      completed: term.status !== 'running',
      logs: truncateOutput(latestLogs, 4000)
    };
  } catch (e) {
    return { error: `Terminal checking crashed: ${e.message}` };
  }
}

async function terminateTerminalTool(terminalId) {
  const term = activeTerminals.get(terminalId);
  if (!term) {
    return { error: `Terminal "${terminalId}" is not active or has been cleaned up.` };
  }

  try {
    if (term.status === 'running') {
      process.kill(-term.process.pid, 'SIGINT'); 
    }
  } catch (err) {
    try {
      term.process.kill();
    } catch (e) {}
  }

  term.status = 'killed';
  return { success: true, message: `Terminal "${terminalId}" has been terminated successfully.` };
}

async function setSessionNameTool(sessionId, name) {
  try {
    await dbRun("UPDATE sessions SET name = ? WHERE id = ?", [name, sessionId]);
    return { success: true, name, message: `Session renamed successfully to "${name}".` };
  } catch (e) {
    return { error: `Failed to set session name: ${e.message}` };
  }
}

async function parseDocumentTool(workspaceId, sessionId, filepath, outputName) {
  try {
    const { resolvedPath, sessionFolder } = await validateAndResolvePath(workspaceId, sessionId, filepath);
    
    // Check if file exists
    try {
      await fs.access(resolvedPath);
    } catch (e) {
      return { error: `File not found: "${filepath}"` };
    }

    const parsedPath = path.parse(resolvedPath);
    const baseNameWithoutExt = parsedPath.name;
    const cleanFolderName = (outputName || baseNameWithoutExt).replace(/[^a-zA-Z0-9.-]/g, "_");
    
    const outputDir = path.join(sessionFolder, cleanFolderName);
    await fs.mkdir(outputDir, { recursive: true });

    const ext = parsedPath.ext.toLowerCase();

    // 1. Image Extraction
    if (ext === '.pdf') {
      try {
        const imgPrefix = path.join(outputDir, 'img');
        await execPromise(`pdfimages -png "${resolvedPath}" "${imgPrefix}"`);
      } catch (err) {
        console.log(`pdfimages completed or skipped: ${err.message}`);
      }
    } else if (ext === '.docx' || ext === '.pptx' || ext === '.xlsx') {
      try {
        const mediaPatternMap = {
          '.docx': 'word/media/*',
          '.pptx': 'ppt/media/*',
          '.xlsx': 'xl/media/*'
        };
        const pattern = mediaPatternMap[ext];
        await execPromise(`unzip -j -q "${resolvedPath}" "${pattern}" -d "${outputDir}"`);
      } catch (err) {
        console.log(`unzip completed or skipped: ${err.message}`);
      }
    }

    // 2. Rename extracted images sequentially to image_1.ext, image_2.ext, etc.
    const filesInOutputDir = await fs.readdir(outputDir);
    let imageFiles = [];
    const imageExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.tiff', '.bmp'];
    
    for (const file of filesInOutputDir) {
      const fileExt = path.extname(file).toLowerCase();
      if (imageExtensions.includes(fileExt)) {
        imageFiles.push(file);
      }
    }
    
    // Sort image files logically
    imageFiles.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));

    const renamedImages = [];
    const tempRenamed = [];
    // Phase 1: Rename to temp names to avoid collisions
    for (let i = 0; i < imageFiles.length; i++) {
      const origFile = imageFiles[i];
      const fileExt = path.extname(origFile).toLowerCase();
      const tempName = `_temp_rename_${i}_${Date.now()}${fileExt}`;
      const srcPath = path.join(outputDir, origFile);
      const tempPath = path.join(outputDir, tempName);
      await fs.rename(srcPath, tempPath);
      tempRenamed.push({ tempPath, fileExt });
    }
    // Phase 2: Rename to final sequential names
    for (let i = 0; i < tempRenamed.length; i++) {
      const { tempPath, fileExt } = tempRenamed[i];
      const newName = `image_${i + 1}${fileExt}`;
      const destPath = path.join(outputDir, newName);
      await fs.rename(tempPath, destPath);
      renamedImages.push(newName);
    }

    // 3. Document to Markdown conversion using Gemini 2.5 Flash
    const apiKey = await getNextApiKey();
    if (!apiKey) {
      return { error: 'No Gemini API Key available in rotation database.' };
    }
    const ai = new GoogleGenAI({ apiKey });

    // Determine standard MIME type
    let mimeType = 'application/octet-stream';
    if (ext === '.pdf') mimeType = 'application/pdf';
    else if (ext === '.docx') mimeType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    else if (ext === '.xlsx') mimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    else if (ext === '.pptx') mimeType = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
    else if (ext === '.doc') mimeType = 'application/msword';
    else if (ext === '.xls') mimeType = 'application/vnd.ms-excel';
    else if (ext === '.ppt') mimeType = 'application/vnd.ms-powerpoint';
    else if (ext === '.txt') mimeType = 'text/plain';
    else if (ext === '.html' || ext === '.htm') mimeType = 'text/html';
    else if (ext === '.csv') mimeType = 'text/csv';
    else if (ext === '.md') mimeType = 'text/markdown';
    else {
      mimeType = mime.getType(resolvedPath) || 'application/octet-stream';
    }

    const base64Data = await fs.readFile(resolvedPath, 'base64');
    
    let imageInfoText = '';
    if (renamedImages.length > 0) {
      imageInfoText = `We extracted the following ${renamedImages.length} images from the document: ${renamedImages.join(', ')}. `;
    }

    const prompt = `Convert the entire contents of this document into clean, well-formatted Markdown.
Retain all text, headers, bullet/numbered lists, inline bold/italic styles.
If there are tables, represent them as markdown tables.
${imageInfoText}When you detect a place in the document where an image, figure, chart, or diagram was located, please insert a relative markdown image link referencing it. Match the sequence of images sequentially to: ${renamedImages.map((img, i) => `image_${i + 1} (${img})`).join(', ')}. If you encounter an image, insert: ![Image](image_N.ext) where N is the image number (1-based index) and ext is the original extension (e.g. .png, .jpg, .jpeg, etc.).
Do not summarize the document. Convert the content fully and accurately.
Do not include any introductory text, concluding text, explanations, or wrapping markdown code blocks (such as \`\`\`markdown ... \`\`\`). Output ONLY the raw Markdown text.`;

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [
        {
          role: 'user',
          parts: [
            {
              inlineData: {
                data: base64Data,
                mimeType: mimeType
              }
            },
            {
              text: prompt
            }
          ]
        }
      ]
    });

    const markdownText = response.text || '';
    const outputMdPath = path.join(outputDir, `${cleanFolderName}.md`);
    await fs.writeFile(outputMdPath, markdownText, 'utf-8');

    const relativeMdPath = path.relative(sessionFolder, outputMdPath);
    const relativeOutputDir = path.relative(sessionFolder, outputDir);
    return {
      success: true,
      message: `Parsed document successfully.`,
      outputDirectory: relativeOutputDir,
      markdownFile: relativeMdPath,
      extractedImages: renamedImages,
      filesCreated: [
        relativeMdPath,
        ...renamedImages.map(img => path.join(relativeOutputDir, img))
      ]
    };

  } catch (err) {
    console.error("parseDocumentTool failed:", err);
    return { error: `Failed to parse document: ${err.message}` };
  }
}

async function viewImageTool(workspaceId, sessionId, filepath) {
  try {
    const { resolvedPath } = await validateAndResolvePath(workspaceId, sessionId, filepath);
    
    // Check file access
    try {
      await fs.access(resolvedPath);
    } catch {
      return { error: `Image file not found at: "${filepath}"` };
    }

    const ext = path.extname(resolvedPath).toLowerCase();
    const imageExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.tiff', '.bmp', '.svg'];
    if (!imageExtensions.includes(ext)) {
      return { error: `File at "${filepath}" does not appear to be an image. Supported formats: ${imageExtensions.join(', ')}` };
    }

    const mimeType = mime.getType(resolvedPath) || 'image/png';
    const base64Data = await fs.readFile(resolvedPath, 'base64');

    return {
      success: true,
      message: `Image at "${filepath}" has been successfully injected into your context as an inline multimodal asset.`,
      inlineImage: {
        data: base64Data,
        mimeType: mimeType
      }
    };
  } catch (err) {
    console.error("viewImageTool failed:", err);
    return { error: `Failed to view image: ${err.message}` };
  }
}

const app = express();
app.use(express.json());
app.use(express.static(__dirname));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const upload = multer({
  limits: { fileSize: 500 * 1024 * 1024 } // Support uploading payload sizes up to 500MB
});

app.get('/api/folder', async (req, res) => {
  try {
    let targetPath = req.query.path;
    if (!targetPath || targetPath === 'undefined' || targetPath === 'null') {
      targetPath = os.homedir();
    }
    targetPath = path.resolve(targetPath);

    const dirContents = await fs.readdir(targetPath, { withFileTypes: true });
    const formatted = dirContents.map(dirent => ({
      name: dirent.name,
      type: dirent.isDirectory() ? 'folder' : 'file',
      full_path: path.join(targetPath, dirent.name)
    }));

    res.json({
      currentPath: targetPath,
      parentPath: path.dirname(targetPath),
      items: formatted
    });
  } catch (error) {
    res.status(500).json({ error: `Could not browse directory path: ${error.message}` });
  }
});

app.get('/api/key', async (req, res) => {
  try {
    const keys = await dbQuery("SELECT id, name, created_at FROM api_keys");
    res.json(keys);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/key', async (req, res) => {
  try {
    const { key, name } = req.body;
    if (!key || !name) {
      return res.status(400).json({ error: 'Missing parameter "key" or "name"' });
    }
    const id = 'key_' + crypto.randomUUID().substring(0, 8);
    await dbRun(
      "INSERT INTO api_keys (id, name, key, created_at) VALUES (?, ?, ?, ?)",
      [id, name, key, new Date().toISOString()]
    );
    res.status(201).json({ message: 'added', id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/key/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { key, name } = req.body;
    if (!key || !name) {
      return res.status(400).json({ error: 'Missing parameter "key" or "name"' });
    }
    const result = await dbRun(
      "UPDATE api_keys SET name = ?, key = ? WHERE id = ?",
      [name, key, id]
    );
    if (result.changes === 0) {
      return res.status(404).json({ error: 'API key not found' });
    }
    res.json({ message: 'updated' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/key/:id', async (req, res) => {
  try {
    await dbRun("DELETE FROM api_keys WHERE id = ?", [req.params.id]);
    res.json({ message: 'deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/instruction', async (req, res) => {
  try {
    const instructions = await dbQuery("SELECT * FROM instructions");
    res.json(instructions);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/instruction', async (req, res) => {
  try {
    const { name, text } = req.body;
    if (!name || !text) {
      return res.status(400).json({ error: 'Missing required system parameters "name" or "text"' });
    }
    const id = 'inst_' + crypto.randomUUID().substring(0, 8);
    await dbRun(
      "INSERT INTO instructions (id, name, text, created_at) VALUES (?, ?, ?, ?)",
      [id, name, text, new Date().toISOString()]
    );
    res.status(201).json({ message: 'Instruction added successfully', id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/instruction/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, text } = req.body;
    const result = await dbRun(
      "UPDATE instructions SET name = ?, text = ? WHERE id = ?",
      [name, text, id]
    );
    if (result.changes === 0) {
      return res.status(404).json({ error: 'Instruction context target not found' });
    }
    res.json({ message: 'Instruction updated successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/instruction/:id', async (req, res) => {
  try {
    await dbRun("DELETE FROM instructions WHERE id = ?", [req.params.id]);
    res.json({ message: 'Instruction deleted successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/workspace', async (req, res) => {
  try {
    const list = await dbQuery("SELECT * FROM workspaces");
    const formatted = list.map(item => ({
      ...item,
      folders_path: JSON.parse(item.folders_path)
    }));
    res.json(formatted);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/workspace', async (req, res) => {
  try {
    const { folders_path, name, instruction_id } = req.body;
    if (!name || !Array.isArray(folders_path)) {
      return res.status(400).json({ error: 'Missing workspace configurations' });
    }
    const id = 'ws_' + crypto.randomUUID().substring(0, 8);
    await dbRun(
      "INSERT INTO workspaces (id, name, folders_path, instruction_id, created_at) VALUES (?, ?, ?, ?, ?)",
      [id, name, JSON.stringify(folders_path), instruction_id || null, new Date().toISOString()]
    );
    await syncWorkspaceOnDisk(id, folders_path);
    res.status(201).json({ message: 'Created', id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/workspace/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { folders_path, name, instruction_id } = req.body;
    const result = await dbRun(
      "UPDATE workspaces SET name = ?, folders_path = ?, instruction_id = ? WHERE id = ?",
      [name, JSON.stringify(folders_path), instruction_id || null, id]
    );
    if (result.changes === 0) {
      return res.status(404).json({ error: 'Workspace target missing' });
    }
    await syncWorkspaceOnDisk(id, folders_path);
    res.json({ message: 'Updated' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/workspace/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await dbRun("DELETE FROM workspaces WHERE id = ?", [id]);
    const { wsDir } = getWorkspacePaths(id);
    await fs.rm(wsDir, { recursive: true, force: true });
    res.json({ message: 'Deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/workspace/:id/session', async (req, res) => {
  try {
    const sessions = await dbQuery(`
      SELECT s.*, COALESCE(MAX(m.created_at), s.created_at) as updated_at 
      FROM sessions s 
      LEFT JOIN messages m ON s.id = m.session_id 
      WHERE s.workspace_id = ? 
      GROUP BY s.id
      ORDER BY updated_at DESC`, [req.params.id]);
    const sessionsWithStatus = sessions.map(s => {
      let hasRunningTerminal = false;
      for (const [_, term] of activeTerminals.entries()) {
        if (term.sessionId === s.id && term.status === 'running') {
          hasRunningTerminal = true;
          break;
        }
      }
      return {
        ...s,
        status: sessionStatus.get(s.id) || 'idle',
        hasRunningTerminal
      };
    });
    res.json(sessionsWithStatus);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/workspace/:id/session/:sessionID', async (req, res) => {
  try {
    const { id: workspaceId, sessionID } = req.params;
    // Set abort flag so that any active executeGeminiStream loop for this session stops
    sessionAbortFlags.set(sessionID, true);

    // Terminate any running processes associated with the deleted session
    for (const [id, value] of activeTerminals.entries()) {
      if (value.sessionId === sessionID && value.status === 'running') {
        if (value.process) {
          try {
            process.kill(-value.process.pid);
          } catch (e) {
            try {
              value.process.kill();
            } catch (err) {}
          }
        }
        value.status = 'killed';
      }
    }

    await dbRun("DELETE FROM sessions WHERE id = ? AND workspace_id = ?", [sessionID, workspaceId]);
    const { sessionFolder } = getWorkspacePaths(workspaceId, sessionID);
    await fs.rm(sessionFolder, { recursive: true, force: true });
    res.json({ message: 'Session deleted successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function getRedoTargetMessageID(workspaceId, sessionID, messageID) {
  const { wsDir } = getWorkspacePaths(workspaceId);
  const allMessages = await loadSessionMessages(wsDir, sessionID);
  let targetID = parseInt(messageID, 10);
  let checked = false;

  while (!checked) {
    checked = true;
    const toDeleteIds = new Set(allMessages.filter(m => m.id >= targetID).map(m => m.id));
    if (toDeleteIds.size === 0) break;

    for (const msg of allMessages) {
      if (msg.id < targetID) continue;
      const parts = msg.parts;

      // Check 1: Model message containing functionCalls
      if (msg.role === 'model') {
        const hasFunctionCall = parts && parts.some(p => p.functionCall);
        if (hasFunctionCall) {
          const nextMsg = allMessages.find(m => m.id > msg.id);
          if (nextMsg && !toDeleteIds.has(nextMsg.id)) {
            targetID = Math.min(targetID, msg.id);
            checked = false;
            break;
          }
        }
      }

      // Check 2: User message containing functionResponses
      if (msg.role === 'user') {
        const hasFunctionResponse = parts && parts.some(p => p.functionResponse);
        if (hasFunctionResponse) {
          const prevMsg = allMessages.slice().reverse().find(m => m.id < msg.id);
          if (prevMsg && !toDeleteIds.has(prevMsg.id)) {
            targetID = Math.min(targetID, prevMsg.id);
            checked = false;
            break;
          }
        }
      }
    }
    if (!checked) continue;
  }

  return targetID;
}

async function findCommitHashForMessage(repo, messageId) {
  try {
    const { stdout } = await execGit(repo, `log --all --grep="msg_${messageId}$" --grep="msg_user_${messageId}$" --format="%H" -n 1`);
    return stdout.trim();
  } catch {
    return '';
  }
}

async function findSessionCommitHashForMessage(sessionDir, messageId) {
  try {
    const { stdout } = await execPromise(`git log --all --grep="msg_${messageId}$" --grep="msg_user_${messageId}$" --format="%H" -n 1`, { cwd: sessionDir });
    return stdout.trim();
  } catch {
    return '';
  }
}

app.get('/api/workspace/:id/session/:sessionID/redo-preview/:messageID', async (req, res) => {
  try {
    const { id: workspaceId, sessionID, messageID } = req.params;
    const repos = await getGitReposForWorkspace(workspaceId);

    // Validate and resolve target message ID to include function calls/responses and maintain user turn constraints
    const targetMessageID = await getRedoTargetMessageID(workspaceId, sessionID, messageID);

    // Find the message immediately preceding targetMessageID
    const { wsDir } = getWorkspacePaths(workspaceId);
    const allMessages = await loadSessionMessages(wsDir, sessionID);
    const targetIdx = allMessages.findIndex(m => m.id === targetMessageID);
    
    let priorMsgId = null;
    if (targetIdx > 0) {
      priorMsgId = allMessages[targetIdx - 1].id;
    }

    const affectedFiles = [];
    for (const repo of repos) {
      try {
        let priorHash = '';
        if (priorMsgId !== null) {
          priorHash = await findCommitHashForMessage(repo, priorMsgId);
        } else if (allMessages.length > 0) {
          const firstMsgId = allMessages[0].id;
          const firstHash = await findCommitHashForMessage(repo, firstMsgId);
          if (firstHash) {
            priorHash = `${firstHash}~1`;
          }
        }

        if (priorHash) {
          // Find all modified files between priorHash and current HEAD
          const { stdout } = await execGit(repo, `diff --name-only ${priorHash} HEAD`);
          const files = stdout.trim().split('\n').filter(Boolean);
          affectedFiles.push(...files.map(f => repo.folderName + '/' + f));
        }
      } catch {}
    }

    res.json({ affectedFiles, targetMessageID: targetMessageID });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/workspace/:id/session/:sessionID/redo/:messageID', async (req, res) => {
  try {
    const { id: workspaceId, sessionID, messageID } = req.params;
    const { wsDir } = getWorkspacePaths(workspaceId, sessionID);
    const repos = await getGitReposForWorkspace(workspaceId);

    // Validate and resolve target message ID to include function calls/responses and maintain user turn constraints
    const targetMessageID = await getRedoTargetMessageID(workspaceId, sessionID, messageID);

    const allMessages = await loadSessionMessages(wsDir, sessionID);
    const targetIdx = allMessages.findIndex(m => m.id === targetMessageID);
    
    let priorMsgId = null;
    if (targetIdx > 0) {
      priorMsgId = allMessages[targetIdx - 1].id;
    }

    const branchSuffix = `branch_${Date.now()}`;
    const sessionDir = path.join(wsDir, 'sessions', sessionID);

    // 1. Checkout session messages repo to the prior message state
    if (priorMsgId === null) {
      // Rollback to empty history: checkout an orphan branch
      try {
        await execPromise(`git checkout --orphan ${branchSuffix}`, { cwd: sessionDir });
        await execPromise('git rm -rf .', { cwd: sessionDir }).catch(() => {});
        // Create an empty messages.jsonl
        await saveSessionMessages(wsDir, sessionID, []);
        await execPromise('git add messages.jsonl', { cwd: sessionDir });
        await execPromise('git commit -m "msg_initial" --no-gpg-sign', { cwd: sessionDir });
      } catch (e) {
        return res.status(400).json({ error: `Session rollback to empty failed: ${e.message}` });
      }
    } else {
      const sessHash = await findSessionCommitHashForMessage(sessionDir, priorMsgId);
      if (!sessHash) {
        return res.status(400).json({ error: `Could not find session commit hash for message ID ${priorMsgId}` });
      }
      try {
        await execPromise(`git checkout -b ${branchSuffix} ${sessHash}`, { cwd: sessionDir });
      } catch (e) {
        return res.status(400).json({ error: `Session checkout to branch failed: ${e.message}` });
      }
    }

    // 2. Checkout workspace project repos to the prior message state
    const newSessionBranch = `sess_${sessionID}_${branchSuffix}`;
    for (const repo of repos) {
      if (priorMsgId === null) {
        // Rollback to initial commit
        try {
          // Find root commit hash
          const { stdout: rootHashOut } = await execGit(repo, 'rev-list --max-parents=0 HEAD');
          const rootHash = rootHashOut.trim().split('\n')[0];
          if (rootHash) {
            await execGit(repo, `checkout -B ${newSessionBranch} ${rootHash}`);
          }
        } catch (e) {
          console.error(`Failed to checkout root in repo ${repo.folderName}:`, e.message);
        }
      } else {
        const repoHash = await findCommitHashForMessage(repo, priorMsgId);
        if (repoHash) {
          try {
            await execGit(repo, `checkout -B ${newSessionBranch} ${repoHash}`);
          } catch (e) {
            console.error(`Failed to checkout commit ${repoHash} in repo ${repo.folderName}:`, e.message);
          }
        }
      }
    }

    res.json({ success: true, message: 'History rolled back and branched successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});



app.get('/api/workspace/:id/source-control/files', async (req, res) => {
  try {
    const { id: workspaceId } = req.params;
    let targetPathPrefix = req.query.path || "";
    
    const repos = await getGitReposForWorkspace(workspaceId);

    // If path is empty, render the top-level workspace folders as directories
    if (targetPathPrefix === "") {
      const items = repos.map(repo => {
        return {
          name: repo.folderName,
          path: repo.folderName, // Use the folder name as the path prefix
          type: 'directory',
          isDeleted: false,
          historyCount: 0,
          lastUpdate: "Unknown",
          size: 0,
          historySize: 0,
          repoHash: repo.hashedName
        };
      });

      for (const item of items) {
        const repo = repos.find(r => r.folderName === item.path);
        if (repo) {
          try {
            const { stdout: countOut } = await execGit(repo, 'log --oneline');
            item.historyCount = countOut.trim().split('\n').filter(Boolean).length;

            const { stdout: updateOut } = await execGit(repo, 'log -1 --format="%cd (%s)" --date=relative');
            if (updateOut.trim()) item.lastUpdate = updateOut.trim();

            item.historySize = await getPathHistorySize(repo, "");
          } catch {}
        }
      }

      return res.json({ items });
    }

    // Split targetPathPrefix into targetFolderName and relativePathInsideRepo
    const firstSlashIdx = targetPathPrefix.indexOf('/');
    const targetFolderName = firstSlashIdx === -1 ? targetPathPrefix : targetPathPrefix.substring(0, firstSlashIdx);
    const relativePathInsideRepo = firstSlashIdx === -1 ? "" : targetPathPrefix.substring(firstSlashIdx + 1);

    const repo = repos.find(r => r.folderName === targetFolderName);
    if (!repo) {
      return res.json({ items: [] });
    }

    const targetPathPrefixNoSlash = relativePathInsideRepo && !relativePathInsideRepo.endsWith('/') 
      ? relativePathInsideRepo + '/' 
      : relativePathInsideRepo;

    let paths = [];
    try {
      const { stdout } = await execGit(repo, 'log --pretty=format: --name-only --all');
      paths = Array.from(new Set(stdout.trim().split('\n').map(p => p.trim()).filter(Boolean)));
    } catch (e) {
      return res.json({ items: [] });
    }

    const childrenMap = new Map();
    for (const p of paths) {
      if (targetPathPrefixNoSlash === "" || p.startsWith(targetPathPrefixNoSlash)) {
        const relativeToPrefix = targetPathPrefixNoSlash === "" ? p : p.substring(targetPathPrefixNoSlash.length);
        if (!relativeToPrefix) continue;

        const segments = relativeToPrefix.split('/');
        const name = segments[0];
        const fullPath = targetPathPrefixNoSlash + name;

        if (segments.length > 1) {
          childrenMap.set(name, { type: 'directory', fullPath });
        } else {
          childrenMap.set(name, { type: 'file', fullPath });
        }
      }
    }

    const items = [];
    for (const [name, info] of childrenMap.entries()) {
      const realPath = path.join(repo.realPath, info.fullPath);
      let isDeleted = true;
      let currentSize = 0;

      try {
        const stat = await fs.stat(realPath);
        isDeleted = false;
        if (info.type === 'file') {
          currentSize = stat.size;
        }
      } catch {}

      let historyCount = 0;
      try {
        const { stdout: countOut } = await execGit(repo, `log --oneline -- "${info.fullPath}"`);
        historyCount = countOut.trim().split('\n').filter(Boolean).length;
      } catch {}

      let lastUpdate = "Unknown";
      try {
        const { stdout: updateOut } = await execGit(repo, `log -1 --format="%cd (%s)" --date=relative -- "${info.fullPath}"`);
        if (updateOut.trim()) {
          lastUpdate = updateOut.trim();
        }
      } catch {}

      const historySize = await getPathHistorySize(repo, info.fullPath);

      items.push({
        name,
        path: targetFolderName + '/' + info.fullPath, // Keep path prefix as folderName/relativePath
        type: info.type,
        isDeleted,
        historyCount,
        lastUpdate,
        size: currentSize,
        historySize,
        repoHash: repo.hashedName
      });
    }

    res.json({ items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/workspace/:id/source-control/ignore', async (req, res) => {
  try {
    const { id: workspaceId } = req.params;
    const { path: itemPath, repoHash } = req.body;

    if (!itemPath) {
      return res.status(400).json({ error: 'Missing parameter "path"' });
    }

    const repos = await getGitReposForWorkspace(workspaceId);
    
    // Split itemPath to extract the relative path inside the repo
    const firstSlashIdx = itemPath.indexOf('/');
    const targetFolderName = firstSlashIdx === -1 ? itemPath : itemPath.substring(0, firstSlashIdx);
    const relativePathInsideRepo = firstSlashIdx === -1 ? "" : itemPath.substring(firstSlashIdx + 1);

    const repo = repos.find(r => r.folderName === targetFolderName);
    if (!repo) {
      return res.status(400).json({ error: 'Workspace repository not found' });
    }

    const excludePath = path.join(repo.gitDir, 'info', 'exclude');
    await fs.mkdir(path.dirname(excludePath), { recursive: true });
    
    let currentExclude = "";
    try {
      currentExclude = await fs.readFile(excludePath, 'utf-8');
    } catch {}
    
    let ignorePattern = relativePathInsideRepo;
    if (!currentExclude.split('\n').includes(ignorePattern)) {
      await fs.writeFile(excludePath, currentExclude + `\n${ignorePattern}\n`, 'utf-8');
    }

    await purgePathFromGitHistory(repo, relativePathInsideRepo);

    res.json({ success: true, message: `Successfully ignored "${relativePathInsideRepo}" and purged its history.` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/workspace/:id/source-control/timeline', async (req, res) => {
  try {
    const { id: workspaceId } = req.params;
    const limit = parseInt(req.query.limit || "20", 10);
    const offset = parseInt(req.query.offset || "0", 10);

    const repos = await getGitReposForWorkspace(workspaceId);
    let allCommits = [];

    for (const repo of repos) {
      try {
        const { stdout } = await execGit(repo, 'log --format="%H|%at|%cd|%s"');
        const lines = stdout.trim().split('\n').filter(Boolean);
        for (const line of lines) {
          const parts = line.split('|');
          if (parts.length >= 4) {
            allCommits.push({
              hash: parts[0],
              timestamp: parseInt(parts[1], 10),
              date: parts[2],
              subject: parts[3],
              repoHash: repo.hashedName
            });
          }
        }
      } catch (e) {}
    }

    allCommits.sort((a, b) => b.timestamp - a.timestamp);

    const paginatedCommits = allCommits.slice(offset, offset + limit);

    const resolvedTimeline = [];
    for (const c of paginatedCommits) {
      let message = null;
      let branches = [];
      try {
        const repo = repos.find(r => r.hashedName === c.repoHash);
        if (repo) {
          const { stdout } = await execGit(repo, `branch --contains ${c.hash}`);
          branches = stdout.trim().split('\n').map(b => b.replace('*', '').trim()).filter(Boolean);
        }
      } catch {}

      if (c.subject.startsWith('msg_')) {
        let msgIdStr = c.subject.substring(4);
        if (msgIdStr.startsWith('user_')) {
          msgIdStr = msgIdStr.substring(5);
        }
        const msgId = parseInt(msgIdStr, 10);
        if (!isNaN(msgId)) {
          try {
            let dbMsg = null;
            const sessions = await dbQuery("SELECT id FROM sessions WHERE workspace_id = ?", [workspaceId]);
            const { wsDir } = getWorkspacePaths(workspaceId);
            for (const s of sessions) {
              const messages = await loadSessionMessages(wsDir, s.id);
              const found = messages.find(m => m.id === msgId);
              if (found) {
                dbMsg = {
                  id: found.id,
                  session_id: s.id,
                  role: found.role,
                  parts: found.parts,
                  created_at: found.createdAt
                };
                break;
              }
            }
            if (dbMsg) {
              message = {
                id: dbMsg.id,
                sessionId: dbMsg.session_id,
                role: dbMsg.role,
                parts: dbMsg.parts,
                createdAt: dbMsg.created_at
              };
            }
          } catch {}
        }
      }

      resolvedTimeline.push({
        hash: c.hash,
        date: c.date,
        subject: c.subject,
        message,
        repoHash: c.repoHash,
        branches
      });
    }

    res.json({
      timeline: resolvedTimeline,
      totalCount: allCommits.length,
      hasMore: offset + limit < allCommits.length
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/workspace/:id/session/:sessionID/branches', async (req, res) => {
  try {
    const { id: workspaceId, sessionID } = req.params;
    const { wsDir } = getWorkspacePaths(workspaceId);
    const sessionDir = path.join(wsDir, 'sessions', sessionID);

    // 1. Get all branches in the session repository
    const { stdout: branchesOut } = await execPromise('git branch --format="%(refname:short)"', { cwd: sessionDir });
    const branches = branchesOut.trim().split('\n').map(b => b.trim()).filter(Boolean);
    
    // 2. Get active branch
    const { stdout: activeBranchOut } = await execPromise('git branch --show-current', { cwd: sessionDir });
    const activeBranch = activeBranchOut.trim() || 'master';

    // 3. For each branch, get message history list (chronological, as msgId integers)
    const branchHistories = {};
    for (const b of branches) {
      try {
        const { stdout: logOut } = await execPromise(`git log ${b} --format="%s"`, { cwd: sessionDir });
        const msgIds = logOut.trim().split('\n').map(line => {
          if (line.startsWith('msg_')) {
            let idStr = line.substring(4);
            if (idStr.startsWith('user_')) idStr = idStr.substring(5);
            return parseInt(idStr, 10);
          }
          return null;
        }).filter(id => id !== null && !isNaN(id)).reverse(); // reverse to get chronological order
        branchHistories[b] = msgIds;
      } catch {}
    }

    // 4. Calculate per-message pagination alternatives for the active branch history
    // (used for the inline pill on each message bubble while streaming)
    const activeHistory = branchHistories[activeBranch] || [];
    const pagination = {};

    activeHistory.forEach((msgId, index) => {
      const parentId = index > 0 ? activeHistory[index - 1] : null;
      const alternatives = [];
      const seenChildIds = new Set();

      for (const b of branches) {
        const history = branchHistories[b] || [];
        const pIdx = parentId === null ? -1 : history.indexOf(parentId);
        
        if (parentId === null && history.length > 0) {
          const childId = history[0];
          if (!seenChildIds.has(childId)) {
            seenChildIds.add(childId);
            alternatives.push({ branchName: b, targetMsgId: childId });
          }
        } else if (pIdx !== -1 && pIdx + 1 < history.length) {
          const childId = history[pIdx + 1];
          if (!seenChildIds.has(childId)) {
            seenChildIds.add(childId);
            alternatives.push({ branchName: b, targetMsgId: childId });
          }
        }
      }

      if (alternatives.length > 1) {
        const activeAltIdx = alternatives.findIndex(alt => alt.targetMsgId === msgId);
        if (activeAltIdx !== -1) {
          pagination[msgId] = {
            currentIndex: activeAltIdx + 1,
            totalCount: alternatives.length,
            alternatives: alternatives.map((alt, i) => ({
              index: i + 1,
              branchName: alt.branchName,
              targetMsgId: alt.targetMsgId
            }))
          };
        }
      }
    });

    // 5. Compute branchPoints: places in the chat where branches diverge.
    // A branchPoint is keyed by the PARENT message (last shared msg before divergence).
    // The client inserts a "Change Branch" divider row AFTER that parent message.
    const branchPointsMap = new Map(); // parentMsgId (or null) -> { alternatives, seenChildIds }

    for (const b of branches) {
      const history = branchHistories[b] || [];
      for (let i = 0; i < history.length; i++) {
        const msgId = history[i];
        const parentId = i > 0 ? history[i - 1] : null;
        const key = parentId === null ? '__root__' : String(parentId);

        if (!branchPointsMap.has(key)) {
          branchPointsMap.set(key, { parentMsgId: parentId, alternatives: [], seenChildIds: new Set() });
        }
        const bp = branchPointsMap.get(key);
        if (!bp.seenChildIds.has(msgId)) {
          bp.seenChildIds.add(msgId);
          bp.alternatives.push({ branchName: b, targetMsgId: msgId });
        }
      }
    }

    // Only keep points with alternatives that diverge from the current active path
    const branchPoints = [];
    for (const [, bp] of branchPointsMap) {
      // Only include branch points that are actually part of the current active history.
      // If the parent message is not in the active branch, this divergence point is irrelevant to the current view.
      if (bp.parentMsgId !== null && !activeHistory.includes(bp.parentMsgId)) {
        continue;
      }

      // Determine the next message in the current active branch
      let nextMsgId = null;
      if (bp.parentMsgId === null) {
        nextMsgId = activeHistory[0] || null;
      } else {
        const pIdx = activeHistory.indexOf(bp.parentMsgId);
        nextMsgId = pIdx !== -1 ? activeHistory[pIdx + 1] : null;
      }

      // A point is a branch point if there is at least one alternative that isn't the current next message
      const hasDivergence = bp.alternatives.some(alt => alt.targetMsgId !== nextMsgId);
      if (!hasDivergence) continue;

      // Find the currently active alternative index. 
      // If the current branch ends at the parent (no next message), index is 0.
      let currentIndex = 0;
      for (let i = 0; i < bp.alternatives.length; i++) {
        if (activeHistory.includes(bp.alternatives[i].targetMsgId)) {
          currentIndex = i + 1;
          break;
        }
      }

      branchPoints.push({
        afterMsgId: bp.parentMsgId, // null means "before the first message"
        currentIndex,
        totalCount: bp.alternatives.length,
        alternatives: bp.alternatives.map((alt, i) => ({
          index: i + 1,
          branchName: alt.branchName,
          targetMsgId: alt.targetMsgId
        }))
      });
    }

    res.json({
      activeBranch,
      branches,
      pagination,
      branchPoints
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/workspace/:id/session/:sessionID/checkout-branch/:branchName', async (req, res) => {
  try {
    const { id: workspaceId, sessionID, branchName } = req.params;
    const { wsDir } = getWorkspacePaths(workspaceId);
    const repos = await getGitReposForWorkspace(workspaceId);
    const sessionDir = path.join(wsDir, 'sessions', sessionID);

    // 1. Checkout session branch in messages repository
    await execPromise(`git checkout ${branchName}`, { cwd: sessionDir });

    // 2. Checkout corresponding session branch in all project repositories
    const newSessionBranch = `sess_${sessionID}_${branchName}`;
    for (const repo of repos) {
      try {
        const { stdout: exists } = await execGit(repo, `show-ref --verify refs/heads/${newSessionBranch}`).catch(() => ({ stdout: '' }));
        if (exists.trim()) {
          await execGit(repo, `checkout ${newSessionBranch}`);
        }
      } catch (e) {
        console.error(`Failed to checkout branch ${newSessionBranch} in repo ${repo.folderName}:`, e.message);
      }
    }

    res.json({ success: true, message: `Checked out branch ${branchName} successfully` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/workspace/:id/session/:sessionID', async (req, res) => {
  try {
    const { id: workspaceId, sessionID } = req.params;

    let session = await dbGet("SELECT * FROM sessions WHERE id = ?", [sessionID]);
    
    const { wsDir } = getWorkspacePaths(workspaceId);
    const messages = await loadSessionMessages(wsDir, sessionID);

    const sessionHistory = messages.map(row => ({
      id: row.id,
      role: row.role,
      parts: row.parts
    }));

    const host = req.get('host');
    const protocol = req.secure ? 'wss' : 'ws';
    const wsURL = `${protocol}://${host}/stream/workspace/${workspaceId}/session/${sessionID}`;

    res.json({
      sessionHistory,
      wsURL
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/workspace/:id/session/:sessionID/artifacts', async (req, res) => {
  try {
    const workspaceId = req.params.id;
    const sessionId = req.params.sessionID;
    const { sessionFolder, sessionArtifactDir } = getWorkspacePaths(workspaceId, sessionId);
    
    if (!sessionFolder) {
      return res.status(404).json({ error: 'Session folder not found' });
    }
    
    await fs.mkdir(sessionArtifactDir, { recursive: true });
    
    const files = await getFilesRecursively(sessionArtifactDir);
    
    const formatted = [];
    for (const filePath of files) {
      const relPath = path.relative(sessionFolder, filePath).replace(/\\/g, '/');
      const name = path.basename(filePath);
      const stat = await fs.stat(filePath);
      formatted.push({
        name,
        path: relPath,
        size: stat.size,
        updatedAt: stat.mtime.toISOString()
      });
    }
    
    res.json({
      items: formatted
    });
  } catch (error) {
    res.status(500).json({ error: `Could not load artifacts: ${error.message}` });
  }
});

app.get('/api/workspace/:id/session/:sessionID/artifacts/read', async (req, res) => {
  try {
    const workspaceId = req.params.id;
    const sessionId = req.params.sessionID;
    const targetPath = req.query.path;
    
    if (!targetPath) {
      return res.status(400).json({ error: 'Missing path parameter' });
    }
    
    const { sessionFolder } = getWorkspacePaths(workspaceId, sessionId);
    
    const absolutePath = path.resolve(sessionFolder, targetPath);
    if (!absolutePath.startsWith(sessionFolder)) {
      return res.status(403).json({ error: 'Access Denied: Path is outside the session directory.' });
    }
    
    const stat = await fs.stat(absolutePath);
    if (stat.isDirectory()) {
      return res.status(400).json({ error: 'Target path is a directory' });
    }
    
    const content = await fs.readFile(absolutePath, 'utf8');
    res.json({
      path: targetPath,
      name: path.basename(absolutePath),
      size: stat.size,
      content: content
    });
  } catch (error) {
    res.status(500).json({ error: `Could not read artifact file: ${error.message}` });
  }
});

app.post('/api/workspace/:id/session/:sessionID', upload.array('files'), async (req, res) => {
  try {
    const { id: workspaceId, sessionID } = req.params;
    const { message } = req.body;
    const reqFiles = req.files || [];

    const ws = await dbGet("SELECT folders_path FROM workspaces WHERE id = ?", [workspaceId]);
    if (!ws) {
      return res.status(404).json({ error: 'Workspace index target not found.' });
    }

    // Ensure session exists before processing message
    let session = await dbGet("SELECT * FROM sessions WHERE id = ?", [sessionID]);
    if (!session) {
      await dbRun(
        "INSERT INTO sessions (id, workspace_id, name, created_at) VALUES (?, ?, ?, ?)",
        [sessionID, workspaceId, "New Agentic Chat Session", new Date().toISOString()]
      );
    }

    const { sessionFolder, sessionUploadsDir, sessionArtifactDir, sessionScratchpadDir } = getWorkspacePaths(workspaceId, sessionID);
    await fs.mkdir(sessionFolder, { recursive: true });
    await fs.mkdir(sessionUploadsDir, { recursive: true });
    await fs.mkdir(sessionArtifactDir, { recursive: true });
    await fs.mkdir(sessionScratchpadDir, { recursive: true });
    
    const parts = [];
    if (message) {
      parts.push({ text: message });
    }

    for (const file of reqFiles) {
      const ext = path.extname(file.originalname);
      const baseName = path.basename(file.originalname, ext).replace(/[^a-zA-Z0-9.-]/g, "_");
      // Add a 3-character random hash prefix to avoid collisions
      const hashPrefix = crypto.randomBytes(2).toString('hex').substring(0, 3);
      const secureFileName = `${hashPrefix}_${baseName}${ext}`;
      const localFilePath = path.join(sessionUploadsDir, secureFileName);
      // Relative path shown to the model
      const relFilePath = `uploads/${secureFileName}`;
      
      await fs.writeFile(localFilePath, file.buffer);

      const mimeType = file.mimetype || mime.getType(secureFileName) || 'application/octet-stream';
      
      parts.push({
        _localFilePath: localFilePath,
        mimeType
      });

      parts.push({
        text: `[User uploaded file: "${file.originalname}" is available in your workspace at relative path: "${relFilePath}"]`
      });
    }

    if (parts.length === 0) {
      return res.status(400).json({ error: 'Must provide content parts or file segments.' });
    }

    const { wsDir } = getWorkspacePaths(workspaceId);
    await initSessionGit(wsDir, sessionID);
    const messages = await loadSessionMessages(wsDir, sessionID);
    const newMsgId = messages.reduce((max, m) => m.id > max ? m.id : max, 0) + 1;
    messages.push({
      id: newMsgId,
      role: 'user',
      parts,
      createdAt: new Date().toISOString()
    });
    await saveSessionMessages(wsDir, sessionID, messages);
    await commitSessionMessage(wsDir, sessionID, newMsgId, 'user');

    res.json({ message: 'Message metadata recorded successfully inside SQLite context stack.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function getLatestLogOutput(filePath, limit = 100) {
  try {
    const stat = await fs.stat(filePath);
    const size = stat.size;
    if (size === 0) return "";
    const readSize = Math.min(size, limit);
    const fd = await fs.open(filePath, 'r');
    try {
      const buffer = Buffer.alloc(readSize);
      await fd.read(buffer, 0, readSize, size - readSize);
      return buffer.toString('utf8');
    } finally {
      await fd.close();
    }
  } catch (e) {
    return "";
  }
}

function isTextFile(fileName) {
  const binaryExtensions = new Set([
    '.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.tiff', '.psd',
    '.zip', '.tar', '.gz', '.bz2', '.7z', '.rar', '.xz',
    '.mp3', '.mp4', '.avi', '.mkv', '.mov', '.flv', '.wav', '.ogg',
    '.db', '.sqlite', '.sqlite3', '.bin', '.exe', '.dll', '.so', '.dylib', '.class', '.jar',
    '.woff', '.woff2', '.ttf', '.eot', '.otf',
    '.dmg', '.iso', '.img'
  ]);
  const ext = path.extname(fileName).toLowerCase();
  return !binaryExtensions.has(ext);
}

async function getFilesRecursively(dir) {
  let results = [];
  try {
    const list = await fs.readdir(dir, { withFileTypes: true });
    for (const file of list) {
      const res = path.resolve(dir, file.name);
      if (file.isDirectory()) {
        results = results.concat(await getFilesRecursively(res));
      } else {
        results.push(res);
      }
    }
  } catch (err) {
    // Ignore if directory doesn't exist
  }
  return results;
}

async function assembleContextualInstruction(workspaceId, sessionId, baseInstructionPrompt, latestUserPromptText) {
  const ws = await dbGet("SELECT folders_path FROM workspaces WHERE id = ?", [workspaceId]);
  const folders = ws ? JSON.parse(ws.folders_path) : [];
  const { wsDir, sessionFolder, sessionMirrorRoot, sessionArtifactDir } = getWorkspacePaths(workspaceId, sessionId);

  const session = await dbGet("SELECT name FROM sessions WHERE id = ?", [sessionId]);
  const sessionName = session ? session.name : "Unknown Session";

  // Build model-visible project structure listing (relative paths only)
  const projectFolderNames = [];
  for (const folder of folders) {
    const folderName = path.basename(path.resolve(folder));
    projectFolderNames.push(folderName);
  }

  // Gather currently running background processes related to this session ID
  const trackingTerminals = [];
  for (const [id, value] of activeTerminals.entries()) {
    if (value.sessionId === sessionId) {
      let latestOutput = "";
      if (value.logFilePath) {
        latestOutput = await getLatestLogOutput(value.logFilePath, 100);
      }
      trackingTerminals.push({
        terminal_id: id,
        name: value.name || undefined,
        command: value.command,
        status: value.status,
        // Show only the relative path to the model
        log_file: value.logFileRelPath || 'terminals/unknown.log',
        started_at: value.started_at,
        latest_output: latestOutput
      });
    }
  }



  const generatedSystemContext = `
=========================================
=== SYSTEM CONTEXT (DO NOT OVERWRITE) ===
=========================================
You are an AI coding agent operating inside an overlay session.
You have NO knowledge of the real filesystem paths on the host system.

Your working directory is the ROOT of your session workspace.
All paths you use in tool calls MUST be RELATIVE paths from this root.
NEVER use absolute paths (starting with / or ~). They are FORBIDDEN and will cause an error.

Your session workspace layout:
- Project files (mirrored for editing): ${projectFolderNames.map(n => `workspace_mirror/${n}/`).join(', ')}
- Uploaded user files: uploads/
- Terminal log files: terminals/
- Artifacts directory (for plans, tasks, walkthroughs): artifact/
- Scratchpad directory (for temporary scripts, test verification code, temporary data): scratchpad/

To access a project file, use a path like: "workspace_mirror/${projectFolderNames[0] || 'my_project'}/src/index.js"
To read an uploaded file, use a path like: "uploads/abc_myfile.pdf"
To read terminal output, use a path like: "terminals/term_12345678.log"
To write plans, task lists, or walkthroughs: use files inside "artifact/" (e.g. "artifact/implementation_plan.md")
To run verification/testing scripts: use files inside "scratchpad/" (e.g. "scratchpad/verify.js")

Current Session Name: "${sessionName}"

Priority Directive:
- If the Current Session Name is "New Agentic Chat Session" or is generic/placeholder, your absolute first priority is to call \`set_session_name\` with a concise, descriptive name based on the user's request.
- Do NOT proceed with other tool calls or the final response until the session has been meaningfully named.

Safety Guardrails:
- You may ONLY operate on paths within your session workspace (relative paths listed above).
- Absolute paths, paths starting with "../", or paths referencing any external location are FORBIDDEN.
- The system will reject any access attempt outside your sandbox with an Access Denied error.

Workflow Guidance:
== Plan Stage (Read Only)
 - Gather information first: Thoroughly research the codebase across all layers (e.g. check both frontend/UI and backend files) to identify all files and components that will be affected by the requested feature. Do not make assumptions about code boundaries.
 - Check for existing plan: Check if an \`artifact/implementation_plan.md\` file already exists. If it does, read its contents first.
 - Create or Modify Plan: For non-trivial requests, write a detailed implementation plan into \`artifact/implementation_plan.md\`. If the plan already exists, modify/update it with your new findings rather than overwriting it completely.
 - Ask the user explicitly if the proposed plan is OK or not. Stop and wait for the user's explicit approval before proceeding. Do NOT execute any modifying commands or write project files until approved.
== Execute Stage (Allowed after user approved the plan)
 - Create a task checklist file named \`task.md\` inside the \`artifact/\` folder (i.e. \`artifact/task.md\`) to track progress. Mark items as completed as you implement the plan.
 - Implement the plan step-by-step, using the appropriate tool calls.
== Verify & Walkthrough Stage
 - Verify the results of each step, ensuring that the output matches expectations.
 - Create any scripts used for testing and verification inside the \`scratchpad/\` folder (e.g. \`scratchpad/test.js\`).
 - If verification fails, analyze the cause, adjust the plan/tasks, and re-execute as necessary.
 - Once implementation and verification are complete, create a file named \`walkthrough.md\` inside the \`artifact/\` folder (i.e. \`artifact/walkthrough.md\`) to summarize the changes made and the verification results.

Required Artifact Formats:
---
#### \`artifact/implementation_plan.md\` Format:
\`\`\`markdown
# [Goal Description]
Brief description of the problem and proposed solution.

## User Review Required
Highlight critical items (breaking changes, design decisions).

## Open Questions
Clarifying questions impacting the plan.

## Proposed Changes
Group files by component. Use markdown links with relative paths and detail exactly which sections, functions, or lines are changing:

### [Component Name]
#### [MODIFY] [file_basename](workspace_mirror/my_project/path/to/file)
- **Target Section/Function:** e.g. \`functionName()\` or specific code block
- **Changes:** Description of what is changing and why
- **Lines/Location:** Target lines or context

#### [NEW] [file_basename](workspace_mirror/my_project/path/to/file)
- **Purpose:** What this new file does
- **Exports:** Functions or classes defined

## Verification Plan
### Automated Tests
- Commands to run.
### Manual Verification
- Manual testing details.
\`\`\`

---
#### \`artifact/task.md\` Format:
\`\`\`markdown
- [ ] uncompleted tasks
- [/] in-progress tasks
- [x] completed tasks
- Use indented lists for sub-items
\`\`\`

---
#### \`artifact/walkthrough.md\` Format:
\`\`\`markdown
# Walkthrough
## Changes Made
- List of changes.
## Verification & Testing
- Test results and verification logs.
\`\`\`


Active Running Background Terminals:
${JSON.stringify(trackingTerminals, null, 2)}

User Latest Context Request:
"${latestUserPromptText || 'none'}"

Instructions for Terminal Execution:
- Background processes are completely async. When you call \`execute_command\`, it starts and returns immediately.
- When starting a background process, ALWAYS provide a descriptive \`name\` parameter.
- Do NOT block or wait on \`wait_terminal\` for long-running background processes.
- To check on the output of a process, use \`read_file\` on the relative \`log_file\` path returned from \`execute_command\`.
- Before starting a new server or process, check "Active Running Background Terminals". If a duplicate exists, call \`terminate_terminal\` with its ID first.
=========================================
`;

  let finalInstruction = `${baseInstructionPrompt || "You are a professional systems integration developer and coding agent. Perform tasks step by step and keep responses technical."}\n\n${generatedSystemContext}`;

  if (sessionArtifactDir) {
    try {
      const artifactFiles = await getFilesRecursively(sessionArtifactDir);
      const textArtifactFiles = artifactFiles.filter(filePath => isTextFile(filePath));
      if (textArtifactFiles.length > 0) {
        let injectedArtifacts = "\n\n=== INJECTED ARTIFACTS ===";
        for (const filePath of textArtifactFiles) {
          const relPath = path.relative(sessionFolder, filePath).replace(/\\/g, '/');
          const content = await fs.readFile(filePath, 'utf8');
          injectedArtifacts += `\n<${relPath}>\n${content}\n</artifact>`;
        }
        finalInstruction += injectedArtifacts;
      }
    } catch (err) {
      console.error("Error reading artifact files for system instruction:", err);
    }
  }

  return finalInstruction;
}

function trimHistoryToLast100Turns(historyRows) {
  if (historyRows.length <= 100) {
    return historyRows;
  }

  const firstUserIdx = historyRows.findIndex(row => row.role === 'user');
  if (firstUserIdx === -1) {
    return historyRows.slice(-100);
  }

  const firstUserTurn = historyRows[firstUserIdx];
  // Slice the remaining turns after the first user turn, taking the last 98 turns
  const rest = historyRows.slice(firstUserIdx + 1);
  const slicedRest = rest.slice(-98);

  // Gemini expects the content history stack to start with a 'user' turn.
  // Since firstUserTurn is a 'user' turn, the returned array will start with a 'user' turn.
  return [firstUserTurn, ...slicedRest];
}

function isRetryableError(error) {
  const status = error.status || error.statusCode || (error.cause && (error.cause.status || error.cause.statusCode));
  if (status) {
    const s = parseInt(status, 10);
    // 4xx client errors (like 400 Bad Request, 403 Forbidden, 429 Rate Limit) are NOT retryable
    if (s >= 400 && s < 500) {
      return false;
    }
    // 5xx server errors are retryable
    if (s >= 500 && s < 600) {
      return true;
    }
  }

  const msg = (error.message || '').toLowerCase();
  if (
    msg.includes('400') || 
    msg.includes('bad request') || 
    msg.includes('429') || 
    msg.includes('rate limit') || 
    msg.includes('quota') || 
    msg.includes('403') || 
    msg.includes('401') || 
    msg.includes('unauthorized')
  ) {
    return false;
  }

  const code = error.code || (error.cause && error.cause.code);
  if (
    code === 'ETIMEDOUT' || 
    code === 'ECONNRESET' || 
    code === 'EADDRINUSE' || 
    code === 'ECONNREFUSED' || 
    code === 'ENOTFOUND' || 
    code === 'EPIPE'
  ) {
    return true;
  }

  // Treat unknown errors (like general connection loss) as retryable
  return true;
}

async function executeGeminiStream(ws, workspaceId, sessionId, userMessageText, apiKeyId) {
  try {
    const currentKey = await getNextApiKey(apiKeyId);
    if (!currentKey) {
      ws.send(JSON.stringify({ 
        type: 'ERROR', 
        message: 'No available API Key in rotation storage database.' 
      }));
      return;
    }

    const ai = new GoogleGenAI({ apiKey: currentKey });

    // Ensure session exists to prevent SQLITE_CONSTRAINT foreign key issues on user text messages
    let session = await dbGet("SELECT * FROM sessions WHERE id = ?", [sessionId]);
    if (!session) {
      const wsCheck = await dbGet("SELECT id FROM workspaces WHERE id = ?", [workspaceId]);
      if (wsCheck) {
        await dbRun(
          "INSERT INTO sessions (id, workspace_id, name, created_at) VALUES (?, ?, ?, ?)",
          [sessionId, workspaceId, "New Agentic Chat Session", new Date().toISOString()]
        );
      } else {
        ws.send(JSON.stringify({ type: 'ERROR', message: 'Workspace index target not found.' }));
        return;
      }
    }

    sessionStatus.set(sessionId, 'generating');

    // Avoid inserting duplicate consecutive user messages
    const { wsDir } = getWorkspacePaths(workspaceId);
    const messages = await loadSessionMessages(wsDir, sessionId);
    const lastMsg = messages[messages.length - 1];
    let isDuplicate = false;
    if (lastMsg && lastMsg.role === 'user') {
      try {
        if (lastMsg.parts.length > 0 && lastMsg.parts[0].text === userMessageText) {
          isDuplicate = true;
        }
      } catch (e) {}
    }

    let userMsgId = null;
    if (!isDuplicate) {
      const userParts = [{ text: userMessageText }];
      const newMessages = await loadSessionMessages(wsDir, sessionId);
      userMsgId = newMessages.reduce((max, m) => m.id > max ? m.id : max, 0) + 1;
      newMessages.push({
        id: userMsgId,
        role: 'user',
        parts: userParts,
        createdAt: new Date().toISOString()
      });
      await saveSessionMessages(wsDir, sessionId, newMessages);
      await commitSessionMessage(wsDir, sessionId, userMsgId, 'user');
    } else if (lastMsg) {
      userMsgId = lastMsg.id;
    }

    if (userMsgId) {
      try {
        const messagesList = await loadSessionMessages(wsDir, sessionId);
        const prevModelMsg = messagesList.slice().reverse().find(m => m.role === 'model' && m.id < userMsgId);
        const commitMsgId = prevModelMsg ? String(prevModelMsg.id) : `user_${userMsgId}`;

        const repos = await getGitReposForWorkspace(workspaceId);
        for (const repo of repos) {
          try {
            const { stdout: statusOut } = await execGit(repo, 'status --porcelain');
            if (statusOut.trim()) {
              await execGit(repo, 'add -A');
              await execGit(repo, `commit -m "msg_${commitMsgId}" --no-gpg-sign`);
              console.log(`Auto-committed changes for repo ${repo.hashedName} at message ${commitMsgId}`);
            }
          } catch (e) {
            console.error(`Failed to auto-commit in repo ${repo.hashedName}:`, e.message);
          }
        }
      } catch (e) {
        console.error(`Failed to auto-commit before message:`, e.message);
      }
    }

    const workspace = await dbGet("SELECT instruction_id FROM workspaces WHERE id = ?", [workspaceId]);
    let baseInstruction = "You are a technical software assistant. Help edit code, structure commands, and coordinate operations.";
    
    if (workspace && workspace.instruction_id) {
      const record = await dbGet("SELECT text FROM instructions WHERE id = ?", [workspace.instruction_id]);
      if (record && record.text) {
        baseInstruction = record.text;
      }
    }

    const dynamicInstruction = await assembleContextualInstruction(workspaceId, sessionId, baseInstruction, userMessageText);

    const tools = [
      {
        functionDeclarations: [
          {
            name: 'list_dir',
            description: 'Lists files and directory structures inside paths. All paths are relative to your session workspace root.',
            parameters: {
              type: Type.OBJECT,
              properties: {
                path: { type: Type.STRING, description: 'Relative path within your session workspace (e.g. "workspace_mirror/myproject/src", "uploads").' }
              },
              required: ['path']
            }
          },
          {
            name: 'read_file',
            description: 'Reads contents of file, supporting pagination. Returns the content and the total line count of the file.',
            parameters: {
              type: Type.OBJECT,
              properties: {
                path: { type: Type.STRING, description: 'Relative path to the target file within your session workspace (e.g. "workspace_mirror/myproject/index.html" or "uploads/abc_doc.pdf").' },
                from_line: { type: Type.INTEGER, description: 'First line index target. Use negative values to count from the end of the file (e.g., -1 is the last line).' },
                to_line: { type: Type.INTEGER, description: 'End line index target. Use negative values to count from the end of the file (e.g., -1 is the last line).' }
              },
              required: ['path']
            }
          },
          {
            name: 'write_file',
            description: 'Creates a new file or completely overwrites an existing file. Use ONLY for creating new files or when replacing the entire content. For editing existing files, use edit_file instead.',
            parameters: {
              type: Type.OBJECT,
              properties: {
                path: { type: Type.STRING, description: 'Relative path within your session workspace (e.g. "workspace_mirror/myproject/new_file.js").' },
                content: { type: Type.STRING, description: 'Complete file contents to write.' }
              },
              required: ['path', 'content']
            }
          },
          {
            name: 'edit_file',
            description: 'Patches an existing file using a search-block / replace-block strategy. Finds an exact occurrence of `search` in the file and replaces it with `replace`. Prefer this over write_file when editing existing files — only the changed section needs to be specified. The `search` block must exactly match the file content including whitespace and indentation. Use `occurrence` to target a specific match when the same block appears multiple times.',
            parameters: {
              type: Type.OBJECT,
              properties: {
                path: { type: Type.STRING, description: 'Relative path within your session workspace to the file to patch (e.g. "workspace_mirror/myproject/src/index.js").' },
                search: { type: Type.STRING, description: 'The exact text block to find in the file. Must match character-for-character.' },
                replace: { type: Type.STRING, description: 'The replacement text that will substitute the matched search block.' },
                occurrence: { type: Type.INTEGER, description: 'Which occurrence to replace when there are multiple matches (1-based, default 1).' }
              },
              required: ['path', 'search', 'replace']
            }
          },
          {
            name: 'execute_command',
            description: 'Spawns terminal actions asynchronously. Outputs write continuously inside logs. Returns a terminal_id and a relative log_file path you can read with read_file.',
            parameters: {
              type: Type.OBJECT,
              properties: {
                command: { type: Type.STRING, description: 'The terminal command to run.' },
                path: { type: Type.STRING, description: 'Relative path within your session workspace where the command should run (e.g. "workspace_mirror/myproject").' },
                name: { type: Type.STRING, description: 'An optional descriptive name for the terminal session.' }
              },
              required: ['command', 'path']
            }
          },
          {
            name: 'regex_search',
            description: 'Searches for a regular expression in file names or file contents within specified paths.',
            parameters: {
              type: Type.OBJECT,
              properties: {
                regexStr: { type: Type.STRING, description: 'The regular expression to search for.' },
                paths: { type: Type.ARRAY, items: { type: Type.STRING }, description: 'The paths to search within.' },
                options: {
                  type: Type.OBJECT,
                  properties: {
                    searchFileName: { type: Type.BOOLEAN, description: 'Whether to search in file names.' },
                    searchFileContent: { type: Type.BOOLEAN, description: 'Whether to search in file contents.' }
                  },
                  description: 'Search options.'
                }
              },
              required: ['regexStr', 'paths']
            }
          },
          {
            name: 'send_terminal_input',
            description: 'Sends keyboard input or ASCII/escape sequences to a running terminal session\'s stdin. Useful for answering interactive prompts (e.g. y/n), sending Enter, Escape, Ctrl+C to interrupt, Ctrl+D to signal EOF, or any arbitrary text. Supports standard escape sequences: \\n (Enter/newline), \\r (carriage return), \\t (tab), \\e or \\x1b (Escape key), \\x03 (Ctrl+C / SIGINT), \\x04 (Ctrl+D / EOF), and arbitrary hex/unicode via \\xHH or \\uHHHH.',
            parameters: {
              type: Type.OBJECT,
              properties: {
                terminal_id: { type: Type.STRING, description: 'The target terminal session ID returned from execute_command.' },
                input: { type: Type.STRING, description: 'The input string to write to terminal stdin. Supports escape sequences: \\n (newline/Enter), \\r (carriage return), \\t (tab), \\e or \\x1b (Escape), \\x03 (Ctrl+C), \\x04 (Ctrl+D), \\xHH (arbitrary hex byte), \\uHHHH (unicode codepoint).' }
              },
              required: ['terminal_id', 'input']
            }
          },
          {
            name: 'wait',
            description: 'Pauses active stream model turns for processing tasks.',
            parameters: {
              type: Type.OBJECT,
              properties: {
                seconds: { type: Type.INTEGER, description: 'Seconds count to pause.' }
              },
              required: ['seconds']
            }
          },
          {
            name: 'wait_terminal',
            description: 'Awaits complete background program outputs or logs.',
            parameters: {
              type: Type.OBJECT,
              properties: {
                terminal_id: { type: Type.STRING, description: 'Target terminal tracking process ID.' },
                timeout_seconds: { type: Type.INTEGER, description: 'Max check timeout seconds (Default 10).' }
              },
              required: ['terminal_id']
            }
          },
          {
            name: 'terminate_terminal',
            description: 'Immediately kills running terminal tasks.',
            parameters: {
              type: Type.OBJECT,
              properties: {
                terminal_id: { type: Type.STRING, description: 'Active terminal target ID.' }
              },
              required: ['terminal_id']
            }
          },
          {
            name: 'set_session_name',
            description: 'Renames the current active chat window title dynamically.',
            parameters: {
              type: Type.OBJECT,
              properties: {
                name: { type: Type.STRING, description: 'Fresh chat title string.' }
              },
              required: ['name']
            }
          },
          {
            name: 'parse_document',
            description: 'Converts a document (PDF, Word, Excel, PowerPoint, Text, HTML, CSV) to Markdown and extracts any embedded images. The output is saved in a subfolder inside the session folder, containing the markdown file and the extracted images.',
            parameters: {
              type: Type.OBJECT,
              properties: {
                filepath: { type: Type.STRING, description: 'Relative path within your session workspace to the document file (e.g. "uploads/abc_report.pdf").' },
                outputName: { type: Type.STRING, description: 'Optional custom name for the output folder and Markdown file. If not specified, the source file name (without extension) is used.' }
              },
              required: ['filepath']
            }
          },
          {
            name: 'view_image',
            description: 'Loads an image file (PNG, JPEG, WEBP, GIF, etc.) at the specified path and injects it directly inline into your multimodal context so you can see/inspect it directly.',
            parameters: {
              type: Type.OBJECT,
              properties: {
                path: { type: Type.STRING, description: 'Relative path within your session workspace to the image file (e.g. "uploads/abc_photo.png" or "workspace_mirror/myproject/assets/logo.svg").' }
              },
              required: ['path']
            }
          },
          {
            name: 'list_devices',
            description: 'Lists all available virtual or physical devices (e.g., adb android devices, local desktop environment, active browsers).',
            parameters: {
              type: Type.OBJECT,
              properties: {}
            }
          },
          {
            name: 'get_device_visuals',
            description: 'Captures the current visual display of the specified device. Returns both a raw screenshot and a screenshot overlayed with a high-contrast coordinate grid.',
            parameters: {
              type: Type.OBJECT,
              properties: {
                deviceId: { type: Type.STRING, description: 'The unique ID of the target device.' }
              },
              required: ['deviceId']
            }
          },
          {
            name: 'device_click',
            description: 'Performs a mouse click or screen tap on the specified device at the given coordinates.',
            parameters: {
              type: Type.OBJECT,
              properties: {
                deviceId: { type: Type.STRING, description: 'The unique ID of the target device.' },
                x: { type: Type.INTEGER, description: 'The X coordinate.' },
                y: { type: Type.INTEGER, description: 'The Y coordinate.' }
              },
              required: ['deviceId', 'x', 'y']
            }
          },
          {
            name: 'device_keyboard',
            description: 'Emulates keyboard input on the target device, typing text or sending key events.',
            parameters: {
              type: Type.OBJECT,
              properties: {
                deviceId: { type: Type.STRING, description: 'The unique ID of the target device.' },
                text: { type: Type.STRING, description: 'Text to type into the active input field.' }
              },
              required: ['deviceId', 'text']
            }
          },
          {
            name: 'device_swipe',
            description: 'Performs a swipe or drag gesture on the target device from a starting coordinate to an ending coordinate using a natural movement curve.',
            parameters: {
              type: Type.OBJECT,
              properties: {
                deviceId: { type: Type.STRING, description: 'The unique ID of the target device.' },
                fromX: { type: Type.INTEGER, description: 'Starting X coordinate.' },
                fromY: { type: Type.INTEGER, description: 'Starting Y coordinate.' },
                toX: { type: Type.INTEGER, description: 'Ending X coordinate.' },
                toY: { type: Type.INTEGER, description: 'Ending Y coordinate.' },
                duration: { type: Type.INTEGER, description: 'Duration of the swipe event in milliseconds (default 300).' }
              },
              required: ['deviceId', 'fromX', 'fromY', 'toX', 'toY']
            }
          },
          {
            name: 'device_navigate',
            description: 'Directs the target device to navigate to the specified URL.',
            parameters: {
              type: Type.OBJECT,
              properties: {
                deviceId: { type: Type.STRING, description: 'The unique ID of the target device.' },
                url: { type: Type.STRING, description: 'The URL to open/navigate to.' }
              },
              required: ['deviceId', 'url']
            }
          },
          {
            name: 'device_scroll',
            description: 'Emulates scrolling on the target device starting at a specific coordinate position.',
            parameters: {
              type: Type.OBJECT,
              properties: {
                deviceId: { type: Type.STRING, description: 'The unique ID of the target device.' },
                x: { type: Type.INTEGER, description: 'The X coordinate where the scroll starts (hover position).' },
                y: { type: Type.INTEGER, description: 'The Y coordinate where the scroll starts (hover position).' },
                deltaX: { type: Type.INTEGER, description: 'Horizontal scroll distance (positive: right, negative: left).' },
                deltaY: { type: Type.INTEGER, description: 'Vertical scroll distance (positive: down, negative: up).' }
              },
              required: ['deviceId', 'x', 'y', 'deltaX', 'deltaY']
            }
          }
        ]
      }
    ];

    const config = {
      tools,
      systemInstruction: dynamicInstruction
    };

    const model = 'gemma-4-31b-it';

    await initSessionGit(wsDir, sessionId);
    
    // Create sandbox mirror before running the stream
    try {
      await createWorkspaceMirror(workspaceId, sessionId);
    } catch (e) {
      console.error(`Failed to create workspace mirror:`, e.message);
    }

    const initialMessages = await loadSessionMessages(wsDir, sessionId);
    const initialCheckpointMsgId = initialMessages.reduce((max, m) => m.id > max ? m.id : max, 0);
    let checkpointMsgId = initialCheckpointMsgId;

    const runId = crypto.randomUUID();
    activeGenerations.set(sessionId, runId);

    const maxRetries = 10;
    let attempt = 0;
    let delay = 2000;
    let success = false;

    while (attempt < maxRetries && !success) {
      // Check if this run has been superseded before starting the attempt
      if (activeGenerations.get(sessionId) !== runId) {
        return;
      }
      attempt++;
      try {
        // Retrieve global database message history
        const historyRows = await loadSessionMessages(wsDir, sessionId);
        
        // Parse parts columns and apply turn trimming algorithms
        const fullHistory = [];
        for (const row of historyRows) {
          if (row.role === 'system') {
            continue;
          }
          const parsedParts = row.parts;
          const processedParts = [];
          const isOldHistory = row.id <= initialCheckpointMsgId;

          for (const part of parsedParts) {
            if (part._localFilePath) {
              // Do not send binary files (image, pdf, document) directly as base64 inlineData.
              // The prompt injection already contains the location of the file in workspace/session storage,
              // allowing the model to interact with it via tools (like parse_document) if needed.
            } else if (part.thought) {
              // Skip internal thought reasoning parts when sending history to Gemini API
            } else if (isOldHistory) {
              // For old history, only keep text parts (omit functionCall / functionResponse)
              if (part.text) {
                processedParts.push(part);
              }
            } else {
              // For the current turn (id > initialCheckpointMsgId), keep text, functionCall, and functionResponse
              processedParts.push(part);
            }
          }
          if (processedParts.length > 0) {
            fullHistory.push({
              role: row.role,
              parts: processedParts
            });
          }
        }
        
        const trimmedHistory = trimHistoryToLast100Turns(fullHistory);
        const contentStack = [];
        for (const turn of trimmedHistory) {
          if (contentStack.length > 0 && contentStack[contentStack.length - 1].role === turn.role) {
            contentStack[contentStack.length - 1].parts.push(...turn.parts);
          } else {
            contentStack.push(turn);
          }
        }

        // Mark session as active; clear any prior abort signal
        sessionAbortFlags.set(sessionId, false);

        let keepRunning = true;
        let lastModelMessageId = null;
        let isFirstTurn = true;

        while (keepRunning) {
          let modelMessageId = null;
          // Check if this run has been superseded
          if (activeGenerations.get(sessionId) !== runId) {
            return;
          }

          // Check for client-requested cancellation before each turn
          if (sessionAbortFlags.get(sessionId)) {
            break;
          }

          let responseStream;
          if (isFirstTurn) {
            let timeoutId;
            const timeoutPromise = new Promise((_, reject) => {
              timeoutId = setTimeout(() => reject(new Error('Gemini initial response timeout after 10s')), 10 * 1000);
            });

            const requestPromise = (async () => {
              const stream = await ai.models.generateContentStream({
                model,
                config,
                contents: [...contentStack, { role: 'user', parts: [{ text: "There was a glitch in the system. Continue your progress." }] }]
              });
              const iterator = stream[Symbol.asyncIterator]();
              const { value, done } = await iterator.next();
              return { stream, iterator, value, done };
            })();

            try {
              const { iterator, value, done } = await Promise.race([requestPromise, timeoutPromise]);
              clearTimeout(timeoutId);
              
              const wrappedStream = (async function* () {
                if (!done) yield value;
                for await (const chunk of { [Symbol.asyncIterator]: () => iterator }) {
                  yield chunk;
                }
              })();
              responseStream = wrappedStream;
              isFirstTurn = false;
            } catch (err) {
              clearTimeout(timeoutId);
              throw err;
            }
          } else {
            responseStream = await ai.models.generateContentStream({
              model,
              config,
              contents: contentStack,
            });
          }

          let assistantResponseParts = [];
          let pendingCalls = [];
          let mergedParts = [];

          for await (const chunk of responseStream) {
            // Check if this run has been superseded
            if (activeGenerations.get(sessionId) !== runId) {
              return;
            }

            // Successful generation chunk received - reset attempts and backoff delay
            attempt = 0;
            delay = 2000;

            // Extract parts directly from candidates to avoid the SDK "non-text parts" warning
            const parts = chunk.candidates?.[0]?.content?.parts || [];

            for (const part of parts) {
              // Check abort flag mid-stream
              if (sessionAbortFlags.get(sessionId)) {
                keepRunning = false;
                break;
              }

              let partAdded = false;
              if (part.thought && part.text) {
                assistantResponseParts.push({ thought: true, text: part.text });
                partAdded = true;
                sendToSession(sessionId, {
                  type: 'THOUGHT_STREAM',
                  text: part.text
                });
              } else if (part.text) {
                assistantResponseParts.push({ text: part.text });
                partAdded = true;
                sendToSession(sessionId, {
                  type: 'TOKEN_STREAM',
                  text: part.text
                });
              } else if (part.functionCall) {
                pendingCalls.push(part.functionCall);
                partAdded = true;
                sendToSession(sessionId, {
                  type: 'FUNCTION_CALL',
                  name: part.functionCall.name,
                  callId: part.functionCall.id,
                  args: part.functionCall.args
                });
              }

              if (partAdded) {
                // Keep accumulator matching live streams
                mergedParts = [];
                for (const p of assistantResponseParts) {
                  if (p.thought) {
                    mergedParts.push({ thought: true, text: p.text });
                  } else if (p.text) {
                    mergedParts.push({ text: p.text });
                  }
                }
                for (const fc of pendingCalls) {
                  mergedParts.push({ functionCall: { id: fc.id, name: fc.name, args: fc.args } });
                }

                const currentMessages = await loadSessionMessages(wsDir, sessionId);
                if (!modelMessageId) {
                  modelMessageId = currentMessages.reduce((max, m) => m.id > max ? m.id : max, 0) + 1;
                  lastModelMessageId = modelMessageId;
                  currentMessages.push({
                    id: modelMessageId,
                    role: 'model',
                    parts: mergedParts,
                    createdAt: new Date().toISOString()
                  });
                } else {
                  const idx = currentMessages.findIndex(m => m.id === modelMessageId);
                  if (idx !== -1) {
                    currentMessages[idx].parts = mergedParts;
                  }
                  lastModelMessageId = modelMessageId;
                }
                await saveSessionMessages(wsDir, sessionId, currentMessages);
              }
            }

            // If inner loop detected abort and set keepRunning to false, break the stream chunk loop
            if (!keepRunning) {
              break;
            }
          }

          if (pendingCalls.length > 0) {
            const toolResponseParts = [];
            const collectedInlineImages = [];
            let toolOutputMsgId = null;

            for (const call of pendingCalls) {
              // Check if this run has been superseded before running each tool
              if (activeGenerations.get(sessionId) !== runId) {
                return;
              }

              let toolResult;
              try {
                if (call.name === 'list_dir') {
                  toolResult = await listDirTool(workspaceId, sessionId, call.args?.path);
                } else if (call.name === 'read_file') {
                  toolResult = await readFileTool(workspaceId, sessionId, call.args?.path, call.args?.from_line, call.args?.to_line);
                } else if (call.name === 'write_file') {
                  toolResult = await writeFileTool(workspaceId, sessionId, call.args?.path, call.args?.content);
                } else if (call.name === 'edit_file') {
                  toolResult = await editFileTool(workspaceId, sessionId, call.args?.path, call.args?.search, call.args?.replace, call.args?.occurrence ?? 1);
                } else if (call.name === 'execute_command') {
                  toolResult = await executeCommandTool(workspaceId, sessionId, call.args?.command, call.args?.path, call.args?.name);
                } else if (call.name === 'regex_search') {
                  toolResult = await regexSearchTool(workspaceId, sessionId, call.args?.regexStr, call.args?.paths, call.args?.options);
                } else if (call.name === 'send_terminal_input') {
                  toolResult = await sendTerminalInputTool(call.args?.terminal_id, call.args?.input);
                } else if (call.name === 'wait') {
                  toolResult = await waitTool(call.args?.seconds);
                } else if (call.name === 'wait_terminal') {
                  toolResult = await waitTerminalTool(call.args?.terminal_id, call.args?.timeout_seconds);
                } else if (call.name === 'terminate_terminal') {
                  toolResult = await terminateTerminalTool(call.args?.terminal_id);
                } else if (call.name === 'set_session_name') {
                  toolResult = await setSessionNameTool(sessionId, call.args?.name);
                } else if (call.name === 'parse_document') {
                  toolResult = await parseDocumentTool(workspaceId, sessionId, call.args?.filepath, call.args?.outputName);
                } else if (call.name === 'view_image') {
                  toolResult = await viewImageTool(workspaceId, sessionId, call.args?.path);
                } else if (call.name === 'list_devices') {
                  toolResult = await deviceManager.listDevices();
                } else if (call.name === 'get_device_visuals') {
                  const adapter = deviceManager.getAdapter(call.args?.deviceId);
                  if (!adapter) {
                    toolResult = { error: `Device adapter not found for ID: ${call.args?.deviceId}` };
                  } else {
                    const rawBuffer = await adapter.getScreenshot();
                    const sideBySideBuffer = await createVisualGrid(rawBuffer);
                    toolResult = {
                      success: true,
                      message: "Screen captured successfully. Grid overlay has been injected into context.",
                      inlineImage: {
                        data: sideBySideBuffer.toString('base64'),
                        mimeType: 'image/png'
                      }
                    };
                  }
                } else if (call.name === 'device_click') {
                  const adapter = deviceManager.getAdapter(call.args?.deviceId);
                  if (!adapter) {
                    toolResult = { error: `Device adapter not found for ID: ${call.args?.deviceId}` };
                  } else {
                    await adapter.click(call.args?.x, call.args?.y);
                    toolResult = { success: true };
                  }
                } else if (call.name === 'device_keyboard') {
                  const adapter = deviceManager.getAdapter(call.args?.deviceId);
                  if (!adapter) {
                    toolResult = { error: `Device adapter not found for ID: ${call.args?.deviceId}` };
                  } else {
                    await adapter.type(call.args?.text);
                    toolResult = { success: true };
                  }
                } else if (call.name === 'device_swipe') {
                  const adapter = deviceManager.getAdapter(call.args?.deviceId);
                  if (!adapter) {
                    toolResult = { error: `Device adapter not found for ID: ${call.args?.deviceId}` };
                  } else {
                    await adapter.swipe(call.args?.fromX, call.args?.fromY, call.args?.toX, call.args?.toY, call.args?.duration || 300);
                    toolResult = { success: true };
                  }
                } else if (call.name === 'device_navigate') {
                  const adapter = deviceManager.getAdapter(call.args?.deviceId);
                  if (!adapter) {
                    toolResult = { error: `Device adapter not found for ID: ${call.args?.deviceId}` };
                  } else {
                    await adapter.navigate(call.args?.url);
                    toolResult = { success: true };
                  }
                } else if (call.name === 'device_scroll') {
                  const adapter = deviceManager.getAdapter(call.args?.deviceId);
                  if (!adapter) {
                    toolResult = { error: `Device adapter not found for ID: ${call.args?.deviceId}` };
                  } else {
                    await adapter.scroll(call.args?.x, call.args?.y, call.args?.deltaX, call.args?.deltaY);
                    toolResult = { success: true };
                  }
                } else {
                  toolResult = { error: `Tool execution logic targeting "${call.name}" is missing.` };
                }
              } catch (err) {
                toolResult = { error: `Internal crash inside tool execution pipeline: ${err.message}` };
              }

              if (toolResult && toolResult.inlineImage) {
                collectedInlineImages.push({
                  inlineData: {
                    data: toolResult.inlineImage.data,
                    mimeType: toolResult.inlineImage.mimeType
                  }
                });
                delete toolResult.inlineImage;
              }

              sendToSession(sessionId, {
                type: 'FUNCTION_RESPONSE',
                callId: call.id,
                response: { result: toolResult }
              });

              toolResponseParts.push({
                functionResponse: {
                  id: call.id,
                  name: call.name,
                  response: { result: toolResult }
                }
              });

              // Streamingly save the completed tool responses to the database immediately
              if (activeGenerations.get(sessionId) !== runId) {
                return;
              }

              const currentMessages = await loadSessionMessages(wsDir, sessionId);
              if (!toolOutputMsgId) {
                toolOutputMsgId = currentMessages.reduce((max, m) => m.id > max ? m.id : max, 0) + 1;
                currentMessages.push({
                  id: toolOutputMsgId,
                  role: 'user',
                  parts: toolResponseParts,
                  createdAt: new Date().toISOString()
                });
              } else {
                const idx = currentMessages.findIndex(m => m.id === toolOutputMsgId);
                if (idx !== -1) {
                  currentMessages[idx].parts = toolResponseParts;
                }
              }
              await saveSessionMessages(wsDir, sessionId, currentMessages);
            }

            // Save complete model message (with thoughts, text, and function calls) to database
            if (activeGenerations.get(sessionId) !== runId) {
              return;
            }

            const currentMessages = await loadSessionMessages(wsDir, sessionId);
            if (modelMessageId) {
              const idx = currentMessages.findIndex(m => m.id === modelMessageId);
              if (idx !== -1) {
                currentMessages[idx].parts = mergedParts;
              }
              lastModelMessageId = modelMessageId;
            } else {
              modelMessageId = currentMessages.reduce((max, m) => m.id > max ? m.id : max, 0) + 1;
              lastModelMessageId = modelMessageId;
              currentMessages.push({
                id: modelMessageId,
                role: 'model',
                parts: mergedParts,
                createdAt: new Date().toISOString()
              });
            }
            await saveSessionMessages(wsDir, sessionId, currentMessages);

            // Build clean in-memory model message parts for the next API call (excluding thoughts)
            const modelContentParts = [];
            for (const p of assistantResponseParts) {
              if (!p.thought && p.text) {
                modelContentParts.push({ text: p.text });
              }
            }
            for (const fc of pendingCalls) {
              modelContentParts.push({ functionCall: { id: fc.id, name: fc.name, args: fc.args } });
            }

            const modelFuncCallMsg = {
              role: 'model',
              parts: modelContentParts
            };
            contentStack.push(modelFuncCallMsg);

            const toolOutputMsg = {
              role: 'user',
              parts: toolResponseParts
            };
            contentStack.push(toolOutputMsg);

            if (collectedInlineImages.length > 0) {
              const paddingText = "padding for image";
              const synthModelMsg = {
                role: 'model',
                parts: [{ text: paddingText }]
              };
              contentStack.push(synthModelMsg);

              const synthUserMsg = {
                role: 'user',
                parts: collectedInlineImages
              };
              contentStack.push(synthUserMsg);
            }

            keepRunning = true;
            try {
              const currentMessages = await loadSessionMessages(wsDir, sessionId);
              checkpointMsgId = currentMessages.reduce((max, m) => m.id > max ? m.id : max, 0);
            } catch (e) {
              console.error(`Failed to update checkpointMsgId:`, e.message);
            }
          } else {
            keepRunning = false;
          }
        }

        // Finalize status only if this generation run is still active
        if (activeGenerations.get(sessionId) === runId) {
          // 1. Commit messages in session Git repository
          try {
            await commitSessionMessage(wsDir, sessionId, lastModelMessageId, 'model');
          } catch (e) {
            console.error(`Failed to commit session messages:`, e.message);
          }

          // 2. Commit and merge changes back to the real project folders
          try {
            await mergeMirrorChangesBack(workspaceId, sessionId, lastModelMessageId);
          } catch (e) {
            console.error(`Failed to merge mirror changes back:`, e.message);
            ws.send(JSON.stringify({
              type: 'ERROR',
              message: `Merge Conflict detected: ${e.message}. Please resolve the conflicts inside the files.`
            }));
          }

          // 3. Clean up the mirror workspace directory
          try {
            const mirrorBase = path.join(wsDir, 'sessions', sessionId, 'workspace_mirror');
            await fs.rm(mirrorBase, { recursive: true, force: true });
          } catch {}

          sendToSession(sessionId, { type: 'DONE', modelMessageId: lastModelMessageId });
          sessionAbortFlags.delete(sessionId);
          sessionStatus.set(sessionId, 'idle');
          activeGenerations.delete(sessionId);
        }
        success = true;
      } catch (error) {
        if (activeGenerations.get(sessionId) !== runId) {
          return; // Ignore errors from superseded runs
        }
        console.error(`Attempt ${attempt} of executeGeminiStream failed:`, error);
        if (error.cause) {
          console.error("Failure cause details:", error.cause);
        }

        // Roll back database changes from this attempt to restore correct conversation context
        try {
          const currentMessages = await loadSessionMessages(wsDir, sessionId);
          const rolledBack = currentMessages.filter(m => m.id <= checkpointMsgId);
          await saveSessionMessages(wsDir, sessionId, rolledBack);
        } catch (e) {
          console.error(`Failed to roll back messages in JSONL file:`, e.message);
        }

        const retryable = isRetryableError(error);

        if (!retryable || attempt >= maxRetries) {
          const finalErrMsg = error.message + (error.cause ? ` (Cause: ${error.cause.message || error.cause})` : '');
          
          // Save the final error state as a system message in the database history
          try {
            const currentMessages = await loadSessionMessages(wsDir, sessionId);
            currentMessages.push({
              id: checkpointMsgId + 1,
              role: 'system',
              parts: [{ text: finalErrMsg }],
              createdAt: new Date().toISOString()
            });
            await saveSessionMessages(wsDir, sessionId, currentMessages);
          } catch (e) {
            console.error(`Failed to append error system message:`, e.message);
          }

          // Clean up mirror on final failure
          try {
            const mirrorBase = path.join(wsDir, 'sessions', sessionId, 'workspace_mirror');
            await fs.rm(mirrorBase, { recursive: true, force: true });
          } catch {}

          // Send final failure ERROR to client
          sendToSession(sessionId, { 
            type: 'ERROR', 
            message: finalErrMsg 
          });
          sessionAbortFlags.delete(sessionId);
          sessionStatus.set(sessionId, 'idle');
          activeGenerations.delete(sessionId);
          throw error;
        }

        // Send retry status chunk to the client via special RETRYING info card payload
        sendToSession(sessionId, {
          type: 'RETRYING',
          attempt: attempt + 1,
          maxAttempts: maxRetries,
          delay: delay,
          message: error.message + (error.cause ? ` (Cause: ${error.cause.message || error.cause})` : '')
        });

        // Wait before retrying
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  } catch (error) {
    if (activeGenerations.get(sessionId) !== runId) {
      return;
    }
    console.error("Content generation failure:", error);
    if (error.cause) {
      console.error("Failure cause details:", error.cause);
    }
    const finalErrMsg = error.message + (error.cause ? ` (Cause: ${error.cause.message || error.cause})` : '');
    
    // Save the final error state as a system message in the database history
    await dbRun(
      "INSERT INTO messages (session_id, role, parts, created_at) VALUES (?, ?, ?, ?)",
      [sessionId, 'system', JSON.stringify([{ text: finalErrMsg }]), new Date().toISOString()]
    );

    sendToSession(sessionId, { 
      type: 'ERROR', 
      message: finalErrMsg 
    });
    sessionAbortFlags.delete(sessionId);
    sessionStatus.set(sessionId, 'idle');
    activeGenerations.delete(sessionId);
  }
}

const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (request, socket, head) => {
  const parsedUrl = new URL(request.url, `http://${request.headers.host}`);
  const pathname = parsedUrl.pathname;

  const matches = pathname.match(/^\/stream\/workspace\/([^/]+)\/session\/([^/]+)$/);
  
  if (matches) {
    wss.handleUpgrade(request, socket, head, (ws) => {
      ws.workspaceId = matches[1];
      ws.sessionId = matches[2];
      wss.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

wss.on('connection', (ws) => {
  console.log(`📡 WebSocket connected: Workspace ${ws.workspaceId}, Session ${ws.sessionId}`);

  // Track this socket for the session to support multi-tab streaming
  if (!sessionSockets.has(ws.sessionId)) {
    sessionSockets.set(ws.sessionId, new Set());
  }
  sessionSockets.get(ws.sessionId).add(ws);

  // Immediately inform the client if the session is currently generating
  ws.send(JSON.stringify({ 
    type: 'SESSION_STATUS', 
    status: sessionStatus.get(ws.sessionId) || 'idle' 
  }));

  ws.on('message', async (data) => {
    try {
      const payload = JSON.parse(data.toString());
      if (payload.type === 'USER_MESSAGE') {
        const prompt = payload.text;
        const apiKeyId = payload.apiKeyId;
        await executeGeminiStream(ws, ws.workspaceId, ws.sessionId, prompt, apiKeyId);
      } else if (payload.type === 'RETRY') {
        const { wsDir } = getWorkspacePaths(ws.workspaceId);
        const messages = await loadSessionMessages(wsDir, ws.sessionId);
        const lastUserMsg = messages.slice().reverse().find(m => m.role === 'user');
        if (lastUserMsg) {
          let prompt = lastUserMsg.parts[0]?.text || "";
          await executeGeminiStream(ws, ws.workspaceId, ws.sessionId, prompt, null);
        } else {
          ws.send(JSON.stringify({ type: 'ERROR', message: 'No user message history available to retry.' }));
        }
      } else if (payload.type === 'CANCEL') {
        // Signal the active stream to abort
        sessionAbortFlags.set(ws.sessionId, true);
        sendToSession(ws.sessionId, { type: 'DONE' });
      }
    } catch (err) {
      ws.send(JSON.stringify({ type: 'ERROR', message: `Payload exception: ${err.message}` }));
    }
  });

  ws.on('close', () => {
    console.log(`🔌 WebSocket disconnected: Session ${ws.sessionId}`);
    const sockets = sessionSockets.get(ws.sessionId);
    if (sockets) {
      sockets.delete(ws);
      if (sockets.size === 0) {
        sessionSockets.delete(ws.sessionId);
      }
    }
  });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`=======================================================`);
  console.log(`🚀 Gemini Workspace Hub Server running on port ${PORT}`);
  console.log(`📁 Local Workspace Explorer root: ${os.homedir()}`);
  console.log(`🔒 Persistent SQLite DB active: ./database.sqlite`);
  console.log(`⚙️ Running Background Terminal Enabled`);
  console.log(`=======================================================`);
});