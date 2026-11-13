import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import type { ServerInfo } from "@ribhu-voyager/protocol";

import { describeConfig, loadConfig } from "./config.js";
import { attachGateway } from "./gateway.js";
import {
  closeApiTokenPools,
  resolveApiToken,
} from "@ribhu-voyager/storage-postgres";

import { createApiRuntime } from "./api-runtime.js";
import { healthPayload } from "./health.js";
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

const config = loadConfig();
const runtime = await createApiRuntime(config);

const info: ServerInfo = {
  serverId: runtime.serverId,
  demo: runtime.demo,
  model: runtime.model.modelId,
  provider: runtime.model.provider,
  startedAt: runtime.startedAt,
};

const distDir = resolve(fileURLToPath(new URL("../../mobile/dist/", import.meta.url)));
const serveStatic = createStaticHandler(distDir);

const server = createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url ?? "/", "http://localhost");

    if (url.pathname === "/api/health") {
      let detailed = !config.token && !tokenCheck;
      if (!detailed) {
        const header = request.headers.authorization;
        const candidate =
          typeof header === "string" && header.startsWith("Bearer ")
            ? header.slice("Bearer ".length)
            : url.searchParams.get("token");
        if (candidate) {
          detailed = tokenCheck
            ? await tokenCheck(candidate).catch(() => false)
            : sameToken(candidate, config.token);
        }
      }
      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end(JSON.stringify(await healthPayload(runtime, detailed)));
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

function sameToken(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

const tokenCheck =
  config.storage === "postgres" && config.postgresUrl
    ? async (candidate: string) => {
        const tenant = await resolveApiToken(config.postgresUrl!, candidate);
        return tenant === (config.tenantId ?? "default");
      }
    : undefined;

if (
  !config.token &&
  !tokenCheck &&
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
  runtime,
  info,
  config.token,
  {
    min: 50,
    max: Math.max(config.maxWindowEntries, 50),
  },
  tokenCheck ? { authorizeToken: tokenCheck } : {},
);

const shutdown = async (signal: string) => {
  console.log(`\n${color.dim}${signal} — closing storage…${color.reset}`);
  try {
    await gateway.close();
    await runtime.close();
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
    `${color.dim}  data      durable SQLite storage — kill this process and the conversation resumes${color.reset}\n`,
  );
});
