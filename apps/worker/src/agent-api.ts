import { Hono } from "hono";
import type { Bindings } from "./env.js";
import {
  exchangeCredential,
  requireMachineRequest,
  resolveAgent,
} from "./agent-auth.js";
import {
  createAgentRequest,
  getAgentRequest,
  withdrawAgentRequest,
} from "./agent-store.js";
import { errorResponse, readJsonBody, requireObject } from "./gate-api.js";
import { GateStoreError, validateCreate } from "./gate-store.js";

export function createAgentApi() {
  const api = new Hono<{ Bindings: Bindings }>();
  api.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    requireMachineRequest(c.req.raw);
    await next();
  });
  api.post("/token", async (c) => {
    if (c.req.header("authorization"))
      throw new GateStoreError(
        401,
        "Valid Agent authentication is required.",
        "AGENT_AUTH_REQUIRED",
      );
    const body = requireObject(await readJsonBody(c.req.raw, 1024), [
      "credentialId",
      "credentialSecret",
    ]);
    return c.json(await exchangeCredential(c.env, body));
  });
  api.post("/requests", async (c) => {
    const actor = await resolveAgent(c.req.raw, c.env);
    const key = c.req.header("Idempotency-Key");
    if (!key) throw new GateStoreError(400, "Idempotency-Key is required.");
    const body = requireObject(await readJsonBody(c.req.raw, 16 * 1024), [
      "templateId",
      "templateVersion",
      "payloadSchemaVersion",
      "payload",
      "threadId",
    ]);
    validateCreate(body);
    const result = await createAgentRequest(c.env.GATE_DB, actor, key, body);
    return c.json(result, result.replayed ? 200 : 201);
  });
  api.get("/requests/:id", async (c) =>
    c.json({
      request: await getAgentRequest(
        c.env.GATE_DB,
        await resolveAgent(c.req.raw, c.env),
        c.req.param("id"),
      ),
    }),
  );
  api.post("/requests/:id/withdraw", async (c) => {
    const actor = await resolveAgent(c.req.raw, c.env);
    requireObject(await readJsonBody(c.req.raw, 1024), []);
    return c.json({
      request: await withdrawAgentRequest(
        c.env.GATE_DB,
        actor,
        c.req.param("id"),
      ),
    });
  });
  api.notFound((c) =>
    errorResponse(new GateStoreError(404, "API route not found."), c),
  );
  api.onError(errorResponse);
  return api;
}
