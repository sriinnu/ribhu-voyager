import { randomBytes } from "node:crypto";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  ApprovalsMode,
  ModelPricing,
  RetryPolicy as ProviderRetryPolicy,
} from "@ribhu-voyager/engine";

export type ProviderRetryConfig = Partial<ProviderRetryPolicy>;

export type Config = {
  host: string;
  port: number;
  dataDir: string;
  workspaceDir: string;
  /** "demo" runs the built-in scripted provider; anything else uses a native streaming client. */
  provider: string;
  model: string;
  demo: boolean;
  demoTokensPerSecond: number;
  maxWindowEntries: number;
  token: string;
  /** How Anthropic requests authenticate. */
  authMode: "auto" | "subscription" | "api-key";
  /** Which Claude OAuth login to prefer. */
  authSource: "auto" | "pi" | "claude-code";
  /** Anthropic API key used in api-key mode. */
  anthropicApiKey?: string;
  sandbox?: "local" | "docker";
  sandboxImage?: string;
  storage?: "sqlite" | "postgres";
  postgresUrl?: string;
  tenantId?: string;
  /** Hard tool gate, or `ask` for durable per-call approval. */
  approvals?: ApprovalsMode;
  /** Web Push VAPID keys; both are required to enable server push. */
  vapidPublicKey?: string;
  vapidPrivateKey?: string;
  vapidSubject?: string;
  /** Bearer token for the admin API/dashboard. Admin routes 404 when unset. */
  adminToken?: string;
  /** Usage pricing in micros per 1k tokens; 0/absent records zero cost. */
  costMicrosPer1kTokens?: number;
  /** Per-model pricing (`provider/model` -> micros per 1k tokens). */
  modelPricing?: Record<string, ModelPricing>;
  /** Provider retry/timeout policy (env: RIBBHU_PROVIDER_*). */
  providerRetry?: ProviderRetryConfig;
  /** Total provider attempts including the first (default 4). */
  providerMaxAttempts?: number;
  /** Per-attempt provider request timeout in ms (default 120000). */
  providerTimeoutMs?: number;
  /** First backoff delay in ms (default 500). */
  providerRetryBaseMs?: number;
  /** Backoff cap in ms (default 30000). */
  providerRetryMaxMs?: number;
  /** Backoff jitter fraction 0…1 (default 0.25). */
  providerRetryJitter?: number;
  /** Max tokens a single run may consume (per-run budget). */
  runTokenBudget?: number;
  /** Max cost in micros a single run may spend; 0 disables the cap. */
  runCostMicros?: number;
  /** `RIBBHU_MIGRATE_ONLY=1`: apply DDL migrations and exit. */
  migrateOnly?: boolean;
  /**
   * R1: allow a token-less runtime on loopback. Off by default; when off and no
   * `RIBBHU_TOKEN` is configured, startup generates and prints one.
   */
  allowAnon?: boolean;
  /** Explicit allowed browser origins for WS upgrades (native/tunnel use). */
  allowedOrigins?: string[];
  /** R8 break-glass: bypass the hosted posture refusal. Not for production. */
  allowUnsafeHosted?: boolean;
  /** R8: `RIBBHU_STRICT_RLS=1` must be on for hosted Postgres posture. */
  strictRls?: boolean;
  /** R8: per-IP/per-token request budget per minute; 0 disables. */
  rateLimitPerMinute?: number;
  /** R8: optional allowlist of push endpoint hosts (suffix match with `*.`). */
  pushAllowedHosts?: string[];
  /**
   * R6: max per-tenant API runtimes cached in this process. 0 = unlimited.
   * The pool refuses new tenants past this cap (HTTP 503) instead of growing
   * without bound; existing tenants keep working.
   */
  maxTenantRuntimes?: number;
  /**
   * R6: evict a tenant runtime once it has no WebSocket clients for this many
   * milliseconds. Default 600000 (10m); 0 disables eviction entirely.
   */
  tenantRuntimeTtlMs?: number;
  /** R6: background idle-eviction sweep interval. Default 60000; 0 = no timer. */
  tenantEvictIntervalMs?: number;
  /** True when startup generated a token instead of reading RIBBHU_TOKEN. */
  tokenGenerated?: boolean;
};

