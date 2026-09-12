export const GENERAL_CHAT_WORKSPACE = 'ws_general_chat';
export const GENERAL_CHAT_INSTRUCTION = 'You are a helpful conversational assistant. Answer the user directly in their language. Support questions, brainstorming, writing, coding explanations, and analysis of attached files or images. No project folder is linked to this conversation. Do not require a project folder for ordinary chat. Use tools only when they help fulfill the request. Do not create project plans or task files for ordinary conversation.';

export function createGeneralChatHandler({ dbRun, dbGet }) {
  return async (_req, res) => {
    try {
      const createdAt = new Date().toISOString();
      await dbRun('INSERT OR IGNORE INTO workspaces (id, name, folders_path, created_at) VALUES (?, ?, ?, ?)',
        [GENERAL_CHAT_WORKSPACE, 'General Chat', '[]', createdAt]);
      let session = await dbGet('SELECT id FROM sessions WHERE workspace_id = ? ORDER BY created_at DESC, id DESC LIMIT 1', [GENERAL_CHAT_WORKSPACE]);
      if (!session) {
        await dbRun('INSERT OR IGNORE INTO sessions (id, workspace_id, name, created_at) VALUES (?, ?, ?, ?)',
          ['sess_general_chat', GENERAL_CHAT_WORKSPACE, 'New conversation', createdAt]);
        session = { id: 'sess_general_chat' };
      }
      const workspace = await dbGet('SELECT * FROM workspaces WHERE id = ?', [GENERAL_CHAT_WORKSPACE]);
      res.json({ workspace: { ...workspace, folders_path: JSON.parse(workspace.folders_path) }, sessionId: session.id });
    } catch (error) { res.status(500).json({ error: error.message }); }
  };
}
