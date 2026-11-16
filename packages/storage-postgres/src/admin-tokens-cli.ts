import {
  closeAdminTokenPools,
  issueAdminToken,
  listAdminTokens,
  revokeAdminToken,
  revokeAdminTokenById,
} from "./admin-tokens.js";

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function usage(): never {
  console.error(`usage:
  admin-tokens issue --label <name> [--days N] [--url <postgres-url>]
  admin-tokens list [--url <postgres-url>]
  admin-tokens revoke --id <id> [--url <postgres-url>]
  admin-tokens revoke --token <plaintext-token> [--url <postgres-url>]

Admin tokens are deployment-global (not tenant-scoped). The plaintext token is
printed exactly once; only its SHA-256 hash is stored.
Set RIBBHU_POSTGRES_URL instead of --url.`);
  process.exit(2);
}

const [command, ...args] = process.argv.slice(2);
const url = flag(args, "--url") ?? process.env.RIBBHU_POSTGRES_URL;
if (!url) usage();

try {
  if (command === "issue") {
    const label = flag(args, "--label") ?? "admin";
    const days = Number(flag(args, "--days") ?? "0");
    if (!Number.isInteger(days) || days < 0) {
      console.error("--days must be a non-negative integer");
      process.exit(2);
    }
    const token = await issueAdminToken(url, label, {
      ...(days > 0 ? { expiresInDays: days } : {}),
    });
    console.log(token);
    console.error(
      `issued admin token label=${label}${days > 0 ? ` expires_in_days=${days}` : ""}`,
    );
  } else if (command === "list") {
    const rows = await listAdminTokens(url);
    console.log(
      JSON.stringify(
        rows.map((row) => ({
          id: row.id,
          label: row.label,
          createdAt: new Date(row.createdAt).toISOString(),
          expiresAt: row.expiresAt ? new Date(row.expiresAt).toISOString() : null,
          revokedAt: row.revokedAt ? new Date(row.revokedAt).toISOString() : null,
          lastUsedAt: row.lastUsedAt ? new Date(row.lastUsedAt).toISOString() : null,
        })),
        null,
        2,
      ),
    );
  } else if (command === "revoke") {
    const id = flag(args, "--id");
    const token = flag(args, "--token");
    if (id !== undefined) {
      const parsed = Number(id);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        console.error("--id must be a positive integer");
        process.exit(2);
      }
      const revoked = await revokeAdminTokenById(url, parsed);
      console.log(revoked ? `revoked id=${parsed}` : `no active admin token id=${parsed}`);
    } else if (token) {
      const revoked = await revokeAdminToken(url, token);
      console.log(revoked ? "revoked" : "no active admin token with that value");
    } else {
      usage();
    }
  } else {
    usage();
  }
} finally {
  await closeAdminTokenPools();
}
