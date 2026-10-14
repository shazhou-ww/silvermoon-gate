import { authHandler, initAuthConfig, verifyAuth } from "@hono/auth-js";
import type { Session } from "@auth/core/types";
import type {
  BootstrapResponse,
  HealthResponse,
  SessionResponse,
} from "@workspace/contracts";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { secureHeaders } from "hono/secure-headers";

import { createAuthConfig, getConfiguredProviders } from "./auth.js";
import type { Bindings } from "./env.js";
import { createGateApi } from "./gate-api.js";
import { GateStoreError } from "./gate-store.js";

const app = new Hono<{ Bindings: Bindings }>();

app.use("*", secureHeaders());
app.use(
  "*",
  initAuthConfig((context) => createAuthConfig(context.env as Bindings)),
);

app.use("/api/auth/*", authHandler());

app.use("/api/templates", verifyAuth());
app.use("/api/templates/*", verifyAuth());
app.use("/api/requests", verifyAuth());
app.use("/api/requests/*", verifyAuth());

app.get("/api/health", (context) =>
  context.json<HealthResponse>({
    service: context.env.APP_NAME,
    status: "ok",
  }),
);

app.get("/api/bootstrap", (context) =>
  context.json<BootstrapResponse>({
    appName: context.env.APP_NAME,
    providers: getConfiguredProviders(context.env),
  }),
);

app.route(
  "/api",
  createGateApi((context) => getIdentityId(context.get("authUser").session)),
);

app.use("/api/me", verifyAuth());
app.get("/api/me", (context) => {
  const session = context.get("authUser").session;
  return context.json(toSessionResponse(session));
});

app.notFound((context) =>
  context.json(
    {
      error: "Not found",
    },
    404,
  ),
);

app.onError((error, context) => {
  if (error instanceof GateStoreError) {
    return context.json({ error: error.message }, error.status);
  }
  if (error instanceof HTTPException) {
    return error.getResponse();
  }

  console.error("Gate API request failed.", error);
  return context.json({ error: "Internal server error." }, 500);
});

export default app;

export function toSessionResponse(session: Session): SessionResponse {
  return {
    expires: session.expires,
    ...(session.user ? { user: session.user } : {}),
  };
}

export function getIdentityId(session: Session): string {
  const identityId = session.user?.id;
  if (!identityId) {
    throw new GateStoreError(
      403,
      "The authenticated session has no stable identity ID.",
    );
  }
  return identityId;
}
