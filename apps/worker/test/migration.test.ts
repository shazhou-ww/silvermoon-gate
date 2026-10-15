import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SqliteD1Database } from "./sqlite-d1.js";
import {
  createRequest,
  getRequest,
  transitionRequest,
} from "../src/gate-store.js";
import { input, kai, lin, seed } from "./fixtures.js";

describe("Non-destructive MVP migration", () => {
  it("adds Agent registries without changing existing human identities, requests, decisions or audit", async () => {
    const db = new SqliteD1Database(false);
    try {
      await db.exec(
        readFileSync(
          new URL("../migrations/0002_human_mvp.sql", import.meta.url),
          "utf8",
        ),
      );
      await seed(db);
      await db.exec(`INSERT INTO gate_requests(id,idempotency_key,request_fingerprint,requester_identity_id,
       template_id,template_version,payload_schema_version,payload_json,payload_digest,status,created_at,decided_at,decided_by,terminal_operation_id)
       VALUES('old-human','old-key','old-fingerprint','lin','release-review',1,1,'{"original":true}',
        'old-digest','approved','2020-01-01','2020-01-02','kai','old-op');
       INSERT INTO gate_decisions VALUES('old-decision','old-human','old-op','kai','kai','approved',1,1,'{"kind":"direct"}','2020-01-02');
       INSERT INTO gate_request_events(request_id,event_type,actor_identity_id,occurred_at,operation_id)
       VALUES('old-human','created','lin','2020-01-01','old-created'),('old-human','approved','kai','2020-01-02','old-op');`);
      const tables = [
        "gate_requests",
        "gate_request_events",
        "gate_decisions",
        "gate_identities",
        "gate_sessions",
        "gate_template_access",
        "gate_configuration_events",
      ] as const;
      const snapshot = async () =>
        JSON.stringify(
          await Promise.all(
            tables.map(
              async (table) =>
                (
                  await db
                    .prepare(`SELECT * FROM ${table} ORDER BY rowid`)
                    .all()
                ).results,
            ),
          ),
        );
      const before = await snapshot();
      await db.exec(
        readFileSync(
          new URL("../migrations/0003_agent_mvp.sql", import.meta.url),
          "utf8",
        ),
      );
      expect(await snapshot()).toBe(before);
      expect((await getRequest(db, "old-human", kai)).requesterType).toBe(
        "human",
      );
      await db.exec(
        "INSERT INTO gate_agent_identities VALUES('agent:new','New','active',1,1,'lin')",
      );
      const { request } = await createRequest(db, lin, "post-migration", input);
      expect(
        (await transitionRequest(db, request.id, kai, "approve")).requesterType,
      ).toBe("human");
      await expect(
        db.exec(
          "INSERT INTO gate_agent_identities VALUES('lin','Collision','active',1,1,'lin')",
        ),
      ).rejects.toThrow("already attributed");
    } finally {
      db.close();
    }
  });
  it("preserves prototype IDs, payloads, digests, terminal state and audit without fabricating identity or Decision", async () => {
    const db = new SqliteD1Database(false);
    try {
      await db.exec(`
        INSERT INTO gate_templates VALUES ('legacy',1,'Original','Original',1,'old-provider-id','2020-01-01T00:00:00.000Z');
        INSERT INTO gate_requests
          (id,idempotency_key,request_fingerprint,requester_identity_id,template_id,template_version,
           payload_schema_version,payload_json,payload_digest,thread_id,status,created_at,decided_at,decided_by)
          VALUES('original-id','original-key','original-fingerprint','old-provider-id','legacy',1,1,
            '{"original":true}','original-digest','original-thread','approved',
            '2020-01-01T00:00:00.000Z','2020-01-02T00:00:00.000Z','original-approver');
        INSERT INTO gate_request_events(request_id,event_type,actor_identity_id,occurred_at)
          VALUES('original-id','created','old-provider-id','2020-01-01T00:00:00.000Z'),
            ('original-id','approved','original-approver','2020-01-02T00:00:00.000Z');
      `);
      const original = await db
        .prepare("SELECT * FROM gate_requests")
        .first<Record<string, unknown>>();
      const originalEvents = (
        await db
          .prepare("SELECT * FROM gate_request_events ORDER BY sequence")
          .all()
      ).results;
      await db.exec(
        readFileSync(
          new URL("../migrations/0002_human_mvp.sql", import.meta.url),
          "utf8",
        ),
      );
      expect(await db.prepare("SELECT * FROM gate_requests").first()).toEqual({
        ...original,
        terminal_operation_id: null,
      });
      expect(
        (
          await db
            .prepare("SELECT * FROM gate_request_events ORDER BY sequence")
            .all()
        ).results,
      ).toEqual(
        originalEvents.map((event) => ({ ...event, operation_id: null })),
      );
      expect(
        await db
          .prepare("SELECT COUNT(*) AS n FROM gate_identities")
          .first("n"),
      ).toBe(0);
      expect(
        await db.prepare("SELECT COUNT(*) AS n FROM gate_decisions").first("n"),
      ).toBe(0);
      await expect(
        db.exec(
          "UPDATE gate_requests SET terminal_operation_id='fake' WHERE id='original-id'",
        ),
      ).rejects.toThrow();
    } finally {
      db.close();
    }
  });
  it("preserves incompatible release-review v1 and refuses to enable it silently", async () => {
    const db = new SqliteD1Database(false);
    try {
      await db.exec(
        "INSERT INTO gate_templates VALUES('release-review',1,'legacy title',NULL,9,'original-admin','2020-01-01T00:00:00.000Z')",
      );
      await db.exec(
        readFileSync(
          new URL("../migrations/0002_human_mvp.sql", import.meta.url),
          "utf8",
        ),
      );
      expect(
        await db
          .prepare("SELECT title,payload_schema_version FROM gate_templates")
          .first(),
      ).toEqual({ title: "legacy title", payload_schema_version: 9 });
      expect(
        await db
          .prepare("SELECT enabled FROM gate_template_entry")
          .first("enabled"),
      ).toBe(0);
    } finally {
      db.close();
    }
  });
});
