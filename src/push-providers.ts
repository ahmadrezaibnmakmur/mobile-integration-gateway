import { createSign } from 'node:crypto';
import { connect } from 'node:http2';

export type PushApp = {
  platforms: Array<'android' | 'ios'>;
  fcm?: { projectId: string; clientEmail: string; privateKey: string };
  apns?: { teamId: string; keyId: string; privateKey: string; bundleId: string; environment: 'sandbox' | 'production' };
};
export type PushApps = Record<string, PushApp>;
export type PushMessage = { eventId: string; title: string; body: string; deepLink: unknown; resource: unknown };
export type PushResult = { status: 'sent' | 'failed' | 'not_configured'; code: string; invalidToken?: boolean };

export function loadPushApps(): PushApps {
  const apps = JSON.parse(process.env.PUSH_APPS_JSON || '{}');
  if (!apps || Array.isArray(apps) || typeof apps !== 'object') throw new Error('PUSH_APPS_JSON must be an application map');
  for (const app of Object.values(apps) as PushApp[]) {
    if (!app || !Array.isArray(app.platforms) || !app.platforms.length || app.platforms.some(p => !['android', 'ios'].includes(p))) throw new Error('Push app platforms must contain android/ios');
    if (app.fcm && !['projectId', 'clientEmail', 'privateKey'].every(k => typeof (app.fcm as any)[k] === 'string' && (app.fcm as any)[k])) throw new Error('FCM configuration is incomplete');
    if (app.apns && (!['teamId', 'keyId', 'privateKey', 'bundleId'].every(k => typeof (app.apns as any)[k] === 'string' && (app.apns as any)[k]) || !['sandbox', 'production'].includes(app.apns.environment))) throw new Error('APNs configuration is incomplete');
  }
  return apps;
}
function signedJwt(header: object, claims: object, key: string, algorithm: 'RSA-SHA256' | 'SHA256') {
  const value = [header, claims].map(x => Buffer.from(JSON.stringify(x)).toString('base64url')).join('.');
  const signer = createSign(algorithm); signer.update(value); signer.end();
  return `${value}.${signer.sign({ key, ...(algorithm === 'SHA256' ? { dsaEncoding: 'ieee-p1363' as const } : {}) }).toString('base64url')}`;
}
const oauthTokens = new Map<string, { token: string; expires: number }>();
async function sendFcm(config: NonNullable<PushApp['fcm']>, token: string, message: PushMessage, http: typeof fetch): Promise<PushResult> {
  const cacheKey = `${config.projectId}:${config.clientEmail}:${config.privateKey}`;
  let cached = oauthTokens.get(cacheKey);
  if (!cached || cached.expires < Date.now() + 60_000) {
    const now = Math.floor(Date.now() / 1000);
    const assertion = signedJwt({ alg: 'RS256', typ: 'JWT' }, { iss: config.clientEmail, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }, config.privateKey, 'RSA-SHA256');
    const auth = await http('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }), signal: AbortSignal.timeout(10_000) });
    if (!auth.ok) return { status: 'failed', code: `FCM_AUTH_${auth.status}` };
    const data = await auth.json() as any;
    if (typeof data.access_token !== 'string') return { status: 'failed', code: 'FCM_AUTH_INVALID_RESPONSE' };
    cached = { token: data.access_token, expires: Date.now() + Number(data.expires_in || 3600) * 1000 }; oauthTokens.set(cacheKey, cached);
  }
  const response = await http(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(config.projectId)}/messages:send`, {
    method: 'POST', headers: { authorization: `Bearer ${cached.token}`, 'content-type': 'application/json' }, signal: AbortSignal.timeout(10_000),
    body: JSON.stringify({ message: { token, notification: { title: message.title, body: message.body }, data: { eventId: message.eventId, deepLink: JSON.stringify(message.deepLink), resource: JSON.stringify(message.resource) } } }),
  });
  if (response.ok) return { status: 'sent', code: 'FCM_ACCEPTED' };
  const data = await response.json().catch(() => ({})) as any;
  const errorCode = data.error?.details?.find((x: any) => x['@type'] === 'type.googleapis.com/google.firebase.fcm.v1.FcmError')?.errorCode;
  return { status: 'failed', code: errorCode === 'UNREGISTERED' ? 'FCM_UNREGISTERED' : `FCM_HTTP_${response.status}`, invalidToken: errorCode === 'UNREGISTERED' };
}
const apnsTokens = new Map<string, { token: string; expires: number }>();
async function sendApns(config: NonNullable<PushApp['apns']>, token: string, message: PushMessage): Promise<PushResult> {
  const cacheKey = `${config.teamId}:${config.keyId}:${config.privateKey}`;
  let cached = apnsTokens.get(cacheKey);
  if (!cached || cached.expires < Date.now()) {
    cached = { token: signedJwt({ alg: 'ES256', kid: config.keyId }, { iss: config.teamId, iat: Math.floor(Date.now() / 1000) }, config.privateKey, 'SHA256'), expires: Date.now() + 50 * 60_000 };
    apnsTokens.set(cacheKey, cached);
  }
  const jwt = cached.token;
  return new Promise(resolve => {
    const client = connect(config.environment === 'sandbox' ? 'https://api.sandbox.push.apple.com' : 'https://api.push.apple.com');
    let finished = false;
    const done = (result: PushResult) => { if (finished) return; finished = true; clearTimeout(timer); client.destroy(); resolve(result); };
    const timer = setTimeout(() => done({ status: 'failed', code: 'APNS_TIMEOUT' }), 10_000);
    client.on('error', () => done({ status: 'failed', code: 'APNS_CONNECTION_ERROR' }));
    const request = client.request({ ':method': 'POST', ':path': `/3/device/${token}`, authorization: `bearer ${jwt}`, 'apns-topic': config.bundleId, 'apns-push-type': 'alert', 'apns-priority': '10' });
    let status = 0; let body = '';
    request.on('response', headers => { status = Number(headers[':status']); });
    request.on('data', chunk => { body += chunk; });
    request.on('error', () => done({ status: 'failed', code: 'APNS_REQUEST_ERROR' }));
    request.on('end', () => {
      let reason = ''; try { reason = JSON.parse(body).reason; } catch { /* Provider returned no reason. */ }
      const invalidToken = ['Unregistered', 'BadDeviceToken', 'DeviceTokenNotForTopic'].includes(reason);
      done(status === 200 ? { status: 'sent', code: 'APNS_ACCEPTED' } : { status: 'failed', code: invalidToken ? `APNS_${reason}` : `APNS_HTTP_${status}`, invalidToken });
    });
    request.end(JSON.stringify({ aps: { alert: { title: message.title, body: message.body }, sound: 'default' }, eventId: message.eventId, deepLink: message.deepLink, resource: message.resource }));
  });
}
export async function deliverPush(app: PushApp | undefined, provider: string, token: string, message: PushMessage, http: typeof fetch = fetch): Promise<PushResult> {
  try {
    if (provider === 'fcm' && app?.fcm) return await sendFcm(app.fcm, token, message, http);
    if (provider === 'apns' && app?.apns) return await sendApns(app.apns, token, message);
    return { status: 'not_configured', code: 'PROVIDER_NOT_CONFIGURED' };
  } catch { return { status: 'failed', code: 'PROVIDER_REQUEST_FAILED' }; }
}
