import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ToolContext } from "@ribhu-voyager/engine";

import { createToolRunner } from "../src/tools-runtime.js";

function context(cwd: string): ToolContext {
  return {
    cwd,
    signal: new AbortController().signal,
    output: () => undefined,
    taskId: 1,
  };
}

test("read/write/edit cannot escape the workspace", { timeout: 20_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "ribhu-paths-"));
  try {
    const runner = createToolRunner();
    const ctx = context(dir);
    await assert.rejects(
      () => runner.execute("read", { path: "../outside" }, ctx),
      /escapes the workspace/,
    );
    await assert.rejects(
      () => runner.execute("write", { path: "../evil", content: "x" }, ctx),
      /escapes the workspace/,
    );
    const written = await runner.execute(
      "write",
      { path: "ok.txt", content: "hello" },
      ctx,
    );
    assert.equal(written.isError, undefined);
    assert.equal(await readFile(join(dir, "ok.txt"), "utf8"), "hello");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

let dockerReady = false;
try {
  execFileSync("docker", ["image", "inspect", "node:24-bookworm"], {
    stdio: "ignore",
    timeout: 10_000,
  });
  dockerReady = true;
} catch {
  dockerReady = false;
}

test(
  "docker sandbox mounts only the workspace and has no network",
  { timeout: 60_000, skip: dockerReady ? false : "docker/node image unavailable" },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "ribhu-docker-"));
    try {
      await writeFile(join(dir, "hello.txt"), "hi", "utf8");
      const runner = createToolRunner({
        sandbox: "docker",
        image: "node:24-bookworm",
      });
      const result = await runner.execute(
        "bash",
        {
          command:
            "pwd && cat hello.txt && echo made > out.txt && node -e \"fetch('https://example.com',{signal:AbortSignal.timeout(1500)}).then(()=>console.log('NET')).catch(()=>console.log('BLOCKED'))\"",
        },
        context(dir),
      );
      assert.equal(result.isError, false);
      assert.match(result.content, /\/workspace/);
      assert.match(result.content, /hi/);
      assert.match(result.content, /BLOCKED/);
      assert.equal(await readFile(join(dir, "out.txt"), "utf8"), "made\n");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test("symlinks cannot escape the workspace", { timeout: 20_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "ribhu-symlink-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  await writeFile(join(root, "secret.txt"), "secret", "utf8");
  await symlink(join(root, "secret.txt"), join(workspace, "link"));
  try {
    const runner = createToolRunner();
    await assert.rejects(
      () => runner.execute("read", { path: "link" }, context(workspace)),
      /symlink|escapes/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("local bash does not inherit gateway secrets", { timeout: 20_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "ribhu-env-"));
  const previous = process.env.RIBBHU_TOKEN;
  process.env.RIBBHU_TOKEN = "must-not-leak";
  try {
    const runner = createToolRunner();
    const result = await runner.execute(
      "bash",
      { command: 'printf "%s" "${RIBBHU_TOKEN:-missing}"' },
      context(dir),
    );
    assert.equal(result.content, "missing");
  } finally {
    if (previous === undefined) delete process.env.RIBBHU_TOKEN;
    else process.env.RIBBHU_TOKEN = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

test("approval policy removes risky tools", { timeout: 20_000 }, async () => {
  const readOnly = createToolRunner({ approvals: "read-only" });
  assert.deepEqual(
    readOnly.specs.map((spec) => spec.name),
    ["read"],
  );
  const noBash = createToolRunner({ approvals: "deny-bash" });
  assert.deepEqual(
    noBash.specs.map((spec) => spec.name).sort(),
    ["edit", "read", "write"],
  );
});
