import type { GateJsonValue } from "@workspace/contracts";
import { Hono } from "hono";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";

import type { Bindings } from "./env.js";
import {
  createRequest,
  createTemplate,
  GateStoreError,
  getRequest,
  getTemplates,
  replaceTemplateApprovers,
  transitionRequest,
} from "./gate-store.js";

type IdentityResolver = (context: Context<{ Bindings: Bindings }>) => string;

const maxRequestBodyBytes = 64 * 1024;

export function createGateApi(resolveIdentity: IdentityResolver) {
  const api = new Hono<{ Bindings: Bindings }>();

  api.use("*", async (context, next) => {
    context.header("Cache-Control", "no-store");
    await next();
  });

  api.get("/templates", async (context) => {
    const templates = await getTemplates(context.env.GATE_DB);
    return context.json({ templates });
  });

  api.post("/templates", async (context) => {
    requireSameOrigin(context.req.raw);
    const identityId = resolveIdentity(context);
    const administrators = parseAdministratorIds(
      context.env.GATE_ADMIN_IDENTITY_IDS,
    );
    if (!administrators.includes(identityId)) {
      throw new GateStoreError(
        403,
        "Identity is not allowed to manage templates.",
      );
    }

    const body = await readJsonBody(context.req.raw, 16 * 1024);
    const record = requireObject(body, [
      "id",
      "title",
      "description",
      "payloadSchemaVersion",
      "approverIdentityIds",
    ]);
    if (
      typeof record.id !== "string" ||
      typeof record.title !== "string" ||
      !isPositiveInteger(record.payloadSchemaVersion) ||
      !Array.isArray(record.approverIdentityIds) ||
      !record.approverIdentityIds.every((id) => typeof id === "string") ||
      (record.description !== undefined &&
        typeof record.description !== "string")
    ) {
      throw new GateStoreError(400, "Template request fields are invalid.");
    }

    const template = await createTemplate(context.env.GATE_DB, identityId, {
      id: record.id,
      title: record.title,
      payloadSchemaVersion: record.payloadSchemaVersion,
      approverIdentityIds: record.approverIdentityIds,
      ...(typeof record.description === "string"
        ? { description: record.description }
        : {}),
    });
    return context.json({ template }, 201);
  });

  api.put("/templates/:id/:version/approvers", async (context) => {
    requireSameOrigin(context.req.raw);
    const identityId = resolveIdentity(context);
    const administrators = parseAdministratorIds(
      context.env.GATE_ADMIN_IDENTITY_IDS,
    );
    if (!administrators.includes(identityId)) {
      throw new GateStoreError(
        403,
        "Identity is not allowed to manage templates.",
      );
    }

    const version = Number(context.req.param("version"));
    if (!isPositiveInteger(version)) {
      throw new GateStoreError(
        400,
        "Template version must be a positive integer.",
      );
    }
    const body = await readJsonBody(context.req.raw, 16 * 1024);
    const record = requireObject(body, ["approverIdentityIds"]);
    if (
      !Array.isArray(record.approverIdentityIds) ||
      !record.approverIdentityIds.every((id) => typeof id === "string")
    ) {
      throw new GateStoreError(400, "Approver identity IDs are required.");
    }

    await replaceTemplateApprovers(
      context.env.GATE_DB,
      context.req.param("id"),
      version,
      identityId,
      record.approverIdentityIds,
    );
    return context.json({ updated: true });
  });

  api.post("/requests", async (context) => {
    requireSameOrigin(context.req.raw);
    const identityId = resolveIdentity(context);
    const idempotencyKey = context.req.header("Idempotency-Key");
    if (!idempotencyKey) {
      throw new GateStoreError(400, "Idempotency-Key header is required.");
    }

    const body = await readJsonBody(context.req.raw, maxRequestBodyBytes);
    const record = requireObject(body, [
      "templateId",
      "templateVersion",
      "payloadSchemaVersion",
      "payload",
      "threadId",
    ]);
    if (
      typeof record.templateId !== "string" ||
      !isPositiveInteger(record.templateVersion) ||
      !isPositiveInteger(record.payloadSchemaVersion) ||
      !isJsonObject(record.payload) ||
      !isGateJsonValue(record.payload) ||
      (record.threadId !== undefined && typeof record.threadId !== "string")
    ) {
      throw new GateStoreError(400, "Request fields are invalid.");
    }

    const result = await createRequest(
      context.env.GATE_DB,
      identityId,
      idempotencyKey,
      {
        templateId: record.templateId,
        templateVersion: record.templateVersion,
        payloadSchemaVersion: record.payloadSchemaVersion,
        payload: record.payload,
        ...(typeof record.threadId === "string"
          ? { threadId: record.threadId }
          : {}),
      },
    );
    return context.json(
      { request: result.request },
      result.created ? 201 : 200,
    );
  });

  api.get("/requests/:id", async (context) => {
    const identityId = resolveIdentity(context);
    const request = await getRequest(
      context.env.GATE_DB,
      context.req.param("id"),
      identityId,
    );
    if (!request) {
      throw new GateStoreError(404, "Request not found.");
    }
    return context.json({ request });
  });

  api.post("/requests/:id/decision", async (context) => {
    requireSameOrigin(context.req.raw);
    const identityId = resolveIdentity(context);
    const body = await readJsonBody(context.req.raw, 1024);
    const record = requireObject(body, ["decision"]);
    if (record.decision !== "approve" && record.decision !== "reject") {
      throw new GateStoreError(400, "Decision must be approve or reject.");
    }

    const request = await transitionRequest(
      context.env.GATE_DB,
      context.req.param("id"),
      identityId,
      record.decision,
    );
    return context.json({ request });
  });

  api.post("/requests/:id/withdraw", async (context) => {
    requireSameOrigin(context.req.raw);
    const identityId = resolveIdentity(context);
    const request = await transitionRequest(
      context.env.GATE_DB,
      context.req.param("id"),
      identityId,
      "withdraw",
    );
    return context.json({ request });
  });

  api.onError((error, context) => {
    if (error instanceof GateStoreError) {
      return context.json({ error: error.message }, error.status);
    }
    if (error instanceof HTTPException) {
      const response = error.getResponse();
      response.headers.set("Cache-Control", "no-store");
      return response;
    }

    console.error("Gate API request failed.", error);
    return context.json({ error: "Internal server error." }, 500);
  });

  return api;
}

