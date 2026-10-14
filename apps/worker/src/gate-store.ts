import {
  calculatePayloadDigest,
  calculateRequestFingerprint,
  canonicalizeJson,
  type CreateGateRequest,
  type GateJsonValue,
  type GateRequestAction,
  type GateRequestStatus,
  transitionRequestStatus,
} from "@workspace/contracts";
import Ajv from "ajv";

export class GateStoreError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 503,
    message: string,
    readonly code = status === 400
      ? "INVALID_INPUT"
      : status === 401
        ? "SESSION_REQUIRED"
        : status === 403
          ? "ACTION_NOT_ALLOWED"
          : status === 404
            ? "REQUEST_NOT_ACCESSIBLE"
            : status === 413
              ? "PAYLOAD_TOO_LARGE"
              : status === 503
                ? "SERVICE_BUSY"
                : "REQUEST_TERMINAL",
    readonly fieldErrors?: Readonly<Record<string, string>>,
  ) {
    super(message);
    this.name = "GateStoreError";
  }
}

export interface Principal {
  readonly identityId: string;
  readonly sessionId: string;
}
export interface GateRequestEvent {
  readonly type: "created" | "approved" | "rejected" | "withdrawn";
  readonly actorIdentityId: string;
  readonly occurredAt: string;
}
export interface GateRequestRecord {
  readonly id: string;
  readonly status: GateRequestStatus;
  readonly requesterIdentityId: string;
  readonly templateId: string;
  readonly templateVersion: number;
  readonly payloadSchemaVersion: number;
  readonly payload: GateJsonValue;
  readonly payloadDigest: string;
  readonly threadId: string | null;
  readonly createdAt: string;
  readonly decidedAt: string | null;
  readonly decidedBy: string | null;
  readonly events: readonly GateRequestEvent[];
  readonly allowedActions: readonly GateRequestAction[];
}

export const releaseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["action", "candidate", "artifactDigest", "environment", "summary"],
  properties: {
    action: { const: "release" },
    candidate: { type: "string", minLength: 1, maxLength: 100, pattern: "\\S" },
    artifactDigest: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" },
    environment: { const: "test" },
    summary: { type: "string", minLength: 1, maxLength: 500, pattern: "\\S" },
  },
} as const;
const validatePayload = new Ajv({ strict: true, allErrors: true }).compile(
  releaseSchema,
);
const dbNow = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
// Included in each payload read and conditional write, not just middleware.
const validSession = `EXISTS (SELECT 1 FROM gate_sessions s JOIN gate_identities i ON i.id=s.identity_id
 WHERE s.id=? AND i.id=? AND i.status='active' AND s.revoked_at IS NULL
 AND s.generation=i.session_generation AND s.expires_at>${dbNow})`;
const canDecide = `EXISTS (SELECT 1 FROM gate_template_access a
 WHERE a.identity_id=? AND a.template_id=r.template_id AND a.template_version=r.template_version AND a.permission='decide')`;
const canRead = `(r.requester_identity_id=? OR ${canDecide})`;
const selection = `r.*, COALESCE((SELECT json_group_array(json_object(
 'type',e.event_type,'actorIdentityId',e.actor_identity_id,'occurredAt',e.occurred_at))
 FROM (SELECT * FROM gate_request_events WHERE request_id=r.id ORDER BY sequence) e),'[]') AS events_json,
 ${canDecide} AS can_decide`;
