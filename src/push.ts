import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { deliverPush, type PushApps, type PushMessage, type PushResult } from './push-providers.js';

type User = { id: string; email: string };
export type NotificationEvent = PushMessage & {
  eventType: 'notification.created' | 'broadcast.published'; occurredAt: string; recipient: User;
  resource: { type: 'ticket' | 'broadcast'; id: string; workflowId?: string };
  deepLink: { route: 'ticket' | 'broadcast'; id: string };
};
export function problem(message: string, status = 400): never { throw Object.assign(new Error(message), { status }); }
function text(value: unknown, name: string, max = 512): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f]/.test(value)) problem(`Invalid ${name}`);
  return value as string;
}
export function verifyWebhookSecret(header: unknown, expected: string | undefined) {
  if (!expected) problem('Notification webhook secret is not configured', 503);
  if (typeof header !== 'string') problem('Invalid webhook secret', 401);
  const a = createHash('sha256').update(header as string).digest();
  const b = createHash('sha256').update(expected as string).digest();
  if (!timingSafeEqual(a, b)) problem('Invalid webhook secret', 401);
}
export function validateEvent(input: any): NotificationEvent {
  if (!input || typeof input !== 'object' || Array.isArray(input)) problem('Notification event must be an object');
  if (!['notification.created', 'broadcast.published'].includes(input.eventType)) problem('Unsupported eventType');
  const kind = input.eventType === 'notification.created' ? 'ticket' : 'broadcast';
  const eventId = text(input.eventId, 'eventId');
  const occurredAt = text(input.occurredAt, 'occurredAt', 40);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(occurredAt) || !Number.isFinite(Date.parse(occurredAt))) problem('Invalid occurredAt');
  const recipient = { id: text(input.recipient?.id, 'recipient.id'), email: text(input.recipient?.email, 'recipient.email', 320) };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient.email)) problem('Invalid recipient.email');
  const resource = { type: kind, id: text(input.resource?.id, 'resource.id'), ...(input.resource?.workflowId === undefined ? {} : { workflowId: text(input.resource.workflowId, 'resource.workflowId') }) } as NotificationEvent['resource'];
  if (input.resource?.type !== kind || input.deepLink?.route !== kind || input.deepLink?.id !== resource.id) problem('resource/deepLink does not match eventType');
  const title = text(input.title, 'title', 300);
  if (typeof input.body !== 'string' || input.body.length > 2000 || /\u0000/.test(input.body)) problem('Invalid body (maximum 2000 characters)');
  const event = { eventId, eventType: input.eventType, occurredAt, recipient, title, body: input.body, resource, deepLink: { route: kind, id: resource.id } } as NotificationEvent;
  if (Buffer.byteLength(JSON.stringify({ title, body: event.body, deepLink: event.deepLink, resource, eventId })) > 3200) problem('Notification exceeds push payload size limit');
  return event;
}