function parseAdministratorIds(value: string | undefined): readonly string[] {
  return (value ?? "")
    .split(",")
    .map((identityId) => identityId.trim())
    .filter(Boolean);
}

async function readJsonBody(
  request: Request,
  maxBytes: number,
): Promise<unknown> {
  const contentType = request.headers
    .get("content-type")
    ?.split(";")[0]
    ?.trim();
  if (contentType !== "application/json") {
    throw new GateStoreError(400, "Content-Type must be application/json.");
  }

  const contentLength = request.headers.get("content-length");
  if (contentLength && Number(contentLength) > maxBytes) {
    throw new GateStoreError(400, "Request body exceeds the size limit.");
  }
  if (!request.body) {
    throw new GateStoreError(400, "Request body is required.");
  }

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  const reader = request.body.getReader();
  let reading = true;
  while (reading) {
    const { done, value } = await reader.read();
    if (done) {
      reading = false;
      continue;
    }
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel();
      throw new GateStoreError(400, "Request body exceeds the size limit.");
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(text) as unknown;
  } catch {
    throw new GateStoreError(400, "Request body must be valid JSON.");
  }
}

function requireObject(
  value: unknown,
  allowedKeys: readonly string[],
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new GateStoreError(400, "Request body must be a JSON object.");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !allowedKeys.includes(key))) {
    throw new GateStoreError(400, "Request body contains unsupported fields.");
  }
  return record;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isGateJsonValue(value: unknown): value is GateJsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every(isGateJsonValue);
  }
  if (typeof value === "object") {
    return Object.values(value).every(isGateJsonValue);
  }
  return false;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function requireSameOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  if (!origin) {
    throw new GateStoreError(403, "Origin header is required for this action.");
  }
  try {
    if (new URL(origin).origin !== new URL(request.url).origin) {
      throw new GateStoreError(403, "Cross-origin actions are not allowed.");
    }
  } catch (error) {
    if (error instanceof GateStoreError) {
      throw error;
    }
    throw new GateStoreError(403, "Origin header is invalid.");
  }
}
