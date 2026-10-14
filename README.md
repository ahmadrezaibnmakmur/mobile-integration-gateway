# Mobile Integration Hub

Private operational console and secure relay boundary for Android and iOS apps that use AnyFlo as their core data platform.

The console has no application login screen. Keep its deployment reachable only by the administrator's trusted network or private domain. It never exposes the AnyFlo API key.

## Current console capabilities

- service health and whether AnyFlo is configured;
- server-to-server connection to AnyFlo;
- non-secret Mobile Admission readiness report, including the configured redirect URI and whether all server-side prerequisites are present;
- a Mobile Admission token supplied by a developer from an authenticated mobile-app session.
- persistent notification event deduplication, authenticated device registration, FCM/APNs adapters, and sanitized push-delivery diagnostics.

See [Push notifications v1](docs/PUSH_NOTIFICATIONS.md) for environment configuration, device APIs, event contract, staging tests, and delivery limits. The push worker uses a persistent SQLite volume and a single Hub replica.

## Required server environment

Attach persistent storage at `/data`. A new Hub deliberately starts disconnected: the administrator sets the AnyFlo base URL, API key label, and API key in the Hub UI. The key is stored server-side and is never returned by the API or browser UI.

Mobile clients use an AnyFlo Mobile Admission bearer token. The gateway never exposes the server-only API key.

AnyFlo API V2 remains the source of truth for workflow dictionaries, tickets, relations, search, create, and update. Workflow Groups are web-app navigation only; they are not an integration contract. The Hub must not add business modules or per-app workflow configuration.

## Mobile V2 relay

Mobile clients call the supported API V2 surface through `https://<hub>/api/mobile/v1/v2`, with a Mobile Admission bearer token. For example, `GET /api/mobile/v1/v2/workflows/:workflowId/dictionary` and `POST /api/mobile/v1/v2/workflows/:workflowId/tickets/search` relay to their AnyFlo API V2 equivalents. The Hub accepts the documented workflow, ticket, search, create, update, array-row, comment, and history routes only.

Use `$currentUser.id`, `$currentUser.email`, `$currentUser.role.id`, or `$currentUser.department.id` in a query/body filter. The Hub resolves the placeholder from the verified Mobile Admission profile; never put an API key in an APK.

## Agentic AI control plane

The UI provides connection setup, a workflow list, live dictionary/schema inspection, an API V2 playground, a Mobile Admission readiness check, and an agent guide at `GET /agent-guide`. The guide supplies the Hub origin, Mobile Admission contract, readiness result, barebones scope, and explicit App Link/Universal Link next step. The playground is an administrator tool and uses the saved server credential; the mobile runtime must use `/api/mobile/v1/v2` with Mobile Admission instead.

## Mobile Admission readiness

The Hub calls `GET /api/mobile/v1/auth/readiness` on AnyFlo with its saved API key. That AnyFlo route returns only booleans for the Google client ID, Google client secret, Mobile JWT secret, refresh-token storage, plus the non-secret redirect URI. It never returns a credential value and is not a mobile-client endpoint.

A ready report proves that the server-side admission prerequisites are configured. It does not replace live Google consent or App Link / Universal Link verification: the app package or bundle identifier and signing identity must be established first, then the association file must be published on the exact redirect host.
