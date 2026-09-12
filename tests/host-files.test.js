import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readHostDirectory, directoryRevision } from '../host-files.js';
import { createSourceFilesHandler } from '../source-files.js';
const run = promisify(execFile);

test('explorer reads host changes without commits and preserves deleted file history', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nx-host-files-'));
  const repo = { realPath: root, gitDir: path.join(root, '.git'), folderName: 'project', hashedName: 'test' };
  const git = async (_, args) => run('git', ['--literal-pathspecs', ...args], { cwd: root });
  const handler = createSourceFilesHandler({ getGitReposForWorkspace: async () => [repo], execGit: git, getPathHistorySize: async () => 10 });
  const request = async (folder, snapshot = false) => {
    let body, status = 200, cache;
    const res = { set: (key, value) => { cache = value; }, status: value => { status = value; return res; }, json: value => { body = value; } };
    await handler({ params: { id: 'test' }, query: { path: folder, snapshot: snapshot ? '1' : '' } }, res);
    return { body, status, cache };
  };
  try {
    await fs.writeFile(path.join(root, 'uncommitted.txt'), 'host data');
    await fs.mkdir(path.join(root, 'empty-folder'));
    let result = await request('project');
    assert.equal(result.status, 200);
    assert.equal(result.cache, 'no-store');
    assert.deepEqual(result.body.items.map(i => i.name).sort(), ['empty-folder', 'uncommitted.txt']);
    assert.equal(result.body.items.find(i => i.name === 'uncommitted.txt').historyCount, 0);
    const revision = result.body.revision;
    await fs.rename(path.join(root, 'uncommitted.txt'), path.join(root, 'renamed.txt'));
    assert.notEqual((await request('project', true)).body.revision, revision);
    await git(repo, ['init']);
    await git(repo, ['add', 'renamed.txt']);
    await git(repo, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture']);
    await fs.unlink(path.join(root, 'renamed.txt'));
    const hostileName = `quote'"<&$() file.txt`;
    await fs.writeFile(path.join(root, hostileName), 'new file');
    result = await request('project');
    assert.ok(result.body.items.find(i => i.name === 'renamed.txt' && i.isDeleted && i.historyCount === 1));
    assert.ok(result.body.items.find(i => i.name === hostileName && !i.isDeleted));
    assert.equal(result.body.items.some(i => i.name === '.git'), false);
    assert.equal((await request('project/../outside')).status, 400);
    assert.equal((await request('project/.git')).status, 400);
    await fs.writeFile(path.join(root, 'empty-folder', 'nested.txt'), 'nested');
    assert.equal((await request('project/empty-folder/')).body.items[0].name, 'nested.txt');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('snapshot changes on file modification and blocks external symlink traversal', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nx-host-links-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'nx-host-outside-'));
  try {
    await fs.writeFile(path.join(root, 'file'), 'one');
    const first = directoryRevision(await readHostDirectory(root));
    await fs.writeFile(path.join(root, 'file'), 'a longer update');
    assert.notEqual(directoryRevision(await readHostDirectory(root)), first);
    await fs.symlink(outside, path.join(root, 'external'), 'dir');
    await assert.rejects(readHostDirectory(root, 'external'), e => e.status === 403);
    await fs.mkdir(path.join(root, 'nested'));
    await fs.symlink(path.join(root, 'nested'), path.join(root, 'internal'), 'dir');
    assert.deepEqual(await readHostDirectory(root, 'internal'), []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test('file preview reads exact text and rejects binary, oversized and external files', async () => {
  const { readHostFile } = await import('../host-files.js');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nx-preview-'));
  try {
    const content = '<script>not executed</script>\nHello 世界\n';
    await fs.writeFile(path.join(root, 'code.txt'), content);
    assert.equal((await readHostFile(root, 'code.txt')).content, content);
    await fs.writeFile(path.join(root, 'empty'), '');
    assert.equal((await readHostFile(root, 'empty')).content, '');
    await fs.writeFile(path.join(root, 'binary'), Buffer.from([0, 1, 2]));
    await assert.rejects(readHostFile(root, 'binary'), e => e.status === 415);
    await assert.rejects(readHostFile(root, 'code.txt', 4), e => e.status === 413);
    await assert.rejects(readHostFile(root, '../outside'), e => e.status === 400);
    await fs.symlink(os.tmpdir(), path.join(root, 'outside'), 'dir');
    await assert.rejects(readHostFile(root, 'outside'), e => e.status === 403);
    await assert.rejects(readHostFile(root, 'missing'), e => e.code === 'ENOENT');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
