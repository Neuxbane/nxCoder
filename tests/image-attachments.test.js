import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadAttachedImage, getHistoryImages } from '../image-attachments.js';
import { OpenAIProvider } from '../marketplace/builtin/providers/openai.js';
import { OllamaProvider } from '../marketplace/builtin/providers/ollama.js';

const image = { inlineData: { mimeType: 'image/png', data: 'aW1hZ2U=' } };

test('attachment hydration retains original bytes, infers MIME and reports missing images', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nx-image-'));
  try {
    const file = path.join(dir, 'screenshot.png');
    const bytes = Buffer.from([137, 80, 78, 71, 0, 1, 2, 255]);
    await fs.writeFile(file, bytes);
    const part = await loadAttachedImage({ _localFilePath: file, mimeType: 'application/octet-stream' });
    assert.equal(part.inlineData.mimeType, 'image/png');
    assert.deepEqual(Buffer.from(part.inlineData.data, 'base64'), bytes);
    assert.equal(await loadAttachedImage({ _localFilePath: path.join(dir, 'notes.txt'), mimeType: 'text/plain' }), null);
    const missing = await loadAttachedImage({ _localFilePath: path.join(dir, 'missing.png') });
    assert.match(missing.text, /could not be read/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('Live retains multiple historical images after text and tool follow-ups', () => {
  const messages = [
    { role: 'user', parts: [{ text: 'Compare these' }, image, image] },
    { role: 'model', parts: [{ functionCall: { name: 'read_file' } }] },
    { role: 'user', parts: [{ functionResponse: { name: 'read_file' } }] }
  ];
  const parts = getHistoryImages(messages);
  assert.equal(parts.length, 4);
  assert.deepEqual(parts.filter(p => p.inlineData), [image, image]);
  assert.match(parts[0].text, /turn 1, user/);
  assert.deepEqual(getHistoryImages([{ role: 'user', parts: [{ text: 'hello' }] }]), []);
});

for (const Provider of [OpenAIProvider, OllamaProvider]) {
  test(`${Provider.id} sends image bytes with text and preserves text-only messages`, async t => {
    let request;
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
      request = JSON.parse(options.body);
      return new Response('', { status: 200 });
    });
    const provider = new Provider({ model: 'vision-model' });
    await provider.executeStream({ messages: [
      { role: 'user', parts: [{ text: 'first' }] },
      { role: 'user', parts: [{ text: 'inspect' }, image, { text: 'then compare' }, image] }
    ] }, {});
    assert.equal(request.messages[0].content, 'first');
    if (Provider.id === 'openai') {
      assert.deepEqual(request.messages[1].content.map(p => p.type), ['text', 'image_url', 'text', 'image_url']);
      assert.equal(request.messages[1].content[1].image_url.url, 'data:image/png;base64,aW1hZ2U=');
    } else {
      assert.deepEqual(request.messages[1].images, ['aW1hZ2U=', 'aW1hZ2U=']);
      assert.equal(request.messages[1].content, 'inspectthen compare');
      assert.equal(request.messages[0].images, undefined);
    }
  });
}

test('Gemini Interactions maps image attachments into native image content with tool context', async () => {
  const { mapContentStackToSteps } = await import('../marketplace/builtin/providers/gemini-content.js');
  const steps = mapContentStackToSteps([
    { role: 'user', parts: [{ text: 'inspect' }, image] },
    { role: 'model', parts: [{ functionCall: { id: 'c1', name: 'read_file', args: { path: 'a' } } }] },
    { role: 'user', parts: [{ functionResponse: { id: 'c1', name: 'read_file', response: { result: 'contents' } } }] }
  ]);
  assert.deepEqual(steps[0], { type: 'user_input', content: [
    { type: 'text', text: 'inspect' }, { type: 'image', data: 'aW1hZ2U=', mime_type: 'image/png' }
  ] });
  assert.equal(steps[1].type, 'function_call');
  assert.equal(steps[2].call_id, 'c1');
});
