import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import puppeteer from 'puppeteer';
import { SessionEvents } from '../session-events.js';

const root = path.resolve(import.meta.dirname, '..');
test('session status, replay, drafts and delivery failures', { timeout: 60000 }, async () => {
  const log = new SessionEvents();
  const calls = [];
  let rejectPost = false;
  let sourceRevision = 0;
  let sourceItems = [];
  let sourceRequests = 0;
  const history = [
    { id: 1, role: 'model', createdAt: '2026-01-01T00:00:00Z', parts: [
      { functionCall: { id: 'duplicate', name: 'list_dir', args: {} } },
      { functionCall: { id: 'duplicate', name: 'list_dir', args: {} } }
    ] },
    { id: 2, role: 'user', createdAt: '2026-01-01T00:00:02Z', parts: [{ functionResponse: { id: 'duplicate', response: { result: { error: 'Permission denied' } } } }] }
  ];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    res.setHeader('Content-Type', 'application/json');
    if (url.pathname.startsWith('/api/')) {
      if (url.pathname === '/api/general-chat') return res.end(JSON.stringify({ workspace: { id: 'ws_general_chat', name: 'General Chat', folders_path: [] }, sessionId: 's1' }));
      if (req.method === 'POST') { calls.push('POST'); res.statusCode = rejectPost ? 500 : 200; return res.end(JSON.stringify({ messageId: 3 })); }
      if (url.pathname.endsWith('/source-control/preview')) return res.end(JSON.stringify({ content: '<script>window.previewExecuted=true</script>\nconst value = 42;\n', size: 64 }));
      if (url.pathname.endsWith('/source-control/files')) { sourceRequests++; return res.end(JSON.stringify({ items: sourceItems, revision: String(sourceRevision) })); }
      if (url.pathname === '/api/workspace') return res.end(JSON.stringify([{ id: 'ws-test', name: 'Test project', folders_path: ['/fixture'] }]));
      if (/\/session$/.test(url.pathname)) return res.end(JSON.stringify([{ id: 's1', name: 'First session' }, { id: 's2', name: 'Second session' }]));
      if (/\/branches$/.test(url.pathname)) return res.end('{}');
      if (/\/session\/s[12]$/.test(url.pathname)) return res.end(JSON.stringify({ sessionHistory: history, engine: { providerId: 'ollama', providerName: 'Ollama', model: 'test-local' }, wsURL: `ws://127.0.0.1:${server.address().port}/stream${url.pathname}` }));
      return res.end('[]');
    }
    try {
      const file = path.join(root, url.pathname === '/' ? 'index.html' : url.pathname);
      res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.html') ? 'text/html' : 'application/octet-stream');
      res.end(await fs.readFile(file));
    } catch { res.statusCode = 404; res.end(); }
  });
  const wss = new WebSocketServer({ server });
  let socket;
  let connectionCount = 0;
  wss.on('connection', (ws, req) => {
    connectionCount++; socket = ws;
    const url = new URL(req.url, 'http://localhost');
    const key = url.pathname.endsWith('s2') ? 's2' : 's1';
    const resume = url.searchParams.get('resume');
    if (resume) {
      const replay = log.replay(key, JSON.parse(resume));
      if (!replay) { ws.send(JSON.stringify({ type: 'RESYNC_REQUIRED' })); ws.close(); return; }
      for (const event of replay) ws.send(JSON.stringify(event));
    }
    ws.send(JSON.stringify({ type: 'STREAM_CURSOR', cursor: log.cursor(key) }));
    ws.send(JSON.stringify({ type: 'SESSION_STATUS', status: 'idle', approvals: [] }));
    ws.on('message', message => calls.push(JSON.parse(message).type));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage();
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: 'networkidle2' });
    await page.waitForFunction(() => state.activeWorkspaceId === 'ws_general_chat' && state.activeSessionId === 's1');
    assert.equal(await page.$eval('#sidebar-active-ws-name', el => el.textContent), 'General Chat');
    assert.equal(await page.$eval('#chat-instruction-selector', el => el.options[0].textContent), 'General assistant');
    await page.evaluate(() => navigateToWorkspaceSession('ws-test', 's1'));
    await page.waitForFunction(() => document.querySelector('#conn-indicator').textContent === 'LIVE INTERACTIVE');
    assert.equal(await page.$eval('#session-running-model', el => el.textContent), 'Ollama · test-local');
    socket.send(JSON.stringify(log.append('s1', { type: 'ENGINE_CHANGED', engine: { providerId: 'gemini', providerName: 'Google Gemini', model: 'configured-model' } })));
    await page.waitForFunction(() => document.querySelector('#session-running-model').textContent === 'Google Gemini · configured-model');
    assert.equal(await page.$$eval('[data-call-id="duplicate"]', els => els.length), 1);
    assert.match(await page.$eval('[data-call-id="duplicate"] .status-marker', el => el.textContent), /Failed · 2.0s/);
    await page.type('#chat-prompt-input', 'Draft for first session');
    await page.evaluate(() => initializeSession('s2'));
    assert.equal(await page.$eval('#chat-prompt-input', el => el.value), '');
    await page.type('#chat-prompt-input', 'Second draft');
    await page.evaluate(() => initializeSession('s1'));
    assert.equal(await page.$eval('#chat-prompt-input', el => el.value), 'Draft for first session');
    await page.waitForFunction(() => document.querySelector('#conn-indicator').textContent === 'LIVE INTERACTIVE');
    const event = log.append('s1', { type: 'FUNCTION_CALL', callId: 'live', name: 'list_dir', args: {} });
    socket.send(JSON.stringify(event));
    await page.waitForSelector('[data-call-id="live"]');
    socket.terminate();
    log.append('s1', { type: 'FUNCTION_RESPONSE', callId: 'live', response: { result: { success: true } } });
    log.append('s1', { type: 'DONE' });
    await page.waitForFunction(() => document.querySelector('#conn-indicator').textContent === 'RECONNECTING');
    await page.evaluate(() => submitActivePrompt());
    assert.deepEqual(calls, [], 'offline submission must not POST or activate a task');
    await page.waitForFunction(() => document.querySelector('[data-call-id="live"]')?.dataset.toolState === 'completed');
    assert.deepEqual(calls, [], 'reconnection must not send USER_MESSAGE or RETRY');
    assert.equal(await page.$$eval('[data-call-id="live"]', els => els.length), 1);
    // Delayed duplicate events must be ignored by their cursor.
    socket.send(JSON.stringify(event));
    await new Promise(r => setTimeout(r,100));
    assert.equal(await page.$$eval('[data-call-id="live"]', els => els.length), 1);
    // A stop request stays pending until the server confirms completion.
    await page.evaluate(() => {
      processWebSocketGatewayPayload({ type: 'TOKEN_STREAM', text: 'Working' });
      cancelActiveGeneration();
    });
    await page.waitForFunction(() => document.querySelector('#btn-chat-stop').disabled);
    assert.equal(await page.evaluate(() => state.isGenerating), true);
    socket.send(JSON.stringify(log.append('s1', { type: 'DONE', cancelled: true })));
    await page.waitForFunction(() => !state.isGenerating);
    assert.deepEqual(calls, ['CANCEL']);
    calls.length = 0;
    rejectPost = true;
    await page.evaluate(() => { submitActivePrompt(); submitActivePrompt(); });
    await page.waitForFunction(() => document.querySelector('#chat-prompt-input').value === 'Draft for first session');
    assert.deepEqual(calls, ['POST'], 'a rejected POST must not activate generation');
    await page.reload({ waitUntil: 'networkidle2' });
    await page.evaluate(() => navigateToWorkspaceSession('ws-test', 's1'));
    assert.equal(await page.$eval('#chat-prompt-input', el => el.value), 'Draft for first session');
    await page.waitForFunction(() => document.querySelector('#conn-indicator').textContent === 'LIVE INTERACTIVE');
    // A server restart discards the replay journal. Reload history without resending work.
    log.sessions.clear();
    socket.terminate();
    await page.waitForFunction(() => document.querySelector('#conn-indicator').textContent === 'RECONNECTING');
    await page.waitForFunction(() => document.querySelector('#conn-indicator').textContent === 'LIVE INTERACTIVE');
    assert.equal(await page.$eval('#chat-prompt-input', el => el.value), 'Draft for first session');
    assert.deepEqual(calls, ['POST']);
    await page.setViewport({ width: 1440, height: 1000 });
    await page.evaluate(() => { window.detailTestSocket = state.wsConn; window.detailTestChat = document.querySelector('#session-chat-container').innerHTML; });
    await page.evaluate(() => toggleSourceControlView(true));
    assert.equal(await page.evaluate(() => !document.querySelector('#chat-interface-wrapper').classList.contains('hidden') && state.wsConn === window.detailTestSocket), true);
    assert.equal(await page.$eval('#source-control-container', el => el.parentElement.id), 'right-drawer-body');
    await new Promise(r => setTimeout(r, 350));
    assert.equal(await page.evaluate(() => document.querySelector('.session-main').getBoundingClientRect().right <= document.querySelector('#session-right-drawer').getBoundingClientRect().left), true);

    await page.waitForFunction(() => document.querySelector('#source-control-content').textContent.includes('This folder is empty.'));
    const unusualName = `new '"<& file.txt`;
    sourceItems = [{ name: unusualName, path: 'project/' + unusualName, type: 'file', historyCount: 0, lastUpdate: 'Not committed', size: 12, historySize: 0, repoHash: 'fixture' }];
    sourceRevision++;
    await page.waitForFunction(name => document.querySelector('#source-control-content').textContent.includes(name), {}, unusualName);
    assert.equal(await page.$$eval('#source-control-content tbody tr', rows => rows.length), 1);
    await page.click('.file-preview-trigger');
    await page.waitForFunction(() => !document.querySelector('#file-preview-copy').disabled);
    assert.equal(await page.$eval('#file-preview-content', el => el.readOnly), true);
    assert.equal(await page.evaluate(() => window.previewExecuted), undefined);
    const previewText = await page.$eval('#file-preview-content', el => el.value);
    await page.click('#file-preview-select');
    assert.equal(await page.$eval('#file-preview-content', el => el.selectionEnd - el.selectionStart), previewText.length);
    await page.keyboard.type('must not edit');
    assert.equal(await page.$eval('#file-preview-content', el => el.value), previewText);
    await browser.defaultBrowserContext().overridePermissions(`http://127.0.0.1:${server.address().port}`, ['clipboard-read', 'clipboard-write', 'clipboard-sanitized-write']);
    await page.click('#file-preview-copy');
    await page.waitForFunction(() => document.querySelector('#file-preview-status').textContent === 'Copied to clipboard');
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), previewText);
    await page.$eval('#file-preview-content', el => { el.focus(); el.setSelectionRange(8, 14); });
    await page.click('#file-preview-copy');
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), previewText.slice(8, 14));
    await page.$eval('#file-preview-content', el => { el.focus(); el.setSelectionRange(4, 4); });
    await page.click('#file-preview-copy');
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), previewText);
    await page.evaluate(() => {
      window.originalClipboardWrite = navigator.clipboard.writeText;
      navigator.clipboard.writeText = async () => { throw new Error('Clipboard unavailable'); };
      const content = document.getElementById('file-preview-content');
      content.focus();
      content.setSelectionRange(8, 14);
    });
    await page.click('#file-preview-copy');
    await page.waitForFunction(() => document.querySelector('#file-preview-status').textContent.includes('Press Ctrl+C'));
    assert.deepEqual(await page.$eval('#file-preview-content', el => [el.selectionStart, el.selectionEnd]), [8, 14]);
    await page.evaluate(() => { navigator.clipboard.writeText = window.originalClipboardWrite; });
    await page.keyboard.press('Escape');
    assert.equal(await page.$eval('#file-preview-dialog', el => el.open), false);
    sourceItems = [];
    sourceRevision++;
    await page.waitForFunction(() => document.querySelector('#source-control-content').textContent.includes('This folder is empty.'));
    await page.evaluate(() => toggleArtifactsView(true));
    assert.equal(await page.$eval('#artifacts-container', el => el.parentElement.id), 'right-drawer-body');
    assert.equal(await page.$eval('#source-control-container', el => el.classList.contains('hidden')), true);
    await page.evaluate(() => toggleAgentProfilesView(true));
    assert.equal(await page.$eval('#agent-profiles-container', el => el.parentElement.id), 'right-drawer-body');
    await page.evaluate(() => openWorkspaceFolderViewer());
    assert.equal(await page.$eval('#right-drawer-title', el => el.textContent), 'Directory Browser');
    assert.equal(await page.$eval('#chat-interface-wrapper', el => el.classList.contains('hidden')), false);
    await page.evaluate(() => openEditWorkspacePanel('ws-test'));
    assert.equal(await page.$eval('#view-edit-workspace', el => el.parentElement.id), 'right-drawer-body');
    assert.equal(await page.evaluate(() => state.view), 'session');
    await page.setViewport({ width: 390, height: 844 });
    await new Promise(r => setTimeout(r, 350));
    assert.equal(await page.evaluate(() => {
      const chat = document.querySelector('.session-main').getBoundingClientRect();
      const details = document.querySelector('#session-right-drawer').getBoundingClientRect();
      return chat.bottom <= details.top && chat.height > 0 && details.height > 0;
    }), true);
    await page.click('#btn-edit-ws-back');
    assert.equal(await page.$eval('#view-edit-workspace', el => el.parentElement.tagName), 'MAIN');
    assert.equal(await page.evaluate(() => state.wsConn === window.detailTestSocket && document.querySelector('#session-chat-container').innerHTML === window.detailTestChat), true);
    assert.equal(await page.$eval('#chat-prompt-input', el => el.value), 'Draft for first session');
    // Both the original tabbed split panel and the new drawer use the live explorer.
    await page.setViewport({ width: 1440, height: 1000 });
    await page.evaluate(() => toggleSourceControlSplitPanel(true));
    await page.waitForFunction(() => document.querySelector('#source-control-content').textContent.includes('This folder is empty.'));
    assert.equal(await page.$eval('#source-control-container', el => el.closest('#side-split-panel') !== null), true);
    assert.equal(await page.$eval('#side-split-panel', el => el.getClientRects().length > 0), true);
    await page.evaluate(() => toggleSourceControlView(true));
    assert.equal(await page.$eval('#source-control-container', el => el.parentElement.id), 'right-drawer-body');
    await page.evaluate(() => { closeSessionRightDrawer(); toggleArtifactsSplitPanel(true); });
    assert.equal(await page.evaluate(() => state.sidePanelActiveTab.type), 'artifact');
    await page.evaluate(() => toggleSideSplitPanel(false));
    // Retain all approval scopes and denial feedback after reconnect support is merged.
    for (const action of ['allow_once', 'always_allow_session', 'always_allow_project', 'always_allow_global', 'deny']) {
      await page.evaluate(action => {
        showToolApprovalModal('approval-' + action, 'read_file', { path: 'sample.txt' });
        selectApprovalOption(action);
        document.getElementById('approval-deny-feedback').value = 'Read the other file';
        window.sentApproval = null;
        const send = state.wsConn.send;
        state.wsConn.send = data => { window.sentApproval = JSON.parse(data); };
        try { submitCommandApproval(); } finally { state.wsConn.send = send; }
      }, action);
      assert.deepEqual(await page.evaluate(() => window.sentApproval), {
        type: 'TOOL_APPROVAL_RESPONSE', approvalId: 'approval-' + action, action,
        feedback: action === 'deny' ? 'Read the other file' : ''
      });
    }
    await page.evaluate(() => {
      showCommandApprovalModal('expired', 'echo test');
      processWebSocketGatewayPayload({ type: 'COMMAND_APPROVAL_TIMEOUT', approvalId: 'expired' });
    });
    assert.equal(await page.$('#chat-inline-approval-card'), null);
    const requestsBeforeHidden = sourceRequests;
    const priorConnections = connectionCount;
    await page.evaluate(() => navigateToView('manager'));
    await new Promise(r => setTimeout(r, 3400));
    assert.equal(sourceRequests, requestsBeforeHidden, 'hidden explorer must not poll the host');
    assert.equal(connectionCount, priorConnections, 'leaving session must cancel reconnection');
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    for (const ws of wss.clients) ws.terminate();
    await new Promise(r => wss.close(r));
    await new Promise(r => server.close(r));
  }
});
