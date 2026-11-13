import { createHash, randomBytes } from "node:crypto";

import { Pool } from "pg";

const pools = new Map<string, Pool>();
const cache = new Map<string, { tenant?: string; expiresAt: number }>();

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function poolFor(connectionString: string): Pool {
  let pool = pools.get(connectionString);
  if (!pool) {
    pool = new Pool({
      connectionString,
      max: 2,
      connectionTimeoutMillis: 2_000,
      idleTimeoutMillis: 10_000,
    });
    pools.set(connectionString, pool);
  }
  return pool;
}

export type TokenRecord = {
  id: number;
  tenantId: string;
  label: string;
  createdAt: number;
  expiresAt: number | null;
  revokedAt: number | null;
};

/** Issue a tenant-scoped API token. Only the hash is stored. */
export async function issueApiToken(
  connectionString: string,
  tenantId: string,
  label: string,
  options: { expiresInDays?: number; now?: number } = {},
): Promise<string> {
  const now = options.now ?? Date.now();
  const expiresAt =
    options.expiresInDays && options.expiresInDays > 0
      ? now + Math.floor(options.expiresInDays * 86_400_000)
      : null;
  const pool = poolFor(connectionString);
  const token = `ribhu_${randomBytes(24).toString("hex")}`;
  await pool.query(
    `INSERT INTO api_tokens(token_hash, tenant_id, label, created_at, expires_at)
     VALUES($1, $2, $3, $4, $5)`,
    [hashToken(token), tenantId, label, now, expiresAt],
  );
  return token;
}

export async function resolveApiToken(
  connectionString: string,
  token: string,
): Promise<string | undefined> {
  const tokenHash = hashToken(token);
  const cached = cache.get(tokenHash);
  if (cached && cached.expiresAt > Date.now()) return cached.tenant;
  const pool = poolFor(connectionString);
  const result = await pool.query(
    `SELECT tenant_id FROM api_tokens
     WHERE token_hash = $1 AND revoked_at IS NULL
       AND (expires_at IS NULL OR expires_at > $2)`,
    [tokenHash, Date.now()],
  );
  const tenant = result.rows[0]?.tenant_id as string | undefined;
  cache.set(tokenHash, { tenant, expiresAt: Date.now() + 5_000 });
  return tenant;
}

export async function listApiTokens(
  connectionString: string,
  tenantId?: string,
): Promise<TokenRecord[]> {
  const pool = poolFor(connectionString);
  const result = await pool.query(
    `SELECT id, tenant_id, label, created_at, expires_at, revoked_at
     FROM api_tokens
     WHERE ($1::text IS NULL OR tenant_id = $1)
     ORDER BY id DESC`,
    [tenantId ?? null],
  );
  return result.rows.map((row) => ({
    id: Number(row.id),
    tenantId: String(row.tenant_id),
    label: String(row.label),
    createdAt: Number(row.created_at),
    expiresAt: row.expires_at === null ? null : Number(row.expires_at),
    revokedAt: row.revoked_at === null ? null : Number(row.revoked_at),
  }));
}

export async function revokeApiToken(
  connectionString: string,
  token: string,
): Promise<void> {
  const pool = poolFor(connectionString);
  const hash = hashToken(token);
  await pool.query(
    "UPDATE api_tokens SET revoked_at = $1 WHERE token_hash = $2",
    [Date.now(), hash],
  );
  cache.delete(hash);
}

export async function revokeApiTokenById(
  connectionString: string,
  id: number,
): Promise<boolean> {
  const pool = poolFor(connectionString);
  const result = await pool.query(
    "UPDATE api_tokens SET revoked_at = $1 WHERE id = $2 AND revoked_at IS NULL",
    [Date.now(), id],
  );
  cache.clear();
  return (result.rowCount ?? 0) > 0;
}

/** Close cached token-resolver pools (tests/shutdown). */
export async function closeApiTokenPools(): Promise<void> {
  const open = [...pools.values()];
  pools.clear();
  cache.clear();
  await Promise.all(open.map((pool) => pool.end().catch(() => undefined)));
}
