import path from 'node:path';

export function isWithinPath(root, target, paths = path) {
  const relative = paths.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + paths.sep) && !paths.isAbsolute(relative));
}

export function normalizeSandboxPath(value) {
  if (typeof value !== 'string' || value.includes('\0')) throw new Error('Invalid workspace path');
  const normalized = value.trim().replace(/\\/g, '/');
  if (/^[a-z]:/i.test(normalized) || normalized.startsWith('//')) throw new Error('Use a relative workspace path, not a drive or network path');
  if (normalized.startsWith('/') && !/^\/(workspace_mirror|uploads|artifact|scratchpad|terminals)(\/|$)/.test(normalized)) throw new Error('Use a relative workspace path');
  return normalized.replace(/^\/+/, '');
}

export const directoryLinkType = (platform = process.platform) => platform === 'win32' ? 'junction' : 'dir';

export function workspaceFolderName(folder, paths = path) {
  const resolved = paths.resolve(folder);
  return paths.basename(resolved) || (paths.parse(resolved).root.replace(/[:\\/]+/g, '') || 'root');
}
