# Mobile Integration Hub — reusable deployment and secret operations

## Scope and deployment boundary

Hub is a separate Android/iOS integration service, not an AnyFlo database or a business-specific workflow backend. AnyFlo owns workflows and data. Hub stores the server API key, relays supported API V2 calls, proxies Mobile Admission, and receives notification events. Do not deploy per-workflow modules or copy AnyFlo's database into Hub.

This guide describes the current implementation, not proposed capabilities. Hub currently accepts **one webhook secret**; there is no old/new overlap window. Provider delivery needs separately configured FCM/APNs credentials and registered devices.

## Easypanel manifest

| Setting | Required value or decision |
|---|---|
| Project/service | A separate project and app service; choose deployment-specific names |
| Source | Authorized Git repository and reviewed release commit/branch |
| Build | Repository root, Dockerfile; Node 22 Alpine supplied by the repository |
| Internal HTTP port | `3000` |
| Replicas | `1`; SQLite and the current worker are not a multi-replica design |
| Persistent storage | Named persistent volume mounted at `/data`, provisioned **before first start** |
| Environment | `NODE_ENV=production`, `PORT=3000`, `DATA_DIR=/data`, `HUB_PUBLIC_URL=https://<hub-origin>` |
| Public TLS | Valid HTTPS origin for mobile runtime and AnyFlo event reception |
| Console protection | Private network or reverse-proxy access control for `/`, `/admin/*`, and the administrator control plane |
| Egress | HTTPS access to AnyFlo and configured push providers |
| Backup | Protected backup of `/data`; use a SQLite-aware backup or stop the service before copying database files |

The application console currently has no login. A public HTTPS domain alone is **not** adequate administrator protection. Do not expose administrator routes to mobile users. Proxy protection must preserve access to authorized runtime/event routes. Check protection externally before storing a real API key.

`/data` contains `hub-config.json` (AnyFlo credential), `mobile-hub-webhook-secret`, and `push.sqlite` plus SQLite companion files. Treat the whole volume and its backups as confidential. Rebuilds must reuse it; a new volume does not preserve credentials, device registrations, receipts, or deduplication.

## Initial deployment order

1. Protect the console, attach the volume, configure the manifest, and deploy Hub.
2. In Hub connection UI, save the **AnyFlo application origin**, API key label, and server API key. Runtime code currently sends `x-api-key`; the label does not select a different header. Start disconnected; do not add fallback or sample credentials.
3. Use Test connection, Load workflows, and a dictionary read to verify the correct deployment. Avoid create/update requests on real records during discovery.
4. Obtain the Hub webhook secret privately using the server procedure below. Compare its fingerprint with Hub diagnostics.
5. Configure the AnyFlo publisher: `MOBILE_HUB_ENABLED=true`, `MOBILE_HUB_URL=https://<hub-origin>` (origin only), and matching `MOBILE_HUB_WEBHOOK_SECRET`. Restart/redeploy AnyFlo to apply its environment.
6. Run Hub **Test Event → All scenarios → Run Test**. Confirm accepted events, recognized duplicates, and rejected invalid/unauthenticated requests.
7. Trigger a controlled real AnyFlo mention/broadcast. Match its source event ID with an accepted Hub receipt. UI synthetic tests alone do not prove AnyFlo publication or public network reachability.
8. Configure platform push credentials and device registration separately; verify delivery on an actual Android/iOS installation. `no_devices` means reception succeeded but no device was available—not successful push delivery.

Mobile Admission requires AnyFlo's Google/JWT configuration, an existing admitted user, and verified App/Universal Links. These secrets remain on AnyFlo, not Hub or the APK. A readiness report does not replace live OAuth callback testing.

## Webhook secret bootstrap and precedence

On startup, Hub uses `MOBILE_HUB_WEBHOOK_SECRET` if nonempty. Otherwise it reads `/data/mobile-hub-webhook-secret`. If neither exists and `MOBILE_HUB_AUTO_GENERATE_SECRET` is not `false`, Hub generates **32 CSPRNG random bytes**, encodes them as 64 hex characters, and creates the persistent file with permission `0600`. Existing values are not regenerated on ordinary restarts.

Use one authoritative location: preferably the persistent bootstrap file. An environment override takes precedence, so replacing the file while an override exists does **not** rotate the active secret. Never configure two different values and assume the file wins.

Do not print the secret, put it in Git, chat, screenshots, URLs, shell history, deployment logs, or browser-visible diagnostic responses. Use protected file transfer or a secret manager for handoff; do not use `cat`, `echo`, or command-line secret arguments. A temporary handoff must be owned by the operator, mode `0600`, inside a mode `0700` directory. Remove it after verified consumption.

### Safe generation / handoff

Run on the authorized server or operator machine with Node.js. This prints **only path and fingerprint**; it does not activate the secret. A local `/tmp` path is not automatically available inside the VPS/container.

