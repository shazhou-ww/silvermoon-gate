-- Existing prototype rows remain unchanged. No subject mapping or historical
-- Decision is inferred: operators must explicitly bind verified GitHub subjects.
CREATE TABLE gate_identities (
  id TEXT PRIMARY KEY,
  github_subject TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','disabled')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  session_generation INTEGER NOT NULL DEFAULT 1 CHECK (session_generation > 0)
);
CREATE TRIGGER gate_identity_binding_immutable BEFORE UPDATE ON gate_identities
WHEN NEW.id IS NOT OLD.id OR NEW.github_subject IS NOT OLD.github_subject
BEGIN SELECT RAISE(ABORT, 'identity binding is immutable'); END;
CREATE TRIGGER gate_identity_no_delete BEFORE DELETE ON gate_identities
BEGIN SELECT RAISE(ABORT, 'identity binding is permanent'); END;
CREATE TRIGGER gate_identity_revision BEFORE UPDATE ON gate_identities
WHEN NEW.revision <= OLD.revision OR NEW.session_generation < OLD.session_generation
BEGIN SELECT RAISE(ABORT, 'identity changes require a new revision'); END;

CREATE TABLE gate_sessions (
  id TEXT PRIMARY KEY,
  identity_id TEXT NOT NULL REFERENCES gate_identities(id),
  generation INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE TABLE gate_template_access (
  identity_id TEXT NOT NULL REFERENCES gate_identities(id),
  template_id TEXT NOT NULL,
  template_version INTEGER NOT NULL,
  permission TEXT NOT NULL CHECK (permission IN ('create','decide')),
  revision INTEGER NOT NULL CHECK (revision > 0),
  PRIMARY KEY (identity_id, template_id, template_version, permission),
  FOREIGN KEY (template_id, template_version) REFERENCES gate_templates(template_id,version)
);
CREATE TABLE gate_template_entry (
  template_id TEXT NOT NULL,
  template_version INTEGER NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0,1)),
  PRIMARY KEY(template_id,template_version),
  FOREIGN KEY(template_id,template_version) REFERENCES gate_templates(template_id,version)
);
CREATE TRIGGER gate_entry_no_delete BEFORE DELETE ON gate_template_entry
BEGIN SELECT RAISE(ABORT, 'disable template entries instead of deleting'); END;
INSERT INTO gate_templates
  (template_id,version,title,description,payload_schema_version,created_by,created_at)
VALUES ('release-review',1,'测试发布审核','仅用于测试环境发布；Gate 不执行发布。',1,'mvp-bootstrap',
  strftime('%Y-%m-%dT%H:%M:%fZ','now'))
ON CONFLICT(template_id,version) DO NOTHING;
-- An incompatible pre-existing version is preserved, but not enabled.
INSERT INTO gate_template_entry
SELECT template_id,version,CASE WHEN payload_schema_version=1 THEN 1 ELSE 0 END
FROM gate_templates WHERE template_id='release-review' AND version=1;

CREATE TABLE gate_configuration_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  actor_identity_id TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  occurred_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TRIGGER gate_configuration_no_update BEFORE UPDATE ON gate_configuration_events
BEGIN SELECT RAISE(ABORT, 'configuration audit is append-only'); END;
CREATE TRIGGER gate_configuration_no_delete BEFORE DELETE ON gate_configuration_events
BEGIN SELECT RAISE(ABORT, 'configuration audit is append-only'); END;
CREATE TRIGGER gate_identity_added AFTER INSERT ON gate_identities
BEGIN INSERT INTO gate_configuration_events(entity_type,entity_id,action,actor_identity_id,evidence_json)
VALUES('identity',NEW.id,'bound','controlled-sql',json_object('subject',NEW.github_subject,'revision',NEW.revision)); END;
CREATE TRIGGER gate_identity_changed AFTER UPDATE ON gate_identities
BEGIN INSERT INTO gate_configuration_events(entity_type,entity_id,action,actor_identity_id,evidence_json)
VALUES('identity',NEW.id,'updated','controlled-sql',json_object('status',NEW.status,'revision',NEW.revision,'generation',NEW.session_generation)); END;
CREATE TRIGGER gate_access_added AFTER INSERT ON gate_template_access
BEGIN INSERT INTO gate_configuration_events(entity_type,entity_id,action,actor_identity_id,evidence_json)
VALUES('access',NEW.identity_id,'added','controlled-sql',json_object('templateId',NEW.template_id,'version',NEW.template_version,'permission',NEW.permission,'revision',NEW.revision)); END;
CREATE TRIGGER gate_access_removed AFTER DELETE ON gate_template_access
BEGIN INSERT INTO gate_configuration_events(entity_type,entity_id,action,actor_identity_id,evidence_json)
VALUES('access',OLD.identity_id,'removed','controlled-sql',json_object('templateId',OLD.template_id,'version',OLD.template_version,'permission',OLD.permission,'revision',OLD.revision)); END;
CREATE TRIGGER gate_access_changed AFTER UPDATE ON gate_template_access
BEGIN INSERT INTO gate_configuration_events(entity_type,entity_id,action,actor_identity_id,evidence_json)
VALUES('access',NEW.identity_id,'updated','controlled-sql',json_object('templateId',NEW.template_id,'version',NEW.template_version,'permission',NEW.permission,'revision',NEW.revision)); END;
CREATE TRIGGER gate_access_revision BEFORE UPDATE ON gate_template_access
WHEN NEW.identity_id IS NOT OLD.identity_id OR NEW.template_id IS NOT OLD.template_id
  OR NEW.template_version IS NOT OLD.template_version OR NEW.permission IS NOT OLD.permission
  OR NEW.revision <= OLD.revision
