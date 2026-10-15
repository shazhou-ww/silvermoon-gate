import { authHandler, initAuthConfig } from "@hono/auth-js";
import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import {
  createAuthConfig,
  getConfiguredProviders,
  resolvePrincipal,
} from "./auth.js";
import type { Bindings } from "./env.js";
import { createGateApi, errorResponse } from "./gate-api.js";
import { GateStoreError } from "./gate-store.js";
import { createAgentApi } from "./agent-api.js";

const app = new Hono<{ Bindings: Bindings }>();
app.use("*", secureHeaders());
app.use("/api/*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  await next();
});
app.use(
  "*",
  initAuthConfig((c) => createAuthConfig(c.env as Bindings)),
);
app.use("/api/auth/*", authHandler());
app.route("/api/agent", createAgentApi());
app.get("/api/health", (c) =>
  c.json({ service: c.env.APP_NAME, status: "ok" }),
);
app.get("/api/bootstrap", (c) =>
  c.json({ appName: c.env.APP_NAME, providers: getConfiguredProviders(c.env) }),
);
app.route(
  "/api",
  createGateApi((c) => resolvePrincipal(c.req.raw, c.env)),
);
app.notFound((c) =>
  errorResponse(new GateStoreError(404, "API route not found."), c),
);
app.onError(errorResponse);
export default app;
