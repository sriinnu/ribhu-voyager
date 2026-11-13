import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { toolSpecs } from "@ribhu-voyager/engine";

import { createToolRunner } from "../src/tools-runtime.js";

const engineSrc = fileURLToPath(new URL("../../../packages/engine/src/", import.meta.url));

test("engine source has no host/runtime imports", { timeout: 20_000 }, async () => {
  const files = (await readdir(engineSrc)).filter((name) => name.endsWith(".ts"));
  for (const file of files) {
    const source = await readFile(join(engineSrc, file), "utf8");
    assert.ok(!source.includes("node:"), `${file} imports a node builtin`);
    assert.ok(!source.includes("process."), `${file} reads process`);
    assert.ok(!source.includes("fetch("), `${file} calls fetch`);
    assert.ok(!source.includes("sqlite"), `${file} mentions sqlite`);
  }
});

test("runner specs match the engine spec table", { timeout: 20_000 }, async () => {
  const runner = createToolRunner();
  const pick = (specs: readonly { name: string; description: string; parameters: unknown; replaySafe: boolean }[]) =>
    [...specs]
      .map((spec) => ({
        name: spec.name,
        description: spec.description,
        parameters: spec.parameters,
        replaySafe: spec.replaySafe,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  assert.deepEqual(pick(runner.specs), pick(toolSpecs));
});
