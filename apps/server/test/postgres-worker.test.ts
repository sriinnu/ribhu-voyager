import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { admitSubmission } from "@ribhu-voyager/engine";
import { PostgresStorage } from "@ribhu-voyager/storage-postgres";

import type { Config } from "../src/config.js";
import { startWorker } from "../src/worker.js";

const IMAGE = "pgvector/pgvector:pg17";
const PORT = 55437;
const NAME = `ribhu-pg-worker-${process.pid}`;
const URL = `postgres://postgres:ribhu@127.0.0.1:${PORT}/ribhu`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let ready = false;
try {
  execFileSync("docker", ["image", "inspect", IMAGE], {
    stdio: "ignore",
    timeout: 10_000,
  });
  ready = true;
} catch {
  ready = false;
}

function configFor(dataDir: string): Config {
  return {
    host: "127.0.0.1",
    port: 0,
    dataDir,
    workspaceDir: join(dataDir, "workspace"),
    provider: "demo",
    model: "ribhu-demo",
    demo: true,
    demoTokensPerSecond: 4000,
    maxWindowEntries: 100,
    token: "",
    authMode: "auto",
    authSource: "auto",
    storage: "postgres",
    postgresUrl: URL,
  };
}

test(
  "a hosted worker claims and answers from Postgres",
  { timeout: 120_000, skip: ready ? false : "docker/postgres image unavailable" },
  async () => {
    execFileSync("docker", [
      "run",
      "--rm",
      "-d",
      "--name",
      NAME,
      "-e",
      "POSTGRES_PASSWORD=ribhu",
      "-e",
      "POSTGRES_DB=ribhu",
      "-p",
      `${PORT}:5432`,
      IMAGE,
    ]);
    const dir = await mkdtemp(join(tmpdir(), "ribhu-pg-worker-"));
    const api = new PostgresStorage(URL);
    try {
      let connected = false;
      for (let attempt = 0; attempt < 240 && !connected; attempt += 1) {
        try {
          await api.init();
          connected = true;
        } catch {
          await sleep(250);
        }
      }
      assert.equal(connected, true);
      const root = await api.ensureRoot();
      const worker = await startWorker(configFor(dir));
      const secondWorker = await startWorker(configFor(dir));
      try {
        await admitSubmission(api, root, {
          type: "input",
          content: "run: echo hosted-worker",
          requestId: "hosted-worker-1",
          whenBusy: "steer",
        });
        let view = await api.view(root);
        for (let attempt = 0; attempt < 120; attempt += 1) {
          view = await api.view(root);
          if (view.entries.some((entry) => entry.kind === "pi.tool-result")) {
            break;
          }
          await sleep(100);
        }
        const tool = view.entries.find((entry) => entry.kind === "pi.tool-result");
        assert.ok(tool);
        assert.match(JSON.stringify(tool.model), /hosted-worker/);
        await sleep(500);
        assert.equal(
          view.entries.filter((entry) => entry.kind === "pi.assistant").length,
          1,
          "two workers produced one answer",
        );
      } finally {
        await secondWorker.close();
        await worker.close();
      }
    } finally {
      await api.close().catch(() => undefined);
      await rm(dir, { recursive: true, force: true });
      try {
        execFileSync("docker", ["rm", "-f", NAME], { stdio: "ignore" });
      } catch {
        /* gone */
      }
    }
  },
);
