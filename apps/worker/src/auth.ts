import type { AuthConfig } from "@hono/auth-js";
import GitHub from "@auth/core/providers/github";
import { getToken } from "@auth/core/jwt";
import type { Bindings } from "./env.js";
import { GateStoreError, getIdentity, type Principal } from "./gate-store.js";

const maxAge = 8 * 60 * 60;
export function safeRedirect(url: string, baseUrl: string): string {
  try {
    const target = new URL(url, baseUrl);
    if (
      url.startsWith("//") ||
      target.origin !== new URL(baseUrl).origin ||
      !/^\/(?:inbox|requests\/(?:mine|new|[^/]+))$/.test(target.pathname)
    )
      return `${new URL(baseUrl).origin}/inbox`;
    return target.href;
  } catch {
    return `${new URL(baseUrl).origin}/inbox`;
  }
}
async function findIdentity(env: Bindings, subject: string) {
  return env.GATE_DB.prepare(
    "SELECT id,name,session_generation FROM gate_identities WHERE github_subject=? AND status='active'",
  )
    .bind(subject)
    .first<{ id: string; name: string; session_generation: number }>();
}
export function createAuthConfig(env: Bindings): AuthConfig {
  return {
    providers:
      env.AUTH_GITHUB_ID?.trim() && env.AUTH_GITHUB_SECRET?.trim()
        ? [
            GitHub({
              clientId: env.AUTH_GITHUB_ID,
              clientSecret: env.AUTH_GITHUB_SECRET,
            }),
          ]
        : [],
    secret: env.AUTH_SECRET,
    trustHost: true,
    basePath: "/api/auth",
    session: { strategy: "jwt", maxAge },
    callbacks: {
      async signIn({ account }) {
        return (
          account?.provider === "github" &&
          !!(await findIdentity(env, account.providerAccountId))
        );
      },
      async jwt({ token, account }) {
        if (account) {
          if (account.provider !== "github") return null;
          const identity = await findIdentity(env, account.providerAccountId);
          if (!identity) return null;
          const id = crypto.randomUUID();
          const result = await env.GATE_DB.prepare(
            `INSERT INTO gate_sessions(id,identity_id,generation,expires_at)
            SELECT ?,id,session_generation,strftime('%Y-%m-%dT%H:%M:%fZ','now','+8 hours')
            FROM gate_identities WHERE id=? AND status='active' AND session_generation=?`,
          )
            .bind(id, identity.id, identity.session_generation)
            .run();
          if (result.meta.changes !== 1) return null;
          token.gateSessionId = id;
          token.sub = identity.id;
          token.name = identity.name;
          delete token.email;
          delete token.picture;
        }
        if (typeof token.gateSessionId !== "string" || !token.sub) return null;
        try {
          await getIdentity(env.GATE_DB, {
            identityId: token.sub,
            sessionId: token.gateSessionId,
          });
        } catch (error) {
          if (error instanceof GateStoreError) return null;
          throw error;
        }
        return token;
      },
      async session({ session, token }) {
        if (!token.sub || typeof token.gateSessionId !== "string")
          throw new GateStoreError(401, "Session required.");
        const me = await getIdentity(env.GATE_DB, {
          identityId: token.sub,
          sessionId: token.gateSessionId,
        });
        session.user = {
          ...session.user,
          id: me.identity.id,
          name: me.identity.name,
        };
        return session;
      },
      redirect({ url, baseUrl }) {
        return safeRedirect(url, baseUrl);
      },
    },
    events: {
      async signOut(message) {
        if (
          "token" in message &&
          typeof message.token?.gateSessionId === "string"
        ) {
          await env.GATE_DB.prepare(
            "UPDATE gate_sessions SET revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?",
          )
            .bind(message.token.gateSessionId)
            .run();
        }
      },
    },
  };
}
export function getConfiguredProviders(env: Bindings) {
  return env.AUTH_GITHUB_ID?.trim() && env.AUTH_GITHUB_SECRET?.trim()
    ? [{ id: "github", label: "GitHub" }]
    : [];
}
export async function resolvePrincipal(
  request: Request,
  env: Bindings,
): Promise<Principal> {
  const secureCookie = new URL(request.url).protocol === "https:";
  // Only the Auth.js HttpOnly cookie is accepted; bearer headers are not sessions.
  const headers = new Headers(request.headers);
  headers.delete("authorization");
  const token = await getToken({
    req: { headers },
    secret: env.AUTH_SECRET,
    secureCookie,
  });
  if (!token?.sub || typeof token.gateSessionId !== "string")
    throw new GateStoreError(401, "Session required.");
  const actor = { identityId: token.sub, sessionId: token.gateSessionId };
  await getIdentity(env.GATE_DB, actor);
  return actor;
}
