import { fileURLToPath } from "node:url";
import { encode } from "@auth/core/jwt";
import type { Account } from "@auth/core/types";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { describe, expect, it } from "vitest";
import { createAuthConfig } from "../src/auth.js";
import type { Bindings } from "../src/env.js";
import {
  createRequest,
  getRequest,
  transitionRequest,
  type GateRequestRecord,
  type Principal,
} from "../src/gate-store.js";
import { input } from "./fixtures.js";
import { applyMigrations } from "./runtime-migrations.js";

interface ApiBody {
  readonly request?: GateRequestRecord;
  readonly identity?: { readonly id: string };
  readonly replayed?: boolean;
  readonly error?: { readonly code: string; readonly traceId: string };
}

describe("Production migrations and HTTP Worker on local workerd D1", () => {
  it("enforces authorization, operation winners, idempotency and complete evidence rollback", async () => {
    const bundle = await build({
      entryPoints: [fileURLToPath(new URL("../src/index.ts", import.meta.url))],
      bundle: true,
      write: false,
      format: "esm",
      platform: "browser",
      target: "es2022",
    });
    const script = bundle.outputFiles[0]?.text;
    if (!script) throw new Error("Worker bundle is empty.");
    const secret = "isolated-local-runtime-test-secret-not-oauth-credentials";
    const mf = new Miniflare(
      convertV4MiniflareOptions({
        name: "gate-runtime-test",
        modules: true,
        script,
        compatibilityDate: "2026-10-14",
        compatibilityFlags: ["nodejs_compat"],
        d1Databases: { GATE_DB: "gate-runtime-test-database" },
        bindings: {
          AUTH_SECRET: secret,
          APP_NAME: "Gate isolated runtime test",
        },
      }),
    );
    try {
      const { GATE_DB: db } = await mf.getBindings<{
        GATE_DB: D1Database;
      }>("gate-runtime-test");
      await applyMigrations(db);
      await db.batch([
        db.prepare(
          `INSERT INTO gate_identities VALUES
             ('lin','101','Lin','active',1,1),
             ('kai','102','Kai','active',1,1),
             ('second','103','Second','active',1,1),
             ('other','104','Other','active',1,1)`,
        ),
        db.prepare(
          `INSERT INTO gate_template_access VALUES
             ('lin','release-review',1,'create',1),
             ('lin','release-review',1,'decide',1),
             ('kai','release-review',1,'decide',1),
             ('second','release-review',1,'decide',1)`,
        ),
      ]);
      const env: Bindings = {
        GATE_DB: db,
        AUTH_SECRET: secret,
        APP_NAME: "Gate isolated runtime test",
        ASSETS: {
          fetch: () => Promise.resolve(new Response()),
          connect: () => {
            throw new Error("Runtime test does not use asset sockets.");
          },
        },
      };
      const auth = createAuthConfig(env);
      const actors = new Map<string, Principal>();
      const cookies = new Map<string, string>();
      for (const [identity, subject] of Object.entries({
        lin: "101",
        kai: "102",
        second: "103",
        other: "104",
      })) {
        // Mock only the verified OAuth account input. Session creation,
        // encrypted cookies, HTTP authentication and D1 revocation are real.
        const account: Account = {
          provider: "github",
          providerAccountId: subject,
          type: "oauth",
        };
        expect(
          await auth.callbacks?.signIn?.({
            user: { id: subject },
            account,
          }),
        ).toBe(true);
        const token = await auth.callbacks?.jwt?.({
          token: {},
          user: { id: subject },
          account,
          trigger: "signIn",
        });
        if (!token || typeof token.gateSessionId !== "string") {
          throw new Error("Auth.js callback did not create a D1 session.");
        }
        expect(token.sub).toBe(identity);
        actors.set(identity, {
          identityId: identity,
          sessionId: token.gateSessionId,
        });
        const name = "__Secure-authjs.session-token";
        cookies.set(
          identity,
          `${name}=${await encode({
            secret,
            salt: name,
            token,
            maxAge: 3600,
          })}`,
        );
      }
      function actor(identity: string): Principal {
        const principal = actors.get(identity);
        if (!principal) throw new Error("Unknown runtime test identity.");
        return principal;
      }
      async function http(
        path: string,
        identity = "lin",
        method = "GET",
        body?: unknown,
        extra: Record<string, string> = {},
      ) {
        const cookie = cookies.get(identity);
        if (!cookie) throw new Error("Missing runtime test session cookie.");
        const response = await mf.dispatchFetch(
          `https://gate-runtime.test/api${path}`,
          {
            method,
            headers: {
              cookie,
              origin: "https://gate-runtime.test",
              "content-type": "application/json",
              ...extra,
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          },
        );
        return {
          status: response.status,
          body: (await response.json()) as ApiBody,
          cache: response.headers.get("cache-control"),
        };
      }

      const me = await http("/me");
      expect(me.status).toBe(200);
      expect(me.body.identity?.id).toBe("lin");
      expect(me.cache).toBe("no-store");
      const parallelCreates = await Promise.all(
        Array.from({ length: 3 }, () =>
          http("/requests", "lin", "POST", input, {
            "Idempotency-Key": "parallel-create",
          }),
        ),
      );
      expect(parallelCreates.map((result) => result.status).sort()).toEqual([
        200, 200, 201,
      ]);
      expect(
        new Set(parallelCreates.map((result) => result.body.request?.id)).size,
      ).toBe(1);
      const parallelId = parallelCreates[0]?.body.request?.id;
      expect(
        await db
          .prepare(
            "SELECT COUNT(*) AS n FROM gate_request_events WHERE request_id=?",
          )
          .bind(parallelId)
          .first("n"),
      ).toBe(1);
      const first = await http("/requests", "lin", "POST", input, {
        "Idempotency-Key": "http-create",
      });
      expect(first.status).toBe(201);
      const id = first.body.request?.id;
      if (!id) throw new Error("HTTP create did not return a request.");
      const replay = await http("/requests", "lin", "POST", input, {
        "Idempotency-Key": "http-create",
      });
      expect(replay.status).toBe(200);
      expect(replay.body.request?.id).toBe(id);
      expect(replay.body.replayed).toBe(true);
      const conflict = await http(
        "/requests",
        "lin",
        "POST",
        { ...input, threadId: "different" },
        { "Idempotency-Key": "http-create" },
      );
      expect(conflict.status).toBe(409);
      expect(conflict.body.error?.code).toBe("IDEMPOTENCY_CONFLICT");
      expect((await http(`/requests/${id}`, "other")).status).toBe(404);
      expect(
        (
          await http(`/requests/${id}/decision`, "lin", "POST", {
            decision: "approve",
          })
        ).status,
      ).toBe(403);

      const race = await Promise.all([
        http(`/requests/${id}/decision`, "kai", "POST", {
          decision: "approve",
        }),
        http(`/requests/${id}/decision`, "second", "POST", {
          decision: "reject",
        }),
      ]);
      expect(race.map((result) => result.status).sort()).toEqual([200, 409]);
      expect(
        await db
          .prepare(
            "SELECT COUNT(*) AS n FROM gate_decisions WHERE request_id=?",
          )
          .bind(id)
          .first("n"),
      ).toBe(1);
      expect(
        await db
          .prepare(
            "SELECT COUNT(*) AS n FROM gate_request_events WHERE request_id=?",
          )
          .bind(id)
          .first("n"),
      ).toBe(2);

      const created = await createRequest(
        db,
        actor("lin"),
        "withdraw-race",
        input,
      );
      const withdrawRace = await Promise.allSettled([
        transitionRequest(db, created.request.id, actor("kai"), "approve"),
        transitionRequest(db, created.request.id, actor("lin"), "withdraw"),
      ]);
      expect(
        withdrawRace.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      const withdrawn = await createRequest(
        db,
        actor("lin"),
        "withdraw",
        input,
      );
      const withdraw = await http(
        `/requests/${withdrawn.request.id}/withdraw`,
        "lin",
        "POST",
        {},
      );
      expect(withdraw.status).toBe(200);
      expect(withdraw.body.request?.status).toBe("withdrawn");
      expect(
        await db
          .prepare(
            "SELECT COUNT(*) AS n FROM gate_decisions WHERE request_id=?",
          )
          .bind(withdrawn.request.id)
          .first("n"),
      ).toBe(0);

      const pending = await createRequest(db, actor("lin"), "fault", input);
      await db
        .prepare(
          `CREATE TRIGGER runtime_audit_fault BEFORE INSERT ON gate_request_events
           WHEN NEW.event_type!='created'
           BEGIN SELECT RAISE(ABORT,'isolated audit fault'); END`,
        )
        .run();
      const fault = await http(
        `/requests/${pending.request.id}/decision`,
        "kai",
        "POST",
        { decision: "approve" },
      );
      expect(fault.status).toBe(500);
      expect(fault.body.error?.code).toBe("INTERNAL_ERROR");
      expect(fault.body.error?.traceId).toBeTypeOf("string");
      const restored = await getRequest(db, pending.request.id, actor("lin"));
      expect(restored.status).toBe("pending");
      expect(restored.events).toHaveLength(1);
      expect(
        await db
          .prepare(
            "SELECT COUNT(*) AS n FROM gate_decisions WHERE request_id=?",
          )
          .bind(pending.request.id)
          .first("n"),
      ).toBe(0);
      await db.prepare("DROP TRIGGER runtime_audit_fault").run();
      await db
        .prepare(
          `CREATE TRIGGER runtime_decision_fault BEFORE INSERT ON gate_decisions
           BEGIN SELECT RAISE(ABORT,'isolated decision fault'); END`,
        )
        .run();
      await expect(
        transitionRequest(db, pending.request.id, actor("kai"), "approve"),
      ).rejects.toThrow();
      expect(
        (await getRequest(db, pending.request.id, actor("lin"))).status,
      ).toBe("pending");
      await db.prepare("DROP TRIGGER runtime_decision_fault").run();

      const revoked = await createRequest(db, actor("lin"), "revoke", input);
      await db
        .prepare(
          "DELETE FROM gate_template_access WHERE identity_id='kai' AND permission='decide'",
        )
        .run();
      expect(
        (await http(`/requests/${revoked.request.id}`, "kai")).status,
      ).toBe(404);
      expect(
        (
          await http(
            `/requests/${revoked.request.id}/decision`,
            "kai",
            "POST",
            { decision: "approve" },
          )
        ).status,
      ).toBe(404);
      await db
        .prepare(
          "UPDATE gate_identities SET status='disabled',revision=2 WHERE id='second'",
        )
        .run();
      expect((await http("/me", "second")).status).toBe(401);
      expect(
        (
          await http(
            `/requests/${revoked.request.id}/decision`,
            "second",
            "POST",
            { decision: "approve" },
          )
        ).status,
      ).toBe(401);
      await auth.events?.signOut?.({
        token: { sub: "lin", gateSessionId: actor("lin").sessionId },
      });
      expect((await http("/me", "lin")).status).toBe(401);
      expect((await http("/me", "other")).status).toBe(200);
      expect(
        await db
          .prepare("SELECT status FROM gate_requests WHERE id=?")
          .bind(revoked.request.id)
          .first("status"),
      ).toBe("pending");
    } finally {
      await mf.dispose();
    }
  }, 60_000);
});
