import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { isWithinPath, normalizeSandboxPath, directoryLinkType, workspaceFolderName } from '../workspace-paths.js';
import { validateExplorerPath } from '../host-files.js';
import '../assets/host-paths.js';

const { normalize, parent } = globalThis.hostPaths;
test('browser paths retain Windows drive and UNC roots', () => {
  assert.equal(normalize('C:\\Users\\Dev\\'), 'C:/Users/Dev');
  assert.equal(normalize('C:\\'), 'C:/');
  assert.equal(normalize('\\\\server\\share\\project'), '//server/share/project');
  for (const [input, expected] of [
    ['C:/Users/Dev', 'C:/Users'], ['C:/Users', 'C:/'], ['C:/', 'C:/'],
    ['//server/share/project', '//server/share'], ['//server/share', '//server/share'],
    ['/home/dev', '/home'], ['/home', '/'], ['/', '/']
  ]) assert.equal(parent.call(globalThis.hostPaths, input), expected);
});

test('containment handles drive changes, case and sibling prefixes on Windows', () => {
  assert.equal(isWithinPath('C:\\Project', 'c:\\project\\src\\a.js', path.win32), true);
  assert.equal(isWithinPath('C:\\Project', 'C:\\Project-other\\a.js', path.win32), false);
  assert.equal(isWithinPath('C:\\Project', 'D:\\Project\\a.js', path.win32), false);
  assert.equal(isWithinPath('\\\\server\\share\\project', '\\\\server\\other\\a.js', path.win32), false);
  assert.equal(directoryLinkType('win32'), 'junction');
  assert.equal(directoryLinkType('linux'), 'dir');
});

test('virtual workspace paths accept separators but reject host paths and traversal', () => {
  assert.equal(validateExplorerPath('project\\src\\a.js'), 'project/src/a.js');
  for (const input of ['project\\..\\secret', 'project\\.GIT\\config', 'C:\\Users', 'C:secret', '\\\\server\\share']) {
    assert.throws(() => validateExplorerPath(input));
  }
  assert.equal(normalizeSandboxPath('workspace_mirror\\project\\a.js'), 'workspace_mirror/project/a.js');
  assert.equal(normalizeSandboxPath('/artifact/file.md'), 'artifact/file.md');
  for (const input of ['C:\\Users\\a', 'C:relative', '\\\\server\\share', '/uploads-other/a']) assert.throws(() => normalizeSandboxPath(input));
});

test('drive root mapping has a nonempty folder name', () => {
  assert.equal(workspaceFolderName('C:\\', path.win32), 'C');
  assert.equal(workspaceFolderName('D:\\Projects\\app', path.win32), 'app');
  assert.equal(workspaceFolderName('/', path.posix), 'root');
});
