import { createHash, timingSafeEqual } from "node:crypto";
import { join } from "node:path";

import type {
  AuditEvent,
  Awaitable,
  JsonObject,
  Quota,
  Storage,
  UsageEvent,
  UsageSummary,
} from "@ribhu-voyager/engine";
import { Db, serializedStorage } from "@ribhu-voyager/storage-sqlite";
import {
  PostgresStorage,
  resolveAdminToken,
} from "@ribhu-voyager/storage-postgres";

import type { Config } from "./config.js";
import { WORKER_STALE_MS } from "./health.js";
import { type PoolStats } from "./runtime-pool.js";

const DEFAULT_TENANT = "default";
const DEFAULT_LIMIT = 50;
const MAX_BODY_CHARS = 8_192;
const ADMIN_PAGE = "/admin";
const ADMIN_API = "/api/admin";
const METRICS_PATH = "/api/metrics";

/** Extra wiring the API process supplies for deployment-wide metrics. */
export type AdminDeps = {
  /** Current tenant runtime pool counters (capacity/active tenants). */
  poolStats?: () => PoolStats;
};

export type AdminIdentity = {
  /** Audit actor label: `admin` for the env token, `admin:<label>` for DB tokens. */
  actor: string;
};

export type AdminRequest = {
  method: string;
  pathname: string;
  headers: Record<string, string | undefined>;
  query: URLSearchParams;
  body?: string;
};

export type AdminResponse = {
  status: number;
  headers: Record<string, string>;
  body: string;
};

export type AdminApi = {
  /**
   * False when neither `RIBBHU_ADMIN_TOKEN` nor Postgres admin tokens can
   * authorize; every admin/metrics route then 404s.
   */
  readonly enabled: boolean;
  /** `undefined` when the request is not an admin or metrics route. */
  handle(request: AdminRequest): Promise<AdminResponse | undefined>;
  close(): Promise<void>;
};

function json(status: number, value: unknown): AdminResponse {
  return {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
    body: JSON.stringify(value),
  };
}

function text(body: string, contentType = "text/plain; charset=utf-8"): AdminResponse {
  return {
    status: 200,
    headers: { "content-type": contentType, "cache-control": "no-store" },
    body,
  };
}

function notFound(): AdminResponse {
  return {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8" },
    body: "Not found",
  };
}

function methodNotAllowed(): AdminResponse {
  return json(405, { error: "method_not_allowed" });
}

/** Constant-time token compare: hash both sides so length differences do not leak. */
function tokenMatches(expected: string, provided: string | undefined): boolean {
  if (provided === undefined) return false;
  const a = createHash("sha256").update(expected).digest();
  const b = createHash("sha256").update(provided).digest();
  return timingSafeEqual(a, b);
}

function bearerToken(
  headers: Record<string, string | undefined>,
): string | undefined {
  const header = headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return undefined;
  return header.slice("Bearer ".length);
}

function quotaValue(value: unknown, field: string): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${field} must be a non-negative number or null.`);
  }
  return Math.trunc(value);
}

function parseLimit(query: URLSearchParams, fallback = DEFAULT_LIMIT): number {
  const raw = query.get("limit");
  if (raw === null) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(500, Math.trunc(parsed));
}

/** One Prometheus gauge: HELP/TYPE plus a sanitized numeric sample. */
function metric(
  name: string,
  help: string,
  raw: number,
  type: "gauge" | "counter" = "gauge",
): string[] {
  const value = Number.isFinite(raw) ? Math.max(0, raw) : 0;
  return [
    `# HELP ribhu_${name} ${help}`,
    `# TYPE ribhu_${name} ${type}`,
    `ribhu_${name} ${value}`,
  ];
}

/**
 * Admin control plane for usage, audit, quotas and tenants.
 *
 * `RIBBHU_ADMIN_TOKEN` gates it: when unset every admin route is a 404, so the
 * surface does not exist for a self-hosted single-user install. Postgres reads
 * are done through a per-tenant `PostgresStorage` so the same RLS policy that
 * protects prompts also protects usage and audit rows. SQLite exposes its one
 * default tenant.
 */
