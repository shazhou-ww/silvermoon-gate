import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Bindings } from "../src/env.js";
import { createGateApi } from "../src/gate-api.js";
import { SqliteD1Database } from "./sqlite-d1.js";
import { HTTPException } from "hono/http-exception";

let database: SqliteD1Database;
let bindings: Bindings;
let api: ReturnType<typeof createGateApi>;

beforeEach(() => {
  database = new SqliteD1Database();
  bindings = {
    APP_NAME: "Silvermoon Gate",
    ASSETS: {
      fetch: () => Promise.resolve(new Response()),
      connect: () => {
        throw new Error("Asset fixture does not open sockets.");
      },
    },
    AUTH_SECRET: "test-secret-that-is-long-enough-for-auth",
    GATE_ADMIN_IDENTITY_IDS: "admin-1",
    GATE_DB: database,
  } satisfies Bindings;
  api = createGateApi(
    (context) => context.req.header("x-test-identity") ?? "anonymous",
  );
});

afterEach(() => {
  database.close();
});

function post(
  path: string,
  body: string,
  options: {
    readonly identity?: string;
    readonly idempotencyKey?: string;
    readonly origin?: string;
    readonly contentType?: string;
  } = {},
): Request {
  const url = new URL(path, "https://gate.example.test");
  const headers = new Headers();
  if (options.contentType !== undefined) {
    headers.set("content-type", options.contentType);
  } else {
    headers.set("content-type", "application/json");
  }
  if (options.origin !== undefined) {
    headers.set("origin", options.origin);
  } else {
    headers.set("origin", url.origin);
  }
  if (options.identity !== undefined) {
    headers.set("x-test-identity", options.identity);
  }
  if (options.idempotencyKey !== undefined) {
    headers.set("idempotency-key", options.idempotencyKey);
  }
  return new Request(url, { method: "POST", headers, body });
}

async function createPurchaseTemplate() {
  const response = await api.request(
    post(
      "/templates",
      JSON.stringify({
        id: "purchase",
        title: "Purchase approval",
        description: "Approval for purchases",
        payloadSchemaVersion: 1,
        approverIdentityIds: ["approver-1"],
      }),
      { identity: "admin-1" },
    ),
    {},
    bindings,
  );
  expect(response.status).toBe(201);
  return response.json();
}

