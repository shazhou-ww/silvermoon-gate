CREATE TABLE gate_agent_identities (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active','disabled')),
  revision INTEGER NOT NULL CHECK(revision > 0),
  token_generation INTEGER NOT NULL CHECK(token_generation > 0),
  registered_by TEXT NOT NULL REFERENCES gate_identities(id)
);
CREATE TRIGGER gate_agent_id_unique BEFORE INSERT ON gate_agent_identities
WHEN EXISTS(SELECT 1 FROM gate_identities WHERE id=NEW.id)
 OR EXISTS(SELECT 1 FROM gate_requests WHERE requester_identity_id=NEW.id OR decided_by=NEW.id)
 OR EXISTS(SELECT 1 FROM gate_request_events WHERE actor_identity_id=NEW.id)
 OR EXISTS(SELECT 1 FROM gate_decisions WHERE actor_identity_id=NEW.id OR authority_identity_id=NEW.id)
 OR EXISTS(SELECT 1 FROM gate_configuration_events WHERE entity_id=NEW.id OR actor_identity_id=NEW.id)
 OR EXISTS(SELECT 1 FROM gate_templates WHERE created_by=NEW.id)
 OR EXISTS(SELECT 1 FROM gate_template_approvers WHERE identity_id=NEW.id)
 OR EXISTS(SELECT 1 FROM gate_template_approver_events WHERE approver_identity_id=NEW.id OR actor_identity_id=NEW.id)
BEGIN SELECT RAISE(ABORT,'identity ID is already attributed'); END;
CREATE TRIGGER gate_human_id_unique BEFORE INSERT ON gate_identities
WHEN EXISTS(SELECT 1 FROM gate_agent_identities WHERE id=NEW.id)
BEGIN SELECT RAISE(ABORT,'identity ID is already attributed'); END;
CREATE TRIGGER gate_agent_identity_guard BEFORE UPDATE ON gate_agent_identities
WHEN NEW.id IS NOT OLD.id OR NEW.registered_by IS NOT OLD.registered_by
 OR NEW.revision <= OLD.revision OR NEW.token_generation < OLD.token_generation
 OR (NEW.status IS NOT OLD.status AND NEW.token_generation <= OLD.token_generation)
BEGIN SELECT RAISE(ABORT,'agent changes require fixed binding and increasing revision/generation'); END;
CREATE TRIGGER gate_agent_identity_no_delete BEFORE DELETE ON gate_agent_identities
BEGIN SELECT RAISE(ABORT,'agent identities are permanent'); END;

CREATE TABLE gate_agent_credentials (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES gate_agent_identities(id),
  secret_hash TEXT NOT NULL CHECK(length(secret_hash)=64),
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK(expires_at>issued_at AND expires_at-issued_at<=2592000),
  revoked_at INTEGER
);
CREATE TABLE gate_agent_tokens (
  id TEXT PRIMARY KEY,
  credential_id TEXT NOT NULL REFERENCES gate_agent_credentials(id),
  agent_id TEXT NOT NULL REFERENCES gate_agent_identities(id),
  secret_hash TEXT NOT NULL CHECK(length(secret_hash)=64),
  issuer TEXT NOT NULL,
  audience TEXT NOT NULL,
  generation INTEGER NOT NULL,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK(expires_at>issued_at AND expires_at-issued_at<=300),
  revoked_at INTEGER
);
CREATE INDEX gate_agent_credentials_agent ON gate_agent_credentials(agent_id);
CREATE INDEX gate_agent_tokens_agent ON gate_agent_tokens(agent_id);
CREATE TRIGGER gate_agent_credential_guard BEFORE UPDATE ON gate_agent_credentials
WHEN NEW.id IS NOT OLD.id OR NEW.agent_id IS NOT OLD.agent_id OR NEW.secret_hash IS NOT OLD.secret_hash
 OR NEW.issued_at IS NOT OLD.issued_at OR NEW.expires_at IS NOT OLD.expires_at
 OR OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL
BEGIN SELECT RAISE(ABORT,'credentials are immutable except irreversible revocation'); END;
CREATE TRIGGER gate_agent_token_guard BEFORE UPDATE ON gate_agent_tokens
WHEN NEW.id IS NOT OLD.id OR NEW.credential_id IS NOT OLD.credential_id OR NEW.agent_id IS NOT OLD.agent_id
 OR NEW.secret_hash IS NOT OLD.secret_hash OR NEW.issuer IS NOT OLD.issuer OR NEW.audience IS NOT OLD.audience
 OR NEW.generation IS NOT OLD.generation OR NEW.issued_at IS NOT OLD.issued_at OR NEW.expires_at IS NOT OLD.expires_at
 OR OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL
BEGIN SELECT RAISE(ABORT,'tokens are immutable except irreversible revocation'); END;
CREATE TRIGGER gate_agent_credential_no_delete BEFORE DELETE ON gate_agent_credentials
BEGIN SELECT RAISE(ABORT,'credential bindings are permanent'); END;
CREATE TRIGGER gate_agent_token_no_delete BEFORE DELETE ON gate_agent_tokens
BEGIN SELECT RAISE(ABORT,'token bindings are permanent'); END;

