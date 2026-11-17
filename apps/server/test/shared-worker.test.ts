import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type {
  Provider,
  ProviderEvent,
  ProviderRequest,
  Usage,
} from "@ribhu-voyager/engine";
import {
  PostgresStorage,
  closeApiTokenPools,
  closeSharedPools,
  createSharedPostgresStorage,
  provisionAppRole,
} from "@ribhu-voyager/storage-postgres";

import { loadConfig, type Config } from "../src/config.js";
import { startSharedWorker } from "../src/tenant-worker.js";

const IMAGE = "pgvector/pgvector:pg17";
const PORT = 55460;
const NAME = `ribhu-pg-shared-worker-${process.pid}`;
const ADMIN_URL = `postgres://postgres:ribhu@127.0.0.1:${PORT}/ribhu`;
const APP_URL = `postgres://ribhu_app:ribhu_app@127.0.0.1:${PORT}/ribhu`;
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

async function waitFor<T>(
  probe: () => Promise<T | undefined> | T | undefined,
  timeoutMs = 15_000,
): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() - start >= timeoutMs) {
      throw new Error("timed out waiting for the expected state");
    }
    await sleep(25);
  }
}

const usage: Usage = { input: 0, output: 1, totalTokens: 1 };

class FastProvider implements Provider {
  readonly id = "fast";
  readonly model = "fast";
  async *stream(): AsyncIterable<ProviderEvent> {
    yield { type: "text", text: "quick answer" };
    yield { type: "done", stopReason: "stop", usage };
  }
}

/** Hangs until aborted: proves a slow tenant does not block the others. */
class SlowProvider implements Provider {
  readonly id = "slow";
  readonly model = "slow";
  async *stream(request: ProviderRequest): AsyncIterable<ProviderEvent> {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 60_000);
      const onAbort = () => {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      };
      if (request.signal.aborted) {
        onAbort();
        return;
      }
      request.signal.addEventListener("abort", onAbort, { once: true });
    });
    yield { type: "text", text: "late answer" };
    yield { type: "done", stopReason: "stop", usage };
  }
}

function sharedConfig(dir: string): Config {
  return {
    host: "127.0.0.1",
    port: 0,
    dataDir: join(dir, "data"),
    workspaceDir: join(dir, "workspaces"),
    provider: "demo",
    model: "ribhu-demo",
    demo: true,
    demoTokensPerSecond: 4000,
    maxWindowEntries: 100,
    token: "",
    authMode: "auto",
    authSource: "auto",
    storage: "postgres",
    postgresUrl: APP_URL,
    tenantId: "default",
    sharedWorker: true,
  };
}

