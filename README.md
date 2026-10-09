# Mobile Integration Hub

Private operational console and secure relay boundary for Android and iOS apps that use AnyFlo as their core data platform.

The console has no application login screen. Keep its deployment reachable only by the administrator's trusted network or private domain. It never exposes the AnyFlo API key.

## Current console capabilities

- service health and whether AnyFlo is configured;
- server-to-server connection to AnyFlo;
- a Mobile Admission token supplied by a developer from an authenticated mobile-app session.

## Required server environment

Set `ANYFLO_API_BASE_URL` and `ANYFLO_API_KEY`. The API key remains server-only.

Mobile clients use an AnyFlo Mobile Admission bearer token. The gateway never exposes the server-only API key.

AnyFlo API V2 remains the source of truth for workflow dictionaries, tickets, relations, search, create, and update. Workflow Groups are web-app navigation only; they are not an integration contract. The Hub must not add business modules or per-app workflow configuration.

## Mobile V2 relay

Mobile clients call the supported API V2 surface through `https://<hub>/api/mobile/v1/v2`, with a Mobile Admission bearer token. For example, `GET /api/mobile/v1/v2/workflows/:workflowId/dictionary` and `POST /api/mobile/v1/v2/workflows/:workflowId/tickets/search` relay to their AnyFlo API V2 equivalents. The Hub accepts the documented workflow, ticket, search, create, update, array-row, comment, and history routes only.

Use `$currentUser.id`, `$currentUser.email`, `$currentUser.role.id`, or `$currentUser.department.id` in a query/body filter. The Hub resolves the placeholder from the verified Mobile Admission profile; never put an API key in an APK.