CREATE TABLE gate_agent_template_access (
  agent_id TEXT NOT NULL REFERENCES gate_agent_identities(id),
  template_id TEXT NOT NULL,
  template_version INTEGER NOT NULL,
  permission TEXT NOT NULL CHECK(permission IN ('create','read','withdraw')),
  revision INTEGER NOT NULL CHECK(revision>0),
  PRIMARY KEY(agent_id,template_id,template_version,permission),
  FOREIGN KEY(template_id,template_version) REFERENCES gate_templates(template_id,version)
);
CREATE TRIGGER gate_agent_access_guard BEFORE UPDATE ON gate_agent_template_access
WHEN NEW.agent_id IS NOT OLD.agent_id OR NEW.template_id IS NOT OLD.template_id
 OR NEW.template_version IS NOT OLD.template_version OR NEW.permission IS NOT OLD.permission
 OR NEW.revision<=OLD.revision
BEGIN SELECT RAISE(ABORT,'agent permission keys are fixed and revisions increase'); END;
CREATE TRIGGER gate_agent_access_regrant BEFORE INSERT ON gate_agent_template_access
WHEN EXISTS(SELECT 1 FROM gate_configuration_events
 WHERE entity_type='agent-access' AND entity_id=NEW.agent_id
 AND json_extract(evidence_json,'$.templateId')=NEW.template_id
 AND json_extract(evidence_json,'$.version')=NEW.template_version
 AND json_extract(evidence_json,'$.permission')=NEW.permission
 AND json_extract(evidence_json,'$.revision')>=NEW.revision)
BEGIN SELECT RAISE(ABORT,'agent regrant requires a higher revision'); END;

CREATE TRIGGER gate_agent_added AFTER INSERT ON gate_agent_identities
BEGIN INSERT INTO gate_configuration_events(entity_type,entity_id,action,actor_identity_id,evidence_json)
VALUES('agent',NEW.id,'registered',NEW.registered_by,json_object('revision',NEW.revision)); END;
CREATE TRIGGER gate_agent_changed AFTER UPDATE ON gate_agent_identities
BEGIN INSERT INTO gate_configuration_events(entity_type,entity_id,action,actor_identity_id,evidence_json)
VALUES('agent',NEW.id,'updated','controlled-local-sql',json_object('revision',NEW.revision,'status',NEW.status,'generation',NEW.token_generation)); END;
CREATE TRIGGER gate_agent_credential_added AFTER INSERT ON gate_agent_credentials
BEGIN INSERT INTO gate_configuration_events(entity_type,entity_id,action,actor_identity_id,evidence_json)
VALUES('agent-credential',NEW.id,'issued','controlled-local-sql',json_object('agentId',NEW.agent_id,'expiresAt',NEW.expires_at)); END;
CREATE TRIGGER gate_agent_credential_revoked AFTER UPDATE ON gate_agent_credentials
BEGIN INSERT INTO gate_configuration_events(entity_type,entity_id,action,actor_identity_id,evidence_json)
VALUES('agent-credential',NEW.id,'revoked','controlled-local-sql',json_object('agentId',NEW.agent_id)); END;
CREATE TRIGGER gate_agent_token_revoked AFTER UPDATE ON gate_agent_tokens
BEGIN INSERT INTO gate_configuration_events(entity_type,entity_id,action,actor_identity_id,evidence_json)
VALUES('agent-token',NEW.id,'revoked','controlled-local-sql',json_object('agentId',NEW.agent_id)); END;
CREATE TRIGGER gate_agent_access_added AFTER INSERT ON gate_agent_template_access
BEGIN INSERT INTO gate_configuration_events(entity_type,entity_id,action,actor_identity_id,evidence_json)
VALUES('agent-access',NEW.agent_id,'added','controlled-local-sql',json_object('templateId',NEW.template_id,'version',NEW.template_version,'permission',NEW.permission,'revision',NEW.revision)); END;
CREATE TRIGGER gate_agent_access_changed AFTER UPDATE ON gate_agent_template_access
BEGIN INSERT INTO gate_configuration_events(entity_type,entity_id,action,actor_identity_id,evidence_json)
VALUES('agent-access',NEW.agent_id,'updated','controlled-local-sql',json_object('templateId',NEW.template_id,'version',NEW.template_version,'permission',NEW.permission,'revision',NEW.revision)); END;
CREATE TRIGGER gate_agent_access_removed AFTER DELETE ON gate_agent_template_access
BEGIN INSERT INTO gate_configuration_events(entity_type,entity_id,action,actor_identity_id,evidence_json)
VALUES('agent-access',OLD.agent_id,'removed','controlled-local-sql',json_object('templateId',OLD.template_id,'version',OLD.template_version,'permission',OLD.permission,'revision',OLD.revision)); END;
