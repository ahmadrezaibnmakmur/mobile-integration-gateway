import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export type HubConfig = { anyfloBaseUrl: string; apiKeyName: string; anyfloApiKey: string };
const configDir = () => process.env.DATA_DIR || join(process.cwd(), '.data');
const configFile = () => join(configDir(), 'hub-config.json');
const emptyConfig = (): HubConfig => ({ anyfloBaseUrl: '', apiKeyName: '', anyfloApiKey: '' });

export async function loadHubConfig(): Promise<HubConfig> {
  try {
    const stored = JSON.parse(await readFile(configFile(), 'utf8')) as Partial<HubConfig>;
    return { ...emptyConfig(), ...stored, anyfloBaseUrl: (stored.anyfloBaseUrl || '').replace(/\/$/, '') };
  } catch { return emptyConfig(); }
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

export async function clearHubConfig(): Promise<HubConfig> {
  try { await unlink(configFile()); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return emptyConfig();
}

export const publicHubConfig = (config: HubConfig) => ({ anyfloBaseUrl: config.anyfloBaseUrl || null, apiKeyName: config.apiKeyName || null, apiKeyConfigured: Boolean(config.anyfloApiKey) });
