// Host paths may come from a Windows server even when the browser runs elsewhere.
globalThis.hostPaths = {
  normalize(value) {
    const input = String(value || '').trim().replace(/\\/g, '/');
    const unc = input.startsWith('//');
    let normalized = input.replace(/\/+/g, '/');
    if (unc) normalized = '/' + normalized;
    if (/^[a-z]:\/?$/i.test(normalized)) return normalized.slice(0, 2) + '/';
    return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized;
  },
  parent(value) {
    const current = this.normalize(value);
    if (!current || current === '/' || /^[a-z]:\/$/i.test(current) || /^\/\/[^/]+\/[^/]+$/.test(current)) return current;
    const index = current.lastIndexOf('/');
    return index < 0 ? '' : this.normalize(current.slice(0, index) || '/');
  }
};
