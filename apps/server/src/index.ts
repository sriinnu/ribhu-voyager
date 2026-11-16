import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";

import type { IncomingMessage, ServerResponse } from "node:http";

import { describeConfig, loadConfig } from "./config.js";
import { attachGateway, createRateLimiter } from "./gateway.js";
import {
  PostgresStorage,
  closeApiTokenPools,
  resolveApiToken,
} from "@ribhu-voyager/storage-postgres";
import { Db } from "@ribhu-voyager/storage-sqlite";

import type { ApiRuntime } from "./api-runtime.js";
import { createAdminApi } from "./admin.js";
import { healthResponse } from "./health.js";
import {
  createRuntimePool,
  isCapacityExceeded,
  runtimeForGateway,
} from "./runtime-pool.js";
import { createStaticHandler } from "./static.js";

const color = {
  dim: "\u001b[2m",
  bold: "\u001b[1m",
  amber: "\u001b[38;5;214m",
  green: "\u001b[32m",
  reset: "\u001b[0m",
};

function lanAddresses(): string[] {
  const found: string[] = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) found.push(entry.address);
    }
  }
  return found;
}

function requestToken(request: IncomingMessage, url: URL): string | undefined {
  const header = request.headers.authorization;
  if (typeof header === "string" && header.startsWith("Bearer ")) {
    return header.slice("Bearer ".length);
  }
  return url.searchParams.get("token") ?? undefined;
}

/** Read a small admin request body (quota POST); larger bodies are truncated to a 400. */
function readAdminBody(request: IncomingMessage, limit = 8_192): Promise<string> {
  return new Promise((resolve) => {
    let body = "";
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve(body);
    };
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      if (settled) return;
      body += chunk;
      if (body.length >= limit) {
        body = body.slice(0, limit);
        finish();
      }
    });
    request.on("end", finish);
    request.on("error", finish);
  });
}

const config = loadConfig();

// R10: schema migrations are an explicit, schema-admin mode. `RIBBHU_MIGRATE_ONLY=1`
// applies DDL with the admin credentials then exits; normal startup only verifies
// the schema version (see the storage `init()` call inside the runtime/worker).
if (config.migrateOnly) {
  try {
    if (config.storage === "postgres" && config.postgresUrl) {
      const schema = new PostgresStorage(
        config.postgresUrl,
        config.tenantId ?? "default",
      );
      try {
        const version = await schema.migrateSchema();
        console.log(`  migrate   Postgres schema at version ${version}`);
      } finally {
        await schema.close().catch(() => undefined);
      }
    } else {
      // Opening the local journal applies its forward-only schema changes.
      const db = new Db(join(config.dataDir, "ribhu.sqlite"));
      db.close();
      console.log("  migrate   SQLite journal schema is up to date");
    }
  } catch (error) {
    console.error(
      `  migrate   failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
  process.exit(0);
}

// R10: verify (never migrate) the hosted schema before serving, so a stale
// database fails startup with the remediation message instead of a 500 later.
if (config.storage === "postgres" && config.postgresUrl) {
  const probe = new PostgresStorage(
    config.postgresUrl,
    config.tenantId ?? "default",
  );
  try {
    await probe.init();
  } catch (error) {
    console.error(
      `  storage   schema check failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    process.exit(1);
  } finally {
    await probe.close().catch(() => undefined);
  }
}

const startedAt = Date.now();
const hasTenantTokens = config.storage === "postgres" && Boolean(config.postgresUrl);

// Postgres tokens resolve to their tenant; SQLite/local has one default runtime
// guarded by the shared RIBBHU_TOKEN.
const pool = createRuntimePool(
  config,
  hasTenantTokens
    ? (token: string) => resolveApiToken(config.postgresUrl!, token)
    : undefined,
);

// Admin control plane: usage/audit/quotas + the /admin dashboard. Every route
// 404s when RIBBHU_ADMIN_TOKEN is unset.
const admin = createAdminApi(config, { poolStats: () => pool.stats() });

const healthRateLimit = createRateLimiter({
  limit: config.rateLimitPerMinute ?? 120,
});

function clientIp(request: IncomingMessage): string {
  return request.socket.remoteAddress ?? "unknown";
}

function rateLimited(response: ServerResponse, retryAfterMs: number): void {
  response.writeHead(429, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "retry-after": String(Math.max(1, Math.ceil(retryAfterMs / 1000))),
  });
  response.end(
    JSON.stringify({
      ok: false,
      error: "rate_limited",
      message: "Too many requests. Try again later.",
    }),
  );
}

const distDir = resolve(fileURLToPath(new URL("../../mobile/dist/", import.meta.url)));
const serveStatic = createStaticHandler(distDir);

