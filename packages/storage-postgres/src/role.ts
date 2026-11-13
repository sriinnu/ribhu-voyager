import { Pool } from "pg";

function ident(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error(`invalid Postgres identifier: ${value}`);
  }
  return `"${value}"`;
}

function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export type ProvisionedRole = {
  role: string;
  database: string;
};

/**
 * Create/update a least-privilege application role and grant it access to the
 * current database's public schema. Run with an admin connection once per DB.
 */
export async function provisionAppRole(
  adminConnectionString: string,
  role: string,
  password: string,
): Promise<ProvisionedRole> {
  const pool = new Pool({ connectionString: adminConnectionString, max: 1 });
  try {
    const databaseRow = await pool.query("SELECT current_database() AS name");
    const database = String(databaseRow.rows[0]?.name);
    const name = ident(role);
    const exists = await pool.query(
      "SELECT 1 FROM pg_roles WHERE rolname = $1",
      [role],
    );
    if ((exists.rowCount ?? 0) === 0) {
      await pool.query(
        `CREATE ROLE ${name} LOGIN PASSWORD ${literal(password)}
         NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
      );
    } else {
      await pool.query(
        `ALTER ROLE ${name} LOGIN PASSWORD ${literal(password)}
         NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
      );
    }
    await pool.query(
      `GRANT CONNECT ON DATABASE ${ident(database)} TO ${name}`,
    );
    await pool.query(`GRANT USAGE ON SCHEMA public TO ${name}`);
    await pool.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${name}`,
    );
    await pool.query(
      `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${name}`,
    );
    await pool.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public
       GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${name}`,
    );
    await pool.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public
       GRANT USAGE, SELECT ON SEQUENCES TO ${name}`,
    );
    return { role, database };
  } finally {
    await pool.end();
  }
}
