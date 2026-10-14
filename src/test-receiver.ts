import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { webhookSecret } from './push.js';

// Run inside the Hub container: the shared secret never leaves its server-side storage except in the HTTPS header.
const target = process.argv.find(x => x.startsWith('--url='))?.slice(6) || `http://127.0.0.1:${process.env.PORT || 3000}`;
const url = new URL(target);
if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname))) throw new Error('Use HTTPS or loopback HTTP for receiver verification');
const secret = webhookSecret();
if (!secret) throw new Error('Hub webhook secret is not configured');
const endpoint = `${url.origin}/internal/events/mobile-notification`;
const runId = randomUUID();
const occurredAt = new Date().toISOString();
const scenarios = [
  { name: 'comment-mention', type: 'notification.created', kind: 'ticket' },
  { name: 'general-notification', type: 'notification.created', kind: 'ticket' },
  { name: 'broadcast', type: 'broadcast.published', kind: 'broadcast' },
];
const evidence = [];
for (const scenario of scenarios) {
  const id = `hub-only-${scenario.name}-${runId}`;
  const event = { eventId: id, eventType: scenario.type, occurredAt, recipient: { id: 'hub-only-test-recipient', email: 'hub-only-test@example.invalid' }, title: 'Hub-only reception verification', body: `Synthetic ${scenario.name} fixture; no AnyFlo mutation or mobile delivery.`, resource: { type: scenario.kind, id, ...(scenario.kind === 'ticket' ? { workflowId: 'hub-only-test-workflow' } : {}) }, deepLink: { route: scenario.kind, id } };
  const post = () => fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', 'X-AnyFlo-Hub-Secret': secret }, body: JSON.stringify(event), signal: AbortSignal.timeout(15_000) });
  const first = await post(); assert.equal(first.status, 202, 'New fixture should be accepted');
  const receipt = await first.json() as any;
  const retries = await Promise.all(Array.from({ length: 6 }, () => post()));
  assert.ok(retries.every(x => x.status === 200), 'Concurrent retries must be duplicates');
  for (const response of retries) assert.equal((await response.json() as any).duplicate, true);
  evidence.push({ scenario: scenario.name, eventType: scenario.type, eventId: id, receiptId: receipt.receiptId, acceptedStatus: first.status, concurrentDuplicates: retries.length });
}
const invalid = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', 'X-AnyFlo-Hub-Secret': secret }, body: '{}', signal: AbortSignal.timeout(15_000) });
assert.equal(invalid.status, 400);
const unauthorized = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(15_000) });
assert.equal(unauthorized.status, 401);
console.log(JSON.stringify({ target: url.origin, runId, occurredAt, fixtures: evidence, invalidPayloadStatus: invalid.status, missingSecretStatus: unauthorized.status, anyfloChanged: false }, null, 2));
