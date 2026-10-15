import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/index.js";
import { createAgentApi } from "../src/agent-api.js";
import {
  agentAudience,
  assertAgent,
  exchangeCredential,
  resolveAgent,
  secretHash,
} from "../src/agent-auth.js";
import {
  changeAgentStatus,
  inspectAgent,
  issueAgentCredential,
  registerAgent,
  revokeAgentAuthentication,
  setAgentAccess,
} from "../src/agent-admin.js";
import {
  createAgentRequest,
  getAgentRequest,
  withdrawAgentRequest,
} from "../src/agent-store.js";
import {
  createRequest,
  getRequest,
  transitionRequest,
} from "../src/gate-store.js";
import { bindings, input, kai, lin, seed } from "./fixtures.js";
import { SqliteD1Database } from "./sqlite-d1.js";

let db: SqliteD1Database;
let agentId: string;
let credential: Awaited<ReturnType<typeof issueAgentCredential>>;
const issuer = "urn:silvermoon-gate:local";
function env() {
  return { ...bindings(db), GATE_AGENT_ISSUER: issuer };
}
async function session() {
  const token = await exchangeCredential(env(), credential);
  const request = new Request("http://localhost/api/agent/requests", {
    headers: { authorization: `Bearer ${token.accessToken}` },
  });
  return { token, actor: await resolveAgent(request, env()) };
}
async function post(path: string, body: unknown, headers = {}) {
  return app.request(
    `http://localhost/api/agent${path}`,
    {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    },
    env(),
  );
}
beforeEach(async () => {
  db = new SqliteD1Database();
  await seed(db);
  agentId = await registerAgent(db, "lin", "Local caller");
  credential = await issueAgentCredential(db, agentId);
  for (const permission of ["create", "read", "withdraw"])
    await setAgentAccess(db, agentId, permission, true);
});
afterEach(() => {
  vi.restoreAllMocks();
  db.close();
});

