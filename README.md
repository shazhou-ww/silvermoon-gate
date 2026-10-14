# Silvermoon Gate

Silvermoon Gate is a reusable approval gateway. This repository is its initial
Cloudflare foundation: a React interface, a Hono Worker, same-origin static
assets, and inherited Auth.js sign-in scaffolding. The shared contracts package
now provides canonical payload digests, request idempotency fingerprints, and
request lifecycle transitions. Persistent approval workflows, authorization, and
credential issuance are still under implementation.

The planned production hostname is
[`https://gate.silvermoon.work`](https://gate.silvermoon.work). Wrangler is
configured to attach it as a Worker Custom Domain when deployed. Deployment
requires an active Cloudflare zone and may create DNS records; no deployment or
DNS change has been performed.

## Architecture

```text
apps/
  web/          React + Vite interface
  worker/       Hono API, Auth.js, static asset deployment
packages/
  contracts/    request and response contracts shared by both apps
```

Cloudflare serves `apps/web/dist` as static assets. Requests under `/api/*` run
the Worker first. Every other unknown route falls back to `index.html`, so
client-side routes remain deployable without a second service.

The Worker package declares the web package as a workspace dependency. This is
deployment topology rather than a runtime import: Turborepo builds web assets
before validating or deploying the Worker.

Approval requests are stored in the Worker-bound D1 database. A request pins a
versioned template and payload schema; the eligible approver roster for that
template version is dynamically replaceable. Request creation stores an
immutable canonical JSON snapshot and SHA-256 digest, and an idempotency key is
unique per requester. Decisions and requester withdrawal use conditional
database updates so only a pending request can reach its first terminal state.
Request and decision events are append-only in the database.

## Local development

Create the local secret file:

```sh
cp apps/worker/.dev.vars.example apps/worker/.dev.vars
```

Generate `AUTH_SECRET` with a cryptographically secure random value:

```sh
openssl rand -base64 32
```

Then run:

```sh
pnpm dev
```

- React development server: `http://localhost:5173`
- Worker development server: `http://localhost:8787`
- Vite proxies `/api/*` to the Worker.

`AUTH_URL` in `.dev.vars.example` points to the proxied browser origin. This
keeps OAuth callbacks and session cookies on `localhost:5173`.

## Identity providers

At least one provider needs credentials. Providers without both an ID and secret
are omitted from the interface rather than exposed as broken actions.

### GitHub

Create an OAuth App and use:

```text
Homepage URL: http://localhost:5173
Authorization callback URL:
http://localhost:5173/api/auth/callback/github
```

Set `AUTH_GITHUB_ID` and `AUTH_GITHUB_SECRET`.

### Google

Create an OAuth 2.0 Web application with:

```text
Authorized JavaScript origin: http://localhost:5173
Authorized redirect URI:
http://localhost:5173/api/auth/callback/google
```

Set `AUTH_GOOGLE_ID` and `AUTH_GOOGLE_SECRET`.

### Microsoft Entra ID

Create a Web platform redirect URI:

```text
http://localhost:5173/api/auth/callback/microsoft-entra-id
```

Set `AUTH_MICROSOFT_ENTRA_ID_ID`, `AUTH_MICROSOFT_ENTRA_ID_SECRET`, and
optionally `AUTH_MICROSOFT_ENTRA_ID_ISSUER`. The example issuer accepts accounts
from any Entra tenant. Replace `common` with a tenant ID for a single-tenant
app.

Use the production origin in every provider console before deployment.

## Worker secrets

Set production values from the Worker workspace:

```sh
pnpm --filter @workspace/worker exec wrangler secret put AUTH_SECRET
pnpm --filter @workspace/worker exec wrangler secret put AUTH_URL
pnpm --filter @workspace/worker exec wrangler secret put AUTH_GITHUB_ID
pnpm --filter @workspace/worker exec wrangler secret put AUTH_GITHUB_SECRET
```

Repeat the last two commands for Google or Microsoft variables. `AUTH_URL` must
be the full production auth base, for example:

```text
https://example.com/api/auth
```

Never commit `.dev.vars`; only `.dev.vars.example` belongs in Git.

## Gate database and template administration

Create a D1 database for the Worker and replace the local placeholder
`database_id` in `apps/worker/wrangler.jsonc` with the ID returned by Wrangler:

```sh
pnpm --filter @workspace/worker exec wrangler d1 create silvermoon-gate
pnpm --filter @workspace/worker exec wrangler d1 migrations apply silvermoon-gate --local
```

The same migration can be applied remotely only when the Cloudflare account and
database are ready for deployment. Set `GATE_ADMIN_IDENTITY_IDS` in Wrangler
configuration to a comma-separated allowlist of Auth.js identity IDs. An
allowlisted administrator creates a new versioned template with
`POST /api/templates`, including its payload schema version and initial
approvers; the same administrator can replace the eligible approver roster for a
specific version with `PUT /api/templates/:id/:version/approvers`. Request
creation, request reads, decisions, and withdrawal require an authenticated
session. Writes also require a same-origin `Origin` header. Request payloads are
limited to 64 KiB.

The current implementation records approval state and audit events but does not
yet issue signed decision credentials. An `approved` response is not an
offline-verifiable release credential.

## Commands

| Command       | Purpose                                                      |
| ------------- | ------------------------------------------------------------ |
| `pnpm dev`    | Build initial assets, then run Vite and Wrangler             |
| `pnpm check`  | Format, lint, type-check, test, and dry-run the Worker build |
| `pnpm build`  | Build the contracts, web assets, and Worker bundle           |
| `pnpm deploy` | Validate everything and deploy the Worker plus assets        |
| `pnpm clean`  | Remove all generated outputs                                 |

## Continuous deployment

The deploy workflow is safe to inherit because push deployment is disabled by
default. Configure the `production` GitHub environment with:

- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN`

Set the repository variable `CLOUDFLARE_DEPLOY_ENABLED=true` to deploy every
push to `main`. A manual workflow dispatch always attempts a deployment.

Use a narrowly scoped Cloudflare token that can edit Workers scripts for the
target account.

## Current boundaries

- The existing sign-in flow and interface are inherited scaffolding, not the
  final Gate identity or delegation model.
- The service design and implementation plan are tracked in the repository's
  Silvermoon idea record.
- Configure production OAuth callback URLs and secrets only when the chosen
  authentication design and deployment environment are ready.
- Enable the deployment workflow only after its Cloudflare environment is
  configured and reviewed.

## License

MIT
