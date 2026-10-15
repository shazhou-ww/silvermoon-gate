# Silvermoon Gate

Silvermoon Gate is a reusable approval gateway. MVP 1 implements a restricted
human online approval workflow: GitHub sign-in, stable Gate identities, explicit
direct permissions, immutable requests, and a single approval/rejection or
requester withdrawal with atomic D1 audit history. The Chinese React interface
includes request creation, personal requests, an approval inbox, and details.
MVP 2 adds a **local-only** independent Agent workflow using explicit direct
permissions and short-lived opaque tokens. Neither stage has passed the external
OAuth/cloud pilot gate. This is not a delegation, MFA, signed-credential, or
offline-verification release. Use non-sensitive test-environment requests only;
local tests do not authorize deployment.

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

Apply `0001_gate.sql`, `0002_human_mvp.sql`, and `0003_agent_mvp.sql` locally
before signing in. The human migration provisions the fixed test template but
deliberately does **not** create enabled identities or grant permissions. After
independently verifying the two GitHub account subjects, execute reviewed SQL in
the selected local database, replacing the placeholders below:

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

## Local Agent integration (MVP 2)

This section is **local only**. The real MVP 2 pilot remains blocked on MVP 1's
external GitHub OAuth, restricted two-human pilot and acceptance, followed by
explicit environment authorization. No cloud migration/deployment is performed
by the tools below. The accepted design and local implementation evidence live
under
[MVP 2](.silvermoon/ideas/01M4XC5P9EQ0K1PCY16K5JF0D3/outer/inner/Implementation.md).

Set `GATE_AGENT_ISSUER=urn:silvermoon-gate:local` in the local configuration
only; it is documented in `.dev.vars.example`. An unset issuer disables machine
authentication, not human sign-in. A future pilot must use an independent D1 and
a different trusted issuer. The issuer never comes from request headers.

After applying all migrations **locally** and provisioning an independently
verified human operator as above, run the local CLI from the repository root:

```powershell
pnpm --filter @workspace/worker agent:local register human-requester "Local caller"
# Set this to the returned public Agent ID, not a secret.
$agent = "agent:REPLACE_WITH_RETURNED_PUBLIC_ID"
pnpm --filter @workspace/worker agent:local credential $agent .wrangler\caller.json
pnpm --filter @workspace/worker agent:local grant $agent create
pnpm --filter @workspace/worker agent:local grant $agent read
pnpm --filter @workspace/worker agent:local grant $agent withdraw
```

The CLI uses Miniflare's persistent local D1 at the Worker workspace's
`.wrangler/state/v3`, with the current configured placeholder database ID
`00000000-0000-0000-0000-000000000000`. `--state LOCAL_PATH` selects another
local persistence directory for isolated tests, never a remote database. Do not
use this tool to provision a differently configured pilot. It never migrates
implicitly, reads `.dev.vars`, or accepts `--remote`. Credential files must be
inside the gitignored Worker `.wrangler` directory: creation is exclusive, Unix
permissions are `0600`, and Windows inheritance is removed before writing the
secret with access granted to the current user. Do not copy their contents into
terminals, logs, URLs or version control.

The bootstrap credential has 256 random bits and a 30-day maximum lifetime; D1
stores only its domain-separated SHA-256 hash. It exchanges at
`POST /api/agent/token` for a separate 300-second opaque Bearer token with
server-side issuer/audience/expiry/generation and revocation checks. There is no
refresh token. The machine API rejects Cookie/Origin credentials; human cookie
authentication and same-origin/CSRF checks remain unchanged.

The only machine business endpoints are `POST /api/agent/requests`,
`GET /api/agent/requests/:id` and `POST /api/agent/requests/:id/withdraw`.
Creation requires explicit create+read; reading/withdrawing is limited to the
Agent's own requests, with explicit read/read+withdraw permissions. Registration
and request creation confer no other rights. Agent decisions, inbox access,
delegation and implicit registrar privileges do not exist. The human interface
identifies human/Agent/legacy requesters separately from the actual decision
actor.

The executable caller uses a synthetic fixed input from
[`examples/release-review.json`](examples/release-review.json):

```powershell
pnpm --filter @workspace/contracts build
$env:GATE_ORIGIN = "http://localhost:8787"
$env:GATE_ISSUER = "urn:silvermoon-gate:local"
$env:GATE_CREDENTIAL_FILE = (Resolve-Path apps\worker\.wrangler\caller.json).Path
$env:GATE_INPUT_FILE = (Resolve-Path examples\release-review.json).Path
# Persist this key with the immutable input BEFORE the first network attempt.
$env:GATE_IDEMPOTENCY_KEY = "local-example-stable-operation-key"
$env:GATE_EXPECTED_DIGEST = node --input-type=module -e "import {readFile} from 'node:fs/promises'; import {calculatePayloadDigest} from './packages/contracts/dist/index.js'; const input=JSON.parse(await readFile(process.env.GATE_INPUT_FILE,'utf8')); console.log(await calculatePayloadDigest(input.payloadSchemaVersion,input.payload));"
node examples\agent-caller.mjs
```

Exit `0` alone means an online approved result matches the caller's expected
schema, template, requester, immutable payload digest and decision evidence.
Exit `75` means still blocked (pending/rejected/withdrawn); other nonzero exits
mean unconfirmed/error. No branch silently retries, refreshes a token, changes a
key, or runs business commands. After an uncertain creation, explicitly rerun
with the **same saved key and identical input**; different content under the
same key is a conflict, not a new request. Never obtain the expected digest from
the Gate response. The business `artifactDigest` is not the Gate payload digest.

Only the caller may chain its own idempotent recovery step after exit `0`; Gate
does not provide exactly-once execution or execute the release. Use explicit
local `remove AGENT PERMISSION`, `disable AGENT`, `enable AGENT`,
`revoke-credential PUBLIC_ID`, or `revoke-token PUBLIC_ID` with `agent:local` to
exercise current permission/credential/token revocation. Disable/enable advances
generation so old tokens never revive; credential revocation invalidates every
token issued from it. These changes preserve historical request and decision
attribution.

`inspect`, `grant` and `remove` fail explicitly for a nonexistent Agent (404,
nonzero CLI exit); they never report a successful mutation or print `null`.
Repeated grant/removal for an existing Agent is idempotent and reports
`unchanged`, not `updated`; no-op operations do not append configuration audit
rows. CLI errors never include authentication secrets or raw exception payloads.

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

### 本地浏览器闭环验证

首次运行 `pnpm check` 前安装测试浏览器：

```sh
pnpm --filter @workspace/worker exec playwright install chromium
```

Linux CI 使用 `playwright install --with-deps chromium` 安装浏览器和系统依赖。
`pnpm check` 会先构建生产静态资源，再运行
`apps/worker/test/browser-runtime.test.ts`：Chromium 实际访问 Miniflare/workerd 的同源静态资源与 Worker
API，使用两份生产迁移及项目目录下隔离的 D1 持久化，覆盖 1440px/320px 创建、批准、拒绝、撤回、无权第三身份、键盘取消、故障恢复、权限撤销、运行时重启与注销后旧 cookie 重放拒绝。测试结束释放浏览器/运行时并清理数据。

测试仅在测试进程内模拟已验证的 GitHub account 输入，经生产 Auth.js
callback 与加密 cookie 建立真实本地会话；不拦截浏览器 API，不增加生产认证绕过接口，不读取
`.dev.vars`、真实凭据或访问云端。它不能代替真实 GitHub
OAuth、云端 D1 与授权试点环境的外部验收。

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
