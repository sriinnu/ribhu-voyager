# Multi-Tenant Routing

The API process can serve multiple Postgres tenants on one port. A token selects the tenant; a
runtime (storage, engine, auth) is created lazily and cached per tenant.

## Topology

```text
PWA / API client
   │  token
   ▼
API (runtime pool) ──▶ tenant-a storage ─┐
   │                 └▶ tenant-b storage ─┤──▶ one shared pg.Pool
   │                           each statement: BEGIN; SET LOCAL app.tenant_id; …; COMMIT
   │
   └── WebSocket / health per token
Worker A (RIBBHU_TENANT=tenant-a) ──▶ tenant-a jobs   (same shared pool in that process)
Worker B (RIBBHU_TENANT=tenant-b) ──▶ tenant-b jobs
```

- One API process can serve many tenants.
- Run **one worker per tenant**: workers still bind to `RIBBHU_TENANT`. There is no worker
  autoscaler or cross-tenant job router yet.
- Postgres must use a `NOSUPERUSER NOBYPASSRLS` role; RLS separates conversations, entries, docs,
  submissions, jobs, tool tasks, settings, cancels, usage events, audit events, and the quota tables.

## Shared connection pool (R6)

Tenant isolation is per **transaction**, not per connection pool:

- One `pg.Pool` per Postgres URL per process (`createSharedPostgresStorage`), shared by every
  tenant `PostgresStorage` the API process, worker, and admin reader create for that URL.
- Every public storage operation runs in a transaction that starts with
  `SELECT set_config('app.tenant_id', $tenant, true)` (transaction-local `SET LOCAL`). Single
  statements get their own short transaction; `storage.tx(fn)` opens one transaction and nested
  `storage.tx`/storage calls join it, so the tenant is always set when RLS is evaluated.
- `close()` is **ref-counted**: it releases that tenant storage's reference and leaves the pool
  running for other tenants. The pool is ended when the last storage for the URL closes;
  `closeSharedPools()` force-closes all pools on process shutdown, and `sharedPoolStats()` /
  `sharedPoolCount()` expose ref counts and pool counters for tests/health tooling.
- `RIBBHU_POSTGRES_POOL_MAX` (default `10`) bounds the shared pool size.
- `PostgresStorage.pool` stays available for raw admin queries (used by the CLI/tests); such raw
  queries bypass the tenant wrapper, so they need admin credentials/superuser.

This removes the earlier "one pool per tenant runtime" cost: adding/evicting a tenant runtime no
longer opens a new pool, and many tenants multiplex over the same bounded connection set.

## Tokens

Issue one token per tenant with the admin URL:

```bash
RIBBHU_POSTGRES_URL="$ADMIN_URL" \
  npm run tokens:postgres -- issue --tenant tenant-a --label phone-a --days 30
```

The API resolves the token with `resolveApiToken`; unknown/revoked/expired tokens get HTTP 401 on
WebSocket upgrade and only minimal health over HTTP. In Postgres mode the shared `RIBBHU_TOKEN` is
not a master key.

## Health

```bash
curl -H "Authorization: Bearer $TENANT_TOKEN" https://gateway.example.com/api/health
```

Authenticated health is scoped to that token's tenant: worker snapshots, queue, auth state.
Unauthenticated health returns only `{ok, protocol, uptimeMs}`.

## Capacity

The API process caches one runtime per tenant (storage pool, engine handles, auth state), so the
cache is bounded:

- `RIBBHU_MAX_TENANT_RUNTIMES` (default `20`, `0` = unlimited) caps the number of tenant runtimes a
  single API process will create.
- A token for a *new* tenant past the cap is refused with HTTP **503** (`capacity_exceeded`) on both
  the WebSocket upgrade and `/api/health`; already-resolved tenants keep working, and their clients
  are unaffected.
- Authenticated health includes `pool: {activeTenants, pendingTenants, activeClients, idle,
  evictable, maxTenants, unlimited, ttlMs, tenants}`; startup prints the cap and eviction policy.

### Client-aware idle eviction

Each tenant runtime tracks `activeClients` (WebSocket connections) and `lastUsedAt`. A runtime is
evicted (closed and removed) only when it has **zero active clients** and has been idle longer than
the TTL; active and in-flight/pending runtimes are never evicted. Eviction is what makes the cap
sustainable for many short-lived tenants:

- `RIBBHU_TENANT_RUNTIME_TTL_MS` — idle TTL in milliseconds, default **600000** (10 minutes);
  `0` disables eviction entirely (the cap then behaves as a hard distinct-tenant limit until restart).
- `RIBBHU_TENANT_EVICT_INTERVAL_MS` — background sweep interval, default **60000** (1 minute);
  `0` disables the periodic sweep (capacity-pressure eviction still runs).
- On capacity pressure (a new tenant arrives at `RIBBHU_MAX_TENANT_RUNTIMES`), the
  **least-recently-used idle+expired** runtime is evicted first; if none is evictable the new tenant
  still gets HTTP **503** (`capacity_exceeded`) on the WS upgrade and `/api/health`. Existing tenants
  always resolve.
- The gateway reserves its tenant runtime when the upgrade token resolves and releases it on
  close/error/terminate; a handshake that never completes is released immediately, so `activeClients`
  never leaks.
- The active-client guarantee: a tenant that has a live WebSocket is never evicted, no matter how
  long it has been connected or idle.

This is the deliberate safe design: bounded resources with an explicit failure mode, not a
rewrite. The residual limitation is that tenant runtimes are still per tenant (no multiplexing
inside one runtime) and the cap is per API process; the eviction TTL only reclaims completely idle
tenants.

## Isolation guarantees

- A tenant token cannot resync, fork, rename, archive, submit to, or abort another tenant's
  conversation ID; the ID simply does not exist in that runtime.
- WebSocket views and auth broadcasts are runtime-scoped.
- Postgres RLS is the final boundary; SQLite multi-tenant mode is for tests only (separate data
  directories).

## Limits

- No tenant provisioning/admin API, per-tenant quotas, billing, or audit dashboard.
- Workers are deployed per tenant; no shared worker pool or autoscaler.
- No token rotation UI beyond the CLI (`issue` / `revoke`).
- The API process holds one runtime per active tenant up to `RIBBHU_MAX_TENANT_RUNTIMES`; capacity
  planning is per process. Tenant storage shares one ref-counted pool per URL, so the cap now
  bounds engine/runtime handles, not Postgres connections. Eviction still only reclaims fully idle
  tenants past the TTL, so bursts of many distinct tenants can hit the 503 cap until idle runtimes
  expire.
- The remaining worker limitation is architectural: jobs are not routed across tenants, so plan one
  worker process per tenant (each worker has its own shared pool for that process).
