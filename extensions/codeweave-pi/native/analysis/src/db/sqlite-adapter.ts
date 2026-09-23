// CodeGraph-derived structural query interfaces (see ../../LICENSE).
// G1 still supplies its connection. Intact maintenance uses the donor Node adapter below.
export interface SqliteStatement {
  run(...params: any[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: any[]): any;
  all(...params: any[]): any[];
  iterate(...params: any[]): IterableIterator<any>;
}

export interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
  pragma(str: string, options?: { simple?: boolean }): any;
  transaction<T>(fn: (...args: any[]) => T): (...args: any[]) => T;
  close(): void;
  readonly open: boolean;
}

export type SqliteBackend = 'node-sqlite';

/** Donor connection adapter; only the isolated maintenance process opens it. */
class NodeSqliteAdapter implements SqliteDatabase {
  private _db: any;
  private _txDepth = 0;

  constructor(dbPath: string, opts?: { readOnly?: boolean }) {
    const { DatabaseSync } = require('node:sqlite');
    this._db = opts?.readOnly ? new DatabaseSync(dbPath, { readOnly: true }) : new DatabaseSync(dbPath);
  }

  get open(): boolean { return this._db.isOpen; }

  prepare(sql: string): SqliteStatement {
    const stmt = this._db.prepare(sql);
    return {
      run(...params: any[]) {
        const result = stmt.run(...params);
        return { changes: Number(result?.changes ?? 0), lastInsertRowid: result?.lastInsertRowid ?? 0 };
      },
      get(...params: any[]) { return stmt.get(...params); },
      all(...params: any[]) { return stmt.all(...params); },
      iterate(...params: any[]) { return stmt.iterate(...params); },
    };
  }

  exec(sql: string): void { this._db.exec(sql); }

  pragma(str: string, options?: { simple?: boolean }): any {
    const trimmed = str.trim();
    if (trimmed.includes('=')) { this._db.exec(`PRAGMA ${trimmed}`); return; }
    const row = this._db.prepare(`PRAGMA ${trimmed}`).get();
    return options?.simple && row && typeof row === 'object' ? Object.values(row)[0] : row;
  }

  transaction<T>(fn: (...args: any[]) => T): (...args: any[]) => T {
    return (...args: any[]) => {
      if (this._txDepth > 0) {
        this._txDepth++;
        try { return fn(...args); } finally { this._txDepth--; }
      }
      this._db.exec('BEGIN');
      this._txDepth = 1;
      try {
        const result = fn(...args);
        this._db.exec('COMMIT');
        this._txDepth = 0;
        return result;
      } catch (error) {
        this._db.exec('ROLLBACK');
        this._txDepth = 0;
        throw error;
      }
    };
  }

  close(): void { if (this._db.isOpen) this._db.close(); }
}

export function createDatabase(dbPath: string, opts?: { readOnly?: boolean }): { db: SqliteDatabase; backend: SqliteBackend } {
  return { db: new NodeSqliteAdapter(dbPath, opts), backend: 'node-sqlite' };
}
