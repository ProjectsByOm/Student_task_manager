# Deploying Daybook

## Production requirements

Daybook requires Node.js 20 or newer. Production startup requires these environment variables:

- `NODE_ENV=production`
- `PORT` (provided by most hosting platforms; defaults to `3000`)
- `JWT_SECRET` (a unique, high-entropy secret; never commit it)
- `DATABASE_PATH` (a writable path on persistent storage)
- `ADMIN_EMAIL` (the email address that should receive the initial administrator role)
- `APP_URL` (the public HTTPS URL, without a trailing slash)
- `SMTP_HOST`, `SMTP_FROM` (required to deliver password-reset links)
- `SMTP_PORT` (usually `587`; optional, defaults to `587`)
- `SMTP_USER`, `SMTP_PASS` (optional, if the SMTP provider requires authentication)
- `SMTP_SECURE=true` (optional, for implicit TLS, usually port `465`)
- `TRUST_PROXY_HOPS` (optional; set to the exact trusted proxy hop count, commonly `1`)

Copy `.env.example` to a local, untracked `.env` file and fill in real values. Use your hosting provider's secret manager for production values. Generate a secret with `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`.

The user matching `ADMIN_EMAIL` is promoted to administrator on signup. If that account already exists, it is promoted at startup. Public signup never grants administrator access to any other email. Administrators can review users and change roles from the in-app Admin panel.

## Docker

Prepare the production environment file, replacing the development values in `.env.example` with a strong `JWT_SECRET`, your admin email, public HTTPS `APP_URL`, and working SMTP details. Then start the app and persistent SQLite volume with Compose:

```sh
docker compose up --build -d
docker compose ps
docker compose logs -f daybook
```

## Render Blueprint

The included `render.yaml` provisions a paid Node web service with a persistent disk for SQLite. To launch it:

1. Push this project to a GitHub repository.
2. In Render, create a new Blueprint and select that repository and the `Student_task_manager` directory if prompted.
3. Provide the requested values: `ADMIN_EMAIL`, the final public HTTPS `APP_URL`, and SMTP host, credentials, and sender address.
4. Review the paid Starter service and persistent disk, then deploy the Blueprint.
5. Open the assigned HTTPS URL and confirm `/api/health`, signup, sign-in, and reset email delivery.

The Blueprint generates `JWT_SECRET` and keeps the SQLite file on a persistent disk. It does not contain credentials. The Blueprint may provision a Render URL only after service creation, so set `APP_URL` to the assigned HTTPS URL in the service environment before using password resets.

Build the image:

```sh
docker build -t daybook:latest .
```

Create a persistent volume and run the container using environment values from a protected env file:

```sh
docker volume create daybook-data
docker run --name daybook --restart unless-stopped --env-file .env \
  -e NODE_ENV=production -e DATABASE_PATH=/data/daybook.db \
  -p 3000:3000 -v daybook-data:/data daybook:latest
```

Do not expose the app directly to the internet without HTTPS. Put it behind a TLS-terminating reverse proxy or a hosting platform's HTTPS ingress. If the proxy forwards requests, set `TRUST_PROXY_HOPS` to the exact number of trusted proxy hops so client IP and HTTPS detection remain correct.

## Hosting-platform / process-manager deployment

The included `Procfile` starts the server with `node server.js`. Configure all production environment variables in the platform dashboard and attach persistent storage at `DATABASE_PATH`. A single SQLite file is suitable for a single app instance; use a managed database such as PostgreSQL before running multiple instances.

## Before going live

- Confirm `/api/health` returns `{"ok":true,"service":"daybook"}`.
- Create the account matching `ADMIN_EMAIL` and confirm the Admin button is visible.
- Configure SMTP and use the forgot-password flow with a real inbox.
- Confirm the database path is on persistent storage and backups are enabled.
- Verify the deployment uses HTTPS, `NODE_ENV=production`, a strong `JWT_SECRET`, and the correct `TRUST_PROXY_HOPS` value when applicable.
- Keep dependencies updated and review platform logs for startup and SMTP errors.

## Data and operations

- Exports contain account planner data only; passwords and reset tokens are never exported.
- Imports validate size and field formats and replace the current account's planner data atomically.
- Reset links expire after one hour and can only be used once.
- The health endpoint is intentionally unauthenticated and does not expose database or account details.
- SQLite WAL mode is enabled. Back up the database using a SQLite-aware backup method while the app is running.
