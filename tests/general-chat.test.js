import test from 'node:test';
import assert from 'node:assert/strict';
import sqlite3 from 'sqlite3';
import { createGeneralChatHandler, GENERAL_CHAT_WORKSPACE } from '../general-chat.js';

test('standalone chat persists without folders and resumes latest session', async () => {
  const db = new sqlite3.Database(':memory:');
  const dbRun = (sql, params = []) => new Promise((resolve, reject) => db.run(sql, params, error => error ? reject(error) : resolve()));
  const dbGet = (sql, params = []) => new Promise((resolve, reject) => db.get(sql, params, (error, row) => error ? reject(error) : resolve(row)));
  try {
    await dbRun('CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT, folders_path TEXT, created_at TEXT)');
    await dbRun('CREATE TABLE sessions (id TEXT PRIMARY KEY, workspace_id TEXT, name TEXT, created_at TEXT)');
    const handler = createGeneralChatHandler({ dbRun, dbGet });
    const call = async () => {
      let result;
      await handler({}, { json(value) { result = value; }, status(code) { throw new Error(String(code)); } });
      return result;
    };
    const first = await call();
    assert.deepEqual(first.workspace.folders_path, []);
    assert.equal(first.workspace.id, GENERAL_CHAT_WORKSPACE);
    assert.equal((await call()).sessionId, first.sessionId);
    assert.equal((await dbGet('SELECT count(*) AS count FROM workspaces')).count, 1);
    await dbRun('INSERT INTO sessions VALUES (?, ?, ?, ?)', ['another', GENERAL_CHAT_WORKSPACE, 'Follow-up', '2099-01-01']);
    assert.equal((await call()).sessionId, 'another');
  } finally { await new Promise(resolve => db.close(resolve)); }
});
