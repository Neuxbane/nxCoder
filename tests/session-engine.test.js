import test from 'node:test';
import assert from 'node:assert/strict';
import { GeminiProvider } from '../marketplace/builtin/providers/gemini.js';
import { GeminiLiveProvider } from '../marketplace/builtin/providers/gemini-live.js';
import { OllamaProvider } from '../marketplace/builtin/providers/ollama.js';
import { OpenAIProvider } from '../marketplace/builtin/providers/openai.js';
import { MarketplaceManager } from '../marketplace/manager.js';

test('engine metadata uses execution defaults and excludes credentials', () => {
  for (const [Provider, model] of [[GeminiProvider, 'gemini-2.5-flash'], [GeminiLiveProvider, 'gemini-3.1-flash-live-preview'], [OllamaProvider, 'llama3'], [OpenAIProvider, 'gpt-4o']]) {
    const provider = new Provider({ apiKey: 'secret', host: 'private-host' });
    assert.equal(provider.engineInfo.model, model);
    assert.deepEqual(Object.keys(provider.engineInfo).sort(), ['model', 'providerId', 'providerName']);
    assert.equal(JSON.stringify(provider.engineInfo).includes('secret'), false);
  }
  assert.equal(new GeminiProvider({ defaultModel: 'configured-gemini' }).engineInfo.model, 'configured-gemini');
  assert.equal(new OllamaProvider({ model: 'configured-local' }).engineInfo.model, 'configured-local');
});

test('previewing engine does not consume the provider rotation', async () => {
  const manager = {
    rotationIndex: 0,
    providers: new Map([['ollama', OllamaProvider]]),
    dbAll: async () => [{ provider_id: 'ollama', key: '{"model":"first"}' }, { provider_id: 'ollama', key: '{"model":"second"}' }]
  };
  const get = options => MarketplaceManager.prototype.getActiveProvider.call(manager, options);
  assert.equal((await get({ rotate: false })).model, 'first');
  assert.equal((await get({ rotate: false })).model, 'first');
  assert.equal((await get()).model, 'first');
  assert.equal((await get({ rotate: false })).model, 'second');
  assert.equal((await get()).model, 'second');
});
