import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encode, type JWT } from "@auth/core/jwt";
import type { Account, User, Session } from "@auth/core/types";
import app from "../src/index.js";
import {
  createAuthConfig,
  getConfiguredProviders,
  resolvePrincipal,
  safeRedirect,
} from "../src/auth.js";
import { SqliteD1Database } from "./sqlite-d1.js";
import { seed, bindings, lin } from "./fixtures.js";
let db: SqliteD1Database;
beforeEach(async () => {
  db = new SqliteD1Database();
  await seed(db);
});
afterEach(() => {
  db.close();
});
async function cookie(
  identityId = "lin",
  sessionId = "session-lin",
  secure = false,
) {
  const name = secure
    ? "__Secure-authjs.session-token"
    : "authjs.session-token";
  return `${name}=${await encode({ secret: bindings(db).AUTH_SECRET, salt: name, token: { sub: identityId, gateSessionId: sessionId }, maxAge: 3600 })}`;
}
function account(subject = "101", provider = "github"): Account {
  return { provider, providerAccountId: subject, type: "oauth" };
}
const user: User = { id: "oauth-provider-id", name: "Untrusted provider name" };
describe("Real cookie authentication and worker", () => {
  it("returns public bootstrap and health without allowing alternate providers", async () => {
    expect(
      await (
        await app.request("http://example.test/api/health", {}, bindings(db))
      ).json(),
    ).toEqual({ service: "Silvermoon Gate", status: "ok" });
    const env = {
      ...bindings(db),
      AUTH_GITHUB_ID: "id",
      AUTH_GITHUB_SECRET: "secret",
    };
    expect(
      await (
        await app.request("http://example.test/api/bootstrap", {}, env)
      ).json(),
    ).toMatchObject({ providers: [{ id: "github", label: "GitHub" }] });
    expect(getConfiguredProviders({ ...env, AUTH_GITHUB_SECRET: " " })).toEqual(
      [],
    );
    expect(createAuthConfig(bindings(db)).providers).toHaveLength(0);
    expect(createAuthConfig(env).providers).toHaveLength(1);
  });
  it("requires a cryptographically valid cookie and ignores spoofed bearer/user headers", async () => {
    for (const path of ["/api/me", "/api/requests", "/api/templates"]) {
      const response = await app.request(
        `http://example.test${path}`,
        { headers: { "x-user-id": "lin", authorization: "Bearer spoof" } },
        bindings(db),
      );
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({
        error: { code: "SESSION_REQUIRED" },
      });
    }
    const valid = await app.request(
      "http://example.test/api/me",
      { headers: { cookie: await cookie() } },
      bindings(db),
    );
    expect(await valid.json()).toMatchObject({
      identity: { id: "lin", name: "Lin" },
    });
    const secure = await resolvePrincipal(
      new Request("https://example.test", {
        headers: { cookie: await cookie("lin", "session-lin", true) },
      }),
      bindings(db),
    );
    expect(secure).toEqual(lin);
    for (const header of [
      await cookie("kai", "session-lin"),
      "authjs.session-token=bad",
      await cookie("lin", "missing"),
    ])
      await expect(
        resolvePrincipal(
          new Request("http://example.test", { headers: { cookie: header } }),
          bindings(db),
        ),
      ).rejects.toMatchObject({ status: 401 });
    await expect(
      resolvePrincipal(
        new Request("http://example.test", {
          headers: { cookie: await cookie("lin", "session-lin") },
        }),
        { ...bindings(db), AUTH_SECRET: "another-secret" },
      ),
    ).rejects.toMatchObject({ status: 401 });
  });
  it("binds OAuth subjects, rejects unknown accounts, and revokes server-side on signout", async () => {
    const config = createAuthConfig(bindings(db));
    expect(await config.callbacks!.signIn!({ user, account: account() })).toBe(
      true,
    );
    expect(
      await config.callbacks!.signIn!({ user, account: account("999") }),
    ).toBe(false);
    expect(
      await config.callbacks!.signIn!({
        user,
        account: account("101", "google"),
      }),
    ).toBe(false);
    expect(await config.callbacks!.signIn!({ user, account: null })).toBe(
      false,
    );
    const token = await config.callbacks!.jwt!({
      token: { email: "private@test", picture: "photo" },
      user,
      account: account(),
      trigger: "signIn",
    });
    expect(token).toMatchObject({
      sub: "lin",
      name: "Lin",
      gateSessionId: expect.any(String) as unknown,
    });
    expect(token).not.toHaveProperty("email");
    if (!token) throw new Error("No token");
    // Auth.js types intersect database and JWT callback parameters even though
    // this configuration exclusively uses JWT sessions.
    const sessionCallback = config.callbacks!.session! as (params: {
      session: Session;
      token: JWT;
    }) => Promise<Session>;
    const session = await sessionCallback({
      session: { expires: "2099-01-01", user: { id: "lin" } },
      token,
    });
    expect(session.user?.id).toBe("lin");
    await config.events!.signOut!({ token });
    expect(
      await config.callbacks!.jwt!({ token, user, account: null }),
    ).toBeNull();
    await expect(
      sessionCallback({
        session: { expires: "2099-01-01", user: { id: "lin" } },
        token,
      }),
    ).rejects.toMatchObject({ status: 401 });
    expect(
      await config.callbacks!.jwt!({ token: {}, user, account: null }),
    ).toBeNull();
    expect(
      await config.callbacks!.jwt!({
        token: {},
        user,
        account: account("101", "google"),
      }),
    ).toBeNull();
    expect(
      await config.callbacks!.jwt!({
        token: {},
        user,
        account: account("999"),
      }),
    ).toBeNull();
    await config.events!.signOut!({ token: null });
    await config.events!.signOut!({
      session: { sessionToken: "unused", userId: "lin", expires: new Date() },
    });
  });
  it("refuses disabled identities even with valid cookies, and logout records do not leak across identities", async () => {
    await db.exec(
      "UPDATE gate_identities SET status='disabled',revision=2 WHERE id='lin'",
    );
    expect(
      (
        await app.request(
          "http://example.test/api/me",
          { headers: { cookie: await cookie() } },
          bindings(db),
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await app.request(
          "http://example.test/api/me",
          { headers: { cookie: await cookie("kai", "session-kai") } },
          bindings(db),
        )
      ).status,
    ).toBe(200);
  });
  it("allows only local application login returns", async () => {
    for (const target of [
      "https://evil.test/inbox",
      "//evil.test/inbox",
      "/api/auth/callback/github",
      "/admin",
      "not a url",
      "http://[",
    ])
      expect(safeRedirect(target, "https://gate.test")).toBe(
        "https://gate.test/inbox",
      );
    expect(safeRedirect("/requests/mine", "https://gate.test")).toBe(
      "https://gate.test/requests/mine",
    );
    expect(
      safeRedirect("https://gate.test/requests/123", "https://gate.test"),
    ).toBe("https://gate.test/requests/123");
    expect(
      await createAuthConfig(bindings(db)).callbacks!.redirect!({
        url: "/inbox",
        baseUrl: "https://gate.test",
      }),
    ).toBe("https://gate.test/inbox");
  });
  it("returns an explicit JSON unknown-route error", async () => {
    const response = await app.request(
      "http://example.test/api/unknown",
      {},
      bindings(db),
    );
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({
      error: {
        code: "REQUEST_NOT_ACCESSIBLE",
        traceId: expect.any(String) as unknown,
      },
    });
  });
});