describe("Independent Agent authentication and direct store", () => {
  it("issues a 5-minute opaque token, stores only domain-separated hashes and preserves human attribution", async () => {
    const { token, actor } = await session();
    expect(token).toMatchObject({
      identityId: agentId,
      issuer,
      audience: agentAudience,
      expiresIn: 300,
      tokenType: "Bearer",
    });
    expect(token.accessToken).not.toContain(credential.credentialSecret);
    const tokens = (await db.prepare("SELECT * FROM gate_agent_tokens").all())
      .results;
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toMatchObject({
      secret_hash: actor.tokenHash,
      generation: 1,
    });
    expect(Number(tokens[0]?.expires_at) - Number(tokens[0]?.issued_at)).toBe(
      300,
    );
    const logs = JSON.stringify(
      (await db.prepare("SELECT * FROM gate_configuration_events").all())
        .results,
    );
    expect(logs).not.toContain(credential.credentialSecret);
    expect(logs).not.toContain(token.accessToken);
    expect(logs).not.toContain(actor.tokenHash);
    expect(await secretHash("credential", actor.tokenId, "value")).not.toBe(
      await secretHash("token", actor.tokenId, "value"),
    );
    const created = await createAgentRequest(db, actor, "key", input);
    expect(created).toMatchObject({
      replayed: false,
      request: {
        requesterType: "agent",
        requesterIdentityId: agentId,
        allowedActions: ["withdraw"],
      },
    });
    expect((await getRequest(db, created.request.id, kai)).requesterType).toBe(
      "agent",
    );
    const approved = await transitionRequest(
      db,
      created.request.id,
      kai,
      "approve",
    );
    expect(approved.events.map((e) => e.actorIdentityId)).toEqual([
      agentId,
      "kai",
    ]);
    expect(
      (await getAgentRequest(db, actor, approved.id)).allowedActions,
    ).toEqual([]);
    expect(
      await db
        .prepare(
          "SELECT actor_identity_id,authority_identity_id FROM gate_decisions",
        )
        .first(),
    ).toEqual({ actor_identity_id: "kai", authority_identity_id: "kai" });
  });
  it("uses stable identity across token rotation and same-key concurrent/uncertain creation", async () => {
    const { actor } = await session();
    const otherSession = await session();
    const results = await Promise.all([
      createAgentRequest(db, actor, "same", input),
      createAgentRequest(db, otherSession.actor, "same", input),
    ]);
    expect(results[0].request.id).toBe(results[1].request.id);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(
      (await createAgentRequest(db, actor, "same", input)).request.events,
    ).toHaveLength(1);
    await expect(
      createAgentRequest(db, actor, "same", {
        ...input,
        threadId: "different",
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      createAgentRequest(db, actor, "\n", input),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      createAgentRequest(db, actor, "bad", { ...input, templateVersion: 2 }),
    ).rejects.toMatchObject({ status: 400 });
  });
  it("does not infer permissions, permit cross-Agent access, or grant decisions from registration", async () => {
    const { actor } = await session();
    const created = await createAgentRequest(db, actor, "key", input);
    const otherId = await registerAgent(db, "lin", "Second caller");
    const secondCredential = await issueAgentCredential(db, otherId);
    const second = await exchangeCredential(env(), secondCredential);
    const secondActor = await resolveAgent(
      new Request("http://localhost", {
        headers: { authorization: `Bearer ${second.accessToken}` },
      }),
      env(),
    );
    await setAgentAccess(db, otherId, "read", true);
    await expect(
      getAgentRequest(db, secondActor, created.request.id),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      withdrawAgentRequest(db, secondActor, created.request.id),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      createAgentRequest(db, secondActor, "no-create", input),
    ).rejects.toMatchObject({ status: 403 });
    await expect(async () =>
      db
        .prepare(
          "INSERT INTO gate_template_access VALUES(?,'release-review',1,'decide',1)",
        )
        .bind(agentId)
        .run(),
    ).rejects.toThrow();
    await expect(
      setAgentAccess(db, agentId, "decide", true),
    ).rejects.toMatchObject({ status: 400 });
    await expect(getAgentRequest(db, actor, "unknown")).rejects.toMatchObject({
      status: 404,
    });
    const human = await createRequest(db, lin, "human", input);
    await expect(
      getAgentRequest(db, actor, human.request.id),
    ).rejects.toMatchObject({ status: 404 });
  });
  it("requires explicit read and withdraw even for the creator, and audits regrant revisions", async () => {
    const { actor } = await session();
    const created = await createAgentRequest(db, actor, "key", input);
    const withdrawalAuditCount = async () =>
      db
        .prepare(
          `SELECT count(*) AS n FROM gate_configuration_events
      WHERE entity_type='agent-access' AND entity_id=? AND json_extract(evidence_json,'$.permission')='withdraw'`,
        )
        .bind(agentId)
        .first("n");
    expect(await setAgentAccess(db, agentId, "create", true)).toBe("unchanged");
    expect(await withdrawalAuditCount()).toBe(1);
    expect(await setAgentAccess(db, agentId, "withdraw", false)).toBe(
      "updated",
    );
    expect(await withdrawalAuditCount()).toBe(2);
    expect(await setAgentAccess(db, agentId, "withdraw", false)).toBe(
      "unchanged",
    );
    expect(await withdrawalAuditCount()).toBe(2);
    expect(
      await db
        .prepare(
          "SELECT count(*) AS n FROM gate_agent_template_access WHERE agent_id=? AND permission='withdraw'",
        )
        .bind(agentId)
        .first("n"),
    ).toBe(0);
    expect(
      (await getAgentRequest(db, actor, created.request.id)).allowedActions,
    ).toEqual([]);
    await expect(
      withdrawAgentRequest(db, actor, created.request.id),
    ).rejects.toMatchObject({ status: 403 });
    await setAgentAccess(db, agentId, "read", false);
    await expect(
      getAgentRequest(db, actor, created.request.id),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      createAgentRequest(db, actor, "key", input),
    ).rejects.toMatchObject({ status: 403 });
    await setAgentAccess(db, agentId, "read", true);
    expect(await setAgentAccess(db, agentId, "withdraw", true)).toBe("updated");
    expect(await withdrawalAuditCount()).toBe(3);
    expect(await setAgentAccess(db, agentId, "withdraw", true)).toBe(
      "unchanged",
    );
    expect(await withdrawalAuditCount()).toBe(3);
    expect(
      await db
        .prepare(
          "SELECT count(*) AS n FROM gate_agent_template_access WHERE agent_id=? AND permission='withdraw'",
        )
        .bind(agentId)
        .first("n"),
    ).toBe(1);
    expect(
      await db
        .prepare(
          "SELECT revision FROM gate_agent_template_access WHERE agent_id=? AND permission='read'",
        )
        .bind(agentId)
        .first("revision"),
    ).toBe(2);
    const withdrawn = await withdrawAgentRequest(db, actor, created.request.id);
    expect(withdrawn).toMatchObject({
      status: "withdrawn",
      allowedActions: [],
    });
    expect(withdrawn.events.map((e) => e.type)).toEqual([
      "created",
      "withdrawn",
    ]);
    expect(
      await db.prepare("SELECT count(*) AS n FROM gate_decisions").first("n"),
    ).toBe(0);
    await expect(
      withdrawAgentRequest(db, actor, created.request.id),
    ).rejects.toMatchObject({ status: 409 });
  });
  it("continues existing reads and withdrawals after template entry is disabled", async () => {
    const { actor } = await session();
    const created = await createAgentRequest(db, actor, "key", input);
    await db.exec("UPDATE gate_template_entry SET enabled=0");
    await expect(
      createAgentRequest(db, actor, "new", input),
    ).rejects.toMatchObject({ status: 403 });
    expect(
      (await withdrawAgentRequest(db, actor, created.request.id)).status,
    ).toBe("withdrawn");
  });
  it("compares the authenticated secret hash in every operation, not only public parsed token fields", async () => {
    const { actor } = await session();
    const forged = { ...actor, tokenHash: "0".repeat(64) };
    await expect(assertAgent(db, forged)).rejects.toMatchObject({
      status: 401,
    });
    await expect(
      createAgentRequest(db, forged, "forged", input),
    ).rejects.toMatchObject({ status: 401 });
    const created = await createAgentRequest(db, actor, "key", input);
    await expect(
      getAgentRequest(db, forged, created.request.id),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      withdrawAgentRequest(db, forged, created.request.id),
    ).rejects.toMatchObject({ status: 401 });
  });
  it("rechecks token revocation at conditional writes after principal resolution", async () => {
    const { actor } = await session();
    const batch = db.batch.bind(db);
    vi.spyOn(db, "batch").mockImplementationOnce(async (statements) => {
      await revokeAgentAuthentication(db, "token", actor.tokenId);
      return batch(statements);
    });
    await expect(
      createAgentRequest(db, actor, "race", input),
    ).rejects.toMatchObject({ status: 401 });
    expect(
      await db.prepare("SELECT count(*) AS n FROM gate_requests").first("n"),
    ).toBe(0);
  });
  it("rechecks the credential hash and revocation inside token issuance, after secret verification", async () => {
    const prepare = db.prepare.bind(db);
    vi.spyOn(db, "prepare").mockImplementation((query) => {
      const statement = prepare(query);
      if (query.startsWith("INSERT INTO gate_agent_tokens")) {
        const run = statement.run.bind(statement);
        vi.spyOn(statement, "run").mockImplementationOnce(async () => {
          await revokeAgentAuthentication(
            db,
            "credential",
            credential.credentialId,
          );
          return run();
        });
      }
      return statement;
    });
    await expect(exchangeCredential(env(), credential)).rejects.toMatchObject({
      status: 401,
    });
    expect(
      await db
        .prepare("SELECT count(*) AS n FROM gate_agent_tokens")
        .first("n"),
    ).toBe(0);
  });
  it("conflicts rather than overwriting concurrent different intents sharing a key", async () => {
    const { actor } = await session();
    const attempts = await Promise.allSettled([
      createAgentRequest(db, actor, "competing", input),
      createAgentRequest(db, actor, "competing", {
        ...input,
        threadId: "different",
      }),
    ]);
    expect(
      attempts.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const failed = attempts.find((result) => result.status === "rejected");
    expect(failed?.reason).toMatchObject({ status: 409 });
    expect(
      await db
        .prepare("SELECT count(*) AS n FROM gate_request_events")
        .first("n"),
    ).toBe(1);
  });
  it("rechecks withdrawal permission at the write and atomically rolls back evidence failures", async () => {
    const { actor } = await session();
    const created = await createAgentRequest(db, actor, "key", input);
    const batch = db.batch.bind(db);
    vi.spyOn(db, "batch").mockImplementationOnce(async (statements) => {
      await setAgentAccess(db, agentId, "withdraw", false);
      return batch(statements);
    });
    await expect(
      withdrawAgentRequest(db, actor, created.request.id),
    ).rejects.toMatchObject({ status: 403 });
    await setAgentAccess(db, agentId, "withdraw", true);
    await db.exec(
      "CREATE TRIGGER agent_fault BEFORE INSERT ON gate_request_events WHEN NEW.event_type='withdrawn' BEGIN SELECT RAISE(ABORT,'evidence fault'); END",
    );
    await expect(
      withdrawAgentRequest(db, actor, created.request.id),
    ).rejects.toThrow("evidence fault");
    expect((await getAgentRequest(db, actor, created.request.id)).status).toBe(
      "pending",
    );
    expect(
      (await getAgentRequest(db, actor, created.request.id)).events,
    ).toHaveLength(1);
  });
  it.each(["token", "credential"] as const)(
    "revokes a %s and rejects repeated revocation",
    async (kind) => {
      const { actor } = await session();
      await revokeAgentAuthentication(
        db,
        kind,
        kind === "token" ? actor.tokenId : credential.credentialId,
      );
      await expect(assertAgent(db, actor)).rejects.toMatchObject({
        status: 401,
      });
      await expect(
        revokeAgentAuthentication(
          db,
          kind,
          kind === "token" ? actor.tokenId : credential.credentialId,
        ),
      ).rejects.toMatchObject({ status: 404 });
      if (kind === "credential")
        await expect(
          exchangeCredential(env(), credential),
        ).rejects.toMatchObject({ status: 401 });
    },
  );
  it("never revives old tokens after disable/re-enable and requires an active registrar/Agent", async () => {
    const { actor } = await session();
    await changeAgentStatus(db, agentId, "disabled");
    await expect(assertAgent(db, actor)).rejects.toMatchObject({ status: 401 });
    await expect(exchangeCredential(env(), credential)).rejects.toMatchObject({
      status: 401,
    });
    await expect(issueAgentCredential(db, agentId)).rejects.toMatchObject({
      status: 403,
    });
    await changeAgentStatus(db, agentId, "active");
    await expect(assertAgent(db, actor)).rejects.toMatchObject({ status: 401 });
    await session();
    await expect(registerAgent(db, "missing", "Caller")).rejects.toMatchObject({
      status: 403,
    });
    await expect(registerAgent(db, "lin", " ")).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      changeAgentStatus(db, "missing", "disabled"),
    ).rejects.toMatchObject({ status: 404 });
    await expect(inspectAgent(db, "missing")).rejects.toMatchObject({
      status: 404,
    });
    for (const enabled of [true, false])
      await expect(
        setAgentAccess(db, "missing", "read", enabled),
      ).rejects.toMatchObject({ status: 404 });
  });
  it("rejects wrong issuer, audience, future/expired token or expired/future credential on every SQL operation", async () => {
    const { actor } = await session();
    const now = Math.floor(Date.now() / 1000);
    for (const values of [
      {
        issuer: "wrong",
        audience: agentAudience,
        issued: now,
        expires: now + 300,
      },
      { issuer, audience: "wrong", issued: now, expires: now + 300 },
      {
        issuer,
        audience: agentAudience,
        issued: now + 100,
        expires: now + 200,
      },
      {
        issuer,
        audience: agentAudience,
        issued: now - 400,
        expires: now - 100,
      },
    ]) {
      const id = crypto.randomUUID();
      await db
        .prepare(`INSERT INTO gate_agent_tokens VALUES(?,?,?,?,?,?,1,?,?,NULL)`)
        .bind(
          id,
          credential.credentialId,
          agentId,
          actor.tokenHash,
          values.issuer,
          values.audience,
          values.issued,
          values.expires,
        )
        .run();
      await expect(
        assertAgent(db, { ...actor, tokenId: id }),
      ).rejects.toMatchObject({ status: 401 });
    }
    for (const issued of [now - 400, now + 400]) {
      const id = crypto.randomUUID();
      const secret = "a".repeat(43);
      await db
        .prepare("INSERT INTO gate_agent_credentials VALUES(?,?,?,?,?,NULL)")
        .bind(
          id,
          agentId,
          await secretHash("credential", id, secret),
          issued,
          issued + 300,
        )
        .run();
      await expect(
        exchangeCredential(env(), {
          credentialId: id,
          credentialSecret: secret,
        }),
      ).rejects.toMatchObject({ status: 401 });
    }
    await expect(
      assertAgent(db, { ...actor, issuer: "wrong" }),
    ).rejects.toMatchObject({ status: 401 });
  });
  it("enforces immutable bindings and increasing access revisions without deleting history", async () => {
    const { actor } = await session();
    for (const sql of [
      "UPDATE gate_agent_credentials SET secret_hash='" + "0".repeat(64) + "'",
      "UPDATE gate_agent_tokens SET expires_at=expires_at+1",
      "DELETE FROM gate_agent_tokens",
      "DELETE FROM gate_agent_credentials",
      "DELETE FROM gate_agent_identities",
      "UPDATE gate_agent_identities SET name='changed'",
      "UPDATE gate_agent_template_access SET revision=revision",
    ])
      await expect(db.exec(sql)).rejects.toThrow();
    await db
      .prepare(
        "UPDATE gate_agent_template_access SET revision=2 WHERE agent_id=? AND permission='read'",
      )
      .bind(agentId)
      .run();
    await setAgentAccess(db, agentId, "read", false);
    await expect(async () =>
      db
        .prepare(
          "INSERT INTO gate_agent_template_access VALUES(?,'release-review',1,'read',1)",
        )
        .bind(agentId)
        .run(),
    ).rejects.toThrow("higher revision");
    await expect(async () =>
      db
        .prepare(
          "INSERT INTO gate_identities VALUES(?,'999','Conflict','active',1,1)",
        )
        .bind(agentId)
        .run(),
    ).rejects.toThrow("already attributed");
    await expect(
      db.exec(
        "INSERT INTO gate_agent_identities VALUES('lin','Conflict','active',1,1,'lin')",
      ),
    ).rejects.toThrow("already attributed");
    await revokeAgentAuthentication(db, "token", actor.tokenId);
    await expect(async () =>
      db
        .prepare("UPDATE gate_agent_tokens SET revoked_at=NULL WHERE id=?")
        .bind(actor.tokenId)
        .run(),
    ).rejects.toThrow("immutable");
  });
});

describe("Production machine HTTP boundary", () => {
  it("exposes create/read/withdraw but never decisions or browser identity fallback", async () => {
    expect(
      (
        await createAgentApi().request(
          "http://localhost/unsupported",
          {},
          env(),
        )
      ).status,
    ).toBe(404);
    const issued = await post("/token", credential);
    expect(issued.status).toBe(200);
    expect(issued.headers.get("cache-control")).toBe("no-store");
    const body = await issued.json<{ accessToken: string }>();
    const headers = {
      authorization: `Bearer ${body.accessToken}`,
      "Idempotency-Key": "http",
    };
    const create = await post("/requests", input, headers);
    expect(create.status).toBe(201);
    const result = await create.json<{ request: { id: string } }>();
    expect((await post("/requests", input, headers)).status).toBe(200);
    expect(
      (
        await app.request(
          `http://localhost/api/agent/requests/${result.request.id}`,
          { headers },
          env(),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await post(
          `/requests/${result.request.id}/decision`,
          { decision: "approve" },
          headers,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await app.request(
          "http://localhost/api/agent/requests?view=inbox",
          { headers },
          env(),
        )
      ).status,
    ).toBe(404);
    expect(
      (await post(`/requests/${result.request.id}/withdraw`, {}, headers))
        .status,
    ).toBe(200);
    expect(
      (
        await post("/requests", input, {
          ...headers,
          origin: "http://localhost",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await post("/requests", input, {
          ...headers,
          cookie: "authjs.session-token=anything",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await post("/requests", input, {
          ...headers,
          "sec-fetch-site": "cross-site",
        })
      ).status,
    ).toBe(403);
    expect(
      (await app.request("http://localhost/api/me", { headers }, env())).status,
    ).toBe(401);
    expect(
      (
        await app.request(
          "http://localhost/api/requests",
          {
            method: "POST",
            headers: { "content-type": "application/json", ...headers },
            body: JSON.stringify(input),
          },
          env(),
        )
      ).status,
    ).toBe(403);
  });
  it("fails closed on unknown credentials, bad secrets, malformed tokens, and missing issuer without logging secrets", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    for (const data of [
      {},
      { ...credential, credentialId: crypto.randomUUID() },
      { ...credential, credentialSecret: "b".repeat(43) },
      { ...credential, credentialSecret: "bad" },
    ]) {
      const response = await post("/token", data);
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({
        error: {
          code: "AGENT_AUTH_REQUIRED",
          message: "Valid Agent authentication is required.",
        },
      });
    }
    for (const authorization of [
      "",
      "Bearer fake",
      `Bearer gat_${crypto.randomUUID()}.${"a".repeat(43)}`,
    ]) {
      expect(
        (
          await app.request(
            "http://localhost/api/agent/requests/missing",
            { headers: { authorization } },
            env(),
          )
        ).status,
      ).toBe(401);
    }
    const { token } = await session();
    const [prefix] = token.accessToken.split(".");
    expect(
      (
        await app.request(
          "http://localhost/api/agent/requests/missing",
          {
            headers: {
              authorization: `Bearer ${prefix}.${"a".repeat(43)}`,
            },
          },
          env(),
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await app.request(
          "http://localhost/api/agent/requests/missing",
          {
            headers: {
              authorization: `Bearer ${token.accessToken.slice(0, -1)}!`,
            },
          },
          env(),
        )
      ).status,
    ).toBe(401);
    const wrong = bindings(db);
    await expect(exchangeCredential(wrong, credential)).rejects.toMatchObject({
      status: 401,
    });
    await expect(
      resolveAgent(
        new Request("http://localhost", {
          headers: { authorization: `Bearer ${token.accessToken}` },
        }),
        wrong,
      ),
    ).rejects.toMatchObject({ status: 401 });
    expect(
      (await post("/token", credential, { authorization: "Bearer fake" }))
        .status,
    ).toBe(401);
    expect(JSON.stringify(log.mock.calls)).not.toContain(
      credential.credentialSecret,
    );
  });
  it("rejects missing idempotency key, unsupported fields and request bodies without credential echoes", async () => {
    const { token } = await session();
    const headers = { authorization: `Bearer ${token.accessToken}` };
    for (const invalid of [
      null,
      [],
      42,
      { ...input, templateId: 42 },
      { ...input, templateVersion: "1" },
      { ...input, payloadSchemaVersion: true },
      { ...input, payload: null },
      { ...input, payload: [] },
      { ...input, payload: { ...input.payload, summary: 42 } },
      { ...input, payload: { ...input.payload, extra: true } },
      { ...input, threadId: 42 },
    ]) {
      const response = await post("/requests", invalid, {
        ...headers,
        "Idempotency-Key": "invalid-types",
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: { code: "INVALID_INPUT" },
      });
    }
    expect(
      await db.prepare("SELECT count(*) AS n FROM gate_requests").first("n"),
    ).toBe(0);
    expect((await post("/requests", input, headers)).status).toBe(400);
    expect(
      (
        await post(
          "/requests",
          { ...input, requesterIdentityId: "lin" },
          { ...headers, "Idempotency-Key": "x" },
        )
      ).status,
    ).toBe(400);
    expect((await post("/token", { ...credential, extra: "bad" })).status).toBe(
      400,
    );
    const created = await post("/requests", input, {
      ...headers,
      "Idempotency-Key": "x",
    });
    const body = await created.json<{ request: { id: string } }>();
    expect(
      (
        await post(
          `/requests/${body.request.id}/withdraw`,
          { decision: "approve" },
          headers,
        )
      ).status,
    ).toBe(400);
    await db
      .prepare(
        "CREATE TRIGGER http_fault BEFORE INSERT ON gate_requests BEGIN SELECT RAISE(ABORT,'secret-private-value'); END",
      )
      .run();
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failed = await post("/requests", input, {
      ...headers,
      "Idempotency-Key": "fault",
    });
    expect(failed.status).toBe(500);
    expect(JSON.stringify(await failed.json())).not.toContain(
      "secret-private-value",
    );
    expect(JSON.stringify(log.mock.calls)).not.toContain(
      "secret-private-value",
    );
  });
});
