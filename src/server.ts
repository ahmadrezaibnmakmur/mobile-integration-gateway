import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const port = Number(process.env.PORT || 3000);
const anyfloBaseUrl = (process.env.ANYFLO_API_BASE_URL || '').replace(/\/$/, '');
const anyfloApiKey = process.env.ANYFLO_API_KEY || '';
type Json = Record<string, unknown>;

function send(response: ServerResponse, status: number, body: Json) { response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); response.end(JSON.stringify(body)); }
function bearer(request: IncomingMessage) { const header = request.headers.authorization || ''; return header.startsWith('Bearer ') ? header.slice(7).trim() : ''; }
async function jsonBody(request: IncomingMessage): Promise<unknown> {
  let raw = ''; for await (const chunk of request) { raw += chunk; if (raw.length > 1_000_000) throw Object.assign(new Error('Request body is too large'), { status: 413 }); }
  if (!raw) return undefined;
  try { return JSON.parse(raw); } catch { throw Object.assign(new Error('Valid JSON body required'), { status: 400 }); }
}
const relayRules = [
  ['GET', /^\/workflows$/], ['GET', /^\/workflows\/[^/]+\/(schema|dictionary)$/],
  ['POST', /^\/workflows\/[^/]+\/deduplication\/check$/], ['POST', /^\/workflows\/[^/]+\/tickets\/search$/],
  ['GET', /^\/workflows\/[^/]+\/tickets$/], ['POST', /^\/workflows\/[^/]+\/tickets$/],
  ['GET', /^\/workflows\/[^/]+\/tickets\/[^/]+\/history$/], ['GET', /^\/tickets\/[^/]+$/],
  ['PUT', /^\/tickets\/[^/]+$/], ['PATCH', /^\/tickets\/[^/]+\/array-fields\/[^/]+\/rows\/[^/]+$/], ['POST', /^\/tickets\/[^/]+\/comments$/],
] as const;
function isRelayRoute(method: string, path: string) { return relayRules.some(([allowedMethod, pattern]) => method === allowedMethod && pattern.test(path)); }
function resolveCurrentUser(value: unknown, user: Json): unknown {
  if (typeof value === 'string') {
    const values: Record<string, unknown> = {
      '$currentUser.id': user.id, '$currentUser.email': user.email,
      '$currentUser.role.id': (user.role as Json | null)?.id, '$currentUser.department.id': (user.department as Json | null)?.id,
    };
    return Object.prototype.hasOwnProperty.call(values, value) && values[value] != null ? values[value] : value;
  }
  if (Array.isArray(value)) return value.map(item => resolveCurrentUser(item, user));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveCurrentUser(item, user)]));
  return value;
}
async function relayV2(path: string, method: string, body: unknown) {
  if (!anyfloBaseUrl || !anyfloApiKey) throw new Error('AnyFlo server credentials are not configured');
  const response = await fetch(`${anyfloBaseUrl}/api/v2${path}`, {
    method, headers: { 'x-api-key': anyfloApiKey, accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, contentType: response.headers.get('content-type') || 'application/json; charset=utf-8', body: await response.text() };
}
async function anyflo(path: string, options: RequestInit = {}) {
  if (!anyfloBaseUrl || !anyfloApiKey) throw new Error('AnyFlo server credentials are not configured');
  const response = await fetch(`${anyfloBaseUrl}/api/v2${path}`, { ...options, headers: { 'x-api-key': anyfloApiKey, accept: 'application/json', ...options.headers } });
  const text = await response.text(); let body: unknown = null; try { body = text ? JSON.parse(text) : null; } catch { body = { error: text }; }
  if (!response.ok) throw Object.assign(new Error(`AnyFlo returned ${response.status}`), { status: response.status, body });
  return body;
}
async function mobileUser(request: IncomingMessage) {
  const token = bearer(request); if (!token || !anyfloBaseUrl) return null;
  const response = await fetch(`${anyfloBaseUrl}/api/mobile/v1/auth/me`, { headers: { authorization: `Bearer ${token}`, accept: 'application/json' } });
  return response.ok ? response.json() as Promise<Json> : null;
}
function contentType(path: string) { return ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' } as Record<string, string>)[extname(path)] || 'application/octet-stream'; }
async function serveStatic(pathname: string, response: ServerResponse) {
  const relative = pathname === '/' ? 'index.html' : pathname.slice(1); const safe = normalize(relative).replace(/^\.\.(\/|\\|$)/, '');
  try { const file = join(process.cwd(), 'public', safe); const content = await readFile(file); response.writeHead(200, { 'content-type': contentType(file), 'cache-control': 'no-store' }); response.end(content); } catch { send(response, 404, { error: 'Not found' }); }
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
  try {
    if (request.method === 'GET' && url.pathname === '/health') return send(response, 200, { status: 'ok', anyfloConfigured: Boolean(anyfloBaseUrl && anyfloApiKey) });
    if (request.method === 'GET' && url.pathname === '/admin/overview') {
      return send(response, 200, { anyfloConfigured: Boolean(anyfloBaseUrl && anyfloApiKey), mobileAdmissionCheckAvailable: true, relayTarget: 'AnyFlo API V2 per workflow', secretsAreServerOnly: true });
    }
    if (request.method === 'GET' && url.pathname === '/admin/anyflo/check') {
      await anyflo('/workflows?limit=1');
      return send(response, 200, { connected: true });
    }
    if (request.method === 'GET' && url.pathname === '/api/mobile/v1/session') {
      const user = await mobileUser(request); return user ? send(response, 200, { authenticated: true, user }) : send(response, 401, { error: 'Valid AnyFlo Mobile Admission token required' });
    }
    if (url.pathname === '/api/mobile/v1/v2' || url.pathname.startsWith('/api/mobile/v1/v2/')) {
      const user = await mobileUser(request); if (!user) return send(response, 401, { error: 'Valid AnyFlo Mobile Admission token required' });
      const targetPath = url.pathname.slice('/api/mobile/v1/v2'.length) || '/workflows';
      if (!isRelayRoute(request.method || 'GET', targetPath)) return send(response, 404, { error: 'Unsupported AnyFlo API V2 route' });
      url.searchParams.forEach((value, key) => url.searchParams.set(key, String(resolveCurrentUser(value, user))));
      const body = ['POST', 'PUT', 'PATCH'].includes(request.method || '') ? resolveCurrentUser(await jsonBody(request), user) : undefined;
      const upstream = await relayV2(`${targetPath}${url.search}`, request.method || 'GET', body);
      response.writeHead(upstream.status, { 'content-type': upstream.contentType, 'cache-control': 'no-store' }); return response.end(upstream.body);
    }
    if (request.method === 'GET') return serveStatic(url.pathname, response);
    return send(response, 404, { error: 'Not found' });
  } catch (error) {
    const item = error as { message?: string; status?: number }; console.error('request failed', { path: url.pathname, status: item.status, message: item.message });
    return send(response, item.status && item.status < 500 ? item.status : 502, { error: item.message || 'Gateway request failed' });
  }
});
server.listen(port, () => console.log(`Mobile Integration Gateway listening on :${port}`));
