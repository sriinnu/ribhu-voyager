import { loadConfig } from "./config.js";
import { startSharedWorker } from "./tenant-worker.js";
import { startWorker } from "./worker.js";

const config = loadConfig();
const log = (line: string) => console.log(`  ${line}`);

if (config.sharedWorker) {
  // Phase 14: one Postgres process discovers and serves every tenant.
  const shared = await startSharedWorker(config, { log });
  console.log(
    `  worker    shared multi-tenant started for ${
      config.demo ? "demo" : `${config.provider}/${config.model}`
    } · ${shared.tenants.length} discovered tenant(s): ${
      shared.tenants.join(", ") || "(none)"
    }`,
  );

  const shutdown = async (signal: string) => {
    console.log(`\n  worker    ${signal} — draining ${shared.workers.size} tenant worker(s)…`);
    try {
      await shared.close();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
} else {
  const worker = await startWorker(config, { log });

  console.log(
    `  worker    started for ${
      config.demo ? "demo" : `${config.provider}/${config.model}`
    } · tenant ${config.tenantId ?? "default"} · queue ${config.dataDir}`,
  );

  const shutdown = async (signal: string) => {
    console.log(`\n  worker    ${signal} — draining…`);
    try {
      await worker.close();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}