```sh
node --input-type=module -e '
import fs from "node:fs";
import { randomBytes, createHash } from "node:crypto";
const dir = fs.mkdtempSync("/tmp/mobile-hub-handoff-");
fs.chmodSync(dir, 0o700);
const secret = randomBytes(32).toString("hex");
const path = `${dir}/mobile-hub-webhook-secret`;
fs.writeFileSync(path, secret, { mode: 0o600, flag: "wx" });
console.log(JSON.stringify({path, fingerprint: `sha256:${createHash("sha256").update(secret).digest("hex")}`}));
'
```

Protect that file during transfer. When using file-backed configuration, an authorized operator can install the transferred file atomically in the Hub container/volume with the following pattern. Replace the input path with the verified transferred path; do not paste the secret itself.

```sh
node --input-type=module -e '
import fs from "node:fs";
const secret = fs.readFileSync("/protected/path/mobile-hub-webhook-secret", "utf8").trim();
if (!/^[a-f0-9]{64}$/.test(secret)) throw new Error("Expected generated 32-byte hex secret");
fs.writeFileSync("/data/mobile-hub-webhook-secret.rotation", secret, {mode: 0o600, flag: "wx"});
fs.renameSync("/data/mobile-hub-webhook-secret.rotation", "/data/mobile-hub-webhook-secret");
'
```

The generated hex text—not decoded raw bytes—is the shared secret. AnyFlo must receive exactly that text. Do not change an environment override to file-backed mode until both sides and the active fingerprint have been checked.

### Fingerprint verification

Use SHA-256 of the UTF-8 secret text, without a trailing newline. Hub exposes `webhookSecretFingerprint` through sanitized `/admin/push` diagnostics. On each server, compute the fingerprint privately from the actual active source; never use a screenshot placeholder or a stale handoff file as proof of configuration.

```sh
node --input-type=module -e '
import fs from "node:fs";
import { createHash } from "node:crypto";
const secret = process.env.MOBILE_HUB_WEBHOOK_SECRET || fs.readFileSync("/data/mobile-hub-webhook-secret", "utf8").trim();
console.log(`sha256:${createHash("sha256").update(secret).digest("hex")}`);
'
```

Fingerprint equality confirms matching values, not a working network or publisher. Require a real source receipt afterward.

## Rotation and rollback

1. Confirm authority, correct staging/production targets, and the active source on **both** services. Retain the previous secret privately only if policy permits rollback; never record its value in the runbook.
2. Generate a new protected handoff and record its non-secret fingerprint. Ensure the AnyFlo operator has it before switching Hub.
3. Plan a brief coordinated window. Current Hub supports one secret only; old requests are rejected after switch. Do not claim zero downtime. Check AnyFlo retry behavior rather than assuming delivery will recover automatically.
4. Replace Hub's authoritative source. File-backed reads occur on each request: atomic file replacement takes effect immediately. Environment-backed changes require service restart/redeploy. Record switch time and fingerprint.
5. Immediately replace AnyFlo's authoritative publisher secret and restart/redeploy it. Avoid duplicate legacy secret configuration; do not delete unrelated variables.
6. Verify the active fingerprint on both sides, Hub UI receiver tests, and a controlled real AnyFlo event. Watch `SECRET_INVALID`, persistence errors, and delivery status.
7. Delete the one-time handoff after confirmed consumption. If compromise motivated rotation, do not restore the compromised old secret; generate another new secret if needed.

For ordinary non-compromise rollback, restore the protected previous authoritative secret on **both** sides, restart environment-backed services, and verify fingerprint plus real event reception. Do not roll back only one service or reset/delete SQLite: that would lose deduplication/device/audit state. Failed events may require source-side retry; confirm their IDs and outcomes before replaying.

## Release acceptance / troubleshooting

- Run `npm ci` and `npm run check` before publishing a release; retain a rollback commit/image.
- Redeploy with the same volume; verify configuration and reception survive restart.
- UI Test Event results: `202` first acceptance, `200` duplicate, `400` invalid payload, `401` missing/wrong secret. These are intentional test outcomes.
- `503 SECRET_NOT_CONFIGURED`: inspect active source/bootstrap configuration without dumping environment values.
- `401 SECRET_INVALID`: compare active fingerprints; check override precedence and AnyFlo restart.
- Readiness `404`: deployed AnyFlo lacks the readiness route; do not invent redirect/configuration values or report ready.
- No device/provider configuration: receiver tests can pass, but native push remains unverified.
- `$currentUser.*` substitution is a convenience, not proof of universal row-level authorization. Verify application access requirements against actual server enforcement before release.

Record only release ID, environment, switch timestamps, fingerprint, receipt/event IDs, safe error codes, and test outcomes. Never include credential values or confidential notification content in deployment evidence.
