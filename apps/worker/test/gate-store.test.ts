import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createRequest,
  createTemplate,
  getRequest,
  getTemplates,
  replaceTemplateApprovers,
  transitionRequest,
} from "../src/gate-store.js";
import { SqliteD1Database } from "./sqlite-d1.js";

describe("Gate request persistence", () => {
  let db: SqliteD1Database;

  beforeEach(() => {
    db = new SqliteD1Database();
  });

  afterEach(() => {
    db.close();
  });

  it("creates versioned templates and lists only each current version", async () => {
    const first = await createTemplate(
      db,
      "admin-1",
      {
        id: "purchase",
        title: "Purchase approval",
        payloadSchemaVersion: 1,
        approverIdentityIds: ["approver-1"],
      },
      "2026-01-01T00:00:00.000Z",
    );
    const second = await createTemplate(
      db,
      "admin-1",
      {
        id: "purchase",
        title: "Purchase approval v2",
        payloadSchemaVersion: 2,
        approverIdentityIds: ["approver-2"],
      },
      "2026-01-02T00:00:00.000Z",
    );

    expect(first).toMatchObject({ id: "purchase", version: 1 });
    expect(second).toMatchObject({
      id: "purchase",
      version: 2,
      payloadSchemaVersion: 2,
    });
    await expect(getTemplates(db)).resolves.toEqual([second]);
  });

  it("rejects invalid template fields and duplicate approvers", async () => {
    await expect(
      createTemplate(db, "admin", {
        id: "Bad Id",
        title: "Purchase",
        payloadSchemaVersion: 1,
        approverIdentityIds: ["approver"],
      }),
    ).rejects.toThrow("Template ID must be 1-64 lowercase letters");
    await expect(
      createTemplate(db, "admin", {
        id: "purchase",
        title: " ",
        payloadSchemaVersion: 1,
        approverIdentityIds: ["approver"],
      }),
    ).rejects.toThrow("Template title must contain 1-120 characters.");
    await expect(
      createTemplate(db, "admin", {
        id: "purchase",
        title: "Purchase",
        payloadSchemaVersion: 0,
        approverIdentityIds: ["approver"],
      }),
    ).rejects.toThrow("Payload schema version must be a positive integer.");
    await expect(
      createTemplate(db, "purchase", {
        id: "purchase",
        title: "Purchase",
        payloadSchemaVersion: 1,
        approverIdentityIds: ["approver", "approver"],
      }),
    ).rejects.toThrow("Approver identity IDs must be unique.");
  });

  it("persists immutable payload snapshots and replays identical idempotent creates", async () => {
    await createTemplate(db, "admin", {
      id: "purchase",
      title: "Purchase",
      payloadSchemaVersion: 1,
      approverIdentityIds: ["approver-1"],
    });
    const input = {
      templateId: "purchase",
      templateVersion: 1,
      payloadSchemaVersion: 1,
      payload: { amount: 42, currency: "USD" },
      threadId: "thread-7",
    } as const;
    const first = await createRequest(db, "requester-1", "key-1", input);
    const replay = await createRequest(db, "requester-1", "key-1", {
      ...input,
      payload: { currency: "USD", amount: 42 },
    });

    expect(first.created).toBe(true);
    expect(first.request.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(first.request.payload).toEqual({ amount: 42, currency: "USD" });
    expect(first.request.payloadDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(first.request).toMatchObject({
      requesterIdentityId: "requester-1",
      status: "pending",
      templateVersion: 1,
      threadId: "thread-7",
      events: [{ type: "created", actorIdentityId: "requester-1" }],
    });
    expect(replay.created).toBe(false);
    expect(replay.request.id).toBe(first.request.id);
    expect(replay.request.events).toHaveLength(1);
  });

  it("rejects reused idempotency keys with changed request content", async () => {
    await createTemplate(db, "admin", {
      id: "purchase",
      title: "Purchase",
      payloadSchemaVersion: 1,
      approverIdentityIds: ["approver-1"],
    });
    const input = {
      templateId: "purchase",
      templateVersion: 1,
      payloadSchemaVersion: 1,
      payload: { amount: 42 },
    } as const;
    await createRequest(db, "requester-1", "key-1", input);

    await expect(
      createRequest(db, "requester-1", "key-1", {
        ...input,
        payload: { amount: 43 },
      }),
    ).rejects.toMatchObject({
      status: 409,
      message:
        "Idempotency key was already used for different request content.",
    });
  });

  it("requires the requested immutable template version and matching payload schema", async () => {
    await expect(
      createRequest(db, "requester-1", "key-1", {
        templateId: "missing",
        templateVersion: 1,
        payloadSchemaVersion: 1,
        payload: {},
      }),
    ).rejects.toMatchObject({ status: 404 });

    await createTemplate(db, "admin", {
      id: "purchase",
      title: "Purchase",
      payloadSchemaVersion: 2,
      approverIdentityIds: ["approver-1"],
    });

    await expect(
      createRequest(db, "requester-1", "key-1", {
        templateId: "purchase",
        templateVersion: 99,
        payloadSchemaVersion: 1,
        payload: {},
      }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      createRequest(db, "requester-1", "key-1", {
        templateId: "purchase",
        templateVersion: 1,
        payloadSchemaVersion: 1,
        payload: {},
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      createRequest(db, "requester-1", "key-1", {
        templateId: "purchase",
        templateVersion: 1,
        payloadSchemaVersion: 2,
        payload: {},
      }),
    ).resolves.toMatchObject({ request: { payloadSchemaVersion: 2 } });
  });

  it("returns not found for a transition on a missing request", async () => {
    await expect(
      transitionRequest(
        db,
        "00000000-0000-0000-0000-000000000000",
        "approver-1",
        "approve",
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("exposes requests only to the requester and current pinned approvers", async () => {
    await createTemplate(db, "admin", {
      id: "purchase",
      title: "Purchase",
      payloadSchemaVersion: 1,
      approverIdentityIds: ["approver-1"],
    });
    const { request } = await createRequest(db, "requester-1", "key-1", {
      templateId: "purchase",
      templateVersion: 1,
      payloadSchemaVersion: 1,
      payload: { amount: 42 },
    });

    await expect(getRequest(db, request.id, "outsider")).resolves.toBeNull();
    await expect(
      getRequest(db, request.id, "requester-1"),
    ).resolves.toMatchObject({
      id: request.id,
    });
    await expect(
      getRequest(db, request.id, "approver-1"),
    ).resolves.toMatchObject({
      id: request.id,
    });
    await expect(
      getRequest(db, "not-a-request-id", "requester-1"),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("dynamically updates approvers without changing the pinned request template", async () => {
    await createTemplate(db, "admin", {
      id: "purchase",
      title: "Purchase",
      payloadSchemaVersion: 1,
      approverIdentityIds: ["approver-old"],
    });
    const { request } = await createRequest(db, "requester-1", "key-1", {
      templateId: "purchase",
      templateVersion: 1,
      payloadSchemaVersion: 1,
      payload: {},
    });
    await replaceTemplateApprovers(db, "purchase", 1, "admin", [
      "approver-new",
    ]);

    await expect(
      getRequest(db, request.id, "approver-old"),
    ).resolves.toBeNull();
    await expect(
      getRequest(db, request.id, "approver-new"),
    ).resolves.toMatchObject({
      id: request.id,
    });
    await expect(
      replaceTemplateApprovers(db, "purchase", 99, "admin", ["approver-new"]),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      replaceTemplateApprovers(db, "purchase", 1, "admin", []),
    ).rejects.toMatchObject({ status: 400 });

    const audit = await db
      .prepare(
        `SELECT action, approver_identity_id, actor_identity_id
         FROM gate_template_approver_events
         WHERE template_id = 'purchase' AND template_version = 1
         ORDER BY sequence`,
      )
      .all<{
        readonly action: string;
        readonly approver_identity_id: string;
        readonly actor_identity_id: string;
      }>();
    expect(audit.results).toEqual([
      {
        action: "added",
        approver_identity_id: "approver-old",
        actor_identity_id: "admin",
      },
      {
        action: "removed",
        approver_identity_id: "approver-old",
        actor_identity_id: "admin",
      },
      {
        action: "added",
        approver_identity_id: "approver-new",
        actor_identity_id: "admin",
      },
    ]);
  });

  it("allows only the requester to withdraw a pending request once", async () => {
    await createTemplate(db, "admin", {
      id: "purchase",
      title: "Purchase",
      payloadSchemaVersion: 1,
      approverIdentityIds: ["approver-1"],
    });
    const { request } = await createRequest(db, "requester-1", "key-1", {
      templateId: "purchase",
      templateVersion: 1,
      payloadSchemaVersion: 1,
      payload: {},
    });
    await expect(
      transitionRequest(db, request.id, "approver-1", "withdraw"),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      transitionRequest(db, request.id, "requester-1", "withdraw"),
    ).resolves.toMatchObject({
      status: "withdrawn",
      events: [{ type: "created" }, { type: "withdrawn" }],
    });
    await expect(
      transitionRequest(db, request.id, "requester-1", "withdraw"),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("allows only eligible pinned approvers to win a single decision", async () => {
    await createTemplate(db, "admin", {
      id: "purchase",
      title: "Purchase",
      payloadSchemaVersion: 1,
      approverIdentityIds: ["approver-1", "approver-2"],
    });
    const { request } = await createRequest(db, "requester-1", "key-1", {
      templateId: "purchase",
      templateVersion: 1,
      payloadSchemaVersion: 1,
      payload: {},
    });
    await expect(
      transitionRequest(db, request.id, "outsider", "approve"),
    ).rejects.toMatchObject({ status: 403 });
    const decision = await transitionRequest(
      db,
      request.id,
      "approver-1",
      "approve",
      "2026-01-01T00:00:00.000Z",
    );

    expect(decision).toMatchObject({
      status: "approved",
      decidedBy: "approver-1",
      decidedAt: "2026-01-01T00:00:00.000Z",
      events: [
        { type: "created", actorIdentityId: "requester-1" },
        { type: "approved", actorIdentityId: "approver-1" },
      ],
    });
    await expect(
      transitionRequest(db, request.id, "approver-2", "reject"),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("returns a decision completed just before the approver is removed", async () => {
    await createTemplate(db, "admin", {
      id: "purchase",
      title: "Purchase",
      payloadSchemaVersion: 1,
      approverIdentityIds: ["approver-1"],
    });
    const { request } = await createRequest(db, "requester-1", "key-1", {
      templateId: "purchase",
      templateVersion: 1,
      payloadSchemaVersion: 1,
      payload: {},
    });

    const batch = db.batch.bind(db);
    let removeApprover = true;
    db.batch = async <T>(
      statements: D1PreparedStatement[],
    ): Promise<D1Result<T>[]> => {
      const results = await batch<T>(statements);
      if (removeApprover) {
        removeApprover = false;
        await replaceTemplateApprovers(db, "purchase", 1, "admin", [
          "approver-2",
        ]);
      }
      return results;
    };

    await expect(
      transitionRequest(db, request.id, "approver-1", "approve"),
    ).resolves.toMatchObject({
      status: "approved",
      decidedBy: "approver-1",
      events: [{ type: "created" }, { type: "approved" }],
    });
    await expect(getRequest(db, request.id, "approver-1")).resolves.toBeNull();
  });

  it("serializes concurrent decisions so only one can win", async () => {
    await createTemplate(db, "admin", {
      id: "purchase",
      title: "Purchase",
      payloadSchemaVersion: 1,
      approverIdentityIds: ["approver-1", "approver-2"],
    });
    const { request } = await createRequest(db, "requester-1", "key-1", {
      templateId: "purchase",
      templateVersion: 1,
      payloadSchemaVersion: 1,
      payload: {},
    });

    const results = await Promise.allSettled([
      transitionRequest(db, request.id, "approver-1", "approve"),
      transitionRequest(db, request.id, "approver-2", "reject"),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);

    const approved = await getRequest(db, request.id, "requester-1");
    expect(approved?.status).toMatch(/^(approved|rejected)$/);
    expect(approved?.events).toHaveLength(2);
  });

  it("prevents updates and deletes from rewriting audit events", async () => {
    await createTemplate(db, "admin", {
      id: "purchase",
      title: "Purchase",
      payloadSchemaVersion: 1,
      approverIdentityIds: ["approver-1"],
    });
    const { request } = await createRequest(db, "requester-1", "key-1", {
      templateId: "purchase",
      templateVersion: 1,
      payloadSchemaVersion: 1,
      payload: {},
    });

    await expect(
      db.exec(
        `UPDATE gate_request_events SET actor_identity_id = 'changed'
         WHERE request_id = '${request.id}'`,
      ),
    ).rejects.toThrow("gate request events are append-only");
    await expect(
      db.exec(
        `DELETE FROM gate_request_events WHERE request_id = '${request.id}'`,
      ),
    ).rejects.toThrow("gate request events are append-only");
    await expect(
      db.exec(
        `UPDATE gate_requests SET payload_json = '{"changed":true}'
         WHERE id = '${request.id}'`,
      ),
    ).rejects.toThrow("request snapshots are immutable");
    await expect(
      db.exec(
        "UPDATE gate_templates SET title = 'Changed' WHERE template_id = 'purchase'",
      ),
    ).rejects.toThrow("template versions are immutable");
    await expect(
      db.exec(
        `UPDATE gate_requests SET status = 'approved'
         WHERE id = '${request.id}'`,
      ),
    ).rejects.toThrow();
    await expect(
      db.exec(`DELETE FROM gate_requests WHERE id = '${request.id}'`),
    ).rejects.toThrow("request history is append-only");
  });
});
