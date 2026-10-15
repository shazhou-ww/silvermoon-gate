import { readFileSync } from "node:fs";

export function migrationStatements(sql: string): string[] {
  let remaining = sql.replace(/--[^\n]*/g, "").trim();
  const statements: string[] = [];
  while (remaining) {
    let end = remaining.indexOf(";");
    if (/^CREATE TRIGGER\b/i.test(remaining)) {
      let depth = 0;
      for (const token of remaining.matchAll(/\b(?:BEGIN|CASE|END)\b|;/gi)) {
        const keyword = token[0].toUpperCase();
        if (keyword === "BEGIN" || keyword === "CASE") depth++;
        else if (keyword === "END") depth--;
        else if (depth === 0) {
          end = token.index;
          break;
        }
      }
    }
    if (end < 0) throw new Error("Migration statement has no terminator.");
    statements.push(remaining.slice(0, end + 1));
    remaining = remaining.slice(end + 1).trim();
  }
  return statements;
}

export async function applyMigrations(db: D1Database) {
  for (const migration of ["0001_gate.sql", "0002_human_mvp.sql"]) {
    const sql = readFileSync(
      new URL(`../migrations/${migration}`, import.meta.url),
      "utf8",
    );
    for (const statement of migrationStatements(sql)) {
      await db.prepare(statement).run();
    }
  }
}
