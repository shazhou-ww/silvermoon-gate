# Project Guidelines

## Development

- This preset is a pnpm/Turborepo workspace with a React/Vite frontend in
  `apps/web`, a Hono/Auth.js Worker in `apps/worker`, and shared contracts in
  `packages/contracts`.
- Use Node.js 22.13 or newer and pnpm 11.22 or newer.
- Install dependencies with `pnpm install`.
- Run `pnpm check` before submitting changes; use `pnpm dev` for local
  development.
- Keep shared third-party versions in the pnpm catalog and internal workspace
  dependencies on `workspace:*`.
- Keep each workspace's build, lint, test, and typecheck scripts aligned with
  `turbo.json`.
- Preserve the same-origin static asset and `/api/*` Worker routing described in
  `README.md`.

## Skills

- Manage project skills with `npx skills`.
- Keep all project skills under `.agent/skills/<skill-name>/`, with each skill's
  `SKILL.md` in its directory.

## Authentication and deployment

- Keep OAuth callback URLs, session handling, and protected API routes aligned;
  do not weaken server-side authorization.
- Never commit `.dev.vars` or real credentials. Update only `.dev.vars.example`
  when documenting required variables.
- Keep push deployment disabled by default. Do not deploy or enable production
  deployment unless explicitly requested.
