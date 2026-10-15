import { readFile } from "node:fs/promises";
import { calculatePayloadDigest } from "../packages/contracts/dist/index.js";

async function main() {
  const required = (name) => {
    const value = process.env[name];
    if (!value) throw new Error("Missing configuration");
    return value;
  };
  const origin = new URL(required("GATE_ORIGIN"));
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(
    origin.hostname,
  );
  if (
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash ||
    !(origin.protocol === "https:" || (origin.protocol === "http:" && loopback))
  )
    throw new Error("Unsafe endpoint");
  const issuer = required("GATE_ISSUER");
  const key = required("GATE_IDEMPOTENCY_KEY");
  const expected = required("GATE_EXPECTED_DIGEST");
  const input = JSON.parse(await readFile(required("GATE_INPUT_FILE"), "utf8"));
  if (
    input.templateId !== "release-review" ||
    input.templateVersion !== 1 ||
    input.payloadSchemaVersion !== 1 ||
    expected !== (await calculatePayloadDigest(1, input.payload))
  )
    throw new Error("Unexpected local intent");
  const credential = JSON.parse(
    await readFile(required("GATE_CREDENTIAL_FILE"), "utf8"),
  );
  async function json(path, init = {}) {
    const response = await fetch(new URL(path, origin), {
      ...init,
      redirect: "error",
      cache: "no-store",
      credentials: "omit",
      signal: AbortSignal.timeout(10000),
      headers: { accept: "application/json", ...init.headers },
    });
    if (!response.ok) throw new Error("Unconfirmed response");
    return response.json();
  }
  const session = await json("/api/agent/token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      credentialId: credential.credentialId,
      credentialSecret: credential.credentialSecret,
    }),
  });
  if (
    session.issuer !== issuer ||
    session.audience !== "urn:silvermoon-gate:agent-api" ||
    session.tokenType !== "Bearer" ||
    session.expiresIn !== 300 ||
    typeof session.accessToken !== "string" ||
    !session.accessToken ||
    typeof session.identityId !== "string" ||
    !session.identityId
  )
    throw new Error("Invalid authentication response");
  const headers = { authorization: `Bearer ${session.accessToken}` };
  const created = await json("/api/agent/requests", {
    method: "POST",
    headers: {
      ...headers,
      "content-type": "application/json",
      "Idempotency-Key": key,
    },
    body: JSON.stringify(input),
  });
  const id = created.request?.id;
  if (typeof id !== "string" || !id) throw new Error("Unconfirmed creation");
  const { request } = await json(
    `/api/agent/requests/${encodeURIComponent(id)}`,
    { headers },
  );
  if (
    !request ||
    request.id !== id ||
    request.requesterIdentityId !== session.identityId ||
    request.requesterType !== "agent" ||
    request.templateId !== input.templateId ||
    request.templateVersion !== input.templateVersion ||
    request.payloadSchemaVersion !== input.payloadSchemaVersion ||
    request.payloadDigest !== expected ||
    (await calculatePayloadDigest(
      request.payloadSchemaVersion,
      request.payload,
    )) !== expected
  )
    throw new Error("Request binding mismatch");
  if (request.status !== "approved") {
    process.exitCode = 75;
    console.error("BLOCKED: no online approved result; no automatic retry.");
    return;
  }
  if (
    typeof request.decidedBy !== "string" ||
    !request.decidedBy ||
    request.decidedBy === session.identityId ||
    typeof request.decidedAt !== "string" ||
    !Number.isFinite(Date.parse(request.decidedAt)) ||
    !Array.isArray(request.events) ||
    !request.events.some(
      (event) =>
        event.type === "approved" &&
        event.actorIdentityId === request.decidedBy,
    )
  )
    throw new Error("Incomplete online decision evidence");
  console.log("APPROVED: online result and expected digest match.");
}
main().catch(() => {
  console.error(
    "BLOCKED: result unconfirmed; preserve the same key and input.",
  );
  process.exitCode = 1;
});
