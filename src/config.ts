import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export type HubConfig = { anyfloBaseUrl: string; apiKeyName: string; anyfloApiKey: string };
const configDir = () => process.env.DATA_DIR || join(process.cwd(), '.data');
const configFile = () => join(configDir(), 'hub-config.json');
const envConfig = (): HubConfig => ({
  anyfloBaseUrl: (process.env.ANYFLO_API_BASE_URL || '').replace(/\/$/, ''),
  apiKeyName: process.env.ANYFLO_API_KEY_NAME || 'AnyFlo API key',
  anyfloApiKey: process.env.ANYFLO_API_KEY || '',
});

export async function loadHubConfig(): Promise<HubConfig> {
  try {
    const stored = JSON.parse(await readFile(configFile(), 'utf8')) as Partial<HubConfig>;
    return { ...envConfig(), ...stored, anyfloBaseUrl: (stored.anyfloBaseUrl || envConfig().anyfloBaseUrl).replace(/\/$/, '') };
  } catch { return envConfig(); }
}

export async function saveHubConfig(input: Partial<HubConfig>): Promise<HubConfig> {
  const current = await loadHubConfig();
  const next: HubConfig = {
    anyfloBaseUrl: typeof input.anyfloBaseUrl === 'string' ? input.anyfloBaseUrl.trim().replace(/\/$/, '') : current.anyfloBaseUrl,
    apiKeyName: typeof input.apiKeyName === 'string' ? input.apiKeyName.trim() : current.apiKeyName,
    anyfloApiKey: typeof input.anyfloApiKey === 'string' && input.anyfloApiKey.trim() ? input.anyfloApiKey.trim() : current.anyfloApiKey,
  };
  try { const url = new URL(next.anyfloBaseUrl); if (!['http:', 'https:'].includes(url.protocol)) throw new Error(); } catch { throw Object.assign(new Error('AnyFlo base URL must be a valid HTTP(S) URL'), { status: 400 }); }
  if (!next.apiKeyName) throw Object.assign(new Error('API key name is required'), { status: 400 });
  if (!next.anyfloApiKey) throw Object.assign(new Error('AnyFlo API key is required'), { status: 400 });
  await mkdir(configDir(), { recursive: true });
  const temporary = `${configFile()}.tmp`;
  await writeFile(temporary, JSON.stringify(next), { mode: 0o600 });
  await rename(temporary, configFile());
  return next;
}

export const publicHubConfig = (config: HubConfig) => ({ anyfloBaseUrl: config.anyfloBaseUrl || null, apiKeyName: config.apiKeyName || null, apiKeyConfigured: Boolean(config.anyfloApiKey) });
