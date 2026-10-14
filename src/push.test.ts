import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, generateKeyPairSync, verify } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once, EventEmitter } from 'node:events';
import { PushEngine, validateEvent, verifyWebhookSecret } from './push.js';
import { deliverPush, type PushApps } from './push-providers.js';

async function listening(child: ReturnType<typeof spawn>) {
  return new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Hub startup timeout')), 10_000);
    child.once('exit', () => { clearTimeout(timeout); reject(new Error('Hub exited before startup')); });
    child.stdout!.on('data', data => { const match = data.toString().match(/listening on :(\d+)/); if (match) { clearTimeout(timeout); resolve(match[1]); } });
  });
}

const dir = await mkdtemp(join(tmpdir(), 'hub-push-test-'));
const apps: PushApps = { demo: { platforms: ['android', 'ios'] } };
const alice = { id: 'alice', email: 'alice@example.com' };
const bob = { id: 'bob', email: 'bob@example.com' };
const event = validateEvent({ eventId: 'event-1', eventType: 'notification.created', occurredAt: new Date().toISOString(), recipient: alice, title: 'A title', body: 'A message\nwith line break', resource: { type: 'ticket', id: 't1', workflowId: 'w1' }, deepLink: { route: 'ticket', id: 't1' } });
const broadcast = validateEvent({ ...event, eventId: 'broadcast-1', eventType: 'broadcast.published', resource: { type: 'broadcast', id: 'b1' }, deepLink: { route: 'broadcast', id: 'b1' } });
assert.throws(() => verifyWebhookSecret(undefined, 'test-secret'), /Invalid webhook secret/);
assert.throws(() => verifyWebhookSecret('wrong', 'test-secret'), /Invalid webhook secret/);
assert.throws(() => verifyWebhookSecret('test-secret', undefined), /not configured/);
verifyWebhookSecret('test-secret', 'test-secret');
assert.throws(() => validateEvent({ ...event, deepLink: { route: 'ticket', id: 'wrong' } }), /does not match/);
assert.throws(() => validateEvent({ ...event, recipient: { id: 'x', email: 'bad' } }), /email/);
assert.throws(() => validateEvent({ ...event, eventType: 'arbitrary' }), /Unsupported/);
let sends = 0;
const file = join(dir, 'test.sqlite');
let engine = new PushEngine(apps, file, async () => { sends++; return { status: 'sent', code: 'TEST_ACCEPTED' }; });
const registration = { applicationId: 'demo', platform: 'android', installationId: 'phone', token: 'fcm-token-1' };
const registered = engine.register(alice, registration);
assert.throws(() => engine.register(alice, { ...registration, userId: bob.id }), /owner/);
assert.throws(() => engine.register(bob, registration), /another user/);
assert.throws(() => engine.unregister(bob, registered.id), /not found/);
assert.equal(engine.register(alice, { ...registration, token: 'rotated-token' }).id, registered.id);
assert.equal(engine.accept(event).duplicate, false);
const second = new PushEngine(apps, file);
assert.equal(second.accept(event).duplicate, true);
second.close();
await Promise.all(Array.from({ length: 20 }, async () => engine.accept(event)));
await engine.drain();
assert.equal(sends, 1);
assert.throws(() => engine.accept({ ...event, body: 'different' }), /different payload/);
engine.close();
engine = new PushEngine(apps, file);
assert.equal(engine.accept(event).duplicate, true, 'Event deduplication survives restart');
engine.accept({ ...event, eventId: 'event-2' });
await engine.drain();
assert.equal((engine.overview().deliveries as any[]).find(x => x.eventId === 'event-2').status, 'not_configured');
engine.close();
engine = new PushEngine(apps, file, async () => ({ status: 'failed', code: 'UNREGISTERED', invalidToken: true }));
engine.accept({ ...event, eventId: 'event-3' }); await engine.drain();
assert.equal((engine.overview().devices as any[])[0].active, 0);
engine.accept({ ...event, eventId: 'event-4' });
assert.equal((engine.overview().deliveries as any[]).find(x => x.eventId === 'event-4').status, 'no_devices');
engine.unregister(alice, registered.id); engine.close();

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const fcm = { projectId: 'project', clientEmail: 'sender@example.com', privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
let calls = 0;
const http = (async (url: string, options: any) => {
  calls++;
  if (url.includes('oauth2')) { assert.ok(options.body.get('assertion')); return Response.json({ access_token: 'oauth-token', expires_in: 3600 }); }
  const sent = JSON.parse(options.body); assert.equal(sent.message.token, 'device-token'); assert.equal(JSON.parse(sent.message.data.deepLink).id, 't1');
  return Response.json({ error: { details: [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode: 'UNREGISTERED' }] } }, { status: 404 });
}) as typeof fetch;
assert.equal((await deliverPush({ platforms: ['android'], fcm }, 'fcm', 'device-token', event, http)).invalidToken, true);
assert.equal(calls, 2);
assert.equal((await deliverPush({ platforms: ['android'], fcm }, 'fcm', 'device-token', event, (async () => Response.json({ name: 'projects/project/messages/success' })) as typeof fetch)).status, 'sent');
assert.equal((await deliverPush(apps.demo, 'apns', 'token', event)).status, 'not_configured');
const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const apns = { teamId: 'team', keyId: 'key', privateKey: ec.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), bundleId: 'com.example.test', environment: 'sandbox' as const };
const apnsTransport = ((origin: string) => {
  assert.equal(origin, 'https://api.sandbox.push.apple.com');
  const session = new EventEmitter() as any; session.destroy = () => {};
  session.request = (headers: any) => {
    assert.equal(headers['apns-topic'], apns.bundleId);
    assert.equal(headers[':path'], '/3/device/apple-token');
    const jwt = headers.authorization.slice(7).split('.');
    assert.ok(verify('SHA256', Buffer.from(jwt.slice(0, 2).join('.')), { key: ec.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(jwt[2], 'base64url')));
    const request = new EventEmitter() as any;
    request.end = (body: string) => {
      assert.equal(JSON.parse(body).deepLink.id, 't1');
      queueMicrotask(() => { request.emit('response', { ':status': 410 }); request.emit('data', JSON.stringify({ reason: 'Unregistered' })); request.emit('end'); });
    };
    return request;
  };
  return session;
}) as any;
assert.equal((await deliverPush({ platforms: ['ios'], apns }, 'apns', 'apple-token', event, http, apnsTransport)).invalidToken, true);

const successfulApnsTransport = (() => {
  const session = new EventEmitter() as any; session.destroy = () => {};
  session.request = () => {
    const request = new EventEmitter() as any;
    request.end = () => queueMicrotask(() => { request.emit('response', { ':status': 200 }); request.emit('end'); });
    return request;
  };
  return session;
}) as any;
assert.equal((await deliverPush({ platforms: ['ios'], apns }, 'apns', 'apple-token', event, http, successfulApnsTransport)).status, 'sent');

const captured: Array<{ token: string; eventId: string }> = [];
const flow = new PushEngine(apps, join(dir, 'flow.sqlite'), async (_app, _provider, token, message) => {
  captured.push({ token, eventId: message.eventId }); return { status: 'sent', code: 'MOCK_ACCEPTED' };
});
flow.register(alice, registration);
flow.register(alice, { ...registration, platform: 'ios', installationId: 'iphone', provider: 'apns', token: 'a'.repeat(64) });
flow.register(bob, { ...registration, installationId: 'bob-phone', token: 'bob-device' });
flow.accept(broadcast); flow.accept(broadcast); await flow.drain();
assert.equal(captured.length, 2, 'One delivery for each active recipient device, excluding another user');
assert.ok(captured.every(x => x.eventId === broadcast.eventId && x.token !== 'bob-device'));
assert.equal(flow.overview().deliveries.filter((x: any) => x.status === 'sent').length, 2);
flow.close();

const recoveryFile = join(dir, 'recovery.sqlite');
let recovery = new PushEngine(apps, recoveryFile);
recovery.register(alice, registration); recovery.accept(event); recovery.close();
recovery = new PushEngine(apps, recoveryFile, async () => ({ status: 'sent', code: 'RECOVERED' }));
await recovery.drain();
assert.equal((recovery.overview().deliveries[0] as any).code, 'RECOVERED', 'Unsent queue survives process restart');
recovery.close();

const relayCalls: { url: string; method: string }[] = [];
const upstream = createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.url === '/api/mobile/v1/auth/me' && req.headers.authorization === 'Bearer alice-token') res.end(JSON.stringify(alice));
  else if (req.url === '/api/mobile/v1/auth/me' && req.headers.authorization === 'Bearer bob-token') res.end(JSON.stringify(bob));
  else if (req.url?.startsWith('/api/v2/') && req.headers['x-api-key'] === 'fixture') {
    relayCalls.push({ url: req.url, method: req.method || '' });
    res.end(JSON.stringify({ users: [{ id: 'eligible-user', name: 'Eligible user' }] }));
  } else { res.statusCode = 401; res.end('{}'); }
});
upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
await writeFile(join(dir, 'hub-config.json'), JSON.stringify({ anyfloBaseUrl: `http://127.0.0.1:${(upstream.address() as any).port}`, apiKeyName: 'fixture', anyfloApiKey: 'fixture' }));
const child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], { cwd: process.cwd(), env: { ...process.env, PORT: '0', DATA_DIR: dir, MOBILE_HUB_WEBHOOK_SECRET: 'test-secret', PUSH_APPS_JSON: JSON.stringify(apps) }, stdio: ['ignore', 'pipe', 'pipe'] });
try {
  const port = await listening(child);
  const url = `http://127.0.0.1:${port}`;
  const post = (path: string, body: unknown, headers = {}) => fetch(url + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const mentionPath = '/tickets/fixture-ticket/mention-candidates?search=Ana%20Maria&limit=7';
  assert.equal((await fetch(url + '/api/mobile/v1/v2' + mentionPath)).status, 401);
  assert.equal(relayCalls.length, 0);
  const candidates = await fetch(url + '/api/mobile/v1/v2' + mentionPath, { headers: { authorization: 'Bearer alice-token' } });
  assert.equal(candidates.status, 200);
  assert.deepEqual(await candidates.json(), { users: [{ id: 'eligible-user', name: 'Eligible user' }] });
  assert.equal(relayCalls.length, 1);
  assert.equal(relayCalls[0].method, 'GET');
  const forwardedMention = new URL(relayCalls[0].url, 'http://fixture');
  assert.equal(forwardedMention.pathname, '/api/v2/tickets/fixture-ticket/mention-candidates');
  assert.deepEqual([...forwardedMention.searchParams], [['search', 'Ana Maria'], ['limit', '7']]);
  for (const path of ['/tickets/fixture-ticket/mention-candidates/extra', '/tickets/fixture-ticket/arbitrary', '/users']) {
    assert.equal((await fetch(url + '/api/mobile/v1/v2' + path, { headers: { authorization: 'Bearer alice-token' } })).status, 404);
  }
  assert.equal((await post('/api/mobile/v1/v2/tickets/fixture-ticket/mention-candidates', {}, { authorization: 'Bearer alice-token' })).status, 404);
  assert.equal(relayCalls.length, 1);
  assert.equal((await post('/admin/v2/request', { method: 'GET', path: mentionPath })).status, 200);
  assert.deepEqual(relayCalls[1], { url: '/api/v2' + mentionPath, method: 'GET' });
  assert.equal((await post('/internal/events/mobile-notification', event)).status, 401);
  assert.equal((await post('/internal/events/mobile-notification', event, { 'X-AnyFlo-Hub-Secret': 'wrong' })).status, 401);
  assert.equal((await post('/internal/events/mobile-notification', {}, { 'X-AnyFlo-Hub-Secret': 'test-secret' })).status, 400);
  assert.equal((await fetch(url + '/internal/events/mobile-notification', { method: 'POST', headers: { 'X-AnyFlo-Hub-Secret': 'test-secret', 'content-type': 'text/plain' }, body: '{}' })).status, 415);
  assert.equal((await fetch(url + '/internal/events/mobile-notification', { method: 'POST', headers: { 'X-AnyFlo-Hub-Secret': 'test-secret', 'content-type': 'application/json' }, body: '{' })).status, 400);
  assert.equal((await post('/api/mobile/v1/devices', registration)).status, 401);
  const device = await (await post('/api/mobile/v1/devices', registration, { authorization: 'Bearer alice-token' })).json() as any;
  assert.ok(device.id);
  assert.equal((await post('/api/mobile/v1/devices', registration, { authorization: 'Bearer bob-token' })).status, 409);
  assert.equal((await fetch(`${url}/api/mobile/v1/devices/${device.id}`, { method: 'DELETE', headers: { authorization: 'Bearer bob-token' } })).status, 404);
  const replies = await Promise.all(Array.from({ length: 10 }, () => post('/internal/events/mobile-notification', event, { 'X-AnyFlo-Hub-Secret': 'test-secret' })));
  assert.equal(replies.filter(r => r.status === 202).length, 1);
  assert.equal(replies.filter(r => r.status === 200).length, 9);
  assert.equal((await post('/internal/events/mobile-notification', { ...event, title: 'Changed payload' }, { 'X-AnyFlo-Hub-Secret': 'test-secret' })).status, 409);
  assert.equal((await post('/api/mobile/v1/devices', { ...registration, userId: 'bob' }, { authorization: 'Bearer alice-token' })).status, 400);
  const summary = await (await fetch(url + '/admin/push')).text();
  assert.ok(!summary.includes('fcm-token-1')); assert.ok(!summary.includes('test-secret'));
  assert.ok(!summary.includes(alice.email));
  const receipts = JSON.parse(summary).receipts;
  assert.equal(receipts.filter((x: any) => x.eventId === event.eventId && x.outcome === 'accepted').length, 1);
  assert.equal(receipts.filter((x: any) => x.eventId === event.eventId && x.outcome === 'duplicate').length, 9);
  assert.ok(receipts.some((x: any) => x.outcome === 'rejected' && x.reason === 'SECRET_INVALID'));
  assert.ok(receipts.some((x: any) => x.outcome === 'rejected' && x.reason === 'EVENT_ID_CONFLICT'));
  assert.ok(receipts.filter((x: any) => x.eventId === event.eventId).every((x: any) => x.recipientRef.startsWith('sha256:')));
  const page = await (await fetch(url + '/')).text();
  assert.ok(page.includes('AnyFlo event reception'));
  const guide = await (await fetch(url + '/agent-guide')).json() as any;
  assert.equal(guide.push.registerDevice, 'POST /api/mobile/v1/devices');
  const waitUntil = Date.now() + 4000;
  let deliveryStatus = '';
  while (Date.now() < waitUntil) {
    const status = await (await fetch(url + '/admin/push')).json() as any;
    deliveryStatus = status.deliveries.find((x: any) => x.eventId === event.eventId)?.status;
    if (deliveryStatus === 'not_configured') break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(deliveryStatus, 'not_configured', 'HTTP accepted event reaches the asynchronous worker and records provider configuration gap');
  assert.equal((await post('/admin/push/test-event', { scenario: 'all' })).status, 400);
  assert.equal((await post('/admin/push/test-event', { scenario: 'all' }, { 'X-Hub-Test': 'receiver', origin: 'https://untrusted.example' })).status, 403);
  assert.equal((await post('/admin/push/test-event', { scenario: 'invalid' }, { 'X-Hub-Test': 'receiver' })).status, 400);
  const uiTest = await (await post('/admin/push/test-event', { scenario: 'all' }, { 'X-Hub-Test': 'receiver' })).json() as any;
  assert.equal(uiTest.passed, true);
  assert.equal(uiTest.results.length, 3);
  assert.equal(uiTest.anyfloChanged, false);
  assert.ok(!JSON.stringify(uiTest).includes('test-secret'));
  assert.ok(uiTest.results.every((x: any) => x.payload.recipient.id === 'hub-ui-test-recipient' && x.accepted.httpStatus === 202 && x.duplicates.length === 3));
  assert.equal((await fetch(`${url}/api/mobile/v1/devices/${device.id}`, { method: 'DELETE', headers: { authorization: 'Bearer alice-token' } })).status, 200);
} finally {
  child.kill('SIGTERM'); await once(child, 'exit'); await new Promise<void>(resolve => upstream.close(() => resolve()));
}
const unavailable = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], { cwd: process.cwd(), env: { ...process.env, PORT: '0', DATA_DIR: dir, MOBILE_HUB_WEBHOOK_SECRET: '', MOBILE_HUB_AUTO_GENERATE_SECRET: 'false', PUSH_APPS_JSON: JSON.stringify(apps) }, stdio: ['ignore', 'pipe', 'pipe'] });
try {
  const port = await listening(unavailable);
  assert.equal((await fetch(`http://127.0.0.1:${port}/internal/events/mobile-notification`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 503);
} finally {
  unavailable.kill('SIGTERM'); await once(unavailable, 'exit'); await rm(dir, { recursive: true, force: true });
}
const generatedDir = await mkdtemp(join(tmpdir(), 'hub-secret-test-'));
const generatedEnv = { ...process.env, PORT: '0', DATA_DIR: generatedDir, MOBILE_HUB_WEBHOOK_SECRET: '', MOBILE_HUB_AUTO_GENERATE_SECRET: 'true', PUSH_APPS_JSON: '{}' };
const generated = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], { cwd: process.cwd(), env: generatedEnv, stdio: ['ignore', 'pipe', 'pipe'] });
try {
  const port = await listening(generated);
  const secretFile = join(generatedDir, 'mobile-hub-webhook-secret');
  const secretValue = await readFile(secretFile, 'utf8');
  assert.equal(secretValue.length, 64);
  assert.equal((await stat(secretFile)).mode & 0o777, 0o600);
  const info = await (await fetch(`http://127.0.0.1:${port}/admin/push`)).json() as any;
  assert.equal(info.webhookConfigured, true);
  assert.equal(info.webhookSecretFingerprint, `sha256:${createHash('sha256').update(secretValue).digest('hex')}`);
  assert.ok(!JSON.stringify(info).includes(secretValue));
  const verifier = spawn(process.execPath, ['--import', 'tsx', 'src/test-receiver.ts', `--url=http://127.0.0.1:${port}`], { cwd: process.cwd(), env: generatedEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; verifier.stdout.on('data', data => { output += data; });
  assert.equal((await once(verifier, 'exit'))[0], 0);
  const proof = JSON.parse(output);
  assert.equal(proof.fixtures.length, 3);
  assert.ok(proof.fixtures.every((x: any) => x.acceptedStatus === 202 && x.concurrentDuplicates === 6));
  assert.ok(!output.includes(secretValue));
} finally {
  generated.kill('SIGTERM'); await once(generated, 'exit'); await rm(generatedDir, { recursive: true, force: true });
}
console.log('Push receiver, ownership, persistence, concurrency, provider, and HTTP checks passed');
