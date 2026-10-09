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
