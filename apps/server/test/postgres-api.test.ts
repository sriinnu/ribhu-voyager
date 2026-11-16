import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import test from "node:test";

import type { ServerInfo, ServerMessage } from "@ribhu-voyager/protocol";
import {
  PostgresStorage,
  closeApiTokenPools,
} from "@ribhu-voyager/storage-postgres";
import { WebSocket } from "ws";

import { createApiRuntime } from "../src/api-runtime.js";
import type { Config } from "../src/config.js";
import { attachGateway } from "../src/gateway.js";
import { startWorker } from "../src/worker.js";

const IMAGE = "pgvector/pgvector:pg17";
const PORT = 55438;
const NAME = `ribhu-pg-api-${process.pid}`;
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

class Client {
  readonly ws: WebSocket;
  private queue: ServerMessage[] = [];
  private waiters: Array<{
    match: (m: ServerMessage) => boolean;
    resolve: (m: ServerMessage) => void;
  }> = [];
  constructor(port: number) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    this.ws.on("message", (raw) => {
      const message = JSON.parse(raw.toString()) as ServerMessage;
      const index = this.waiters.findIndex((w) => w.match(message));
      if (index === -1) this.queue.push(message);
      else this.waiters.splice(index, 1)[0]!.resolve(message);
    });
  }
  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws.once("open", resolve);
      this.ws.once("error", reject);
    });
  }
  send(message: object): void {
    this.ws.send(JSON.stringify(message));
  }
  next(match: (m: ServerMessage) => boolean, timeoutMs = 20_000): Promise<ServerMessage> {
    const found = this.queue.find(match);
    if (found) {
      this.queue = this.queue.filter((m) => m !== found);
      return Promise.resolve(found);
    }
    return new Promise((resolve, reject) => {
      const waiter = { match, resolve };
      this.waiters.push(waiter);
      setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        reject(new Error("timed out waiting for a gateway message"));
      }, timeoutMs);
    });
  }
  close(): void {
    this.ws.close();
  }
}

test(
  "API, gateway, and worker all run on Postgres",
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
    const dir = await mkdtemp(join(tmpdir(), "ribhu-pg-api-"));
    let api: Awaited<ReturnType<typeof createApiRuntime>> | undefined;
    let worker: Awaited<ReturnType<typeof startWorker>> | undefined;
    let server: ReturnType<typeof createServer> | undefined;
    let gateway: Awaited<ReturnType<typeof attachGateway>> | undefined;
    const clientRef: { current?: Client } = {};
    try {
      let connected = false;
      for (let attempt = 0; attempt < 240 && !connected; attempt += 1) {
        const probe = new PostgresStorage(URL);
        try {
          await probe.init({ migrate: true });
          connected = true;
        } catch {
          await sleep(250);
        } finally {
          await probe.close().catch(() => undefined);
        }
      }
      assert.equal(connected, true);

      api = await createApiRuntime(configFor(dir));
      worker = await startWorker(configFor(dir));
      const info: ServerInfo = {
        serverId: api.serverId,
        demo: api.demo,
        model: api.model.modelId,
        provider: api.model.provider,
        startedAt: api.startedAt,
      };
      server = createServer((_request, response) => response.writeHead(404).end());
      gateway = attachGateway(server, api, info, "");
      await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
      const port = (server.address() as AddressInfo).port;

      const client = new Client(port);
      clientRef.current = client;
      await client.open();
      client.send({ t: "hello", v: 2, clientId: "pg-api" });
      const welcome = await client.next((m) => m.t === "welcome");
      assert.ok(welcome.t === "welcome");
      client.send({
        t: "submit",
        requestId: "pg-api-1",
        content: "run: echo hosted-api",
        whenBusy: "steer",
      });
      const view = await client.next(
        (m) =>
          m.t === "view" &&
          m.view.entries.some((entry) => entry.kind === "pi.tool-result"),
      );
      assert.ok(view.t === "view");
      assert.match(JSON.stringify(view.view.entries), /hosted-api/);
    } finally {
      clientRef.current?.close();
      await gateway?.close().catch(() => undefined);
      await new Promise<void>((resolve) => {
        if (!server) return resolve();
        server.close(() => resolve());
      });
      await worker?.close().catch(() => undefined);
      await api?.close().catch(() => undefined);
      await closeApiTokenPools();
      await rm(dir, { recursive: true, force: true });
      try {
        execFileSync("docker", ["rm", "-f", NAME], { stdio: "ignore" });
      } catch {
        /* gone */
      }
    }
  },
);
