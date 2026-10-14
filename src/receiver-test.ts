import { randomUUID } from 'node:crypto';
import { problem, webhookSecret } from './push.js';

export async function testReceiver(origin: string, scenario: string) {
  if (!['comment-mention', 'general-notification', 'broadcast', 'all'].includes(scenario)) problem('Invalid test scenario');
  const secret = webhookSecret();
  if (!secret) problem('Receiver secret is not configured', 503);
  const runId = randomUUID();
  const names = scenario === 'all' ? ['comment-mention', 'general-notification', 'broadcast'] : [scenario];
  const results = [];
  const request = async (body: unknown, authenticated = true) => {
    const response = await fetch(`${origin}/internal/events/mobile-notification`, { method: 'POST', headers: { 'content-type': 'application/json', ...(authenticated ? { 'X-AnyFlo-Hub-Secret': secret } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
    return { httpStatus: response.status, result: await response.json() as any };
  };
  for (const name of names) {
    const kind = name === 'broadcast' ? 'broadcast' : 'ticket';
    const id = `hub-ui-test-${name}-${runId}`;
    const payload = { eventId: id, eventType: kind === 'broadcast' ? 'broadcast.published' : 'notification.created', occurredAt: new Date().toISOString(), recipient: { id: 'hub-ui-test-recipient', email: 'hub-ui-test@example.invalid' }, title: 'Hub UI test', body: `Synthetic ${name} verification. No AnyFlo change or real recipient.`, resource: { type: kind, id, ...(kind === 'ticket' ? { workflowId: 'hub-ui-test-workflow' } : {}) }, deepLink: { route: kind, id } };
    const accepted = await request(payload);
    const duplicates = await Promise.all(Array.from({ length: 3 }, () => request(payload)));
    results.push({ scenario: name, payload, accepted, duplicates, passed: accepted.httpStatus === 202 && duplicates.every(x => x.httpStatus === 200 && x.result.duplicate === true) });
  }
  const invalid = await request({});
  const unauthorized = await request({}, false);
  return { runId, scope: 'Hub-only receiver test; no AnyFlo publisher or mobile push verification', transport: 'server loopback HTTP', anyfloChanged: false, results, invalidPayload: invalid, missingSecret: unauthorized, passed: results.every(x => x.passed) && invalid.httpStatus === 400 && unauthorized.httpStatus === 401 };
}
