import { agentNow, randomSecret, secretHash } from "./agent-auth.js";
import { GateStoreError } from "./gate-store.js";

export async function registerAgent(
  db: D1Database,
  operatorId: string,
  name: string,
) {
  if (!name.trim() || name.length > 100)
    throw new GateStoreError(
      400,
      "Agent name is required (max 100 characters).",
    );
  const id = `agent:${crypto.randomUUID()}`;
  const result = await db
    .prepare(
      `INSERT INTO gate_agent_identities(id,name,status,revision,token_generation,registered_by)
    SELECT ?,?,'active',1,1,id FROM gate_identities WHERE id=? AND status='active'`,
    )
    .bind(id, name, operatorId)
    .run();
  // D1 also counts writes performed by the configuration audit triggers.
  if (result.meta.changes === 0)
    throw new GateStoreError(
      403,
      "An active registered human operator is required.",
    );
  return id;
}
export async function issueAgentCredential(db: D1Database, agentId: string) {
  const credentialId = crypto.randomUUID();
  const credentialSecret = randomSecret();
  const hash = await secretHash("credential", credentialId, credentialSecret);
  const result = await db
    .prepare(
      `INSERT INTO gate_agent_credentials(id,agent_id,secret_hash,issued_at,expires_at)
    SELECT ?,id,?,${agentNow},${agentNow}+2592000 FROM gate_agent_identities WHERE id=? AND status='active'`,
    )
    .bind(credentialId, hash, agentId)
    .run();
  if (result.meta.changes === 0)
    throw new GateStoreError(403, "An active Agent is required.");
  return { credentialId, credentialSecret };
}
export async function setAgentAccess(
  db: D1Database,
  agentId: string,
  permission: string,
  enabled: boolean,
): Promise<"updated" | "unchanged"> {
  if (!["create", "read", "withdraw"].includes(permission))
    throw new GateStoreError(400, "Invalid Agent permission.");
  await inspectAgent(db, agentId);
  if (enabled) {
    const result = await db
      .prepare(
        `INSERT INTO gate_agent_template_access(agent_id,template_id,template_version,permission,revision)
     SELECT ?,'release-review',1,?,COALESCE((SELECT MAX(json_extract(evidence_json,'$.revision'))
      FROM gate_configuration_events WHERE entity_type='agent-access' AND entity_id=?
      AND json_extract(evidence_json,'$.templateId')='release-review' AND json_extract(evidence_json,'$.version')=1
      AND json_extract(evidence_json,'$.permission')=?),0)+1
     ON CONFLICT(agent_id,template_id,template_version,permission) DO NOTHING`,
      )
      .bind(agentId, permission, agentId, permission)
      .run();
    return result.meta.changes === 0 ? "unchanged" : "updated";
  } else {
    const result = await db
      .prepare(
        "DELETE FROM gate_agent_template_access WHERE agent_id=? AND template_id='release-review' AND template_version=1 AND permission=?",
      )
      .bind(agentId, permission)
      .run();
    return result.meta.changes === 0 ? "unchanged" : "updated";
  }
}
export async function inspectAgent(db: D1Database, agentId: string) {
  const row = await db
    .prepare(
      "SELECT id,name,status,revision,token_generation FROM gate_agent_identities WHERE id=?",
    )
    .bind(agentId)
    .first<{
      id: string;
      name: string;
      status: "active" | "disabled";
      revision: number;
      token_generation: number;
    }>();
  if (!row) throw new GateStoreError(404, "Agent does not exist.");
  return row;
}
export async function changeAgentStatus(
  db: D1Database,
  agentId: string,
  status: "active" | "disabled",
) {
  const result = await db
    .prepare(
      `UPDATE gate_agent_identities SET status=?,revision=revision+1,
    token_generation=token_generation+1 WHERE id=?`,
    )
    .bind(status, agentId)
    .run();
  if (result.meta.changes === 0)
    throw new GateStoreError(404, "Agent does not exist.");
}
export async function revokeAgentAuthentication(
  db: D1Database,
  kind: "token" | "credential",
  id: string,
) {
  const table =
    kind === "token" ? "gate_agent_tokens" : "gate_agent_credentials";
  const result = await db
    .prepare(
      `UPDATE ${table} SET revoked_at=${agentNow} WHERE id=? AND revoked_at IS NULL`,
    )
    .bind(id)
    .run();
  if (result.meta.changes === 0)
    throw new GateStoreError(
      404,
      "Authentication record does not exist or is already revoked.",
    );
}
