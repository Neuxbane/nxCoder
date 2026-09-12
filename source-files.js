import fs from 'node:fs/promises';
import { readHostFile, readHostDirectory, mergeHostAndHistory, directoryRevision, validateExplorerPath } from './host-files.js';

export function createSourceFilesHandler({ getGitReposForWorkspace, execGit, getPathHistorySize }) {
  return async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const targetPath = validateExplorerPath(req.query.path || '');
      const repos = await getGitReposForWorkspace(req.params.id);
      const snapshotOnly = req.query.snapshot === '1';
      let items;
      let revision;
      if (!targetPath) {
        items = await Promise.all(repos.map(async repo => {
          let stat;
          try { stat = await fs.stat(repo.realPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
          return { name: repo.folderName, path: repo.folderName, type: 'directory', isDeleted: !stat, modifiedAt: stat?.mtime.toISOString() || null, size: 0, historyCount: 0, historySize: 0, lastUpdate: 'Unknown', repoHash: repo.hashedName };
        }));
        revision = directoryRevision(items);
        if (snapshotOnly) return res.json({ revision });
        for (const item of items) {
          const repo = repos.find(repo => repo.hashedName === item.repoHash);
          try {
            const { stdout } = await execGit(repo, ['log', '--oneline']);
            item.historyCount = stdout.trim().split('\n').filter(Boolean).length;
            const { stdout: update } = await execGit(repo, ['log', '-1', '--format=%cd (%s)', '--date=relative']);
            item.lastUpdate = update.trim() || 'Unknown';
            item.historySize = await getPathHistorySize(repo, '');
          } catch (_) {}
        }
      } else {
        const [folderName, ...parts] = targetPath.split('/');
        const relativePath = parts.join('/');
        const repo = repos.find(repo => repo.folderName === folderName);
        if (!repo) return res.status(404).json({ error: 'Workspace folder not found' });
        const liveItems = await readHostDirectory(repo.realPath, relativePath);
        revision = directoryRevision(liveItems);
        if (snapshotOnly) return res.json({ revision });
        let historyPaths = [];
        try {
          const { stdout } = await execGit(repo, ['log', '--pretty=format:', '--name-only', '-z', '--all']);
          historyPaths = [...new Set(stdout.split('\0').map(value => value.replace(/^\n+/, '')).filter(Boolean))];
        } catch (_) { /* Host files remain browsable before the first commit. */ }
        items = [];
        for (const item of mergeHostAndHistory(liveItems, historyPaths, relativePath)) {
          let historyCount = 0;
          let lastUpdate = 'Not committed';
          let historySize = 0;
          try {
            const { stdout } = await execGit(repo, ['log', '--oneline', '--', item.fullPath]);
            historyCount = stdout.trim().split('\n').filter(Boolean).length;
            if (historyCount) {
              const { stdout: update } = await execGit(repo, ['log', '-1', '--format=%cd (%s)', '--date=relative', '--', item.fullPath]);
              lastUpdate = update.trim() || 'Unknown';
              historySize = await getPathHistorySize(repo, item.fullPath);
            }
          } catch (_) {}
          items.push({ ...item, path: folderName + '/' + item.fullPath, historyCount, lastUpdate, historySize, repoHash: repo.hashedName });
        }
      }
      res.json({ items, revision });
    } catch (error) {
      res.status(error.status || (error.code === 'EACCES' ? 403 : 500)).json({ error: error.message });
    }
  };
}

export function createFilePreviewHandler({ getGitReposForWorkspace }) {
  return async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const filePath = validateExplorerPath(req.query.path || '');
      const [folderName, ...parts] = filePath.split('/');
      const repos = await getGitReposForWorkspace(req.params.id);
      const repo = repos.find(repo => repo.folderName === folderName);
      if (!repo || !parts.length) return res.status(404).json({ error: 'Workspace file not found' });
      const file = await readHostFile(repo.realPath, parts.join('/'));
      res.json({ ...file, path: filePath });
    } catch (error) {
      res.status(error.status || (error.code === 'ENOENT' ? 404 : error.code === 'EACCES' ? 403 : 500)).json({ error: error.code === 'ENOENT' ? 'File no longer exists on the host' : error.message });
    }
  };
}
