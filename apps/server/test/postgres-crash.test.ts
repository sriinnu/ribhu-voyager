import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { admitSubmission } from "@ribhu-voyager/engine";
import { PostgresStorage } from "@ribhu-voyager/storage-postgres";

import type { Config } from "../src/config.js";
import { startWorker } from "../src/worker.js";

const IMAGE = "pgvector/pgvector:pg17";
const PORT = 55439;
const NAME = `ribhu-pg-crash-${process.pid}`;
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
  "a killed Postgres worker resumes after lease expiry",
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
    const dir = await mkdtemp(join(tmpdir(), "ribhu-pg-crash-"));
    const api = new PostgresStorage(URL);
    let child: ReturnType<typeof spawn> | undefined;
    try {
      let connected = false;
      for (let attempt = 0; attempt < 240 && !connected; attempt += 1) {
        try {
          await api.init({ migrate: true });
          connected = true;
        } catch {
          await sleep(250);
        }
      }
      assert.equal(connected, true);
      const root = await api.ensureRoot();

      child = spawn(
        process.execPath,
        ["--import", "tsx", "apps/server/src/worker-main.ts"],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            RIBBHU_STORAGE: "postgres",
            RIBBHU_POSTGRES_URL: URL,
            // This fixture intentionally uses the local sandbox with the
            // scripted demo provider; opt out of the hosted posture gate.
            RIBBHU_ALLOW_UNSAFE_HOSTED: "1",
            RIBBHU_DATA_DIR: dir,
            RIBBHU_WORKSPACE: join(dir, "workspace"),
          },
          stdio: "ignore",
        },
      );
      await sleep(2_000);

      await admitSubmission(api, root, {
        type: "input",
        content: "run: sleep 3",
        requestId: "pg-crash-1",
        whenBusy: "steer",
      });

      let running = false;
      for (let attempt = 0; attempt < 100 && !running; attempt += 1) {
        const result = await api.pool.query(
          "SELECT 1 FROM tool_tasks WHERE status = 'running' LIMIT 1",
        );
        running = (result.rowCount ?? 0) > 0;
        if (!running) await sleep(100);
      }
      assert.equal(running, true, "the worker started the tool");

      child.kill("SIGKILL");
      await new Promise((resolve) => child!.once("exit", resolve));
      await api.pool.query(
        "UPDATE jobs SET lease_until = 0 WHERE status = 'running'",
      );

      const worker = await startWorker(configFor(dir));
      try {
        let view = await api.view(root);
        let status = "";
        for (let attempt = 0; attempt < 150; attempt += 1) {
          view = await api.view(root);
          status =
            (await api.findSubmission(root, "pg-crash-1"))?.status ?? "";
          if (status === "done") break;
          await sleep(100);
        }
        assert.ok(
          view.entries.some((entry) => entry.kind === "pi.tool-result"),
          "the interrupted tool was journaled",
        );
        assert.equal(status, "done");
      } finally {
        await worker.close();
      }
    } finally {
      child?.kill("SIGKILL");
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