test(
  "one shared worker serves two Postgres tenants concurrently",
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
    const admin = new PostgresStorage(ADMIN_URL);
    const dir = await mkdtemp(join(tmpdir(), "ribhu-shared-worker-"));
    let tenantA: PostgresStorage | undefined;
    let tenantB: PostgresStorage | undefined;
    let shared: Awaited<ReturnType<typeof startSharedWorker>> | undefined;
    try {
      let connected = false;
      for (let attempt = 0; attempt < 240 && !connected; attempt += 1) {
        try {
          await admin.init({ migrate: true });
          connected = true;
        } catch {
          await sleep(250);
        }
      }
      assert.equal(connected, true);
      await provisionAppRole(ADMIN_URL, "ribhu_app", "ribhu_app");

      // Provision two tenants and queue one job for each.
      tenantA = createSharedPostgresStorage(APP_URL, "tenant-a");
      tenantB = createSharedPostgresStorage(APP_URL, "tenant-b");
      await tenantA.init();
      await tenantB.init();
      const rootA = await tenantA.ensureRoot();
      const rootB = await tenantB.ensureRoot();
      await tenantA.admitSubmission(rootA, "sw-a", "slow tenant request");
      await tenantB.admitSubmission(rootB, "sw-b", "fast tenant request");

      const config = sharedConfig(dir);
      const lines: string[] = [];
      shared = await startSharedWorker(config, {
        log: (line) => lines.push(line),
        provider: (tenantId) =>
          tenantId === "tenant-a" ? new SlowProvider() : new FastProvider(),
      });

      // Discovery + one worker/workspace per tenant.
      assert.ok(shared.tenants.includes("tenant-a"));
      assert.ok(shared.tenants.includes("tenant-b"));
      assert.ok(lines.some((line) => /discovery \d+ tenant/.test(line)));
      assert.ok(shared.workers.has("tenant-a"));
      assert.ok(shared.workers.has("tenant-b"));
      for (const tenant of ["tenant-a", "tenant-b"]) {
        assert.ok(
          (await stat(join(config.workspaceDir!, tenant))).isDirectory(),
          `${tenant} has its own workspace`,
        );
      }

      // The fast tenant finishes while the slow tenant is still running.
      await waitFor(async () =>
        (await tenantB!.view(rootB)).entries.some(
          (entry) => entry.kind === "pi.assistant",
        )
          ? true
          : undefined,
      );
      assert.equal(
        (await tenantA!.view(rootA)).entries.filter(
          (entry) => entry.kind === "pi.assistant",
        ).length,
        0,
        "the slow tenant has not answered yet",
      );
      assert.equal(
        (await tenantA!.findSubmission(rootA, "sw-a"))?.status,
        "running",
        "the slow tenant is still running",
      );
      await waitFor(async () =>
        (await tenantB!.findSubmission(rootB, "sw-b"))?.status === "done"
          ? true
          : undefined,
      );
      assert.equal(
        (await tenantB!.findSubmission(rootB, "sw-b"))?.status,
        "done",
        "the fast tenant completed without waiting for the slow one",
      );

      // Neither tenant's worker claimed or wrote the other tenant's job.
      assert.equal((await tenantA!.view(rootB)).entries.length, 0);
      assert.equal((await tenantB!.view(rootA)).entries.length, 0);
      assert.equal((await tenantA!.queueStats()).running, 1);
      await waitFor(async () =>
        (await tenantB!.queueStats()).running === 0 ? true : undefined,
      );
      assert.equal((await tenantB!.queueStats()).running, 0);

      // Graceful close aborts the in-flight tenant run and drains everyone.
      const started = Date.now();
      await shared.close();
      assert.ok(Date.now() - started < 20_000, "shared close drains quickly");
      assert.equal(shared.workers.size, 0);
      assert.equal(
        (await tenantA!.findSubmission(rootA, "sw-a"))?.status,
        "aborted",
        "the slow tenant's run was aborted on shutdown",
      );
      assert.equal(
        (await tenantB!.findSubmission(rootB, "sw-b"))?.status,
        "done",
        "the completed tenant keeps its answer",
      );
    } finally {
      await shared?.close().catch(() => undefined);
      await tenantA?.close().catch(() => undefined);
      await tenantB?.close().catch(() => undefined);
      await admin.close().catch(() => undefined);
      await closeSharedPools();
      await closeApiTokenPools();
      await rm(dir, { recursive: true, force: true });
      try {
        execFileSync("docker", ["rm", "-f", NAME], { stdio: "ignore" });
      } catch {
        /* container already gone */
      }
    }
  },
);

