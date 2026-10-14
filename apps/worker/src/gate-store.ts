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

export interface CreateGateTemplate {
  readonly description?: string;
  readonly id: string;
  readonly approverIdentityIds: readonly string[];
  readonly payloadSchemaVersion: number;
  readonly title: string;
}

export interface GateTemplateSummary {
  readonly description: string | null;
  readonly id: string;
  readonly payloadSchemaVersion: number;
  readonly title: string;
  readonly version: number;
}

export interface GateRequestRecord {
  readonly createdAt: string;
  readonly decidedAt: string | null;
  readonly decidedBy: string | null;
  readonly events: readonly GateRequestEvent[];
  readonly id: string;
  readonly payload: GateJsonValue;
  readonly payloadDigest: string;
  readonly payloadSchemaVersion: number;
  readonly requesterIdentityId: string;
  readonly status: GateRequestStatus;
  readonly templateId: string;
  readonly templateVersion: number;
  readonly threadId: string | null;
}

export interface GateRequestEvent {
  readonly actorIdentityId: string;
  readonly occurredAt: string;
  readonly type: "approved" | "created" | "rejected" | "withdrawn";
}

export class GateStoreError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409,
    message: string,
  ) {
    super(message);
    this.name = "GateStoreError";
  }
}

interface TemplateRow {
  readonly description: string | null;
  readonly payload_schema_version: number;
  readonly template_id: string;
  readonly title: string;
  readonly version: number;
}

interface RequestRow {
  readonly created_at: string;
  readonly decided_at: string | null;
  readonly decided_by: string | null;
  readonly id: string;
  readonly payload_digest: string;
  readonly payload_json: string;
  readonly payload_schema_version: number;
  readonly requester_identity_id: string;
  readonly status: GateRequestStatus;
  readonly template_id: string;
  readonly template_version: number;
  readonly thread_id: string | null;
}

interface EventRow {
  readonly actor_identity_id: string;
  readonly event_type: GateRequestEvent["type"];
  readonly occurred_at: string;
}

export async function createTemplate(
  db: D1Database,
  actorIdentityId: string,
  input: CreateGateTemplate,
  now = new Date().toISOString(),
): Promise<GateTemplateSummary> {
  assertIdentityId(actorIdentityId);
  assertTemplateId(input.id);
  assertPositiveInteger(input.payloadSchemaVersion, "Payload schema version");
  const title = assertText(input.title, "Template title", 120);
  const description =
    input.description === undefined
      ? null
      : assertText(input.description, "Template description", 1000);
  const approvers = normalizeIdentityIds(input.approverIdentityIds);

  const statements = [
    db
      .prepare(
        `INSERT INTO gate_templates
          (template_id, version, title, description, payload_schema_version,
           created_by, created_at)
         VALUES (
          ?, COALESCE(
            (SELECT MAX(version) + 1 FROM gate_templates WHERE template_id = ?),
            1
          ), ?, ?, ?, ?, ?
         )`,
      )
      .bind(
        input.id,
        input.id,
        title,
        description,
        input.payloadSchemaVersion,
        actorIdentityId,
        now,
      ),
    ...approvers.map((identityId) =>
      db
        .prepare(
          `INSERT INTO gate_template_approvers
            (template_id, template_version, identity_id)
           SELECT template_id, MAX(version), ?
           FROM gate_templates
           WHERE template_id = ?`,
        )
        .bind(identityId, input.id),
    ),
    ...approvers.map((identityId) =>
      db
        .prepare(
          `INSERT INTO gate_template_approver_events
            (template_id, template_version, approver_identity_id, action,
             actor_identity_id, occurred_at)
           SELECT template_id, MAX(version), ?, 'added', ?, ?
           FROM gate_templates
           WHERE template_id = ?`,
        )
        .bind(identityId, actorIdentityId, now, input.id),
    ),
  ];
  await db.batch(statements);

  const template = await db
    .prepare(
      `SELECT template_id, version, title, description, payload_schema_version
       FROM gate_templates
       WHERE template_id = ?
       ORDER BY version DESC
       LIMIT 1`,
    )
    .bind(input.id)
    .first<TemplateRow>();

  if (!template) {
    throw new Error("The template could not be read after creation.");
  }

  return toTemplateSummary(template);
}

