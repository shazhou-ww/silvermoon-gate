import { Hono } from "hono";
import type { Context } from "hono";
import type {
  CreateGateRequest,
  GateRequestStatus,
} from "@workspace/contracts";
import type { Bindings } from "./env.js";
import {
  createRequest,
  GateStoreError,
  getIdentity,
  getRequest,
  getTemplates,
  listRequests,
  releaseSchema,
  transitionRequest,
  type Principal,
  type ListFilter,
} from "./gate-store.js";
type IdentityResolver = (
  context: Context<{ Bindings: Bindings }>,
) => Promise<Principal>;

export function errorResponse(
  error: Error,
  context: Context<{ Bindings: Bindings }>,
) {
  const traceId = crypto.randomUUID();
  const known = error instanceof GateStoreError;
  if (!known)
    console.error(
      JSON.stringify({
        traceId,
        code: "INTERNAL_ERROR",
        path: context.req.path,
      }),
    );
  return context.json(
    {
      error: {
        code: known ? error.code : "INTERNAL_ERROR",
        message: known ? error.message : "Internal server error.",
        traceId,
        ...(known && error.fieldErrors
          ? { fieldErrors: error.fieldErrors }
          : {}),
      },
    },
    known ? error.status : 500,
  );
}
export function createGateApi(resolveIdentity: IdentityResolver) {
  const api = new Hono<{ Bindings: Bindings }>();
  api.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  });
  api.get("/me", async (c) =>
    c.json(await getIdentity(c.env.GATE_DB, await resolveIdentity(c))),
  );
  api.get("/templates", async (c) =>
    c.json({
      templates: await getTemplates(c.env.GATE_DB, await resolveIdentity(c)),
    }),
  );
  api.get("/templates/:id/:version/schema", async (c) => {
    await resolveIdentity(c);
    if (
      c.req.param("id") !== "release-review" ||
      c.req.param("version") !== "1"
    )
      throw new GateStoreError(404, "Template not available.");
    return c.json({
      templateId: "release-review",
      templateVersion: 1,
      payloadSchemaVersion: 1,
      schema: releaseSchema,
    });
  });
  api.get("/requests", async (c) => {
    const actor = await resolveIdentity(c);
    const view = c.req.query("view") ?? "mine";
    const status = c.req.query("status") ?? null;
    const limitText = c.req.query("limit") ?? "20";
    const limit = Number(limitText);
    if (
      (view !== "mine" && view !== "inbox") ||
      (status !== null &&
        !["pending", "approved", "rejected", "withdrawn"].includes(status)) ||
      !/^[0-9]+$/.test(limitText) ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 50 ||
      (view === "inbox" && status && status !== "pending")
    )
      throw new GateStoreError(400, "Invalid list filters.");
    const filter: ListFilter = {
      view,
      status: status as GateRequestStatus | null,
      limit,
    };
    const cursor = c.req.query("cursor");
    if (cursor)
      filter.after = await decodeCursor(
        cursor,
        actor,
        filter,
        c.env.AUTH_SECRET,
      );
    const result = await listRequests(c.env.GATE_DB, actor, filter);
    return c.json({
      items: result.items.map((request) => ({
        id: request.id,
        status: request.status,
        requesterIdentityId: request.requesterIdentityId,
        templateId: request.templateId,
        templateVersion: request.templateVersion,
        payloadSchemaVersion: request.payloadSchemaVersion,
        candidate:
          typeof request.payload === "object" &&
          request.payload !== null &&
          !Array.isArray(request.payload)
            ? ((request.payload as Readonly<Record<string, unknown>>)
                .candidate ?? "")
            : "",
        createdAt: request.createdAt,
      })),
      nextCursor: result.after
        ? await encodeCursor(
            { identityId: actor.identityId, view, status, ...result.after },
            c.env.AUTH_SECRET,
          )
        : null,
    });
  });
  api.post("/requests", async (c) => {
    requireSameOrigin(c.req.raw);
    const actor = await resolveIdentity(c);
    const key = c.req.header("Idempotency-Key");
    if (!key) throw new GateStoreError(400, "Idempotency-Key is required.");
    const body = requireObject(await readJsonBody(c.req.raw, 16 * 1024), [
      "templateId",
      "templateVersion",
      "payloadSchemaVersion",
      "payload",
      "threadId",
    ]);
    const result = await createRequest(
      c.env.GATE_DB,
      actor,
      key,
      body as unknown as Omit<
        CreateGateRequest,
        "requesterIdentityId" | "idempotencyKey"
      >,
    );
    return c.json(
      { request: result.request, replayed: !result.created },
      result.created ? 201 : 200,
    );
  });
  api.get("/requests/:id", async (c) =>
    c.json({
      request: await getRequest(
        c.env.GATE_DB,
        c.req.param("id"),
        await resolveIdentity(c),
      ),
    }),
  );
  api.post("/requests/:id/decision", async (c) => {
    requireSameOrigin(c.req.raw);
    const actor = await resolveIdentity(c);
    const body = requireObject(await readJsonBody(c.req.raw, 1024), [
      "decision",
    ]);
    if (body.decision !== "approve" && body.decision !== "reject")
      throw new GateStoreError(400, "Decision must be approve or reject.");
    return c.json({
      request: await transitionRequest(
        c.env.GATE_DB,
        c.req.param("id"),
        actor,
        body.decision,
      ),
    });
  });
  api.post("/requests/:id/withdraw", async (c) => {
    requireSameOrigin(c.req.raw);
    const actor = await resolveIdentity(c);
    requireObject(await readJsonBody(c.req.raw, 1024), []);
    return c.json({
      request: await transitionRequest(
        c.env.GATE_DB,
        c.req.param("id"),
        actor,
        "withdraw",
      ),
    });
  });
  api.notFound((c) =>
    errorResponse(new GateStoreError(404, "API route not found."), c),
  );
  api.onError(errorResponse);
  return api;
}
function requireObject(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    throw new GateStoreError(400, "Unsupported JSON envelope.");
  return value as Record<string, unknown>;
}
export async function readJsonBody(
  request: Request,
  maxBytes: number,
): Promise<unknown> {
  if (
    request.headers.get("content-type")?.split(";")[0]?.trim() !==
    "application/json"
  )
    throw new GateStoreError(400, "Content-Type must be application/json.");
  if (Number(request.headers.get("content-length")) > maxBytes)
    throw new GateStoreError(413, "Request body exceeds the size limit.");
  if (!request.body) throw new GateStoreError(400, "JSON body required.");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > maxBytes) {
      await reader.cancel();
      throw new GateStoreError(413, "Request body exceeds the size limit.");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    ) as unknown;
  } catch {
    throw new GateStoreError(400, "Invalid JSON body.");
  }
}
export function requireSameOrigin(request: Request) {
  if (
    request.headers.get("origin") !== new URL(request.url).origin ||
    request.headers.get("sec-fetch-site") === "cross-site"
  )
    throw new GateStoreError(403, "A same-origin request is required.");
}
interface CursorData {
  identityId: string;
  view: string;
  status: string | null;
  createdAt: string;
  id: string;
}
async function hmacKey(secret: string) {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}
function base64(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}
function unbase64(text: string) {
  return Uint8Array.from(
    atob(text.replaceAll("-", "+").replaceAll("_", "/")),
    (c) => c.charCodeAt(0),
  );
}
async function encodeCursor(data: CursorData, secret: string) {
  const payload = base64(new TextEncoder().encode(JSON.stringify(data)));
  const signature = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(secret),
    new TextEncoder().encode(payload),
  );
  return `${payload}.${base64(new Uint8Array(signature))}`;
}
async function decodeCursor(
  cursor: string,
  actor: Principal,
  filter: ListFilter,
  secret: string,
) {
  try {
    if (cursor.length > 2048) throw new Error();
    const parts = cursor.split(".");
    const [payload, signature] = parts;
    if (
      parts.length !== 2 ||
      !payload ||
      !signature ||
      !(await crypto.subtle.verify(
        "HMAC",
        await hmacKey(secret),
        unbase64(signature),
        new TextEncoder().encode(payload),
      ))
    )
      throw new Error();
    const data = JSON.parse(
      new TextDecoder().decode(unbase64(payload)),
    ) as CursorData;
    if (
      data.identityId !== actor.identityId ||
      data.view !== filter.view ||
      data.status !== filter.status ||
      typeof data.id !== "string" ||
      typeof data.createdAt !== "string" ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(data.createdAt)
    )
      throw new Error();
    return { createdAt: data.createdAt, id: data.id };
  } catch {
    throw new GateStoreError(
      400,
      "Invalid cursor for this identity or filter.",
    );
  }
}
