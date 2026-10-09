import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = await mkdtemp(join(tmpdir(), 'mobile-hub-config-'));
const { loadHubConfig, saveHubConfig, publicHubConfig } = await import('./config.js');
assert.deepEqual(await loadHubConfig(), { anyfloBaseUrl: '', apiKeyName: '', anyfloApiKey: '' });
await saveHubConfig({ anyfloBaseUrl: 'https://anyflo.example/', apiKeyName: 'Staging', anyfloApiKey: 'secret-value' });
const saved = await loadHubConfig();
assert.equal(saved.anyfloBaseUrl, 'https://anyflo.example');
assert.equal(saved.anyfloApiKey, 'secret-value');
assert.deepEqual(publicHubConfig(saved), { anyfloBaseUrl: 'https://anyflo.example', apiKeyName: 'Staging', apiKeyConfigured: true });
await rm(process.env.DATA_DIR, { recursive: true, force: true });
console.log('Hub configuration checks passed');
