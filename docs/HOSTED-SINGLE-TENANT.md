# Hosted Single-Tenant Beta

This is the shortest safe path to a hosted Ribhu Voyager: one tenant, one API/worker pair, a
least-privilege Postgres role, tenant API tokens, and TLS in front. It is **not** a multi-tenant SaaS
control plane; run one deployment per tenant.

## 1. Provision Postgres

Create the database and an admin URL, then provision the app role:

```bash
export ADMIN_URL='postgres://postgres:...@db.example.com/ribhu'

npm run provision:postgres -- \
  --url "$ADMIN_URL" \
  --role ribhu_app
```

If `--password` is omitted, the command generates one and prints it **once**. The role is
`NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE` and receives DML on the public schema. Save the
password in your secret manager.

```bash
export APP_URL='postgres://ribhu_app:<password>@db.example.com/ribhu'
export RIBBHU_STRICT_RLS=1
```

`RIBBHU_STRICT_RLS=1` makes startup fail if the role can bypass RLS. Without it, startup warns but
continues — never run a hosted instance without it.

## 2. Migrate an existing SQLite journal

Use the **admin** URL for schema creation/migration:

```bash
npm run migrate:postgres -- .ribhu-data/ribhu.sqlite "$ADMIN_URL"
```

The migration is non-destructive by default and runs in one transaction. `--force` truncates every
tenant table and is only for a verified empty target.

Jobs are not copied; the worker redispatches open submissions on boot. The migration currently lands
data in the `default` tenant. Run it into a fresh database for a single-tenant beta.

After deploying a new build, run schema migrations explicitly with admin credentials:

```bash
RIBBHU_MIGRATE_ONLY=1 RIBBHU_POSTGRES_URL="$ADMIN_URL" npm run start:api
```

Normal API/worker startup never runs DDL; it verifies the schema version and fails with a clear
message if the database is behind.

## 3. Issue a tenant token

Use the **admin** URL for token management:

```bash
export RIBBHU_POSTGRES_URL="$ADMIN_URL"

npm run tokens:postgres -- issue \
  --tenant default \
  --label phone \
  --days 30
```

The plaintext token is printed once; only its SHA-256 hash is stored. Keep it in the phone's secure
storage or password manager.

List and revoke:

```bash
npm run tokens:postgres -- list --tenant default
npm run tokens:postgres -- revoke --id 3
```

Revocation takes effect within the resolver cache window (5 seconds). Expired tokens are rejected.

## 4. Start the API and worker

```bash
RIBBHU_STORAGE=postgres \
RIBBHU_POSTGRES_URL="$APP_URL" \
RIBBHU_TENANT=default \
RIBBHU_STRICT_RLS=1 \
RIBBHU_SANDBOX=docker \
RIBBHU_APPROVALS=deny-bash \
HOST=127.0.0.1 \
PORT=8787 \
npm start
```

- The shared `RIBBHU_TOKEN` is ignored when Postgres token checking is active; use the issued token.
- Keep `HOST=127.0.0.1` and put TLS in front. Do not expose cleartext `0.0.0.0`.
- `RIBBHU_SANDBOX=docker` and a restrictive approval policy are strongly recommended for hosted use.
- The API process can serve multiple tenants (see [MULTI-TENANT.md](MULTI-TENANT.md)); run one worker
  per tenant. There is no worker autoscaler or shared worker pool.

## 5. TLS reverse proxy

Caddy example:

```caddy
ribhu.example.com {
  reverse_proxy 127.0.0.1:8787
}
```

Or nginx with `proxy_set_header Upgrade $http_upgrade;` and `Connection "upgrade"` for `/ws`. The app
serves both HTTP and WebSocket on the same port.

The phone connects to `https://ribhu.example.com/?token=<tenant-token>`; the PWA stores the token in
the browser. WebSocket upgrades use the same origin.

## 6. Health

- `GET /api/health` is **minimal** for unauthenticated callers: `ok`, protocol, uptime.
- Send the token as `Authorization: Bearer …` or `?token=…` for worker, queue, auth, and job detail.
- Use the minimal probe for load balancers; use the authenticated payload for dashboards.

## 7. Backups and operations

- Enable Postgres automated backups and point-in-time recovery before the first user.
- Test a restore into a separate database; `migrate:postgres` is not a backup tool.
- Apply migrations during a maintenance window; `SEARCH`/schema changes are not online migrations.
- Rotate tokens by issuing a new one, deploying it to the phone, then revoking the old ID.
- Alert on authenticated health: `worker.alive=false`, `queue.pending` growth, and `authError`.
- Log retention should cover incident review; the app does not ship a log pipeline.

## 8. Preflight checklist

- [ ] Dedicated `ribhu_app` role, not a superuser
- [ ] `RIBBHU_STRICT_RLS=1`
- [ ] TLS terminates before the app
- [ ] Tenant token issued with an expiry
- [ ] Token revocation tested
- [ ] Migration completed and counts verified
- [ ] Backup + restore tested
- [ ] `RIBBHU_SANDBOX=docker` and approval policy set
- [ ] Authenticated health checked from outside the host
- [ ] Worker-per-tenant topology documented for operators

## Known limits

- No per-request tenant runtime routing; one tenant per API process.
- No interactive approvals, billing, quotas, or audit UI.
- Native iOS/Android builds are not generated.
- RLS is only as strong as the database role; a superuser or `BYPASSRLS` role bypasses it.
