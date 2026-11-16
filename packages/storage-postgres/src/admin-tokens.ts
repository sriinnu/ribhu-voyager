import { createHash, randomBytes } from "node:crypto";

import { Pool } from "pg";

const pools = new Map<string, Pool>();

/** SHA-256 hex digest used to store admin tokens (plaintext is never persisted). */
export function hashAdminToken(token: string): string {
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

export async function closeAdminTokenPools(): Promise<void> {
  const open = [...pools.values()];
  pools.clear();
  await Promise.allSettled(open.map((pool) => pool.end()));
}

export type AdminTokenRecord = {
  id: number;
  label: string;
  createdAt: number;
  expiresAt: number | null;
  revokedAt: number | null;
  lastUsedAt: number | null;
};

/** Issue a deployment-global admin token. Only the hash is stored; printed once. */
export async function issueAdminToken(
  connectionString: string,
  label: string,
  options: { expiresInDays?: number; now?: number } = {},
): Promise<string> {
  const now = options.now ?? Date.now();
  const normalizedLabel = label.trim() === "" ? "admin" : label.trim().slice(0, 100);
  const expiresAt =
    options.expiresInDays && options.expiresInDays > 0
      ? now + Math.floor(options.expiresInDays * 86_400_000)
      : null;
  const token = `ribhu_admin_${randomBytes(24).toString("hex")}`;
  const pool = poolFor(connectionString);
  await pool.query(
    `INSERT INTO admin_tokens(label, token_hash, created_at, expires_at)
     VALUES($1, $2, $3, $4)`,
    [normalizedLabel, hashAdminToken(token), now, expiresAt],
  );
  return token;
}

/** List admin tokens without hashes (never expose token_hash). */
export async function listAdminTokens(
  connectionString: string,
): Promise<AdminTokenRecord[]> {
  const pool = poolFor(connectionString);
  const result = await pool.query(
    `SELECT id, label, created_at, expires_at, revoked_at, last_used_at
     FROM admin_tokens ORDER BY id`,
  );
  return result.rows.map((row) => ({
    id: Number(row.id),
    label: String(row.label),
    createdAt: Number(row.created_at),
    expiresAt: row.expires_at === null ? null : Number(row.expires_at),
    revokedAt: row.revoked_at === null ? null : Number(row.revoked_at),
    lastUsedAt: row.last_used_at === null ? null : Number(row.last_used_at),
  }));
}

export async function revokeAdminTokenById(
  connectionString: string,
  id: number,
  now = Date.now(),
): Promise<boolean> {
  const pool = poolFor(connectionString);
  const result = await pool.query(
    `UPDATE admin_tokens SET revoked_at = $1
     WHERE id = $2 AND revoked_at IS NULL`,
    [now, id],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function revokeAdminToken(
  connectionString: string,
  token: string,
  now = Date.now(),
): Promise<boolean> {
  const pool = poolFor(connectionString);
  const result = await pool.query(
    `UPDATE admin_tokens SET revoked_at = $1
     WHERE token_hash = $2 AND revoked_at IS NULL`,
    [now, hashAdminToken(token)],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Resolve a presented bearer token to its admin token row. Returns `undefined`
 * for unknown/expired/revoked tokens. Successful use updates `last_used_at`.
 */
export async function resolveAdminToken(
  connectionString: string,
  token: string,
  now = Date.now(),
): Promise<{ id: number; label: string } | undefined> {
  const pool = poolFor(connectionString);
  const result = await pool.query(
    `SELECT id, label FROM admin_tokens
     WHERE token_hash = $1 AND revoked_at IS NULL
       AND (expires_at IS NULL OR expires_at > $2)`,
    [hashAdminToken(token), now],
  );
  const row = result.rows[0] as { id?: unknown; label?: unknown } | undefined;
  if (row === undefined) return undefined;
  const id = Number(row.id);
  await pool
    .query(`UPDATE admin_tokens SET last_used_at = $1 WHERE id = $2`, [now, id])
    .catch(() => undefined);
  return { id, label: String(row.label) };
}