const server = createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url ?? "/", "http://localhost");

    if (url.pathname === "/api/health") {
      const healthToken = requestToken(request, url);
      for (const key of [
        `ip:${clientIp(request)}`,
        ...(healthToken ? [`token:${healthToken}`] : []),
      ]) {
        const limit = healthRateLimit?.take(key);
        if (limit && !limit.allowed) {
          rateLimited(response, limit.retryAfterMs);
          return;
        }
      }
      // Authenticated callers get their tenant's detailed health; unknown or
      // missing tokens get only the minimal public payload. Pool exhaustion for
      // a new tenant is a clear 503 (existing tenants keep working).
      const health = await healthResponse(pool, healthToken, startedAt);
      response.writeHead(health.status, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end(JSON.stringify(health.payload));
      return;
    }

    if (
      url.pathname === "/admin" ||
      url.pathname === "/api/metrics" ||
      url.pathname.startsWith("/api/admin")
    ) {
      const adminResponse = await admin.handle({
        method: request.method ?? "GET",
        pathname: url.pathname,
        headers: { authorization: request.headers.authorization },
        query: url.searchParams,
        ...(request.method === "POST"
          ? { body: await readAdminBody(request) }
          : {}),
      });
      if (adminResponse) {
        response.writeHead(adminResponse.status, adminResponse.headers);
        response.end(adminResponse.body);
        return;
      }
    }

    const handled = await serveStatic(request, response);
    if (!handled) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found");
    }
  })().catch((error: unknown) => {
    console.error("request failed", error);
    if (!response.headersSent) {
      response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    }
    response.end("Internal server error");
  });
});

const gateway = attachGateway(
  server,
  undefined,
  undefined,
  config.token,
  {
    min: 50,
    max: Math.max(config.maxWindowEntries, 50),
  },
  {
    resolveRuntime: async (token) => runtimeForGateway(await pool.resolve(token)),
    infoFor: (runtime) => pool.infoFor(runtime as ApiRuntime),
    allowAnonymous: config.allowAnon === true,
    allowedOrigins: config.allowedOrigins ?? [],
    rateLimit: { limit: config.rateLimitPerMinute ?? 120, windowMs: 60_000 },
    // R6: WebSocket connections are the client-activity signal for eviction.
    onRuntimeConnect: async (runtime, token) => {
      const acquired = await pool.acquire(token);
      if (acquired === undefined) {
        throw new Error("Tenant runtime disappeared during upgrade.");
      }
      if (isCapacityExceeded(acquired)) throw new Error(acquired.message);
      if (acquired.runtime !== runtime) {
        // The idle runtime was evicted between resolve and acquire; do not let
        // the client keep a closed runtime.
        pool.release(acquired.runtime);
        throw new Error("Tenant runtime was evicted during upgrade; retry.");
      }
    },
    onRuntimeDisconnect: (runtime) => {
      pool.release(runtime as ApiRuntime);
    },
  },
);

const shutdown = async (signal: string) => {
  console.log(`\n${color.dim}${signal} — closing storage…${color.reset}`);
  try {
    await gateway.close();
    await admin.close();
    await pool.close();
    await closeApiTokenPools();
  } finally {
    server.close();
    process.exit(0);
  }
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

server.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EADDRINUSE") {
    console.error(
      `\nPort ${config.port} is already in use. Set PORT to another value.\n`,
    );
  } else {
    console.error(error);
  }
  process.exit(1);
});

server.listen(config.port, config.host, () => {
  const local = `http://127.0.0.1:${config.port}`;
  const lan = lanAddresses();
  const token = config.token ? `?token=${encodeURIComponent(config.token)}` : "";

  console.log(`\n${color.amber}${color.bold}Ribhu Voyager${color.reset}`);
  console.log(`${color.dim}${describeConfig(config)}${color.reset}\n`);
  if (config.tokenGenerated) {
    console.log(
      `  ${color.amber}${color.bold}token${color.reset}     ${config.token}  ${color.dim}(generated this start — save it; the URL below carries it)${color.reset}`,
    );
  }
  console.log(`  ${color.green}gateway${color.reset}   ${local}${token}`);
  if (config.host === "0.0.0.0" || config.host === "::") {
    for (const address of lan) {
      console.log(`  ${color.green}phone${color.reset}     http://${address}:${config.port}${token}`);
    }
  } else {
    console.log(
      `${color.dim}  phone     start with HOST=0.0.0.0 to reach it over your LAN${color.reset}`,
    );
  }
  console.log(
    `${color.dim}  data      durable storage — kill this process and the conversation resumes${color.reset}\n`,
  );
});
