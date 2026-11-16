import { Db } from "@ribhu-voyager/storage-sqlite";

import { PostgresStorage } from "./storage.js";

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function usage(): never {
  console.error(`usage:
  retention --days N [--apply] [--dry-run] --url <postgres-url> [--tenant <id>]
  retention --days N [--apply] [--dry-run] --sqlite <path>

Deletes ONLY usage_events and audit_events older than N days (never journal
entries or conversations). Dry-run is the default; pass --apply to delete.
Postgres mode covers every tenant unless --tenant is given.
Set RIBBHU_POSTGRES_URL / RIBBHU_SQLITE_PATH instead of --url / --sqlite.`);
  process.exit(2);
}

const args = process.argv.slice(2);
const daysRaw = flag(args, "--days");
if (daysRaw === undefined) usage();
const days = Number(daysRaw);
if (!Number.isInteger(days) || days <= 0) {
  console.error("--days must be a positive integer");
  process.exit(2);
}
const apply = args.includes("--apply");
const dryRun = !apply;
const cutoff = Date.now() - days * 86_400_000;
const mode = `mode=${dryRun ? "dry-run" : "apply"} days=${days} cutoff=${new Date(cutoff).toISOString()}`;

const sqlitePath = flag(args, "--sqlite") ?? process.env.RIBBHU_SQLITE_PATH?.trim();
const postgresUrl =
  flag(args, "--url") ?? process.env.RIBBHU_POSTGRES_URL?.trim();
const tenantFilter = flag(args, "--tenant");
if (Boolean(sqlitePath) === Boolean(postgresUrl)) usage();

try {
  if (sqlitePath) {
    const db = new Db(sqlitePath);
    try {
      const usage = db.deleteOldUsage(cutoff, { dryRun });
      const audit = db.deleteOldAudit(cutoff, { dryRun });
      console.log(`retention ${mode} target=sqlite:${sqlitePath}`);
      console.log(`retention tenant=default usage_events=${usage} audit_events=${audit}`);
      console.log(`retention total usage_events=${usage} audit_events=${audit}`);
    } finally {
      db.close();
    }
  } else {
    const url = postgresUrl!;
    const probe = new PostgresStorage(url, "default");
    let tenants: string[];
    try {
      await probe.init();
      tenants = await probe.listTenants();
    } finally {
      await probe.close().catch(() => undefined);
    }
    if (tenantFilter !== undefined) {
      if (!tenants.includes(tenantFilter)) {
        throw new Error(`unknown tenant "${tenantFilter}"`);
      }
      tenants = [tenantFilter];
    }

    console.log(`retention ${mode} target=postgres tenants=${tenants.length}`);
    let totalUsage = 0;
    let totalAudit = 0;
    for (const tenant of tenants) {
      const storage = new PostgresStorage(url, tenant);
      try {
        await storage.init();
        const usage = await storage.deleteOldUsage(cutoff, { dryRun });
        const audit = await storage.deleteOldAudit(cutoff, { dryRun });
        totalUsage += usage;
        totalAudit += audit;
        console.log(
          `retention tenant=${tenant} usage_events=${usage} audit_events=${audit}`,
        );
      } finally {
        await storage.close().catch(() => undefined);
      }
    }
    console.log(
      `retention total usage_events=${totalUsage} audit_events=${totalAudit}`,
    );
  }
} catch (error) {
  console.error(
    `retention failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}
