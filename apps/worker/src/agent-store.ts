import {
  calculatePayloadDigest,
  calculateRequestFingerprint,
  canonicalizeJson,
  type CreateGateRequest,
} from "@workspace/contracts";
import {
  agentBindings,
  assertAgent,
  validAgent,
  type AgentPrincipal,
} from "./agent-auth.js";
import {
  GateStoreError,
  requestRecord,
  requestSelection,
  validateCreate,
  type RequestRow,
} from "./gate-store.js";

type Input = Omit<CreateGateRequest, "requesterIdentityId" | "idempotencyKey">;
const now = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
function access(permission: "create" | "read" | "withdraw") {
  return `EXISTS(SELECT 1 FROM gate_agent_template_access a
   WHERE a.agent_id=? AND a.template_id=r.template_id AND a.template_version=r.template_version AND a.permission='${permission}')`;
}
const selection = `${requestSelection},0 AS can_decide,${access("withdraw")} AS can_withdraw`;
interface AgentRow extends RequestRow {
  can_withdraw: number;
}
function record(row: AgentRow) {
  return requestRecord(
    row,
    row.status === "pending" && row.can_withdraw ? ["withdraw"] : [],
  );
}
async function read(
  db: D1Database,
  actor: AgentPrincipal,
  key: "id" | "idempotency_key",
  value: string,
  create = false,
) {
  return db
    .prepare(
      `SELECT ${selection} FROM gate_requests r
    WHERE r.${key}=? AND r.requester_identity_id=? AND ${validAgent} AND ${access("read")}
    ${create ? `AND ${access("create")}` : ""}`,
    )
    .bind(
      actor.identityId,
      value,
      actor.identityId,
      ...agentBindings(actor),
      actor.identityId,
      ...(create ? [actor.identityId] : []),
    )
    .first<AgentRow>();
}
export async function getAgentRequest(
  db: D1Database,
  actor: AgentPrincipal,
  id: string,
) {
  await assertAgent(db, actor);
  const row = await read(db, actor, "id", id);
  if (!row)
    throw new GateStoreError(
      404,
      "Request is not accessible or does not exist.",
    );
  return record(row);
}
export async function createAgentRequest(
  db: D1Database,
  actor: AgentPrincipal,
  key: string,
  input: Input,
) {
  validateCreate(input);
  if (!/^[\x21-\x7e]{1,200}$/.test(key))
    throw new GateStoreError(400, "Invalid Idempotency-Key.");
  await assertAgent(db, actor);
  const fingerprint = await calculateRequestFingerprint({
    ...input,
    requesterIdentityId: actor.identityId,
    idempotencyKey: key,
  });
  const existing = await read(db, actor, "idempotency_key", key, true);
  if (existing) {
    if (existing.request_fingerprint !== fingerprint)
      throw new GateStoreError(
        409,
        "Key already used for different content.",
        "IDEMPOTENCY_CONFLICT",
      );
    return { request: record(existing), replayed: true };
  }
  const id = crypto.randomUUID();
  const digest = await calculatePayloadDigest(1, input.payload);
  const result = await db.batch([
    db
      .prepare(
        `INSERT INTO gate_requests(id,idempotency_key,request_fingerprint,requester_identity_id,
     template_id,template_version,payload_schema_version,payload_json,payload_digest,thread_id,status,created_at)
     SELECT ?,?,?,?,'release-review',1,1,?,?,?,'pending',${now}
     WHERE ${validAgent} AND EXISTS(SELECT 1 FROM gate_template_entry e WHERE e.template_id='release-review'
      AND e.template_version=1 AND e.enabled=1)
     AND EXISTS(SELECT 1 FROM gate_agent_template_access WHERE agent_id=? AND template_id='release-review'
      AND template_version=1 AND permission='create')
     AND EXISTS(SELECT 1 FROM gate_agent_template_access WHERE agent_id=? AND template_id='release-review'
      AND template_version=1 AND permission='read')
     ON CONFLICT(requester_identity_id,idempotency_key) DO NOTHING`,
      )
      .bind(
        id,
        key,
        fingerprint,
        actor.identityId,
        canonicalizeJson(input.payload),
        digest,
        input.threadId ?? null,
        ...agentBindings(actor),
        actor.identityId,
        actor.identityId,
      ),
    db
      .prepare(
        `INSERT INTO gate_request_events(request_id,event_type,actor_identity_id,occurred_at,operation_id)
     SELECT id,'created',requester_identity_id,created_at,? FROM gate_requests WHERE id=?`,
      )
      .bind(crypto.randomUUID(), id),
  ]);
  const stored = await read(db, actor, "idempotency_key", key, true);
  if (!stored) {
    await assertAgent(db, actor);
    throw new GateStoreError(
      403,
      "Creating this template requires direct create and read permissions.",
    );
  }
  if (stored.request_fingerprint !== fingerprint)
    throw new GateStoreError(
      409,
      "Key already used for different content.",
      "IDEMPOTENCY_CONFLICT",
    );
  return { request: record(stored), replayed: result[0]?.meta.changes !== 1 };
}
export async function withdrawAgentRequest(
  db: D1Database,
  actor: AgentPrincipal,
  id: string,
) {
  await getAgentRequest(db, actor, id);
  const operation = crypto.randomUUID();
  const result = await db.batch([
    db
      .prepare(
        `UPDATE gate_requests AS r SET status='withdrawn',decided_by=?,decided_at=${now},terminal_operation_id=?
     WHERE r.id=? AND r.status='pending' AND r.requester_identity_id=? AND ${validAgent}
     AND ${access("read")} AND ${access("withdraw")}`,
      )
      .bind(
        actor.identityId,
        operation,
        id,
        actor.identityId,
        ...agentBindings(actor),
        actor.identityId,
        actor.identityId,
      ),
    db
      .prepare(
        `INSERT INTO gate_request_events(request_id,event_type,actor_identity_id,occurred_at,operation_id)
     SELECT id,status,decided_by,decided_at,terminal_operation_id FROM gate_requests WHERE id=? AND terminal_operation_id=?`,
      )
      .bind(id, operation),
  ]);
  const current = await getAgentRequest(db, actor, id);
  if (result[0]?.meta.changes !== 1) {
    if (current.status !== "pending")
      throw new GateStoreError(409, "Request already has a terminal result.");
    throw new GateStoreError(403, "Withdrawing requires direct permission.");
  }
  return current;
}
