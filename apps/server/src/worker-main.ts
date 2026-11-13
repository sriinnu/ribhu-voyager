import { loadConfig } from "./config.js";
import { startWorker } from "./worker.js";

const config = loadConfig();
const worker = await startWorker(config, {
  log: (line) => console.log(`  ${line}`),
});

console.log(
  `  worker    started for ${config.demo ? "demo" : `${config.provider}/${config.model}`} · queue ${config.dataDir}`,
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
