import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
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

const skipDocker = dockerReady ? false : "docker/node image unavailable";

function dockerRunner() {
  return createToolRunner({ sandbox: "docker", image: "node:24-bookworm" });
}

test(
  "docker read keeps numbered read offset/limit semantics",
  { timeout: 60_000, skip: skipDocker },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "ribhu-docker-read-"));
    try {
      await writeFile(join(dir, "lines.txt"), "alpha\nbeta\ngamma", "utf8");
      const runner = dockerRunner();
      const full = await runner.execute(
        "read",
        { path: "lines.txt" },
        context(dir),
      );
      assert.equal(full.isError, undefined);
      assert.equal(full.content, "    1  alpha\n    2  beta\n    3  gamma");
      const sliced = await runner.execute(
        "read",
        { path: "lines.txt", offset: 2, limit: 1 },
        context(dir),
      );
      assert.equal(sliced.isError, undefined);
      assert.equal(sliced.content, "    2  beta\n… 1 more lines");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test(
  "docker write creates directories and is visible on the host",
  { timeout: 60_000, skip: skipDocker },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "ribhu-docker-write-"));
    try {
      const runner = dockerRunner();
      const result = await runner.execute(
        "write",
        { path: "nested/dir/out.txt", content: "written in docker" },
        context(dir),
      );
      assert.equal(result.isError, undefined);
      assert.match(result.content, /Wrote 17 characters/);
      assert.equal(
        await readFile(join(dir, "nested", "dir", "out.txt"), "utf8"),
        "written in docker",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test(
  "docker edit replaces exactly one occurrence",
  { timeout: 60_000, skip: skipDocker },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "ribhu-docker-edit-"));
    try {
      await writeFile(join(dir, "edit.txt"), "one two one", "utf8");
      const runner = dockerRunner();
      await assert.rejects(
        () =>
          runner.execute(
            "edit",
            { path: "edit.txt", oldText: "one", newText: "ONE" },
            context(dir),
          ),
        /more than once/,
      );
      const result = await runner.execute(
        "edit",
        { path: "edit.txt", oldText: "two", newText: "2" },
        context(dir),
      );
      assert.equal(result.isError, undefined);
      assert.match(result.content, /Replaced 1 occurrence/);
      assert.equal(await readFile(join(dir, "edit.txt"), "utf8"), "one 2 one");
      await assert.rejects(
        () =>
          runner.execute(
            "edit",
            { path: "edit.txt", oldText: "missing", newText: "x" },
            context(dir),
          ),
        /not found/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test(
  "docker rejects path traversal escapes",
  { timeout: 60_000, skip: skipDocker },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "ribhu-docker-escape-"));
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    try {
      const runner = dockerRunner();
      await assert.rejects(
        () => runner.execute("read", { path: "../secret.txt" }, context(workspace)),
        /escapes the workspace/,
      );
      await assert.rejects(
        () => runner.execute("read", { path: "/etc/passwd" }, context(workspace)),
        /escapes the workspace/,
      );
      await assert.rejects(
        () =>
          runner.execute(
            "write",
            { path: "../evil.txt", content: "x" },
            context(workspace),
          ),
        /escapes the workspace/,
      );
      assert.equal(existsSync(join(root, "evil.txt")), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "docker rejects symlink escapes",
  { timeout: 60_000, skip: skipDocker },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "ribhu-docker-symlink-"));
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    await symlink("/etc/passwd", join(workspace, "passwd-link"));
    try {
      const runner = dockerRunner();
      await assert.rejects(
        () =>
          runner.execute("read", { path: "passwd-link" }, context(workspace)),
        /symlink|escapes/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
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
