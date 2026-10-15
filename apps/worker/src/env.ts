export interface Bindings {
  readonly APP_NAME: string;
  readonly ASSETS: Fetcher;
  readonly GATE_DB: D1Database;
  readonly AUTH_GITHUB_ID?: string;
  readonly AUTH_GITHUB_SECRET?: string;
  readonly AUTH_SECRET: string;
  readonly AUTH_URL?: string;
  readonly GATE_AGENT_ISSUER?: string;
}