export class PushEngine {
  readonly db: DatabaseSync;
  private draining = false;
  private timer?: ReturnType<typeof setInterval>;
  constructor(private apps: PushApps, file: string, private sender = deliverPush) {
    this.db = new DatabaseSync(file);
    if (file !== ':memory:') chmodSync(file, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, app_id TEXT NOT NULL, platform TEXT NOT NULL,
        provider TEXT NOT NULL, installation_id TEXT NOT NULL, token TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL, UNIQUE(app_id, platform, installation_id), UNIQUE(app_id, provider, token)
      );
      CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, hash TEXT NOT NULL, payload TEXT NOT NULL, received_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS deliveries (
        id TEXT PRIMARY KEY, event_id TEXT NOT NULL, device_id TEXT, status TEXT NOT NULL, code TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(event_id, device_id)
      );
      CREATE INDEX IF NOT EXISTS device_recipient ON devices(user_id, active);
      CREATE INDEX IF NOT EXISTS delivery_queue ON deliveries(status);
    `);
  }
  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  register(user: User, input: any) {
    if (!input || typeof input !== 'object' || ['userId', 'user', 'email', 'recipient', 'ownerId'].some(k => k in input)) problem('Device owner is derived only from Mobile Admission');
    const appId = text(input.applicationId, 'applicationId', 100);
    const platform = text(input.platform, 'platform', 10);
    const provider = input.provider || (platform === 'ios' ? 'apns' : 'fcm');
    const app = Object.hasOwn(this.apps, appId) ? this.apps[appId] : undefined;
    if (!app || !app.platforms.includes(platform as any)) problem('Application/platform is not registered');
    if (!['fcm', 'apns'].includes(provider) || (provider === 'apns' && platform !== 'ios')) problem('Invalid push provider');
    const installation = text(input.installationId, 'installationId', 200);
    const token = text(input.token, 'token', 4096);
    if (provider === 'apns' && !/^[a-fA-F0-9]{64}$/.test(token)) problem('Invalid APNs token');
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT * FROM devices WHERE app_id=? AND platform=? AND installation_id=?').get(appId, platform, installation) as any;
      const tokenOwner = this.db.prepare('SELECT * FROM devices WHERE app_id=? AND provider=? AND token=?').get(appId, provider, token) as any;
      if ((existing && existing.user_id !== user.id) || (tokenOwner && tokenOwner.user_id !== user.id)) problem('Device is registered to another user; unregister before switching accounts', 409);
      if (tokenOwner && tokenOwner.id !== existing?.id) problem('Token is already bound to another installation', 409);
      const id = existing?.id || randomUUID();
      this.db.prepare(`INSERT INTO devices (id,user_id,app_id,platform,provider,installation_id,token,active,updated_at) VALUES (?,?,?,?,?,?,?,1,?)
        ON CONFLICT(id) DO UPDATE SET token=excluded.token,provider=excluded.provider,active=1,updated_at=excluded.updated_at`).run(id, user.id, appId, platform, provider, installation, token, new Date().toISOString());
      return { id, applicationId: appId, platform, provider, active: true };
    });
  }
  unregister(user: User, id: string) {
    const result = this.db.prepare('DELETE FROM devices WHERE id=? AND user_id=?').run(id, user.id);
    if (!result.changes) problem('Device not found', 404);
    return { unregistered: true };
  }
  accept(event: NotificationEvent) {
    const payload = JSON.stringify(event); const hash = createHash('sha256').update(payload).digest('hex');
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT hash FROM events WHERE id=?').get(event.eventId) as any;
      if (existing) {
        if (existing.hash !== hash) problem('eventId already exists with different payload', 409);
        return { accepted: true, duplicate: true, eventId: event.eventId };
      }
      const now = new Date().toISOString();
      this.db.prepare('INSERT INTO events VALUES (?,?,?,?)').run(event.eventId, hash, payload, now);
      const devices = this.db.prepare('SELECT id FROM devices WHERE user_id=? AND active=1').all(event.recipient.id) as any[];
      const insert = this.db.prepare('INSERT INTO deliveries VALUES (?,?,?,?,?,?,?)');
      for (const device of devices) insert.run(randomUUID(), event.eventId, device.id, 'pending', null, now, now);
      if (!devices.length) insert.run(randomUUID(), event.eventId, null, 'no_devices', 'NO_ACTIVE_DEVICES', now, now);
      return { accepted: true, duplicate: false, eventId: event.eventId };
    });
  }
  async drain() {
    if (this.draining) return;
    this.draining = true;
    try {
      for (let n = 0; n < 100; n++) {
        const row = this.transaction(() => {
          const item = this.db.prepare(`SELECT l.id,l.event_id,l.device_id,e.payload FROM deliveries l JOIN events e ON e.id=l.event_id WHERE l.status='pending' ORDER BY l.created_at LIMIT 1`).get() as any;
          if (item) this.db.prepare("UPDATE deliveries SET status='sending',updated_at=? WHERE id=?").run(new Date().toISOString(), item.id);
          return item;
        });
        if (!row) break;
        const event = JSON.parse(row.payload) as NotificationEvent;
        const device = this.db.prepare('SELECT * FROM devices WHERE id=? AND active=1 AND user_id=?').get(row.device_id, event.recipient.id) as any;
        let result: PushResult;
        try { result = device ? await this.sender(this.apps[device.app_id], device.provider, device.token, event) : { status: 'failed', code: 'DEVICE_INACTIVE' }; }
        catch { result = { status: 'failed', code: 'PROVIDER_REQUEST_FAILED' }; }
        this.transaction(() => {
          this.db.prepare('UPDATE deliveries SET status=?,code=?,updated_at=? WHERE id=?').run(result.status, result.code, new Date().toISOString(), row.id);
          if (result.invalidToken && device) this.db.prepare('UPDATE devices SET active=0 WHERE id=? AND token=?').run(device.id, device.token);
        });
      }
    } finally { this.draining = false; }
  }
  start() {
    // An interrupted provider request may already have delivered: never resend it automatically.
    this.db.prepare("UPDATE deliveries SET status='failed',code='DELIVERY_OUTCOME_UNKNOWN',updated_at=? WHERE status='sending'").run(new Date().toISOString());
    this.timer = setInterval(() => { void this.drain().catch(() => console.error('Push queue processing failed')); }, 1000);
    this.timer.unref();
  }
  overview() {
    return {
      webhookConfigured: Boolean(process.env.MOBILE_HUB_WEBHOOK_SECRET),
      applications: Object.entries(this.apps).map(([id, app]) => ({ id, platforms: app.platforms, fcmConfigured: Boolean(app.fcm), apnsConfigured: Boolean(app.apns) })),
      devices: this.db.prepare('SELECT app_id AS applicationId,platform,provider,active,count(*) AS count FROM devices GROUP BY app_id,platform,provider,active').all(),
      deliveries: this.db.prepare('SELECT id,event_id AS eventId,status,code,created_at AS createdAt,updated_at AS updatedAt FROM deliveries ORDER BY created_at DESC LIMIT 100').all(),
    };
  }
  close() { if (this.timer) clearInterval(this.timer); this.db.close(); }
}
export function createPushEngine(apps: PushApps) {
  const dir = process.env.DATA_DIR || '/data'; mkdirSync(dir, { recursive: true, mode: 0o700 });
  return new PushEngine(apps, join(dir, 'push.sqlite'));
}
