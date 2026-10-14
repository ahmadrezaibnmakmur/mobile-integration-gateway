import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { clearHubConfig, loadHubConfig, publicHubConfig, saveHubConfig, type HubConfig } from './config.js';
import { createPushEngine, initializeWebhookSecret, validateEvent, verifyWebhookSecret, webhookSecret } from './push.js';
import { loadPushApps } from './push-providers.js';
import { testReceiver } from './receiver-test.js';

const port = Number(process.env.PORT || 3000);
const push = createPushEngine(loadPushApps());
initializeWebhookSecret();
push.start();
type Json = Record<string, unknown>;

function send(response: ServerResponse, status: number, body: Json) { response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); response.end(JSON.stringify(body)); }
function bearer(request: IncomingMessage) { const header = request.headers.authorization || ''; return header.startsWith('Bearer ') ? header.slice(7).trim() : ''; }
async function jsonBody(request: IncomingMessage): Promise<unknown> {
  let raw = ''; for await (const chunk of request) { raw += chunk; if (raw.length > 1_000_000) throw Object.assign(new Error('Request body is too large'), { status: 413 }); }
  if (!raw) return undefined;
  try { return JSON.parse(raw); } catch { throw Object.assign(new Error('Valid JSON body required'), { status: 400 }); }
}
const relayRules = [
  ['GET', /^\/tickets\/[^/]+\/mention-candidates$/],
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
async function relayV2(config: HubConfig, path: string, method: string, body: unknown) {
  if (!config.anyfloBaseUrl || !config.anyfloApiKey) throw new Error('AnyFlo server credentials are not configured');
  const response = await fetch(`${config.anyfloBaseUrl}/api/v2${path}`, {
    method, headers: { 'x-api-key': config.anyfloApiKey, accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, contentType: response.headers.get('content-type') || 'application/json; charset=utf-8', body: await response.text() };
}
async function anyflo(path: string, options: RequestInit = {}) {
  const config = await loadHubConfig();
  if (!config.anyfloBaseUrl || !config.anyfloApiKey) throw new Error('AnyFlo server credentials are not configured');
  const response = await fetch(`${config.anyfloBaseUrl}/api/v2${path}`, { ...options, headers: { 'x-api-key': config.anyfloApiKey, accept: 'application/json', ...options.headers } });
  const text = await response.text(); let body: unknown = null; try { body = text ? JSON.parse(text) : null; } catch { body = { error: text }; }
  if (!response.ok) throw Object.assign(new Error(`AnyFlo returned ${response.status}`), { status: response.status, body });
  return body;
}
async function mobileAdmissionReadiness() {
  const config = await loadHubConfig();
  if (!config.anyfloBaseUrl || !config.anyfloApiKey) throw Object.assign(new Error('Connect AnyFlo before checking Mobile Admission readiness'), { status: 409 });
  const response = await fetch(`${config.anyfloBaseUrl}/api/mobile/v1/auth/readiness`, {
    headers: { 'x-api-key': config.anyfloApiKey, accept: 'application/json' },
  });
  const text = await response.text(); let body: unknown = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { error: text }; }
  if (!response.ok) throw Object.assign(new Error(`AnyFlo Mobile Admission readiness returned ${response.status}`), { status: response.status, body });
  return body;
}
async function safeMobileAdmissionReadiness() {
  try { return { checked: true, result: await mobileAdmissionReadiness() }; }
  catch (error) { const item = error as { message?: string; status?: number }; return { checked: false, error: item.message || 'Readiness check unavailable', status: item.status || 502 }; }
}
function publicHubUrl(request: IncomingMessage) {
  const configured = process.env.HUB_PUBLIC_URL?.replace(/\/$/, '');
  if (configured) return configured;
  const host = String(request.headers['x-forwarded-host'] || request.headers.host || '').split(',')[0].trim();
  const forwardedProtocol = request.headers['x-forwarded-proto'];
  const protocol = forwardedProtocol ? String(forwardedProtocol).split(',')[0].trim() : (/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(host) ? 'http' : 'https');
  return host ? `${protocol === 'http' ? 'http' : 'https'}://${host}` : null;
}
async function mobileUser(request: IncomingMessage) {
  const config = await loadHubConfig();
  const token = bearer(request); if (!token || !config.anyfloBaseUrl) return null;
  const response = await fetch(`${config.anyfloBaseUrl}/api/mobile/v1/auth/me`, { headers: { authorization: `Bearer ${token}`, accept: 'application/json' } });
  return response.ok ? response.json() as Promise<Json> : null;
}
async function proxyMobileAdmission(request: IncomingMessage, response: ServerResponse, url: URL) {
  const config = await loadHubConfig();
  if (!config.anyfloBaseUrl) return send(response, 503, { error: 'AnyFlo server credentials are not configured' });
  const body = ['POST', 'PUT', 'PATCH'].includes(request.method || '') ? await jsonBody(request) : undefined;
  const upstream = await fetch(`${config.anyfloBaseUrl}${url.pathname}`, {
    method: request.method,
    headers: { accept: 'application/json', ...(bearer(request) ? { authorization: `Bearer ${bearer(request)}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  response.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') || 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(await upstream.text());
}
function contentType(path: string) { return ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' } as Record<string, string>)[extname(path)] || 'application/octet-stream'; }
async function serveStatic(pathname: string, response: ServerResponse) {
  const relative = pathname === '/' ? 'index.html' : pathname.slice(1); const safe = normalize(relative).replace(/^\.\.(\/|\\|$)/, '');
  try { const file = join(process.cwd(), 'public', safe); const content = await readFile(file); response.writeHead(200, { 'content-type': contentType(file), 'cache-control': 'no-store' }); response.end(content); } catch { send(response, 404, { error: 'Not found' }); }
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
  try {
    if (request.method === 'POST' && url.pathname === '/internal/events/mobile-notification') {
      let input: unknown;
      try {
        verifyWebhookSecret(request.headers['x-anyflo-hub-secret'], webhookSecret());
        if (!request.headers['content-type']?.startsWith('application/json')) throw Object.assign(new Error('Content-Type application/json required'), { status: 415 });
        input = await jsonBody(request);
        const result = push.accept(validateEvent(input));
        return send(response, result.duplicate ? 200 : 202, result);
      } catch (error) {
        const item = error as { status?: number; message?: string };
        const status = item.status || 500;
        const reason = status === 401 ? 'SECRET_INVALID' : status === 503 ? 'SECRET_NOT_CONFIGURED' : status === 409 ? 'EVENT_ID_CONFLICT' : status === 415 ? 'CONTENT_TYPE_INVALID' : status === 413 ? 'BODY_TOO_LARGE' : status === 400 ? 'PAYLOAD_INVALID' : 'PERSISTENCE_ERROR';
        const receiptId = push.recordReceipt(input, 'rejected', status, reason);
        return send(response, status, { error: status >= 500 ? reason : item.message || reason, reason, receiptId });
      }
    }
    if (request.method === 'POST' && url.pathname === '/api/mobile/v1/devices') {
      const user = await mobileUser(request);
      if (!user || typeof user.id !== 'string' || typeof user.email !== 'string') return send(response, 401, { error: 'Valid AnyFlo Mobile Admission token required' });
      return send(response, 200, push.register({ id: user.id, email: user.email }, await jsonBody(request)));
    }
    const deviceMatch = url.pathname.match(/^\/api\/mobile\/v1\/devices\/([^/]+)$/);
    if (request.method === 'DELETE' && deviceMatch) {
      const user = await mobileUser(request);
      if (!user || typeof user.id !== 'string' || typeof user.email !== 'string') return send(response, 401, { error: 'Valid AnyFlo Mobile Admission token required' });
      return send(response, 200, push.unregister({ id: user.id, email: user.email }, deviceMatch[1]));
    }
    if (request.method === 'GET' && url.pathname === '/admin/push') return send(response, 200, push.overview());
    if (request.method === 'POST' && url.pathname === '/admin/push/test-event') {
      if (request.headers['x-hub-test'] !== 'receiver' || !request.headers['content-type']?.startsWith('application/json')) return send(response, 400, { error: 'Use the Hub Test Event panel with JSON content' });
      if (request.headers.origin && request.headers.origin !== publicHubUrl(request)) return send(response, 403, { error: 'Cross-origin test requests are not allowed' });
      const input = await jsonBody(request) as { scenario?: string };
      return send(response, 200, await testReceiver(`http://127.0.0.1:${(server.address() as { port: number }).port}`, input?.scenario || 'all'));
    }
    if (request.method === 'GET' && url.pathname === '/health') { const config = await loadHubConfig(); return send(response, 200, { status: 'ok', anyfloConfigured: Boolean(config.anyfloBaseUrl && config.anyfloApiKey) }); }
    if (request.method === 'GET' && url.pathname === '/admin/overview') {
      const config = await loadHubConfig(); return send(response, 200, { ...publicHubConfig(config), mobileAdmissionCheckAvailable: true, relayTarget: 'AnyFlo API V2 per workflow', secretsAreServerOnly: true });
    }
    if (request.method === 'GET' && url.pathname === '/admin/config') return send(response, 200, publicHubConfig(await loadHubConfig()));
    if (request.method === 'PUT' && url.pathname === '/admin/config') return send(response, 200, publicHubConfig(await saveHubConfig(await jsonBody(request) as Partial<HubConfig>)));
    if (request.method === 'DELETE' && url.pathname === '/admin/config') return send(response, 200, publicHubConfig(await clearHubConfig()));
    if (request.method === 'GET' && url.pathname === '/admin/anyflo/check') {
      await anyflo('/workflows?limit=1');
      return send(response, 200, { connected: true });
    }
    if (request.method === 'GET' && url.pathname === '/admin/mobile-admission/readiness') return send(response, 200, await mobileAdmissionReadiness() as Json);
    if (request.method === 'GET' && url.pathname === '/admin/workflows') return send(response, 200, { result: await anyflo('/workflows') });
    const dictionaryMatch = url.pathname.match(/^\/admin\/workflows\/([^/]+)\/(dictionary|schema)$/);
    if (request.method === 'GET' && dictionaryMatch) return send(response, 200, { result: await anyflo(`/workflows/${encodeURIComponent(dictionaryMatch[1])}/${dictionaryMatch[2]}`) });
    if (request.method === 'GET' && url.pathname === '/agent-guide') return send(response, 200, {
      title: 'AnyFlo Mobile Admission Readiness & Barebones Guide', hubBaseUrl: publicHubUrl(request), runtimeBasePath: '/api/mobile/v1/v2', authentication: 'Bearer <Mobile Admission access token>',
      eventTesting: { ui: 'Test Event panel', endpoint: 'POST /admin/push/test-event', headers: { 'X-Hub-Test': 'receiver' }, body: { scenario: 'all | comment-mention | general-notification | broadcast' }, scope: 'Fixed synthetic recipient, receiver loopback test only. Does not verify the AnyFlo publisher or send to real devices.', diagnostics: 'GET /admin/push' },
      push: { registerDevice: 'POST /api/mobile/v1/devices', unregisterDevice: 'DELETE /api/mobile/v1/devices/:deviceId', body: { applicationId: '<server-registered app>', platform: 'android | ios', provider: 'fcm | apns', installationId: '<persisted random device installation ID>', token: '<provider registration token>' }, rules: ['Use Mobile Admission bearer authentication. The server derives device ownership.', 'Register on login and whenever the provider token changes. Unregister before logout/account switching.', 'Handle deepLink as a validated route/id object; fetch ticket data using the admitted session.', 'Push may be missed or delayed; refresh app data on resume.'] },
      mobileAdmission: {
        authBasePath: '/api/mobile/v1/auth',
        endpoints: { startGoogle: 'GET /google/start', exchangeCode: 'POST /google/exchange', currentProfile: 'GET /me', refresh: 'POST /refresh', logout: 'POST /logout' },
        readiness: await safeMobileAdmissionReadiness(),
        clientRules: ['Open Google sign-in in the system browser, never an embedded WebView.', 'Verify OAuth state before exchanging the returned code.', 'Store access and refresh tokens only in Android Keystore or iOS Keychain.', 'Do not put an AnyFlo API key, Google client secret, Mobile JWT secret, or Hub admin token in the app.'],
        appLinkNextStep: 'Use the non-secret redirectUri reported by readiness as the App Link/Universal Link host. Before live testing, propose the Android package name or iOS bundle identifier, obtain its signing identity, then publish its association file on that exact host. Do not invent a redirect URI, package name, signing fingerprint, or association file value.',
      },
      barebonesScope: ['Build Google Admission login first.', 'After successful admission, show an empty authenticated Home.', 'Provide an Account page that displays the admitted user name, email, avatar when supplied, role, and department.', 'Unknown Google users must remain rejected by AnyFlo; never auto-provision them in the app.'],
      requiredUserInputs: ['The app name and local project folder, if not already given.', 'Approval of the proposed Android package name and/or iOS bundle identifier before App Link or Universal Link configuration.', 'A physical device or emulator for final callback verification.'],
      workflowDiscovery: ['GET /workflows', 'GET /workflows/:workflowId/dictionary', 'GET /workflows/:workflowId/schema'],
      ticketOperations: ['GET /workflows/:workflowId/tickets', 'POST /workflows/:workflowId/tickets/search', 'POST /workflows/:workflowId/tickets', 'GET /tickets/:ticketId', 'PUT /tickets/:ticketId', 'PATCH /tickets/:ticketId/array-fields/:arrayField/rows/:rowId', 'GET /tickets/:ticketId/mention-candidates?search=&limit=', 'POST /tickets/:ticketId/comments'],
      identityPlaceholders: ['$currentUser.id', '$currentUser.email', '$currentUser.role.id', '$currentUser.department.id'],
      rules: ['Read the dictionary before building a form or query.', 'Use hubBaseUrl + runtimeBasePath, never an AnyFlo API key in an APK.', 'Workflow Groups are web navigation, not an integration requirement.', 'Use Mobile Admission and secure device storage for mobile tokens.'],
    });
    if (request.method === 'POST' && url.pathname === '/admin/v2/request') {
      const input = await jsonBody(request) as { method?: string; path?: string; body?: unknown };
      const target = new URL(input.path || '', 'http://hub'); const method = (input.method || 'GET').toUpperCase();
      if (!input.path?.startsWith('/') || !isRelayRoute(method, target.pathname)) return send(response, 400, { error: 'Unsupported AnyFlo API V2 route' });
      const upstream = await relayV2(await loadHubConfig(), `${target.pathname}${target.search}`, method, ['POST', 'PUT', 'PATCH'].includes(method) ? input.body : undefined);
      response.writeHead(upstream.status, { 'content-type': upstream.contentType, 'cache-control': 'no-store' }); return response.end(upstream.body);
    }
    if (/^\/api\/mobile\/v1\/auth\/(google\/start|google\/exchange|me|refresh|logout)$/.test(url.pathname)) return proxyMobileAdmission(request, response, url);
    if (request.method === 'GET' && url.pathname === '/api/mobile/v1/storage/presigned-url') {
      const user = await mobileUser(request); if (!user) return send(response, 401, { error: 'Valid AnyFlo Mobile Admission token required' });
      const config = await loadHubConfig();
      const upstream = await fetch(`${config.anyfloBaseUrl}/api/storage/presigned-url${url.search}`, { headers: { accept: 'application/json' } });
      response.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') || 'application/json; charset=utf-8', 'cache-control': 'no-store' }); return response.end(await upstream.text());
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
      const upstream = await relayV2(await loadHubConfig(), `${targetPath}${url.search}`, request.method || 'GET', body);
      response.writeHead(upstream.status, { 'content-type': upstream.contentType, 'cache-control': 'no-store' }); return response.end(upstream.body);
    }
    if (request.method === 'GET') return serveStatic(url.pathname, response);
    return send(response, 404, { error: 'Not found' });
  } catch (error) {
    const item = error as { message?: string; status?: number }; console.error('request failed', { path: url.pathname, status: item.status, message: item.message });
    return send(response, item.status && (item.status < 500 || item.status === 503) ? item.status : 502, { error: item.message || 'Gateway request failed' });
  }
});
server.listen(port, () => console.log(`Mobile Integration Gateway listening on :${(server.address() as { port: number }).port}`));
