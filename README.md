# Mobile Integration Hub

Private operational console and backend-for-frontend for Android and iOS apps that use AnyFlo as their core data platform.

The console has no application login screen. Keep its deployment reachable only by the administrator's trusted network or private domain. It never exposes the AnyFlo API key.

## Current console capabilities

- service health and whether AnyFlo is configured;
- server-to-server connection to AnyFlo;
- a Mobile Admission token supplied by a developer from an authenticated mobile-app session.

## Required server environment

Set `ANYFLO_API_BASE_URL` and `ANYFLO_API_KEY`. The API key remains server-only.

Mobile clients use an AnyFlo Mobile Admission bearer token. The gateway validates it through AnyFlo before returning any Outlet Ops data.

The next capability is an app registry: each app will configure its own AnyFlo resources and API contract rather than adding a hard-coded module to the gateway.
