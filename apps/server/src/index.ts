import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { PROTOCOL_VERSION } from "@ribhu-voyager/protocol";
import type { IncomingMessage } from "node:http";

import { describeConfig, loadConfig } from "./config.js";
import { attachGateway } from "./gateway.js";
import {
  closeApiTokenPools,
  resolveApiToken,
} from "@ribhu-voyager/storage-postgres";

import type { ApiRuntime } from "./api-runtime.js";
import { healthPayload } from "./health.js";
import { createRuntimePool } from "./runtime-pool.js";
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

const config = loadConfig();
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

const distDir = resolve(fileURLToPath(new URL("../../mobile/dist/", import.meta.url)));
const serveStatic = createStaticHandler(distDir);

const server = createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url ?? "/", "http://localhost");

    if (url.pathname === "/api/health") {
      // Authenticated callers get their tenant's detailed health; unknown or
      // missing tokens get only the minimal public payload.
      const resolved = await pool.resolve(requestToken(request, url));
      const payload = resolved
        ? await healthPayload(resolved.runtime, true)
        : {
            ok: true,
            protocol: PROTOCOL_VERSION,
            uptimeMs: Date.now() - startedAt,
          };
      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end(JSON.stringify(payload));
      return;
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

if (
  !config.token &&
  !hasTenantTokens &&
  config.host !== "127.0.0.1" &&
  config.host !== "::1" &&
  config.host !== "localhost"
) {
  console.error(
    `Refusing to bind ${config.host} without RIBBHU_TOKEN or a Postgres tenant token.`,
  );
  process.exit(1);
}

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
    resolveRuntime: async (token) => (await pool.resolve(token))?.runtime,
    infoFor: (runtime) => pool.infoFor(runtime as ApiRuntime),
  },
);

const shutdown = async (signal: string) => {
  console.log(`\n${color.dim}${signal} — closing storage…${color.reset}`);
  try {
    await gateway.close();
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
