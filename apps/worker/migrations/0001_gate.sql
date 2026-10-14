PRAGMA foreign_keys = ON;

CREATE TABLE gate_templates (
  template_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  title TEXT NOT NULL,
  description TEXT,
  payload_schema_version INTEGER NOT NULL CHECK (payload_schema_version > 0),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (template_id, version)
);

CREATE TRIGGER gate_templates_no_update
BEFORE UPDATE ON gate_templates
BEGIN
  SELECT RAISE(ABORT, 'template versions are immutable');
END;

CREATE TRIGGER gate_templates_no_delete
BEFORE DELETE ON gate_templates
BEGIN
  SELECT RAISE(ABORT, 'template versions are immutable');
END;

CREATE TABLE gate_template_approvers (
  template_id TEXT NOT NULL,
  template_version INTEGER NOT NULL,
  identity_id TEXT NOT NULL,
  PRIMARY KEY (template_id, template_version, identity_id),
  FOREIGN KEY (template_id, template_version)
    REFERENCES gate_templates (template_id, version)
);

CREATE TABLE gate_template_approver_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  template_id TEXT NOT NULL,
  template_version INTEGER NOT NULL,
  approver_identity_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('added', 'removed')),
  actor_identity_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  FOREIGN KEY (template_id, template_version)
    REFERENCES gate_templates (template_id, version)
);

CREATE TABLE gate_requests (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  requester_identity_id TEXT NOT NULL,
  template_id TEXT NOT NULL,
  template_version INTEGER NOT NULL,
  payload_schema_version INTEGER NOT NULL CHECK (payload_schema_version > 0),
  payload_json TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  thread_id TEXT,
  status TEXT NOT NULL CHECK (
    status IN ('pending', 'approved', 'rejected', 'withdrawn')
  ),
  created_at TEXT NOT NULL,
  decided_at TEXT,
  decided_by TEXT,
  CHECK (
    (status = 'pending' AND decided_at IS NULL AND decided_by IS NULL)
    OR
    (status != 'pending' AND decided_at IS NOT NULL AND decided_by IS NOT NULL)
  ),
  UNIQUE (requester_identity_id, idempotency_key),
  FOREIGN KEY (template_id, template_version)
    REFERENCES gate_templates (template_id, version)
);

CREATE TRIGGER gate_requests_update_guard
BEFORE UPDATE ON gate_requests
BEGIN
  SELECT CASE
    WHEN NEW.id IS NOT OLD.id
      OR NEW.idempotency_key IS NOT OLD.idempotency_key
      OR NEW.request_fingerprint IS NOT OLD.request_fingerprint
      OR NEW.requester_identity_id IS NOT OLD.requester_identity_id
      OR NEW.template_id IS NOT OLD.template_id
      OR NEW.template_version IS NOT OLD.template_version
      OR NEW.payload_schema_version IS NOT OLD.payload_schema_version
      OR NEW.payload_json IS NOT OLD.payload_json
      OR NEW.payload_digest IS NOT OLD.payload_digest
      OR NEW.thread_id IS NOT OLD.thread_id
      OR NEW.created_at IS NOT OLD.created_at
    THEN RAISE(ABORT, 'request snapshots are immutable')
    WHEN OLD.status != 'pending'
      OR NEW.status = 'pending'
      OR NEW.decided_at IS NULL
      OR NEW.decided_by IS NULL
    THEN RAISE(ABORT, 'request terminal state is immutable')
  END;
END;

CREATE TRIGGER gate_requests_no_delete
BEFORE DELETE ON gate_requests
BEGIN
  SELECT RAISE(ABORT, 'request history is append-only');
END;

CREATE INDEX gate_requests_requester_created
  ON gate_requests (requester_identity_id, created_at DESC);

CREATE TABLE gate_request_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (
    event_type IN ('created', 'approved', 'rejected', 'withdrawn')
  ),
  actor_identity_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  FOREIGN KEY (request_id) REFERENCES gate_requests (id)
);

CREATE INDEX gate_request_events_request
  ON gate_request_events (request_id, sequence);

CREATE UNIQUE INDEX gate_request_events_once_per_type
  ON gate_request_events (request_id, event_type);

CREATE TRIGGER gate_request_events_no_update
BEFORE UPDATE ON gate_request_events
BEGIN
  SELECT RAISE(ABORT, 'gate request events are append-only');
END;

CREATE TRIGGER gate_request_events_no_delete
BEFORE DELETE ON gate_request_events
BEGIN
  SELECT RAISE(ABORT, 'gate request events are append-only');
END;

CREATE TRIGGER gate_template_approver_events_no_update
BEFORE UPDATE ON gate_template_approver_events
BEGIN
  SELECT RAISE(ABORT, 'template approver events are append-only');
END;

CREATE TRIGGER gate_template_approver_events_no_delete
BEFORE DELETE ON gate_template_approver_events
BEGIN
  SELECT RAISE(ABORT, 'template approver events are append-only');
END;
