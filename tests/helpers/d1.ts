/**
 * Shared test adapter: better-sqlite3 in-memory database exposing a minimal
 * D1-compatible API (prepare().bind().run()/all() + atomic batch).
 */
import type Database from "better-sqlite3";
import type { CreditsDB } from "../../src/server/credits";

export function makeD1Like(db: Database.Database): CreditsDB {
  return {
    prepare(sql: string) {
      const stmt = db.prepare(sql);
      const runWith = (params: unknown[]) => {
        const info = stmt.run(...(params as never[]));
        return { meta: { changes: info.changes } };
      };
      const allWith = <T,>(params: unknown[]) => {
        const rows = stmt.all(...(params as never[]));
        return { results: rows as T[] };
      };
      return {
        async run() {
          return runWith([]);
        },
        async all<T>() {
          return allWith<T>([]);
        },
        bind(...values: unknown[]) {
          const bound = [...values];
          return {
            async run() {
              return runWith(bound);
            },
            async all<T>() {
              return allWith<T>(bound);
            },
          };
        },
      };
    },
    async batch(statements) {
      // D1 batch semantics: one transaction, first failure aborts + rolls back.
      db.exec("BEGIN");
      try {
        const results: unknown[] = [];
        for (const s of statements) {
          results.push(await s.run());
        }
        db.exec("COMMIT");
        return results;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
}