export async function getTemplates(
  db: D1Database,
): Promise<readonly GateTemplateSummary[]> {
  const result = await db
    .prepare(
      `SELECT template_id, version, title, description, payload_schema_version
       FROM gate_templates AS template
       WHERE version = (
         SELECT MAX(current.version)
         FROM gate_templates AS current
         WHERE current.template_id = template.template_id
       )
       ORDER BY template_id`,
    )
    .all<TemplateRow>();

  return result.results.map(toTemplateSummary);
}

export async function replaceTemplateApprovers(
  db: D1Database,
  templateId: string,
  version: number,
  actorIdentityId: string,
  approverIdentityIds: readonly string[],
  now = new Date().toISOString(),
): Promise<void> {
  assertTemplateId(templateId);
  assertPositiveInteger(version, "Template version");
  assertIdentityId(actorIdentityId);
  const approvers = normalizeIdentityIds(approverIdentityIds);
  const template = await db
    .prepare(
      `SELECT 1 AS found
       FROM gate_templates
       WHERE template_id = ? AND version = ?`,
    )
    .bind(templateId, version)
    .first<{ readonly found: number }>();

  if (!template) {
    throw new GateStoreError(404, "Template version not found.");
  }

  await db.batch([
    db
      .prepare(
        `INSERT INTO gate_template_approver_events
          (template_id, template_version, approver_identity_id, action,
           actor_identity_id, occurred_at)
         SELECT template_id, template_version, identity_id, 'removed', ?, ?
         FROM gate_template_approvers
         WHERE template_id = ? AND template_version = ?`,
      )
      .bind(actorIdentityId, now, templateId, version),
    db
      .prepare(
        `DELETE FROM gate_template_approvers
         WHERE template_id = ? AND template_version = ?`,
      )
      .bind(templateId, version),
    ...approvers.map((identityId) =>
      db
        .prepare(
          `INSERT INTO gate_template_approvers
            (template_id, template_version, identity_id)
           VALUES (?, ?, ?)`,
        )
        .bind(templateId, version, identityId),
    ),
    ...approvers.map((identityId) =>
      db
        .prepare(
          `INSERT INTO gate_template_approver_events
            (template_id, template_version, approver_identity_id, action,
             actor_identity_id, occurred_at)
           VALUES (?, ?, ?, 'added', ?, ?)`,
        )
        .bind(templateId, version, identityId, actorIdentityId, now),
    ),
  ]);
}