test("shared worker mode is opt-in and Postgres-only", { timeout: 20_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "ribhu-shared-worker-config-"));
  try {
    const base = sharedConfig(dir);
    // SQLite + shared worker is rejected at config load.
    assert.throws(
      () =>
        loadConfig({
          RIBBHU_SHARED_WORKER: "1",
          RIBBHU_STORAGE: "sqlite",
          RIBBHU_DATA_DIR: dir,
        } as NodeJS.ProcessEnv),
      /requires RIBBHU_STORAGE=postgres/,
    );
    // Postgres sets the flag (break-glass skips the hosted posture checks).
    const config = loadConfig({
      RIBBHU_SHARED_WORKER: "1",
      RIBBHU_STORAGE: "postgres",
      RIBBHU_POSTGRES_URL: "postgres://example/ribhu",
      RIBBHU_ALLOW_UNSAFE_HOSTED: "1",
      RIBBHU_DATA_DIR: dir,
    } as NodeJS.ProcessEnv);
    assert.equal(config.sharedWorker, true);
    assert.equal(loadConfig({} as NodeJS.ProcessEnv).sharedWorker, false);

    // startSharedWorker refuses a non-Postgres config.
    await assert.rejects(
      startSharedWorker(
        { ...base, storage: "sqlite", postgresUrl: undefined, sharedWorker: true },
        { log: () => undefined },
      ),
      /requires RIBBHU_STORAGE=postgres/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

const MAIN_PORT = 55461;
const MAIN_NAME = `ribhu-pg-shared-main-${process.pid}`;
const MAIN_ADMIN_URL = `postgres://postgres:ribhu@127.0.0.1:${MAIN_PORT}/ribhu`;
const MAIN_APP_URL = `postgres://ribhu_app:ribhu_app@127.0.0.1:${MAIN_PORT}/ribhu`;

test(
  "worker-main runs in shared mode and logs tenant discovery",
  { timeout: 120_000, skip: ready ? false : "docker/postgres image unavailable" },
  async () => {
    execFileSync("docker", [
      "run",
      "--rm",
      "-d",
      "--name",
      MAIN_NAME,
      "-e",
      "POSTGRES_PASSWORD=ribhu",
      "-e",
      "POSTGRES_DB=ribhu",
      "-p",
      `${MAIN_PORT}:5432`,
      IMAGE,
    ]);
    const admin = new PostgresStorage(MAIN_ADMIN_URL);
    const dir = await mkdtemp(join(tmpdir(), "ribhu-shared-main-"));
    let tenantA: PostgresStorage | undefined;
    let tenantB: PostgresStorage | undefined;
    let child: ReturnType<typeof spawn> | undefined;
    try {
      let connected = false;
      for (let attempt = 0; attempt < 240 && !connected; attempt += 1) {
        try {
          await admin.init({ migrate: true });
          connected = true;
        } catch {
          await sleep(250);
        }
      }
      assert.equal(connected, true);
      await provisionAppRole(MAIN_ADMIN_URL, "ribhu_app", "ribhu_app");

      tenantA = createSharedPostgresStorage(MAIN_APP_URL, "tenant-a");
      tenantB = createSharedPostgresStorage(MAIN_APP_URL, "tenant-b");
      await tenantA.init();
      await tenantB.init();
      const rootA = await tenantA.ensureRoot();
      const rootB = await tenantB.ensureRoot();
      await tenantA.admitSubmission(rootA, "main-a", "hello a");
      await tenantB.admitSubmission(rootB, "main-b", "hello b");

      let stdout = "";
      let stderr = "";
      child = spawn(
        process.execPath,
        ["--import", "tsx", "apps/server/src/worker-main.ts"],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            RIBBHU_STORAGE: "postgres",
            RIBBHU_POSTGRES_URL: MAIN_APP_URL,
            RIBBHU_SHARED_WORKER: "1",
            RIBBHU_ALLOW_UNSAFE_HOSTED: "1",
            RIBBHU_DATA_DIR: join(dir, "data"),
            RIBBHU_WORKSPACE: join(dir, "workspaces"),
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr?.on("data", (chunk: string) => {
        stderr += chunk;
      });

      await waitFor(
        () => (/discovery \d+ tenant/.test(stdout) ? true : undefined),
        20_000,
      );
      assert.match(stdout, /shared multi-tenant started/);
      assert.match(stdout, /tenant-a worker started/);
      assert.match(stdout, /tenant-b worker started/);

      // Both queued jobs are answered by the one process.
      await waitFor(async () => {
        const a = (await tenantA!.view(rootA)).entries.some(
          (entry) => entry.kind === "pi.assistant",
        );
        const b = (await tenantB!.view(rootB)).entries.some(
          (entry) => entry.kind === "pi.assistant",
        );
        return a && b ? true : undefined;
      }, 30_000);

      child.kill("SIGTERM");
      const code = await new Promise<number | null>((resolve) => {
        child!.once("exit", resolve);
      });
      assert.equal(code, 0, `worker-main exited cleanly: ${stderr}`);
    } finally {
      child?.kill("SIGKILL");
      await tenantA?.close().catch(() => undefined);
      await tenantB?.close().catch(() => undefined);
      await admin.close().catch(() => undefined);
      await closeSharedPools();
      await closeApiTokenPools();
      await rm(dir, { recursive: true, force: true });
      try {
        execFileSync("docker", ["rm", "-f", MAIN_NAME], { stdio: "ignore" });
      } catch {
        /* container already gone */
      }
    }
  },
);
