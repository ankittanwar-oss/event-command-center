// Minimal type declarations for the parts of node-postgres ("pg") this app uses.
// Kept in-repo so the project type-checks without @types/pg.
declare module "pg" {
  export interface QueryResult<R = any> { rows: R[]; rowCount: number | null }
  export interface PoolClient {
    query<R = any>(text: string, values?: unknown[]): Promise<QueryResult<R>>;
    release(err?: Error | boolean): void;
    on(event: "error", listener: (err: Error) => void): this;
  }
  export interface PoolConfig {
    connectionString?: string;
    max?: number;
    ssl?: boolean | { rejectUnauthorized?: boolean };
    idleTimeoutMillis?: number;
    connectionTimeoutMillis?: number;
  }
  export class Pool {
    constructor(config?: PoolConfig);
    query<R = any>(text: string, values?: unknown[]): Promise<QueryResult<R>>;
    connect(): Promise<PoolClient>;
    end(): Promise<void>;
    on(event: "error", listener: (err: Error) => void): this;
    on(event: "connect", listener: (client: PoolClient) => void): this;
  }
  const pg: { Pool: typeof Pool };
  export default pg;
}
