<p><img src="./docs/images/omlet-logo.svg" alt="Omlet" width="40" height="40" /></p>

# Omlet

Omlet is a component analytics tool for React and React Native. It scans your codebase to detect components, props, and how they're used across projects, then surfaces adoption, usage, and dependency insights through a web dashboard.

## What you can answer with Omlet

- How is my design system used across projects, and how does adoption change over time?
- Which projects are still on older versions of my components?
- Which non-design-system components are heavily used and might be worth promoting?
- Which props are unused, and which values get passed in practice?
- Which components share dependencies, and what breaks if I change one?

## How it works

Omlet's CLI scans React code locally and sends only metadata (component names, file paths, prop usage, dependency relationships) to the web app, where you can build charts and dashboards.

## Project layout

- [`cli/`](./cli) — the scanner that runs against your code (`omlet init`, `omlet analyze`, `omlet login`). Rust with Node bindings.
- [`webapp/`](./webapp) — the backend the CLI uploads scans to and the dashboard you view them in. Express + React + MongoDB. See [`webapp/README.md`](./webapp/README.md) for dev tooling, migrations, and the full env reference.
- [`docs/`](./docs/README.md) — user docs for the CLI and dashboard.

## Quick start

Get a local Omlet instance running and scan your first repo with the pre-configured test user.

### Prerequisites

- Node.js 20+
- Docker (for MongoDB and Redis)

### Run the web app

```sh
cd webapp
npm install
npm run dev
```

This generates a `.env` file with sensible defaults (test user enabled, email login disabled), starts MongoDB and Redis via Docker, runs migrations, and launches the backend and frontend.

The app should now be running at [http://localhost:3001](http://localhost:3001). Click **Continue with test user** to sign in.

### Scan a repo

In any React project on your machine:

```sh
OMLET_BASE_URL=http://localhost:3001 npx @omlet/cli login
OMLET_BASE_URL=http://localhost:3001 npx @omlet/cli init
```

> **Note**
>
> `npx @omlet/cli` runs the published package from npm, not the source in [`cli/`](./cli). If you make changes to the CLI, build it locally and run the built binary instead.

`omlet init` walks you through scan setup, runs the first scan, and uploads metadata to your local web app. For follow-up scans, use `omlet analyze`.

See [Your first scan](./docs/cli/your-first-scan.md) for a full CLI walkthrough.

## Going beyond the quick start

For a long-running instance shared with teammates, you'll want to swap the test user for real authentication. The web app supports Google OAuth and GitHub OAuth.

### Disable the test user

Once real auth is configured, set `ENABLE_TEST_USER=false` so the test user button disappears from the login page.

### Google OAuth

1. In [Google Cloud Console](https://console.cloud.google.com/), create an OAuth 2.0 client ID (Web application).
2. Add an authorized redirect URI of `<APP_BASE_URL>/auth/google/login` — e.g. `http://localhost:3001/auth/google/login` for local, or your production URL.
3. Set in `webapp/.env`:

   ```sh
   GOOGLE_CLIENT_ID="<your client id>"
   GOOGLE_CLIENT_SECRET="<your client secret>"
   ```

The redirect path is fixed at `/auth/google/login` — only the host part (`APP_BASE_URL`) is configurable.

### GitHub OAuth

1. In [GitHub Developer Settings](https://github.com/settings/developers), create a new OAuth App.
2. Set the authorization callback URL to `<APP_BASE_URL>/auth/github/login` — e.g. `http://localhost:3001/auth/github/login`.
3. Set in `webapp/.env`:

   ```sh
   GITHUB_CLIENT_ID="<your client id>"
   GITHUB_CLIENT_SECRET="<your client secret>"
   ```

As with Google, the callback path is fixed at `/auth/github/login`.

### Email login

The web app has scaffolding for email flows (magic-link login, workspace invites, email-change confirmations), but the email sender is a stub. To enable these flows, wire up `EmailClient.sendEmail` in [`webapp/src/backend/service/emailing.ts`](./webapp/src/backend/service/emailing.ts) to your email provider, then set `EMAILS_ENABLED=true` and `VITE_EMAILS_ENABLED=true` in `webapp/.env`.

### Public URL

If you're hosting the app at a URL other than `http://localhost:3001`, set:

```sh
APP_BASE_URL="https://omlet.example.com"
VITE_APP_BASE_URL="https://omlet.example.com"
```

## Documentation

Full user documentation lives in [`docs/`](./docs/README.md):

- [Migrating from the hosted version](./docs/migrating-from-the-hosted-version.md) — move from omlet.dev to your own instance without starting from scratch
- [CLI](./docs/cli/README.md) — scan commands, config file, custom component properties
- [Dashboard](./docs/dashboard/analytics/README.md) — analytics, components, workspace settings
- [FAQs](./docs/faqs/README.md)
- [Troubleshooting](./docs/troubleshooting/README.md)

## VS Code extension

A separate Omlet VS Code extension surfaces component metadata in your editor. You can find it at [Omlet for VS Code](https://marketplace.visualstudio.com/items?itemName=Omlet.omlet-vscode-extension).

## License

[MIT](./LICENSE)
