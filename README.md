# Mobile Integration Admin Console

Private operational console and backend-for-frontend for Android and iOS apps that use AnyFlo as their core data platform.

The console has no application login screen. Keep its deployment reachable only by the administrator's trusted network or private domain. It never exposes the AnyFlo API key.

## What the console checks

- service health and whether AnyFlo is configured;
- server-to-server connection to AnyFlo;
- Store Ops source workflows: `SOP Task Execution` and `Shift Schedule`;
- a Mobile Admission token supplied by a developer from an authenticated mobile-app session.

## Required server environment

Set `ANYFLO_API_BASE_URL`, `ANYFLO_API_KEY`, `OUTLET_OPS_TASK_WORKFLOW_ID`, and `OUTLET_OPS_SHIFT_WORKFLOW_ID`. The API key remains server-only.

Mobile clients use an AnyFlo Mobile Admission bearer token. The gateway validates it through AnyFlo before returning any Outlet Ops data.
