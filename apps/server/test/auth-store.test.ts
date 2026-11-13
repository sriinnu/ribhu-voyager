import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { PiAuthStore } from "../src/auth-store.js";

const OAUTH = {
  type: "oauth" as const,
  access: "old-access",
  refresh: "refresh-token",
  expires: 1,
};

test("uses Pi's auth file as a durable credential store", { timeout: 20_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "ribhu-auth-"));
  const file = join(dir, "auth.json");

  try {
    await writeFile(
      file,
      JSON.stringify({ anthropic: OAUTH, xai: { ...OAUTH, access: "xai" } }),
    );

    const store = new PiAuthStore(file);
    const read = await store.read("anthropic");
    assert.equal(read?.type, "oauth");
    assert.equal(read?.type === "oauth" ? read.access : undefined, "old-access");

    // A refresh writes the rotated token back and preserves other providers.
    const next = await store.modify("anthropic", async (current) => {
      if (current?.type !== "oauth") throw new Error("missing credential");
      return { ...current, access: "new-access", expires: Date.now() + 3_600_000 };
    });
    assert.equal(next?.type === "oauth" ? next.access : undefined, "new-access");

    const onDisk = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    assert.equal((onDisk.anthropic as { access: string }).access, "new-access");
    assert.deepEqual(onDisk.xai, { ...OAUTH, access: "xai" });

    const listed = await store.list();
    assert.deepEqual(
      listed.map((entry) => entry.providerId).sort(),
      ["anthropic", "xai"],
    );

    await store.delete("anthropic");
    assert.equal(await store.read("anthropic"), undefined);
    assert.ok(await store.read("xai"), "unrelated credentials survive");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
