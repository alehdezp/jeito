import type Database from "better-sqlite3";

/** The pinned donor QueryBuilder's SQLite boundary, on one owned connection.
 * Opening/admission and schema migration belong to the updater, not this adapter.
 * Unlike the donor's synchronous transaction helper, publish awaits all passes.
 * Use the package-pinned SQLite, not the older SQLite bundled with Node 22.19.
 */
export class AnalysisDatabase {
  readonly #database: Database.Database;
  #transactionDepth = 0;
  #publishing = false;
  #transactionFailure: Error | undefined;

  constructor(database: Database.Database) {
    this.#database = database;
  }

  get open(): boolean { return this.#database.open; }

  prepare(sql: string) {
    return this.#database.prepare(sql);
  }

  exec(sql: string): void { this.#database.exec(sql); }

  pragma(value: string, options?: { simple?: boolean }): unknown {
    return this.#database.pragma(value, options);
  }

  /** Donor bulk helpers are synchronous and flatten into the publication.
   * This deliberately is NOT the entry point for asynchronous analysis.
   */
  transaction<T>(operation: (...args: any[]) => T): (...args: any[]) => T {
    return (...args: any[]): T => {
      const ownsTransaction = this.#transactionDepth === 0;
      if (ownsTransaction) {
        this.#database.exec("BEGIN IMMEDIATE");
        this.#transactionFailure = undefined;
      }
      this.#transactionDepth++;
      try {
        const result = operation(...args);
        if (result != null && typeof (result as any).then === "function") {
          // Prevent an ignored promise rejection; never mistake it for completed work.
          void Promise.resolve(result).catch(() => undefined);
          this.#transactionFailure = new TypeError("Async analysis must use publish(), not transaction()");
          // An async continuation must not write after rollback or into a later job.
          this.#database.close();
          throw this.#transactionFailure;
        }
        if (ownsTransaction) {
          if (this.#transactionFailure) throw this.#transactionFailure;
          this.#database.exec("COMMIT");
        }
        return result;
      } catch (error) {
        // Flattening must not let a caller catch a failed bulk helper and
        // accidentally publish its partial writes as a complete analysis.
        if (this.#database.open) {
          this.#transactionFailure ??= error instanceof Error ? error : new Error("Analysis helper failed", { cause: error });
        }
        if (ownsTransaction) this.#rollback(error);
        throw error;
      } finally {
        this.#transactionDepth--;
      }
    };
  }

  /** Intermediate facts are visible to later passes on this connection only.
   * validate must reject source/policy/base drift and incomplete required passes.
   * The child supervisor supplies hard termination; abort here is cooperative.
   */
  async publish<T>(operation: () => Promise<T>, validate: () => void | Promise<void>, signal: AbortSignal): Promise<T> {
    signal.throwIfAborted();
    if (this.#publishing || this.#transactionDepth !== 0) {
      throw new Error("Analysis publication already owns this connection");
    }
    this.#database.exec("BEGIN IMMEDIATE");
    this.#publishing = true;
    this.#transactionDepth = 1;
    this.#transactionFailure = undefined;
    try {
      const result = await operation();
      signal.throwIfAborted();
      await validate();
      signal.throwIfAborted();
      if (this.#transactionFailure) throw this.#transactionFailure;
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      this.#rollback(error);
      throw error;
    } finally {
      this.#transactionDepth = 0;
      this.#publishing = false;
    }
  }

  close(): void {
    if (this.#publishing || this.#transactionDepth !== 0) throw new Error("Cannot close an active analysis transaction");
    if (this.#database.open) this.#database.close();
  }

  #rollback(cause: unknown): void {
    if (cause === this.#transactionFailure && !this.#database.open) return;
    try { this.#database.exec("ROLLBACK"); }
    catch (error) {
      // A failed rollback is not a successful last-good recovery.
      throw new AggregateError([cause, error], "Analysis failed and SQLite rollback also failed");
    }
  }
}
