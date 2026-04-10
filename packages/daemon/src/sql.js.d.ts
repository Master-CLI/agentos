declare module 'sql.js' {
  interface SqlJsStatic {
    Database: new (data?: ArrayLike<number> | Buffer | null) => Database;
  }

  interface Database {
    run(sql: string, params?: unknown[]): Database;
    exec(sql: string): QueryExecResult[];
    prepare(sql: string): Statement;
    export(): Uint8Array;
    close(): void;
  }

  interface Statement {
    bind(params?: unknown[]): boolean;
    step(): boolean;
    getAsObject(params?: Record<string, unknown>): Record<string, unknown>;
    free(): boolean;
  }

  interface QueryExecResult {
    columns: string[];
    values: unknown[][];
  }

  export type { SqlJsStatic, Database, Statement, QueryExecResult };
  export default function initSqlJs(config?: Record<string, unknown>): Promise<SqlJsStatic>;
}
