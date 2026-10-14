import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

export class SqliteD1Database implements D1Database {
  private readonly database = new DatabaseSync(":memory:");

  constructor() {
    this.database.exec(
      readFileSync(
        new URL("../migrations/0001_gate.sql", import.meta.url),
        "utf8",
      ),
    );
  }

  prepare(query: string): D1PreparedStatement {
    return new SqliteD1PreparedStatement(this.database, query);
  }

  batch<T = unknown>(
    statements: D1PreparedStatement[],
  ): Promise<D1Result<T>[]> {
    this.database.exec("BEGIN");
    try {
      const results = statements.map((statement) => {
        if (!(statement instanceof SqliteD1PreparedStatement)) {
          throw new TypeError(
            "SQLite D1 test adapter received an unknown statement.",
          );
        }
        return statement.execute<T>();
      });
      this.database.exec("COMMIT");
      return Promise.resolve(results);
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  exec(query: string): Promise<D1ExecResult> {
    try {
      this.database.exec(query);
      return Promise.resolve({ count: 0, duration: 0 });
    } catch (error) {
      return Promise.reject(
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }

  withSession(): D1DatabaseSession {
    throw new Error(
      "D1 sessions are not implemented by the SQLite test adapter.",
    );
  }

  dump(): Promise<ArrayBuffer> {
    return Promise.reject(
      new Error("D1 dump is not implemented by the SQLite test adapter."),
    );
  }

  close(): void {
    this.database.close();
  }
}

class SqliteD1PreparedStatement implements D1PreparedStatement {
  private values: unknown[] = [];

  constructor(
    private readonly database: DatabaseSync,
    private readonly query: string,
  ) {}

  bind(...values: unknown[]): D1PreparedStatement {
    this.values = values;
    return this;
  }

  first<T = Record<string, unknown>>(colName?: string): Promise<T | null> {
    const row = this.database
      .prepare(this.query)
      .get(...toSqlInputValues(this.values));
    if (!row) {
      return Promise.resolve(null);
    }
    return Promise.resolve((colName ? row[colName] : row) as T);
  }

  run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return Promise.resolve(this.execute<T>());
  }

  all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    const rows = this.database
      .prepare(this.query)
      .all(...toSqlInputValues(this.values));
    return Promise.resolve({
      success: true,
      results: rows as T[],
      meta: createMeta(0, rows.length),
    });
  }

  raw<T = unknown[]>(_options?: { readonly columnNames?: false }): Promise<T[]>;
  raw<T = unknown[]>(_options: {
    readonly columnNames: true;
  }): Promise<[string[], ...T[]]>;
  raw<T = unknown[]>(options?: {
    readonly columnNames?: boolean;
  }): Promise<T[] | [string[], ...T[]]> {
    void options;
    const rows = this.database
      .prepare(this.query)
      .all(...toSqlInputValues(this.values));
    return Promise.resolve(rows.map((row) => Object.values(row)) as T[]);
  }

  execute<T>(): D1Result<T> {
    const result = this.database
      .prepare(this.query)
      .run(...toSqlInputValues(this.values));
    return {
      success: true,
      results: [],
      meta: createMeta(Number(result.changes), Number(result.lastInsertRowid)),
    };
  }
}

function toSqlInputValues(
  values: readonly unknown[],
): (null | string | number | bigint | Uint8Array)[] {
  return values.map((value) => {
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "bigint" ||
      value instanceof Uint8Array
    ) {
      return value;
    }
    throw new TypeError(
      "SQLite D1 test adapter received an unsupported binding.",
    );
  });
}

function createMeta(
  changes: number,
  lastRowId: number,
): D1Meta & Record<string, unknown> {
  return Object.assign(Object.fromEntries([]), {
    duration: 0,
    size_after: 0,
    rows_read: 0,
    rows_written: changes,
    last_row_id: lastRowId,
    changed_db: changes > 0,
    changes,
  });
}
