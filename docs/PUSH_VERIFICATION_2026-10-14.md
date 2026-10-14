# Independent push verification — 2026-10-14

Scope: Hub only. AnyFlo code, environment, and publisher activation were not changed. All authenticated mutation fixtures ran in a temporary local Hub with a fake Admission /auth/me server and isolated SQLite files. No real devices or real recipient records were registered in staging.

## Automated evidence

Command: npm run check (TypeScript checks plus configuration, boundary, and push tests).

Passed assertions:

- Missing or wrong webhook secret: HTTP 401; absent server configuration: HTTP 503.
- Malformed JSON/invalid event: HTTP 400; wrong content type: HTTP 415.
- Changed content with an existing eventId: HTTP 409.
- Ten concurrent HTTP requests: exactly one HTTP 202 and nine HTTP 200 duplicate responses.
- Database reopen retains event deduplication; a second SQLite connection sees the same event.
- Pending deliveries survive restart and are processed.
- Authenticated Alice can register/rotate/unregister her device; authenticated Bob cannot take ownership (409) or unregister it (404).
- User override fields are rejected (400); unauthenticated registration returns 401.
- Broadcast recipient with Android and iOS devices produces exactly two successful mock deliveries; another user's device receives none.
- FCM OAuth/send encoding and APNs ES256 signature/topic/payload validated using local keys and mock transports.
- Both provider-success branches return sent; unregistered responses deactivate tokens.
- Missing credentials produce not_configured in the asynchronous HTTP-to-worker pipeline without rejecting the event.
- UI includes push diagnostics; agent guide includes device API instructions; diagnostics expose neither tokens nor shared secrets.

## Staging observations

- /health: HTTP 200; anyfloConfigured=true.
- /admin/push: webhookConfigured=false; applications, devices, and deliveries empty.
- Device registration without a Mobile Admission bearer: HTTP 401.
- Browser diagnostics show the same unconfigured state.
- /agent-guide contains register/unregister endpoints and mobile integration instructions.
- The live readiness probe for AnyFlo Admission reports upstream 404; the guide still loads and this does not block the standalone push engine.
- The Easypanel edge can replace the unconfigured webhook's application 503 response with HTML 502. The process log identifies the missing secret; health remains available.

## Remaining live-device prerequisites

1. Matching MOBILE_HUB_WEBHOOK_SECRET configured on Hub; no value was requested, generated for staging, or displayed.
2. Actual application ID and platform allowlist in PUSH_APPS_JSON.
3. FCM project/service-account configuration and/or APNs key/team/topic/environment.
4. Native app notification permission, provider token, Mobile Admission session, and notification-tap/deep-link handler.
5. A controlled real-device run to verify delivery and tap behaviour. Mock success proves request construction and pipeline logic, not provider authorization or device receipt.

Runtime limits remain documented in PUSH_NOTIFICATIONS.md: one Hub worker/replica, no automatic resend of terminal failures, interrupted sends marked outcome-unknown, no backlog replay for missing-device/not-configured events.

