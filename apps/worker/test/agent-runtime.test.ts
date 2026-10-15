import { spawn } from "node:child_process";
import type { Buffer } from "node:buffer";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { encode } from "@auth/core/jwt";
import { describe, expect, it } from "vitest";
import { calculatePayloadDigest } from "@workspace/contracts";
import { createAuthConfig } from "../src/auth.js";
import {
  issueAgentCredential,
  registerAgent,
  revokeAgentAuthentication,
  setAgentAccess,
} from "../src/agent-admin.js";
import {
  agentAudience,
  randomSecret,
  resolveAgent,
  secretHash,
} from "../src/agent-auth.js";
import {
  createAgentRequest,
  getAgentRequest,
  withdrawAgentRequest,
} from "../src/agent-store.js";
import type { Bindings } from "../src/env.js";
import type { GateRequestRecord } from "../src/gate-store.js";
import { input } from "./fixtures.js";
import { applyMigrations } from "./runtime-migrations.js";

const databaseId = "00000000-0000-0000-0000-000000000000";
const issuer = "urn:silvermoon-gate:local";
const authSecret = "isolated-agent-runtime-secret-not-production-oauth";
function child(script: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolveResult, reject) => {
      const processChild = spawn(process.execPath, [script, ...args], {
        env: { ...process.env, ...env },
        windowsHide: true,
      });
      let stdout = "",
        stderr = "";
      processChild.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      processChild.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      processChild.on("error", reject);
      processChild.on("close", (code) => {
        resolveResult({ code, stdout, stderr });
      });
    },
  );
}
async function runtime(legacy = false) {
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL("../src/index.ts", import.meta.url))],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
  });
  const script = bundle.outputFiles[0]?.text;
  if (!script) throw new Error("Missing Worker bundle.");
  const persist = resolve(".wrangler", `agent-runtime-${crypto.randomUUID()}`);
  await mkdir(persist, { recursive: true });
  const options = convertV4MiniflareOptions({
    name: "gate-agent-runtime",
    modules: true,
    script,
    host: "127.0.0.1",
    port: 0,
    compatibilityDate: "2026-10-14",
    compatibilityFlags: ["nodejs_compat"],
    d1Databases: { GATE_DB: databaseId },
    resourcePersistencePath: persist,
    bindings: {
      AUTH_SECRET: authSecret,
      APP_NAME: "Isolated Agent test",
      GATE_AGENT_ISSUER: issuer,
    },
  });
  const mf = new Miniflare(options);
  const origin = (await mf.ready).origin;
  expect((await fetch(`${origin}/api/health`)).status).toBe(200);
  const { GATE_DB: db } = await mf.getBindings<{ GATE_DB: D1Database }>();
  await applyMigrations(db, ["0001_gate.sql", "0002_human_mvp.sql"]);
  await db.batch([
    db.prepare(
      "INSERT INTO gate_identities VALUES('lin','101','Lin','active',1,1),('kai','102','Kai','active',1,1)",
    ),
    db.prepare(
      "INSERT INTO gate_template_access VALUES('lin','release-review',1,'create',1),('kai','release-review',1,'decide',1)",
    ),
  ]);
  if (legacy) {
    await db.batch([
      db.prepare(`INSERT INTO gate_requests(id,idempotency_key,request_fingerprint,requester_identity_id,
       template_id,template_version,payload_schema_version,payload_json,payload_digest,status,created_at,decided_at,decided_by)
       VALUES('legacy-id','legacy-key','legacy-fingerprint','legacy-requester','release-review',1,1,
        '{"original":true}','legacy-digest','approved','2020-01-01','2020-01-02','legacy-approver')`),
      db.prepare(`INSERT INTO gate_request_events(request_id,event_type,actor_identity_id,occurred_at)
       VALUES('legacy-id','created','legacy-requester','2020-01-01'),('legacy-id','approved','legacy-approver','2020-01-02')`),
    ]);
  }
  const before = legacy
    ? JSON.stringify([
        (await db.prepare("SELECT * FROM gate_requests ORDER BY id").all())
          .results,
        (
          await db
            .prepare("SELECT * FROM gate_request_events ORDER BY sequence")
            .all()
        ).results,
        (await db.prepare("SELECT * FROM gate_identities ORDER BY id").all())
          .results,
        (
          await db
            .prepare(
              "SELECT * FROM gate_configuration_events ORDER BY sequence",
            )
            .all()
        ).results,
      ])
    : null;
  await applyMigrations(db, ["0003_agent_mvp.sql"]);
  if (legacy)
    expect(
      JSON.stringify([
        (await db.prepare("SELECT * FROM gate_requests ORDER BY id").all())
          .results,
        (
          await db
            .prepare("SELECT * FROM gate_request_events ORDER BY sequence")
            .all()
        ).results,
        (await db.prepare("SELECT * FROM gate_identities ORDER BY id").all())
          .results,
        (
          await db
            .prepare(
              "SELECT * FROM gate_configuration_events ORDER BY sequence",
            )
            .all()
        ).results,
      ]),
    ).toBe(before);
  const auth = createAuthConfig({
    GATE_DB: db,
    AUTH_SECRET: authSecret,
  } as Bindings);
  const account = {
    provider: "github",
    providerAccountId: "102",
    type: "oauth" as const,
  };
  expect(await auth.callbacks?.signIn?.({ user: { id: "102" }, account })).toBe(
    true,
  );
  const token = await auth.callbacks?.jwt?.({
    token: {},
    user: { id: "102" },
    account,
    trigger: "signIn",
  });
  if (!token)
    throw new Error(
      "Production OAuth callback did not establish a local human session.",
    );
  const cookie = `authjs.session-token=${await encode({ secret: authSecret, salt: "authjs.session-token", token, maxAge: 3600 })}`;
  const agentId = await registerAgent(db, "lin", "Runtime Agent");
  const credential = await issueAgentCredential(db, agentId);
  for (const permission of ["create", "read", "withdraw"])
    await setAgentAccess(db, agentId, permission, true);
  async function decision(id: string, outcome: "approve" | "reject") {
    const response = await fetch(`${origin}/api/requests/${id}/decision`, {
      method: "POST",
      headers: { cookie, origin, "content-type": "application/json" },
      body: JSON.stringify({ decision: outcome }),
    });
    expect(response.status, await response.text()).toBe(200);
  }
  return {
    mf,
    options,
    origin,
    db,
    persist,
    agentId,
    credential,
    cookie,
    decision,
  };
}

