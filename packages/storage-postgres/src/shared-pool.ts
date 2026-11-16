import { Pool } from "pg";

/**
 * One `pg.Pool` per connection string per process, reference-counted by the
 * tenant-scoped `PostgresStorage` instances that use it. Tenant RLS is applied
 * per transaction (`SET LOCAL app.tenant_id`), never through pool-level
 * connection options, so a single pool can safely serve every tenant.
 */
export type PoolLease = {
  readonly pool: Pool;
  readonly connectionString: string;
  /** Release this instance's reference; ends the pool when it reaches zero. */
  release(): Promise<void>;
  /** True while this lease holds a reference. */
  readonly active: boolean;
};

export type SharedPoolStats = {
  connectionString: string;
  refs: number;
  max: number;
  totalCount: number;
  idleCount: number;
  waitingCount: number;
};

type Entry = {
  pool: Pool;
  refs: number;
  max: number;
};

const pools = new Map<string, Entry>();
const leases = new WeakSet<PoolLease>();

function defaultMax(): number {
  const raw = Number(process.env.RIBBHU_POSTGRES_POOL_MAX);
  if (Number.isFinite(raw) && raw >= 1) return Math.trunc(raw);
  return 10;
}

/** Keying by URL: credentials never appear in logs/stats. */
function poolKey(connectionString: string): string {
  return connectionString;
}

export function acquirePool(
  connectionString: string,
  options: { max?: number } = {},
): PoolLease {
  const key = poolKey(connectionString);
  let entry = pools.get(key);
  if (!entry) {
    const pool = new Pool({
      connectionString,
      max: options.max ?? defaultMax(),
    });
    // An idle client error must not crash the process; surface it while the
    // owning storage operation fails on its own.
    pool.on("error", (error) => {
      console.warn(`  storage   Postgres pool error: ${error.message}`);
    });
    entry = { pool, refs: 0, max: options.max ?? defaultMax() };
    pools.set(key, entry);
  }
  entry.refs += 1;
  let released = false;
  const lease: PoolLease = {
    pool: entry.pool,
    connectionString,
    get active(): boolean {
      return !released;
    },
    async release(): Promise<void> {
      if (released) return;
      released = true;
      const current = pools.get(key);
      if (!current || current.pool !== entry.pool) {
        // The registry was force-closed; nothing to end here.
        if (!entry.pool.ended) {
          await entry.pool.end().catch(() => undefined);
        }
        return;
      }
      current.refs -= 1;
      if (current.refs <= 0) {
        pools.delete(key);
        await current.pool.end().catch(() => undefined);
      }
    },
  };
  leases.add(lease);
  return lease;
}

/** Introspection for tests/health: one row per shared pool. */
export function sharedPoolStats(): SharedPoolStats[] {
  return [...pools.entries()].map(([connectionString, entry]) => ({
    connectionString,
    refs: entry.refs,
    max: entry.max,
    totalCount: entry.pool.totalCount,
    idleCount: entry.pool.idleCount,
    waitingCount: entry.pool.waitingCount,
  }));
}

/** Number of live shared pools (0 after the last tenant storage closes). */
export function sharedPoolCount(): number {
  return pools.size;
}

/** Force-close every shared pool (process shutdown / test teardown). */
export async function closeSharedPools(): Promise<void> {
  const entries = [...pools.values()];
  pools.clear();
  await Promise.allSettled(entries.map((entry) => entry.pool.end()));
}

/** True when this object is a lease handed out by `acquirePool`. */
export function isPoolLease(value: unknown): value is PoolLease {
  return typeof value === "object" && value !== null && leases.has(value as PoolLease);
}
