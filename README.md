# Silvermoon Gate

Silvermoon Gate is a reusable approval gateway. MVP 1 implements a restricted
human online approval workflow: GitHub sign-in, stable Gate identities, explicit
direct permissions, immutable requests, and a single approval/rejection or
requester withdrawal with atomic D1 audit history. The Chinese React interface
includes request creation, personal requests, an approval inbox, and details.
This is not an Agent, delegation, MFA, signed-credential, or
offline-verification release. It is intended for non-sensitive test-environment
pilot requests only.

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

MVP 1 enables GitHub only. Missing GitHub credentials do not expose a broken
sign-in action. A successful OAuth login alone does not grant approval rights:
the verified GitHub subject must map to an enabled, provisioned Gate identity.

### GitHub

Create an OAuth App and use:

```text
Homepage URL: http://localhost:5173
Authorization callback URL:
http://localhost:5173/api/auth/callback/github
```

Set `AUTH_GITHUB_ID` and `AUTH_GITHUB_SECRET`.

Use the production origin in every provider console before deployment.

## Worker secrets

Set production values from the Worker workspace:

```sh
pnpm --filter @workspace/worker exec wrangler secret put AUTH_SECRET
pnpm --filter @workspace/worker exec wrangler secret put AUTH_URL
pnpm --filter @workspace/worker exec wrangler secret put AUTH_GITHUB_ID
pnpm --filter @workspace/worker exec wrangler secret put AUTH_GITHUB_SECRET
```

`AUTH_URL` must be the full auth base for the selected pilot environment, for
example:

```text
https://example.com/api/auth
```

Never commit `.dev.vars`; only `.dev.vars.example` belongs in Git.

## Gate database and restricted pilot setup

Create a D1 database for the Worker and replace the local placeholder
`database_id` in `apps/worker/wrangler.jsonc` with the ID returned by Wrangler:

```sh
pnpm --filter @workspace/worker exec wrangler d1 create silvermoon-gate
pnpm --filter @workspace/worker exec wrangler d1 migrations apply silvermoon-gate --local
```

Remote migration, database creation and deployment require explicit environment
authorization; none is performed by running tests or a dry-run build. Provision
Gate identities and template permissions through reviewed SQL, not through
browser administrator endpoints or an environment-variable bypass. Use distinct,
independently verified GitHub subjects for requester and approver. Display names
and email addresses are never authorization keys. Self-approval is prohibited
even when one identity holds both permissions.

The MVP schema and pilot provisioning procedure are documented in the Worker
migrations and
[MVP 1 implementation evidence](.silvermoon/ideas/01M4XC32C5CB66DH8RFWPCAEF1/outer/inner/Verification.md).
Keep legacy history intact; do not invent identity mappings for historical
records or edit accepted requests during provisioning.

Apply both `0001_gate.sql` and `0002_human_mvp.sql` locally before signing in.
The latter provisions the fixed test template but deliberately does **not**
create enabled identities or grant permissions. After independently verifying
the two GitHub account subjects, execute reviewed SQL in the selected local
database, replacing the placeholders below:

```sql
INSERT INTO gate_identities VALUES
  ('human-requester', 'VERIFIED_GITHUB_SUBJECT_REQUESTER', 'Requester', 'active', 1, 1),
  ('human-approver', 'VERIFIED_GITHUB_SUBJECT_APPROVER', 'Approver', 'active', 1, 1);
INSERT INTO gate_template_access VALUES
  ('human-requester', 'release-review', 1, 'create', 1),
  ('human-approver', 'release-review', 1, 'decide', 1);
```

The explicit Gate IDs must never be reassigned. Configuration changes require
increasing revisions and generate configuration audit records. Do not use a
GitHub display name or email as its provider subject. For an existing pilot,
inspect the current records before applying an update; never replay inserts or
delete history to bypass a uniqueness/revision conflict.

The fixed `release-review` version 1 template only accepts
`environment: "test"`. Payload fields are `action: "release"`, `candidate`,
`artifactDigest` (`sha256:` plus 64 lowercase hexadecimal characters),
`environment`, and `summary`. The API body limit is 16 KiB. Unknown fields and
invalid business payloads are rejected. The artifact digest is a business field,
distinct from the Gate digest of the complete immutable payload plus schema
version.

GitHub-backed Gate sessions are revocable and validated against D1. Request
creation, lists, details, decisions and withdrawal enforce current identity and
direct template permissions. Cookie-authenticated writes additionally require a
same-origin `Origin` header. Lists authorize before pagination; request links
and cursors do not grant access.

The inbox excludes self-created requests. Only a pending request may be decided
or withdrawn. A per-operation marker gates the matching decision/audit writes,
so a losing concurrent submission cannot create evidence for another operation.
The conditional state change and evidence run in one D1 batch and roll back
together on failure.

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

- MVP 1 implements direct human authorization only, not the final delegated
  authority model. Do not use it for production release controls or workflows
  that require MFA or offline verification.
- The service design and implementation plan are tracked in the repository's
  Silvermoon idea record.
- Configure production OAuth callback URLs and secrets only when the chosen
  authentication design and deployment environment are ready.
- Enable the deployment workflow only after its Cloudflare environment is
  configured and reviewed.
- Local tests and local workerd/D1 emulation do not prove cloud D1 queueing,
  overload recovery, or real provider sign-in. The pilot still requires two real
  identities and an explicitly authorized cloud environment.

## License

MIT
