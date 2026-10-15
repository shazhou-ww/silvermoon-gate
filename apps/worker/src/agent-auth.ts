import type { Bindings } from "./env.js";
import { GateStoreError } from "./gate-store.js";

export const agentAudience = "urn:silvermoon-gate:agent-api";
export const agentLifetime = 300;
export interface AgentPrincipal {
  readonly kind: "agent";
  readonly identityId: string;
  readonly tokenId: string;
  readonly tokenHash: string;
  readonly issuer: string;
}
export const agentNow = "unixepoch('now')";
export const validAgent = `EXISTS (
 SELECT 1 FROM gate_agent_tokens at
 JOIN gate_agent_credentials ac ON ac.id=at.credential_id AND ac.agent_id=at.agent_id
 JOIN gate_agent_identities ai ON ai.id=at.agent_id
 WHERE at.id=? AND at.secret_hash=? AND at.agent_id=? AND at.issuer=? AND at.audience=?
 AND at.revoked_at IS NULL AND ac.revoked_at IS NULL AND ai.status='active'
 AND at.generation=ai.token_generation
 AND at.issued_at<=${agentNow} AND at.expires_at>${agentNow} AND at.expires_at-at.issued_at<=300
 AND ac.issued_at<=${agentNow} AND ac.expires_at>${agentNow})`;
export function agentBindings(actor: AgentPrincipal): string[] {
  return [
    actor.tokenId,
    actor.tokenHash,
    actor.identityId,
    actor.issuer,
    agentAudience,
  ];
}
export function agentUnauthorized(): GateStoreError {
  return new GateStoreError(
    401,
    "Valid Agent authentication is required.",
    "AGENT_AUTH_REQUIRED",
  );
}
export function requireMachineRequest(request: Request): void {
  if (
    request.headers.has("cookie") ||
    request.headers.has("origin") ||
    request.headers.get("sec-fetch-site") === "cross-site"
  )
    throw new GateStoreError(
      403,
      "Machine authentication cannot use browser credentials.",
    );
}
export async function secretHash(
  kind: "credential" | "token",
  id: string,
  secret: string,
): Promise<string> {
  const bytes = new TextEncoder().encode(`gate-agent:${kind}:${id}:${secret}`);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
export function randomSecret(): string {
  return btoa(
    String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))),
  )
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}
async function hashesEqual(expected: string, actual: string): Promise<boolean> {
  // Web Crypto verifies a MAC in constant time, including in Node-based tests.
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode("gate-agent-hash-comparison-v1"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(expected),
  );
  return crypto.subtle.verify(
    "HMAC",
    key,
    signature,
    new TextEncoder().encode(actual),
  );
}
export async function assertAgent(
  db: D1Database,
  actor: AgentPrincipal,
): Promise<void> {
  const row = await db
    .prepare(`SELECT 1 AS valid WHERE ${validAgent}`)
    .bind(...agentBindings(actor))
    .first();
  if (!row) throw agentUnauthorized();
}
export async function resolveAgent(
  request: Request,
  env: Bindings,
): Promise<AgentPrincipal> {
  requireMachineRequest(request);
  if (!env.GATE_AGENT_ISSUER) throw agentUnauthorized();
  const match = /^Bearer gat_([a-f0-9-]{36})\.([A-Za-z0-9_-]{43})$/.exec(
    request.headers.get("authorization") ?? "",
  );
  if (!match) throw agentUnauthorized();
  const tokenId = match[1]!;
  const hash = await secretHash("token", tokenId, match[2]!);
  const row = await env.GATE_DB.prepare(
    "SELECT agent_id,secret_hash FROM gate_agent_tokens WHERE id=?",
  )
    .bind(tokenId)
    .first<{ agent_id: string; secret_hash: string }>();
  if (!row || !(await hashesEqual(row.secret_hash, hash)))
    throw agentUnauthorized();
  const actor: AgentPrincipal = {
    kind: "agent",
    identityId: row.agent_id,
    tokenId,
    tokenHash: hash,
    issuer: env.GATE_AGENT_ISSUER,
  };
  await assertAgent(env.GATE_DB, actor);
  return actor;
}
export async function exchangeCredential(
  env: Bindings,
  input: Record<string, unknown>,
) {
  if (
    !env.GATE_AGENT_ISSUER ||
    typeof input.credentialId !== "string" ||
    typeof input.credentialSecret !== "string" ||
    !/^[a-f0-9-]{36}$/.test(input.credentialId) ||
    !/^[A-Za-z0-9_-]{43}$/.test(input.credentialSecret)
  )
    throw agentUnauthorized();
  const hash = await secretHash(
    "credential",
    input.credentialId,
    input.credentialSecret,
  );
  const credential = await env.GATE_DB.prepare(
    "SELECT secret_hash FROM gate_agent_credentials WHERE id=?",
  )
    .bind(input.credentialId)
    .first<{ secret_hash: string }>();
  if (!credential || !(await hashesEqual(credential.secret_hash, hash)))
    throw agentUnauthorized();
  const id = crypto.randomUUID();
  const secret = randomSecret();
  const tokenHash = await secretHash("token", id, secret);
  const result = await env.GATE_DB.prepare(
    `INSERT INTO gate_agent_tokens
    (id,credential_id,agent_id,secret_hash,issuer,audience,generation,issued_at,expires_at)
    SELECT ?,ac.id,ac.agent_id,?,?,?,ai.token_generation,${agentNow},${agentNow}+300
    FROM gate_agent_credentials ac JOIN gate_agent_identities ai ON ai.id=ac.agent_id
    WHERE ac.id=? AND ac.secret_hash=? AND ac.revoked_at IS NULL AND ai.status='active'
    AND ac.issued_at<=${agentNow} AND ac.expires_at>${agentNow}`,
  )
    .bind(
      id,
      tokenHash,
      env.GATE_AGENT_ISSUER,
      agentAudience,
      input.credentialId,
      hash,
    )
    .run();
  if (result.meta.changes !== 1) throw agentUnauthorized();
  const row = await env.GATE_DB.prepare(
    "SELECT agent_id FROM gate_agent_tokens WHERE id=?",
  )
    .bind(id)
    .first<{ agent_id: string }>();
  if (!row) throw agentUnauthorized();
  return {
    accessToken: `gat_${id}.${secret}`,
    tokenType: "Bearer",
    expiresIn: agentLifetime,
    issuer: env.GATE_AGENT_ISSUER,
    audience: agentAudience,
    identityId: row.agent_id,
  };
}
