import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const port = Number(process.env.PORT || 3000);
const anyfloBaseUrl = (process.env.ANYFLO_API_BASE_URL || '').replace(/\/$/, '');
const anyfloApiKey = process.env.ANYFLO_API_KEY || '';
const outletOps = { taskWorkflowId: process.env.OUTLET_OPS_TASK_WORKFLOW_ID || '', shiftWorkflowId: process.env.OUTLET_OPS_SHIFT_WORKFLOW_ID || '' };
type Json = Record<string, unknown>;

function send(response: ServerResponse, status: number, body: Json) { response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); response.end(JSON.stringify(body)); }
function bearer(request: IncomingMessage) { const header = request.headers.authorization || ''; return header.startsWith('Bearer ') ? header.slice(7).trim() : ''; }
async function jsonBody(request: IncomingMessage): Promise<Json> { let raw = ''; for await (const chunk of request) { raw += chunk; if (raw.length > 1_000_000) throw new Error('Request body is too large'); } return raw ? JSON.parse(raw) as Json : {}; }
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
function list(value: unknown): Json[] { return Array.isArray(value) ? value as Json[] : Array.isArray((value as Json)?.data) ? (value as Json).data as Json[] : []; }
function ticketBelongsToUser(ticket: Json, user: Json) {
  const identity = new Set([user.id, user.email].filter(Boolean).map(String));
  return Object.values(ticket).some((value) => Array.isArray(value) && value.some((item) => typeof item === 'string' ? identity.has(item) : Boolean(item && typeof item === 'object' && (identity.has(String((item as Json).id)) || identity.has(String((item as Json).email))))));
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
    if (request.method === 'GET' && url.pathname === '/admin/config') {
      return send(response, 200, { anyfloBaseUrl: anyfloBaseUrl || null, apiKeyConfigured: Boolean(anyfloApiKey), outletOps, secretsAreServerOnly: true });
    }
    if (request.method === 'GET' && url.pathname === '/admin/anyflo/check') {
      await anyflo('/workflows?limit=1');
      return send(response, 200, { connected: true });
    }
    if (request.method === 'GET' && url.pathname === '/admin/store-ops/check') {
      if (!outletOps.taskWorkflowId || !outletOps.shiftWorkflowId) return send(response, 503, { error: 'Outlet Ops workflows are not configured' });
      const [tasks, shifts] = await Promise.all([anyflo(`/workflows/${outletOps.taskWorkflowId}/tickets?limit=1`), anyflo(`/workflows/${outletOps.shiftWorkflowId}/tickets?limit=1`)]);
      return send(response, 200, { connected: true, taskWorkflowId: outletOps.taskWorkflowId, shiftWorkflowId: outletOps.shiftWorkflowId, taskSampleCount: list(tasks).length, shiftSampleCount: list(shifts).length });
    }
    if (request.method === 'GET' && url.pathname === '/api/mobile/v1/session') {
      const user = await mobileUser(request); return user ? send(response, 200, { authenticated: true, user }) : send(response, 401, { error: 'Valid AnyFlo Mobile Admission token required' });
    }
    if (request.method === 'GET' && url.pathname === '/api/mobile/v1/apps/outlet-ops/bootstrap') {
      const user = await mobileUser(request); if (!user) return send(response, 401, { error: 'Valid AnyFlo Mobile Admission token required' });
      if (!outletOps.taskWorkflowId || !outletOps.shiftWorkflowId) return send(response, 503, { error: 'Outlet Ops workflows are not configured' });
      const [tasks, shifts] = await Promise.all([anyflo(`/workflows/${outletOps.taskWorkflowId}/tickets?limit=100`), anyflo(`/workflows/${outletOps.shiftWorkflowId}/tickets?limit=100`)]);
      return send(response, 200, { user, tasks: list(tasks).filter((ticket) => ticketBelongsToUser(ticket, user)), shifts: list(shifts).filter((ticket) => ticketBelongsToUser(ticket, user)) });
    }
    const taskMatch = url.pathname.match(/^\/api\/mobile\/v1\/apps\/outlet-ops\/tasks\/([^/]+)$/);
    if (taskMatch && request.method === 'PUT') {
      const user = await mobileUser(request); if (!user) return send(response, 401, { error: 'Valid AnyFlo Mobile Admission token required' });
      const ticket = await anyflo(`/tickets/${encodeURIComponent(taskMatch[1])}`) as Json; if (!ticketBelongsToUser(ticket, user)) return send(response, 404, { error: 'Task not found' });
      const body = await jsonBody(request); const allowed = ['field_checklist', 'work_notes', 'evidence', 'captured_location', 'status']; const data = Object.fromEntries(Object.entries(body).filter(([key]) => allowed.includes(key)));
      if (!Object.keys(data).length) return send(response, 400, { error: 'No permitted task fields supplied' });
      return send(response, 200, { ticket: await anyflo(`/tickets/${encodeURIComponent(taskMatch[1])}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ data }) }) });
    }
    if (request.method === 'GET') return serveStatic(url.pathname, response);
    return send(response, 404, { error: 'Not found' });
  } catch (error) {
    const item = error as { message?: string; status?: number }; console.error('request failed', { path: url.pathname, status: item.status, message: item.message });
    return send(response, item.status && item.status < 500 ? item.status : 502, { error: item.message || 'Gateway request failed' });
  }
});
server.listen(port, () => console.log(`Mobile Integration Gateway listening on :${port}`));