BEGIN SELECT RAISE(ABORT, 'permission keys are fixed and changes require a new revision'); END;
CREATE TRIGGER gate_access_regrant_revision BEFORE INSERT ON gate_template_access
WHEN EXISTS(SELECT 1 FROM gate_configuration_events e WHERE e.entity_type='access' AND e.entity_id=NEW.identity_id
  AND json_extract(e.evidence_json,'$.templateId')=NEW.template_id
  AND json_extract(e.evidence_json,'$.version')=NEW.template_version
  AND json_extract(e.evidence_json,'$.permission')=NEW.permission
  AND json_extract(e.evidence_json,'$.revision')>=NEW.revision)
BEGIN SELECT RAISE(ABORT, 'regranted permission requires a new revision'); END;
CREATE TRIGGER gate_entry_changed AFTER UPDATE ON gate_template_entry
BEGIN INSERT INTO gate_configuration_events(entity_type,entity_id,action,actor_identity_id,evidence_json)
VALUES('entry',NEW.template_id,'updated','controlled-sql',json_object('version',NEW.template_version,'enabled',NEW.enabled)); END;
INSERT INTO gate_configuration_events(entity_type,entity_id,action,actor_identity_id,evidence_json)
VALUES('template','release-review','mvp-entry-initialized','mvp-bootstrap',
  json_object('version',1,'schemaVersion',1,'legacyHistoryPreserved',1));

ALTER TABLE gate_requests ADD COLUMN terminal_operation_id TEXT;
ALTER TABLE gate_request_events ADD COLUMN operation_id TEXT;
CREATE TRIGGER gate_terminal_operation_required BEFORE UPDATE ON gate_requests
WHEN NEW.terminal_operation_id IS NULL
BEGIN SELECT RAISE(ABORT, 'terminal writes require operationId'); END;
CREATE UNIQUE INDEX gate_terminal_operation ON gate_requests(terminal_operation_id)
WHERE terminal_operation_id IS NOT NULL;
CREATE UNIQUE INDEX gate_event_operation ON gate_request_events(operation_id)
WHERE operation_id IS NOT NULL;
CREATE UNIQUE INDEX gate_terminal_event ON gate_request_events(request_id)
WHERE event_type != 'created';
CREATE TABLE gate_decisions (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE REFERENCES gate_requests(id),
  operation_id TEXT NOT NULL UNIQUE,
  actor_identity_id TEXT NOT NULL REFERENCES gate_identities(id),
  authority_identity_id TEXT NOT NULL REFERENCES gate_identities(id),
  outcome TEXT NOT NULL CHECK(outcome IN ('approved','rejected')),
  identity_revision INTEGER NOT NULL,
  access_revision INTEGER NOT NULL,
  authority_evidence TEXT NOT NULL,
  decided_at TEXT NOT NULL,
  CHECK(actor_identity_id=authority_identity_id)
);
CREATE TRIGGER gate_decisions_no_update BEFORE UPDATE ON gate_decisions
BEGIN SELECT RAISE(ABORT, 'decisions are immutable'); END;
CREATE TRIGGER gate_decisions_no_delete BEFORE DELETE ON gate_decisions
BEGIN SELECT RAISE(ABORT, 'decisions are immutable'); END;
CREATE INDEX gate_request_pagination ON gate_requests(created_at DESC,id DESC);
