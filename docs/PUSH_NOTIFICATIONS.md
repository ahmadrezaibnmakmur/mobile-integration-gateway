# Push notifications v1 — Hub operator and mobile guide

## Scope

AnyFlo emits platform-neutral notifications to this Hub. Hub authenticates the event, persists its ID and device delivery queue, and uses FCM or APNs. No AnyFlo changes are required.

Provider references: [FCM HTTP v1](https://firebase.google.com/docs/cloud-messaging/send/v1-api), [APNs token authentication](https://developer.apple.com/documentation/usernotifications/establishing-a-token-based-connection-to-apns), [APNs requests](https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns).

## Deployment and secrets

Run Node 22.14 or newer (Docker uses Node 22). Mount a persistent local volume at DATA_DIR, normally /data. SQLite stores device tokens, accepted events, and delivery records in /data/push.sqlite. Treat this file, its WAL files, and backups as sensitive. It is created with mode 0600. Never commit or serve the data directory.

This v1 worker supports ONE Hub process/replica using that local volume. Do not deploy multiple workers against this database: startup marks interrupted sends as outcome-unknown to avoid accidental resend.

Environment:

- MOBILE_HUB_WEBHOOK_SECRET: the same server-only value as AnyFlo's MOBILE_HUB_WEBHOOK_SECRET. Missing configuration makes the event receiver return 503. Missing/wrong incoming header returns 401.
- PUSH_APPS_JSON: an application allowlist and optional provider credentials. Default {} means device registration is unavailable until an administrator configures an application. Missing provider configuration does not reject accepted events.
- DATA_DIR: persistent directory, default /data.
- PORT: default 3000.

Example shape (placeholders only; replace through the secret manager):

    {
      "my-mobile-app": {
        "platforms": ["android", "ios"],
        "fcm": {
          "projectId": "<Firebase project ID>",
          "clientEmail": "<service account client_email>",
          "privateKey": "<service account private_key, with JSON escaped newlines>"
        },
        "apns": {
          "teamId": "<Apple team ID>",
          "keyId": "<APNs signing key ID>",
          "privateKey": "<APNs .p8 content, with JSON escaped newlines>",
          "bundleId": "<iOS bundle identifier>",
          "environment": "sandbox"
        }
      }
    }

You may configure only fcm, only apns, or neither during initial integration. Each app uses its own credentials. FCM requires the Firebase Cloud Messaging API enabled and a service account authorized to send messages in that project. APNs requires the actual bundle identifier, key/team identifiers, APNs entitlement, and matching sandbox/production token. Do not guess these values.

iOS can use FCM if the device explicitly registers provider=fcm and its Firebase project has the required Apple push setup. Otherwise iOS defaults to APNs. Android uses FCM.

Configuration changes require restarting/redeploying Hub. Validate with GET /admin/push; it returns only readiness flags, app IDs, device counts, and sanitized delivery outcomes. The UI contains a Push notification diagnostics card.

The existing administrator console is intended for a trusted network. Its /admin routes use the existing console access model. Protect the administration paths with network/proxy access controls when exposing mobile runtime endpoints publicly. This change does not add a new administrator login.

## AnyFlo configuration

Set AnyFlo MOBILE_HUB_URL to the Hub HTTPS origin, MOBILE_HUB_ENABLED=true, and use the exact matching MOBILE_HUB_WEBHOOK_SECRET on both services. AnyFlo's existing comment-mention/broadcast publisher determines which recipients receive events. Hub uses recipient.id as the canonical identity, never an email provided by the mobile app.

## Event receiver

    POST /internal/events/mobile-notification
    Content-Type: application/json
    X-AnyFlo-Hub-Secret: <server-only shared secret>

Body:

    {
      "eventId": "<unique stable event ID>",
      "eventType": "notification.created",
      "occurredAt": "2026-10-14T10:00:00.000Z",
      "recipient": { "id": "<AnyFlo user ID>", "email": "<recipient email>" },
      "title": "New comment",
      "body": "You were mentioned",
      "resource": { "type": "ticket", "id": "<ticket ID>", "workflowId": "<workflow ID>" },
      "deepLink": { "route": "ticket", "id": "<ticket ID>" }
    }

broadcast.published uses resource.type=broadcast and deepLink.route=broadcast. Their IDs must match. Title is limited to 300 characters, body to 2000, and combined push content to 3200 bytes. Content must be suitable for a lock-screen preview.

Responses:

- 202 accepted, duplicate=false: persisted atomically with a snapshot of active recipient devices.
- 200 accepted, duplicate=true: same event was already persisted; no new device deliveries.
- 400: invalid payload.
- 401: missing/wrong secret.
- 409: event ID reused with different normalized content.
- 415: wrong content type.
- 503: receiver secret not configured.

Acceptance does not mean a push was displayed. The queue runs asynchronously. Provider credentials may be missing, devices may not exist, or providers may reject the request. None of those failures changes event acceptance.

## Device API

Mobile app obtains a normal Mobile Admission access token through Hub first.

    POST /api/mobile/v1/devices
    Authorization: Bearer <Mobile Admission access token>

    {
      "applicationId": "<configured application ID>",
      "platform": "android",
      "provider": "fcm",
      "installationId": "<random stable per-installation identifier>",
      "token": "<FCM registration token>"
    }

Hub verifies the token using AnyFlo /auth/me and derives user ownership from that response. User/email overrides are rejected. It returns a device id without returning the token.

Persist installationId locally; call registration after login and on provider token refresh. Re-registering the same owned installation updates the token. The same token cannot be claimed by another user. Before logout/account switching, call:

    DELETE /api/mobile/v1/devices/<device ID>
    Authorization: Bearer <current user's Mobile Admission access token>

Deletion is owner-scoped; another user gets 404. Unregister before revoking the current session. If unregister fails, do not silently transfer the installation to another account; finish unregister while authenticated as the prior owner or resolve the stale registration operationally.

All active registered apps/devices for recipient.id receive an event. This v1 has no app/workflow routing policies. Register devices only for apps that should receive that AnyFlo user's notifications.

Android app must configure Firebase, obtain notification permission on applicable Android versions, handle foreground messages and notification taps. iOS app must enable push entitlement, request notification permission, register with APNs or FCM, and handle taps. Deep links are route/id objects, not arbitrary URLs. Validate route and load protected data using the current session. API credentials remain server-side.

## Delivery states and v1 guarantees

GET /admin/push and the diagnostics card show the latest 100 delivery outcomes:

- pending / sending
- sent: provider accepted; this is not proof of device receipt
- not_configured: provider credentials missing
- failed: safe provider/error code
- no_devices: no active recipient devices at acceptance

FCM UNREGISTERED and APNs Unregistered/BadDeviceToken/DeviceTokenNotForTopic deactivate the device token. Correct app/provider/environment configuration before the client registers a fresh token.

Duplicate requests never create new deliveries, including after restart or concurrent requests. Queued deliveries survive restarts. A send interrupted by a crash is marked DELIVERY_OUTCOME_UNKNOWN on startup rather than blindly resent. There is no automatic retry of terminal provider failures in v1; deduplication cannot guarantee exactly-once delivery across a provider network timeout. Use a new intentional event for a fresh notification, not replaying the same event.

Events with no devices or missing provider configuration are logged and are not backfilled automatically after configuration changes. New devices receive new events. Configure providers before the actual end-to-end test.

## Staging tests without exposing secrets

Use secret files with restrictive permissions. Never put the shared secret into a command argument or paste it into chat. Prepare the event fixture at a local path such as /secure/test-event.json. Use only a controlled test account/device.

Negative receiver test (contains no secret):

    curl -i -X POST "$HUB_URL/internal/events/mobile-notification" \
      -H 'Content-Type: application/json' --data '{}'

Expect 401 when configured, or 503 when the secret is not set.

Authorized test: a local, mode-0600 headers file contains Content-Type plus the shared-secret header. Load it through curl's header-file option:

    curl -i -X POST "$HUB_URL/internal/events/mobile-notification" \
      --header @/secure/hub-event-headers --data-binary @/secure/test-event.json

Expect 202 the first time, then 200 duplicate=true on repeated and concurrent requests. Confirm only one delivery per device in diagnostics, then restart the service and repeat to verify persistence.

Device test: a separate mode-0600 file contains the Mobile Admission Authorization header and Content-Type. The device fixture contains no user override:

    curl -i -X POST "$HUB_URL/api/mobile/v1/devices" \
      --header @/secure/mobile-headers --data-binary @/secure/device-registration.json

Verify other-user unregister is denied, owner unregister succeeds, token rotation updates the same device, and invalid provider tokens become inactive. Perform one real-device push per platform to verify provider credentials and native app integration.

## Automated verification

Run npm run check. Tests cover shared-secret validation, payload mismatch, device ownership, token rotation, persistent event deduplication, concurrent HTTP retries, missing provider configuration, invalid token deactivation, provider request encoding, and API response redaction. External provider calls in automated tests use fixtures; real FCM/APNs delivery requires actual credentials and devices.

