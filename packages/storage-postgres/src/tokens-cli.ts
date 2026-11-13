import {
  closeApiTokenPools,
  issueApiToken,
  listApiTokens,
  revokeApiToken,
  revokeApiTokenById,
} from "./tokens.js";

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function usage(): never {
  console.error(`usage:
  tokens issue --tenant <id> --label <name> [--days N] [--url <postgres-url>]
  tokens list [--tenant <id>] [--url <postgres-url>]
  tokens revoke --id <id> [--url <postgres-url>]
  tokens revoke --token <plaintext-token> [--url <postgres-url>]

Set RIBBHU_POSTGRES_URL instead of --url.`);
  process.exit(2);
}

const [command, ...args] = process.argv.slice(2);
const url = flag(args, "--url") ?? process.env.RIBBHU_POSTGRES_URL;
if (!url) usage();

try {
  if (command === "issue") {
    const tenant = flag(args, "--tenant") ?? "default";
    const label = flag(args, "--label") ?? "manual";
    const days = Number(flag(args, "--days") ?? "0");
    const token = await issueApiToken(url, tenant, label, {
      ...(days > 0 ? { expiresInDays: days } : {}),
    });
    console.log(token);
    console.error(
      `issued tenant=${tenant} label=${label}${days > 0 ? ` expires_in_days=${days}` : ""}`,
    );
  } else if (command === "list") {
    const tenant = flag(args, "--tenant");
    const rows = await listApiTokens(url, tenant);
    console.log(
      JSON.stringify(
        rows.map((row) => ({
          ...row,
          createdAt: new Date(row.createdAt).toISOString(),
          expiresAt: row.expiresAt ? new Date(row.expiresAt).toISOString() : null,
          revokedAt: row.revokedAt ? new Date(row.revokedAt).toISOString() : null,
        })),
        null,
        2,
      ),
    );
  } else if (command === "revoke") {
    const id = flag(args, "--id");
    const token = flag(args, "--token");
    if (id) {
      const revoked = await revokeApiTokenById(url, Number(id));
      console.log(revoked ? `revoked id=${id}` : `no active token id=${id}`);
    } else if (token) {
      await revokeApiToken(url, token);
      console.log("revoked");
    } else {
      usage();
    }
  } else {
    usage();
  }
} finally {
  await closeApiTokenPools();
}
