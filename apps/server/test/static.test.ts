import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SECURITY_HEADERS, createStaticHandler } from "../src/static.js";

async function withServer<T>(
  distDir: string,
  run: (base: string) => Promise<T>,
): Promise<T> {
  const handler = createStaticHandler(distDir);
  const server = createServer((request, response) => {
    void handler(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function assertSecurityHeaders(headers: Headers): void {
  const csp = headers.get("content-security-policy") ?? "";
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /object-src 'none'/);
  assert.equal(headers.get("x-frame-options"), "DENY");
  assert.equal(headers.get("x-content-type-options"), "nosniff");
  assert.equal(headers.get("referrer-policy"), "no-referrer");
  assert.match(headers.get("permissions-policy") ?? "", /camera=\(\)/);
}

test("app shell responses carry the R8 security headers", { timeout: 20_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "ribhu-static-"));
  try {
    await writeFile(
      join(dir, "index.html"),
      "<!doctype html><title>Ribhu</title><main>ok</main>",
    );
    await writeFile(join(dir, "app.js"), "console.log('hi');");
    await withServer(dir, async (base) => {
      const shell = await fetch(`${base}/`);
      assert.equal(shell.status, 200);
      assert.match(await shell.text(), /<title>Ribhu<\/title>/);
      assertSecurityHeaders(shell.headers);

      const asset = await fetch(`${base}/app.js`);
      assert.equal(asset.status, 200);
      assert.equal(asset.headers.get("content-type"), "text/javascript; charset=utf-8");
      assertSecurityHeaders(asset.headers);

      const spaFallback = await fetch(`${base}/some/client/route`);
      assert.equal(spaFallback.status, 200);
      assert.match(await spaFallback.text(), /<title>Ribhu<\/title>/);
      assertSecurityHeaders(spaFallback.headers);

      const missing = await fetch(`${base}/missing.js`);
      assert.equal(missing.status, 404);
      assertSecurityHeaders(missing.headers);

      const method = await fetch(`${base}/`, { method: "POST" });
      assert.equal(method.status, 405);
      assertSecurityHeaders(method.headers);
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the missing-build page is also hardened", { timeout: 20_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "ribhu-static-empty-"));
  try {
    await withServer(dir, async (base) => {
      // Extensionless routes hit the SPA fallback, which renders the
      // "build needed" shell when dist/ is empty.
      const response = await fetch(`${base}/app`);
      assert.equal(response.status, 200);
      const body = await response.text();
      assert.match(body, /not built yet/);
      assertSecurityHeaders(response.headers);
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("SECURITY_HEADERS is frozen and complete", () => {
  assert.equal(Object.isFrozen(SECURITY_HEADERS), true);
  const keys = Object.keys(SECURITY_HEADERS);
  for (const expected of [
    "content-security-policy",
    "x-frame-options",
    "x-content-type-options",
    "referrer-policy",
  ]) {
    assert.ok(keys.includes(expected), `missing ${expected}`);
  }
});
