import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createGateApi,
  readJsonBody,
  requireSameOrigin,
} from "../src/gate-api.js";
import { GateStoreError } from "../src/gate-store.js";
import { SqliteD1Database } from "./sqlite-d1.js";
import { seed, lin, kai, other, input, bindings } from "./fixtures.js";
let db: SqliteD1Database;
let actor = lin;
const api = createGateApi(() => Promise.resolve(actor));
function call(
  path: string,
  method = "GET",
  body?: unknown,
  headers?: Record<string, string>,
) {
  return api.request(
    `http://example.test${path}`,
    {
      method,
      headers: {
        origin: "http://example.test",
        "content-type": "application/json",
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    bindings(db),
  );
}
beforeEach(async () => {
  db = new SqliteD1Database();
  await seed(db);
  actor = lin;
});
afterEach(() => {
  db.close();
  vi.restoreAllMocks();
});
describe("MVP API", () => {
  it("returns me, fixed template and schema and removes browser administration", async () => {
    expect(await (await call("/me")).json()).toMatchObject({
      identity: { id: "lin" },
      permissions: { canCreate: true },
    });
    expect(await (await call("/templates")).json()).toMatchObject({
      templates: [{ id: "release-review", version: 1 }],
    });
    expect(
      await (await call("/templates/release-review/1/schema")).json(),
    ).toMatchObject({ schema: { additionalProperties: false } });
    expect((await call("/templates/other/1/schema")).status).toBe(404);
    expect((await call("/templates", "POST", {})).status).toBe(404);
    expect(
      (await call("/templates/release-review/1/approvers", "PUT", {})).status,
    ).toBe(404);
  });
  it("creates, replays, decides and returns one atomic request/event snapshot", async () => {
    const created = await call("/requests", "POST", input, {
      "Idempotency-Key": "key",
    });
    expect(created.status).toBe(201);
    expect(created.headers.get("cache-control")).toBe("no-store");
    const body = await created.json<{ request: { id: string } }>();
    const replay = await call("/requests", "POST", input, {
      "Idempotency-Key": "key",
    });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({
      replayed: true,
      request: { id: body.request.id },
    });
    actor = kai;
    const decision = await call(
      `/requests/${body.request.id}/decision`,
      "POST",
      { decision: "approve" },
    );
    expect(decision.status).toBe(200);
    expect(await decision.json()).toMatchObject({
      request: {
        status: "approved",
        events: [{ type: "created" }, { type: "approved" }],
        allowedActions: [],
      },
    });
    expect((await call(`/requests/${body.request.id}`)).status).toBe(200);
    expect(
      (
        await call(`/requests/${body.request.id}/decision`, "POST", {
          decision: "reject",
        })
      ).status,
    ).toBe(409);
    actor = other;
    const missing = await call(`/requests/${body.request.id}`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({
      error: {
        code: "REQUEST_NOT_ACCESSIBLE",
        traceId: expect.any(String) as unknown,
      },
    });
  });
  it("withdraw requires an empty JSON object and forbids actor injection", async () => {
    const body = await (
      await call("/requests", "POST", input, { "Idempotency-Key": "key" })
    ).json<{ request: { id: string } }>();
    for (const value of [[], null, { actor: "kai" }])
      expect(
        (await call(`/requests/${body.request.id}/withdraw`, "POST", value))
          .status,
      ).toBe(400);
    expect(
      (await call(`/requests/${body.request.id}/withdraw`, "POST", {})).status,
    ).toBe(200);
  });
  it.each([
    {},
    [],
    null,
    { ...input, actor: "kai" },
    { ...input, payload: { environment: "production" } },
  ])("rejects bad creates", async (body) => {
    expect(
      (await call("/requests", "POST", body, { "Idempotency-Key": "key" }))
        .status,
    ).toBe(400);
  });
  it("validates keys, decisions, CSRF, content type, JSON and streamed body size", async () => {
    for (const body of [
      { ...input, templateId: 42 },
      { ...input, templateVersion: "1" },
      { ...input, payloadSchemaVersion: true },
      { ...input, payload: null },
      { ...input, payload: [] },
      { ...input, payload: { ...input.payload, summary: 42 } },
      { ...input, payload: { ...input.payload, extra: true } },
      { ...input, threadId: 42 },
    ]) {
      const invalid = await call("/requests", "POST", body, {
        "Idempotency-Key": "invalid-types",
      });
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toMatchObject({
        error: { code: "INVALID_INPUT" },
      });
    }
    expect(
      await db.prepare("SELECT count(*) AS n FROM gate_requests").first("n"),
    ).toBe(0);
    expect((await call("/requests", "POST", input)).status).toBe(400);
    expect(
      (await call("/requests/missing/decision", "POST", { decision: "maybe" }))
        .status,
    ).toBe(400);
    expect(
      (
        await call("/requests", "POST", input, {
          origin: "http://evil.test",
          "Idempotency-Key": "key",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call("/requests", "POST", input, {
          "content-type": "text/plain",
          "Idempotency-Key": "key",
        })
      ).status,
    ).toBe(400);
    const invalid = await api.request(
      "http://example.test/requests",
      {
        method: "POST",
        headers: {
          origin: "http://example.test",
          "content-type": "application/json",
          "Idempotency-Key": "key",
        },
        body: "{",
      },
      bindings(db),
    );
    expect(invalid.status).toBe(400);
    for (const headers of [
      { "content-type": "application/json" },
      { "content-type": "application/json", "content-length": "20000" },
    ]) {
      await expect(
        readJsonBody(
          new Request("http://example.test", {
            method: "POST",
            headers,
            body: "x".repeat(17000),
          }),
          16000,
        ),
      ).rejects.toMatchObject({ status: 413 });
    }
    await expect(
      readJsonBody(
        new Request("http://example.test", {
          headers: { "content-type": "application/json" },
        }),
        1024,
      ),
    ).rejects.toMatchObject({ status: 400 });
    const badUtf8 = new Request("http://example.test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: new Uint8Array([0xff]),
    });
    await expect(readJsonBody(badUtf8, 1024)).rejects.toMatchObject({
      status: 400,
    });
    expect(() => {
      requireSameOrigin(
        new Request("http://example.test", {
          headers: {
            origin: "http://example.test",
            "sec-fetch-site": "cross-site",
          },
        }),
      );
    }).toThrow();
    expect(() => {
      requireSameOrigin(new Request("http://example.test"));
    }).toThrow();
  });
  it("authenticates cursors and binds them to identities, views and status filters", async () => {
    for (let i = 0; i < 3; i++)
      await call("/requests", "POST", input, { "Idempotency-Key": `key${i}` });
    const first = await (
      await call("/requests?view=mine&limit=1")
    ).json<{ items: { id: string }[]; nextCursor: string }>();
    const next = await (
      await call(`/requests?view=mine&limit=1&cursor=${first.nextCursor}`)
    ).json<{ items: { id: string }[] }>();
    expect(next.items[0]?.id).not.toBe(first.items[0]?.id);
    for (const query of [
      `view=inbox&cursor=${first.nextCursor}`,
      `status=pending&cursor=${first.nextCursor}`,
      `cursor=${first.nextCursor}broken`,
      "cursor=bad",
      "cursor=a.b.c",
      `cursor=${"a".repeat(2050)}`,
      "view=all",
      "status=bad",
      "limit=0",
      "limit=51",
      "limit=1.5",
      "limit=-2",
      "view=inbox&status=approved",
    ])
      expect((await call(`/requests?${query}`)).status).toBe(400);
    actor = kai;
    expect((await call(`/requests?cursor=${first.nextCursor}`)).status).toBe(
      400,
    );
    expect(await (await call("/requests?view=inbox")).json()).toMatchObject({
      items: expect.any(Array) as unknown,
      nextCursor: null,
    });
  });
  it("sanitizes unexpected failures but keeps a trace and no-store", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(db, "prepare").mockImplementation(() => {
      throw new Error("SQL secret payload");
    });
    const response = await call("/me");
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      error: {
        code: "INTERNAL_ERROR",
        message: "Internal server error.",
        traceId: expect.any(String) as unknown,
      },
    });
    expect(log.mock.calls.flat().join()).not.toContain("secret");
    const busy = createGateApi(() =>
      Promise.reject(new GateStoreError(503, "Service busy.")),
    );
    expect(
      (await busy.request("http://example.test/me", {}, bindings(db))).status,
    ).toBe(503);
  });
});
