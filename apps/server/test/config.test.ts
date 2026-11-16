import assert from "node:assert/strict";
import test from "node:test";

import { describeConfig, isLoopbackHost, loadConfig } from "../src/config.js";

test("R1: loopback without a token generates and flags one", () => {
  const config = loadConfig({});
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.allowAnon, false);
  assert.equal(config.tokenGenerated, true);
  assert.ok(config.token.length >= 20, "generated token is long enough");
  assert.equal(config.token.includes(" "), false);
});

test("R1: RIBBHU_TOKEN is used verbatim when configured", () => {
  const config = loadConfig({ RIBBHU_TOKEN: "  configured-token  " });
  assert.equal(config.token, "configured-token");
  assert.equal(config.tokenGenerated, false);
  assert.equal(config.allowAnon, false);
});

test("R1: RIBBHU_ALLOW_ANON=1 allows a token-less loopback runtime", () => {
  const config = loadConfig({ RIBBHU_ALLOW_ANON: "1" });
  assert.equal(config.allowAnon, true);
  assert.equal(config.token, "");
  assert.equal(config.tokenGenerated, false);
});

test("R1: non-loopback hosts always require a token", () => {
  assert.equal(isLoopbackHost("127.0.0.1"), true);
  assert.equal(isLoopbackHost("localhost"), true);
  assert.equal(isLoopbackHost("0.0.0.0"), false);
  assert.throws(
    () => loadConfig({ HOST: "0.0.0.0" }),
    /RIBBHU_TOKEN is required/,
  );
  assert.throws(
    () => loadConfig({ HOST: "0.0.0.0", RIBBHU_ALLOW_ANON: "1" }),
    /only allowed on loopback/,
  );
});

test("R8: hosted posture refuses local sandbox or allow-all approvals", () => {
  assert.throws(
    () =>
      loadConfig({
        HOST: "0.0.0.0",
        RIBBHU_TOKEN: "token",
      }),
    /Refusing unsafe hosted posture.*RIBBHU_SANDBOX=docker/,
  );
  assert.throws(
    () =>
      loadConfig({
        HOST: "0.0.0.0",
        RIBBHU_TOKEN: "token",
        RIBBHU_SANDBOX: "docker",
      }),
    /RIBBHU_APPROVALS/,
  );
  const hardened = loadConfig({
    HOST: "0.0.0.0",
    RIBBHU_TOKEN: "token",
    RIBBHU_SANDBOX: "docker",
    RIBBHU_APPROVALS: "ask",
  });
  assert.equal(hardened.sandbox, "docker");
  assert.equal(hardened.approvals, "ask");
  assert.equal(hardened.allowUnsafeHosted, false);
});

test("R8: Postgres posture requires strict RLS unless break-glass", () => {
  const base = {
    RIBBHU_STORAGE: "postgres",
    RIBBHU_POSTGRES_URL: "postgres://app@db.example/ribhu",
    RIBBHU_TOKEN: "token",
    RIBBHU_SANDBOX: "docker",
    RIBBHU_APPROVALS: "read-only",
  };
  assert.throws(() => loadConfig(base), /RIBBHU_STRICT_RLS=1/);
  const strict = loadConfig({ ...base, RIBBHU_STRICT_RLS: "1" });
  assert.equal(strict.storage, "postgres");
  assert.equal(strict.strictRls, true);
  const breakGlass = loadConfig({ ...base, RIBBHU_ALLOW_UNSAFE_HOSTED: "1" });
  assert.equal(breakGlass.allowUnsafeHosted, true);
  assert.equal(breakGlass.strictRls, false);
});

test("R1/R8: Postgres tenant tokens replace the generated shared token", () => {
  const hosted = loadConfig({
    HOST: "0.0.0.0",
    RIBBHU_STORAGE: "postgres",
    RIBBHU_POSTGRES_URL: "postgres://app@db.example/ribhu",
    RIBBHU_SANDBOX: "docker",
    RIBBHU_APPROVALS: "ask",
    RIBBHU_STRICT_RLS: "1",
  });
  assert.equal(hosted.token, "");
  assert.equal(hosted.tokenGenerated, false);
  assert.equal(hosted.storage, "postgres");
  assert.doesNotMatch(describeConfig(hosted), /generated/);
  assert.match(describeConfig(hosted), /tenant tokens/);
});

test("R8: allowed origins, rate limit, and push hosts parse from env", () => {
  const config = loadConfig({
    RIBBHU_ALLOWED_ORIGINS: "https://app.example.com, capacitor://localhost",
    RIBBHU_RATE_LIMIT_PER_MINUTE: "30",
    RIBBHU_PUSH_ALLOWED_HOSTS: "push.example.com, *.example.net",
  });
  assert.deepEqual(config.allowedOrigins, [
    "https://app.example.com",
    "capacitor://localhost",
  ]);
  assert.equal(config.rateLimitPerMinute, 30);
  assert.deepEqual(config.pushAllowedHosts, [
    "push.example.com",
    "*.example.net",
  ]);

  assert.equal(loadConfig({}).rateLimitPerMinute, 120);
  assert.equal(loadConfig({ RIBBHU_RATE_LIMIT_PER_MINUTE: "0" }).rateLimitPerMinute, 0);
  assert.throws(
    () => loadConfig({ RIBBHU_RATE_LIMIT_PER_MINUTE: "-1" }),
    /non-negative integer/,
  );
  assert.throws(
    () => loadConfig({ RIBBHU_ALLOWED_ORIGINS: "http://" }),
    /RIBBHU_ALLOWED_ORIGINS/,
  );
});