function parseNonNegativeInt(
  raw: string | undefined,
  name: string,
  fallback: number,
): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
  return value;
}

function parsePositiveInt(
  raw: string | undefined,
  name: string,
  fallback: number,
): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function parseFraction(
  raw: string | undefined,
  name: string,
  fallback: number,
): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${name} must be a number between 0 and 1.`);
  }
  return value;
}

function parseModelPricing(
  raw: string | undefined,
): Record<string, ModelPricing> | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      "RIBBHU_MODEL_PRICING must be JSON: {\"provider/model\": {\"inputMicrosPer1k\":N,\"outputMicrosPer1k\":N}}.",
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("RIBBHU_MODEL_PRICING must be a JSON object keyed by provider/model.");
  }
  const result: Record<string, ModelPricing> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!key.includes("/")) {
      throw new Error(`RIBBHU_MODEL_PRICING entry "${key}" must be "provider/model".`);
    }
    const rate = (candidate: unknown, field: string): number => {
      if (typeof candidate !== "number" || !Number.isFinite(candidate) || candidate < 0) {
        throw new Error(`RIBBHU_MODEL_PRICING ${key}.${field} must be a non-negative number.`);
      }
      return candidate;
    };
    if (typeof value === "number") {
      const flat = rate(value, "rate");
      result[key] = { inputMicrosPer1k: flat, outputMicrosPer1k: flat };
      continue;
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`RIBBHU_MODEL_PRICING ${key} must be a number or an object.`);
    }
    const entry = value as { inputMicrosPer1k?: unknown; outputMicrosPer1k?: unknown };
    result[key] = {
      inputMicrosPer1k: rate(entry.inputMicrosPer1k, "inputMicrosPer1k"),
      outputMicrosPer1k: rate(entry.outputMicrosPer1k, "outputMicrosPer1k"),
    };
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

// Resolve against the repository, not the caller's cwd: npm workspace scripts run
// inside apps/server, and storage must not move when you start the app differently.
const projectRoot = fileURLToPath(new URL("../../../", import.meta.url));

const REAL_PROVIDERS = new Set([
  "anthropic",
  "openai",
  "deepseek",
  "openrouter",
  "xai",
  "groq",
  "mistral",
  "ollama",
]);

/** Hosts that are only reachable from the same machine. */
export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return (
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "[::1]" ||
    normalized === "localhost" ||
    normalized === "::ffff:127.0.0.1"
  );
}

function parseList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

function parseRateLimit(env: NodeJS.ProcessEnv): number {
  const raw = env.RIBBHU_RATE_LIMIT_PER_MINUTE?.trim();
  if (raw === undefined || raw === "") return 120;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(
      "RIBBHU_RATE_LIMIT_PER_MINUTE must be a non-negative integer (0 disables).",
    );
  }
  return value;
}

function parseMaxTenantRuntimes(env: NodeJS.ProcessEnv): number {
  return parseNonNegativeInt(
    env.RIBBHU_MAX_TENANT_RUNTIMES?.trim(),
    "RIBBHU_MAX_TENANT_RUNTIMES",
    20,
  );
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const host = env.HOST?.trim() || "127.0.0.1";
  const loopback = isLoopbackHost(host);
  const provider = env.RIBBHU_PROVIDER?.trim() || "demo";
  const model = env.RIBBHU_MODEL?.trim() || "";
  const demo = provider === "demo" || env.RIBBHU_DEMO === "1";

  if (!demo && !REAL_PROVIDERS.has(provider)) {
    throw new Error(
      `Unknown RIBBHU_PROVIDER "${provider}". Use one of: demo, ${[...REAL_PROVIDERS].join(", ")}.`,
    );
  }
  if (!demo && model === "") {
    throw new Error(`RIBBHU_MODEL is required when RIBBHU_PROVIDER=${provider}.`);
  }

  const requestedMode = (env.RIBBHU_ANTHROPIC_AUTH?.trim().toLowerCase() || "auto");
  const authMode =
    requestedMode === "credits" || requestedMode === "api_key"
      ? "api-key"
      : requestedMode;
  if (authMode !== "auto" && authMode !== "subscription" && authMode !== "api-key") {
    throw new Error(
      `Unknown RIBBHU_ANTHROPIC_AUTH "${requestedMode}". Use auto, subscription, or api-key.`,
    );
  }

  const requestedSource = (env.RIBBHU_AUTH_SOURCE?.trim().toLowerCase() || "auto");
  const authSource =
    requestedSource === "claude" ? "claude-code" : requestedSource;
  if (authSource !== "auto" && authSource !== "pi" && authSource !== "claude-code") {
    throw new Error(
      `Unknown RIBBHU_AUTH_SOURCE "${requestedSource}". Use auto, pi, or claude-code.`,
    );
  }

  const anthropicApiKey =
    env.RIBBHU_ANTHROPIC_API_KEY?.trim() ||
    env.ANTHROPIC_API_KEY?.trim() ||
    undefined;

  const storageRaw = env.RIBBHU_STORAGE?.trim().toLowerCase() || "sqlite";
  if (storageRaw !== "sqlite" && storageRaw !== "postgres") {
    throw new Error(`Unknown RIBBHU_STORAGE "${storageRaw}". Use sqlite or postgres.`);
  }
  if (storageRaw === "postgres" && !env.RIBBHU_POSTGRES_URL?.trim()) {
    throw new Error("RIBBHU_POSTGRES_URL is required when RIBBHU_STORAGE=postgres.");
  }

  const tenantId = env.RIBBHU_TENANT?.trim() || "default";
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(tenantId)) {
    throw new Error("RIBBHU_TENANT must be 1-64 alphanumeric, dash, or underscore.");
  }

  const approvalsRaw = env.RIBBHU_APPROVALS?.trim().toLowerCase() || "allow";
  if (
    approvalsRaw !== "allow" &&
    approvalsRaw !== "deny-bash" &&
    approvalsRaw !== "read-only" &&
    approvalsRaw !== "ask"
  ) {
    throw new Error(
      `Unknown RIBBHU_APPROVALS "${approvalsRaw}". Use allow, ask, deny-bash, or read-only.`,
    );
  }

  const vapidPublicKey = env.RIBBHU_VAPID_PUBLIC_KEY?.trim() || undefined;
  const vapidPrivateKey = env.RIBBHU_VAPID_PRIVATE_KEY?.trim() || undefined;
  if (Boolean(vapidPublicKey) !== Boolean(vapidPrivateKey)) {
    throw new Error(
      "RIBBHU_VAPID_PUBLIC_KEY and RIBBHU_VAPID_PRIVATE_KEY must be set together.",
    );
  }

  const adminToken = env.RIBBHU_ADMIN_TOKEN?.trim() || undefined;

  const costRaw = env.RIBBHU_COST_MICROS_PER_1K_TOKENS?.trim();
  const costMicrosPer1kTokens = costRaw === undefined || costRaw === ""
    ? 0
    : Number.parseFloat(costRaw);
  if (!Number.isFinite(costMicrosPer1kTokens) || costMicrosPer1kTokens < 0) {
    throw new Error(
      "RIBBHU_COST_MICROS_PER_1K_TOKENS must be a non-negative number.",
    );
  }
  const modelPricing = parseModelPricing(env.RIBBHU_MODEL_PRICING);
  const runTokenBudget = parseNonNegativeInt(
    env.RIBBHU_RUN_TOKEN_BUDGET,
    "RIBBHU_RUN_TOKEN_BUDGET",
    200_000,
  );
  const runCostMicros = parseNonNegativeInt(
    env.RIBBHU_RUN_COST_MICROS,
    "RIBBHU_RUN_COST_MICROS",
    0,
  );
  const migrateOnly = env.RIBBHU_MIGRATE_ONLY?.trim() === "1";

  // Provider resilience (retry/backoff/timeout). One attempt disables retries.
  const providerMaxAttempts = parsePositiveInt(
    env.RIBBHU_PROVIDER_MAX_ATTEMPTS,
    "RIBBHU_PROVIDER_MAX_ATTEMPTS",
    4,
  );
  const providerTimeoutMs = parsePositiveInt(
    env.RIBBHU_PROVIDER_TIMEOUT_MS,
    "RIBBHU_PROVIDER_TIMEOUT_MS",
    120_000,
  );
  const providerRetryBaseMs = parseNonNegativeInt(
    env.RIBBHU_PROVIDER_RETRY_BASE_MS,
    "RIBBHU_PROVIDER_RETRY_BASE_MS",
    500,
  );
  const providerRetryMaxMs = parseNonNegativeInt(
    env.RIBBHU_PROVIDER_RETRY_MAX_MS,
    "RIBBHU_PROVIDER_RETRY_MAX_MS",
    30_000,
  );
  if (providerRetryMaxMs < providerRetryBaseMs) {
    throw new Error(
      "RIBBHU_PROVIDER_RETRY_MAX_MS must be >= RIBBHU_PROVIDER_RETRY_BASE_MS.",
    );
  }
  const providerRetryJitter = parseFraction(
    env.RIBBHU_PROVIDER_RETRY_JITTER,
    "RIBBHU_PROVIDER_RETRY_JITTER",
    0.25,
  );
  const providerRetry: ProviderRetryConfig = {
    maxAttempts: providerMaxAttempts,
    initialDelayMs: providerRetryBaseMs,
    maxDelayMs: providerRetryMaxMs,
    factor: 2,
    jitter: providerRetryJitter,
    timeoutMs: providerTimeoutMs,
  };

  const sandboxRaw = env.RIBBHU_SANDBOX?.trim().toLowerCase() || "local";
  if (sandboxRaw !== "local" && sandboxRaw !== "docker") {
    throw new Error(
      `Unknown RIBBHU_SANDBOX "${sandboxRaw}". Use local or docker.`,
    );
  }

  // ---- R1: no unauthenticated default runtime ----
  const allowAnon = env.RIBBHU_ALLOW_ANON?.trim() === "1";
  const tenantTokenAuth = storageRaw === "postgres";
  const configuredToken = env.RIBBHU_TOKEN?.trim() || "";
  let token = configuredToken;
  let tokenGenerated = false;
  if (!loopback && allowAnon) {
    throw new Error(
      "RIBBHU_ALLOW_ANON=1 is only allowed on loopback; set RIBBHU_TOKEN or tenant tokens for non-loopback hosts.",
    );
  }
  if (!loopback && token === "" && !tenantTokenAuth) {
    throw new Error(
      `RIBBHU_TOKEN is required when binding ${host}; non-loopback hosts always require a token.`,
    );
  }
  if (token === "" && !allowAnon && !tenantTokenAuth) {
    // Generated per start and printed by the server; the URL carries it.
    token = randomBytes(24).toString("base64url");
    tokenGenerated = true;
  }

  // ---- R8: hosted posture ----
  const strictRls = env.RIBBHU_STRICT_RLS?.trim() === "1";
  const allowUnsafeHosted = env.RIBBHU_ALLOW_UNSAFE_HOSTED?.trim() === "1";
  const hosted = !loopback || storageRaw === "postgres";
  // Migration mode never serves traffic: the schema-admin posture rules (which
  // describe the app credential) do not apply to a DDL-only run.
  if (hosted && !allowUnsafeHosted && !migrateOnly) {
    const missing: string[] = [];
    if (sandboxRaw !== "docker") missing.push("RIBBHU_SANDBOX=docker");
    if (approvalsRaw === "allow") {
      missing.push("RIBBHU_APPROVALS=ask (or deny-bash/read-only)");
    }
    if (storageRaw === "postgres" && !strictRls) {
      missing.push("RIBBHU_STRICT_RLS=1");
    }
    if (missing.length > 0) {
      throw new Error(
        `Refusing unsafe hosted posture for ${host}${storageRaw === "postgres" ? " (Postgres)" : ""}: ` +
          `set ${missing.join(", ")}. ` +
          "Set RIBBHU_ALLOW_UNSAFE_HOSTED=1 only as an explicit, temporary break-glass.",
      );
    }
  }

  const allowedOrigins = parseList(env.RIBBHU_ALLOWED_ORIGINS);
  for (const origin of allowedOrigins) {
    if (origin === "*") continue;
    try {
      // Accept full origins (https://app.example.com) and bare hosts.
      new URL(origin.includes("://") ? origin : `https://${origin}`);
    } catch {
      throw new Error(
        `Unknown RIBBHU_ALLOWED_ORIGINS entry "${origin}". Use origins or hosts.`,
      );
    }
  }

  const pushAllowedHosts = parseList(env.RIBBHU_PUSH_ALLOWED_HOSTS).map((entry) =>
    entry.toLowerCase(),
  );

  const rateLimitPerMinute = parseRateLimit(env);
  const maxTenantRuntimes = parseMaxTenantRuntimes(env);
  const tenantRuntimeTtlMs = parseNonNegativeInt(
    env.RIBBHU_TENANT_RUNTIME_TTL_MS?.trim(),
    "RIBBHU_TENANT_RUNTIME_TTL_MS",
    600_000,
  );
  const tenantEvictIntervalMs = parseNonNegativeInt(
    env.RIBBHU_TENANT_EVICT_INTERVAL_MS?.trim(),
    "RIBBHU_TENANT_EVICT_INTERVAL_MS",
    60_000,
  );

  return {
    host,
    port: Number.parseInt(env.PORT ?? "8787", 10),
    dataDir: resolve(env.RIBBHU_DATA_DIR?.trim() || join(projectRoot, ".ribhu-data")),
    workspaceDir: resolve(env.RIBBHU_WORKSPACE?.trim() || join(projectRoot, ".ribhu-workspace")),
    provider,
    model: demo ? "ribhu-demo" : model,
    demo,
    demoTokensPerSecond: Number.parseFloat(env.RIBBHU_DEMO_TPS ?? "38"),
    maxWindowEntries: Number.parseInt(env.RIBBHU_WINDOW_ENTRIES ?? "100", 10),
    token,
    tokenGenerated,
    allowAnon,
    allowedOrigins,
    allowUnsafeHosted,
    strictRls,
    rateLimitPerMinute,
    pushAllowedHosts,
    maxTenantRuntimes,
    tenantRuntimeTtlMs,
    tenantEvictIntervalMs,
    authMode,
    authSource,
    storage: storageRaw,
    tenantId,
    ...(env.RIBBHU_POSTGRES_URL?.trim()
      ? { postgresUrl: env.RIBBHU_POSTGRES_URL.trim() }
      : {}),
    approvals: approvalsRaw,
    sandbox: sandboxRaw,
    ...(vapidPublicKey
      ? {
          vapidPublicKey,
          vapidPrivateKey: vapidPrivateKey!,
          vapidSubject:
            env.RIBBHU_VAPID_SUBJECT?.trim() || "mailto:hello@srinivas.dev",
        }
      : {}),
    sandboxImage: env.RIBBHU_SANDBOX_IMAGE?.trim() || "node:24-bookworm",
    ...(anthropicApiKey ? { anthropicApiKey } : {}),
    ...(adminToken ? { adminToken } : {}),
    ...(costMicrosPer1kTokens > 0 ? { costMicrosPer1kTokens } : {}),
    ...(modelPricing ? { modelPricing } : {}),
    runTokenBudget,
    runCostMicros,
    migrateOnly,
    providerRetry,
    providerMaxAttempts,
    providerTimeoutMs,
    providerRetryBaseMs,
    providerRetryMaxMs,
    providerRetryJitter,
  };
}