describe("Agent production Worker, real workerd D1 and executable caller", () => {
  it("migrates a historical runtime database without reattributing old humans, payloads or audit", async () => {
    const r = await runtime(true);
    try {
      const response = await fetch(`${r.origin}/api/requests/legacy-id`, {
        headers: { cookie: r.cookie },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        request: {
          requesterType: "legacy",
          requesterIdentityId: "legacy-requester",
          payloadDigest: "legacy-digest",
          decidedBy: "legacy-approver",
          status: "approved",
        },
      });
      for (const id of ["legacy-requester", "legacy-approver", "lin"]) {
        await expect(
          r.db
            .prepare(
              "INSERT INTO gate_agent_identities VALUES(?,'Conflict','active',1,1,'lin')",
            )
            .bind(id)
            .run(),
        ).rejects.toThrow("already attributed");
      }
      expect(
        await r.db
          .prepare(
            "SELECT count(*) AS n FROM gate_decisions WHERE request_id='legacy-id'",
          )
          .first("n"),
      ).toBe(0);
    } finally {
      await r.mf.dispose();
      await rm(r.persist, { recursive: true, force: true });
    }
  }, 120000);
  it("enforces token hashes, explicit authority, conditional races, atomic evidence and persistent history", async () => {
    const r = await runtime();
    try {
      const issued = await fetch(`${r.origin}/api/agent/token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(r.credential),
      });
      expect(issued.status).toBe(200);
      const token = await issued.json<{ accessToken: string }>();
      const headers = {
        authorization: `Bearer ${token.accessToken}`,
        "Idempotency-Key": "same",
        "content-type": "application/json",
      };
      const attempts = await Promise.all(
        [1, 2].map(() =>
          fetch(`${r.origin}/api/agent/requests`, {
            method: "POST",
            headers,
            body: JSON.stringify(input),
          }),
        ),
      );
      expect(attempts.map((response) => response.status).sort()).toEqual([
        200, 201,
      ]);
      const values = await Promise.all(
        attempts.map((response) =>
          response.json<{ request: GateRequestRecord }>(),
        ),
      );
      const id = values[0]!.request.id;
      expect(values[1]!.request.id).toBe(id);
      expect(values[0]!.request.requesterType).toBe("agent");
      expect(
        (
          await fetch(`${r.origin}/api/agent/requests/${id}/decision`, {
            method: "POST",
            headers,
            body: '{"decision":"approve"}',
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await fetch(`${r.origin}/api/requests/${id}/decision`, {
            method: "POST",
            headers: { ...headers, origin: r.origin },
            body: '{"decision":"approve"}',
          })
        ).status,
      ).toBe(401);
      expect(
        (
          await fetch(`${r.origin}/api/requests/${id}/decision`, {
            method: "POST",
            headers: { ...headers, cookie: r.cookie },
            body: '{"decision":"approve"}',
          })
        ).status,
      ).toBe(403);
      const actor = await resolveAgent(
        new Request(`${r.origin}/api/agent/requests`, { headers }),
        {
          GATE_DB: r.db,
          AUTH_SECRET: authSecret,
          GATE_AGENT_ISSUER: issuer,
        } as Bindings,
      );
      const now = Math.floor(Date.now() / 1000);
      for (const metadata of [
        {
          issuer: "wrong",
          audience: agentAudience,
          issued: now,
          expires: now + 300,
        },
        { issuer, audience: "wrong", issued: now, expires: now + 300 },
        {
          issuer,
          audience: agentAudience,
          issued: now + 60,
          expires: now + 300,
        },
        {
          issuer,
          audience: agentAudience,
          issued: now - 400,
          expires: now - 100,
        },
      ]) {
        const tokenId = crypto.randomUUID(),
          secret = randomSecret();
        await r.db
          .prepare(
            "INSERT INTO gate_agent_tokens VALUES(?,?,?,?,?,?,1,?,?,NULL)",
          )
          .bind(
            tokenId,
            r.credential.credentialId,
            r.agentId,
            await secretHash("token", tokenId, secret),
            metadata.issuer,
            metadata.audience,
            metadata.issued,
            metadata.expires,
          )
          .run();
        expect(
          (
            await fetch(`${r.origin}/api/agent/requests/${id}`, {
              headers: {
                authorization: `Bearer gat_${tokenId}.${secret}`,
              },
            })
          ).status,
        ).toBe(401);
      }
      await expect(
        getAgentRequest(r.db, { ...actor, tokenHash: "0".repeat(64) }, id),
      ).rejects.toMatchObject({ status: 401 });
      await setAgentAccess(r.db, r.agentId, "withdraw", false);
      await expect(withdrawAgentRequest(r.db, actor, id)).rejects.toMatchObject(
        { status: 403 },
      );
      await setAgentAccess(r.db, r.agentId, "withdraw", true);
      await r.db
        .prepare(
          "CREATE TRIGGER runtime_agent_fault BEFORE INSERT ON gate_request_events WHEN NEW.event_type='withdrawn' BEGIN SELECT RAISE(ABORT,'local audit fault'); END",
        )
        .run();
      expect(
        (
          await fetch(`${r.origin}/api/agent/requests/${id}/withdraw`, {
            method: "POST",
            headers,
            body: "{}",
          })
        ).status,
      ).toBe(500);
      expect((await getAgentRequest(r.db, actor, id)).status).toBe("pending");
      await r.db.prepare("DROP TRIGGER runtime_agent_fault").run();
      const responses = await Promise.all([
        fetch(`${r.origin}/api/agent/requests/${id}/withdraw`, {
          method: "POST",
          headers,
          body: "{}",
        }),
        fetch(`${r.origin}/api/requests/${id}/decision`, {
          method: "POST",
          headers: {
            cookie: r.cookie,
            origin: r.origin,
            "content-type": "application/json",
          },
          body: '{"decision":"approve"}',
        }),
      ]);
      expect(responses.map((response) => response.status).sort()).toEqual([
        200, 409,
      ]);
      const terminal = await getAgentRequest(r.db, actor, id);
      expect(terminal.events).toHaveLength(2);
      expect(
        await r.db
          .prepare(
            "SELECT count(*) AS n FROM gate_decisions WHERE request_id=?",
          )
          .bind(id)
          .first("n"),
      ).toBe(terminal.status === "approved" ? 1 : 0);
      await revokeAgentAuthentication(r.db, "token", actor.tokenId);
      await expect(
        createAgentRequest(r.db, actor, "after-revoked", input),
      ).rejects.toMatchObject({ status: 401 });
      expect(
        (await fetch(`${r.origin}/api/agent/requests/${id}`, { headers }))
          .status,
      ).toBe(401);
      await r.mf.dispose();
      const restarted = new Miniflare(r.options);
      try {
        const { GATE_DB: db } = await restarted.getBindings<{
          GATE_DB: D1Database;
        }>();
        expect(
          await db
            .prepare("SELECT status FROM gate_requests WHERE id=?")
            .bind(id)
            .first("status"),
        ).toBe(terminal.status);
        expect(
          await db
            .prepare(
              "SELECT count(*) AS n FROM gate_request_events WHERE request_id=?",
            )
            .bind(id)
            .first("n"),
        ).toBe(2);
      } finally {
        await restarted.dispose();
      }
    } finally {
      await r.mf.dispose();
      await rm(r.persist, { recursive: true, force: true });
    }
  }, 120000);

  it("runs the real caller subprocess; only online approved plus expected digest resumes, with no silent retries", async () => {
    const r = await runtime();
    let mode = "normal";
    const counts = new Map<string, number>();
    const proxy = createServer((request, response) => {
      void forward(request, response).catch(() => {
        if (!response.headersSent) response.writeHead(500);
        response.end();
      });
    });
    async function forward(request: IncomingMessage, response: ServerResponse) {
      const path = request.url ?? "/";
      counts.set(
        `${request.method} ${path}`,
        (counts.get(`${request.method} ${path}`) ?? 0) + 1,
      );
      const chunks: Uint8Array[] = [];
      for await (const chunk of request) {
        if (!(chunk instanceof Uint8Array))
          throw new Error("Unexpected local proxy body.");
        chunks.push(chunk);
      }
      const bodyBytes = new Uint8Array(
        chunks.reduce((size, chunk) => size + chunk.byteLength, 0),
      );
      let offset = 0;
      for (const chunk of chunks) {
        bodyBytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const result = await fetch(`${r.origin}${path}`, {
        method: request.method ?? "GET",
        headers: {
          "content-type": "application/json",
          ...(request.headers.authorization
            ? { authorization: request.headers.authorization }
            : {}),
          ...(request.headers["idempotency-key"]
            ? { "Idempotency-Key": String(request.headers["idempotency-key"]) }
            : {}),
        },
        ...(chunks.length ? { body: bodyBytes } : {}),
      });
      if (
        (mode === "drop-create" &&
          request.method === "POST" &&
          path === "/api/agent/requests") ||
        (mode === "drop-get" && request.method === "GET")
      ) {
        response.destroy();
        return;
      }
      const text = await result.text();
      let body: unknown = JSON.parse(text);
      if (path.endsWith("/token") && mode === "wrong-issuer")
        body = { ...(body as object), issuer: "wrong" };
      if (path.endsWith("/token") && mode === "wrong-audience")
        body = { ...(body as object), audience: "wrong" };
      if (request.method === "GET") {
        if (["500", "401"].includes(mode)) {
          response.writeHead(Number(mode));
          response.end("{}");
          return;
        }
        if (mode === "invalid-json") {
          response.writeHead(200, { "content-type": "application/json" });
          response.end("not JSON");
          return;
        }
        if (mode === "timeout") {
          const timer = setTimeout(() => {
            response.end("{}");
          }, 11000);
          response.once("close", () => {
            clearTimeout(timer);
          });
          return;
        }
        if (mode === "redirect") {
          response.writeHead(302, { location: `${r.origin}${path}` });
          response.end();
          return;
        }
        const envelope = body as { request: GateRequestRecord };
        const changes: Record<string, unknown> = {
          "wrong-digest": { payloadDigest: `sha256:${"0".repeat(64)}` },
          "wrong-id": { id: "other" },
          "wrong-requester": { requesterIdentityId: "lin" },
          "wrong-type": { requesterType: "human" },
          "wrong-template": { templateVersion: 2 },
          "wrong-schema": { payloadSchemaVersion: 2 },
          "wrong-payload": {
            payload: { ...input.payload, summary: "tampered" },
          },
          "invalid-decision": { decidedBy: null },
          pending: { status: "pending" },
          rejected: { status: "rejected" },
          withdrawn: { status: "withdrawn" },
        };
        body = {
          request: {
            ...envelope.request,
            ...(changes[mode] as object | undefined),
          },
        };
      }
      response.writeHead(result.status, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      response.end(JSON.stringify(body));
    }
    await new Promise<void>((resolveReady) =>
      proxy.listen(0, "127.0.0.1", resolveReady),
    );
    const address = proxy.address();
    if (!address || typeof address === "string")
      throw new Error("Missing local proxy port.");
    const caller = fileURLToPath(
      new URL("../../../examples/agent-caller.mjs", import.meta.url),
    );
    const credentialFile = resolve(r.persist, "credential.json"),
      inputFile = resolve(r.persist, "input.json");
    await writeFile(credentialFile, JSON.stringify(r.credential), {
      mode: 0o600,
      flag: "wx",
    });
    await writeFile(inputFile, JSON.stringify(input), { flag: "wx" });
    const configuration = {
      GATE_ORIGIN: `http://127.0.0.1:${address.port}`,
      GATE_ISSUER: issuer,
      GATE_IDEMPOTENCY_KEY: "caller-stable-key",
      GATE_EXPECTED_DIGEST: await calculatePayloadDigest(1, input.payload),
      GATE_INPUT_FILE: inputFile,
      GATE_CREDENTIAL_FILE: credentialFile,
    };
    async function run(overrides: NodeJS.ProcessEnv = {}) {
      counts.clear();
      const result = await child(caller, [], {
        ...configuration,
        ...overrides,
      });
      expect(result.stdout + result.stderr).not.toContain(
        r.credential.credentialSecret,
      );
      expect(result.stdout + result.stderr).not.toContain("gat_");
      for (const count of counts.values()) expect(count).toBe(1);
      return result;
    }
    try {
      expect((await run()).code).toBe(75);
      const id = await r.db
        .prepare("SELECT id FROM gate_requests WHERE idempotency_key=?")
        .bind(configuration.GATE_IDEMPOTENCY_KEY)
        .first<string>("id");
      if (!id) throw new Error("Caller did not create a request.");
      await r.decision(id, "approve");
      expect((await run()).code).toBe(0);
      expect(
        await r.db
          .prepare("SELECT count(*) AS n FROM gate_requests")
          .first("n"),
      ).toBe(1);
      for (mode of [
        "wrong-digest",
        "wrong-id",
        "wrong-requester",
        "wrong-type",
        "wrong-template",
        "wrong-schema",
        "wrong-payload",
        "invalid-json",
        "invalid-decision",
        "500",
        "401",
        "drop-get",
        "timeout",
        "redirect",
        "wrong-issuer",
        "wrong-audience",
      ]) {
        expect((await run()).code, mode).toBe(1);
      }
      for (mode of ["pending", "rejected", "withdrawn"])
        expect((await run()).code, mode).toBe(75);
      mode = "drop-create";
      expect((await run({ GATE_IDEMPOTENCY_KEY: "uncertain" })).code).toBe(1);
      expect(
        await r.db
          .prepare(
            "SELECT count(*) AS n FROM gate_requests WHERE idempotency_key='uncertain'",
          )
          .first("n"),
      ).toBe(1);
      mode = "normal";
      expect((await run({ GATE_IDEMPOTENCY_KEY: "uncertain" })).code).toBe(75);
      expect(
        await r.db
          .prepare(
            "SELECT count(*) AS n FROM gate_requests WHERE idempotency_key='uncertain'",
          )
          .first("n"),
      ).toBe(1);
      expect((await run({ GATE_EXPECTED_DIGEST: "wrong" })).code).toBe(1);
      expect(counts.size).toBe(0);
      expect(
        (await run({ GATE_ORIGIN: "http://not-loopback.example" })).code,
      ).toBe(1);
      expect(counts.size).toBe(0);
      await revokeAgentAuthentication(
        r.db,
        "credential",
        r.credential.credentialId,
      );
      expect((await run()).code).toBe(1);
      expect(counts.size).toBe(1);
    } finally {
      await new Promise<void>((resolveClose, reject) =>
        proxy.close((error) => {
          if (error) reject(error);
          else resolveClose();
        }),
      );
      await r.mf.dispose();
      await rm(r.persist, { recursive: true, force: true });
    }
  }, 120000);

  it("uses the local-only CLI against persistent D1, securely creates credentials and performs explicit revocation", async () => {
    const r = await runtime();
    const cli = fileURLToPath(
      new URL("../scripts/agent-local.mjs", import.meta.url),
    );
    const command = async (...args: string[]) =>
      child(cli, [...args, "--state", r.persist]);
    try {
      const registered = await command("register", "lin", "CLI caller");
      expect(registered.code, registered.stderr).toBe(0);
      const id = registered.stdout.trim();
      expect(id).toMatch(/^agent:[a-f0-9-]{36}$/);
      const output = resolve(r.persist, "cli-credential.json");
      const created = await command("credential", id, output);
      expect(created.code, created.stderr).toBe(0);
      const credential = JSON.parse(await readFile(output, "utf8")) as {
        credentialId: string;
        credentialSecret: string;
      };
      expect(created.stdout + created.stderr).not.toContain(
        credential.credentialSecret,
      );
      expect((await command("credential", id, output)).code).toBe(1);
      const grant = await command("grant", id, "create");
      expect(grant.code).toBe(0);
      expect(grant.stdout).toContain("permission updated.");
      const repeatGrant = await command("grant", id, "create");
      expect(repeatGrant.code).toBe(0);
      expect(repeatGrant.stdout).toContain("permission unchanged.");
      const accessCount = async () =>
        r.db
          .prepare(
            "SELECT count(*) AS n FROM gate_agent_template_access WHERE agent_id=? AND permission='create'",
          )
          .bind(id)
          .first("n");
      const auditCount = async () =>
        r.db
          .prepare(
            `SELECT count(*) AS n FROM gate_configuration_events
        WHERE entity_type='agent-access' AND entity_id=? AND json_extract(evidence_json,'$.permission')='create'`,
          )
          .bind(id)
          .first("n");
      expect(await accessCount()).toBe(1);
      expect(await auditCount()).toBe(1);
      expect((await command("grant", id, "decide")).code).toBe(1);
      const remove = await command("remove", id, "create");
      expect(remove.code).toBe(0);
      expect(remove.stdout).toContain("permission updated.");
      const repeatRemove = await command("remove", id, "create");
      expect(repeatRemove.code).toBe(0);
      expect(repeatRemove.stdout).toContain("permission unchanged.");
      expect(await accessCount()).toBe(0);
      expect(await auditCount()).toBe(2);
      for (const args of [
        ["inspect", "missing"],
        ["grant", "missing", "read"],
        ["remove", "missing", "read"],
      ]) {
        const missing = await command(...args);
        expect(missing.code).toBe(1);
        expect(missing.stdout).toBe("");
        expect(missing.stderr).toContain("(404)");
        expect(missing.stderr).not.toContain(credential.credentialSecret);
      }
      expect(
        await r.db
          .prepare(
            "SELECT count(*) AS n FROM gate_agent_template_access WHERE agent_id='missing'",
          )
          .first("n"),
      ).toBe(0);
      expect(
        await r.db
          .prepare(
            "SELECT count(*) AS n FROM gate_configuration_events WHERE entity_type='agent-access' AND entity_id='missing'",
          )
          .first("n"),
      ).toBe(0);
      const inserted = await r.db
        .prepare(
          "INSERT INTO gate_agent_template_access VALUES(?,'release-review',1,'withdraw',1)",
        )
        .bind(id)
        .run();
      expect(inserted.meta.changes).toBe(2);
      const removed = await r.db
        .prepare(
          "DELETE FROM gate_agent_template_access WHERE agent_id=? AND permission='withdraw'",
        )
        .bind(id)
        .run();
      expect(removed.meta.changes).toBe(2);
      const unchanged = await r.db
        .prepare(
          "DELETE FROM gate_agent_template_access WHERE agent_id=? AND permission='withdraw'",
        )
        .bind(id)
        .run();
      expect(unchanged.meta.changes).toBe(0);
      expect((await command("disable", id)).code).toBe(0);
      expect((await command("enable", id)).code).toBe(0);
      expect(
        (await command("revoke-credential", credential.credentialId)).code,
      ).toBe(0);
      expect((await command("inspect", id)).stdout).toContain(id);
      expect((await command("register", "missing", "Bad")).code).toBe(1);
      expect((await command("--remote")).code).toBe(1);
      expect(
        (await command("credential", id, resolve("must-not-exist.json"))).code,
      ).toBe(1);
    } finally {
      await r.mf.dispose();
      await rm(r.persist, { recursive: true, force: true });
    }
  }, 120000);
});
