import type { SqliteD1Database } from "./sqlite-d1.js";
import type { Bindings } from "../src/env.js";
export const lin = { identityId: "lin", sessionId: "session-lin" };
export const kai = { identityId: "kai", sessionId: "session-kai" };
export const other = { identityId: "other", sessionId: "session-other" };
export const input = {
  templateId: "release-review",
  templateVersion: 1,
  payloadSchemaVersion: 1,
  payload: {
    action: "release",
    candidate: "build 1",
    artifactDigest: `sha256:${"a".repeat(64)}`,
    environment: "test",
    summary: "Review this build.",
  },
};
export async function seed(db: SqliteD1Database) {
  await db.exec(`
    INSERT INTO gate_identities VALUES('lin','101','Lin','active',1,1),('kai','102','Kai','active',1,1),('other','103','Other','active',1,1);
    INSERT INTO gate_sessions VALUES('session-lin','lin',1,'2099-01-01T00:00:00.000Z',NULL),
      ('session-kai','kai',1,'2099-01-01T00:00:00.000Z',NULL),('session-other','other',1,'2099-01-01T00:00:00.000Z',NULL);
    INSERT INTO gate_template_access VALUES('lin','release-review',1,'create',1),('kai','release-review',1,'decide',1);
  `);
}
export function bindings(db: SqliteD1Database): Bindings {
  return {
    APP_NAME: "Silvermoon Gate",
    GATE_DB: db,
    AUTH_SECRET: "long-test-auth-secret-that-is-not-a-production-secret",
    ASSETS: {
      fetch: () => Promise.resolve(new Response()),
      connect: () => {
        throw new Error("No sockets.");
      },
    },
  };
}