export function describeConfig(config: Config): string {
  const lines = [
    `  storage   ${join(config.dataDir, "ribhu.sqlite")}`,
    `  workspace ${config.workspaceDir}`,
    `  model     ${config.provider}/${config.model}${config.demo ? "  (scripted demo — set RIBBHU_PROVIDER + RIBBHU_MODEL for a real model)" : ""}`,
    `  storage   ${config.storage === "postgres" ? `Postgres (tenant ${config.tenantId ?? "default"})` : join(config.dataDir, "ribhu.sqlite")}`,
    `  approvals ${config.approvals ?? "allow"}`,
    `  sandbox   ${config.sandbox ?? "local"}${config.sandbox === "docker" ? ` (${config.sandboxImage ?? "node:24-bookworm"})` : ""}`,
    `  auth      ${
      config.token !== ""
        ? config.tokenGenerated
          ? "token (generated this start)"
          : "token (RIBBHU_TOKEN)"
        : config.storage === "postgres"
          ? "tenant tokens (Postgres api_tokens)"
          : "anonymous loopback (RIBBHU_ALLOW_ANON=1)"
    }`,
    `  origins   ${config.allowedOrigins?.length ? config.allowedOrigins.join(", ") : "same-origin only"}`,
    `  rate      ${config.rateLimitPerMinute ? `${config.rateLimitPerMinute}/min per IP or token` : "disabled"}`,
    `  tenants   ${config.maxTenantRuntimes && config.maxTenantRuntimes > 0 ? `cap ${config.maxTenantRuntimes} API runtimes (one worker per tenant)` : "API runtime cap unlimited (RIBBHU_MAX_TENANT_RUNTIMES=0)"}`,
    `  eviction  ${
      config.tenantRuntimeTtlMs === 0
        ? "disabled (RIBBHU_TENANT_RUNTIME_TTL_MS=0)"
        : `idle ${(config.tenantRuntimeTtlMs ?? 600_000) / 1000}s → close${
            config.tenantEvictIntervalMs === 0
              ? " (no background sweep)"
              : `; sweep ${(config.tenantEvictIntervalMs ?? 60_000) / 1000}s`
          }`
    }`,
    `  posture   ${config.allowUnsafeHosted ? "break-glass (RIBBHU_ALLOW_UNSAFE_HOSTED=1)" : "hardened"}${config.strictRls ? " · strict RLS" : ""}`,
    `  push      ${config.vapidPublicKey ? "Web Push enabled" : "disabled (set RIBBHU_VAPID_*)"}`,
    `  admin     ${config.adminToken ? "enabled at /admin" : "disabled (set RIBBHU_ADMIN_TOKEN)"}`,
    `  pricing   ${
      config.modelPricing
        ? `${Object.keys(config.modelPricing).length} per-model rates`
        : config.costMicrosPer1kTokens
          ? `${config.costMicrosPer1kTokens} micros / 1k tokens`
          : "unset (usage cost recorded as 0)"
    }`,
    `  budget    ${config.runTokenBudget} tokens/run${config.runCostMicros ? `, ${config.runCostMicros} micros/run cap` : ", no cost cap"}`,
    `  retries   ${config.providerMaxAttempts ?? 4} attempts · ${config.providerTimeoutMs ?? 120_000}ms timeout · ${config.providerRetryBaseMs ?? 500}-${config.providerRetryMaxMs ?? 30_000}ms backoff`,
    `  migrate   ${config.migrateOnly ? "migrate-only (schema admin)" : "verify-only (no DDL from app)"}`,
  ];
  return lines.join("\n");
}
