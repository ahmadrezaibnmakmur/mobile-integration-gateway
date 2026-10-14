import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, verify } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once, EventEmitter } from 'node:events';
import { PushEngine, validateEvent, verifyWebhookSecret } from './push.js';
import { deliverPush, type PushApps } from './push-providers.js';

const dir = await mkdtemp(join(tmpdir(), 'hub-push-test-'));
const apps: PushApps = { demo: { platforms: ['android', 'ios'] } };
const alice = { id: 'alice', email: 'alice@example.com' };
const bob = { id: 'bob', email: 'bob@example.com' };
const event = validateEvent({ eventId: 'event-1', eventType: 'notification.created', occurredAt: new Date().toISOString(), recipient: alice, title: 'A title', body: 'A message\nwith line break', resource: { type: 'ticket', id: 't1', workflowId: 'w1' }, deepLink: { route: 'ticket', id: 't1' } });
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

const upstream = createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.url === '/api/mobile/v1/auth/me' && req.headers.authorization === 'Bearer alice-token') res.end(JSON.stringify(alice));
  else { res.statusCode = 401; res.end('{}'); }
});
upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
await writeFile(join(dir, 'hub-config.json'), JSON.stringify({ anyfloBaseUrl: `http://127.0.0.1:${(upstream.address() as any).port}`, apiKeyName: 'fixture', anyfloApiKey: 'fixture' }));
const child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], { cwd: process.cwd(), env: { ...process.env, PORT: '0', DATA_DIR: dir, MOBILE_HUB_WEBHOOK_SECRET: 'test-secret', PUSH_APPS_JSON: JSON.stringify(apps) }, stdio: ['ignore', 'pipe', 'pipe'] });
try {
  const port = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Hub startup timeout')), 10_000);
    child.once('exit', () => { clearTimeout(timeout); reject(new Error('Hub exited before startup')); });
    child.stdout.on('data', data => { const match = data.toString().match(/listening on :(\d+)/); if (match) { clearTimeout(timeout); resolve(match[1]); } });
  });
  const url = `http://127.0.0.1:${port}`;
  const post = (path: string, body: unknown, headers = {}) => fetch(url + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  assert.equal((await post('/internal/events/mobile-notification', event)).status, 401);
  assert.equal((await post('/internal/events/mobile-notification', {}, { 'X-AnyFlo-Hub-Secret': 'test-secret' })).status, 400);
  assert.equal((await post('/api/mobile/v1/devices', registration)).status, 401);
  const device = await (await post('/api/mobile/v1/devices', registration, { authorization: 'Bearer alice-token' })).json() as any;
  assert.ok(device.id);
  const replies = await Promise.all(Array.from({ length: 10 }, () => post('/internal/events/mobile-notification', event, { 'X-AnyFlo-Hub-Secret': 'test-secret' })));
  assert.equal(replies.filter(r => r.status === 202).length, 1);
  assert.equal(replies.filter(r => r.status === 200).length, 9);
  assert.equal((await post('/api/mobile/v1/devices', { ...registration, userId: 'bob' }, { authorization: 'Bearer alice-token' })).status, 400);
  const summary = await (await fetch(url + '/admin/push')).text();
  assert.ok(!summary.includes('fcm-token-1')); assert.ok(!summary.includes('test-secret'));
  assert.equal((await fetch(`${url}/api/mobile/v1/devices/${device.id}`, { method: 'DELETE', headers: { authorization: 'Bearer alice-token' } })).status, 200);
} finally {
  child.kill('SIGTERM'); await once(child, 'exit'); await new Promise<void>(resolve => upstream.close(() => resolve()));
  await rm(dir, { recursive: true, force: true });
}
console.log('Push receiver, ownership, persistence, concurrency, provider, and HTTP checks passed');
