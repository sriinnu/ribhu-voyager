import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Engine, admitSubmission } from "@ribhu-voyager/engine";
import { DemoProvider } from "@ribhu-voyager/providers";
import { PostgresStorage } from "@ribhu-voyager/storage-postgres";

import { createToolRunner } from "../src/tools-runtime.js";

const IMAGE = "pgvector/pgvector:pg17";
const PORT = 55434;
const NAME = `ribhu-pg-engine-${process.pid}`;
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

test(
  "the async engine runs end to end on Postgres",
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
    const storage = new PostgresStorage(URL);
    const dir = await mkdtemp(join(tmpdir(), "ribhu-pg-engine-"));
    try {
      let connected = false;
      for (let attempt = 0; attempt < 240 && !connected; attempt += 1) {
        try {
          await storage.init();
          connected = true;
        } catch {
          await sleep(250);
        }
      }
      assert.equal(connected, true);
      const root = await storage.ensureRoot();
      const engine = await Engine.open({
        storage,
        provider: new DemoProvider("ribhu-demo"),
        runner: createToolRunner(),
        cwd: dir,
        model: { provider: "demo", modelId: "ribhu-demo" },
        instructions: "test",
        autoRun: false,
      });
      const [firstAdmit, secondAdmit] = await Promise.all([
        admitSubmission(storage, root, {
          type: "input",
          content: "run: echo postgres-engine",
          requestId: "pg-engine-1",
          whenBusy: "steer",
        }),
        admitSubmission(storage, root, {
          type: "input",
          content: "run: echo postgres-engine",
          requestId: "pg-engine-1",
          whenBusy: "steer",
        }),
      ]);
      assert.equal(firstAdmit.id, secondAdmit.id);
      await engine.run(root);
      const view = await engine.view(root);
      const tool = view.entries.find((entry) => entry.kind === "pi.tool-result");
      assert.ok(tool);
      assert.match(JSON.stringify(tool.model), /postgres-engine/);
      assert.ok(
        view.entries.some((entry) => entry.kind === "pi.assistant"),
        "the model answered from the Postgres journal",
      );
      await engine.close();
    } finally {
      await storage.close().catch(() => undefined);
      await rm(dir, { recursive: true, force: true });
      try {
        execFileSync("docker", ["rm", "-f", NAME], { stdio: "ignore" });
      } catch {
        /* gone */
      }
    }
  },
);