describe("Gate API", () => {
  it("lists current templates and lets allowlisted administrators version them", async () => {
    const initial = await api.request(
      "https://gate.example.test/templates",
      {},
      bindings,
    );
    await expect(initial.json()).resolves.toEqual({ templates: [] });
    expect(initial.headers.get("cache-control")).toBe("no-store");

    await expect(createPurchaseTemplate()).resolves.toMatchObject({
      template: {
        id: "purchase",
        version: 1,
        payloadSchemaVersion: 1,
      },
    });
    const second = await api.request(
      post(
        "/templates",
        JSON.stringify({
          id: "purchase",
          title: "Purchase approval v2",
          payloadSchemaVersion: 2,
          approverIdentityIds: ["approver-2"],
        }),
        { identity: "admin-1" },
      ),
      {},
      bindings,
    );
    expect(second.status).toBe(201);
    await expect(second.json()).resolves.toMatchObject({
      template: { version: 2, payloadSchemaVersion: 2 },
    });

    const current = await api.request(
      "https://gate.example.test/templates",
      {},
      bindings,
    );
    await expect(current.json()).resolves.toMatchObject({
      templates: [{ version: 2, title: "Purchase approval v2" }],
    });
  });

  it("creates, replays, retrieves, and decides an idempotent approval request", async () => {
    await createPurchaseTemplate();
    const body = JSON.stringify({
      templateId: "purchase",
      templateVersion: 1,
      payloadSchemaVersion: 1,
      payload: { amount: 42, currency: "USD" },
      threadId: "thread-1",
    });
    const first = await api.request(
      post("/requests", body, {
        identity: "requester-1",
        idempotencyKey: "purchase-001",
      }),
      {},
      bindings,
    );
    expect(first.status).toBe(201);
    expect(first.headers.get("cache-control")).toBe("no-store");
    const created = await first.json<{
      readonly request: { readonly id: string };
    }>();

    const replay = await api.request(
      post("/requests", body, {
        identity: "requester-1",
        idempotencyKey: "purchase-001",
      }),
      {},
      bindings,
    );
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toMatchObject({
      request: { id: created.request.id, status: "pending" },
    });

    const requesterRead = await api.request(
      `https://gate.example.test/requests/${created.request.id}`,
      { headers: { "x-test-identity": "requester-1" } },
      bindings,
    );
    expect(requesterRead.status).toBe(200);
    await expect(requesterRead.json()).resolves.toMatchObject({
      request: { threadId: "thread-1" },
    });

    const outsiderRead = await api.request(
      `https://gate.example.test/requests/${created.request.id}`,
      { headers: { "x-test-identity": "outsider" } },
      bindings,
    );
    expect(outsiderRead.status).toBe(404);

    const decision = await api.request(
      post(
        `/requests/${created.request.id}/decision`,
        JSON.stringify({ decision: "approve" }),
        { identity: "approver-1" },
      ),
      {},
      bindings,
    );
    expect(decision.status).toBe(200);
    await expect(decision.json()).resolves.toMatchObject({
      request: {
        status: "approved",
        decidedBy: "approver-1",
        events: [
          { type: "created", actorIdentityId: "requester-1" },
          { type: "approved", actorIdentityId: "approver-1" },
        ],
      },
    });
  });

  it("rejects conflicting idempotency reuse and mismatched payload schemas", async () => {
    await createPurchaseTemplate();
    const first = await api.request(
      post(
        "/requests",
        JSON.stringify({
          templateId: "purchase",
          templateVersion: 1,
          payloadSchemaVersion: 1,
          payload: { amount: 42 },
        }),
        { identity: "requester-2", idempotencyKey: "key-1" },
      ),
      {},
      bindings,
    );
    expect(first.status).toBe(201);

    const conflict = await api.request(
      post(
        "/requests",
        JSON.stringify({
          templateId: "purchase",
          templateVersion: 1,
          payloadSchemaVersion: 1,
          payload: { amount: 43 },
        }),
        { identity: "requester-2", idempotencyKey: "key-1" },
      ),
      {},
      bindings,
    );
    expect(conflict.status).toBe(409);

    const invalidSchema = await api.request(
      post(
        "/requests",
        JSON.stringify({
          templateId: "purchase",
          templateVersion: 1,
          payloadSchemaVersion: 2,
          payload: { amount: 44 },
        }),
        { identity: "requester-2", idempotencyKey: "key-2" },
      ),
      {},
      bindings,
    );
    expect(invalidSchema.status).toBe(400);
  });

  it("updates eligible approvers dynamically and only lets the requester withdraw", async () => {
    await createPurchaseTemplate();
    const created = await api.request(
      post(
        "/requests",
        JSON.stringify({
          templateId: "purchase",
          templateVersion: 1,
          payloadSchemaVersion: 1,
          payload: { amount: 10 },
        }),
        { identity: "requester-3", idempotencyKey: "key-3" },
      ),
      {},
      bindings,
    );
    const { request } = await created.json<{
      readonly request: { readonly id: string };
    }>();

    const update = await api.request(
      new Request("https://gate.example.test/templates/purchase/1/approvers", {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          origin: "https://gate.example.test",
          "x-test-identity": "admin-1",
        },
        body: JSON.stringify({ approverIdentityIds: ["approver-2"] }),
      }),
      {},
      bindings,
    );
    expect(update.status).toBe(200);

    const denied = await api.request(
      post(`/requests/${request.id}/decision`, '{"decision":"approve"}', {
        identity: "approver-1",
      }),
      {},
      bindings,
    );
    expect(denied.status).toBe(403);

    const withdrawal = await api.request(
      post(`/requests/${request.id}/withdraw`, "{}", {
        identity: "requester-3",
      }),
      {},
      bindings,
    );
    expect(withdrawal.status).toBe(200);
    await expect(withdrawal.json()).resolves.toMatchObject({
      request: { status: "withdrawn" },
    });
  });

  it("enforces administrator, origin, media type, body shape, and size limits", async () => {
    await expect(
      api.request(
        post(
          "/templates",
          JSON.stringify({
            id: "denied",
            title: "Denied",
            payloadSchemaVersion: 1,
            approverIdentityIds: ["approver-1"],
          }),
          { identity: "not-admin" },
        ),
        {},
        bindings,
      ),
    ).resolves.toMatchObject({ status: 403 });

    const noOrigin = await api.request(
      post("/requests", "{}", {
        identity: "requester-1",
        idempotencyKey: "key",
        origin: "",
      }),
      {},
      bindings,
    );
    expect(noOrigin.status).toBe(403);

    const noContentType = await api.request(
      post("/templates", "{}", {
        identity: "admin-1",
        contentType: "text/plain",
      }),
      {},
      bindings,
    );
    expect(noContentType.status).toBe(400);

    const malformed = await api.request(
      post("/templates", "{", { identity: "admin-1" }),
      {},
      bindings,
    );
    expect(malformed.status).toBe(400);

    const wrongOrigin = await api.request(
      post("/templates", "{}", {
        identity: "admin-1",
        origin: "https://attacker.example.test",
      }),
      {},
      bindings,
    );
    expect(wrongOrigin.status).toBe(403);

    const invalidOrigin = await api.request(
      post("/templates", "{}", {
        identity: "admin-1",
        origin: "not a URL",
      }),
      {},
      bindings,
    );
    expect(invalidOrigin.status).toBe(403);

    const emptyAdminList = await api.request(
      post(
        "/templates",
        JSON.stringify({
          id: "disabled",
          title: "Disabled",
          payloadSchemaVersion: 1,
          approverIdentityIds: ["approver-1"],
        }),
        { identity: "admin-1" },
      ),
      {},
      { ...bindings, GATE_ADMIN_IDENTITY_IDS: "" },
    );
    expect(emptyAdminList.status).toBe(403);

    const whitespaceAdminList = await api.request(
      post(
        "/templates",
        JSON.stringify({
          id: "allowed",
          title: "Allowed",
          payloadSchemaVersion: 1,
          approverIdentityIds: ["approver-1"],
        }),
        { identity: "admin-2" },
      ),
      {},
      { ...bindings, GATE_ADMIN_IDENTITY_IDS: " admin-1, admin-2, " },
    );
    expect(whitespaceAdminList.status).toBe(201);

    const undefinedAdminList = await api.request(
      post("/templates", "{}", { identity: "admin-1" }),
      {},
      { ...bindings, GATE_ADMIN_IDENTITY_IDS: undefined },
    );
    expect(undefinedAdminList.status).toBe(403);

    const badTemplate = await api.request(
      post(
        "/templates",
        JSON.stringify({
          id: "bad",
          title: "",
          payloadSchemaVersion: 0,
          approverIdentityIds: [],
        }),
        { identity: "admin-1" },
      ),
      {},
      bindings,
    );
    expect(badTemplate.status).toBe(400);

    const invalidTemplate = await api.request(
      post(
        "/templates",
        JSON.stringify({
          id: "Bad ID",
          title: "Invalid ID",
          payloadSchemaVersion: 1,
          approverIdentityIds: ["approver-1"],
        }),
        { identity: "admin-1" },
      ),
      {},
      bindings,
    );
    expect(invalidTemplate.status).toBe(400);

    const invalidApproverList = await api.request(
      new Request("https://gate.example.test/templates/purchase/1/approvers", {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          origin: "https://gate.example.test",
          "x-test-identity": "admin-1",
        },
        body: JSON.stringify({ approverIdentityIds: [] }),
      }),
      {},
      bindings,
    );
    expect(invalidApproverList.status).toBe(400);

    const invalidVersion = await api.request(
      new Request(
        "https://gate.example.test/templates/purchase/nope/approvers",
        {
          method: "PUT",
          headers: {
            "content-type": "application/json",
            origin: "https://gate.example.test",
            "x-test-identity": "admin-1",
          },
          body: JSON.stringify({ approverIdentityIds: ["approver-1"] }),
        },
      ),
      {},
      bindings,
    );
    expect(invalidVersion.status).toBe(400);

    const unexpectedField = await api.request(
      post("/requests", '{"requesterIdentityId":"spoofed"}', {
        identity: "requester-1",
        idempotencyKey: "key",
      }),
      {},
      bindings,
    );
    expect(unexpectedField.status).toBe(400);

    const nonObjectBody = await api.request(
      post("/templates", "[]", { identity: "admin-1" }),
      {},
      bindings,
    );
    expect(nonObjectBody.status).toBe(400);

    const missingIdempotencyKey = await api.request(
      post(
        "/requests",
        JSON.stringify({
          templateId: "purchase",
          templateVersion: 1,
          payloadSchemaVersion: 1,
          payload: {},
        }),
        { identity: "requester-1" },
      ),
      {},
      bindings,
    );
    expect(missingIdempotencyKey.status).toBe(400);

    const invalidPayload = await api.request(
      post(
        "/requests",
        JSON.stringify({
          templateId: "purchase",
          templateVersion: 1,
          payloadSchemaVersion: 1,
          payload: [],
        }),
        { identity: "requester-1", idempotencyKey: "array-payload" },
      ),
      {},
      bindings,
    );
    expect(invalidPayload.status).toBe(400);

    const invalidThread = await api.request(
      post(
        "/requests",
        JSON.stringify({
          templateId: "purchase",
          templateVersion: 1,
          payloadSchemaVersion: 1,
          payload: { nested: ["valid", 1] },
          threadId: 2,
        }),
        { identity: "requester-1", idempotencyKey: "invalid-thread" },
      ),
      {},
      bindings,
    );
    expect(invalidThread.status).toBe(400);

    const invalidDecision = await api.request(
      post("/requests/00000000-0000-0000-0000-000000000000/decision", "{}"),
      {},
      bindings,
    );
    expect(invalidDecision.status).toBe(400);

    const missingBody = await api.request(
      new Request("https://gate.example.test/templates", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://gate.example.test",
          "x-test-identity": "admin-1",
        },
      }),
      {},
      bindings,
    );
    expect(missingBody.status).toBe(400);

    const claimedSize = await api.request(
      new Request("https://gate.example.test/templates", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": "999999",
          origin: "https://gate.example.test",
          "x-test-identity": "admin-1",
        },
        body: "{}",
      }),
      {},
      bindings,
    );
    expect(claimedSize.status).toBe(400);

    const wrongClaimedSize = await api.request(
      new Request("https://gate.example.test/templates", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": "1",
          origin: "https://gate.example.test",
          "x-test-identity": "admin-1",
        },
        body: "{}",
      }),
      {},
      bindings,
    );
    expect(wrongClaimedSize.status).toBe(400);

    const oversized = await api.request(
      post(
        "/requests",
        JSON.stringify({
          templateId: "purchase",
          templateVersion: 1,
          payloadSchemaVersion: 1,
          payload: { content: "x".repeat(70 * 1024) },
        }),
        { identity: "requester-1", idempotencyKey: "large" },
      ),
      {},
      bindings,
    );
    expect(oversized.status).toBe(400);

    const missingRequest = await api.request(
      "https://gate.example.test/requests/00000000-0000-0000-0000-000000000000",
      { headers: { "x-test-identity": "requester-1" } },
      bindings,
    );
    expect(missingRequest.status).toBe(404);
  });

  it("preserves HTTP exceptions raised by identity resolution", async () => {
    const unauthorizedApi = createGateApi(() => {
      throw new HTTPException(401, { message: "Authentication required." });
    });
    const response = await unauthorizedApi.request(
      "https://gate.example.test/requests/00000000-0000-0000-0000-000000000000",
      {},
      bindings,
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
