# Migrating from the hosted version

This guide is for teams using the hosted version of Omlet at omlet.dev who are moving to a self-hosted instance. It walks you through standing up your own instance, running both versions in parallel to build up scan history, and cutting over.

## What carries over, and what doesn't

Everything that lives in your repositories works with your self-hosted instance as-is:

- Your project [config files](./cli/config-file/README.md), including any [`exports`](./cli/config-file/exports.md) and [`aliases`](./cli/config-file/aliases.md) fixes
- [Hook scripts](./cli/custom-component-properties/cli-hooks.md) that add custom component properties
- Your [regular scan setup](./cli/set-up-regular-scans.md) in CI — it only needs to point at a different URL.

Everything that lives in the web app has to be recreated on the new instance:

- **Scan history:** Since the hosted version and your self-hosted setup are two entirely separate instances, unfortunately there's no practical way to transfer history between them. That's why we recommend setting up your own instance early and scanning into both, so history starts accumulating well before you switch.
- **[Tags](./dashboard/components/tags.md)**
- **[Saved charts and dashboards](./dashboard/analytics/save-charts-to-dashboard.md)**
- **Workspace members**
- **[Project renames](./dashboard/workspace-and-account/renaming-projects.md)**

> ☝️ Before your hosted access ends, [download the data behind charts you care about as CSV](./dashboard/analytics/download-chart-data.md). It's the only way to keep a record of trends from before your self-hosted instance started collecting data.

The [VS Code extension](https://marketplace.visualstudio.com/items?itemName=Omlet.omlet-vscode-extension) works locally and isn't affected by the migration.

## Step 1: Stand up your self-hosted instance

Follow the [project README](../README.md) to get the web app running, then work through its "Going beyond the quick start" section. For a migration, pay particular attention to:

- **Host it at a URL your team and CI runners can reach.** A `localhost` instance is fine for trying things out, but parallel scanning from CI requires a routable URL, set via `APP_BASE_URL` and `VITE_APP_BASE_URL`.
- **Set up real authentication** (Google or GitHub OAuth) and disable the test user with `ENABLE_TEST_USER=false`.

## Step 2: Scan into both instances

The goal of this step is that every scan lands in both instances, so history builds up in the new one while your team keeps using the hosted dashboard day to day.

The CLI targets whichever instance `OMLET_BASE_URL` points at, and stores one login token per URL — so being logged in to both instances on the same machine works without conflicts.

### In CI

If you have [regular scans](./cli/set-up-regular-scans.md) set up, keep your existing step as-is and add a second `analyze` step pointing at your self-hosted instance.

Generate an access token for the new instance:

```sh
OMLET_BASE_URL=https://omlet.example.com npx @omlet/cli login --print-token
```

Store it in a new CI secret (e.g. `OMLET_SELF_HOSTED_TOKEN`). For GitHub Actions:

```yaml
      # Your existing step, unchanged
      - name: Run analyze (hosted)
        run: npx @omlet/cli analyze
        env:
          OMLET_TOKEN: ${{ secrets.OMLET_TOKEN }}

      # New step, pointing at your self-hosted instance
      - name: Run analyze (self-hosted)
        run: npx @omlet/cli analyze
        env:
          OMLET_TOKEN: ${{ secrets.OMLET_SELF_HOSTED_TOKEN }}
          OMLET_BASE_URL: https://omlet.example.com
```

The same pattern applies on other CI platforms — see [Set up regular scans](./cli/set-up-regular-scans.md) for GitLab CI/CD and CircleCI configurations.

### Locally

Log in to your self-hosted instance once:

```sh
OMLET_BASE_URL=https://omlet.example.com npx @omlet/cli login
```

Then, whenever you run a scan, repeat it with `OMLET_BASE_URL` pointing at the new instance:

```sh
OMLET_BASE_URL=https://omlet.example.com npx @omlet/cli analyze
```

Since your repos already have their config files from the hosted setup, `analyze` is all you need — no need to go through `init` again.

## Step 3: Recreate your workspace setup

While history accumulates, rebuild the parts of your workspace that don't transfer:

1. [Invite your team members](./dashboard/workspace-and-account/invite-team-members.md) — the invite link option works without any email configuration.
2. [Set up your dashboard](./cli/set-up-your-dashboard.md) by tagging your design system components, so adoption charts are meaningful from day one.
3. Recreate any other [tags](./dashboard/components/tags.md) and [saved charts](./dashboard/analytics/save-charts-to-dashboard.md) your team relies on. It helps to open the hosted dashboard side by side and copy the filters behind each one.
4. [Rename projects](./dashboard/workspace-and-account/renaming-projects.md) to match the names your team is used to.

## Step 4: Cut over

Once your self-hosted instance has enough history for the trends your team relies on:

1. [Download CSVs](./dashboard/analytics/download-chart-data.md) of any hosted charts you want to keep for reference.
2. Remove the hosted `analyze` step from your CI setup.
3. Update local workflows to point at your self-hosted instance only — e.g. set `OMLET_BASE_URL` in your shell profile or repo tooling.

From then on, your self-hosted instance is the single source of truth.