export function createAdminApi(config: Config, deps: AdminDeps = {}): AdminApi {
  const token = config.adminToken;
  const defaultTenant = config.tenantId ?? DEFAULT_TENANT;
  const usesPostgres = config.storage === "postgres" && Boolean(config.postgresUrl);
  // Postgres deployments can authorize with DB admin tokens even when the
  // legacy RIBBHU_ADMIN_TOKEN env token is unset.
  const enabled =
    (typeof token === "string" && token !== "") || usesPostgres;

  let sqlite: Storage | undefined;
  const postgres = new Map<string, Promise<PostgresStorage>>();

  const sqliteStorage = (): Storage => {
    sqlite ??= serializedStorage(new Db(join(config.dataDir, "ribhu.sqlite")));
    return sqlite;
  };

  const postgresStorage = async (tenant: string): Promise<PostgresStorage> => {
    const cached = postgres.get(tenant);
    if (cached) return cached;
    const created = (async () => {
      const instance = new PostgresStorage(config.postgresUrl!, tenant);
      await instance.init();
      return instance;
    })();
    postgres.set(tenant, created);
    return created;
  };

  const storageFor = async (tenant: string): Promise<Storage> =>
    usesPostgres ? await postgresStorage(tenant) : sqliteStorage();

  const tenants = async (): Promise<string[]> => {
    if (!usesPostgres) return [DEFAULT_TENANT];
    return (await postgresStorage(defaultTenant)).listTenants();
  };

  const resolveTenant = async (
    requested: string | null,
  ): Promise<
    | { tenant: string; storage: Storage }
    | { error: AdminResponse }
  > => {
    const tenant = requested?.trim() || (usesPostgres ? defaultTenant : DEFAULT_TENANT);
    const known = await tenants();
    if (!known.includes(tenant)) {
      return {
        error: json(404, {
          error: "unknown_tenant",
          message: `Unknown tenant "${tenant}".`,
        }),
      };
    }
    return { tenant, storage: await storageFor(tenant) };
  };

  /** Env token (legacy) or a DB admin token; returns the audit actor. */
  const authenticate = async (
    request: AdminRequest,
  ): Promise<AdminIdentity | undefined> => {
    if (!enabled) return undefined;
    const provided = bearerToken(request.headers);
    if (provided === undefined || provided === "") return undefined;
    if (
      typeof token === "string" &&
      token !== "" &&
      tokenMatches(token, provided)
    ) {
      return { actor: "admin" };
    }
    if (!usesPostgres) return undefined;
    try {
      const row = await resolveAdminToken(config.postgresUrl!, provided);
      return row ? { actor: `admin:${row.label}` } : undefined;
    } catch (error) {
      console.error(
        "admin token lookup failed",
        error instanceof Error ? error.message : String(error),
      );
      return undefined;
    }
  };

  const usagePayload = async (
    tenant: string,
    storage: Storage,
    limit: number,
  ): Promise<{
    tenant: string;
    day: UsageSummary;
    month: UsageSummary;
    recent: UsageEvent[];
  }> => ({
    tenant,
    day: await storage.usageSummary("day"),
    month: await storage.usageSummary("month"),
    recent: await storage.listUsage(limit),
  });

  const auditPayload = async (
    tenant: string,
    storage: Storage,
    limit: number,
  ): Promise<{ tenant: string; events: AuditEvent[] }> => ({
    tenant,
    events: await storage.listAudit(limit),
  });

  const handleQuota = async (
    request: AdminRequest,
    actor: string,
  ): Promise<AdminResponse> => {
    let body: unknown;
    try {
      body = request.body ? JSON.parse(request.body) : undefined;
    } catch {
      return json(400, { error: "invalid_json" });
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return json(400, {
        error: "bad_request",
        message: "Body must be a JSON object.",
      });
    }
    const input = body as {
      tenant?: unknown;
      dailyTokens?: unknown;
      monthlyCostMicros?: unknown;
    };
    if (typeof input.tenant !== "string" || input.tenant.trim() === "") {
      return json(400, {
        error: "bad_request",
        message: "tenant must be a non-empty string.",
      });
    }
    let dailyTokens: number | null | undefined;
    let monthlyCostMicros: number | null | undefined;
    try {
      dailyTokens = quotaValue(input.dailyTokens, "dailyTokens");
      monthlyCostMicros = quotaValue(input.monthlyCostMicros, "monthlyCostMicros");
    } catch (error) {
      return json(400, {
        error: "bad_request",
        message: error instanceof Error ? error.message : String(error),
      });
    }
    const resolved = await resolveTenant(input.tenant);
    if ("error" in resolved) return resolved.error;
    const next: Partial<Quota> = {
      ...(dailyTokens !== undefined ? { dailyTokens } : {}),
      ...(monthlyCostMicros !== undefined ? { monthlyCostMicros } : {}),
    };
    if (Object.keys(next).length === 0) {
      return json(400, {
        error: "bad_request",
        message: "Provide dailyTokens and/or monthlyCostMicros.",
      });
    }
    await resolved.storage.setQuota(next);
    await resolved.storage.recordAudit({
      actor,
      action: "quota.updated",
      target: resolved.tenant,
      data: next as JsonObject,
    });
    return json(200, {
      tenant: resolved.tenant,
      quota: await resolved.storage.quota(),
    });
  };

  const auditAdminRead = async (
    storage: Storage,
    actor: string,
    action: "admin.usage_view" | "admin.audit_view" | "admin.tenants_view",
    target: string,
    data: JsonObject,
  ): Promise<void> => {
    try {
      await storage.recordAudit({ actor, action, target, data });
    } catch (error) {
      // Auditing a read must not break the read itself.
      console.error(
        "admin audit write failed",
        error instanceof Error ? error.message : String(error),
      );
    }
  };

  const schemaVersionOf = async (storage: Storage): Promise<number> => {
    const candidate = storage as Storage & {
      schemaVersion?: () => Awaitable<number>;
    };
    if (typeof candidate.schemaVersion !== "function") return 0;
    try {
      return Number(await candidate.schemaVersion());
    } catch {
      return 0;
    }
  };

  const metricsResponse = async (): Promise<AdminResponse> => {
    const storage = await storageFor(defaultTenant);
    const [queue, day, month, heartbeats] = await Promise.all([
      storage.queueStats(),
      storage.usageSummary("day"),
      storage.usageSummary("month"),
      storage.settingsMatching("worker_heartbeat:"),
    ]);
    const now = Date.now();
    let workersTotal = 0;
    let workersAlive = 0;
    for (const pair of heartbeats) {
      const heartbeat = Number(pair.value);
      if (!Number.isFinite(heartbeat) || heartbeat <= 0) continue;
      workersTotal += 1;
      if (now - heartbeat < WORKER_STALE_MS) workersAlive += 1;
    }
    const pool: PoolStats =
      deps.poolStats?.() ??
      ({
        activeTenants: 0,
        pendingTenants: 0,
        activeClients: 0,
        idle: 0,
        evictable: 0,
        maxTenants: 0,
        unlimited: true,
        ttlMs: 0,
        tenants: [],
      } satisfies PoolStats);
    const oldestPendingMs = queue.oldestPendingAgeMs ?? 0;
    const lines = [
      ...metric(
        "queue_pending_jobs",
        "Jobs waiting to be claimed by a worker.",
        queue.pending,
      ),
      ...metric(
        "queue_running_jobs",
        "Jobs currently claimed by a worker.",
        queue.running,
      ),
      ...metric(
        "queue_oldest_pending_age_seconds",
        "Age of the oldest pending job in seconds.",
        oldestPendingMs / 1000,
      ),
      ...metric("workers_total", "Workers that have published a heartbeat.", workersTotal),
      ...metric(
        "workers_alive",
        "Workers whose heartbeat is within the stale window.",
        workersAlive,
      ),
      ...metric(
        "usage_day_tokens",
        "Model tokens recorded today (default tenant).",
        day.totalTokens,
      ),
      ...metric(
        "usage_month_tokens",
        "Model tokens recorded this UTC month (default tenant).",
        month.totalTokens,
      ),
      ...metric(
        "usage_month_cost_micros",
        "Model cost in micros recorded this UTC month (default tenant).",
        month.costMicros,
      ),
      ...metric(
        "tenant_runtimes_active",
        "Tenant runtimes currently cached in this API process.",
        pool.activeTenants,
      ),
      ...metric(
        "tenant_runtimes_capacity",
        "Configured maximum tenant runtimes (0 = unlimited).",
        pool.maxTenants,
      ),
      ...metric(
        "tenant_runtimes_unlimited",
        "1 when the tenant runtime pool has no cap.",
        pool.unlimited ? 1 : 0,
      ),
      ...metric(
        "schema_version",
        "Applied storage schema version.",
        await schemaVersionOf(storage),
      ),
    ];
    return text(`${lines.join("\n")}\n`, "text/plain; version=0.0.4; charset=utf-8");
  };

  return {
    enabled,
    async handle(request: AdminRequest): Promise<AdminResponse | undefined> {
      const isAdminRoute =
        request.pathname === ADMIN_PAGE ||
        request.pathname === METRICS_PATH ||
        request.pathname === ADMIN_API ||
        request.pathname.startsWith(`${ADMIN_API}/`);
      if (!isAdminRoute) return undefined;
      if (!enabled) return notFound();

      if (request.pathname === ADMIN_PAGE) {
        if (request.method !== "GET") return methodNotAllowed();
        return {
          status: 200,
          headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
          },
          body: dashboardHtml(),
        };
      }

      const identity = await authenticate(request);
      if (identity === undefined) {
        return json(401, {
          error: "unauthorized",
          message: "A valid admin bearer token is required.",
        });
      }

      try {
        if (request.pathname === METRICS_PATH) {
          if (request.method !== "GET") return methodNotAllowed();
          return await metricsResponse();
        }
        if (request.pathname === `${ADMIN_API}/tenants`) {
          if (request.method !== "GET") return methodNotAllowed();
          const list = await tenants();
          await auditAdminRead(
            await storageFor(defaultTenant),
            identity.actor,
            "admin.tenants_view",
            "deployment",
            { tenants: list.length },
          );
          return json(200, { tenants: list });
        }
        if (request.pathname === `${ADMIN_API}/usage`) {
          if (request.method !== "GET") return methodNotAllowed();
          const limit = parseLimit(request.query);
          const resolved = await resolveTenant(request.query.get("tenant"));
          if ("error" in resolved) return resolved.error;
          const payload = await usagePayload(
            resolved.tenant,
            resolved.storage,
            limit,
          );
          await auditAdminRead(
            resolved.storage,
            identity.actor,
            "admin.usage_view",
            resolved.tenant,
            { limit },
          );
          return json(200, payload);
        }
        if (request.pathname === `${ADMIN_API}/audit`) {
          if (request.method !== "GET") return methodNotAllowed();
          const limit = parseLimit(request.query);
          const resolved = await resolveTenant(request.query.get("tenant"));
          if ("error" in resolved) return resolved.error;
          const payload = await auditPayload(
            resolved.tenant,
            resolved.storage,
            limit,
          );
          await auditAdminRead(
            resolved.storage,
            identity.actor,
            "admin.audit_view",
            resolved.tenant,
            { limit },
          );
          return json(200, payload);
        }
        if (request.pathname === `${ADMIN_API}/quota`) {
          if (request.method !== "POST") return methodNotAllowed();
          return await handleQuota(request, identity.actor);
        }
        return notFound();
      } catch (error) {
        return json(500, {
          error: "admin_error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },
    async close(): Promise<void> {
      const pending = [...postgres.values()];
      postgres.clear();
      const opened = await Promise.allSettled(pending);
      for (const result of opened) {
        if (result.status === "fulfilled") await result.value.close().catch(() => undefined);
      }
      if (sqlite) {
        await Promise.resolve(sqlite.close()).catch(() => undefined);
        sqlite = undefined;
      }
    },
  };
}

function dashboardHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Ribhu Voyager — admin</title>
<style>
  :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; }
  body { margin: 0; padding: 24px; background: #0b0c0f; color: #e8e8ea; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: #9a9aa2; font-size: 13px; margin-bottom: 20px; }
  .row { display: flex; gap: 8px; align-items: center; margin-bottom: 16px; flex-wrap: wrap; }
  input, select, button { font: inherit; padding: 8px 10px; border-radius: 8px; border: 1px solid #2f3038; background: #15161b; color: inherit; }
  button { cursor: pointer; background: #2a2b34; }
  .cards { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 20px; }
  .card { border: 1px solid #2a2b34; border-radius: 12px; padding: 14px 18px; min-width: 180px; }
  .card .label { color: #9a9aa2; font-size: 12px; text-transform: uppercase; letter-spacing: .06em; }
  .card .value { font-size: 22px; margin-top: 4px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #23242b; vertical-align: top; }
  th { color: #9a9aa2; font-weight: 500; }
  .status { color: #9a9aa2; }
  .error { color: #ff8a8a; }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
</style>
</head>
<body>
  <h1>Ribhu Voyager — admin</h1>
  <div class="sub">Usage, quotas and audit for this deployment. The admin bearer token stays in this browser tab.</div>
  <div class="row">
    <input id="token" type="password" placeholder="admin bearer token" autocomplete="off" size="36" />
    <button id="load">Load</button>
    <select id="tenant"><option value="">default tenant</option></select>
    <span id="status" class="status"></span>
  </div>
  <div class="cards">
    <div class="card"><div class="label">Today tokens</div><div class="value" id="day-tokens">—</div></div>
    <div class="card"><div class="label">Today events</div><div class="value" id="day-events">—</div></div>
    <div class="card"><div class="label">Month cost (micros)</div><div class="value" id="month-cost">—</div></div>
    <div class="card"><div class="label">Month tokens</div><div class="value" id="month-tokens">—</div></div>
  </div>
  <h2 style="font-size:15px;margin:0 0 8px">Recent audit</h2>
  <table>
    <thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Target</th><th>Data</th></tr></thead>
    <tbody id="audit"><tr><td colspan="5" class="status">Load the dashboard to see audit events.</td></tr></tbody>
  </table>
<script>
(function () {
  var tokenInput = document.getElementById("token");
  var tenantSelect = document.getElementById("tenant");
  var status = document.getElementById("status");
  var loadButton = document.getElementById("load");
  tokenInput.value = sessionStorage.getItem("ribhuAdminToken") || "";

  function headers() {
    return { authorization: "Bearer " + tokenInput.value.trim() };
  }
  function setStatus(text, isError) {
    status.textContent = text;
    status.className = isError ? "error" : "status";
  }
  function cell(text) {
    var td = document.createElement("td");
    td.textContent = text;
    return td;
  }
  function renderAudit(events) {
    var body = document.getElementById("audit");
    body.textContent = "";
    if (!events.length) {
      var row = document.createElement("tr");
      var td = cell("No audit events yet.");
      td.colSpan = 5;
      row.appendChild(td);
      body.appendChild(row);
      return;
    }
    events.forEach(function (event) {
      var row = document.createElement("tr");
      row.appendChild(cell(new Date(event.createdAt).toISOString()));
      row.appendChild(cell(event.actor));
      row.appendChild(cell(event.action));
      row.appendChild(cell(event.target));
      var data = cell(event.data ? JSON.stringify(event.data) : "");
      data.className = "mono";
      row.appendChild(data);
      body.appendChild(row);
    });
  }
  function renderUsage(usage) {
    document.getElementById("day-tokens").textContent = usage.day.totalTokens;
    document.getElementById("day-events").textContent = usage.day.events;
    document.getElementById("month-cost").textContent = usage.month.costMicros;
    document.getElementById("month-tokens").textContent = usage.month.totalTokens;
  }
  function query(tenant, limit) {
    var params = new URLSearchParams();
    if (tenant) params.set("tenant", tenant);
    if (limit) params.set("limit", String(limit));
    var suffix = params.toString();
    return suffix ? "?" + suffix : "";
  }
  async function load() {
    var token = tokenInput.value.trim();
    if (!token) { setStatus("Enter the admin token.", true); return; }
    sessionStorage.setItem("ribhuAdminToken", token);
    setStatus("Loading…", false);
    try {
      var tenantsResponse = await fetch("/api/admin/tenants", { headers: headers() });
      if (tenantsResponse.status === 401) { setStatus("Invalid admin token.", true); return; }
      if (!tenantsResponse.ok) throw new Error("tenants: HTTP " + tenantsResponse.status);
      var tenantPayload = await tenantsResponse.json();
      var current = tenantSelect.value;
      tenantSelect.textContent = "";
      tenantPayload.tenants.forEach(function (tenant) {
        var option = document.createElement("option");
        option.value = tenant;
        option.textContent = tenant;
        tenantSelect.appendChild(option);
      });
      if (current && tenantPayload.tenants.indexOf(current) !== -1) tenantSelect.value = current;
      var selected = tenantSelect.value;
      var usageResponse = await fetch("/api/admin/usage" + query(selected), { headers: headers() });
      if (!usageResponse.ok) throw new Error("usage: HTTP " + usageResponse.status);
      renderUsage(await usageResponse.json());
      var auditResponse = await fetch("/api/admin/audit" + query(selected, 25), { headers: headers() });
      if (!auditResponse.ok) throw new Error("audit: HTTP " + auditResponse.status);
      renderAudit((await auditResponse.json()).events);
      setStatus("Updated " + new Date().toLocaleTimeString(), false);
    } catch (error) {
      setStatus(String(error && error.message ? error.message : error), true);
    }
  }
  loadButton.addEventListener("click", load);
  tenantSelect.addEventListener("change", load);
  tokenInput.addEventListener("keydown", function (event) { if (event.key === "Enter") load(); });
  if (tokenInput.value) load();
})();
</script>
</body>
</html>`;
}