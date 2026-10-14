import type { BootstrapResponse, HealthResponse } from "@workspace/contracts";
import { describe, expect, it } from "vitest";

import { createAuthConfig } from "../src/auth.js";
import type { Bindings } from "../src/env.js";
import app, { toSessionResponse } from "../src/index.js";

const baseBindings = {
  APP_NAME: "Silvermoon Gate",
  AUTH_SECRET: "test-secret-that-is-long-enough-for-auth",
} as Bindings;

describe("Worker", () => {
  it("reports health", async () => {
    const response = await app.request(
      "http://example.test/api/health",
      {},
      baseBindings,
    );

    expect(response.status).toBe(200);
    await expect(response.json<HealthResponse>()).resolves.toEqual({
      service: "Silvermoon Gate",
      status: "ok",
    });
  });

  it("only exposes configured identity providers", async () => {
    const response = await app.request(
      "http://example.test/api/bootstrap",
      {},
      {
        ...baseBindings,
        AUTH_GITHUB_ID: "github-id",
        AUTH_GITHUB_SECRET: "github-secret",
        AUTH_GOOGLE_ID: "google-id",
        AUTH_GOOGLE_SECRET: "google-secret",
        AUTH_MICROSOFT_ENTRA_ID_ID: "microsoft-id",
        AUTH_MICROSOFT_ENTRA_ID_ISSUER:
          "https://login.microsoftonline.com/common/v2.0",
        AUTH_MICROSOFT_ENTRA_ID_SECRET: "microsoft-secret",
      },
    );

    const body = await response.json<BootstrapResponse>();
    expect(body.providers).toEqual([
      { id: "github", label: "GitHub" },
      { id: "google", label: "Google" },
      { id: "microsoft-entra-id", label: "Microsoft" },
    ]);
  });

  it("ignores incomplete credentials and supports the default Microsoft issuer", async () => {
    const bindings: Bindings = {
      ...baseBindings,
      AUTH_GITHUB_ID: "github-without-a-secret",
      AUTH_GOOGLE_ID: " ",
      AUTH_GOOGLE_SECRET: "google-secret",
      AUTH_MICROSOFT_ENTRA_ID_ID: "microsoft-id",
      AUTH_MICROSOFT_ENTRA_ID_SECRET: "microsoft-secret",
    };
    const response = await app.request(
      "http://example.test/api/bootstrap",
      {},
      bindings,
    );

    await expect(response.json<BootstrapResponse>()).resolves.toMatchObject({
      providers: [{ id: "microsoft-entra-id", label: "Microsoft" }],
    });
    expect(createAuthConfig(bindings).providers).toHaveLength(1);
  });

  it("protects the current-user endpoint", async () => {
    const response = await app.request(
      "http://example.test/api/me",
      {},
      baseBindings,
    );

    expect(response.status).toBe(401);
  });

  it("returns a JSON 404 for unknown API routes", async () => {
    const response = await app.request(
      "http://example.test/api/unknown",
      {},
      baseBindings,
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Not found" });
  });

  it("maps Auth.js sessions to the public contract", () => {
    expect(
      toSessionResponse({
        expires: "2099-01-01T00:00:00.000Z",
        user: {
          email: "operator@example.test",
          name: "Operator",
        },
      }),
    ).toEqual({
      expires: "2099-01-01T00:00:00.000Z",
      user: {
        email: "operator@example.test",
        name: "Operator",
      },
    });
    expect(
      toSessionResponse({
        expires: "2099-01-01T00:00:00.000Z",
      }),
    ).toEqual({
      expires: "2099-01-01T00:00:00.000Z",
    });
  });
});
