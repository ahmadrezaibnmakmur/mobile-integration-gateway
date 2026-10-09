# Mobile Integration Gateway

Generic Android/iOS backend-for-frontend for AnyFlo deployments. It keeps the AnyFlo API key in the server environment. Apps present a Mobile Admission bearer token; the gateway validates it through AnyFlo before serving module data.

## First deployment

1. Set `ANYFLO_API_BASE_URL`, `ANYFLO_API_KEY`, and a long `GATEWAY_ADMIN_TOKEN` as server secrets.
2. The supplied values target the Store Ops sample (`SOP Task Execution` and `Shift Schedule`). Replace them only when another mobile module is configured.
3. Deploy the supplied Dockerfile. Open `/` to use the protected health/configuration/connection console.

The initial Outlet Ops BFF exposes a session check, an assignment-filtered bootstrap endpoint, and a narrow task update endpoint. It never exposes the AnyFlo API key to an APK or browser.

Platform-neutral backend-for-frontend for Android and iOS applications that use AnyFlo as their core data platform.

## Boundaries

- Mobile clients authenticate with AnyFlo Mobile Admission; API keys never enter an APK or IPA.
- This gateway stores a per-app AnyFlo API key only as a server secret.
- App-specific routes live here. AnyFlo remains the generic workflow and database core.
- The initial service provides only a health endpoint. Configure and verify the AnyFlo connection before adding an app module.

## Local start

```bash
npm install
cp .env.example .env
npm run dev
```

`GET /health` returns the service status and whether the required connection configuration is present. It never returns secrets.
