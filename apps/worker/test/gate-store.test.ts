import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { calculatePayloadDigest } from "@workspace/contracts";
import {
  createRequest,
  getRequest,
  getIdentity,
  getTemplates,
  listRequests,
  transitionRequest,
  validateCreate,
} from "../src/gate-store.js";
import { SqliteD1Database } from "./sqlite-d1.js";
import { seed, lin, kai, other, input } from "./fixtures.js";
let db: SqliteD1Database;
beforeEach(async () => {
  db = new SqliteD1Database();
  await seed(db);
});
afterEach(() => {
  db.close();
});
describe("Human MVP store", () => {
  it("pins fixed content, computes JCS digest and returns current permissions", async () => {
    const result = await createRequest(db, lin, "key", input);
    expect(result.created).toBe(true);
    expect(result.request).toMatchObject({
      status: "pending",
      requesterIdentityId: "lin",
      allowedActions: ["withdraw"],
      events: [{ type: "created", actorIdentityId: "lin" }],
    });
    expect(result.request.payloadDigest).toBe(
      await calculatePayloadDigest(1, input.payload),
    );
    expect(await getRequest(db, result.request.id, kai)).toMatchObject({
      allowedActions: ["approve", "reject"],
    });
    expect(await getIdentity(db, kai)).toEqual({
      identity: { id: "kai", name: "Kai" },
      permissions: { canCreate: false, canDecide: true },
    });
    expect(await getTemplates(db, lin)).toHaveLength(1);
  });
  it("replays only matching content; revoked create still permits authorized historical replay", async () => {
    const first = await createRequest(db, lin, "key", input);
    await db.exec(
      "DELETE FROM gate_template_access WHERE identity_id='lin' AND permission='create'",
    );
    expect((await createRequest(db, lin, "key", input)).request.id).toBe(
      first.request.id,
    );
    await expect(
      createRequest(db, lin, "key", { ...input, threadId: "different" }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await expect(createRequest(db, lin, "new", input)).rejects.toMatchObject({
      status: 403,
    });
    expect((await getRequest(db, first.request.id, lin)).events).toHaveLength(
      1,
    );
  });
  it("serializes same-key attempts and leaves exactly one created event", async () => {
    const results = await Promise.all([
      createRequest(db, lin, "same", input),
      createRequest(db, lin, "same", input),
    ]);
    expect(results[0].request.id).toBe(results[1].request.id);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(results[1].request.events).toHaveLength(1);
  });
  it.each(["approve", "reject"] as const)(
    "writes %s with direct immutable authority and exactly two events",
    async (action) => {
      const { request } = await createRequest(db, lin, "key", input);
      const terminal = await transitionRequest(db, request.id, kai, action);
      expect(terminal.events).toHaveLength(2);
      expect(terminal.allowedActions).toEqual([]);
      const evidence = await db.prepare("SELECT * FROM gate_decisions").first();
      expect(evidence).toMatchObject({
        actor_identity_id: "kai",
        authority_identity_id: "kai",
        identity_revision: 1,
        access_revision: 1,
        decided_at: terminal.decidedAt,
      });
      await expect(
        transitionRequest(db, request.id, kai, action),
      ).rejects.toMatchObject({ status: 409 });
      await expect(
        db.exec("UPDATE gate_decisions SET access_revision=2"),
      ).rejects.toThrow("immutable");
      await expect(db.exec("DELETE FROM gate_decisions")).rejects.toThrow(
        "immutable",
      );
    },
  );
  it("withdraws without Decision and gates a losing operation by operationId", async () => {
    const { request } = await createRequest(db, lin, "key", input);
    await transitionRequest(db, request.id, lin, "withdraw");
    await expect(
      transitionRequest(db, request.id, kai, "approve"),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      await db.prepare("SELECT COUNT(*) AS n FROM gate_decisions").first("n"),
    ).toBe(0);
    expect(
      (await getRequest(db, request.id, lin)).events.map((e) => e.type),
    ).toEqual(["created", "withdrawn"]);
  });
  it("prohibits self-approval even with both permissions, and does not leak to other identities", async () => {
    await db.exec(
      "INSERT INTO gate_template_access VALUES ('lin','release-review',1,'decide',1)",
    );
    const { request } = await createRequest(db, lin, "key", input);
    await expect(
      transitionRequest(db, request.id, lin, "approve"),
    ).rejects.toMatchObject({ status: 403 });
    await expect(getRequest(db, request.id, other)).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      transitionRequest(db, request.id, other, "approve"),
    ).rejects.toMatchObject({ status: 404 });
    await expect(getRequest(db, "missing", lin)).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      transitionRequest(db, request.id, kai, "withdraw"),
    ).rejects.toMatchObject({ status: 403 });
  });
  it.each([
    "UPDATE gate_identities SET status='disabled',revision=2 WHERE id='kai'",
    "UPDATE gate_sessions SET revoked_at='2000-01-01T00:00:00.000Z' WHERE id='session-kai'",
    "UPDATE gate_sessions SET expires_at='2000-01-01T00:00:00.000Z' WHERE id='session-kai'",
    "UPDATE gate_identities SET session_generation=2,revision=2 WHERE id='kai'",
    "DELETE FROM gate_template_access WHERE identity_id='kai'",
  ])(
    "rechecks authorization in write SQL after pre-read (%s)",
    async (revoke) => {
      const { request } = await createRequest(db, lin, "key", input);
      const batch = db.batch.bind(db);
      db.batch = async (statements) => {
        await db.exec(revoke);
        return batch(statements);
      };
      await expect(
        transitionRequest(db, request.id, kai, "approve"),
      ).rejects.toMatchObject({ status: 404 });
      expect((await getRequest(db, request.id, lin)).status).toBe("pending");
      expect((await getRequest(db, request.id, lin)).events).toHaveLength(1);
    },
  );
  it.each(["gate_decisions", "gate_request_events"])(
    "rolls back update and evidence when %s insertion fails",
    async (table) => {
      const { request } = await createRequest(db, lin, "key", input);
      await db.exec(
        `CREATE TRIGGER inject_fault BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'injected fault'); END`,
      );
      await expect(
        transitionRequest(db, request.id, kai, "approve"),
      ).rejects.toThrow("injected fault");
      expect(await getRequest(db, request.id, lin)).toMatchObject({
        status: "pending",
        events: [{ type: "created" }],
      });
      expect(
        await db.prepare("SELECT COUNT(*) AS n FROM gate_decisions").first("n"),
      ).toBe(0);
    },
  );
  it("rolls back a created request if its audit insert fails", async () => {
    await db.exec(
      "CREATE TRIGGER inject_fault BEFORE INSERT ON gate_request_events BEGIN SELECT RAISE(ABORT,'injected fault'); END",
    );
    await expect(createRequest(db, lin, "key", input)).rejects.toThrow(
      "injected fault",
    );
    expect(
      await db.prepare("SELECT COUNT(*) AS n FROM gate_requests").first("n"),
    ).toBe(0);
  });
  it("preserves a winner when two authorized decisions race", async () => {
    const { request } = await createRequest(db, lin, "key", input);
    const results = await Promise.allSettled([
      transitionRequest(db, request.id, kai, "approve"),
      transitionRequest(db, request.id, kai, "reject"),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(
      await db.prepare("SELECT COUNT(*) AS n FROM gate_decisions").first("n"),
    ).toBe(1);
    expect((await getRequest(db, request.id, lin)).events).toHaveLength(2);
  });
  it("filters authorized stable cursor tuples and excludes the requester's inbox", async () => {
    await db.exec(
      "INSERT INTO gate_template_access VALUES ('lin','release-review',1,'decide',1)",
    );
    const a = await createRequest(db, lin, "a", input);
    await createRequest(db, lin, "b", input);
    const first = await listRequests(db, lin, {
      view: "mine",
      status: null,
      limit: 1,
    });
    expect(first.items).toHaveLength(1);
    const second = await listRequests(db, lin, {
      view: "mine",
      status: null,
      limit: 1,
      after: first.after!,
    });
    expect(second.items[0]?.id).not.toBe(first.items[0]?.id);
    expect(second.after).toBeNull();
    expect(
      (await listRequests(db, lin, { view: "inbox", status: null, limit: 20 }))
        .items,
    ).toEqual([]);
    expect(
      (
        await listRequests(db, other, {
          view: "inbox",
          status: "pending",
          limit: 20,
        })
      ).items,
    ).toEqual([]);
    await transitionRequest(db, a.request.id, kai, "reject");
    expect(
      (
        await listRequests(db, kai, {
          view: "inbox",
          status: "pending",
          limit: 20,
        })
      ).items,
    ).toHaveLength(1);
    expect(
      (
        await listRequests(db, lin, {
          view: "mine",
          status: "rejected",
          limit: 20,
        })
      ).items,
    ).toHaveLength(1);
  });
  it("disables new creates without automatically closing existing pending requests", async () => {
    const { request } = await createRequest(db, lin, "key", input);
    await db.exec("UPDATE gate_template_entry SET enabled=0");
    expect(await getTemplates(db, lin)).toEqual([]);
    await expect(createRequest(db, lin, "new", input)).rejects.toMatchObject({
      status: 403,
    });
    expect(
      (await transitionRequest(db, request.id, kai, "approve")).status,
    ).toBe("approved");
  });
  it("revoked identities cannot replay history or cross-wire session subjects", async () => {
    await createRequest(db, lin, "key", input);
    await expect(
      getIdentity(db, { identityId: "lin", sessionId: "session-kai" }),
    ).rejects.toMatchObject({ status: 401 });
    await db.exec(
      "UPDATE gate_identities SET status='disabled',revision=2 WHERE id='lin'",
    );
    await expect(createRequest(db, lin, "key", input)).rejects.toMatchObject({
      status: 401,
    });
  });
  it("enforces immutable snapshots and audit", async () => {
    await createRequest(db, lin, "key", input);
    for (const sql of [
      "UPDATE gate_requests SET payload_json='{}'",
      "DELETE FROM gate_requests",
      "UPDATE gate_request_events SET actor_identity_id='other'",
      "DELETE FROM gate_request_events",
      "DELETE FROM gate_configuration_events",
      "UPDATE gate_configuration_events SET action='fake'",
      "UPDATE gate_identities SET github_subject='replacement' WHERE id='lin'",
      "DELETE FROM gate_identities WHERE id='other'",
    ])
      await expect(db.exec(sql)).rejects.toThrow();
    expect(
      await db
        .prepare("SELECT COUNT(*) AS n FROM gate_configuration_events")
        .first("n"),
    ).toBeGreaterThan(3);
  });
  it.each([
    { ...input, templateId: "other" },
    { ...input, templateVersion: 2 },
    { ...input, payloadSchemaVersion: 2 },
    { ...input, threadId: " " },
    { ...input, threadId: "x".repeat(101) },
    { ...input, payload: { ...input.payload, environment: "production" } },
    { ...input, payload: { ...input.payload, summary: " " } },
    { ...input, payload: { ...input.payload, candidate: "" } },
    { ...input, payload: { ...input.payload, artifactDigest: "sha256:ABC" } },
    { ...input, payload: { ...input.payload, extra: true } },
    { ...input, payload: { ...input.payload, summary: "\ud800" } },
    { ...input, payload: [] },
  ])("rejects non-fixed, extra, empty, invalid Unicode content", (bad) => {
    expect(() => {
      validateCreate(bad);
    }).toThrow();
  });
  it("rejects empty and oversized idempotency keys", async () => {
    for (const key of ["", "x".repeat(201), "has space"])
      await expect(createRequest(db, lin, key, input)).rejects.toMatchObject({
        status: 400,
      });
  });
});