interface RequestRow {
  id: string;
  status: GateRequestStatus;
  requester_identity_id: string;
  template_id: string;
  template_version: number;
  payload_schema_version: number;
  payload_json: string;
  payload_digest: string;
  thread_id: string | null;
  created_at: string;
  decided_at: string | null;
  decided_by: string | null;
  events_json: string;
  can_decide: number;
  request_fingerprint: string;
}
function toRecord(row: RequestRow, actor: Principal): GateRequestRecord {
  return {
    id: row.id,
    status: row.status,
    requesterIdentityId: row.requester_identity_id,
    templateId: row.template_id,
    templateVersion: row.template_version,
    payloadSchemaVersion: row.payload_schema_version,
    payload: JSON.parse(row.payload_json) as GateJsonValue,
    payloadDigest: row.payload_digest,
    threadId: row.thread_id,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
    decidedBy: row.decided_by,
    events: JSON.parse(row.events_json) as GateRequestEvent[],
    allowedActions:
      row.status !== "pending"
        ? []
        : row.requester_identity_id === actor.identityId
          ? ["withdraw"]
          : row.can_decide
            ? ["approve", "reject"]
            : [],
  };
}
export async function getIdentity(db: D1Database, actor: Principal) {
  const row = await db
    .prepare(
      `SELECT i.id,i.name,
    EXISTS(SELECT 1 FROM gate_template_access a JOIN gate_template_entry t
     ON t.template_id=a.template_id AND t.template_version=a.template_version
     WHERE a.identity_id=i.id AND a.template_id='release-review' AND a.template_version=1
     AND a.permission='create' AND t.enabled=1) AS can_create,
    EXISTS(SELECT 1 FROM gate_template_access a WHERE a.identity_id=i.id
     AND a.template_id='release-review' AND a.template_version=1 AND a.permission='decide') AS can_decide
    FROM gate_identities i WHERE i.id=? AND ${validSession}`,
    )
    .bind(actor.identityId, actor.sessionId, actor.identityId)
    .first<{
      id: string;
      name: string;
      can_create: number;
      can_decide: number;
    }>();
  if (!row)
    throw new GateStoreError(401, "A current authorized session is required.");
  return {
    identity: { id: row.id, name: row.name },
    permissions: { canCreate: !!row.can_create, canDecide: !!row.can_decide },
  };
}
export async function getTemplates(db: D1Database, actor: Principal) {
  await getIdentity(db, actor);
  const rows = await db
    .prepare(
      `SELECT t.template_id AS id,t.version,
    t.payload_schema_version AS payloadSchemaVersion,t.title,t.description
    FROM gate_templates t JOIN gate_template_entry e
    ON e.template_id=t.template_id AND e.template_version=t.version
    WHERE t.template_id='release-review' AND t.version=1 AND e.enabled=1`,
    )
    .all();
  return rows.results;
}
async function readRow(db: D1Database, id: string, actor: Principal) {
  return db
    .prepare(
      `SELECT ${selection} FROM gate_requests r WHERE r.id=? AND ${validSession} AND ${canRead}`,
    )
    .bind(
      actor.identityId,
      id,
      actor.sessionId,
      actor.identityId,
      actor.identityId,
      actor.identityId,
    )
    .first<RequestRow>();
}
export async function getRequest(
  db: D1Database,
  id: string,
  actor: Principal,
): Promise<GateRequestRecord> {
  const row = await readRow(db, id, actor);
  if (!row)
    throw new GateStoreError(
      404,
      "Request is not accessible or does not exist.",
    );
  return toRecord(row, actor);
}
export function validateCreate(
  input: Omit<CreateGateRequest, "requesterIdentityId" | "idempotencyKey">,
) {
  if (
    input.templateId !== "release-review" ||
    input.templateVersion !== 1 ||
    input.payloadSchemaVersion !== 1 ||
    !validatePayload(input.payload) ||
    (input.threadId !== undefined &&
      (typeof input.threadId !== "string" ||
        !input.threadId.trim() ||
        [...input.threadId].length > 100))
  ) {
    const fieldErrors: Record<string, string> = {};
    for (const error of validatePayload.errors ?? []) {
      const missing: unknown = error.params.missingProperty;
      const name =
        error.instancePath.slice(1) ||
        (typeof missing === "string" ? missing : "payload");
      fieldErrors[name] = "Invalid or missing release-review field.";
    }
    throw new GateStoreError(
      400,
      "The fixed release-review v1 payload or envelope is invalid.",
      "INVALID_INPUT",
      fieldErrors,
    );
  }
  try {
    canonicalizeJson(input);
  } catch {
    throw new GateStoreError(400, "Input must contain valid Unicode and JSON.");
  }
}
export async function createRequest(
  db: D1Database,
  actor: Principal,
  idempotencyKey: string,
  input: Omit<CreateGateRequest, "requesterIdentityId" | "idempotencyKey">,
) {
  validateCreate(input);
  if (!/^[\x21-\x7e]{1,200}$/.test(idempotencyKey))
    throw new GateStoreError(400, "Invalid Idempotency-Key.");
  const fingerprint = await calculateRequestFingerprint({
    ...input,
    requesterIdentityId: actor.identityId,
    idempotencyKey,
  });
  const existing = await db
    .prepare(
      `SELECT ${selection} FROM gate_requests r
    WHERE r.requester_identity_id=? AND r.idempotency_key=? AND ${validSession} AND ${canRead}`,
    )
    .bind(
      actor.identityId,
      actor.identityId,
      idempotencyKey,
      actor.sessionId,
      actor.identityId,
      actor.identityId,
      actor.identityId,
    )
    .first<RequestRow>();
  if (existing) {
    if (existing.request_fingerprint !== fingerprint)
      throw new GateStoreError(
        409,
        "Key already used for different content.",
        "IDEMPOTENCY_CONFLICT",
      );
    return { created: false, request: toRecord(existing, actor) };
  }
  const id = crypto.randomUUID();
  const digest = await calculatePayloadDigest(1, input.payload);
  const result = await db.batch([
    db
      .prepare(
        `INSERT INTO gate_requests(id,idempotency_key,request_fingerprint,requester_identity_id,
     template_id,template_version,payload_schema_version,payload_json,payload_digest,thread_id,status,created_at)
     SELECT ?,?,?,?,'release-review',1,1,?,?,?,'pending',${dbNow}
     WHERE ${validSession} AND EXISTS(SELECT 1 FROM gate_template_access a JOIN gate_template_entry e
      ON e.template_id=a.template_id AND e.template_version=a.template_version
      WHERE a.identity_id=? AND a.template_id='release-review' AND a.template_version=1
      AND a.permission='create' AND e.enabled=1)
     ON CONFLICT(requester_identity_id,idempotency_key) DO NOTHING`,
      )
      .bind(
        id,
        idempotencyKey,
        fingerprint,
        actor.identityId,
        canonicalizeJson(input.payload),
        digest,
        input.threadId ?? null,
        actor.sessionId,
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
  const stored = await db
    .prepare(
      `SELECT ${selection} FROM gate_requests r
    WHERE r.requester_identity_id=? AND r.idempotency_key=? AND ${validSession} AND ${canRead}`,
    )
    .bind(
      actor.identityId,
      actor.identityId,
      idempotencyKey,
      actor.sessionId,
      actor.identityId,
      actor.identityId,
      actor.identityId,
    )
    .first<RequestRow>();
  if (!stored) {
    await getIdentity(db, actor);
    throw new GateStoreError(403, "Creating this template is not allowed.");
  }
  if (stored.request_fingerprint !== fingerprint)
    throw new GateStoreError(
      409,
      "Key already used for different content.",
      "IDEMPOTENCY_CONFLICT",
    );
  return {
    created: result[0]?.meta.changes === 1,
    request: toRecord(stored, actor),
  };
}
export async function transitionRequest(
  db: D1Database,
  id: string,
  actor: Principal,
  action: GateRequestAction,
) {
  await getRequest(db, id, actor);
  const operationId = crypto.randomUUID();
  const status = transitionRequestStatus("pending", action);
  const permission =
    action === "withdraw"
      ? "r.requester_identity_id=?"
      : `r.requester_identity_id!=? AND ${canDecide}`;
  const bindings =
    action === "withdraw"
      ? [actor.identityId]
      : [actor.identityId, actor.identityId];
  const statements = [
    db
      .prepare(
        `UPDATE gate_requests AS r SET status=?,decided_by=?,decided_at=${dbNow},terminal_operation_id=?
      WHERE r.id=? AND r.status='pending' AND ${validSession} AND ${permission}`,
      )
      .bind(
        status,
        actor.identityId,
        operationId,
        id,
        actor.sessionId,
        actor.identityId,
        ...bindings,
      ),
  ];
  if (action !== "withdraw")
    statements.push(
      db
        .prepare(
          `INSERT INTO gate_decisions
    (id,request_id,operation_id,actor_identity_id,authority_identity_id,outcome,identity_revision,access_revision,authority_evidence,decided_at)
    SELECT ?,r.id,r.terminal_operation_id,r.decided_by,r.decided_by,r.status,i.revision,a.revision,
     json_object('kind','direct','identityId',i.id,'identityRevision',i.revision,'accessRevision',a.revision,
      'templateId',r.template_id,'templateVersion',r.template_version,'permission','decide'),r.decided_at
    FROM gate_requests r JOIN gate_identities i ON i.id=r.decided_by
    JOIN gate_template_access a ON a.identity_id=i.id AND a.template_id=r.template_id
     AND a.template_version=r.template_version AND a.permission='decide'
    WHERE r.id=? AND r.terminal_operation_id=?`,
        )
        .bind(crypto.randomUUID(), id, operationId),
    );
  statements.push(
    db
      .prepare(
        `INSERT INTO gate_request_events(request_id,event_type,actor_identity_id,occurred_at,operation_id)
    SELECT id,status,decided_by,decided_at,terminal_operation_id FROM gate_requests WHERE id=? AND terminal_operation_id=?`,
      )
      .bind(id, operationId),
  );
  const result = await db.batch(statements);
  const record = await getRequest(db, id, actor);
  if (result[0]?.meta.changes !== 1) {
    if (record.status !== "pending")
      throw new GateStoreError(409, "Request already has a terminal result.");
    throw new GateStoreError(403, "This action is not allowed.");
  }
  return record;
}

export interface ListFilter {
  view: "mine" | "inbox";
  status: GateRequestStatus | null;
  limit: number;
  after?: { createdAt: string; id: string };
}
export async function listRequests(
  db: D1Database,
  actor: Principal,
  filter: ListFilter,
) {
  await getIdentity(db, actor);
  const conditions = [validSession, canRead];
  const values: (string | number)[] = [
    actor.identityId,
    actor.sessionId,
    actor.identityId,
    actor.identityId,
    actor.identityId,
  ];
  if (filter.view === "mine") {
    conditions.push("r.requester_identity_id=?");
    values.push(actor.identityId);
  } else {
    conditions.push(
      `r.status='pending' AND r.requester_identity_id!=? AND ${canDecide}`,
    );
    values.push(actor.identityId, actor.identityId);
  }
  if (filter.status) {
    conditions.push("r.status=?");
    values.push(filter.status);
  }
  if (filter.after) {
    conditions.push("(r.created_at<? OR (r.created_at=? AND r.id<?))");
    values.push(
      filter.after.createdAt,
      filter.after.createdAt,
      filter.after.id,
    );
  }
  values.push(filter.limit + 1);
  const result = await db
    .prepare(
      `SELECT ${selection} FROM gate_requests r WHERE ${conditions.join(" AND ")}
    ORDER BY r.created_at DESC,r.id DESC LIMIT ?`,
    )
    .bind(...values)
    .all<RequestRow>();
  const rows = result.results.slice(0, filter.limit);
  const last = rows.at(-1);
  return {
    items: rows.map((row) => toRecord(row, actor)),
    after:
      result.results.length > filter.limit && last
        ? { createdAt: last.created_at, id: last.id }
        : null,
  };
}
