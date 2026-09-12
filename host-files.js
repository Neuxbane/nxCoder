import fs from 'node:fs/promises';
import path from 'node:path';
import { isWithinPath } from './workspace-paths.js';
import { createHash } from 'node:crypto';

export function validateExplorerPath(relativePath) {
  if (typeof relativePath === 'string') relativePath = relativePath.replace(/\\/g, '/');
  if (typeof relativePath !== 'string' || /^[a-z]:/i.test(relativePath) || path.posix.isAbsolute(relativePath) || relativePath.includes('\0') || relativePath.split('/').some(part => part === '..' || part.toLowerCase() === '.git')) {
    const error = new Error('Invalid workspace folder path');
    error.status = 400;
    throw error;
  }
  return relativePath.replace(/\/+$/, '');
}
const within = isWithinPath;

export async function readHostDirectory(root, relativePath = '') {
  relativePath = validateExplorerPath(relativePath);
  let entries;
  let directory;
  let canonicalRoot;
  try {
    canonicalRoot = await fs.realpath(root);
    directory = await fs.realpath(path.join(root, relativePath));
    if (!within(canonicalRoot, directory)) {
      const error = new Error('Folder link points outside this workspace');
      error.status = 403;
      throw error;
    }
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return [];
    throw error;
  }
  const items = [];
  for (const entry of entries) {
    if (entry.name === '.git') continue;
    const fullPath = path.posix.join(relativePath, entry.name);
    const physicalPath = path.join(directory, entry.name);
    try {
      let stat = await fs.lstat(physicalPath);
      if (stat.isSymbolicLink()) {
        try {
          const target = await fs.realpath(physicalPath);
          if (within(canonicalRoot, target)) stat = await fs.stat(physicalPath);
        } catch (_) { /* A broken link remains visible as a file. */ }
      }
      items.push({ name: entry.name, fullPath, type: stat.isDirectory() ? 'directory' : 'file', size: stat.isDirectory() ? 0 : stat.size, modifiedAt: stat.mtime.toISOString(), isDeleted: false });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return items.sort((a, b) => a.name.localeCompare(b.name));
}

export function mergeHostAndHistory(liveItems, historyPaths, relativePath = '') {
  relativePath = validateExplorerPath(relativePath);
  const prefix = relativePath ? relativePath + '/' : '';
  const children = new Map();
  for (const historicalPath of historyPaths) {
    if (!historicalPath.startsWith(prefix)) continue;
    const parts = historicalPath.slice(prefix.length).split('/');
    if (!parts[0] || parts[0] === '.git') continue;
    const existing = children.get(parts[0]);
    const type = parts.length > 1 || existing?.type === 'directory' ? 'directory' : 'file';
    children.set(parts[0], { name: parts[0], fullPath: prefix + parts[0], type, isDeleted: true, size: 0, modifiedAt: null });
  }
  for (const item of liveItems) children.set(item.name, item);
  return [...children.values()];
}

export function directoryRevision(items) {
  return createHash('sha256').update(JSON.stringify(items)).digest('hex');
}

export async function readHostFile(root, relativePath, limit = 2 * 1024 * 1024) {
  relativePath = validateExplorerPath(relativePath);
  const canonicalRoot = await fs.realpath(root);
  const target = await fs.realpath(path.join(root, relativePath));
  if (!within(canonicalRoot, target)) {
    const error = new Error('File link points outside this workspace');
    error.status = 403;
    throw error;
  }
  // Nonblocking open avoids waiting on named pipes; only regular files are previewed.
  const { constants } = await import('node:fs');
  const file = await fs.open(target, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw Object.assign(new Error('Only regular files can be previewed'), { status: 400 });
    if (stat.size > limit) throw Object.assign(new Error('Preview supports text files up to 2 MB'), { status: 413 });
    const buffer = Buffer.alloc(limit + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > limit) throw Object.assign(new Error('Preview supports text files up to 2 MB'), { status: 413 });
    const data = buffer.subarray(0, size);
    let content;
    try {
      if (data.includes(0)) throw new Error('Binary file');
      content = new TextDecoder('utf-8', { fatal: true }).decode(data);
    } catch (_) {
      throw Object.assign(new Error('Preview is available for UTF-8 text and source code files. This file is binary or uses another encoding.'), { status: 415 });
    }
    return { content, size, modifiedAt: stat.mtime.toISOString() };
  } finally { await file.close(); }
}