export async function createRequest(
  db: D1Database,
  requesterIdentityId: string,
  idempotencyKey: string,
  input: Omit<CreateGateRequest, "idempotencyKey" | "requesterIdentityId">,
  now = new Date().toISOString(),
): Promise<{ readonly created: boolean; readonly request: GateRequestRecord }> {
  assertIdentityId(requesterIdentityId);
  assertText(idempotencyKey, "Idempotency key", 200);
  const request: CreateGateRequest = {
    ...input,
    idempotencyKey,
    requesterIdentityId,
  };
  const payloadJson = canonicalizeJson(request.payload);
  const payloadDigest = await calculatePayloadDigest(
    request.payloadSchemaVersion,
    request.payload,
  );
  const fingerprint = await calculateRequestFingerprint(request);
  const template = await db
    .prepare(
      `SELECT payload_schema_version
       FROM gate_templates
       WHERE template_id = ? AND version = ?`,
    )
    .bind(request.templateId, request.templateVersion)
    .first<{ readonly payload_schema_version: number }>();

  if (!template) {
    throw new GateStoreError(404, "Template version not found.");
  }
  if (template.payload_schema_version !== request.payloadSchemaVersion) {
    throw new GateStoreError(
      400,
      "Payload schema version does not match the pinned template version.",
    );
  }

  const id = crypto.randomUUID();
  const results = await db.batch([
    db
      .prepare(
        `INSERT OR IGNORE INTO gate_requests (
          id, idempotency_key, request_fingerprint, requester_identity_id,
          template_id, template_version, payload_schema_version, payload_json,
          payload_digest, thread_id, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      )
      .bind(
        id,
        idempotencyKey,
        fingerprint,
        requesterIdentityId,
        request.templateId,
        request.templateVersion,
        request.payloadSchemaVersion,
        payloadJson,
        payloadDigest,
        request.threadId ?? null,
        now,
      ),
    db
      .prepare(
        `INSERT OR IGNORE INTO gate_request_events
          (request_id, event_type, actor_identity_id, occurred_at)
         SELECT id, 'created', requester_identity_id, created_at
         FROM gate_requests
         WHERE id = ?`,
      )
      .bind(id),
  ]);
  const stored = await db
    .prepare(
      `SELECT id, request_fingerprint
       FROM gate_requests
       WHERE requester_identity_id = ? AND idempotency_key = ?`,
    )
    .bind(requesterIdentityId, idempotencyKey)
    .first<{ readonly id: string; readonly request_fingerprint: string }>();

  if (!stored) {
    throw new Error("The request was not persisted.");
  }
  if (stored.request_fingerprint !== fingerprint) {
    throw new GateStoreError(
      409,
      "Idempotency key was already used for different request content.",
    );
  }

  const record = await getRequest(db, stored.id, requesterIdentityId);
  if (!record) {
    throw new Error("The persisted request could not be read.");
  }

  return {
    created: results[0]?.meta.changes === 1,
    request: record,
  };
}

export async function getRequest(
  db: D1Database,
  id: string,
  viewerIdentityId: string,
): Promise<GateRequestRecord | null> {
  assertRequestId(id);
  assertIdentityId(viewerIdentityId);
  const row = await db
    .prepare(
      `SELECT request.id, request.requester_identity_id, request.template_id,
          request.template_version, request.payload_schema_version,
          request.payload_json, request.payload_digest, request.thread_id,
          request.status, request.created_at, request.decided_at,
          request.decided_by
       FROM gate_requests AS request
       WHERE request.id = ?
         AND (
           request.requester_identity_id = ?
           OR EXISTS (
             SELECT 1
             FROM gate_template_approvers AS approver
             WHERE approver.template_id = request.template_id
               AND approver.template_version = request.template_version
               AND approver.identity_id = ?
           )
         )`,
    )
    .bind(id, viewerIdentityId, viewerIdentityId)
    .first<RequestRow>();

  if (!row) {
    return null;
  }

  return toGateRequestRecord(db, id, row);
}

async function readRequestRecord(
  db: D1Database,
  id: string,
): Promise<GateRequestRecord | null> {
  const row = await db
    .prepare(
      `SELECT request.id, request.requester_identity_id, request.template_id,
          request.template_version, request.payload_schema_version,
          request.payload_json, request.payload_digest, request.thread_id,
          request.status, request.created_at, request.decided_at,
          request.decided_by
       FROM gate_requests AS request
       WHERE request.id = ?`,
    )
    .bind(id)
    .first<RequestRow>();

  if (!row) {
    return null;
  }
  return toGateRequestRecord(db, id, row);
}

async function toGateRequestRecord(
  db: D1Database,
  id: string,
  row: RequestRow,
): Promise<GateRequestRecord> {
  const eventRows = await db
    .prepare(
      `SELECT event_type, actor_identity_id, occurred_at
       FROM gate_request_events
       WHERE request_id = ?
       ORDER BY sequence`,
    )
    .bind(id)
    .all<EventRow>();

  let payload: GateJsonValue;
  try {
    payload = JSON.parse(row.payload_json) as GateJsonValue;
  } catch (error) {
    throw new Error("Stored request payload is invalid JSON.", {
      cause: error,
    });
  }

  return {
    createdAt: row.created_at,
    decidedAt: row.decided_at,
    decidedBy: row.decided_by,
    events: eventRows.results.map((event) => ({
      actorIdentityId: event.actor_identity_id,
      occurredAt: event.occurred_at,
      type: event.event_type,
    })),
    id: row.id,
    payload,
    payloadDigest: row.payload_digest,
    payloadSchemaVersion: row.payload_schema_version,
    requesterIdentityId: row.requester_identity_id,
    status: row.status,
    templateId: row.template_id,
    templateVersion: row.template_version,
    threadId: row.thread_id,
  };
}

export async function transitionRequest(
  db: D1Database,
  requestId: string,
  actorIdentityId: string,
  action: GateRequestAction,
  now = new Date().toISOString(),
): Promise<GateRequestRecord> {
  assertRequestId(requestId);
  assertIdentityId(actorIdentityId);
  const targetStatus = transitionRequestStatus("pending", action);
  const row = await db
    .prepare(
      `SELECT requester_identity_id, template_id, template_version, status
       FROM gate_requests
       WHERE id = ?`,
    )
    .bind(requestId)
    .first<{
      readonly requester_identity_id: string;
      readonly status: GateRequestStatus;
      readonly template_id: string;
      readonly template_version: number;
    }>();

  if (!row) {
    throw new GateStoreError(404, "Request not found.");
  }

  if (action === "withdraw" && row.requester_identity_id !== actorIdentityId) {
    throw new GateStoreError(404, "Request not found.");
  }

  const permissionPredicate =
    action === "withdraw"
      ? "requester_identity_id = ?"
      : `EXISTS (
          SELECT 1
          FROM gate_template_approvers AS approver
          WHERE approver.template_id = gate_requests.template_id
            AND approver.template_version = gate_requests.template_version
            AND approver.identity_id = ?
        )`;
  const result = await db.batch([
    db
      .prepare(
        `UPDATE gate_requests
         SET status = ?, decided_at = ?, decided_by = ?
         WHERE id = ? AND status = 'pending' AND ${permissionPredicate}`,
      )
      .bind(targetStatus, now, actorIdentityId, requestId, actorIdentityId),
    db
      .prepare(
        `INSERT INTO gate_request_events
          (request_id, event_type, actor_identity_id, occurred_at)
         SELECT id, ?, ?, ?
         FROM gate_requests
         WHERE id = ? AND status = ? AND decided_by = ?
           AND NOT EXISTS (
             SELECT 1 FROM gate_request_events
             WHERE request_id = ? AND event_type = ?
           )`,
      )
      .bind(
        targetStatus,
        actorIdentityId,
        now,
        requestId,
        targetStatus,
        actorIdentityId,
        requestId,
        targetStatus,
      ),
  ]);

  if (result[0]?.meta.changes !== 1) {
    const current = await db
      .prepare(`SELECT status FROM gate_requests WHERE id = ?`)
      .bind(requestId)
      .first<{ readonly status: GateRequestStatus }>();
    if (current && current.status !== "pending") {
      throw new GateStoreError(409, `Request is already ${current.status}.`);
    }
    throw new GateStoreError(403, "Identity is not eligible for this action.");
  }

  const request = await readRequestRecord(db, requestId);
  if (!request) {
    throw new Error("The transitioned request could not be read.");
  }

  return request;
}

function toTemplateSummary(row: TemplateRow): GateTemplateSummary {
  return {
    description: row.description,
    id: row.template_id,
    payloadSchemaVersion: row.payload_schema_version,
    title: row.title,
    version: row.version,
  };
}

function normalizeIdentityIds(
  identityIds: readonly string[],
): readonly string[] {
  if (identityIds.length === 0) {
    throw new GateStoreError(
      400,
      "At least one approver identity is required.",
    );
  }

  const normalized = [
    ...new Set(identityIds.map((id) => assertIdentityId(id))),
  ];
  if (normalized.length !== identityIds.length) {
    throw new GateStoreError(400, "Approver identity IDs must be unique.");
  }

  return normalized;
}

function assertTemplateId(value: string): void {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(value)) {
    throw new GateStoreError(
      400,
      "Template ID must be 1-64 lowercase letters, numbers, dots, underscores, or hyphens.",
    );
  }
}

function assertRequestId(value: string): void {
  if (!/^[0-9a-f-]{36}$/.test(value)) {
    throw new GateStoreError(404, "Request not found.");
  }
}

function assertIdentityId(value: string): string {
  return assertText(value, "Identity ID", 255);
}

function assertText(value: string, label: string, maxLength: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) {
    throw new GateStoreError(
      400,
      `${label} must contain 1-${maxLength} characters.`,
    );
  }
  return normalized;
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new GateStoreError(400, `${label} must be a positive integer.`);
  }
}
